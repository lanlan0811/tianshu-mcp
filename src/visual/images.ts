import fs from "node:fs/promises";

import { loadSharp } from "./runtime.js";
import { VisualError } from "./errors.js";



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
