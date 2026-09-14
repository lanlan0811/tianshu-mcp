import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadSharp } from "../../src/visual/runtime.js";
import { VisualConfigSchema, ImageSchema } from "../../src/visual/schema.js";
import { VisualBudget } from "../../src/visual/budget.js";
import { checkImage } from "../../src/visual/images.js";
import { compareImages, diffRegions } from "../../src/visual/compare.js";

const dirs: string[] = [];
const budgets: VisualBudget[] = [];
async function fixture(limits = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "visual-images-"));
  dirs.push(dir);
  const budget = new VisualBudget(VisualConfigSchema.parse({ limits }).limits);
  budgets.push(budget);
  return { dir, budget, sharp: await loadSharp() };
}
afterEach(async () => {
  budgets.splice(0).forEach((b) => b.dispose());
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
describe("image specifications", () => {
  it("normalizes EXIF orientation and validates known DPI", async () => {
    const { dir, budget, sharp } = await fixture();
    await sharp({ create: { width: 8, height: 12, channels: 3, background: "red" } })
      .withMetadata({ orientation: 6, density: 144 }).jpeg().toFile(path.join(dir, "oriented.jpg"));
    const rule = ImageSchema.parse({ id: "orientation", files: ["oriented.jpg"], width: { exact: 12 }, height: { exact: 8 }, dpi: { min: 143, max: 145 } });
    expect((await checkImage(dir, rule, "oriented.jpg", budget)).status).toBe("passed");
    rule.dpi = { min: 300 };
    expect((await checkImage(dir, rule, "oriented.jpg", budget)).status).toBe("failed");
  });
  it("rejects animations and unsupported encodings", async () => {
    const { dir, budget, sharp } = await fixture();
    const pixels = Buffer.alloc(2 * 4 * 3, 255); pixels.fill(0, 2 * 2 * 3);
    await sharp(pixels, { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 } })
      .webp({ loop: 0, delay: [100, 100] }).toFile(path.join(dir, "animated.webp"));
    await fs.writeFile(path.join(dir, "image.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>');
    for (const file of ["animated.webp", "image.svg"]) {
      const result = await checkImage(dir, ImageSchema.parse({ id: "format", files: [file] }), file, budget);
      expect(result.code).toBe("IMAGE_UNSUPPORTED"); expect(result.repairable).toBe(true);
    }
  });
  it("checks actual transparency, extension mismatch, and inclusive byte limits", async () => {
    const { dir, budget, sharp } = await fixture();
    const input = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
    await fs.writeFile(path.join(dir, "transparent.png"), input);
    await fs.writeFile(path.join(dir, "wrong.jpg"), input);
    const rule = ImageSchema.parse({ id: "alpha", files: ["transparent.png"], transparency: "transparent", fileSizeBytes: { exact: input.length } });
    expect((await checkImage(dir, rule, "transparent.png", budget)).status).toBe("passed");
    expect((await checkImage(dir, rule, "wrong.jpg", budget)).code).toBe("IMAGE_SPEC_MISMATCH");
    budget.limits.inputBytes = input.length;
    expect((await checkImage(dir, rule, "transparent.png", budget)).status).toBe("passed");
    budget.limits.inputBytes--;
    expect((await checkImage(dir, rule, "transparent.png", budget)).code).toBe("INPUT_BUDGET");
  });
  it.each(["png", "jpeg", "webp"] as const)(
    "fully decodes %s and checks normalized dimensions",
    async (format) => {
      const { dir, budget, sharp } = await fixture();
      await sharp({ create: { width: 12, height: 8, channels: 3, background: "red" } })
        .toFormat(format)
        .toFile(path.join(dir, `image.${format}`));
      const result = await checkImage(
        dir,
        ImageSchema.parse({
          id: "image",
          files: [`image.${format}`],
          width: { exact: 12 },
          height: { exact: 8 },
        }),
        `image.${format}`,
        budget,
      );
      expect(result.status).toBe("passed");
      expect(result.metrics?.width).toBe(12);
    },
  );
  it("distinguishes an opaque alpha channel from real transparency and unknown DPI", async () => {
    const { dir, budget, sharp } = await fixture();
    await sharp({
      create: { width: 2, height: 3, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
    })
      .png()
      .toFile(path.join(dir, "image.png"));
    const result = await checkImage(
      dir,
      ImageSchema.parse({
        id: "image",
        files: ["image.png"],
        transparency: "transparent",
        dpi: { min: 72 },
      }),
      "image.png",
      budget,
    );
    expect(result.status).toBe("failed");
    expect(result.metrics?.transparentPixels).toBe(0);
    expect(result.metrics?.dpi).toBeNull();
  });
  it("classifies missing, empty and truncated inputs as repairable defects", async () => {
    const { dir, budget, sharp } = await fixture();
    await fs.writeFile(path.join(dir, "empty.png"), "");
    const valid = await sharp({ create: { width: 20, height: 20, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    await fs.writeFile(path.join(dir, "truncated.png"), valid.subarray(0, valid.length - 24));
    for (const file of ["missing.png", "empty.png", "truncated.png"]) {
      const r = await checkImage(
        dir,
        ImageSchema.parse({ id: "image", files: [file] }),
        file,
        budget,
      );
      expect(r.status).toBe("failed");
      expect(r.repairable).toBe(true);
    }
  });
  it("blocks excessive pixels before decoding and rejects wrong extension", async () => {
    const { dir, budget, sharp } = await fixture({ decodedPixels: 10 });
    await sharp({ create: { width: 20, height: 20, channels: 3, background: "red" } })
      .png()
      .toFile(path.join(dir, "wrong.jpeg"));
    const r = await checkImage(
      dir,
      ImageSchema.parse({ id: "image", files: ["wrong.jpeg"] }),
      "wrong.jpeg",
      budget,
    );
    expect(r.code).toBe("PIXEL_BUDGET");
    expect(r.status).toBe("blocked");
  });
});
describe("pixel differences", () => {
  it("rejects different dimensions without inventing a difference ratio and rejects full masks", async () => {
    const { dir, budget, sharp } = await fixture();
    const baseline = path.join(dir, "baseline.png"), actual = path.join(dir, "actual.png");
    await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } }).png().toFile(baseline);
    await sharp({ create: { width: 5, height: 4, channels: 3, background: "red" } }).png().toFile(actual);
    const result = await compareImages(baseline, actual, path.join(dir, "dimension"), { pixelThreshold: 0.1, maxDiffRatio: 1, masks: [] }, budget);
    expect(result.code).toBe("DIMENSION_MISMATCH"); expect(result.metrics.diffRatio).toBeNull(); expect(result.passed).toBe(false);
    await expect(compareImages(baseline, baseline, path.join(dir, "all-masked"), { pixelThreshold: 0.1, maxDiffRatio: 1, masks: [{ x: 0, y: 0, width: 4, height: 4 }] }, budget)).rejects.toMatchObject({ code: "MASK_ALL_PIXELS" });
  });
  it("excludes recognized antialiasing differences", async () => {
    const { dir, budget, sharp } = await fixture();
    const paths = [path.join(dir, "a.png"), path.join(dir, "b.png")];
    for (const [index, x] of [3.2, 3.7].entries()) {
      await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="white"/><rect x="${x}" y="3" width="10" height="14" fill="black"/></svg>`)).png().toFile(paths[index]!);
    }
    const [a, b] = await Promise.all(paths.map((p) => sharp(p).ensureAlpha().raw().toBuffer()));
    const { default: pixelmatch } = await import("pixelmatch");
    const allDifferences = pixelmatch(a!, b!, undefined, 20, 20, { threshold: 0.1, includeAA: true });
    const result = await compareImages(paths[0]!, paths[1]!, path.join(dir, "aa"), { pixelThreshold: 0.1, maxDiffRatio: 1, masks: [] }, budget);
    expect(allDifferences).toBeGreaterThan(0);
    expect("differentPixels" in result.metrics && result.metrics.differentPixels).toBeLessThan(allDifferences);
  });
  it("uses inclusive diff ratio and excludes masked pixels from denominator", async () => {
    const { dir, budget, sharp } = await fixture();
    const baseline = path.join(dir, "baseline.png"),
      actual = path.join(dir, "actual.png");
    const raw = Buffer.alloc(10 * 10 * 4, 255);
    await sharp(raw, { raw: { width: 10, height: 10, channels: 4 } })
      .png()
      .toFile(baseline);
    raw[0] = 0;
    raw[1] = 0;
    raw[2] = 0;
    await sharp(raw, { raw: { width: 10, height: 10, channels: 4 } })
      .png()
      .toFile(actual);
    const equal = await compareImages(
      baseline,
      actual,
      path.join(dir, "equal"),
      { pixelThreshold: 0.1, maxDiffRatio: 0.01, masks: [] },
      budget,
    );
    expect(equal.passed).toBe(true);
    expect(equal.metrics.diffRatio).toBe(0.01);
    const exceeded = await compareImages(
      baseline,
      actual,
      path.join(dir, "exceeded"),
      { pixelThreshold: 0.1, maxDiffRatio: 0.009, masks: [] },
      budget,
    );
    expect(exceeded.passed).toBe(false);
    const masked = await compareImages(
      baseline,
      actual,
      path.join(dir, "masked"),
      { pixelThreshold: 0.1, maxDiffRatio: 0, masks: [{ x: 0, y: 0, width: 1, height: 1 }] },
      budget,
    );
    expect(masked.passed).toBe(true);
    expect("effectivePixels" in masked.metrics && masked.metrics.effectivePixels).toBe(99);
  });
  it("caps disconnected regions and keeps total extent", () => {
    const mask = new Uint8Array(41 * 41);
    for (let y = 0; y < 41; y += 2) for (let x = 0; x < 41; x += 2) mask[y * 41 + x] = 1;
    const result = diffRegions(mask, 41, 41);
    expect(result.regions).toHaveLength(100);
    expect(result.omittedRegions).toBe(341);
    expect(result.bounds).toEqual({ x: 0, y: 0, width: 41, height: 41 });
  });
});
