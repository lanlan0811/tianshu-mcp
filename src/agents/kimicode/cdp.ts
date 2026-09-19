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
  inputTextExpression,
  menuOpenCountExpression,
  overlayVisibleExpression,
  pageHiddenExpression,
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
 * 触发器点击被吞后的重试间隔。窗口被其他窗口完全遮挡时 Chromium 会节流页面，
 * 合成鼠标事件常被吞掉（第一次点击无效、第二次才生效），所以「点一次然后干等」必然失败。
 */
const TRIGGER_RECLICK_MS = 1_500;

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
  connect(): Promise<void> {
    return this.pages.main.connect();
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

  /** trusted 鼠标点击（moved + pressed + released）：ws-chip 只认这条路径 */
  private async clickAt(role: KimicodePageRole, x: number, y: number): Promise<void> {
    const page = role === "overlay" ? this.pages.overlay : this.pages.main;
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

  private async pressEscape(role: KimicodePageRole): Promise<void> {
    const page = role === "overlay" ? this.pages.overlay : this.pages.main;
    await page.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await page.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
  }

  private pause(ms: number): Promise<void> {
    return this.evaluate(`new Promise(resolve=>setTimeout(resolve,${ms}))`);
  }
}