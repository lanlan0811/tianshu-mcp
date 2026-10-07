/**
 * 假 CDP 客户端：内存 DOM 桩，供集成测试驱动真实 runTraeworkTask 逻辑（不依赖真机）。
 *
 * 只实现 run/ui 层用到的方法：connect / exists / text / center / click / focus /
 * insertText / pressEnter / pressEscape / clickAt / evaluate / evaluateString / disconnect。
 *
 * 行为：维护一个简单的「页面状态」——输入框文本、消息容器文本、项目下拉项；
 * 通过 advance() 模拟 TraeWork 生成回复（逐步写入消息容器）。
 */

import {
  cssCandidates,
  OPEN_DESIGN_LAYOUT_GUARD_KEYS,
  OPEN_DESIGN_SELECTORS,
  type OpenDesignSelectorKey,
} from "../src/agents/opendesign/selectors.js";

export interface FakeDomState {
  /** 输入框当前文本 */
  inputText: string;
  /** 消息容器全文 */
  messages: string;
  /** 是否已新建会话 */
  sessionStarted: boolean;
  /** 已绑定的项目（null = 未绑定） */
  boundProject: string | null;
  /** 下拉中的项目项 */
  projectItems: Array<{ name: string; subtitle: string }>;
  /** 当前模型 */
  model: string;
  /** 下拉可用模型 */
  models: string[];
  /** 是否发送过消息 */
  sent: boolean;
  /** 记录所有点击过的语义键 */
  clicked: string[];
  /** 原生对话框是否被调用 */
  nativeDialogCalls: number;
  /** 当前展开的下拉类型（用于坐标点击归属） */
  openDropdown: "project" | "model" | null;
  /** 当前面板模式（Work/Code/Design） */
  mode: string;
  /** ensureMode 查找表达式解析出的待切换模式（clickAt 时应用） */
  pendingMode: "Work" | "Code" | "Design" | null;
  /**
   * 发送后立刻追加的助手回复（同步、确定性）。
   * 用字段而非定时器：轮询间隔（pollIntervalMs）可能小到 1ms 且 stableRounds 很小，
   * 异步定时器会与「稳定兜底」抢跑，导致 CI 上偶发拿不到回复（实测 Windows Node 22 flake）。
   */
  autoReplyText?: string;
  /** 运行状态探针；stop/tail 是权威信号，thinking 仅诊断 */
  liveness: { stopVisible: boolean; tailLoading: boolean; thinkingStream: boolean };
  livenessSequence?: Array<{ stopVisible: boolean; tailLoading: boolean; thinkingStream: boolean }>;
  /** 探针调用时可注入的错误（模拟 CDP 断开） */
  livenessError?: Error;
  /**
   * 下拉底部「选择文件夹」按钮：哪一级点击才真正唤起原生对话框（issue #38）。
   *
   * 真机事实（#35 实测）：`element.click()` 会「返回 true 却不唤起原生弹窗」（间歇），
   * 而 CDP 真实鼠标事件（`Input.dispatchMouseEvent`，等价 `clickAt`）稳定弹出。
   * - `"coordinate"`：坐标点击（clickAt）成功、DOM click 失败 —— 核心回归场景
   * - `"dom"`：DOM 语义键 click 成功
   * - `"text"`：只有文本兜底 click 成功
   * - `"never"`：三级全失败（默认，保持既有用例行为）
   */
  footerDialogOpensOn: "coordinate" | "dom" | "text" | "never";
  /** 原生对话框当前是否已打开（footer 按上面的方式点击后被置位） */
  folderDialogOpen: boolean;
}

export function makeFakeState(over: Partial<FakeDomState> = {}): FakeDomState {
  return {
    inputText: "",
    messages: "",
    sessionStarted: false,
    boundProject: null,
    projectItems: [],
    model: "Auto Mode",
    models: ["GLM-5.3", "DeepSeek-V4-Flash"],
    sent: false,
    clicked: [],
    nativeDialogCalls: 0,
    openDropdown: null,
    mode: "Work",
    pendingMode: null,
    liveness: { stopVisible: false, tailLoading: false, thinkingStream: false },
    footerDialogOpensOn: "never",
    folderDialogOpen: false,
    ...over,
  };
}

/** 与 TraeworkCdpClient 结构兼容的最小假实现 */
export class FakeCdpClient {
  readonly port: number;
  constructor(
    port: number,
    private readonly state: FakeDomState,
  ) {
    this.port = port;
  }

  get connected(): boolean {
    return true;
  }

  get alive(): boolean {
    return true;
  }

  async connect(): Promise<void> {
    /* no-op */
  }

  disconnect(): void {
    /* no-op */
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    return this.evaluateString(expression) as unknown as T;
  }

