/**
 * 会话与项目文件夹（开发计划 §4.5 步骤 3，对应图1/图2/图3）。
 *
 * 流程：
 *   1. 点「新建任务」开干净会话（每任务一个 TraeWork 会话，决策 5）
 *   2. 点「选择文件夹（可选）」展开应用内下拉（图2，纯 DOM）
 *   3. 在下拉里按 basename / 绝对路径匹配已有项目 → 命中直接选择
 *   4. 未命中 → 点下拉底部「选择文件夹」→ 走受限 computer-use 驱动原生对话框（图3）
 */
import type { TraeworkCdpClient } from "../cdp/client.js";
import type { AgentRunLogger } from "../../adapter.js";
import type { SelectorOverrides } from "../cdp/selectors.js";
import { pickFolderViaNativeDialog } from "../computeruse/dialog.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface ProjectFolderItem {
  /** 显示名（如 zhiyu） */
  name: string;
  /** 副标题里的路径（可能为绝对路径或显示路径） */
  subtitle: string;
  /** 元素中心坐标（坐标点击用） */
  x?: number;
  y?: number;
}

/** 归一化路径用于比较：小写、正反斜杠统一、去尾部斜杠 */
export function normComparePath(p: string): string {
  return (p || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * 项目名（basename）——决策 9：任务文件夹名称取 projectPath 的 basename。
 * 不能用 `path.basename`：它是平台相关的（POSIX 下不把 `\` 当分隔符），
 * 而项目路径可能来自 Windows（含反斜杠）却在 Linux/macOS 上被处理（CI/跨平台）。
 * 这里显式同时按 `\` 与 `/` 切分。
 */
export function projectBasename(projectPath: string): string {
  const trimmed = projectPath.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * 判断下拉项是否匹配目标项目。
 * 匹配规则（任一命中即可）：basename 相等（不区分大小写）；或副标题路径与目标路径归一化后相等/为其尾部。
 */
export function matchProjectItem(item: ProjectFolderItem, projectPath: string): boolean {
  const wantName = projectBasename(projectPath).toLowerCase();
  if (item.name.trim().toLowerCase() === wantName) return true;
  const wantPath = normComparePath(projectPath);
  const gotPath = normComparePath(item.subtitle);
  if (!gotPath) return false;
  if (gotPath === wantPath) return true;
  // 副标题可能只显示尾部路径（如 "...\Trae项目\zhiyu"）
  return wantPath.endsWith(gotPath) || gotPath.endsWith(wantPath);
}

/** 新建会话（点「新建任务」） */
export async function startNewSession(
  cdp: TraeworkCdpClient,
  opts: { selectors?: SelectorOverrides; logger: AgentRunLogger },
): Promise<boolean> {
  const ok = await cdp.click("newTask", opts.selectors);
  if (!ok) {
    opts.logger.warn("[traework] 未找到「新建任务」按钮，跳过会话隔离（fail-open）");
    return false;
  }
  await sleep(2500);
  return true;
}

/** 读取当前面板模式（Work / Code / Design） */
export async function readMode(cdp: TraeworkCdpClient, selectors?: SelectorOverrides): Promise<string> {
  const raw = await cdp.evaluateString(`(function(){
    const sw = document.querySelector('[class*="mode-switcher-btn"]');
    if (!sw) return '';
    const active = sw.querySelector('[class*="tabActive"]');
    return active ? (active.textContent || '').trim() : '';
  })()`);
  void selectors;
  return raw;
}

/**
 * 切换到指定面板模式。
 * 实测（1.107.1）：项目文件夹按钮「选择文件夹（可选）」只在 Work 模式出现，
 * Code 模式没有——因此绑定项目前必须先确保处于 Work 模式。
 */
export async function ensureMode(
  cdp: TraeworkCdpClient,
  mode: "Work" | "Code" | "Design",
  opts: { selectors?: SelectorOverrides; logger: AgentRunLogger },
): Promise<boolean> {
  const cur = await readMode(cdp, opts.selectors);
  if (cur.toLowerCase() === mode.toLowerCase()) return true;
  const pos = await cdp.evaluateString(`(function(){
    const tabs = [...document.querySelectorAll('[class*="mode-switcher-btn"] [class*="tab"]')]
      .filter(e => (e.textContent || '').trim() === ${JSON.stringify(mode)});
    if (!tabs[0]) return '';
    const r = tabs[0].getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return '';
    return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
  })()`);
  if (!pos) {
    opts.logger.warn(`[traework] 找不到模式分段「${mode}」（当前 ${cur || "未知"}）`);
    return false;
  }
  const { x, y } = JSON.parse(pos) as { x: number; y: number };
  await cdp.clickAt(x, y);
  await sleep(2000);
  const after = await readMode(cdp, opts.selectors);
  if (after.toLowerCase() === mode.toLowerCase()) {
    opts.logger.info(`[traework] 已切换到 ${mode} 模式`);
    return true;
  }
  opts.logger.warn(`[traework] 切换到 ${mode} 模式后验证不一致（当前 ${after || "未知"}）`);
  return false;
}

/** 读取任务列表中已有的会话标题（诊断用） */
export async function listSessions(cdp: TraeworkCdpClient, selectors?: SelectorOverrides): Promise<string[]> {
  const raw = await cdp.evaluateString(`(function(){
    const cs = ${JSON.stringify([selectors?.taskListItem, ".taskText", ".solo-lite-task-item"].filter(Boolean))};
    let items = [];
    for (const c of cs) { const f = document.querySelectorAll(c); if (f.length) { items = [...f]; break; } }
    return JSON.stringify(items.map(e => (e.textContent || '').trim()).filter(Boolean));
  })()`);
  try {
    return JSON.parse(raw || "[]") as string[];
  } catch {
    return [];
  }
}

/** 读取任务列表中的项目分组名（= 项目文件夹名称，图1） */
export async function listProjectGroups(cdp: TraeworkCdpClient, selectors?: SelectorOverrides): Promise<string[]> {
  const raw = await cdp.evaluateString(`(function(){
    const cs = ${JSON.stringify([selectors?.taskListGroupName, ".task-list-group-name"].filter(Boolean))};
    let items = [];
    for (const c of cs) { const f = document.querySelectorAll(c); if (f.length) { items = [...f]; break; } }
    return JSON.stringify([...new Set(items.map(e => (e.textContent || '').trim()).filter(Boolean))]);
  })()`);
  try {
    return JSON.parse(raw || "[]") as string[];
  } catch {
    return [];
  }
}

/** 读取「选择文件夹」下拉中的项目项（图2） */
export async function readProjectItems(
  cdp: TraeworkCdpClient,
  selectors?: SelectorOverrides,
): Promise<ProjectFolderItem[]> {
  const itemSel = selectors?.cascadeMenuItem ?? '[class*="cascadeMenuItemWithSubtitle"]';
  const titleSel = selectors?.cascadeMenuItemTitle ?? '[class*="cascadeMenuItemTitle"]';
  const subSel = selectors?.cascadeMenuItemSubtitle ?? '[class*="cascadeMenuItemSubtitle"]';
  const raw = await cdp.evaluateString(`(function(){
    const items = [...document.querySelectorAll(${JSON.stringify(itemSel)})];
    const out = [];
    for (const it of items) {
      const r = it.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const nameEl = it.querySelector(${JSON.stringify(titleSel)});
      const subEl = it.querySelector(${JSON.stringify(subSel)});
      const name = nameEl ? (nameEl.textContent || '').trim() : '';
      const subtitle = subEl ? (subEl.textContent || '').trim() : '';
      if (!name) continue;
      out.push({ name, subtitle, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
    }
    return JSON.stringify(out);
  })()`);
  try {
    const arr = JSON.parse(raw || "[]") as Array<ProjectFolderItem & { x?: number; y?: number }>;
    return arr.map((a) => ({ name: a.name, subtitle: a.subtitle, x: a.x, y: a.y }) as ProjectFolderItem & { x?: number; y?: number });
  } catch {
    return [];
  }
}

/** 点击下拉中某个项目项（按匹配结果，坐标点击） */
async function clickProjectItemAt(
  cdp: TraeworkCdpClient,
  projectPath: string,
  selectors?: SelectorOverrides,
): Promise<boolean> {
  const items = await readProjectItems(cdp, selectors);
  const target = items.find((it) => matchProjectItem(it, projectPath));
  if (!target) return false;
  const pos = target as ProjectFolderItem & { x?: number; y?: number };
  if (typeof pos.x !== "number" || typeof pos.y !== "number") return false;
  await cdp.clickAt(pos.x, pos.y);
  return true;
}

/** 读取当前输入栏绑定的项目名（未绑定返回空） */
export async function readBoundProject(cdp: TraeworkCdpClient, selectors?: SelectorOverrides): Promise<string> {
  // 已绑定态：输入栏有若干 inputBarButton，其中文本非「本地」的那个即项目名
  const raw = await cdp.evaluateString(`(function(){
    const btns = [...document.querySelectorAll('[class*="inputBarButton"]')];
    const out = [];
    for (const b of btns) {
      const r = b.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const t = (b.textContent || '').trim();
      if (t) out.push(t);
    }
    return JSON.stringify(out);
  })()`);
  void selectors;
  try {
    const arr = JSON.parse(raw || "[]") as string[];
    return arr.find((t) => t && t !== "本地") ?? "";
  } catch {
    return "";
  }
}

/** 展开「选择文件夹」下拉（图2） */
async function openProjectDropdown(
  cdp: TraeworkCdpClient,
  opts: { selectors?: SelectorOverrides; logger: AgentRunLogger },
): Promise<boolean> {
  // 优先点 placeholder 形态（未绑定）
  if (await cdp.click("projectButton", opts.selectors)) {
    await sleep(1500);
    if ((await cdp.exists("cascadeMenu", opts.selectors)) || (await readProjectItems(cdp, opts.selectors)).length > 0) {
      return true;
    }
  }
  // 已绑定态：点文本非「本地」的 inputBarButton
  const clicked = await cdp.evaluate<boolean>(`(function(){
    const btns = [...document.querySelectorAll('[class*="inputBarButton"]')];
    for (const b of btns) {
      const r = b.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const t = (b.textContent || '').trim();
      if (t && t !== '本地') { b.click(); return true; }
    }
    return false;
  })()`);
  if (!clicked) return false;
  await sleep(1500);
  return (await cdp.exists("cascadeMenu", opts.selectors)) || (await readProjectItems(cdp, opts.selectors)).length > 0;
}

/** 点下拉底部「选择文件夹」→ 原生对话框 */
async function clickDropdownFooter(
  cdp: TraeworkCdpClient,
  opts: { selectors?: SelectorOverrides; logger: AgentRunLogger },
): Promise<boolean> {
  // 底部按钮可能是「选择文件夹」文本；先按选择器，再按文本兜底
  if (await cdp.click("cascadeMenuFooter", opts.selectors)) {
    await sleep(1200);
    return true;
  }
  const clicked = await cdp.evaluate<boolean>(`(function(){
    const all = [...document.querySelectorAll('button,div,span,a')];
    const btn = all.find(e => (e.textContent || '').trim() === '选择文件夹' && e.getBoundingClientRect().width > 0);
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  if (clicked) await sleep(1200);
  return clicked === true;
}

export interface BindProjectResult {
  bound: boolean;
  method: "dropdown" | "native-dialog" | "already-selected" | "failed";
  message: string;
}

/**
 * 把目标项目绑定到当前会话。
 * @param projectPath 项目绝对路径
 */
export async function bindProject(
  cdp: TraeworkCdpClient,
  projectPath: string,
  opts: { selectors?: SelectorOverrides; logger: AgentRunLogger; mode?: "Work" | "Code" | "Design" },
): Promise<BindProjectResult> {
  const { selectors, logger } = opts;

  // 实测（1.107.1）：「选择文件夹」按钮只在 Work 模式出现，先确保模式正确
  const wantMode = opts.mode ?? "Work";
  const modeOk = await ensureMode(cdp, wantMode, { selectors, logger });
  if (!modeOk) {
    logger.warn(`[traework] 未能确认处于 ${wantMode} 模式，仍尝试绑定项目（fail-open）`);
  }

  // 已绑定且就是目标项目 → 直接返回（避免多余操作）
  const bound = await readBoundProject(cdp, selectors);
  if (bound && matchProjectItem({ name: bound, subtitle: "" }, projectPath)) {
    logger.info(`[traework] 输入栏已绑定项目「${bound}」，无需重新选择`);
    return { bound: true, method: "already-selected", message: `已绑定: ${bound}` };
  }

  // 展开下拉
  if (!(await openProjectDropdown(cdp, opts))) {
    // 下拉未展开且未识别为已绑定 → 明确的失败（不静默继续）
    const btnText = await cdp.text("projectButton", selectors);
    return {
      bound: false,
      method: "failed",
      message: `无法展开「选择文件夹」下拉（按钮未找到${btnText ? `，当前文本「${btnText}」` : ""}）`,
    };
  }

  // 下拉内匹配
  const items = await readProjectItems(cdp, selectors);
  logger.info(`[traework] 项目下拉共 ${items.length} 项：${items.map((i) => i.name).join("、") || "空"}`);
  const hit = items.find((it) => matchProjectItem(it, projectPath));
  if (hit) {
    const ok = await clickProjectItemAt(cdp, projectPath, selectors);
    if (ok) {
      await sleep(1500);
      logger.info(`[traework] 已在下拉中选中项目「${hit.name}」`);
      return { bound: true, method: "dropdown", message: `下拉命中: ${hit.name}` };
    }
  }

  // 未命中 → 底部「选择文件夹」→ 原生对话框
  logger.info(`[traework] 下拉未命中项目「${projectBasename(projectPath)}」，改走原生选择文件夹对话框`);
  if (!(await clickDropdownFooter(cdp, opts))) {
    return { bound: false, method: "failed", message: "下拉未命中且找不到底部「选择文件夹」按钮" };
  }
  const picked = await pickFolderViaNativeDialog(projectPath, { logger });
  if (!picked.ok) {
    return { bound: false, method: "native-dialog", message: picked.message };
  }
  await sleep(1500);
  return { bound: true, method: "native-dialog", message: picked.message };
}
