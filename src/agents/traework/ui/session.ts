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
import {
  closeStaleFolderDialogs,
  findFolderDialog,
  pickFolderViaNativeDialog,
  type FolderDialogInfo,
} from "../computeruse/dialog.js";

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** UI 层会话/绑定函数的公共选项；sleep 为测试注入点（生产缺省真实 sleep） */
export interface SessionUiOptions {
  selectors?: SelectorOverrides;
  logger: AgentRunLogger;
  sleep?: (ms: number) => Promise<void>;
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
  opts: SessionUiOptions,
): Promise<boolean> {
  const ok = await cdp.click("newTask", opts.selectors);
  if (!ok) {
    opts.logger.warn("[traework] 未找到「新建任务」按钮，跳过会话隔离（fail-open）");
    return false;
  }
  await (opts.sleep ?? defaultSleep)(2500);
  return true;
}

/** TraeWork 面板模式（类型真源在 config/schema.ts） */
export type { TraeworkMode } from "../../../config/schema.js";
import type { TraeworkMode } from "../../../config/schema.js";

/**
 * 从任务书文本识别面板模式（自然语言兜底，决策：显式参数 > 文本 > 默认 Work）。
 * 支持中英混写，例如：
 *   「切换到 Code 模式」「用 Work 模式做」「设计模式下…」「工作模式」「代码模式」「设计模式」
 * 未命中返回 undefined（调用方保持默认）。
 */
export function detectModeFromText(text: string): TraeworkMode | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();
  // 英文模式名（允许中间有空格/连字符，如 "code mode" / "code-mode"）
  if (/\bcode\b/.test(t) && /(mode|模式)/.test(t)) return "Code";
  if (/\bdesign\b/.test(t) && /(mode|模式)/.test(t)) return "Design";
  if (/\bwork\b/.test(t) && /(mode|模式)/.test(t)) return "Work";
  // 中文别名
  if (/代码模式|编码模式|编程模式/.test(t)) return "Code";
  if (/设计模式/.test(t)) return "Design";
  if (/工作模式/.test(t)) return "Work";
  return undefined;
}

export interface ResolvedMode {
  mode: TraeworkMode;
  /** param=显式参数；text=任务书识别；default=保持 Work */
  source: "param" | "text" | "default";
}

/**
 * 解析本次任务的目标面板模式：显式参数优先，其次任务书文本，最后默认 Work。
 * 注意：项目文件夹绑定始终在 Work 模式完成，切到目标模式发生在绑定之后（见 run.ts）。
 */