  async evaluateString(expression: string): Promise<string> {
    // 已绑定项目读取（inputBarButton 文本集合）
    if (expression.includes("inputBarButton")) {
      const arr = this.state.boundProject ? ["本地", this.state.boundProject] : ["本地"];
      return JSON.stringify(arr);
    }
    // 模式读取
    if (expression.includes("mode-switcher-btn") && expression.includes("tabActive")) {
      return this.state.mode;
    }
    // 模式分段查找（切换用）：从表达式中解析请求的模式名，记录待应用
    if (expression.includes("mode-switcher-btn") && expression.includes("getBoundingClientRect")) {
      const m = expression.match(/===\s*"(Work|Code|Design)"/);
      this.state.pendingMode = (m?.[1] as FakeDomState["pendingMode"]) ?? null;
      return JSON.stringify({ x: 300, y: 300 });
    }
    // 项目下拉项读取
    if (expression.includes("cascadeMenuItem")) {
      return JSON.stringify(this.state.projectItems.map((i, idx) => ({ ...i, x: 100, y: 100 + idx * 30 })));
    }
    if (expression.includes("model-select-model-item")) {
      // scrollIntoView 表达式：无返回
      if (expression.includes("scrollIntoView")) return "";
      // 坐标查找表达式：按目标文本返回单个 {x,y}
      const m = expression.match(/t\s*===\s*"([^"]*)"/);
      if (m && expression.includes("getBoundingClientRect")) {
        const idx = this.state.models.indexOf(m[1]!);
        if (idx >= 0) return JSON.stringify({ x: 100, y: 100 + idx * 30 });
        return "";
      }
      // 收集全部选项
      return JSON.stringify(this.state.models.map((t, idx) => ({ text: t, restricted: false, x: 100, y: 100 + idx * 30 })));
    }
    return "";
  }

  async exists(key: string): Promise<boolean> {
    if (key === "cascadeMenu") return this.state.openDropdown === "project" && this.state.projectItems.length > 0;
    if (key === "messageContainer") return this.state.messages.length > 0;
    if (key === "chatInput") return true;
    if (key === "projectButton") return true;
    if (key === "newTask") return true;
    return false;
  }

  async text(key: string): Promise<string> {
    switch (key) {
      case "chatInput":
        return this.state.inputText;
      case "messageContainer":
        return this.state.messages;
      case "projectButton":
        return this.state.boundProject ? this.state.boundProject : "选择文件夹（可选）";
      case "modelTriggerValue":
        return this.state.model;
      default:
        return "";
    }
  }

  async probeLiveness(): Promise<FakeDomState["liveness"]> {
    if (this.state.livenessError) throw this.state.livenessError;
    const next = this.state.livenessSequence?.shift();
    if (next) this.state.liveness = next;
    return { ...this.state.liveness };
  }

  async center(key: string): Promise<{ x: number; y: number } | null> {
    if (key === "projectButton") return { x: 100, y: 100 };
    if (key === "modelTrigger") return { x: 200, y: 200 };
    if (key === "newTask") return { x: 50, y: 50 };
    // 下拉底部「选择文件夹」：坐标 (400,400)（issue #38 的坐标点击优先路径）
    if (key === "cascadeMenuFooter") return { x: 400, y: 400 };
    return null;
  }

  async click(key: string): Promise<boolean> {
    this.state.clicked.push(key);
    if (key === "newTask") {
      this.state.sessionStarted = true;
      this.state.messages = "";
      return true;
    }
    if (key === "projectButton") {
      this.state.openDropdown = "project";
      return true;
    }
    // 语义键 DOM click 命中 footer：只有配置为 "dom" 时才真正唤起原生对话框。
    // 其余情况**返回 true 但不置位** —— 这正是 #35 记录的「点击返回成功却无副作用」。
    if (key === "cascadeMenuFooter") {
      if (this.state.footerDialogOpensOn === "dom") this.state.folderDialogOpen = true;
      return true;
    }
    return true;
  }

  async focus(): Promise<boolean> {
    return true;
  }

  async insertText(text: string): Promise<void> {
    this.state.inputText += text;
  }

  async pressEnter(): Promise<void> {
    // 发送：把输入内容作为用户消息写入消息容器
    this.state.sent = true;
    this.state.messages = `${this.state.inputText}`;
    this.state.inputText = "";
    // 同步追加助手回复（确定性，避免定时器与稳定兜底抢跑）
    if (this.state.autoReplyText) {
      this.state.messages = `${this.state.messages}TraeWork${this.state.autoReplyText}由AI生成12:30`;
    }
  }

  async pressEscape(): Promise<void> {
    this.state.openDropdown = null;
  }

  async clickAt(x: number, y: number): Promise<void> {
    this.state.clicked.push(`at(${x},${y})`);
    // 模式分段（x=300）：应用 pendingMode（由 ensureMode 的查找表达式记录），
    // 不再硬编码 "Work"——否则请求 Code/Design 会被误判为「切换后验证不一致」。
    if (x === 300) {
      this.state.mode = this.state.pendingMode ?? "Work";
      this.state.pendingMode = null;
      return;
    }
    // 模型触发器（x=200）
    if (x === 200) {
      this.state.openDropdown = "model";
      return;
    }
    // 下拉底部「选择文件夹」（x=400，issue #38）：坐标点击＝真实鼠标事件。
    // 只有配置为 "coordinate" 时才唤起原生对话框；其余配置下**点击发生但无副作用**
    // —— 用于验证「阶梯必须按副作用升级，而不是按点击返回值判定」。
    if (x === 400) {
      if (this.state.footerDialogOpensOn === "coordinate") this.state.folderDialogOpen = true;
      return;
    }
    // 项目下拉项（y = 100 + idx*30）
    if (x === 100) {
      const idx = Math.round((y - 100) / 30);
      if (this.state.openDropdown === "project" && idx >= 0 && idx < this.state.projectItems.length) {
        this.state.boundProject = this.state.projectItems[idx]!.name;
      } else if (this.state.openDropdown === "model" && idx >= 0 && idx < this.state.models.length) {
        this.state.model = this.state.models[idx]!;
      }
    }
  }

  /** 测试驱动：模拟 TraeWork 生成回复 */
  appendAssistant(text: string, opts: { complete?: boolean; thinking?: boolean } = {}): void {
    const mark = opts.complete ? "由AI生成12:30" : opts.thinking ? "思考中" : "";
    this.state.messages = `${this.state.messages}TraeWork${text}${mark}`;
  }
}

/** 从输入框文本中提取标记（供测试断言） */
export function extractMarker(text: string): string {
  const m = text.match(/【ts[a-z0-9]+】/);
  return m ? m[0] : "";
}

/* ============================ Kimi Code 场景 ============================ */

/**
 * Kimi Code 页面桩：内存状态 + 按表达式标记分发。
 *
 * 与真机的对齐点：
 * - **双渲染进程**：主窗口 `app://renderer/`（草稿页 / `app://renderer/sessions/<id>`）承载侧栏、
 *   会话、composer；`app://renderer/browser-overlay.html` 是浮层（模型/档位/执行模式菜单）。
 *   两个 page 桩按 url 区分，工作区面板只在**主窗口**，菜单开/关只看**浮层可见性**。
 * - 工作区面板 `div.ws-panel` 只在草稿页且面板打开时可见；`button.ws-chip` 只在草稿页挂载
 *   （发送后消失），所以「新建会话点击成功」必须靠 ws-chip 出现来确认。
 * - `div.se[data-session-id]` 提供会话 id，主窗口 URL 也带会话 id。
 *
 * 分发依据是 dom.ts 表达式里的 `kc:*` 标记 + spec 里的 CSS 片段（选择器变了这里会一起暴露），
 * 不做任何真实网络/系统调用。
 */
export interface FakeKimicodeState {
  /** 页面 URL：草稿页、会话页或浮层页 */
  url: string;
  /** 草稿页是否建立：ws-chip / 工作区面板只在草稿页存在 */
  draft: boolean;
  /** 点「新建会话」也建立不了草稿（复刻「点击返回 true 却不切页」） */
  draftBlocked: boolean;
  /**
   * 前 N 次「新建会话」点击被吞（复刻真机：Chromium 节流吞掉合成事件，
   * 单次点击毫无反应）。用于验证有界重试能自愈。
   */
  draftSwallowCount: number;
  /** 回退入口「在此工作区新建会话」也建立不了草稿 */
  addSessionBlocked: boolean;
  /** 工作区面板是否打开 */
  panelOpen: boolean;
  /** 工作区条目（面板内顺序即 DOM 顺序） */
  workspaces: Array<{ name: string; path: string; active: boolean }>;
  /** 侧栏会话项 */
  sessions: Array<{ id: string; title?: string }>;
  /** 当前会话 id（URL 与侧栏选中项的独立来源） */
  currentSessionId?: string;
  /** 输入框文本 */
  inputText: string;
  /** 对话正文 */
  conversation: string;
  /** 发送按钮是否可用 */
  sendEnabled: boolean;
  /** 主窗口是否被隐藏（页面节流） */
  pageHidden: boolean;
  /** 浮层是否可见（菜单开关的权威判据） */
  overlayVisible: boolean;
  /** 浮层 DOM 是否残留（关闭后可能短暂存在，不能当判据） */
  menuDomPresent: boolean;
  /** 点击记录（语义标签，供断言「走了哪条路径」） */
  clicks: string[];
  /** 原生「选择文件夹…」调用次数 */
  chooseFolderClicks: number;

