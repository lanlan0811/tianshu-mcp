/**
 * Open Design 的 CDP 客户端装配与页面操作原语。
 *
 * 复用 `TraeworkCdpClient` 作为**页面级传输**（WebSocket / send 超时 / 断线语义已经打磨过），
 * 只注入本产品的**目标排序**；在其之上封装本产品需要的语义操作（12 步流程全部走这一层，
 * 绝不在 `run.ts` 里直接拼页面表达式——两处各写一套必然漂移）。
 *
 * 两条与计划对齐的硬约束：
 * 1. **点击是可信点击**：坐标由 `getBoundingClientRect` 实时算出后经 `Input.dispatchMouseEvent`
 *    派发，而不是 `element.click()`（React 的合成事件链对 `isTrusted` 敏感，真机教训）；
 * 2. **每次「点击成功」都要回读确认**（面板是否真的展开、菜单项是否真的出现），
 *    点击本身只代表事件已派发。
 */
import { TraeworkCdpClient } from "../traework/cdp/client.js";
import type { KimicodePageClient, KimicodePageRole } from "../kimicode/cdp.js";
import { OPEN_DESIGN_DOM, type SelectorOverrides } from "./dom.js";
import {
  OPEN_DESIGN_LAYOUT_GUARD_KEYS,
  OPEN_DESIGN_SELECTORS,
  type OpenDesignSelectorKey,
} from "./selectors.js";
import {
  conversationTextExpression,
  countExpression,
  dismissExpression,
  exactMatchPointExpression,
  existsExpression,
  firstPointExpression,
  inputValueExpression,
  layoutProbeExpression,
  listLabelsExpression,
  selectorSpecFor,
  singlePointExpression,
  textExpression,
  triggerTextExpression,
  type LayoutProbeEntry,
} from "./dom.js";

export interface OpenDesignTargetLike {
  type?: string;
  title?: string;
  url?: string;
}

/**
 * 本产品的页面判据 —— **单一真源**（`instance.ts` 的端口探测也 import 它）。
 *
 * 真机形态（2026-09-27，Open Design 0.24.1）：`/json/list` 返回
 * `page | "OpenDesign" | "od://app/"` —— 标题**无空格**、URL 也不含 `open-design` 字样。
 * 因此三条判据缺一不可：标题（容忍有无空格）／URL 含 open-design／URL 是本产品的 `od://` 协议。
 *
 * 历史教训：`instance.ts` 曾自带一份只认前两条的副本，导致真机「明明连上了真实 CDP，
 * 就绪判据却判 false」，最终表现为 90000ms 等待后 `setup_failed`（详见 HANDOFF）。
 */
export function isProductPage(target: OpenDesignTargetLike): boolean {
  const title = (target.title ?? "").trim();
  const url = target.url ?? "";
  return /^open\s*design/i.test(title) || /open-design/i.test(url) || /^od:\/\//i.test(url);
}

/**
 * 主窗口优先：真主窗口 → 其他本产品页面 → 无关 page。
 *
 * 两条真机修正（2026-09-27，0.24.1）：
 * 1. 主窗口标题是 **`OpenDesign`（无空格）**；只认带空格的 `Open Design` 会让它与辅助页同级；
 * 2. 产品会另开一个**同标题的辅助页** `od://app/desktop-pet`（桌面宠物，没有任何业务控件）。
 *    同级排序会退化成「谁先返回」，适配器可能连到空页面 —— 探针首跑就命中过：
 *    全部锚点 count=0，看起来像「UI 全漂移」，其实是连错了页面。
 * 故辅助页压到最低档，标题判据容忍有无空格。
 */
export function openDesignMainTargetRank(target: OpenDesignTargetLike): number {
  const title = (target.title ?? "").trim();
  const url = target.url ?? "";
  if (/desktop-pet|overlay/i.test(url)) return 3;
  if (/^open\s*design$/i.test(title)) return 0;
  if (isProductPage(target)) return 1;
  return 2;
}

/** 浮层优先：下拉菜单若在独立渲染进程，其标题通常不是主窗口标题 */
export function openDesignOverlayTargetRank(target: OpenDesignTargetLike): number {
  const title = (target.title ?? "").trim();
  if (!title || /^about:blank$/i.test(title) || /^about:blank$/i.test(target.url ?? "")) return 0;
  return isProductPage(target) ? 2 : 1;
}

