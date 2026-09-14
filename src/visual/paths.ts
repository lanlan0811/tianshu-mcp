import path from "node:path";
import fs from "node:fs/promises";
import { VisualError } from "./errors.js";

export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}
/** Resolve every existing ancestor, including symlinks, for both reads and writes. */
export async function projectFile(root: string, relative: string): Promise<string> {
  const realRoot = await fs.realpath(root);
  const target = path.resolve(realRoot, relative);
  if (!isWithin(realRoot, target))
    throw new VisualError("PATH_OUTSIDE_PROJECT", "Path escapes project");
  let ancestor = target;
  while (true) {
    try {
      const real = await fs.realpath(ancestor);
      if (!isWithin(realRoot, real))
        throw new VisualError("PATH_OUTSIDE_PROJECT", "Symlink escapes project");
      return path.join(real, path.relative(ancestor, target));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (ancestor === realRoot) throw e;
      ancestor = path.dirname(ancestor);
    }
  }
}