  /* ---- M3：composer / 模型档位 / 执行模式 / 运行信号 ---- */
  /** composer 未挂载（复刻停在登录/引导页） */
  composerMissing: boolean;
  /** 模型+档位触发器全文（如 `K3 · High`） */
  modelPill: string;
  /** 执行模式触发器文本 */
  permissionPill: string;
  /** 浮层模型候选（模型/档位/执行模式的当前值都落在主窗口状态里，浮层经 link 读取） */
  modelOptions: string[];
  /** 当前模型（`.is-active` 项） */
  currentModel: string;
  /** 浮层思考档位标签集合（**界面实际渲染**：官方 Low/High/Max、非官方 On/Off） */
  tiers: string[];
  /** 当前档位（`.is-on` 项） */
  currentTier: string;
  /** 执行模式候选 */
  permissionOptions: string[];
  /** 当前执行模式 */
  currentPermission: string;
  /** 权威运行信号：`button.stop` 是否可见 */
  stopVisible: boolean;
  /** 次权威运行信号：`button.send` class 含 `is-starting` */
  sendStarting: boolean;
  /** 失败态：`button.ui-button--secondary`（「继续」）是否可见 */
  retryVisible: boolean;
  /** panes 内的失败文案 */
  errorText: string;
  /** 用户消息复制按钮（`button.u-copy`）是否可见 */
  userCopyVisible: boolean;
  /** M4：`gui.selectors.userGate` 命中的「等待用户」界面是否可见 */
  userGateVisible: boolean;
  /**
   * M4：点 `button.stop` 后运行信号是否真的消失。
   * false（默认）复刻「点击被吞/停止未生效」——停止按钮仍可见，用于验证取消文案如实说明。
   */
  stopStopsOnClick: boolean;
  /** 发送按钮被点击的次数（断言「绝不重发」） */
  sendClicks: number;
  /** 点击发送被吞：不产生任何确认证据（会话 id / 消息落地 / 输入框清空 / 运行信号全无） */
  sendSwallowed: boolean;
  /** 发送后新会话 id（写入 URL，复刻「会话 id 从 URL 取得」） */
  newSessionId: string;
  /**
   * 发送后的运行状态脚本：每次 kc:poll 消费一条（仅在发送点击生效后才开始消费）。
   * 用脚本而不是定时器：轮询间隔可能小到 1ms，异步定时器会与判定抢跑（CI 上会 flake）。
   */
  pollScript?: Array<Partial<FakeKimicodeState>>;

  /* ---- 模型「更多模型…」二级入口（overlay 隐藏 + 主窗口「切换模型」对话框） ---- */
  /** overlay 模型菜单里是否渲染出「更多模型…」入口 */
  moreModelsAvailable: boolean;
  /** 「切换模型」对话框是否可见 */
  modelDialogVisible: boolean;
  /** 对话框搜索框当前输入（搜索只做过滤，不参与身份判定） */
  modelDialogQuery: string;
  /** 对话框全量候选目录 */
  modelDialogModels: string[];
  /**
   * 搜索框的过滤面：`name` = 对完整模型名做包含匹配（默认，按实测行为）；
   * `provider` = 只索引 `/` 前半段（模拟「更严格的过滤」），用于验证「完整名 0 命中 → 退化为
   * provider 搜索一次」这条兜底分支确实被执行。
   */
  modelDialogFilterBy: "name" | "provider";
  /** 对话框里的当前模型（`.is-current`；空则回落到 currentModel） */
  modelDialogCurrent: string;
  /** 模型 → 选中后界面的档位集合（复刻「切到非官方模型后档位变成 On/Off」） */
  modelDialogTiers?: Record<string, string[]>;
  /** 点击候选行后界面不更新（复刻「点了但没生效」→ 回读不一致） */
  dialogClickNoop: boolean;
  /** 对话框搜索框是否已聚焦（Input.insertText 的落点） */
  searchFocused: boolean;
}

export function makeKimicodeFakeState(over: Partial<FakeKimicodeState> = {}): FakeKimicodeState {
  return {
    url: "app://renderer/",
    draft: true,
    draftBlocked: false,
    draftSwallowCount: 0,
    addSessionBlocked: false,
    panelOpen: false,
    workspaces: [],
    sessions: [],
    inputText: "",
    conversation: "",
    sendEnabled: true,
    pageHidden: false,
    overlayVisible: false,
    menuDomPresent: false,
    clicks: [],
    chooseFolderClicks: 0,
    composerMissing: false,
    modelPill: "K3 · High",
    permissionPill: "完全自动",
    modelOptions: ["K3", "K3-256k"],
    currentModel: "K3",
    tiers: ["Low", "High", "Max"],
    currentTier: "High",
    permissionOptions: ["始终询问", "必要时询问", "完全自动"],
    currentPermission: "完全自动",
    stopVisible: false,
    sendStarting: false,
    retryVisible: false,
    errorText: "",
    userCopyVisible: false,
    userGateVisible: false,
    stopStopsOnClick: false,
    sendClicks: 0,
    sendSwallowed: false,
    newSessionId: "s-new",
    moreModelsAvailable: true,
    modelDialogVisible: false,
    modelDialogQuery: "",
    modelDialogModels: ["K3", "K2.8 Preview", "K3-256k"],
    modelDialogFilterBy: "name",
    modelDialogCurrent: "",
    dialogClickNoop: false,
    searchFocused: false,
    ...over,
  };
}

