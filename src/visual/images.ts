import fs from "node:fs/promises";
import path from "node:path";
import { loadSharp } from "./runtime.js";
import { VisualError, visualError } from "./errors.js";
import { projectFile } from "./paths.js";
import type { VisualImage } from "./schema.js";
import type { VisualResult } from "./types.js";
import type { VisualBudget } from "./budget.js";

export async function decodeImage(filename: string, budget: VisualBudget) {
  budget.check();
  const sharp = await loadSharp();
  let input: Buffer;
  try {
    const stat = await fs.stat(filename);
    if (!stat.isFile())
      throw new VisualError("IMAGE_INVALID", "Input is not a regular file", "failed");
    if (stat.size > budget.limits.inputBytes)
      throw new VisualError("INPUT_BUDGET", "Image exceeds input byte budget");
    if (!stat.size) throw new VisualError("IMAGE_EMPTY", "Image is empty", "failed");
    const handle = await fs.open(filename, "r");
    try {
      const buffer = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        budget.check();
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > stat.size) throw new VisualError("INPUT_CHANGED", "Image grew while being read; retry with a stable file");
      input = buffer.subarray(0, offset);
    } finally { await handle.close(); }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new VisualError("IMAGE_MISSING", `Missing image: ${filename}`, "failed");
    if (e instanceof VisualError) throw e;
    throw new VisualError("IMAGE_UNREADABLE", "Cannot read image (check permissions)");
  }
  try {
    const options = { limitInputPixels: budget.limits.decodedPixels, failOn: "warning" as const };
    const metadata = await sharp(input, { ...options, limitInputPixels: false }).metadata();
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > budget.limits.decodedPixels
    )
      throw new VisualError("PIXEL_BUDGET", "Image exceeds decoded pixel budget");
    if (
      !["png", "jpeg", "webp"].includes(metadata.format ?? "") ||
      (metadata.pages ?? 1) > 1 ||
      metadata.delay?.length
    )
      throw new VisualError(
        "IMAGE_UNSUPPORTED",
        "Only static PNG, JPEG and WebP are supported",
        "failed",
      );
    const decoded = await sharp(input, options)
      .rotate()
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .timeout({
        seconds: Math.max(1, Math.ceil(budget.timeout(budget.limits.itemTimeoutMs) / 1000)),
      })
      .toBuffer({ resolveWithObject: true });
    budget.check();
    return { input, metadata, ...decoded };
  } catch (e) {
    if (e instanceof VisualError) throw e;
    if (/timeout/i.test(String(e))) throw new VisualError("ITEM_TIMEOUT", "Image decoding deadline exceeded");
    throw new VisualError("IMAGE_CORRUPT", "Image cannot be fully decoded", "failed");
  }
}
export async function checkImage(
  project: string,
  rule: VisualImage,
  file: string,
  budget: VisualBudget,
): Promise<VisualResult> {
  const started = Date.now();
  const result: VisualResult = {
    id: rule.id,
    kind: "image",
    target: file,
    optional: rule.optional,
    status: "passed",
    code: "IMAGE_MATCH",
    message: "Image meets specifications",
    repairable: false,
    durationMs: 0,
    rules: rule,
  };
  try {
    const decoded = await decodeImage(await projectFile(project, file), budget);
    const { width, height } = decoded.info;
    let transparentPixels = 0;
    for (let i = 3; i < decoded.data.length; i += 4)
      if (decoded.data[i]! < 255) transparentPixels++;
    const metrics = {
      width,
      height,
      aspectRatio: width / height,
      fileSizeBytes: decoded.input.length,
      format: decoded.metadata.format,
      dpi: decoded.metadata.density ?? null,
      transparentPixels,
    };
    result.metrics = metrics;
    const failures: string[] = [];
    const extension = path.extname(file).slice(1).toLowerCase().replace(/^jpg$/, "jpeg");
    if (extension !== metrics.format) failures.push("File extension does not match encoded format");
    if (rule.formats && !rule.formats.includes(metrics.format as "png" | "jpeg" | "webp"))
      failures.push("Encoded format is not allowed");
    for (const key of ["width", "height", "aspectRatio", "fileSizeBytes", "dpi"] as const) {
      const range = rule[key],
        actual = metrics[key];
      if (
        range &&
        (actual === null ||
          (range.exact !== undefined && actual !== range.exact) ||
          (range.min !== undefined && actual < range.min) ||
          (range.max !== undefined && actual > range.max))
      )
        failures.push(`${key}: expected ${JSON.stringify(range)}, actual ${actual ?? "unknown"}`);
    }
    if (rule.transparency === "transparent" && !transparentPixels)
      failures.push("No actual transparent pixels");
    if (rule.transparency === "opaque" && transparentPixels)
      failures.push("Image contains transparent pixels");
    if (failures.length)
      Object.assign(result, {
        status: "failed",
        code: "IMAGE_SPEC_MISMATCH",
        message: failures.join("; "),
        repairable: true,
      });
  } catch (e) {
    const error = visualError(e);
    Object.assign(result, {
      status: error.kind === "cancelled" ? "skipped" : error.kind,
      code: error.code,
      message: error.message,
      repairable: error.kind === "failed",
    });
  }
  result.durationMs = Date.now() - started;
  return result;
}
