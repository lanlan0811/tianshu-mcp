/**
 * 假 CDP 客户端：内存 DOM 桩，供集成测试驱动真实 runTraeworkTask 逻辑（不依赖真机）。
 *
 * 只实现 run/ui 层用到的方法：connect / exists / text / center / click / focus /
 * insertText / pressEnter / pressEscape / clickAt / evaluate / evaluateString / disconnect。
 *
 * 行为：维护一个简单的「页面状态」——输入框文本、消息容器文本、项目下拉项；
 * 通过 advance() 模拟 TraeWork 生成回复（逐步写入消息容器）。
 */

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
}

export function makeKimicodeFakeState(over: Partial<FakeKimicodeState> = {}): FakeKimicodeState {
  return {
    url: "app://renderer/",
    draft: true,
    draftBlocked: false,
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
    ...over,
  };
}

/** 主窗口与浮层窗口两个 target 的桩 */
export class FakeKimicodePage {
  readonly connected = true;
  readonly alive = true;
  constructor(
    readonly url: string,
    private readonly state: FakeKimicodeState,
  ) {}

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
      this.state.inputText += String(params.text ?? "");
      return undefined;
    }
    if (method === "Input.dispatchKeyEvent") {
      if (params.type === "keyDown" && params.key === "Escape") {
        this.state.panelOpen = false;
        this.state.overlayVisible = false;
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
    if (expression.includes("kc:focus-input")) return true;
    if (expression.includes("kc:send-point")) return s.sendEnabled ? { x: 400, y: 400 } : null;
    if (expression.includes("kc:conversation")) return s.conversation;
    if (expression.includes("kc:exact")) return { count: 0, available: [] };
    if (expression.includes("kc:dom-click")) {
      s.clicks.push("dom-click");
      return false;
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
    if (expression.includes("button.send")) return "sendButton";
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
        return { x: 300, y: 300 };
      case "messageArea":
        return { x: 350, y: 350 };
      case "sessionItem":
        return s.sessions.length ? { x: 200, y: 200 } : null;
      case "overlayMenuRow":
        return s.menuDomPresent ? { x: 500, y: 500 } : null;
      default:
        return null;
    }
  }

  private applyClick(x: number, y: number): void {
    const s = this.state;
    if (x === 10) {
      s.clicks.push("new-session");
      // 复刻 M22 教训：点击返回 true 并不等于已切页——被阻塞时不建立草稿。
      if (s.draftBlocked) return;
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
    }
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
  const main = new FakeKimicodePage(states.main.url, states.main);
  const overlay = new FakeKimicodePage(states.overlay.url, states.overlay);
  return {
    main,
    overlay,
    states,
    createClient: (role) => (role === "overlay" ? overlay : main),
  };
}
