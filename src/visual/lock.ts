import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { VisualError } from "./errors.js";

export function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export async function withVisualLock<T>(
  home: string,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const directory = path.join(home, "visual-locks");
  await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, `${digest(key)}.lock`);
  let handle;
  try {
    handle = await fs.open(filename, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new VisualError(
        "VISUAL_BUSY",
        "A visual operation owns this project/task lock; retry after completion. Inspect stale lock after a crash.",
      );
    throw e;
  }
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    );
    return await run();
  } finally {
    await handle.close();
    await fs.unlink(filename);
  }
}
