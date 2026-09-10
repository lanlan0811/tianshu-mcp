import path from "node:path";

export interface ZcodeProjectItem {
  name: string;
  path?: string;
  id?: string;
}

export function normalizeProjectPath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const api = platform === "win32" ? path.win32 : path.posix;
  let out = api.normalize(value).replace(/[\\/]+$/, "");
  if (platform === "win32") out = out.replace(/\\/g, "/").toLowerCase();
  return out;
}

export function matchZcodeProject(
  items: ZcodeProjectItem[],
  target: string,
  platform: NodeJS.Platform = process.platform,
): { item?: ZcodeProjectItem; ambiguous: boolean } {
  const exact = items.filter(
    (item) =>
      item.path &&
      normalizeProjectPath(item.path, platform) === normalizeProjectPath(target, platform),
  );
  if (exact.length === 1) return { item: exact[0], ambiguous: false };
  if (exact.length > 1) return { ambiguous: true };
  const api = platform === "win32" ? path.win32 : path.posix;
  const base = api.basename(target);
  const names = items.filter((item) => exactName(item.name, base, platform));
  if (names.length > 0) return { ambiguous: true };
  return { ambiguous: false };
}

function exactName(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
