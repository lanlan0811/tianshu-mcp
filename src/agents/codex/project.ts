/**
 * Codex 项目匹配（开发计划决策 2：按文件夹目录名 basename 匹配）。
 * 同名多命中 → 报歧义，绝不猜测。
 */
import type { CodexProjectItem } from "./cdp.js";

export interface CodexProjectMatch {
  item?: CodexProjectItem;
  ambiguous: boolean;
  /** 归一化后的目标目录名 */
  target: string;
}

/** 归一化项目名（Windows 大小写不敏感；NFKC 处理全角/兼容字符） */
export function normalizeProjectName(value: string, platform: NodeJS.Platform = process.platform): string {
  const norm = value.normalize("NFKC").trim();
  return platform === "win32" ? norm.toLocaleLowerCase() : norm;
}

/** 取目录名（同时兼容 Windows 与 POSIX 分隔符，便于跨平台单测） */
export function projectBasename(target: string): string {
  const posix = target.split(/[\\/]+/).filter(Boolean);
  return posix.length ? posix[posix.length - 1]! : target;
}

export function matchCodexProject(
  items: CodexProjectItem[],
  target: string,
  platform: NodeJS.Platform = process.platform,
): CodexProjectMatch {
  const base = normalizeProjectName(projectBasename(target), platform);
  if (!base) return { ambiguous: false, target: base };
  const matched = items.filter((item) => normalizeProjectName(item.name, platform) === base);
  if (matched.length === 1) return { item: matched[0], ambiguous: false, target: base };
  if (matched.length > 1) return { ambiguous: true, target: base };
  return { ambiguous: false, target: base };
}