export interface OpenDesignCdpDeps {
  /** 按角色创建页面客户端；缺省创建 TraeworkCdpClient（带各自的 targetRank） */
  createClient?: (role: KimicodePageRole) => KimicodePageClient;
}

/**
 * 页面角色 → 客户端。Open Design 的菜单/面板都是**同一文档内的浮层**
 * （不像 Kimi Code 那样有独立 overlay 渲染进程），`overlay` 角色只保留给诊断脚本。
 */
export function createOpenDesignPageClient(
  role: KimicodePageRole,
  port: number,
  sendTimeoutMs: number,
  deps: OpenDesignCdpDeps = {},
): KimicodePageClient {
  if (deps.createClient) return deps.createClient(role);
  return new TraeworkCdpClient({
    port,
    sendTimeoutMs,
    appLabel: "Open Design",
    targetRank: role === "overlay" ? openDesignOverlayTargetRank : openDesignMainTargetRank,
  }) as KimicodePageClient;
}

export interface OpenDesignDocumentProbe {
  /** 页面 URL 与标题（诊断用） */
  url: string;
  title: string;
  /** 关键锚点的存在性与文本（选择器漂移的诊断依据） */
  anchors: LayoutProbeEntry[];
  /** 页面可见文本长度（判「页面还没渲染完」用的粗信号） */
  bodyTextLength: number;
  /** 页面可见文本片段（截断）：选择器漂移时用于判断「页面到底渲染了什么」 */
  bodyText?: string;
}

/**
 * 在**主窗口**里执行一次只读布局盘点：按注册表里每个语义键解析元素并计数。
 * 纯读取、不点任何东西——probe 脚本、`run.ts` 的 selector_drift 判据共用同一份实现
 * （两处各写一套必然漂移）。
 *
 * `overrides` 用于真机采集：把候选 CSS 按语义键传进来即可读出命中情况。
 */
export async function probeLayout(
  client: KimicodePageClient,
  overrides: SelectorOverrides = {},
): Promise<OpenDesignDocumentProbe> {
  return client.evaluate<OpenDesignDocumentProbe>(
    layoutProbeExpression(OPEN_DESIGN_LAYOUT_GUARD_KEYS, overrides),
  );
}

/**
 * 采集模式：对**全部**语义键（含菜单/按钮这类运行期才出现的键）做布局盘点，
 * 供 `scripts/probe-opendesign.mjs` 输出候选命中清单。缺值的键不会进表达式。
 */
export async function probeAllAnchors(
  client: KimicodePageClient,
  overrides: SelectorOverrides = {},
): Promise<OpenDesignDocumentProbe> {
  const keys = Object.keys(OPEN_DESIGN_SELECTORS) as OpenDesignSelectorKey[];
  const present = keys.filter((key) => {
    const spec = OPEN_DESIGN_SELECTORS[key];
    return Boolean(overrides[key]?.trim() || spec.primary.trim() || (spec.fallbacks ?? []).length);
  });
  return client.evaluate<OpenDesignDocumentProbe>(layoutProbeExpression(present, overrides));
}

/** 选择器覆盖的浅合并（profile.gui.selectors 覆盖内置默认） */
export function mergeSelectors(
  defaults: Record<string, string>,
  overrides: SelectorOverrides = {},
): Record<string, string> {
  const out: Record<string, string> = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (value && value.trim()) out[key] = value.trim();
  }
  return out;
}

/** 精确点击的结果（与 kimicode 的 KimicodeClickExactResult 同构） */
export interface OpenDesignClickExactResult {
  clicked: boolean;
  /** 归一后与目标全等的可见命中数（>1 视为歧义，拒绝点击） */
  count: number;
  /** 当前可见候选（未命中时的诊断依据，最多 20 项） */
  available: string[];
}

export interface OpenDesignPoint {
  x: number;
  y: number;
}

/** `clickKey` 允许声明的后置条件：点击后必须观察到什么才算「确实生效」 */
export type OpenDesignClickExpect = "working-dir-panel" | "none";

