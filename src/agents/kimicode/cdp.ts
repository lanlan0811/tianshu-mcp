/**
 * Kimi Code CDP 客户端。
 *
 * 真机事实（2026-09-20，Kimi Code 1.0.2 / Chromium 150 / Electron 43.1.1）：
 * Kimi Code 是**双渲染进程**应用，一个端口上同时存在三个 page target：
 *   - 主窗口：title `Kimi Code`，url `app://renderer/`（草稿页）或 `app://renderer/sessions/<id>`
 *     → 侧栏、会话列表、composer、输入框、发送/停止按钮都在这里；
 *   - 浮层窗口：`Kimi Browser Overlay` / `app://renderer/browser-overlay.html`
 *     → 模型菜单、思考档位、执行模式菜单渲染在这里；
 *   - 截图窗口：`app://renderer/screenshot/index.html` → 必须排除。
 *
 * 因此本类内部持有**两个** TraeworkCdpClient：主窗口按 targetRank 收敛（排除 overlay/screenshot），
 * 浮层只在需要时惰性连接（rank 只认 browser-overlay）。主窗口 URL 在草稿页 ↔ 会话页之间变化
 * **不会**改变 target id，WS 连接可长期保持。
 */
import {
  TraeworkCdpClient,
  CdpDisconnectedError,
  CdpUnavailableError,
} from "../traework/cdp/client.js";
import { KIMICODE_OVERLAY_SELECTORS, KIMICODE_SELECTORS, mainSpec, overlaySpec } from "./selectors.js";
import {
  conversationTextExpression,
  currentSessionExpression,
  domClickExpression,
  exactMatchExpression,
  existsExpression,
  focusInputExpression,
  focusModelDialogSearchExpression,
  inputTextExpression,
  menuOpenCountExpression,
  modelDialogItemsExpression,
  modelDialogOpenExpression,
  modelDialogRowPointExpression,
  modelDialogSearchTextExpression,
  overlayItemsExpression,
  overlayVisibleExpression,
  pageHiddenExpression,
  pollExpression,
  selectSessionExpression,
  sendButtonPointExpression,
  sessionsExpression,
  singlePointExpression,
  textExpression,
  workspaceChipTextExpression,
  workspaceItemsExpression,
  workspacePanelOpenExpression,
  workspaceRowPointExpression,
  type SelectorOverrides,
} from "./dom.js";
import type { KimicodePoll } from "./liveness.js";
import { normalizeWorkspacePath, type KimicodeWorkspaceItem } from "./workspace.js";

export { CdpDisconnectedError, CdpUnavailableError };

export interface KimicodeSessionItem {
  id: string;
  title?: string;
}

export interface KimicodeClickExactResult {
  clicked: boolean;
  count: number;
  available: string[];
}

export interface KimicodePoint {
  x: number;
  y: number;
}

/** 浮层菜单项（模型候选 / 思考档位 / 执行模式候选共用）：可见标签 + 是否当前项 */
export interface KimicodeOverlayItem {
  label: string;
  current: boolean;
}

/** 浮层里可精确点击的菜单键 */
export type KimicodeOverlayMenuKey =
  | "modelOption"
  | "thinkingSegment"
  | "permissionOption"
  | "moreModelsItem";

/** 「切换模型」对话框的候选行（`current` 只认 `.is-current`） */
export interface KimicodeModelDialogItem {
  name: string;
  current: boolean;
}

/** CDP page target 的最小可判定字段（TraeworkCdpClient 的 CdpPageTarget 结构兼容） */
export interface KimicodeTargetLike {
  type?: string;
  title?: string;
  url?: string;
}

/** overlay 选择器键在对外 API 里的前缀（`overlay.permissionOption`） */
const OVERLAY_PREFIX = "overlay.";

/**
 * 主窗口 target 排序偏好：优先 title 恰好为 `Kimi Code`，其次任何 `app://renderer/` 页面；
 * overlay 与截图窗口排到最后（正常情况下不会被选中）。
 */
