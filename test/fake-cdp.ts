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
  /**
   * 发送后立刻追加的助手回复（同步、确定性）。
   * 用字段而非定时器：轮询间隔（pollIntervalMs）可能小到 1ms 且 stableRounds 很小，
   * 异步定时器会与「稳定兜底」抢跑，导致 CI 上偶发拿不到回复（实测 Windows Node 22 flake）。
   */
  autoReplyText?: string;
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
    // 模式分段查找（切换用）
    if (expression.includes("mode-switcher-btn") && expression.includes("getBoundingClientRect")) {
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
    // 模式分段（x=300）
    if (x === 300) {
      this.state.mode = "Work";
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