export function resolveMode(explicit: TraeworkMode | undefined, taskText: string): ResolvedMode {
  if (explicit) return { mode: explicit, source: "param" };
  const fromText = detectModeFromText(taskText);
  if (fromText) return { mode: fromText, source: "text" };
  return { mode: "Work", source: "default" };
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
  mode: TraeworkMode,
  opts: SessionUiOptions,
): Promise<boolean> {
  const sleep = opts.sleep ?? defaultSleep;
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
  opts: SessionUiOptions,
): Promise<boolean> {
  const sleep = opts.sleep ?? defaultSleep;
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

/**
 * footer 点击实际生效的执行方式（issue #38）：用于日志与测试断言，
 * 取代旧实现里误导性的「点击=选择器」（旧日志把弱信号写成成功）。
 */
export type FooterClickVia = "坐标" | "选择器" | "文本" | "none";

/**
 * 坐标点击（第一级）占用的探测预算比例（issue #38）。
 *
 * 生产 20s × 0.30 = 6s，按本机实测的单次原生窗口探测成本（1.0–4.8s，见
 * `.rivet/plans/issue-38-*.md` 的实测表）折算 ≈ **1–4 次探测**。取值为工程估算，
 * 需真机校准；比例切分同时让测试注入的短预算自动得到对应窗口，无需双常量。
 */
export const FOOTER_FIRST_ATTEMPT_SHARE = 0.3;

/**
 * 单次原生窗口探测的最小墙钟成本估计（issue #38 本机实测下限 1.0s，中位约 1.5s，最坏 4.8s）。
 *
 * `waitDialogAppeared` 用它做「剩余预算还够不够再探一次」的判断：不够就直接返回，
 * 避免每级末尾多溢出一次「sleep + 探测」（真机实测曾把 20s 预算跑成 28.2s）。
 */
const MIN_PROBE_COST_MS = 1_000;

/** 测试专用导出别名：@internal 仅供单测驱动三级阶梯，生产代码不调用 */
export { clickDropdownFooter as clickDropdownFooterForTest };

/**
 * 点下拉底部「选择文件夹」→ 唤起原生对话框。
 *
 * 实测踩坑（2026-09-08）：`element.click()` 对某些 DirectUI 按钮不会真正触发原生
 * 弹窗（点击「成功」但对话框没出现），旧实现只看点击返回值就返回 true，导致下游
 * 「等待原生对话框超时」这一误导性错误。
 *
 * 修复（issue #38 问题 A）：**重试决策改由副作用驱动**——判定依据是「原生对话框是否
 * 出现」，而不是任何 click 调用的返回值。执行方式按可靠性降序排成三级阶梯
 * （坐标点击 → 语义键 DOM → 文本兜底），每级有独立有界探测窗，失败必升级。
 *
 * 不变量：
 * - 返回 `clicked=true` ⟺ 已观测到原生对话框出现（与 click 返回值无关）。
 * - 总探测预算 ≤ `dialogWaitTimeoutMs`（点击动作自身开销单列，量级 ms）。
 * - 每级探测窗口 ≥ 单次原生窗口探测的实测成本（见 FOOTER_FIRST_ATTEMPT_SHARE）。
 *
 * @internal 导出仅供单测驱动（`clickDropdownFooterForTest`）。
 */
export async function clickDropdownFooter(
  cdp: TraeworkCdpClient,
  opts: SessionUiOptions & { dialogWaitTimeoutMs?: number },
): Promise<{ clicked: boolean; hwnd: number; via: FooterClickVia }> {
  const { logger } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const budget = opts.dialogWaitTimeoutMs ?? 20_000;
  const deadline = Date.now() + budget;

  // 阶梯按「执行方式可靠性」降序：
  // ① 坐标点击 = 真实鼠标事件（#35 真机实测多次稳定弹出）
  // ② 语义键 DOM click = 弱信号（对 DirectUI 按钮会「返回成功却不弹窗」）
  // ③ 文本兜底 = 扩大到 footer 容器内的可点击元素
  const ladder: Array<{ via: FooterClickVia; fire: () => Promise<boolean> }> = [
    {
      via: "坐标",
      fire: async () => {
        const pos = await cdp.center("cascadeMenuFooter", opts.selectors);
        if (!pos) return false;
        await cdp.clickAt(pos.x, pos.y);
        return true;
      },
    },
    { via: "选择器", fire: () => cdp.click("cascadeMenuFooter", opts.selectors) },
    { via: "文本", fire: () => clickFooterByText(cdp) },
  ];

  for (const [i, step] of ladder.entries()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const fired = await step.fire().catch(() => false);
    if (!fired) continue;
    // I3：首级窗口按比例切分（生产 20s × 0.30 = 6s，按实测探测成本 1.0–4.8s 折算 ≈ 1–4 次探测）；
    // 其余各级用掉剩余预算。总探测 ≤ 预算，不膨胀。
    const left = deadline - Date.now();
    if (left <= 0) break;
    const window = i === 0 ? Math.min(left, Math.ceil(budget * FOOTER_FIRST_ATTEMPT_SHARE)) : left;
    const appeared = await waitDialogAppeared(window, sleep);
    if (appeared) {
      logger.info(`[traework] 原生「选择文件夹」对话框已弹出（hwnd=${appeared.hwnd}，方式=${step.via}）`);
      return { clicked: true, hwnd: appeared.hwnd, via: step.via };
    }
    logger.warn(`[traework] 「${step.via}」点击后原生对话框未在 ${window}ms 内出现，升级到下一级`);
  }

  // 阶梯耗尽：记录下拉 DOM 快照，便于诊断选择器漂移
  const snapshot = await cdp
    .evaluateString(`(function(){
      const nodes = [...document.querySelectorAll('[class*="cascade"]')].slice(0, 12)
        .map(e => String(e.className).slice(0, 80) + ' | ' + (e.textContent || '').trim().slice(0, 30));
      return JSON.stringify(nodes);
    })()`)
    .catch(() => "");
  logger.warn(`[traework] 三级点击阶梯均未唤起原生对话框；下拉 DOM 快照: ${snapshot || "n/a"}`);
  return { clicked: false, hwnd: 0, via: "none" };
}

/** 文本兜底：在 footer / 下拉容器内按文本「选择文件夹」找到可点击元素并 click */
async function clickFooterByText(cdp: TraeworkCdpClient): Promise<boolean> {
  return cdp.evaluate<boolean>(`(function(){
    const inFooter = [...document.querySelectorAll('[class*="cascadeFooter"] *, [class*="cascadeMenu"] *')];
    const pool = inFooter.length ? inFooter : [...document.querySelectorAll('button,[role="button"],div,span,a')];
    const btn = pool.find(e => {
      const t = (e.textContent || '').trim();
      const r = e.getBoundingClientRect();
      return t === '选择文件夹' && r.width > 0 && r.height > 0;
    });
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
}

/**
 * 点击 footer 后等待原生对话框出现。
 *
 * 成本模型（issue #38 实测修正）：这是 **Node 侧循环**，每次迭代调用
 * `findFolderDialog()` 都**新起一个 PowerShell 进程**（本机实测 1.0–4.8s，中位约 1.5s）。
 * 因此每轮探测实际成本 ≈ 探测耗时 + `sleep(1500)` ≈ **2.5–6.3s**，20s 预算只够约
 * 3–8 次探测。调用方必须按此折算窗口（见 `FOOTER_FIRST_ATTEMPT_SHARE`），
 * 不可假设「预算内可以频繁轮询」。
 */
async function waitDialogAppeared(
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<FolderDialogInfo | null> {
  const deadline = Date.now() + timeoutMs;
  // 至少允许一次探测：窗口比单次探测成本还短时（测试注入短预算、或首级按比例切分后的
  // 小窗口），不能因为「剩余 < MIN_PROBE_COST_MS」而一次都不探——那会让该级点击虽已发生
  // 却被判失败，白白降级到更不可靠的下一级（回归：A-core 的坐标点击首级被跳过）。
  let probed = false;
  for (;;) {
    if (probed && deadline - Date.now() < MIN_PROBE_COST_MS) return null;
    // eslint-disable-next-line no-await-in-loop
    const d = await findFolderDialog();
    probed = true;
    if (d.found && d.hwnd > 0) return { hwnd: d.hwnd, windowTitle: d.windowTitle, processName: d.processName };
    const remain = deadline - Date.now();
    if (remain <= 0) return null;
    // sleep 不越过窗口边界：旧实现的固定 `sleep(1500)` 会在窗口末尾再吃满 1.5s。
    // eslint-disable-next-line no-await-in-loop
    await sleep(Math.min(1_500, remain));
  }
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
  opts: SessionUiOptions & { mode?: TraeworkMode; dialogWaitTimeoutMs?: number },
): Promise<BindProjectResult> {
  const wantMode = opts.mode ?? "Work";

  // Work/Code/Design 各自维护独立的项目绑定（run.ts 的模式切换约束）。
  // Work 绑定不会建立目标模式的绑定，跨模式重试还会改变当前模式与 Work 侧项目。
  // 因此仅在目标模式内尝试，失败直接返回，不以 Work 绑定作为补救（issue #35）。
  return bindProjectOnce(cdp, projectPath, { ...opts, mode: wantMode });
}

/** 单次绑定尝试（在指定模式下） */
async function bindProjectOnce(
  cdp: TraeworkCdpClient,
  projectPath: string,
  opts: SessionUiOptions & { mode: TraeworkMode; dialogWaitTimeoutMs?: number },
): Promise<BindProjectResult> {
  const { selectors, logger } = opts;
  const sleep = opts.sleep ?? defaultSleep;

  const modeOk = await ensureMode(cdp, opts.mode, { selectors, logger, sleep: opts.sleep });
  if (!modeOk) {
    logger.warn(`[traework] 未能确认处于 ${opts.mode} 模式，仍尝试绑定项目（fail-open）`);
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
  // 仅在真正要弹原生对话框时才清理遗留窗口（避免下拉命中路径上多一次 PowerShell 启动开销）
  await closeStaleFolderDialogs(logger).catch(() => 0);
  const footer = await clickDropdownFooter(cdp, opts);
  if (!footer.clicked) {
    return {
      bound: false,
      method: "failed",
      message: "下拉未命中且底部「选择文件夹」未成功唤起原生对话框（三级点击阶梯均未生效）",
    };
  }
  // 把刚弹出的对话框 hwnd 传下去，保证写入的是同一个窗口（避免写到遗留对话框）
  const picked = await pickFolderViaNativeDialog(projectPath, { logger, hwnd: footer.hwnd });
  if (!picked.ok) {
    return { bound: false, method: "native-dialog", message: picked.message };
  }
  await sleep(1500);
  return { bound: true, method: "native-dialog", message: picked.message };
}