export function kimicodeMainTargetRank(target: KimicodeTargetLike): number {
  const url = target.url ?? "";
  const title = (target.title ?? "").trim();
  if (/browser-overlay|screenshot/i.test(url)) return 100;
  if (title === "Kimi Code") return 0;
  if (url.startsWith("app://renderer/")) return 1;
  return 2;
}

/** 浮层 target 排序偏好：只认为 browser-overlay 页面是浮层，其余一律靠后 */
export function kimicodeOverlayTargetRank(target: KimicodeTargetLike): number {
  return /browser-overlay/i.test(target.url ?? "") ? 0 : 100;
}

export type KimicodePageRole = "main" | "overlay";

/** 页面级 CDP 客户端（真实实现为 TraeworkCdpClient；单测注入内存桩） */
export interface KimicodePageClient {
  connect(): Promise<void>;
  disconnect(): void;
  evaluate<T = unknown>(expression: string): Promise<T>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  readonly connected?: boolean;
  readonly alive?: boolean;
}

export interface KimicodeCdpDeps {
  /** 按角色创建页面客户端；缺省创建 TraeworkCdpClient（带各自的 targetRank） */
  createClient?: (role: KimicodePageRole) => KimicodePageClient;
}

/** 与 zcode/retryZcodeEvaluation 同义：只重试一次 Runtime.evaluate 的瞬态不可用 */
export async function retryKimicodeEvaluation<T>(
  operation: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        attempt >= 1 ||
        !(error instanceof CdpUnavailableError) ||
        error instanceof CdpDisconnectedError
      )
        throw error;
      await sleep(500);
    }
  }
}

/** 点击后确认工作区面板打开的轮询间隔（不是独立超时） */
const PANEL_POLL_MS = 100;
/**
 * 置前后等待前台真正生效的上限。实测 `Page.bringToFront` 异步生效（数百毫秒），
 * 期间派发的合成事件仍会被节流吞掉。
 */
const FOCUS_SETTLE_MS = 1_500;
/**
 * 触发器点击被吞后的重试间隔。窗口被其他窗口完全遮挡时 Chromium 会节流页面，
 * 合成鼠标事件常被吞掉（第一次点击无效、第二次才生效），所以「点一次然后干等」必然失败。
 */
const TRIGGER_RECLICK_MS = 1_500;
/** 对话框搜索过滤的观察间隔（过滤是异步的，读一次会读到旧列表） */
const FILTER_POLL_MS = 150;

/** 键盘事件参数（沿用 pressEscape 的字段组合，保证 Electron 真的收得到） */
interface KeyStroke {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers?: number;
}
const ESCAPE_KEY: KeyStroke = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 };
const SELECT_ALL_KEY: KeyStroke = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 };
const BACKSPACE_KEY: KeyStroke = { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 };

export class KimicodeCdpClient {
  readonly port: number;
  private readonly pages: Record<KimicodePageRole, KimicodePageClient>;
  private overlayReady = false;

  constructor(
    port: number,
    sendTimeoutMs: number,
    private readonly selectors: SelectorOverrides = {},
    deps: KimicodeCdpDeps = {},
  ) {
    this.port = port;
    const create =
      deps.createClient ??
      ((role: KimicodePageRole) =>
        new TraeworkCdpClient({
          port,
          sendTimeoutMs,
          targetRank: role === "overlay" ? kimicodeOverlayTargetRank : kimicodeMainTargetRank,
        }) as KimicodePageClient);
    this.pages = { main: create("main"), overlay: create("overlay") };
  }

  /** 连接主窗口（浮层按需惰性连接，见 ensureOverlay） */
  async connect(): Promise<void> {
    await this.pages.main.connect();
    // 启动后窗口常在后台：Chromium 会节流被遮挡/不可见的页面，合成鼠标事件被吞，
    // 于是「点触发器无反应」被误报成选择器失效。真机实测 Kimi Code（Electron 43）
    // 的 Page.bringToFront 有效（与 ZCode 不同），所以连接后立刻置前并开启焦点模拟。
    await this.focusMainWindow();
  }