/** 运行检测的单次快照（字段与 `liveness.OpenDesignPoll` 对应的子集） */
export interface OpenDesignPollSnapshot {
  stopVisible: boolean;
  sendStarting: boolean;
  conversationText: string;
  inputText: string;
  /**
   * 界面明确给出的失败文案（失败终态的权威信号）。
   * 真机回归（2026-10-11）：漏了这个字段，失败态就永远传不到判定层，
   * 任务会在「看起来全静止」的失败界面上空等到时限。
   */
  errorText: string;
  pageHidden: boolean;
}

/**
 * 运行检测的单次快照表达式：一次页面求值取回全部信号，避免多次 CDP 往返产生观测竞态
 * （与 `TraeworkCdpClient.probeLiveness` 同一取舍）。
 * 字段与 `liveness.OpenDesignPoll` 一一对应，改名必须同步两处。
 */
export function pollExpression(overrides: SelectorOverrides = {}): string {
  const spec = (key: OpenDesignSelectorKey): string => selectorSpecFor(key, overrides);
  return `(function(){${OPEN_DESIGN_DOM}/*od:poll*/
    const nodes = odResolve(${spec("stopButton")}, true);
    return {
      stopVisible: nodes.length > 0,
      // 发送中态：按钮带 aria-busy 或 disabled（产品用 chat-send-pending 表达「已受理未开跑」）
      sendStarting: odResolve(${spec("sendButton")}, true).some(
        (e) => e.getAttribute('aria-busy') === 'true' || e.getAttribute('disabled') !== null,
      ),
      conversationText: odResolve(${spec("conversationText")}, true).map(odText).join('\\n'),
      inputText: (function () {
        const inputs = odResolve(${spec("inputBox")}, true);
        if (!inputs.length) return '';
        const e = inputs[0];
        return 'value' in e && typeof e.value === 'string' ? e.value : odText(e);
      })(),
      pageHidden: document.hidden === true,
      // 失败终态文案：有它就必须判 failed，不得继续当「运行中」等下去
      errorText: (function () {
        const e = odResolve(${spec("errorText")}, true);
        return e.length ? odText(e[0]) : '';
      })(),
    };
  })()`;
}

/**
 * Open Design 主窗口的语义操作层：所有页面交互都经这里，`run.ts` 只调语义方法。
 */