/** 归一化（与真机页面内 kcNorm 同义）：NFKC + 折叠空白 + 大小写不敏感 */
function kcNorm(value: string): string {
  return (value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/**
 * 模型触发器文本。真机实测：官方模型后缀是档位名（`K3 · High`），
 * 非官方模型（档位只有 On/Off）后缀是「思考」（`stepfun/… · 思考`）。
 */
function pillText(model: string, state: FakeKimicodeState): string {
  const onoff = state.tiers.includes("On") && state.tiers.includes("Off");
  return onoff ? `${model} · 思考` : `${model} · ${state.currentTier}`;
}

/** 浮层里待应用的选中动作：`kc:exact` 解析出坐标，鼠标事件按下时才真正生效 */
interface FakeOverlayPending {
  kind: "model" | "tier" | "permission" | "more-models";
  label: string;
}

/** 主窗口与浮层窗口两个 target 的桩 */
export class FakeKimicodePage {
  readonly connected = true;
  readonly alive = true;
  private pendingOverlay: FakeOverlayPending | null = null;
  /** `kc:model-dialog-row-point` 解析出的待点击候选行（坐标点击落下时才应用） */
  private pendingDialogRow: string | null = null;
  constructor(
    readonly url: string,
    private readonly state: FakeKimicodeState,
    /**
     * 对侧页面状态：主窗口页 → 浮层状态（点触发器开菜单 / 收菜单）；
     * 浮层页 → 主窗口状态（模型、档位、执行模式的当前值都落在主窗口）。
     */
    private readonly link?: FakeKimicodeState,
  ) {}

  private get isOverlay(): boolean {
    return /browser-overlay/.test(this.url);
  }

  async connect(): Promise<void> {
    /* no-op */
  }
  disconnect(): void {
    /* no-op */
  }
  async evaluate<T = unknown>(expression: string): Promise<T> {
    return (await this.resolve(expression)) as T;
  }
  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (method === "Input.insertText") {
      // 对话框搜索框聚焦时，真实输入落在搜索框；否则落在 composer。
      if (this.state.searchFocused && this.state.modelDialogVisible)
        this.state.modelDialogQuery += String(params.text ?? "");
      else this.state.inputText += String(params.text ?? "");
      return undefined;
    }
    if (method === "Input.dispatchKeyEvent") {
      if (params.type === "keyDown" && params.key === "Escape") {
        this.state.panelOpen = false;
        this.state.overlayVisible = false;
        // Esc 同样关闭「切换模型」对话框（closeModelDialog 的收尾路径）。
        this.state.modelDialogVisible = false;
        this.state.searchFocused = false;
      }
      // 搜索框里 Ctrl+A 清空 / Backspace 退格（clearModelDialogSearch 走的就是这两条）
      if (params.type === "keyDown" && this.state.searchFocused && this.state.modelDialogVisible) {
        if (params.key === "a" && (Number(params.modifiers) & 2) === 2)
          this.state.modelDialogQuery = "";
        else if (params.key === "Backspace")
          this.state.modelDialogQuery = this.state.modelDialogQuery.slice(0, -1);
      }
      return undefined;
    }
    // 只认 mousePressed，避免 moved/pressed/released 三次重复应用同一效果
    if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
      this.applyClick(Number(params.x), Number(params.y));
    }
    return undefined;
  }

  /** 表达式分发：标记优先，其次是 spec 里的 CSS 片段 */
  private async resolve(expression: string): Promise<unknown> {
    const s = this.state;
    if (expression === "location.href") return s.url;
    if (expression.includes("new Promise")) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return undefined;
    }
    if (expression.includes("kc:overlay-visible")) return s.overlayVisible;
    if (expression.includes("kc:page-hidden")) return s.pageHidden;
    if (expression.includes("kc:menu-count")) return s.panelOpen ? 1 : 0;
    if (expression.includes("kc:workspace-panel-open")) return s.draft && s.panelOpen;
    if (expression.includes("kc:workspace-chip-text")) return this.activeWorkspace()?.name ?? "";
    if (expression.includes("kc:workspace-items")) {
      return s.draft && s.panelOpen
        ? s.workspaces.map((item) => ({ name: item.name, path: item.path, active: item.active }))
        : [];
    }
    if (expression.includes("kc:workspace-row-point")) {
      const index = Number(/const index = (\d+);/.exec(expression)?.[1] ?? -1);
      if (!s.draft || !s.panelOpen || index < 0 || index >= s.workspaces.length) return null;
      return { x: 100, y: 100 + index * 20 };
    }
    if (expression.includes("kc:sessions")) {
      return s.sessions.map((item) => ({ id: item.id, title: item.title }));
    }
    if (expression.includes("kc:current-session")) {
      const matched = /\/sessions\/([^/?#]+)/.exec(s.url);
      if (matched) return { id: matched[1], source: "url" };
      if (s.currentSessionId) return { id: s.currentSessionId, source: "dom" };
      return { id: "", source: "none" };
    }
    if (expression.includes("kc:select-session")) {
      const id = JSON.parse(/const byId = (".*?");/.exec(expression)?.[1] ?? '""') as string;
      const index = id ? s.sessions.findIndex((item) => item.id === id) : -1;
      return index >= 0 ? { count: 1, point: { x: 200, y: 200 + index * 20 } } : { count: 0 };
    }
    if (expression.includes("kc:input-text")) return s.inputText;
    if (expression.includes("kc:focus-input")) return !s.composerMissing;
    if (expression.includes("kc:send-point")) return s.sendEnabled ? { x: 400, y: 400 } : null;
    if (expression.includes("kc:conversation")) return s.conversation;
    if (expression.includes("kc:poll")) {
      // 发送生效后才消费脚本：发送前的基线 poll 不能吃掉第一帧运行状态。
      if (s.pollScript?.length && s.sendClicks > 0 && !s.sendSwallowed)
        Object.assign(s, s.pollScript.shift());
      return {
        stopVisible: s.stopVisible,
        sendStarting: s.sendStarting,
        assistantText: s.conversation,
        errorText: s.errorText,
        retryVisible: s.retryVisible,
        userGateVisible: s.userGateVisible,
        inputText: s.inputText,
        sendEnabled: s.sendEnabled,
        pageHidden: s.pageHidden,
      };
    }
    if (expression.includes("kc:overlay-items")) {
      const m = this.link ?? s;
      if (expression.includes("ui-seg__item"))
        return m.tiers.map((label) => ({ label, current: kcNorm(label) === kcNorm(m.currentTier) }));
      if (expression.includes("完全自动"))
        return m.permissionOptions.map((label) => ({
          label,
          current: kcNorm(label) === kcNorm(m.currentPermission),
        }));
      return m.modelOptions.map((label) => ({
        label,
        current: kcNorm(label) === kcNorm(m.currentModel),
      }));
    }
    if (expression.includes("kc:model-dialog-open"))
      // 只有「对话框可见 + 有候选行」才算就绪（与真机判据一致）。
      return s.modelDialogVisible && this.dialogRows().length > 0;
    if (expression.includes("kc:model-dialog-focus")) {
      if (!s.modelDialogVisible) return false;
      s.searchFocused = true;
      return true;
    }
    if (expression.includes("kc:model-dialog-search-text")) return s.modelDialogQuery;
    if (expression.includes("kc:model-dialog-items")) {
      const current = s.modelDialogCurrent || s.currentModel;
      return this.dialogRows().map((name) => ({
        name,
        current: kcNorm(name) === kcNorm(current),
      }));
    }
    if (expression.includes("kc:model-dialog-row-point")) {
      const raw = /const target = kcNorm\((.*?)\);/.exec(expression)?.[1] ?? '""';
      const wanted = JSON.parse(raw) as string;
      const rows = this.dialogRows();
      const matches = rows.filter((row) => kcNorm(row) === kcNorm(wanted));
      if (matches.length !== 1) return { count: matches.length, available: rows };
      this.pendingDialogRow = matches[0]!;
      return { count: 1, available: rows, point: { x: 740, y: 740 } };
    }
    if (expression.includes("kc:exact")) {
      if (!this.isOverlay) return { count: 0, available: [] };
      const raw = /const target = kcNorm\((.*?)\);/.exec(expression)?.[1] ?? '""';
      const value = JSON.parse(raw) as string;
      const m = this.link ?? s;
      // 「更多模型…」入口的 spec 里带 texts（中英变体）→ 按这就可与模型项区分开。
      if (expression.includes("更多模型")) {
        const available = m.moreModelsAvailable ? ["更多模型…"] : [];
        if (!m.moreModelsAvailable) return { count: 0, available };
        this.pendingOverlay = { kind: "more-models", label: "更多模型…" };
        return { count: 1, available, point: { x: 700, y: 700 } };
      }
      const kind: FakeOverlayPending["kind"] = expression.includes("ui-seg__item")
        ? "tier"
        : expression.includes("完全自动")
          ? "permission"
          : "model";
      const labels =
        kind === "tier" ? m.tiers : kind === "permission" ? m.permissionOptions : m.modelOptions;
      const available = [...labels];
      const index = labels.findIndex((label) => kcNorm(label) === kcNorm(value));
      if (index < 0) return { count: 0, available };
      this.pendingOverlay = { kind, label: labels[index]! };
      return { count: 1, available, point: { x: 700, y: 700 } };
    }
    if (expression.includes("kc:dom-click")) {
      s.clicks.push("dom-click");
      return false;
    }
    // 注意顺序：kc:first-point 不包含子串 "kc:point"，但显式先判更清晰（多命中取首个坐标）。
    if (expression.includes("kc:first-point")) {
      const point = this.pointOf(expression);
      return point ? { count: 1, point } : { count: 0 };
    }
    if (expression.includes("kc:point")) {
      const point = this.pointOf(expression);
      return point ? { count: 1, point } : { count: 0 };
    }
    if (expression.includes("kc:exists")) return this.pointOf(expression) !== null;
    if (expression.includes("kc:text")) {
      const key = this.keyOf(expression);
      if (key === "chatInput") return s.inputText;
      if (key === "messageArea") return s.conversation;
      if (key === "modelPill") return s.modelPill;
      if (key === "permissionPill") return s.permissionPill;
      if (key === "workspaceChip" || key === "workspaceChipName")
        return this.activeWorkspace()?.name ?? "";
      return "";
    }
    return "";
  }

  /** spec 里的 CSS 片段 → 语义键（选择器漂移时这里会一起失败，避免桩「假装还能用」） */
  private keyOf(expression: string): string {
    if (expression.includes("ws-chip-name")) return "workspaceChipName";
    if (expression.includes("ws-chip")) return "workspaceChip";
    if (expression.includes("ws-action")) return "chooseFolder";
    if (expression.includes("ws-row")) return "workspaceRow";
    if (expression.includes("ws-panel")) return "workspacePanel";
    if (expression.includes("btn-new-chat")) return "newSession";
    if (expression.includes("gh-add")) return "workspaceAddSession";
    if (expression.includes("ProseMirror")) return "chatInput";
    if (expression.includes("model-pill")) return "modelPill";
    if (expression.includes("perm-pill")) return "permissionPill";
    if (expression.includes("button.stop")) return "stopButton";
    if (expression.includes("button.send")) return "sendButton";
    if (expression.includes("ui-button--secondary")) return "errorRetryButton";
    if (expression.includes("u-copy")) return "userCopyButton";
    if (expression.includes("a-cpbtn")) return "assistantCopyButton";
    if (expression.includes("ui-seg__item")) return "overlayTier";
    if (expression.includes("div.panes")) return "messageArea";
    if (expression.includes("data-session-id")) return "sessionItem";
    if (expression.includes("overlay-menu-row")) return "overlayMenuRow";
    return "";
  }

  private pointOf(expression: string): { x: number; y: number } | null {
    const s = this.state;
    switch (this.keyOf(expression)) {
      case "newSession":
        return { x: 10, y: 10 };
      case "workspaceChip":
      case "workspaceChipName":
        return s.draft ? { x: 20, y: 20 } : null;
      case "workspaceAddSession":
        return { x: 15, y: 15 };
      case "workspacePanel":
        return s.draft && s.panelOpen ? { x: 110, y: 110 } : null;
      case "chooseFolder":
        return s.draft && s.panelOpen ? { x: 30, y: 30 } : null;
      case "workspaceRow":
        return s.draft && s.panelOpen && s.workspaces.length
          ? { x: 100, y: 100 }
          : null;
      case "sendButton":
        return s.sendEnabled ? { x: 400, y: 400 } : null;
      case "chatInput":
        return s.composerMissing ? null : { x: 300, y: 300 };
      case "messageArea":
        return { x: 350, y: 350 };
      case "sessionItem":
        return s.sessions.length ? { x: 200, y: 200 } : null;
      case "overlayMenuRow":
        return s.menuDomPresent ? { x: 500, y: 500 } : null;
      case "modelPill":
        return { x: 520, y: 520 };
      case "permissionPill":
        return { x: 540, y: 540 };
      case "stopButton":
        return s.stopVisible ? { x: 560, y: 560 } : null;
      case "errorRetryButton":
        return s.retryVisible ? { x: 580, y: 580 } : null;
      case "userCopyButton":
        return s.userCopyVisible ? { x: 600, y: 600 } : null;
      case "assistantCopyButton":
        return { x: 620, y: 620 };
      default:
        return null;
    }
  }

  private applyClick(x: number, y: number): void {
    const s = this.state;
    if (x === 700 && this.isOverlay) {
      const pending = this.pendingOverlay;
      this.pendingOverlay = null;
      const main = this.link;
      if (!pending || !main) return;
      // 「更多模型…」：实测 overlay 立刻 hidden 并清空，同时主窗口弹出「切换模型」对话框。
      if (pending.kind === "more-models") {
        main.modelDialogVisible = true;
        main.modelDialogQuery = "";
        main.searchFocused = false;
        s.overlayVisible = false;
        s.clicks.push("overlay-more-models");
        return;
      }
      // 模型/档位/执行模式的当前值都落在主窗口：真机里触发器文本就是这样更新的。
      if (pending.kind === "model") {
        main.currentModel = pending.label;
        main.modelPill = pillText(pending.label, main);
      } else if (pending.kind === "tier") {
        main.currentTier = pending.label;
        main.modelPill = pillText(main.currentModel, main);
      } else {
        main.currentPermission = pending.label;
        main.permissionPill = pending.label;
      }
      s.clicks.push(`overlay-${pending.kind}:${pending.label}`);
      return;
    }
    if (x === 740) {
      // 对话框候选行：实测点击后对话框自动关闭，button.model-pill 文本随之更新。
      const row = this.pendingDialogRow;
      this.pendingDialogRow = null;
      if (!row) return;
      s.clicks.push(`dialog-model:${row}`);
      s.modelDialogVisible = false;
      s.searchFocused = false;
      // 「点了但界面没生效」：不更新触发器，用于验证回读拦截。
      if (s.dialogClickNoop) return;
      s.currentModel = row;
      const tiers = s.modelDialogTiers?.[row];
      if (tiers) {
        s.tiers = [...tiers];
        s.currentTier = tiers[0]!;
      }
      s.modelPill = pillText(row, s);
      return;
    }
    if (x === 10) {
      s.clicks.push("new-session");
      // 复刻 M22 教训：点击返回 true 并不等于已切页——被阻塞时不建立草稿。
      if (s.draftBlocked) return;
      // 复刻真机：合成点击被 Chromium 节流吞掉时，前几次点击不产生任何效果。
      if (s.draftSwallowCount > 0) {
        s.draftSwallowCount -= 1;
        return;
      }
      s.draft = true;
      s.panelOpen = false;
      s.url = "app://renderer/";
      return;
    }
    if (x === 15) {
      s.clicks.push("workspace-add-session");
      if (s.addSessionBlocked) return;
      s.draft = true;
      s.panelOpen = false;
      s.url = "app://renderer/";
      return;
    }
    if (x === 20) {
      s.clicks.push("workspace-chip");
      // 面板是 toggle：已开着再点会收起
      if (s.draft) s.panelOpen = !s.panelOpen;
      return;
    }
    if (x === 30) {
      s.clicks.push("choose-folder");
      s.chooseFolderClicks++;
      return;
    }
    if (x === 100) {
      const index = Math.round((y - 100) / 20);
      s.clicks.push(`workspace-row:${index}`);
      if (!s.draft || !s.panelOpen || index < 0 || index >= s.workspaces.length) return;
      s.workspaces.forEach((item, i) => (item.active = i === index));
      s.panelOpen = false;
      s.url = "app://renderer/";
      return;
    }
    if (x === 200) {
      const index = Math.round((y - 200) / 20);
      s.clicks.push(`session:${index}`);
      const item = s.sessions[index];
      if (!item) return;
      s.currentSessionId = item.id;
      s.url = `app://renderer/sessions/${item.id}`;
      return;
    }
    if (x === 400) {
      // 发送：真机上「用户消息落地 + 输入框清空 + 会话 URL 变化 + 停止按钮出现」同现。
      s.clicks.push("send");
      s.sendClicks++;
      if (s.sendSwallowed) return;
      s.conversation = `${s.conversation}${s.inputText}`;
      s.inputText = "";
      s.userCopyVisible = true;
      s.stopVisible = true;
      s.sendStarting = true;
      s.url = `app://renderer/sessions/${s.newSessionId}`;
      return;
    }
    if (x === 520) {
      s.clicks.push("model-pill");
      // 触发器是 toggle，但菜单渲染在浮层窗口：这里只把浮层置为可见。
      if (this.link) this.link.overlayVisible = true;
      return;
    }
    if (x === 540) {
      s.clicks.push("permission-pill");
      if (this.link) this.link.overlayVisible = true;
      return;
    }
    if (x === 560) {
      // M4：停止按钮（trusted 坐标点击）。stopStopsOnClick=false 复刻「点击未生效」——
      // 运行信号仍在，取消/重派护栏必须据此如实落文案（不得谎报已停止）。
      s.clicks.push("stop-button");
      if (s.stopStopsOnClick) {
        s.stopVisible = false;
        s.sendStarting = false;
      }
      return;
    }
  }

  /** 对话框当前可见的候选行：搜索框只做「包含」过滤，身份判定由点击方按全等做 */
  private dialogRows(): string[] {
    const s = this.state;
    const query = kcNorm(s.modelDialogQuery);
    if (!query) return [...s.modelDialogModels];
    const BY_PROVIDER = s.modelDialogFilterBy === "provider";
    return s.modelDialogModels.filter((name) => {
      const haystack = BY_PROVIDER
        ? kcNorm(name.includes("/") ? name.slice(0, name.indexOf("/")) : name)
        : kcNorm(name);
      return haystack.includes(query);
    });
  }

  private activeWorkspace(): { name: string; path: string; active: boolean } | undefined {
    return this.state.workspaces.find((item) => item.active);
  }
}

export interface FakeKimicodeTargets {
  main: FakeKimicodePage;
  overlay: FakeKimicodePage;
  states: { main: FakeKimicodeState; overlay: FakeKimicodeState };
  /** 传给 KimicodeCdpClient 的 createClient（按角色返回对应 target 的桩） */
  createClient: (role: "main" | "overlay") => FakeKimicodePage;
}

/** 两个 target（主窗口 + 浮层）的桩集合：按 URL 区分，正如真机上的两个渲染进程 */
export function makeKimicodeTargets(
  mainOverrides: Partial<FakeKimicodeState> = {},
  overlayOverrides: Partial<FakeKimicodeState> = {},
): FakeKimicodeTargets {
  const states = {
    main: makeKimicodeFakeState({ url: "app://renderer/", ...mainOverrides }),
    overlay: makeKimicodeFakeState({
      url: "app://renderer/browser-overlay.html",
      overlayVisible: false,
      ...overlayOverrides,
    }),
  };
  // 交叉持有对侧状态：主窗口的触发器点击要打开浮层，浮层的选中结果要写回主窗口的触发器文本。
  const main = new FakeKimicodePage(states.main.url, states.main, states.overlay);
  const overlay = new FakeKimicodePage(states.overlay.url, states.overlay, states.main);
  return {
    main,
    overlay,
    states,
    createClient: (role) => (role === "overlay" ? overlay : main),
  };
}

/* ============================ Open Design 场景 ============================ */

/**
 * Open Design 页面桩：内存状态 + 按 `od:*` 标记分发。
 *
 * 与真机的对齐点（都是 `selectors.ts` 里取证得到的真实钩子）：
 * - 单页应用：首页 hero（工作目录 / 模型 / 设计系统 / 设计方向触发器 + 输入框 + 提交按钮）；
 *   提交后进入会话页（`chat-log` 出现、`chat-send` / 停止按钮出现）。
 * - 菜单/面板都是**同一文档内的浮层**，用「可见性」开关表达；选中项按**归一化后的全等文本**判定，
 *   与页面内 `__opendesignResolve` 的判据一致（绝不模糊匹配）。
 * - 停止按钮与发送按钮互斥出现；`chat-send` 的 `aria-busy`/`disabled` 表达「受理中」。
 *
 * 表达式语义键由**注册表自身**推导（`cssCandidates` 的 primary 与表达式文本匹配），
 * 因此选择器漂移时这里会一起暴露，而不是「桩假装还能用」。
 */
export interface FakeOpenDesignState {
  /** 是否在首页 hero（提交后进入会话页） */
  onHome: boolean;
  /** 输入框文本 */
  inputText: string;
  /** 会话正文（chat-log） */
  conversation: string;
  /** 已绑定的工作目录（触发器文本；null = 未绑定） */
  workingDir: string | null;
  /** 工作目录面板是否展开 */
  workDirPanelOpen: boolean;
  /** 原生「选择文件夹」对话框被点了几次 */
  nativeDialogCalls: number;
  /** 当前模型（触发器文本；null = 未指定） */
  model: string | null;
  /** 模型菜单是否展开 */
  modelMenuOpen: boolean;
  /** 可选模型 */
  models: string[];
  /** 当前设计系统 */
  designSystem: string | null;
  /** 设计系统面板是否展开 */
  dsMenuOpen: boolean;
  /** 设计系统搜索框当前输入 */
  dsSearch: string;
  /** 可选设计系统 */
  designSystems: string[];
  /** 当前设计方向 */
  direction: string | null;
  /** 设计方向菜单是否展开 */
  directionMenuOpen: boolean;
  /** 可选设计方向（含产品策略不允许的项，用于验证 fail-closed） */
  directions: string[];
  /** 权威运行信号 */
  stopVisible: boolean;
  /** 受理中（chat-send 不可用） */
  sendStarting: boolean;
  /** 发送按钮被点击次数（断言「绝不重发」） */
  sendClicks: number;
  /** 发送被吞：不产生任何确认证据 */
  sendSwallowed: boolean;
  /** 页面是否被隐藏（节流） */
  pageHidden: boolean;
  /** 点击记录（语义标签） */
  clicks: string[];
  /** 额外声明「多命中」的语义键（复刻 UI 渲染出重复控件的情形） */
  duplicatedKeys?: string[];
  /** 发送后消耗的运行状态脚本（用脚本而非定时器，避免与轮询抢跑） */
  pollScript?: Array<Partial<FakeOpenDesignState>>;
  /** 原生对话框路径（dialog 桩用它回写工作目录） */
  nativeDialogPath?: string;
  /** 原生对话框失败（fail-closed 路径） */
  nativeDialogFails?: boolean;
  /** 首页入口也不可见（复刻「页面完全漂移、连切回首页都做不到」） */
  noHomeEntry?: boolean;
  /** 会话容器缺失（复刻「当前不在会话页」，用于验证返修轮 fail-closed） */
  conversationMissing?: boolean;
  /** 指定语义键不可见（复刻局部锚点漂移，用于验证布局守卫） */
  missingAnchors?: string[];
}

export function makeOpenDesignFakeState(
  over: Partial<FakeOpenDesignState> = {},
): FakeOpenDesignState {
  return {
    onHome: true,
    inputText: "",
    conversation: "",
    workingDir: null,
    workDirPanelOpen: false,
    nativeDialogCalls: 0,
    model: "deepseek-v4.1-flash",
    modelMenuOpen: false,
    models: ["deepseek-v4.1-flash", "deepseek-v4-pro", "claude-fable-5"],
    designSystem: null,
    dsMenuOpen: false,
    dsSearch: "",
    designSystems: ["Claude (Anthropic)", "Linear", "Vercel"],
    direction: null,
    directionMenuOpen: false,
    directions: ["原型", "文档", "网站复刻", "幻灯片"],
    stopVisible: false,
    sendStarting: false,
    sendClicks: 0,
    sendSwallowed: false,
    pageHidden: false,
    clicks: [],
    ...over,
  };
}

/** 每个语义键的固定坐标（与真机无关，只用于让「坐标点击」可被桩解释） */
const OD_POINTS: Record<string, { x: number; y: number }> = {
  title: { x: 10, y: 10 },
  composer: { x: 20, y: 20 },
  inputBox: { x: 30, y: 30 },
  workingDirTrigger: { x: 40, y: 40 },
  selectDirItem: { x: 50, y: 50 },
  workingDirValue: { x: 41, y: 41 },
  modelTrigger: { x: 60, y: 60 },
  modelMenuItem: { x: 70, y: 70 },
  designSystemTrigger: { x: 80, y: 80 },
  designSystemSearch: { x: 90, y: 90 },
  designSystemItem: { x: 100, y: 100 },
  designDirectionTrigger: { x: 110, y: 110 },
  designDirectionItem: { x: 120, y: 120 },
  sendButton: { x: 130, y: 130 },
  stopButton: { x: 140, y: 140 },
  conversationText: { x: 150, y: 150 },
};

/** 菜单项索引 → y（与 `OD_POINTS` 的基数错开，避免与「触发器」坐标混淆） */
function odItemY(base: number, index: number): number {
  return base + 200 + index * 10;
}
function odItemIndex(base: number, y: number): number {
  return Math.round((y - (base + 200)) / 10);
}

/** 归一化（与页面内 odNorm 同义）：NFKC + 折叠空白 + 大小写不敏感 */
function odNorm(value: string | undefined | null): string {
  return (value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
/** 三个菜单项语义键共用同一 CSS（`role="option"`，产品里同一时刻只开一个 listbox）。
 *  桩按「当前展开的是哪个菜单」把它收敛到具体键——这正是真机的并集语义。 */
const OD_OPTION_KEYS = new Set(["modelMenuItem", "designSystemItem", "designDirectionItem"]);

function odKeyOf(expression: string): string {
  // 只看**标记之后**的部分：`resolveFnSource()` 的公共扫描列表里硬编码了
  // `[role="option"]` 等候选，若整段比对，任何表达式都会先命中 `modelMenuItem`
  // （真机上没这问题——那里的 spec 是结构化参数，不是字符串搜索）。
  const marker = /\/\*od:[a-z-]+\*\//.exec(expression);
  const body = marker ? expression.slice(marker.index) : expression;
  // 表达式里的 spec 是 JSON 字符串，内层引号被转义；比对前先还原
  const flat = body.replace(/\\"/g, '"');
  // 取**出现位置最靠前**的候选：spec 是 [primary, ...fallbacks]，所以被测键的 primary 必然
  // 排在最前；若改成「注册表顺序优先」，`inputBox` 的 fallback 里含 `composer` 的 primary
  // 就会把它误判成 composer（真机上 spec 是结构化参数，不存在这个歧义）。
  let best: { index: number; key: string } | null = null;
  for (const [css, key] of OD_KEY_BY_CSS) {
    const index = flat.indexOf(css);
    if (index < 0) continue;
    if (!best || index < best.index) best = { index, key };
  }
  if (!best) return "";
  return OD_OPTION_KEYS.has(best.key) ? "menuItem" : best.key;
}

const OD_KEY_BY_CSS: Array<[string, string]> = (
  Object.keys(OPEN_DESIGN_SELECTORS) as OpenDesignSelectorKey[]
).map((key) => [cssCandidates(OPEN_DESIGN_SELECTORS[key])[0] ?? "", key as string]);

/** 页面级 Open Design 桩 */
export class FakeOpenDesignPage {
  readonly connected = true;
  readonly alive = true;
  constructor(private readonly state: FakeOpenDesignState) {}

  async connect(): Promise<void> {
    /* no-op */
  }
  disconnect(): void {
    /* no-op */
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    return (await this.resolve(expression)) as T;
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (method === "Page.bringToFront" || method === "Runtime.enable") return undefined;
    if (method === "Input.insertText") {
      const text = String(params.text ?? "");
      if (this.state.dsMenuOpen) this.state.dsSearch += text;
      else this.state.inputText += text;
      return undefined;
    }
    if (method === "Input.dispatchKeyEvent") {
      if (String(params.key) === "Escape") {
        this.state.modelMenuOpen = false;
        this.state.dsMenuOpen = false;
        this.state.directionMenuOpen = false;
        this.state.workDirPanelOpen = false;
      }
      if (this.state.dsMenuOpen && String(params.key) === "a" && (Number(params.modifiers) & 2) === 2)
        this.state.dsSearch = "";
      if (this.state.dsMenuOpen && String(params.key) === "Delete") this.state.dsSearch = "";
      return undefined;
    }
    // 只认 mousePressed，避免 moved/pressed/released 三次重复应用同一效果
    if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed")
      this.applyClick(Number(params.x), Number(params.y));
    return undefined;
  }

  private s(): FakeOpenDesignState {
    return this.state;
  }

  /** 当前展开的菜单（产品里同一时刻最多一个 listbox 处于展开态） */
  private activeMenu(): "model" | "ds" | "direction" | "" {
    const s = this.s();
    if (s.directionMenuOpen) return "direction";
    if (s.dsMenuOpen) return "ds";
    if (s.modelMenuOpen) return "model";
    return "";
  }

  /** 把「菜单项」这类共用 CSS 的键收敛成当前展开菜单对应的具体键 */
  private concreteKey(key: string): string {
    if (key !== "menuItem") return key;
    const menu = this.activeMenu();
    return menu === "direction"
      ? "designDirectionItem"
      : menu === "ds"
        ? "designSystemItem"
        : menu === "model"
          ? "modelMenuItem"
          : key;
  }

  private visible(key: string): boolean {
    const s = this.s();
    if (s.missingAnchors?.includes(key)) return false;
    if (s.duplicatedKeys?.includes(key)) return true;
    // 「菜单项」是按当前展开的菜单收敛的（`odKeyOf` 已把三个共用 CSS 的键折成 menuItem）
    if (key === "menuItem") return this.activeMenu() !== "";
    switch (key) {
      case "title":
      case "composer":
        return s.onHome;
      // 输入框在首页与会话页都存在（会话页是 chat-composer 内的编辑器），
      // 只有显式声明 missingAnchors 时才缺席。
      case "inputBox":
        return true;
      case "workingDirTrigger":
      case "workingDirValue":
      case "modelTrigger":
      case "designSystemTrigger":
      case "designDirectionTrigger":
        return s.onHome;
      // 发送按钮两种形态都存在（首页 home-hero-submit / 会话页 chat-send）
      case "sendButton":
        return true;
      case "selectDirItem":
        return s.onHome && s.workDirPanelOpen;
      case "modelMenuItem":
        return s.onHome && s.modelMenuOpen;
      case "designSystemItem":
      case "designSystemSearch":
        return s.onHome && s.dsMenuOpen;
      case "designDirectionItem":
        return s.onHome && s.directionMenuOpen;
      case "stopButton":
        return s.stopVisible || s.sendStarting;
      case "conversationText":
        return !s.conversationMissing;
      default:
        return false;
    }
  }

  private textOf(key: string): string {
    const s = this.s();
    switch (key) {
      case "title":
        return s.onHome ? "Open Design" : "";
      case "workingDirTrigger":
      case "workingDirValue":
        return s.workingDir ?? "选择工作目录";
      case "modelTrigger":
        return s.model ?? "";
      case "designSystemTrigger":
        return s.designSystem ?? "";
      case "designDirectionTrigger":
        return s.direction ?? "创建类型";
      case "conversationText":
        return s.conversation;
      case "inputBox":
        return s.inputText;
      case "sendButton":
        return "发送";
      default:
        return "";
    }
  }

  /** 计数：多命中声明只对触发器/菜单项生效（复刻 UI 渲染重复控件） */
  private countOf(key: string): number {
    if (!this.visible(key)) return 0;
    return this.s().duplicatedKeys?.includes(key) ? 2 : 1;
  }

  /** 菜单项候选（按语义键；设计系统受搜索框过滤） */
  private itemsOf(rawKey: string): string[] {
    const s = this.s();
    const key = this.concreteKey(rawKey);
    if (key === "modelMenuItem") return s.models;
    if (key === "designDirectionItem") return s.directions;
    // 「选择目录」是工作目录面板里的唯一项（真机上文本随绑定状态变化，这里用产品默认文案）
    if (key === "selectDirItem") return ["选择目录"];
    if (key === "designSystemItem") {
      const q = odNorm(s.dsSearch);
      return q ? s.designSystems.filter((n) => odNorm(n).includes(q)) : s.designSystems;
    }
    return [];
  }

  private pointOf(rawKey: string): { x: number; y: number } | null {
    if (!this.visible(rawKey)) return null;
    const base = OD_POINTS[this.concreteKey(rawKey)];
    return base ? { x: base.x, y: base.y } : null;
  }

  private async resolve(expression: string): Promise<unknown> {
    const s = this.s();
    if (expression.includes("od:poll")) {
      if (s.pollScript?.length && s.sendClicks > 0 && !s.sendSwallowed)
        Object.assign(s, s.pollScript.shift());
      return {
        stopVisible: s.stopVisible,
        sendStarting: s.sendStarting,
        conversationText: s.conversation,
        inputText: s.inputText,
        pageHidden: s.pageHidden,
      };
    }
    if (expression.includes("od:layout-probe")) {
      // 桩按**状态**计算守卫锚点命中数；返回结构与真机 layoutProbeExpression 一致。
      const anchors = OPEN_DESIGN_LAYOUT_GUARD_KEYS.map((key) => ({
        key,
        count: this.countOf(key),
      }));
      return {
        url: "od://app/",
        title: "Open Design",
        anchors,
        bodyTextLength: (s.conversation || s.direction || "Open Design").length,
        bodyText: s.conversation || "Open Design 首页",
      };
    }
    if (expression.includes("od:exists")) return this.countOf(odKeyOf(expression)) > 0;
    if (expression.includes("od:count")) return this.countOf(odKeyOf(expression));
    if (expression.includes("od:text") || expression.includes("od:trigger-text"))
      return this.textOf(odKeyOf(expression));
    if (expression.includes("od:input-value"))
      return { found: this.countOf("inputBox"), value: s.inputText, length: s.inputText.length };
    if (expression.includes("od:conversation-text")) return s.conversation;
    if (expression.includes("od:labels")) return this.itemsOf(odKeyOf(expression));
    if (expression.includes("od:dismiss")) {
      const openBefore = this.countOf("modelMenuItem");
      this.state.modelMenuOpen = false;
      this.state.dsMenuOpen = false;
      this.state.directionMenuOpen = false;
      this.state.workDirPanelOpen = false;
      return { openBefore };
    }
    if (expression.includes("od:exact-point")) {
      const key = odKeyOf(expression) || (expression.includes("working-dir-pick") ? "selectDirItem" : "");
      const target = JSON.parse(
        /odNorm\(("(?:[^"\\]|\\.)*")\)/.exec(expression)?.[1] ?? '""',
      ) as string;
      const available = this.itemsOf(key);
      const matches = available.filter((label) => odNorm(label) === odNorm(target));
      if (matches.length !== 1) return { count: matches.length, available };
      const index = available.indexOf(matches[0]!);
      const base = OD_POINTS[this.concreteKey(key)];
      if (!base) return { count: 0, available };
      return { count: 1, available, point: { x: base.x, y: odItemY(base.y, index) } };
    }
    if (expression.includes("od:first-point") || expression.includes("od:point")) {
      const key = odKeyOf(expression);
      if (this.s().duplicatedKeys?.includes(key)) return { count: 2 };
      const point = this.pointOf(key);
      return point ? { count: 1, point } : { count: 0 };
    }
    if (expression.includes("od:raw-point")) {
      // 首页入口：仅在**不在首页**时可见（复刻「从会话页切回首页」）
      if (s.noHomeEntry) return { count: 0 };
      return s.onHome ? { count: 0 } : { count: 1, point: { x: 5, y: 5 } };
    }
    return "";
  }

  private applyClick(x: number, y: number): void {
    const s = this.s();
    if (x === 5) {
      // 首页入口
      s.clicks.push("home-entry");
      s.onHome = true;
      return;
    }
    if (x === 40) {
      s.clicks.push("working-dir-trigger");
      s.workDirPanelOpen = !s.workDirPanelOpen;
      return;
    }
    if (x === 50) {
      s.clicks.push("select-dir-item");
      s.nativeDialogCalls += 1;
      return;
    }
    if (x === 60) {
      s.clicks.push("model-trigger");
      s.modelMenuOpen = !s.modelMenuOpen;
      return;
    }
    if (x === 70) {
      const index = odItemIndex(70, y);
      s.clicks.push(`model-item:${index}`);
      const picked = s.models[index];
      if (picked) s.model = picked;
      s.modelMenuOpen = false;
      return;
    }
    if (x === 80) {
      s.clicks.push("ds-trigger");
      s.dsMenuOpen = !s.dsMenuOpen;
      return;
    }
    if (x === 100) {
      const index = odItemIndex(100, y);
      const available = this.itemsOf("designSystemItem");
      s.clicks.push(`ds-item:${index}`);
      const picked = available[index];
      if (picked) s.designSystem = picked;
      s.dsMenuOpen = false;
      s.dsSearch = "";
      return;
    }
    if (x === 110) {
      s.clicks.push("direction-trigger");
      s.directionMenuOpen = !s.directionMenuOpen;
      return;
    }
    if (x === 120) {
      const index = odItemIndex(120, y);
      s.clicks.push(`direction-item:${index}`);
      const picked = s.directions[index];
      if (picked) s.direction = picked;
      s.directionMenuOpen = false;
      return;
    }
    if (x === 130) {
      // 发送：真机上「用户消息落地 + 输入框清空 + 进入会话页 + 运行信号出现」同现
      s.clicks.push("send");
      s.sendClicks += 1;
      if (s.sendSwallowed) return;
      s.conversation = `${s.conversation}\n${s.inputText}`;
      s.inputText = "";
      s.onHome = false;
      s.stopVisible = true;
      s.sendStarting = true;
      return;
    }
    if (x === 140) {
      s.clicks.push("stop-button");
      s.stopVisible = false;
      s.sendStarting = false;
      return;
    }
  }
}
