/**
 * Open Design 的「工作目录」绑定（计划 P2 / 图 1、图 2）。
 *
 * 时序（与截图一一对应，改动前先看 docs/opendesign-cdp.md §5）：
 *   1. 回读当前工作目录显示值 —— **已是目标目录就直接跳过**（不做无意义点击）；
 *   2. 展开「工作目录」触发器；
 *   3. 点「选择目录」菜单项 → 弹出 Windows 原生「选择文件夹」对话框；
 *   4. 走 `dialog.ts` 填绝对路径 → 回读校验 → 确认 → 等对话框关闭；
 *   5. **回读工作目录显示值**，确认绑定真的生效（原生对话框关闭 ≠ 应用已接受该目录）。
 *
 * 门禁纪律：
 * - 步骤 2/3 用**坐标点击**（可信点击），但坐标来自 DOM 实测；坐标缺失即 fail-closed；
 * - 原生对话框的**基线**必须在点「选择目录」之前采样，否则会把用户自己的对话框当成本次弹出的；
 * - 任一步失败都返回结构化 `reason`，由上层决定转 `needs_user` 还是硬失败——
 *   绝不在「回读不一致」的情况下继续往下走（那会把后续失败归因到完全无关的地方）。
 */
import type { GuiProfile } from "../../config/schema.js";
import type { AgentRunLogger } from "../adapter.js";
import type { SelectorOverrides } from "./dom.js";
import {
  exactMatchPointExpression,
  existsExpression,
  selectorSpecFor,
  singlePointExpression,
  triggerTextExpression,
} from "./dom.js";
import {
  selectOpenDesignFolder,
  listOwnedDialogs,
  type FolderDialogDeps,
  type FolderDialogOutcome,
} from "./dialog.js";

/** 页面客户端最小接口（真实实现为 `cdp.ts` 的客户端；单测注入内存桩） */
export interface OpenDesignPage {
  evaluate<T = unknown>(expression: string): Promise<T>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  clickAt(point: { x: number; y: number }, options?: { expect?: string }): Promise<boolean>;
}