  /**
   * 把主窗口置于前台并开启焦点模拟，然后**等前台真正生效**再返回。
   *
   * 真机教训（2026-09-20）：只调一次 `Page.bringToFront` 就立刻派发点击，合成事件仍会被
   * Chromium 节流吞掉——置前是异步生效的（实测需数百毫秒），表现为「点新建会话毫无反应」。
   * 所以这里以 `visibilityState` 收敛为准，而不是盲等一个固定时长。
   * 失败不抛错：置前只是让点击更容易生效，正确性判据始终是点击后的回读。
   */
  async focusMainWindow(): Promise<void> {
    try {
      await this.pages.main.send("Page.enable");
    } catch {
      /* Page 域不可用不影响后续命令 */
    }
    try {
      await this.pages.main.send("Page.bringToFront");
    } catch {
      /* 置前失败：交由调用方的回读判定 */
    }
    try {
      await this.pages.main.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    } catch {
      /* 焦点模拟失败：同上 */
    }
    const until = Date.now() + FOCUS_SETTLE_MS;
    for (;;) {
      try {
        // eslint-disable-next-line no-await-in-loop
        if (!(await this.pageHidden())) return;
      } catch {
        return;
      }
      if (Date.now() >= until) return;
      // eslint-disable-next-line no-await-in-loop
      await this.pause(100);
    }
  }

  disconnect(): void {
    try {
      this.pages.main.disconnect();
    } finally {
      this.overlayReady = false;
      this.pages.overlay.disconnect();
    }
  }

  evaluate<T>(expression: string): Promise<T> {
    return retryKimicodeEvaluation(() => this.pages.main.evaluate<T>(expression));
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.pages.main.send(method, params);
  }

  /** 是否已连上浮层窗口 */
  overlayConnected(): boolean {
    if (!this.overlayReady) return false;
    const page = this.pages.overlay;
    return (page.connected ?? page.alive ?? true) === true;
  }

  /**
   * 浮层窗口是否可见 —— 菜单开/关的唯一权威判据。
   * 菜单关闭时 overlay 的 visibilityState 为 hidden；关闭后 DOM 可能短暂残留，
   * 所以不能只看 DOM 是否存在。
   */
  async overlayVisible(): Promise<boolean> {
    if (!(await this.ensureOverlay())) return false;
    try {
      return (await this.pages.overlay.evaluate<boolean>(overlayVisibleExpression())) === true;
    } catch {
      return false;
    }
  }

  /** 主窗口是否被隐藏（被遮挡/最小化 → 页面节流 → 合成点击不可靠） */
  pageHidden(): Promise<boolean> {
    return this.evaluate<boolean>(pageHiddenExpression());
  }

