import path from "node:path";
import { decodeImage } from "./images.js";
import { loadSharp } from "./runtime.js";
import { VisualError } from "./errors.js";
import type { VisualBudget } from "./budget.js";
import type { Rectangle } from "./types.js";

/** Four-connected components, bounded report size without discarding total extent. */
export function diffRegions(mask: Uint8Array, width: number, height: number) {
  const visited = new Uint8Array(mask.length);
  const queue = new Uint32Array(mask.length);
  const regions: Rectangle[] = [];
  let count = 0;
  let left = width,
    top = height,
    right = -1,
    bottom = -1;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    let head = 0,
      tail = 1,
      minX = width,
      minY = height,
      maxX = 0,
      maxY = 0;
    queue[0] = start;
    visited[start] = 1;
    while (head < tail) {
      const n = queue[head++]!,
        x = n % width,
        y = Math.floor(n / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      for (const adjacent of [
        x > 0 ? n - 1 : -1,
        x + 1 < width ? n + 1 : -1,
        y > 0 ? n - width : -1,
        y + 1 < height ? n + width : -1,
      ]) {
        if (adjacent >= 0 && mask[adjacent] && !visited[adjacent]) {
          visited[adjacent] = 1;
          queue[tail++] = adjacent;
        }
      }
    }
    count++;
    left = Math.min(left, minX);
    top = Math.min(top, minY);
    right = Math.max(right, maxX);
    bottom = Math.max(bottom, maxY);
    regions.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, area: tail });
    regions.sort((a, b) => b.area! - a.area!);
    if (regions.length > 100) regions.pop();
  }
  return {
    regions,
    omittedRegions: Math.max(0, count - regions.length),
    bounds: count ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null,
  };
}

export async function compareImages(
  baseline: string,
  actual: string,
  directory: string,
  options: { pixelThreshold: number; maxDiffRatio: number; masks: Rectangle[] },
  budget: VisualBudget,
) {
  const [a, b, sharp, { default: pixelmatch }] = await Promise.all([
    decodeImage(baseline, budget),
    decodeImage(actual, budget),
    loadSharp(),
    import("pixelmatch"),
  ]);
  const baselineCopy = path.join(directory, "baseline.png");
  await budget.write(baselineCopy, await sharp(a.data, { raw: a.info }).png().toBuffer());
  const artifacts: Record<string, string> = { baseline: baselineCopy, actual };
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
    return {
      passed: false,
      code: "DIMENSION_MISMATCH",
      metrics: {
        baselineWidth: a.info.width,
        baselineHeight: a.info.height,
        actualWidth: b.info.width,
        actualHeight: b.info.height,
        diffRatio: null,
      },
      regions: [],
      artifacts,
    };
  }
  const { width, height } = a.info;
  const excluded = new Uint8Array(width * height);
  for (const rect of options.masks) {
    for (
      let y = Math.max(0, Math.floor(rect.y));
      y < Math.min(height, Math.ceil(rect.y + rect.height));
      y++
    )
      for (
        let x = Math.max(0, Math.floor(rect.x));
        x < Math.min(width, Math.ceil(rect.x + rect.width));
        x++
      )
        excluded[y * width + x] = 1;
  }
  let effectivePixels = 0;
  for (let n = 0; n < excluded.length; n++) {
    if (excluded[n]) {
      a.data.fill(0, n * 4, n * 4 + 4);
      b.data.fill(0, n * 4, n * 4 + 4);
    } else effectivePixels++;
  }
  if (!effectivePixels)
    throw new VisualError("MASK_ALL_PIXELS", "Masks exclude every comparison pixel");
  const diff = Buffer.alloc(a.data.length);
  pixelmatch(a.data, b.data, diff, width, height, {
    threshold: options.pixelThreshold,
    includeAA: false,
    diffMask: true,
  });
  const mask = new Uint8Array(width * height);
  let differentPixels = 0;
  for (let n = 0; n < mask.length; n++)
    if (!excluded[n] && diff[n * 4 + 3]) {
      mask[n] = 1;
      differentPixels++;
    }
  const regions = diffRegions(mask, width, height);
  const diffRatio = differentPixels / effectivePixels;
  const metrics = {
    width,
    height,
    differentPixels,
    effectivePixels,
    diffRatio,
    includeAA: false,
    pixelThreshold: options.pixelThreshold,
    maxDiffRatio: options.maxDiffRatio,
    omittedRegions: regions.omittedRegions,
    bounds: regions.bounds,
  };
  artifacts.diff = path.join(directory, "diff.png");
  await budget.write(
    artifacts.diff,
    await sharp(diff, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer(),
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${regions.regions.map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="none" stroke="red" stroke-width="2"/>`).join("")}</svg>`;
  artifacts.regions = path.join(directory, "regions.png");
  await budget.write(
    artifacts.regions,
    await sharp(b.data, { raw: b.info })
      .composite([{ input: Buffer.from(svg) }])
      .png()
      .toBuffer(),
  );
  artifacts.metrics = path.join(directory, "metrics.json");
  await budget.write(artifacts.metrics, JSON.stringify(metrics, null, 2));
  budget.check();
  return {
    passed: diffRatio <= options.maxDiffRatio,
    code: diffRatio <= options.maxDiffRatio ? "PIXELS_MATCH" : "PIXEL_DIFFERENCE",
    metrics,
    regions: regions.regions,
    artifacts,
  };
}
