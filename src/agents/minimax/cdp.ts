/**
 * MiniMax Code CDP 客户端。
 *
 * 真机事实（2026-10-05，MiniMax Code 3.1.0 / Chromium 148.0.7778.280 / Electron 42.8.0）：
 * MiniMax Code 是**双渲染进程**应用，一个端口上同时存在三个 page target：
 *   - 主窗口：title `MiniMax Code`，url `app://./archon`
 *     → 侧栏、项目分组、composer、输入框、发送/停止按钮都在这里；
 *   - 模型弹层：title `Model menu`，url `.../resources/app.asar/dist/model-menu/index.html`
 *     → 模型列表、**以及悬停模型项后展开的推理等级/上下文窗口二级子菜单**；
 *   - 截图页：title `Rsbuild App`，url `.../react-screenshots/dist/electron.html` → 必须排除。
 *
 * 因此本类内部持有**两个** TraeworkCdpClient：主窗口按 targetRank 收敛，
 * 弹层只在需要时惰性连接（rank 只认 model-menu）。
 *
 * 二级子菜单的时序：**悬停**（mouseMoved，不按鼠标键）某个带 aria-haspopup="menu" 的模型项后，
 * 该窗口内出现第二个 `role="menu"`，其中才有推理等级/上下文窗口组。实测展开是异步的
 * （需数百毫秒），所以 submenuOpen() 以「组已渲染」为收敛判据而非盲等。
 */
import {
  TraeworkCdpClient,
  CdpDisconnectedError,
  CdpUnavailableError,
} from "../traework/cdp/client.js";
import { MM_MAIN_SELECTORS, MM_MENU_SELECTORS, mainSpec, menuSpec } from "./selectors.js";
import {
  contextOptionsExpression,
  conversationTextExpression,
  effortOptionsExpression,
  domClickExpression,
  existsExpression,
  exactMatchExpression,
  firstPointExpression,
  focusInputExpression,
  hoverPointExpression,
  inputTextExpression,
  labelExpression,
  menuModelItemsExpression,
  menuModelReadyExpression,
  menuOpenCountExpression,
  menuOpenExpression,
  modalChooseFolderPointExpression,
  modalOpenExpression,
  modalProjectExpression,
  modalSubmitPointExpression,
  newTaskPointExpression,
  pageHiddenExpression,
  pollExpression,
  projectPointExpression,
  projectGroupsExpression,
  sendButtonPointExpression,
  sendStateExpression,
  sessionTitlesExpression,
  singlePointExpression,
  submenuOpenExpression,
  submenuOwnerExpression,
  textExpression,
  type SelectorOverrides,
} from "./dom.js";
import type { MinimaxPoll } from "./liveness.js";
import { normalizeProjectPath, type MinimaxProjectGroup } from "./workspace.js";

export { CdpDisconnectedError, CdpUnavailableError };

export interface MinimaxPoint {
  x: number;
  y: number;
}

export interface MinimaxModelItem {
  name: string;
  current: boolean;
  /** 是否带二级子菜单（aria-haspopup="menu"）——档位/窗口只有这类项能读 */
  hasPopup: boolean;
  expanded: boolean;
  point: MinimaxPoint;
}

export interface MinimaxEffortOption {
  label: string;
  current: boolean;
  point: MinimaxPoint;
}

export interface MinimaxContextOption {
  label: string;
  current: boolean;
  /** 是否带「用量较高」标记（只作诊断） */
  higherUsage: boolean;
  point: MinimaxPoint;
}

export interface MinimaxClickExactResult {
  clicked: boolean;
  count: number;
  available: string[];
}

/** CDP page target 的最小可判定字段（TraeworkCdpClient 的 CdpPageTarget 结构兼容） */
export interface MinimaxTargetLike {
  type?: string;
  title?: string;
  url?: string;
}

/** 弹层选择器键在对外 API 里的前缀（`menu.permissionOption` 形态） */
const MENU_PREFIX = "menu.";

/**
 * 主窗口 target 排序偏好：优先 title 恰好为 `MiniMax Code`，其次 `app://` 页面；
 * 弹层与截图窗口排到最后（正常情况下不会被选中）。
 */
export function minimaxMainTargetRank(target: MinimaxTargetLike): number {
  const url = target.url ?? "";
  const title = (target.title ?? "").trim();
  if (/model-menu|react-screenshots/i.test(url)) return 100;
  if (title === "MiniMax Code") return 0;
  if (url.startsWith("app://")) return 1;
  return 2;
}

