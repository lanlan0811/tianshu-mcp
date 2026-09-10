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

export function validateTaskReferences(
  task: string,
  context: string | undefined,
  projectRoot: string,
): ValidatedReference[] {
  const text = `${task}\n${context ?? ""}`;
  const values = new Set<string>();
  for (const m of text.matchAll(/`([^`]+)`/g)) values.add(m[1]!.trim());
  for (const m of text.matchAll(/(?:^|\s)((?:[A-Za-z]:[\\/]|\/|\.\.?[\\/])[^\s，。；;]+)/gm))
    values.add(m[1]!.trim());
  const out: ValidatedReference[] = [];
  for (const source of values) {
    // Backticks frequently contain identifiers/commands. Only path-like values are interpreted.
    if (!path.isAbsolute(source) && !/^\.\.?[\\/]/.test(source) && !/[\\/]/.test(source)) continue;
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
