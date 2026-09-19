import path from "node:path";

/** 工作区下拉面板里的一项（`button.ws-row[role="menuitem"]`） */
export interface KimicodeWorkspaceItem {
  name: string;
  /** `span.ws-path` 的完整绝对路径；缺失时只能退回名称匹配 */
  path?: string;
}

/**
 * 工作区路径归一：盘符大写 + 反斜杠统一 + 去尾部分隔符 + Windows 大小写不敏感。
 *
 * 实测（2026-09-20，Kimi Code 1.0.2）：原生「添加工作区」对话框拒绝正斜杠形式，面板里
 * `span.ws-path` 回读的是 `D:\Trae项目\tianshu-mcp` 这种原生形式；而任务上下文里的
 * projectPath 可能来自 normPath（正斜杠 + 小写盘符）。绑定判据必须比较**归一化后的完整路径**，
 * 比字面量会把同一目录判成两个。
 *
 * 刻意不做 realpath：这里要保证「面板回读值」与「会话上下文」两段字符串可确定性对齐，
 * 纯词法函数在单测与运行期行为一致（Kimi Code 的 macOS 原生对话框分支 fail-closed，
 * 暂时不需要处理 macOS 符号链接别名，见 dialog.ts）。
 */
export function normalizeWorkspacePath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!value) return "";
  if (platform === "win32") {
    let out = path.win32.normalize(value).replace(/[\\/]+$/, "");
    // win32.normalize 会把「仅盘符」补成 `d:.`；盘根本身要记成 `d:\`，否则会与相对路径混淆。
    if (/^[a-zA-Z]:\.$/.test(out)) out = `${out.slice(0, 2)}\\`;
    if (/^[a-zA-Z]:$/.test(out)) out = `${out}\\`;
    // 大小写不敏感比较：先整体小写，再把盘符恢复成大写（界面回读形式为 D:\...）。
    return out
      .toLocaleLowerCase()
      .replace(/^([a-z]):/, (_match, drive: string) => `${drive.toUpperCase()}:`);
  }
  const out = path.posix.normalize(value);
  return out === "/" ? out : out.replace(/\/+$/, "");
}

/** 工作区显示名归一：NFKC（全半角）+ 折叠空白 + trim + 大小写不敏感 */
export function normalizeWorkspaceName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function identity(item: KimicodeWorkspaceItem): string {
  return item.path ?? item.name;
}

/**
 * 定位目标工作区：**优先完整路径匹配**，路径不可用时才回退名称匹配；
 * 多命中即 ambiguous（同名不同目录绝不能猜一个点，会把任务派到错误目录）。
 */
export function matchKimicodeWorkspace(
  items: KimicodeWorkspaceItem[],
  projectPath: string,
  platform: NodeJS.Platform = process.platform,
): { item?: KimicodeWorkspaceItem; ambiguous: boolean; candidates: string[] } {
  const target = normalizeWorkspacePath(projectPath, platform);
  if (target) {
    const exact = items.filter(
      (item) => item.path && normalizeWorkspacePath(item.path, platform) === target,
    );
    if (exact.length === 1)
      return { item: exact[0], ambiguous: false, candidates: [identity(exact[0]!)] };
    if (exact.length > 1) return { ambiguous: true, candidates: exact.map(identity) };
  }
  const api = platform === "win32" ? path.win32 : path.posix;
  const wanted = normalizeWorkspaceName(api.basename(projectPath));
  if (!wanted) return { ambiguous: false, candidates: [] };
  const byName = items.filter((item) => normalizeWorkspaceName(item.name) === wanted);
  if (byName.length === 1)
    return { item: byName[0], ambiguous: false, candidates: [identity(byName[0]!)] };
  if (byName.length > 1) return { ambiguous: true, candidates: byName.map(identity) };
  return { ambiguous: false, candidates: [] };
}