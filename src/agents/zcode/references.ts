import fs from "node:fs";
import path from "node:path";

export interface ValidatedReference {
  source: string;
  absolutePath: string;
  directory: boolean;
}

function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 从任务书/上下文中抽取「像本地路径」的候选值（URL、模型名、命令文本等已被排除）。 */
export function collectLocalReferences(task: string, context?: string): string[] {
  const text = `${task}\n${context ?? ""}`;
  const values = new Set<string>();
  for (const m of text.matchAll(/`([^`]+)`/g)) values.add(m[1]!.trim());
  for (const m of text.matchAll(/(?:^|\s)((?:[A-Za-z]:[\\/]|\/|\.\.?[\\/])[^\s，。；;]+)/gm))
    values.add(m[1]!.trim());
  return [...values].filter(
    (source) => path.isAbsolute(source) || /^\.\.?[\\/]/.test(source) || /[\\/]/.test(source),
  );
}

/**
 * 校验任务书里的本地引用。
 *
 * `projectRoot` 缺失（无项目模式，issue #12）时**不得**退回 cwd / 主目录 / 日志目录去解析：
 * 识别到明确引用就直接说明需要 projectPath，没有引用则返回空表。
 */
export function validateTaskReferences(
  task: string,
  context: string | undefined,
  projectRoot: string | undefined,
): ValidatedReference[] {
  const candidates = collectLocalReferences(task, context);
  if (!projectRoot) {
    if (candidates.length)
      throw new Error(
        `任务书包含本地文件引用（${candidates.slice(0, 5).join("、")}${candidates.length > 5 ? ` 等 ${candidates.length} 项` : ""}）；无项目模式无法解析路径，请提供 projectPath`,
      );
    return [];
  }
  const out: ValidatedReference[] = [];
  for (const source of candidates) {
    const absolutePath = path.resolve(projectRoot, source);
    if (!inside(path.resolve(projectRoot), absolutePath))
      throw new Error(`引用路径越出项目范围：${source}`);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolutePath);
    } catch {
      throw new Error(`引用路径不存在：${source}`);
    }
    out.push({ source, absolutePath, directory: stat.isDirectory() });
  }
  return out;
}