/** 弹层 target 排序偏好：只认为 model-menu 页面是弹层，其余一律靠后 */
export function minimaxMenuTargetRank(target: MinimaxTargetLike): number {
  return /dist\/model-menu\//i.test(target.url ?? "") ? 0 : 100;
}

export type MinimaxPageRole = "main" | "menu";

/** 页面级 CDP 客户端（真实实现为 TraeworkCdpClient；单测注入内存桩） */
export interface MinimaxPageClient {
  connect(): Promise<void>;
  disconnect(): void;
  evaluate<T = unknown>(expression: string): Promise<T>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  readonly connected?: boolean;
  readonly alive?: boolean;
}

export interface MinimaxCdpDeps {
  /** 按角色创建页面客户端；缺省创建 TraeworkCdpClient（带各自的 targetRank） */
  createClient?: (role: MinimaxPageRole) => MinimaxPageClient;
}

/** 与 zcode/retryZcodeEvaluation 同义：只重试一次 Runtime.evaluate 的瞬态不可用 */
export async function retryMinimaxEvaluation<T>(
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

/** 点击后确认菜单打开的轮询间隔（不是独立超时） */
const PANEL_POLL_MS = 100;
/**
 * 置前后等待前台真正生效的上限。实测 Page.bringToFront 异步生效（数百毫秒），
 * 期间派发的合成事件仍会被节流吞掉。
 */
const FOCUS_SETTLE_MS = 1_500;
/**
 * 触发器点击被吞后的重试间隔。窗口被其他窗口完全遮挡时 Chromium 会节流页面，
 * 合成鼠标事件常被吞掉（第一次点击无效、第二次才生效），所以「点一次然后干等」必然失败。
 */
const TRIGGER_RECLICK_MS = 1_500;
/** 悬停后等待二级子菜单渲染出来的轮询间隔 */
const SUBMENU_POLL_MS = 150;

/** 键盘事件参数（沿用既有字段组合，保证 Electron 真的收得到） */
interface KeyStroke {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers?: number;
}
const ESCAPE_KEY: KeyStroke = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 };

export class MinimaxCdpClient {
  readonly port: number;
  private readonly pages: Record<MinimaxPageRole, MinimaxPageClient>;
  private menuReady = false;

  constructor(
    port: number,
    sendTimeoutMs: number,
    private readonly selectors: SelectorOverrides = {},
    deps: MinimaxCdpDeps = {},
  ) {
    this.port = port;
    const create =
      deps.createClient ??
      ((role: MinimaxPageRole) =>
        new TraeworkCdpClient({
          port,
          sendTimeoutMs,
          appLabel: "MiniMax Code",
          targetRank: role === "menu" ? minimaxMenuTargetRank : minimaxMainTargetRank,
        }) as MinimaxPageClient);
    this.pages = { main: create("main"), menu: create("menu") };
  }

  /** 连接主窗口（弹层按需惰性连接，见 ensureMenu） */
  async connect(): Promise<void> {
    await this.pages.main.connect();
    // 启动后窗口常在后台：Chromium 会节流被遮挡/不可见的页面，合成鼠标事件被吞，
    // 于是「点触发器无反应」被误报成选择器失效。连接后立刻置前并开启焦点模拟。
    await this.focusMainWindow();
  }

  /**
   * 把主窗口置于前台并开启焦点模拟，然后**等前台真正生效**再返回。
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
        if (!(await this.pageHidden())) return;
      } catch {
        return;
      }
      if (Date.now() >= until) return;
      await this.pause(100);
    }
  }

  disconnect(): void {
    try {
      this.pages.main.disconnect();
    } finally {
      this.menuReady = false;
      this.pages.menu.disconnect();
    }
  }

  evaluate<T>(expression: string): Promise<T> {
    return retryMinimaxEvaluation(() => this.pages.main.evaluate<T>(expression));
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.pages.main.send(method, params);
  }

  /** 主窗口是否被隐藏（窗口被遮挡/最小化 → Chromium 节流 → 合成点击不可靠） */
  pageHidden(): Promise<boolean> {
    return this.evaluate<boolean>(pageHiddenExpression());
  }

  /* ---------------- 语义键操作（主窗口键，或 `menu.` 前缀的弹层键） ---------------- */

  async exists(key: string): Promise<boolean> {
    const target = this.resolveKey(key);
    if (target.role === "menu" && !(await this.ensureMenu())) return false;
    return (await this.evaluateOn<boolean>(target.role, existsExpression(target.spec))) === true;
  }