export class OpenDesignCdpClient {
  constructor(
    private readonly page: KimicodePageClient,
    private readonly overrides: SelectorOverrides = {},
    private readonly sleepFn: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** 等待若干毫秒（供上层做「重试一次」这类有界等待；sleep 本身不进预算，由调用方夹住） */
  sleep(ms: number): Promise<void> {
    return this.sleepFn(ms);
  }

  connect(): Promise<void> {
    return this.page.connect();
  }

  disconnect(): void {
    this.page.disconnect();
  }

  get connected(): boolean {
    return this.page.connected === true;
  }

  evaluate<T = unknown>(expression: string): Promise<T> {
    return this.page.evaluate<T>(expression);
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.page.send(method, params);
  }

  /** 置前：Chromium 会节流后台页面，合成事件在非前台时经常被吞（真机教训） */
  async bringToFront(): Promise<boolean> {
    try {
      await this.send("Page.bringToFront");
      await this.sleepFn(300);
      return true;
    } catch {
      return false;
    }
  }

  pageHidden(): Promise<boolean> {
    return this.evaluate<boolean>("document.hidden === true").catch(() => false);
  }

  href(): Promise<string> {
    return this.evaluate<string>("location.href").catch(() => "");
  }

  /** 只读布局盘点（布局守卫 / 探针共用） */
  probe(): Promise<OpenDesignDocumentProbe> {
    return probeLayout(this.page, this.overrides);
  }

  /* ---------------- 通用读写 ---------------- */

  exists(key: OpenDesignSelectorKey): Promise<boolean> {
    return this.evaluate<boolean>(existsExpression(selectorSpecFor(key, this.overrides)));
  }

  text(key: OpenDesignSelectorKey): Promise<string> {
    return this.evaluate<string>(textExpression(selectorSpecFor(key, this.overrides)));
  }

  count(key: OpenDesignSelectorKey): Promise<number> {
    return this.evaluate<number>(countExpression(selectorSpecFor(key, this.overrides)));
  }

  labels(key: OpenDesignSelectorKey): Promise<string[]> {
    return this.evaluate<string[]>(listLabelsExpression(selectorSpecFor(key, this.overrides)));
  }

  /** 触发器上的当前值文本（模型/设计系统/设计方向/工作目录回读共用） */
  triggerText(key: OpenDesignSelectorKey): Promise<string> {
    return this.evaluate<string>(triggerTextExpression(key, this.overrides));
  }

  /**
   * 输入框当前文本（`inputValueExpression` 返回 `{found,value,length}`，
   * 这里只取 `value`——类型写成 string 却返回对象会让调用方的 `includes` 在运行时炸掉）。
   */
  async inputText(): Promise<string> {
    const result = await this.evaluate<{ found?: number; value?: string }>(
      inputValueExpression(this.overrides),
    );
    return typeof result?.value === "string" ? result.value : "";
  }

  conversationText(): Promise<string> {
    return this.evaluate<string>(conversationTextExpression(this.overrides));
  }

  /** 输入框是否可见（「页面可交互」判据：只列到 target 不代表已渲染完） */
  inputReady(): Promise<boolean> {
    return this.evaluate<boolean>(existsExpression(selectorSpecFor("inputBox", this.overrides))).catch(
      () => false,
    );
  }

  /* ---------------- 点击 ---------------- */

  /** 可信鼠标点击（坐标在页面内实时计算） */
  async clickAt(point: OpenDesignPoint): Promise<boolean> {
    try {
      const x = Math.round(point.x);
      const y = Math.round(point.y);
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await this.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 点击某语义键指向的**唯一**元素，并可选校验后置条件。
   * 多命中/零命中一律不给坐标（猜一个点会点到别的控件），由调用方据此判 fail-closed。
   */
  async clickKey(
    key: OpenDesignSelectorKey,
    options: { expect?: OpenDesignClickExpect; expectBudgetMs?: number } = {},
  ): Promise<{ clicked: boolean; count: number }> {
    const hit = await this.evaluate<{ count: number; point?: OpenDesignPoint }>(
      singlePointExpression(selectorSpecFor(key, this.overrides)),
    );
    if (hit.count !== 1 || !hit.point) return { clicked: false, count: hit.count };
    const dispatched = await this.clickAt(hit.point);
    if (!dispatched) return { clicked: false, count: 1 };
    if (options.expect === "working-dir-panel") {
      const ok = await this.waitFor(
        () => this.exists("selectDirItem"),
        options.expectBudgetMs ?? 5_000,
      );
      return { clicked: ok, count: 1 };
    }
    return { clicked: true, count: 1 };
  }

  /** 取第一个可见匹配的坐标（不要求唯一，仅用于诊断/兜底） */
  firstPoint(key: OpenDesignSelectorKey): Promise<{ count: number; point?: OpenDesignPoint }> {
    return this.evaluate<{ count: number; point?: OpenDesignPoint }>(
      firstPointExpression(selectorSpecFor(key, this.overrides)),
    );
  }

  /**
   * 按可见文本/aria **精确**匹配菜单项并点击（NFKC 归一后全等，多命中即拒绝）。
   * 未命中时把当前可见候选原样带回，供调用方按「未命中就报错并回显候选」的纪律落文案。
   */
  async clickExact(key: OpenDesignSelectorKey, value: string): Promise<OpenDesignClickExactResult> {
    const hit = await this.evaluate<{
      count: number;
      available: string[];
      point?: OpenDesignPoint;
    }>(exactMatchPointExpression(key, value, this.overrides));
    const available = Array.isArray(hit.available) ? hit.available : [];
    if (hit.count !== 1 || !hit.point) return { clicked: false, count: hit.count, available };
    const dispatched = await this.clickAt(hit.point);
    return { clicked: dispatched, count: 1, available };
  }

  /**
   * 按**原始 CSS** 点击首个可见元素（点第一个、并回报命中总数）。
   * 用于注册表之外的兜底入口（例如首页导航钩子）；业务锚点一律走语义键，避免又出现一套散落的选择器。
   */
  async clickSelector(selector: string): Promise<{ clicked: boolean; count: number }> {
    const hit = await this.evaluate<{ count: number; point?: OpenDesignPoint }>(
      `(function(){${OPEN_DESIGN_DOM}/*od:raw-point*/
        let nodes = [];
        try { nodes = [...document.querySelectorAll(${JSON.stringify(selector)})]; } catch (_) { return { count: -1 }; }
        const visible = nodes.filter(odVisible);
        if (!visible.length) return { count: 0 };
        return { count: visible.length, point: odPoint(visible[0]) };
      })()`,
    );
    if (!hit.point) return { clicked: false, count: hit.count };
    return { clicked: await this.clickAt(hit.point), count: hit.count };
  }

  /* ---------------- 输入 ---------------- */

  /**
   * 在输入框内键入文本：先可信点击聚焦，再走 `Input.insertText`（真实输入管线，
   * Lexical/contenteditable 友好；直接改 textContent 不会触发 React 的 onChange）。
   */
  /**
   * 清空任务输入框（点入 → 全选 → 删除 → 回读确认为空）。
   *
   * 为什么必须在输入任务书**之前**做（真机 2026-09-28 实测）：首页输入框可能残留产品模板
   * 或上一次的草稿（例如「游戏化习惯应用…」），而 `Input.insertText` 是**插到光标处**、
   * 不是替换全文 —— 结果是「模板 + 任务书」混在一起（真机上就是 55 字的混合文本），
   * 回读不含本次标记，适配器只能 fail-closed 放弃发送；用户看到的现象正是「没有点击发送按钮」。
   */
  async clearInput(): Promise<boolean> {
    const hit = await this.evaluate<{ count: number; point?: OpenDesignPoint }>(
      singlePointExpression(selectorSpecFor("inputBox", this.overrides)),
    );
    if (hit.count !== 1 || !hit.point) return false;
    await this.clickAt(hit.point);
    await this.sleepFn(100);
    // 与 clearAndType 同一套原语：Ctrl+A 全选 + Delete
    await this.key("a", "KeyA", 65, { modifiers: 2 });
    await this.key("Delete", "Delete", 46);
    await this.sleepFn(120);
    return true;
  }

  /**
   * 在任务输入框里键入任务书。
   *
   * **调用方必须先 `clearInput()`**（见 `dispatchTask`）：本方法只负责"输入"这一件事，
   * 不做隐式清场 —— 清空与否是可观测的行为，藏进这里就无法在单测里断言调用顺序。
   */
  async typeText(text: string): Promise<void> {
    const hit = await this.evaluate<{ count: number; point?: OpenDesignPoint }>(
      singlePointExpression(selectorSpecFor("inputBox", this.overrides)),
    );
    if (hit.count !== 1 || !hit.point)
      throw new Error(`Open Design 输入框无法唯一定位（匹配 ${hit.count}）——选择器可能已漂移`);
    await this.clickAt(hit.point);
    await this.sleepFn(120);
    await this.send("Input.insertText", { text });
    // insertText 是可信输入，React 会收到真实 beforeinput/input；再等一拍让受控状态落定
    await this.sleepFn(200);
  }

  /**
   * 在指定语义键的输入框里**清空后**键入（设计系统面板的搜索框）。
   * 必须先清空：上一次搜索的残留会让过滤结果只剩旧项，表现为「目标项没渲染出来」。
   * 搜索框可能被多条候选同时命中（例如面板里既有搜索框又有隐藏输入），
   * 因此这里允许退化为「首个可见命中」，但仍要求至少命中一个。
   */
  async clearAndType(key: OpenDesignSelectorKey, text: string): Promise<boolean> {
    const hit = await this.evaluate<{ count: number; point?: OpenDesignPoint }>(
      singlePointExpression(selectorSpecFor(key, this.overrides)),
    );
    let point = hit.point;
    if (hit.count !== 1 || !point) point = (await this.firstPoint(key)).point;
    if (!point) return false;
    await this.clickAt(point);
    await this.sleepFn(80);
    // 全选 + 删除，清掉上一次过滤条件（Ctrl+A / Delete）
    await this.key("a", "KeyA", 65, { modifiers: 2 });
    await this.key("Delete", "Delete", 46);
    await this.sleepFn(60);
    await this.send("Input.insertText", { text });
    await this.sleepFn(150);
    return true;
  }

  /* ------------------------------ 导出段（步 9.5） ------------------------------ */

  /** 当前页面 URL —— 导出段据此推导产物名（`od://.../files/onboarding-guide.html`） */
  async currentUrl(): Promise<string> {
    return this.evaluate<string>("location.href");
  }

  /**
   * 把**下载目录**指到目标路径（导出段的正解；真机取证 2026-10-11）。
   *
   * 为什么不能用原生保存对话框：0.24.1 的「导出为独立 HTML」/「下载为 .zip」走的是
   * **浏览器式下载**（blob → Electron `will-download`）——点完只出现一个 `#32770` 空壳窗口
   * （标题 `blob:od://app/<uuid>`、无任何子控件），下载停在 `~/Downloads/<uuid>.tmp` 不再增长。
   * 那个窗口不是可供 Win32/UIA 驱动的保存对话框，`saveViaNativeDialog` 因此永远等不到产物。
   *
   * 正解：CDP 先指定 downloadPath，再点菜单项，文件**直接落盘到目标目录**。
   * 真机复现：html → 完整文档；zip → 魔数 `504b0304` + `testzip()` 无损坏。
   *
   * 两个协议版都发一次：`Page.*` 在部分 Electron/Chromium 组合上被忽略，
   * `Browser.*`（较新）覆盖面更广——两者都是幂等设置，重复调用无副作用。
   */
  async setDownloadDir(dir: string): Promise<boolean> {
    let ok = false;
    for (const method of ["Page.setDownloadBehavior", "Browser.setDownloadBehavior"] as const) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.send(method, { behavior: "allow", downloadPath: dir });
        ok = true;
      } catch {
        // 单个协议不支持不影响另一个；两个都失败才算失败
      }
    }
    return ok;
  }

  /**
   * 按**可见文本**精确点一个按钮。
   *
   * 为什么需要它：工具栏「导出」按钮**没有 testid**（真机取证 2026-09-28），产品只给了文本；
   * 语义键 `exportTrigger` 用 `texts:["导出"]` + `excludes`（排除产物卡片上的同名按钮）来消歧，
   * 这里仍要求**唯一命中**才点——多命中说明排除规则没覆盖住，宁可报错也不猜。
   */
  async clickByText(text: string): Promise<{ clicked: boolean; count: number }> {
    const hit = await this.evaluate<{ count: number; point?: OpenDesignPoint }>(
      exactMatchPointExpression("exportTrigger", text, this.overrides),
    );
    if (hit.count !== 1 || !hit.point) return { clicked: false, count: hit.count };
    await this.clickAt(hit.point);
    return { clicked: true, count: 1 };
  }

  /** 等导出菜单（`role=menu`）出现 */
  async waitForMenu(timeoutMs: number): Promise<boolean> {
    return this.waitFor(() => this.exists("exportMenu"), timeoutMs);
  }

  /** 按文本精确点导出方式菜单项；未命中时回显可见候选（fail-closed 报错要能直接读） */
  async clickMenuItem(
    text: string,
  ): Promise<{ clicked: boolean; count: number; available: string[] }> {
    const hit = await this.evaluate<{
      count: number;
      available?: string[];
      point?: OpenDesignPoint;
    }>(exactMatchPointExpression("exportMenuItem", text, this.overrides));
    const available = hit.available ?? [];
    if (hit.count !== 1 || !hit.point) return { clicked: false, count: hit.count, available };
    await this.clickAt(hit.point);
    return { clicked: true, count: 1, available };
  }

  /** Escape 关闭浮层（尽力而为；浮层未关闭由后续回读判据兜底） */
  async dismissMenus(): Promise<void> {    try {
      await this.evaluate(dismissExpression(this.overrides));
    } catch {
      /* 尽力而为 */
    }
    try {
      await this.key("Escape", "Escape", 27);
    } catch {
      /* 尽力而为 */
    }
  }

  async key(
    key: string,
    code: string,
    vk: number,
    options: { text?: string; modifiers?: number } = {},
  ): Promise<void> {
    const base = {
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      ...(options.text === undefined ? {} : { text: options.text }),
      ...(options.modifiers === undefined ? {} : { modifiers: options.modifiers }),
    };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /* ---------------- 运行检测 ---------------- */

  poll(): Promise<OpenDesignPollSnapshot> {
    return this.evaluate<OpenDesignPollSnapshot>(pollExpression(this.overrides));
  }

  /** 在预算内轮询直到谓词为真（不做无界等待） */
  async waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate().catch(() => false)) return true;
      if (Date.now() >= deadline) return false;
      await this.sleepFn(200);
    }
  }
}