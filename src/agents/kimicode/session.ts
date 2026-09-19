/**
 * 草稿页建立与会话定位。
 *
 * 真机事实（2026-09-20，Kimi Code 1.0.2）：
 * 1) 草稿页的权威判据是 composer 上方挂载了 `button.ws-chip`（工作区触发器）；
 *    发送消息后 ws-chip 从 composer 消失，因此「点击新建会话返回 true」绝不等于已切到草稿页
 *    （ZCode M22 教训：点击顶层入口返回 true 却不切页，必须用后置条件确认）；
 * 2) 新建会话**会继承上次工作区**（不会自动清空），所以进入草稿后仍需显式核对/绑定工作区；
 * 3) 会话 id 有两条独立来源：主窗口 URL（`app://renderer/sessions/<id>`）与侧栏
 *    `div.se[data-session-id]`。定位原会话必须唯一定位，**绝不打开「最近会话」**。
 */
import type { KimicodeSessionItem } from "./cdp.js";
import { normalizeWorkspaceName } from "./workspace.js";

export interface KimicodeDraftCdp {
  newSession(): Promise<boolean>;
  newSessionInWorkspace(): Promise<boolean>;
  exists(key: string): Promise<boolean>;
}

export interface KimicodeDraftDeps {
  sleep?: (ms: number) => Promise<void>;
  /** 轮询间隔（ms）；默认 100 */
  pollIntervalMs?: number;
  /** 点击被吞后的重试间隔（ms）；默认 1500 */
  reclickMs?: number;
}

/**
 * 建立新的草稿会话，并以「ws-chip 已挂载」确认它真的建立了。
 *
 * 流程：点「新建会话」→ 等触发器挂载；未挂载则**周期性重试**（全局入口与「在此工作区新建会话」
 * 交替），直到截止时间；始终未挂载即 fail-closed 返回 false（调用方不得发送任务）。
 *
 * 为什么必须重试而不是点两次：真机实测（2026-09-20）单次合成点击会被 Chromium 节流吞掉，
 * 表现为「点了新建会话却毫无反应」。置前（focusMainWindow）能显著降低概率，但不能消除，
 * 所以以「触发器已挂载」为准做有界重试——这与 openWorkspacePanel 的 TRIGGER_RECLICK 同一思路。
 */
export async function ensureFreshDraft(
  cdp: KimicodeDraftCdp,
  deadlineMs: number,
  deps: KimicodeDraftDeps = {},
): Promise<boolean> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const interval = deps.pollIntervalMs ?? 100;
  const reclick = deps.reclickMs ?? 1_500;
  let lastClick = 0;
  let useWorkspaceEntry = false;
  while (Date.now() < deadlineMs) {
    if (Date.now() - lastClick >= reclick) {
      // 首次必然点击（lastClick=0）：初始任务一律新建对话，**不复用**可能残留的旧草稿。
      // 之后交替使用两个入口：全局入口可靠，分组入口在「已停在某会话」时更精确。
      // eslint-disable-next-line no-await-in-loop
      await (useWorkspaceEntry ? cdp.newSessionInWorkspace() : cdp.newSession());
      useWorkspaceEntry = !useWorkspaceEntry;
      lastClick = Date.now();
    }
    // eslint-disable-next-line no-await-in-loop
    if (await cdp.exists("workspaceChip")) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(interval);
  }
  return cdp.exists("workspaceChip");
}

export interface KimicodeSessionCdp {
  currentSessionId(): Promise<{ id?: string; source: "url" | "dom" | "none"; ambiguous?: boolean }>;
  sessions(): Promise<KimicodeSessionItem[]>;
  selectSession(id?: string, title?: string): Promise<boolean>;
}

export interface KimicodeSessionLocation {
  found: boolean;
  id?: string;
  title?: string;
  /** 命中来源：url=当前会话就是它；dom=由侧栏条目唯一定位后切过去 */
  source?: "url" | "dom";
  reason?: "missing-anchor" | "not-found" | "ambiguous" | "select-failed";
}

/**
 * 唯一定位原会话（URL 优先、DOM 辅助）。
 * id 与标题都缺失、命中 0 条或多条、切页后回读不一致 → 一律 found:false，
 * 不做「取侧栏第一项」之类的猜测。
 */
export async function locateSession(
  cdp: KimicodeSessionCdp,
  id?: string,
  title?: string,
): Promise<KimicodeSessionLocation> {
  if (!id && !title) return { found: false, reason: "missing-anchor" };
  const current = await cdp.currentSessionId();
  if (id && current.id === id) return { found: true, id, source: "url" };
  const items = await cdp.sessions();
  const wantedTitle = title ? normalizeWorkspaceName(title) : "";
  const matches = id
    ? items.filter((item) => item.id === id)
    : items.filter((item) => item.title && normalizeWorkspaceName(item.title) === wantedTitle);
  if (matches.length > 1) return { found: false, reason: "ambiguous" };
  const match = matches[0];
  if (!match) return { found: false, reason: "not-found" };
  if (!(await cdp.selectSession(match.id, match.title))) return { found: false, reason: "select-failed" };
  // 切页后回读：URL 会变成 app://renderer/sessions/<id>，不一致说明点错了条目。
  const after = await cdp.currentSessionId();
  if (after.id !== match.id) return { found: false, reason: "select-failed" };
  return { found: true, id: match.id, title: match.title, source: "dom" };
}