  async text(key: string): Promise<string> {
    const target = this.resolveKey(key);
    if (target.role === "menu" && !(await this.ensureMenu())) return "";
    return (await this.evaluateOn<string>(target.role, textExpression(target.spec))) || "";
  }

  /** 可读名称（aria-label → span.sr-only → title → innerText） */
  async label(key: string): Promise<string> {
    const target = this.resolveKey(key);
    if (target.role === "menu" && !(await this.ensureMenu())) return "";
    return (await this.evaluateOn<string>(target.role, labelExpression(target.spec))) || "";
  }

  /**
   * 点击语义键。**先 trusted 坐标点击**（Input.dispatchMouseEvent moved+pressed+released），
   * 拿不到唯一可见目标时才回退 DOM click。
   */
  async click(key: string): Promise<boolean> {
    const target = this.resolveKey(key);
    if (target.role === "menu" && !(await this.ensureMenu())) return false;
    const found = await this.evaluateOn<{ count: number; point?: MinimaxPoint }>(
      target.role,
      singlePointExpression(target.spec),
    );
    if (found?.point) {
      await this.clickAt(target.role, found.point.x, found.point.y);
      return true;
    }
    return (await this.evaluateOn<boolean>(target.role, domClickExpression(target.spec))) === true;
  }

  /**
   * 点击**第一个**可见匹配（不要求唯一）。
   * 用于「任取一个都成立」的语义键——例如「在该项目中新建任务」在每个项目分组各有一个，
   * 天然多命中；先建出会话、随后按完整路径显式绑定目标项目，顺序上已保证正确性。
   */
  async clickFirst(key: string): Promise<boolean> {
    const target = this.resolveKey(key);
    if (target.role === "menu" && !(await this.ensureMenu())) return false;
    const found = await this.evaluateOn<{ count: number; point?: MinimaxPoint }>(
      target.role,
      firstPointExpression(target.spec),
    );
    if (found?.point) {
      await this.clickAt(target.role, found.point.x, found.point.y);
      return true;
    }
    return (await this.evaluateOn<boolean>(target.role, domClickExpression(target.spec))) === true;
  }

  /** 按可见文本/aria 精确点击；多命中/未命中都不点击，并回报可见候选用于诊断 */
  async clickExact(key: string, value: string): Promise<MinimaxClickExactResult> {
    const target = this.resolveKey(key);
    if (target.role === "menu" && !(await this.ensureMenu()))
      return { clicked: false, count: 0, available: [] };
    const found = await this.evaluateOn<{
      count: number;
      available: string[];
      point?: MinimaxPoint;
    }>(target.role, exactMatchExpression(target.spec, value));
    if (!found?.point)
      return { clicked: false, count: found?.count ?? 0, available: found?.available ?? [] };
    await this.clickAt(target.role, found.point.x, found.point.y);
    return { clicked: true, count: found.count, available: found.available };
  }

  /* ---------------- 主窗口：会话与项目 ---------------- */

  /**
   * 点「新建任务」。testid 挂在 `<kbd>` 上，真正可点击的是祖先 button——
   * 直接点 kbd 无效（实测），故用 newTaskPointExpression 取 button 中心。
   */
  async newTask(): Promise<boolean> {
    const found = await this.evaluate<{ count: number; point?: MinimaxPoint }>(
      newTaskPointExpression(this.selectors),
    );
    if (found?.point) {
      await this.clickAt("main", found.point.x, found.point.y);
      return true;
    }
    return false;
  }

  /** 在某个项目分组下新建任务（回退入口；多分组天然多命中，故用 clickFirst） */
  newTaskInProject(): Promise<boolean> {
    return this.clickFirst("sessionGroupNewTask");
  }

  /** 侧栏项目分组（`data-workspace-dir` = **完整绝对路径**，项目绑定的权威判据） */
  projectGroups(): Promise<MinimaxProjectGroup[]> {
    return this.evaluate<MinimaxProjectGroup[]>(projectGroupsExpression(this.selectors));
  }

  /** 侧栏会话条目（项目路径 + 会话标题） */
  sessionTitles(): Promise<{ dir: string; title: string }[]> {
    return this.evaluate<{ dir: string; title: string }[]>(sessionTitlesExpression(this.selectors));
  }

  /** 当前项目触发器文本（实测为项目名，如 `.appdata`） */
  projectTriggerText(): Promise<string> {
    return this.text("projectTrigger");
  }