  /** 收起主窗口菜单与浮层菜单（toggle 语义：只在确认打开时才按 Escape） */
  async dismissMenus(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      // eslint-disable-next-line no-await-in-loop
      const open = await this.evaluate<number>(menuOpenCountExpression());
      // eslint-disable-next-line no-await-in-loop
      const overlay = await this.overlayVisible();
      if (!open && !overlay) return;
      if (open) {
        // eslint-disable-next-line no-await-in-loop
        await this.pressEscape("main");
      }
      if (overlay) {
        // eslint-disable-next-line no-await-in-loop
        await this.pressEscape("overlay");
      }
      // eslint-disable-next-line no-await-in-loop
      await this.pause(50);
    }
  }

  /* ---------------- 语义键操作（主窗口键，或 `overlay.` 前缀的浮层键） ---------------- */

  async exists(key: string): Promise<boolean> {
    const target = this.resolveKey(key);
    if (target.role === "overlay" && !(await this.ensureOverlay())) return false;
    return (await this.evaluateOn<boolean>(target.role, existsExpression(target.spec))) === true;
  }

  async text(key: string): Promise<string> {
    const target = this.resolveKey(key);
    if (target.role === "overlay" && !(await this.ensureOverlay())) return "";
    return (await this.evaluateOn<string>(target.role, textExpression(target.spec))) || "";
  }

  /**
   * 点击语义键。**先 trusted 坐标点击**（Input.dispatchMouseEvent moved+pressed+released），
   * 拿不到唯一可见目标时才回退 DOM `element.click()`：真机实测 `button.ws-chip` 只认 trusted
   * 点击，而 `button.model-pill` 两者皆可，所以 trusted 必须是首选路径。
   */
  async click(key: string): Promise<boolean> {
    const target = this.resolveKey(key);
    if (target.role === "overlay" && !(await this.ensureOverlay())) return false;
    const found = await this.evaluateOn<{ count: number; point?: KimicodePoint }>(
      target.role,
      singlePointExpression(target.spec),
    );
    if (found?.point) {
      await this.clickAt(target.role, found.point.x, found.point.y);
      return true;
    }
    return (
      (await this.evaluateOn<boolean>(target.role, domClickExpression(target.spec))) === true
    );
  }

  /** 按可见文本/aria 精确点击；多命中/未命中都不点击，并回报可见候选用于诊断 */
  async clickExact(key: string, value: string): Promise<KimicodeClickExactResult> {
    const target = this.resolveKey(key);
    if (target.role === "overlay" && !(await this.ensureOverlay()))
      return { clicked: false, count: 0, available: [] };
    const found = await this.evaluateOn<{
      count: number;
      available: string[];
      point?: KimicodePoint;
    }>(target.role, exactMatchExpression(target.spec, value));
    if (!found?.point)
      return { clicked: false, count: found?.count ?? 0, available: found?.available ?? [] };
    await this.clickAt(target.role, found.point.x, found.point.y);
    return { clicked: true, count: found.count, available: found.available };
  }

  /* ---------------- 会话与草稿 ---------------- */

  /** 点「新建会话」（button.btn-new-chat）。返回是否发出点击，**不代表已切到草稿页**。 */
  newSession(): Promise<boolean> {
    return this.click("newSession");
  }

  /** 在指定工作区分组下新建会话（回退入口，比全局新建会话更精确） */
  newSessionInWorkspace(): Promise<boolean> {
    return this.click("workspaceAddSession");
  }

  /** 触发器上的工作区名；发送消息后 ws-chip 消失 → 空串表示已不在草稿页 */
  workspaceChipText(): Promise<string> {
    return this.evaluate<string>(workspaceChipTextExpression(this.selectors));
  }

  /** 工作区下拉面板是否可见 */
  workspacePanelOpen(): Promise<boolean> {
    return this.evaluate<boolean>(workspacePanelOpenExpression(this.selectors));
  }

  /**
   * 打开工作区下拉面板并确认其真正可见。
   * 面板可能已经开着（上一次尝试的残留）——toggle 语义下再点触发器会把它关掉，
   * 所以每轮都先查后点；点击被节流吞掉时有界重试，不重置调用方给的截止时间。
   */
  async openWorkspacePanel(deadlineMs = 5_000): Promise<boolean> {
    if (await this.workspacePanelOpen()) return true;
    const deadline = Date.now() + deadlineMs;
    let lastClick = 0;
    while (Date.now() < deadline) {
      if (Date.now() - lastClick >= TRIGGER_RECLICK_MS) {
        // eslint-disable-next-line no-await-in-loop
        await this.click("workspaceChip");
        lastClick = Date.now();
      }
      // eslint-disable-next-line no-await-in-loop
      if (await this.workspacePanelOpen()) return true;
      // eslint-disable-next-line no-await-in-loop
      await this.pause(PANEL_POLL_MS);
    }
    return false;
  }

  /** 面板内的「最近的文件夹」条目（含完整路径与当前选中标记） */
  workspaceItems(): Promise<(KimicodeWorkspaceItem & { active: boolean })[]> {
    return this.evaluate(workspaceItemsExpression(this.selectors));
  }

  /**
   * 按完整路径点击工作区条目（要求面板已打开且路径唯一命中）。
   * 路径归属在 Node 侧用 normalizeWorkspacePath 判定，页面内只按 DOM 顺序取坐标，
   * 避免两处各写一套归一逻辑产生分歧。
   */
  async clickWorkspaceByPath(target: string): Promise<{ clicked: boolean; count: number }> {
    const items = await this.workspaceItems();
    const wanted = normalizeWorkspacePath(target);
    const matched = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.path && normalizeWorkspacePath(item.path) === wanted);
    if (matched.length !== 1) return { clicked: false, count: matched.length };
    const point = await this.evaluate<KimicodePoint | null>(
      workspaceRowPointExpression(this.selectors, matched[0]!.index),
    );
    if (!point) return { clicked: false, count: 1 };
    await this.clickAt("main", point.x, point.y);
    return { clicked: true, count: 1 };
  }

  /** 点「选择文件夹…」→ 触发原生「添加工作区」对话框 */
  clickChooseFolder(): Promise<boolean> {
    return this.click("chooseFolder");
  }

  /* ---------------- 会话定位 ---------------- */

  sessions(): Promise<KimicodeSessionItem[]> {
    return this.evaluate(sessionsExpression(this.selectors));
  }

  /** 当前会话 id：URL 优先，其次侧栏选中项；两者都不可信时 source='none' */
  currentSessionId(): Promise<{ id?: string; source: "url" | "dom" | "none"; ambiguous?: boolean }> {
    return this.evaluate(currentSessionExpression(this.selectors));
  }

  /** 唯一定位并切到目标会话；不在场、不唯一或不可见一律返回 false */
  async selectSession(id?: string, title?: string): Promise<boolean> {
    if (id) {
      const current = await this.currentSessionId();
      if (current.id === id) return true;
    }
    const found = await this.evaluate<{ count: number; point?: KimicodePoint }>(
      selectSessionExpression(this.selectors, id, title),
    );
    if (!found?.point) return false;
    await this.clickAt("main", found.point.x, found.point.y);
    return true;
  }

  /* ---------------- 模型 / 思考档位 / 执行模式（浮层菜单） ---------------- */

  /** 模型+档位触发器全文（实测形如 `K3 · High`；非官方模型为 `stepfun/… · 思考`） */
  modelTriggerText(): Promise<string> {
    return this.text("modelPill");
  }

  /** 执行模式触发器文本（实测「完全自动」，class 含 perm-auto） */
  permissionText(): Promise<string> {
    return this.text("permissionPill");
  }

  /** 打开模型/档位菜单（浮层） */
  openModelMenu(deadlineMs = 5_000): Promise<boolean> {
    return this.openOverlayMenu("modelPill", deadlineMs);
  }

  /** 打开执行模式菜单（浮层） */
  openPermissionMenu(deadlineMs = 5_000): Promise<boolean> {
    return this.openOverlayMenu("permissionPill", deadlineMs);
  }

  /** 浮层里的模型候选（当前项 `.is-active`） */
  overlayModels(): Promise<KimicodeOverlayItem[]> {
    return this.overlayItems(overlaySpec("modelOption", this.selectors));
  }

  /** 浮层里的思考档位标签（当前档 `.is-on`）：档位集合的唯一来源就是它 */
  reasoningTiers(): Promise<KimicodeOverlayItem[]> {
    return this.overlayItems(overlaySpec("thinkingSegment", this.selectors));
  }

  /** 浮层里的执行模式候选（当前项 `.is-active`） */
  overlayPermissions(): Promise<KimicodeOverlayItem[]> {
    return this.overlayItems(overlaySpec("permissionOption", this.selectors));
  }

  /** 按可见文本精确点击浮层菜单项；多命中/未命中一律不点击，并回报可见候选 */
  clickOverlayExact(key: KimicodeOverlayMenuKey, value: string): Promise<KimicodeClickExactResult> {
    return this.clickExact(`${OVERLAY_PREFIX}${key}`, value);
  }

  /* ---------------- 「切换模型」对话框（「更多模型…」的二级入口） ---------------- */

  /**
   * 点开 overlay 模型菜单里的「更多模型…」。
   * 真机实测：点击后 overlay 立刻变 hidden 并清空，主窗口弹出「切换模型」对话框——
   * 因此这里**不**校验 overlay 后续状态，只确认那次点击真的命中并发出。
   */
  async openModelPicker(deadlineMs = 5_000): Promise<boolean> {
    const until = Date.now() + deadlineMs;
    const texts = KIMICODE_OVERLAY_SELECTORS.moreModelsItem.texts ?? ["更多模型…"];
    for (let attempt = 0; attempt < 50 && Date.now() < until; attempt++) {
      // 菜单没开就先开（可能被上一次失败的直选留在关闭态）；再点会把刚开的面板关掉，故先查后点。
      // eslint-disable-next-line no-await-in-loop
      if (!(await this.overlayVisible()) && !(await this.openModelMenu(Math.max(1, until - Date.now()))))
        return false;
      for (const text of texts) {
        // eslint-disable-next-line no-await-in-loop
        const clicked = await this.clickOverlayExact("moreModelsItem", text);
        if (clicked.clicked) return true;
      }
      // eslint-disable-next-line no-await-in-loop
      await this.pause(PANEL_POLL_MS);
    }
    return false;
  }

  /** 「切换模型」对话框是否可见且已渲染出候选行 */
  modelDialogOpen(): Promise<boolean> {
    return this.evaluate<boolean>(modelDialogOpenExpression(this.selectors)).then(
      (open) => open === true,
    );
  }

  /** 对话框候选行（模型名 + 是否当前模型） */
  modelDialogItems(): Promise<KimicodeModelDialogItem[]> {
    return this.evaluate<KimicodeModelDialogItem[]>(modelDialogItemsExpression(this.selectors));
  }

  /**
   * 在对话框里搜索模型：先清空已有输入（Ctrl+A + Backspace），再用真实输入管线写入，
   * 并等候选收敛（连续两次读数一致）——过滤是异步的，只读一次会读到旧列表。
   */
  async searchModelDialog(
    query: string,
    deadlineMs = 5_000,
  ): Promise<{ typed: string; rowNames: string[] }> {
    const until = Date.now() + deadlineMs;
    const focused = await this.evaluate<boolean>(focusModelDialogSearchExpression(this.selectors));
    if (!focused) return { typed: "", rowNames: [] };
    await this.clearModelDialogSearch();
    await this.send("Input.insertText", { text: query });
    let previous = "";
    let last: { typed: string; rowNames: string[] } = { typed: "", rowNames: [] };
    for (let attempt = 0; attempt < 50 && Date.now() < until; attempt++) {
      // eslint-disable-next-line no-await-in-loop
      const typed = await this.evaluate<string>(modelDialogSearchTextExpression(this.selectors));
      // eslint-disable-next-line no-await-in-loop
      const rowNames = (await this.modelDialogItems()).map((item) => item.name);
      last = { typed, rowNames };
      const key = JSON.stringify(rowNames);
      if (typed === query && key === previous) return last;
      previous = key;
      // eslint-disable-next-line no-await-in-loop
      await this.pause(FILTER_POLL_MS);
    }
    return last;
  }

  /** 按 `span.model-name` 文本 NFKC 精确点击候选行；无命中/多命中都不点击并回报可见候选 */
  async clickModelDialogRowByName(
    name: string,
  ): Promise<{ clicked: boolean; available: string[] }> {
    const found = await this.evaluate<{
      count: number;
      available: string[];
      point?: KimicodePoint;
    }>(modelDialogRowPointExpression(this.selectors, name));
    if (!found?.point) return { clicked: false, available: found?.available ?? [] };
    await this.clickAt("main", found.point.x, found.point.y);
    return { clicked: true, available: found.available };
  }

  /** Esc 关闭对话框（失败收尾用：残留对话框会吞掉后续的键盘注入） */
  async closeModelDialog(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await this.modelDialogOpen())) return;
      // eslint-disable-next-line no-await-in-loop
      await this.pressKey("main", ESCAPE_KEY);
      // eslint-disable-next-line no-await-in-loop
      await this.pause(PANEL_POLL_MS);
    }
  }

  /* ---------------- 输入与对话 ---------------- */

  inputText(): Promise<string> {
    return this.evaluate<string>(inputTextExpression(this.selectors));
  }

  async typeText(text: string): Promise<void> {
    const focused = await this.evaluate<boolean>(focusInputExpression(this.selectors));
    if (!focused) throw new Error("找不到 Kimi Code 输入框");
    await this.send("Input.insertText", { text });
  }

  async sendMessage(): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (let attempt = 0; attempt < 50 && Date.now() < deadline; attempt++) {
      // eslint-disable-next-line no-await-in-loop
      const point = await this.evaluate<KimicodePoint | null>(
        sendButtonPointExpression(this.selectors),
      );
      if (point) {
        await this.clickAt("main", point.x, point.y);
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      await this.pause(200);
    }
    // 窗口被遮挡/最小化时 Chromium 会节流页面：合成鼠标事件与 elementFromPoint 都不可靠，
    // 按钮「明明在视口内」却点不到。此时只报按钮会把用户引向错误方向，如实报出真因。
    let throttled = false;
    try {
      throttled = await this.pageHidden();
    } catch {
      throttled = false;
    }
    throw new Error(
      throttled
        ? "Kimi Code 发送按钮在观察期内不可点击：Kimi Code 窗口当前不在前台（页面被节流，合成点击不可靠）——请把 Kimi Code 窗口置于前台后重试；未发送任务"
        : "Kimi Code 发送按钮未在观察期内启用或被遮挡；未发送任务",
    );
  }

  conversationText(): Promise<string> {
    return this.evaluate<string>(conversationTextExpression(this.selectors));
  }

  /**
   * 单次运行信号快照（一次 evaluate，见 dom.pollExpression 的说明）。
   * `question` 刻意留空：提问卡片的采集属于 M4（本轮只把字段与 needs_user 分支接上）。
   */
  poll(): Promise<KimicodePoll> {
    return this.evaluate<KimicodePoll>(pollExpression(this.selectors));
  }

  /* ---------------- 内部 ---------------- */

  private resolveKey(key: string): { role: KimicodePageRole; spec: string } {
    if (key.startsWith(OVERLAY_PREFIX)) {
      const name = key.slice(OVERLAY_PREFIX.length);
      if (!(name in KIMICODE_OVERLAY_SELECTORS)) throw new Error(`未知的 Kimi Code 浮层选择器键: ${key}`);
      return { role: "overlay", spec: overlaySpec(name as keyof typeof KIMICODE_OVERLAY_SELECTORS, this.selectors) };
    }
    if (!(key in KIMICODE_SELECTORS)) throw new Error(`未知的 Kimi Code 选择器键: ${key}`);
    return { role: "main", spec: mainSpec(key as keyof typeof KIMICODE_SELECTORS, this.selectors) };
  }

  private evaluateOn<T>(role: KimicodePageRole, expression: string): Promise<T> {
    if (role === "main") return retryKimicodeEvaluation(() => this.pages.main.evaluate<T>(expression));
    return this.pages.overlay.evaluate<T>(expression);
  }

  /**
   * 惰性连接浮层窗口。targetRank 只认 browser-overlay，但若端口上根本没有浮层页面，
   * CDP 会把主窗口交给它——所以连接后用页面 URL 二次确认，避免把主窗口当成浮层操作。
   */
  private async ensureOverlay(): Promise<boolean> {
    if (this.overlayReady) return true;
    const page = this.pages.overlay;
    try {
      await page.connect();
    } catch {
      return false;
    }
    let href = "";
    try {
      href = (await page.evaluate<string>("location.href")) || "";
    } catch {
      href = "";
    }
    if (!/browser-overlay/i.test(href)) {
      try {
        page.disconnect();
      } catch {
        /* 已断开 */
      }
      return false;
    }
    this.overlayReady = true;
    return true;
  }

  /** 浮层菜单项读取：入参是 spec，浮层连不上时返回空集（调用方据此 fail-closed，不猜档位） */
  private async overlayItems(spec: string): Promise<KimicodeOverlayItem[]> {
    if (!(await this.ensureOverlay())) return [];
    return this.evaluateOn<KimicodeOverlayItem[]>("overlay", overlayItemsExpression(spec));
  }

  /**
   * 打开浮层菜单并确认它真的可见。
   * 触发器是 toggle 语义：菜单已经开着时再点一次会把它关掉，所以每轮都先查后点；
   * 窗口被遮挡时节流会吞掉合成点击，故有界重试，不重置调用方给的截止时间。
   */
  private async openOverlayMenu(pillKey: "modelPill" | "permissionPill", deadlineMs: number): Promise<boolean> {
    if (await this.overlayVisible()) return true;
    const deadline = Date.now() + deadlineMs;
    let lastClick = 0;
    while (Date.now() < deadline) {
      if (Date.now() - lastClick >= TRIGGER_RECLICK_MS) {
        // eslint-disable-next-line no-await-in-loop
        await this.click(pillKey);
        lastClick = Date.now();
      }
      // eslint-disable-next-line no-await-in-loop
      if (await this.overlayVisible()) return true;
      // eslint-disable-next-line no-await-in-loop
      await this.pause(PANEL_POLL_MS);
    }
    return false;
  }

  /** trusted 鼠标点击（moved + pressed + released）：ws-chip 只认这条路径 */
  private async clickAt(role: KimicodePageRole, x: number, y: number): Promise<void> {
    const page = role === "overlay" ? this.pages.overlay : this.pages.main;
    // 窗口被遮挡/最小化时 Chromium 会节流页面，合成事件常被吞（真机实测：工作区触发器
    // 点 5 秒无任何反应）。派发前先确认前台，隐藏就先置前，避免把节流误诊成选择器失效。
    if (role === "main") {
      try {
        if (await this.pageHidden()) await this.focusMainWindow();
      } catch {
        /* 读不到可见性时按可见处理，继续点击（回读仍会如实判定） */
      }
    }
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await page.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }

  private pressEscape(role: KimicodePageRole): Promise<void> {
    return this.pressKey(role, ESCAPE_KEY);
  }

  /** 清空对话框搜索框：Ctrl+A + Backspace（受控输入框不设 value，走真实键盘事件） */
  private async clearModelDialogSearch(): Promise<void> {
    await this.pressKey("main", SELECT_ALL_KEY);
    await this.pressKey("main", BACKSPACE_KEY);
  }

  /** 键盘注入（keyDown + keyUp）：Electron 侧只认真实事件，不认 DOM 属性赋值 */
  private async pressKey(role: KimicodePageRole, stroke: KeyStroke): Promise<void> {
    const page = role === "overlay" ? this.pages.overlay : this.pages.main;
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...stroke });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...stroke });
  }

  private pause(ms: number): Promise<void> {
    return this.evaluate(`new Promise(resolve=>setTimeout(resolve,${ms}))`);
  }
}