/** 路径比较归一：Windows 大小写不敏感 + 反斜杠 + 去尾斜杠 */
export function normalizeWorkspacePath(value: string | undefined): string {
  let out = (value ?? "").trim().replace(/\//g, "\\").replace(/\\+$/, "");
  if (/^[a-zA-Z]:\.?$/.test(out)) out = `${out.slice(0, 2)}\\`;
  // 路径可能被界面截断成 `D:\Trae项目\tian…`，比较前统一去掉省略号尾巴
  out = out.replace(/(…|\.\.\.)$/, "");
  return process.platform === "win32" ? out.toLowerCase() : out;
}

/** 目标路径是否已出现在当前显示值里（含被截断的情形） */
export function workspaceMatches(actual: string | undefined, wanted: string): boolean {
  const a = normalizeWorkspacePath(actual);
  const w = normalizeWorkspacePath(wanted);
  if (!a || !w) return false;
  if (a === w) return true;
  // 界面常见截断：以省略号结尾，只保留了前缀
  const shownEllipsis = /(…|\.\.\.)\s*$/.test((actual ?? "").trim());
  return shownEllipsis && w.startsWith(a);
}

export type WorkspaceBindReason =
  "already-bound" | "no-panel" | "no-item" | "click" | "native" | "readback" | "timeout";

export interface WorkspaceBindOutcome {
  ok: boolean;
  /** 绑定后回读到的工作目录显示值 */
  shown?: string;
  reason?: WorkspaceBindReason;
  message?: string;
  /** 原生对话框返回的细节（诊断用） */
  native?: FolderDialogOutcome;
}

export interface BindWorkspaceInput {
  page: OpenDesignPage;
  /** 目标绝对路径（项目根） */
  targetPath: string;
  /** 受管实例 pid（原生对话框归属核对用） */
  ownerPids: number[];
  gui: GuiProfile;
  logger: AgentRunLogger;
  overrides?: SelectorOverrides;
  signal?: AbortSignal;
  deps?: WorkspaceBindDeps;
}

export interface WorkspaceBindDeps extends FolderDialogDeps {
  listDialogs: (pids: number[], options: { signal?: AbortSignal }) => Promise<string[]>;
  selectFolder: (
    targetPath: string,
    pids: number[],
    baseline: string[],
    options: { signal?: AbortSignal; onProgress?: (stage: string) => void },
  ) => Promise<FolderDialogOutcome>;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_DEPS: WorkspaceBindDeps = {
  listDialogs: (pids, options) => listOwnedDialogs(pids, options),
  selectFolder: (targetPath, pids, baseline, options) =>
    selectOpenDesignFolder(targetPath, pids, baseline, options),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** 在预算内轮询直到谓词为真（返回是否命中） */
async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    // eslint-disable-next-line no-await-in-loop
    await sleep(200);
  }
}

/** 读回工作目录显示值（触发器文本；空串表示触发器缺失或还没渲染） */
export async function readWorkspaceValue(
  page: OpenDesignPage,
  overrides: SelectorOverrides = {},
): Promise<string> {
  return page.evaluate<string>(triggerTextExpression("workingDirValue", overrides));
}

/**
 * 绑定工作目录。返回结构化结果：
 * - `already-bound`：当前显示值已是目标目录（未做任何点击）；
 * - 其余 reason 表示失败，调用方据此决定 `needs_user` / 硬失败。
 */
export async function bindWorkspace(input: BindWorkspaceInput): Promise<WorkspaceBindOutcome> {
  const { page, targetPath, ownerPids, gui, logger } = input;
  const overrides = input.overrides ?? gui.selectors ?? {};
  const deps: WorkspaceBindDeps = { ...DEFAULT_DEPS, ...input.deps };
  const panelBudget = gui.projectTriggerTimeoutMs;

  // 1) 已是目标目录 → 跳过（不做无意义点击，也不改动用户既有绑定）
  const before = await readWorkspaceValue(page, overrides);
  if (workspaceMatches(before, targetPath)) {
    logger.info(`[opendesign] 工作目录已是目标值，跳过绑定：${before}`);
    return { ok: true, shown: before, reason: "already-bound" };
  }
  logger.info(`[opendesign] 工作目录当前为「${before || "(空)"}」，准备绑定到 ${targetPath}`);

  // 2) 展开「工作目录」触发器（坐标点击：可信点击；坐标来自 DOM 实测）
  const triggerPoint = await page.evaluate<{ count: number; point?: { x: number; y: number } }>(
    singlePointExpression(selectorSpecFor("workingDirTrigger", overrides)),
  );
  if (triggerPoint.count !== 1 || !triggerPoint.point) {
    return {
      ok: false,
      reason: "no-panel",
      message: `「工作目录」触发器无法唯一定位（匹配 ${triggerPoint.count}）——选择器可能已漂移`,
    };
  }
  const opened = await page.clickAt(triggerPoint.point, { expect: "working-dir-panel" });
  if (!opened) {
    return {
      ok: false,
      reason: "click",
      message: "点击「工作目录」后未观察到面板变化（合成点击可能被吞）",
    };
  }

  // 3) 等「选择目录」项出现（文本谓词兜底：菜单项文案是稳定的中文）
  const itemReady = await waitUntil(
    () => page.evaluate<boolean>(existsExpression(selectorSpecFor("selectDirItem", overrides))),
    panelBudget,
    deps.sleep,
    input.signal,
  );
  if (!itemReady) {
    return {
      ok: false,
      reason: "no-item",
      message: `展开后未出现「选择目录」项（预算 ${panelBudget}ms）`,
    };
  }

  // 4) **基线必须在点击之前采样**：只有不在基线里的窗口才可能是本次弹出的
  const baseline = await deps.listDialogs(ownerPids, { signal: input.signal });

  const itemPoint = await page.evaluate<{
    count: number;
    available?: string[];
    point?: { x: number; y: number };
  }>(exactMatchPointExpression("selectDirItem", "选择目录", overrides));
  if (itemPoint.count !== 1 || !itemPoint.point) {
    return {
      ok: false,
      reason: "no-item",
      message:
        `「选择目录」项无法唯一点击（匹配 ${itemPoint.count}）` +
        `${itemPoint.available?.length ? `；当前可见候选：${itemPoint.available.slice(0, 10).join("、")}` : ""}`,
    };
  }
  const clicked = await page.clickAt(itemPoint.point, { expect: "native-folder-dialog" });
  if (!clicked) {
    return {
      ok: false,
      reason: "click",
      message: "点击「选择目录」未生效（原生对话框可能未弹出）",
    };
  }

  // 5) 原生对话框：填路径 → 回读 → 确认 → 等关闭
  const native = await deps.selectFolder(targetPath, ownerPids, baseline, {
    signal: input.signal,
    onProgress: (stage) => logger.debug(`[opendesign] native:${stage}`),
  });
  if (!native.ok) {
    return {
      ok: false,
      reason: "native",
      message: native.message,
      native,
    };
  }

  // 6) 回读工作目录显示值：**对话框关闭 ≠ 应用已接受**
  const shown = await readWorkspaceValue(page, overrides);
  if (!workspaceMatches(shown, targetPath)) {
    return {
      ok: false,
      reason: "readback",
      shown,
      native,
      message: `原生对话框已确认，但工作目录回读为「${shown}」，与目标不一致（未把绑定当成成功）`,
    };
  }
  logger.info(`[opendesign] 工作目录绑定成功：${shown}`);
  return { ok: true, shown, native };
}