  /** 按完整路径唯一点选项目分组（要求路径唯一命中） */
  async clickProjectByPath(target: string): Promise<{ clicked: boolean; count: number }> {
    const groups = await this.projectGroups();
    const wanted = normalizeProjectPath(target);
    const matched = groups.filter(
      (g) => g.dir && normalizeProjectPath(g.dir) === wanted,
    );
    if (matched.length !== 1) return { clicked: false, count: matched.length };
    // 分组是容器：点它的头部（第一个 [aria-label] 元素）才是切换项目的语义
    const point = await this.evaluate<MinimaxPoint | null>(
      projectPointExpression(wanted, this.selectors),
    );
    if (!point) return { clicked: false, count: 1 };
    await this.clickAt("main", point.x, point.y);
    return { clicked: true, count: 1 };
  }

  /**
   * 点「新建项目」→ 打开**应用内「创建项目」模态框**。
   *
   * **注意**：真机实测它**不直接**弹原生文件夹对话框——原生对话框要等模态框里
   * 再点「选择文件夹」才出现（见 project-modal.ts 的说明）。返回 true 只表示点击发出。
   */
  createProject(): Promise<boolean> {
    return this.click("createProject");
  }

  /** 应用内「创建项目」模态框是否已打开 */
  modalOpen(): Promise<boolean> {
    return this.evaluate<boolean>(modalOpenExpression());
  }

  /** 模态框全文（诊断：文件夹行是否已回填路径） */
  modalText(): Promise<string> {
    return this.evaluate<string>(modalProjectExpression());
  }

  /** 模态框里点「选择文件夹」（这一步才触发原生 Select Directory） */
  async clickModalChooseFolder(): Promise<boolean> {
    const point = await this.evaluate<MinimaxPoint | null>(modalChooseFolderPointExpression());
    if (!point) return false;
    await this.clickAt("main", point.x, point.y);
    return true;
  }

  /** 模态框里点「创建项目」提交（原生对话框回填后的最后一步） */
  async submitProjectModal(): Promise<boolean> {
    const point = await this.evaluate<MinimaxPoint | null>(modalSubmitPointExpression());
    if (!point) return false;
    await this.clickAt("main", point.x, point.y);
    return true;
  }

