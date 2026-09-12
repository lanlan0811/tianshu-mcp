import path from "node:path";

export interface ZcodeProjectItem {
  name: string;
  path?: string;
  id?: string;
}

export const PROJECT_PLACEHOLDER_TEXTS = [
  "选择项目",
  "select project",
  "select a project",
  "choose project",
] as const;

function normalizeDisplayName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

export function projectDisplayName(
  projectPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const api = platform === "win32" ? path.win32 : path.posix;
  return api.basename(projectPath).normalize("NFKC").trim();
}

export function sameDisplayName(a: string, b: string): boolean {
  return normalizeDisplayName(a) === normalizeDisplayName(b);
}

export function isUnboundTriggerText(text: string): boolean {
  const normalized = normalizeDisplayName(text);
  const compact = normalized.replace(/\s+/g, "");
  return PROJECT_PLACEHOLDER_TEXTS.some((placeholder) => {
    const normalizedPlaceholder = normalizeDisplayName(placeholder);
    return (
      normalized === normalizedPlaceholder || compact === normalizedPlaceholder.replace(/\s+/g, "")
    );
  });
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