  /** 关闭模态框（Esc；失败收尾用：残留模态框会吞掉后续所有点击） */
  async dismissModal(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      if (!(await this.modalOpen().catch(() => false))) return;
      await this.pressEscape("main").catch(() => {});
      await this.pause(200);
    }
  }

  /* ---------------- 主窗口：输入与对话 ---------------- */

  inputText(): Promise<string> {
    return this.evaluate<string>(inputTextExpression(this.selectors));
  }

  async typeText(text: string): Promise<void> {
    const focused = await this.evaluate<boolean>(focusInputExpression(this.selectors));
    if (!focused) throw new Error("找不到 MiniMax Code 输入框");
    await this.send("Input.insertText", { text });
  }

  /** 发送按钮可见性与可用性（aria-disabled 双态） */
  sendState(): Promise<{ visible: boolean; disabled: boolean; count: number }> {
    return this.evaluate(sendStateExpression(this.selectors));
  }

  async sendMessage(): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (let attempt = 0; attempt < 50 && Date.now() < deadline; attempt++) {
      const point = await this.evaluate<MinimaxPoint | null>(
        sendButtonPointExpression(this.selectors),
      );
      if (point) {
        await this.clickAt("main", point.x, point.y);
        return;
      }
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
        ? "MiniMax Code 发送按钮在观察期内不可点击：MiniMax Code 窗口当前不在前台（页面被节流，合成点击不可靠）——请把 MiniMax Code 窗口置于前台后重试；未发送任务"
        : "MiniMax Code 发送按钮未在观察期内启用或被遮挡；未发送任务",
    );
  }

  conversationText(): Promise<string> {
    return this.evaluate<string>(conversationTextExpression(this.selectors));
  }

  /** 单次运行信号快照（一次 evaluate，见 dom.pollExpression 的说明） */
  poll(): Promise<MinimaxPoll> {
    return this.evaluate<MinimaxPoll>(pollExpression(this.selectors));
  }

  /* ---------------- 模型 / 推理等级 / 上下文窗口（弹层窗口 + 二级子菜单） ---------------- */

  /** 模型触发器文本（实测当前模型名，如 `M2.7-highspeed`；选定带子菜单的模型后为「模型\n档位」） */
  modelTriggerText(): Promise<string> {
    return this.text("modelTrigger");
  }

  /** 权限模式文本（实测「始终授权」） */
  permissionText(): Promise<string> {
    return this.text("permissionLabel");
  }

  /**
   * 打开模型弹层并确认候选已渲染。
   * 触发器是 toggle 语义：菜单已经开着时再点一次会把它关掉，所以每轮都先查后点；
   * 窗口被遮挡时节流会吞掉合成点击，故有界重试，不重置调用方给的截止时间。
   */
  async openModelMenu(deadlineMs = 5_000): Promise<boolean> {
    if (await this.menuReadyCheck()) return true;
    const deadline = Date.now() + deadlineMs;
    let lastClick = 0;
    while (Date.now() < deadline) {
      if (Date.now() - lastClick >= TRIGGER_RECLICK_MS) {
        await this.click("modelTrigger");
        lastClick = Date.now();
      }
      if (await this.menuReadyCheck()) return true;
      await this.pause(PANEL_POLL_MS);
    }
    return false;
  }

  /** 弹层是否已打开且渲染出模型候选 */
  async menuReadyCheck(): Promise<boolean> {
    if (!(await this.ensureMenu())) return false;
    try {
      return (
        (await this.evaluateOn<boolean>("menu", menuModelReadyExpression(this.selectors))) === true
      );
    } catch {
      return false;
    }
  }

  /** 模型候选（名称取 span.sr-only；带 hasPopup 标记以便判定能否读档位） */
  async menuModels(): Promise<MinimaxModelItem[]> {
    if (!(await this.ensureMenu())) return [];
    return this.evaluateOn<MinimaxModelItem[]>("menu", menuModelItemsExpression(this.selectors));
  }

  /**
   * 悬停某个模型项以展开二级子菜单，并等到组真正渲染出来。
   *
   * 悬停是**唯一**展开方式（实测 hover 会置 `aria-expanded="true"` 并渲染第二个 menu）；
   * 展开异步，故以 submenuOpen（组已渲染）为收敛判据，而不是盲等固定时长。
   */
  async hoverModel(name: string, deadlineMs = 8_000): Promise<boolean> {
    if (!(await this.ensureMenu())) return false;
    const found = await this.evaluateOn<{
      count: number;
      available?: string[];
      point?: MinimaxPoint;
    }>("menu", hoverPointExpression(name, this.selectors));
    if (!found?.point) return false;
    // **先移开再移入**：子菜单容器是复用的，直接移入上一个模型项的位置不会触发 mouseenter，
    // DOM 会保留**上一个悬停模型**的档位/窗口组——据此选档位会选到别的模型的档位集合（真机踩到）。
    await this.hoverAt("menu", 5, 5);
    await this.pause(220);
    await this.hoverAt("menu", found.point.x, found.point.y);
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      if (
        (await this.evaluateOn<boolean>(
          "menu",
          submenuOpenExpression(name),
        )) === true
      )
        return true;
      await this.pause(SUBMENU_POLL_MS);
    }
    return false;
  }

  /** 二级子菜单当前归属的模型名（子菜单未展开时为空串；诊断用） */
  async submenuOwner(): Promise<string> {
    if (!(await this.ensureMenu())) return "";
    return this.evaluateOn<string>("menu", submenuOwnerExpression());
  }

  /**
   * 推理等级候选（在**二级子菜单**里）。
   * `model` 是**必填**的归属约束：子菜单容器复用，不限定归属会读到上一个模型的档位集合。
   * 未展开/归属不符则返回空集——调用方据此 fail-closed（绝不按空集合猜）。
   */
  async effortOptions(model: string): Promise<MinimaxEffortOption[]> {
    if (!(await this.ensureMenu())) return [];
    return this.evaluateOn<MinimaxEffortOption[]>(
      "menu",
      effortOptionsExpression(model, this.selectors),
    );
  }

  /** 上下文窗口候选（在**二级子菜单**里；同样要求归属匹配） */
  async contextOptions(model: string): Promise<MinimaxContextOption[]> {
    if (!(await this.ensureMenu())) return [];
    return this.evaluateOn<MinimaxContextOption[]>(
      "menu",
      contextOptionsExpression(model, this.selectors),
    );
  }

  /** 在弹层里按坐标点击（子菜单候选项直接用坐标，因为它们是 button 且坐标唯一） */
  async clickMenuPoint(point: MinimaxPoint): Promise<void> {
    await this.clickAt("menu", point.x, point.y);
  }

  /** 关闭弹层（Esc；失败收尾用：残留弹层会吞掉后续键盘注入） */
  async dismissMenus(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      // 主窗口可能有自己的菜单（ant-dropdown）打开；弹层菜单用**内容判据**（窗口常驻 visible）。
      const open = await this.evaluate<number>(menuOpenCountExpression()).catch(() => 0);
      const menuOpen = await this.menuOpen().catch(() => false);
      if (!open && !menuOpen) return;
      // 弹层菜单优先关（它盖在主窗口之上）：Esc 只会作用于**聚焦**的窗口，
      // 所以先发给弹层，再处理主窗口的菜单。
      if (menuOpen) await this.pressEscape("menu").catch(() => {});
      if (open) await this.pressEscape("main").catch(() => {});
      await this.pause(80);
    }
  }

  /**
   * 弹层菜单是否打开（内容判据）。
   * 不用窗口 visibility —— 真机实测菜单关闭时 `Model menu` 窗口仍是 `visible`（见 dom.menuOpenExpression）。
   */
  async menuOpen(): Promise<boolean> {
    if (!(await this.ensureMenu())) return false;
    try {
      return (await this.evaluateOn<boolean>("menu", menuOpenExpression())) === true;
    } catch {
      return false;
    }
  }

  /* ---------------- 内部 ---------------- */

  private resolveKey(key: string): { role: MinimaxPageRole; spec: string } {
    if (key.startsWith(MENU_PREFIX)) {
      const name = key.slice(MENU_PREFIX.length);
      if (!(name in MM_MENU_SELECTORS))
        throw new Error(`未知的 MiniMax Code 弹层选择器键: ${key}`);
      return {
        role: "menu",
        spec: menuSpec(name as keyof typeof MM_MENU_SELECTORS, this.selectors),
      };
    }
    if (!(key in MM_MAIN_SELECTORS)) throw new Error(`未知的 MiniMax Code 选择器键: ${key}`);
    return { role: "main", spec: mainSpec(key as keyof typeof MM_MAIN_SELECTORS, this.selectors) };
  }

  private evaluateOn<T>(role: MinimaxPageRole, expression: string): Promise<T> {
    if (role === "main")
      return retryMinimaxEvaluation(() => this.pages.main.evaluate<T>(expression));
    return this.pages.menu.evaluate<T>(expression);
  }

  /**
   * 惰性连接弹层窗口。targetRank 只认 model-menu，但若端口上根本没有弹层页面，
   * CDP 会把主窗口交给它——所以连接后用页面 URL 二次确认，避免把主窗口当成弹层操作。
   */
  private async ensureMenu(): Promise<boolean> {
    if (this.menuReady) return true;
    const page = this.pages.menu;
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
    if (!/dist\/model-menu\//i.test(href)) {
      try {
        page.disconnect();
      } catch {
        /* 已断开 */
      }
      return false;
    }
    this.menuReady = true;
    return true;
  }

  /** trusted 鼠标点击（moved + pressed + released） */
  private async clickAt(role: MinimaxPageRole, x: number, y: number): Promise<void> {
    const page = role === "menu" ? this.pages.menu : this.pages.main;
    // 主窗口被遮挡/最小化时 Chromium 会节流页面，合成事件常被吞。
    // 派发前先确认前台，隐藏就先置前，避免把节流误诊成选择器失效。
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

  /**
   * trusted 悬停（只发 mouseMoved）。
   * **不按鼠标键**是刻意的：实测点击有子菜单的模型项会直接提交模型切换并关闭菜单，
   * 只有纯悬停才展开二级子菜单。
   */
  private async hoverAt(role: MinimaxPageRole, x: number, y: number): Promise<void> {
    const page = role === "menu" ? this.pages.menu : this.pages.main;
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  private pressEscape(role: MinimaxPageRole): Promise<void> {
    return this.pressKey(role, ESCAPE_KEY);
  }

  /** 键盘注入（keyDown + keyUp）：Electron 侧只认真实事件，不认 DOM 属性赋值 */
  private async pressKey(role: MinimaxPageRole, stroke: KeyStroke): Promise<void> {
    const page = role === "menu" ? this.pages.menu : this.pages.main;
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...stroke });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...stroke });
  }

  private pause(ms: number): Promise<void> {
    return this.evaluate(`new Promise(resolve=>setTimeout(resolve,${ms}))`);
  }
}
