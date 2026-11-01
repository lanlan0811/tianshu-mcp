/**
 * GUI CDP 传输底座：所有 GUI adapter 共享的页面级传输与通用输入原语。
 *
 * 与任何具体产品无关——WebSocket 连接、`send` 超时、`CdpDisconnectedError` /
 * `CdpUnavailableError` 断线语义、`listTargets` / `probe` 就绪探测、坐标点击与按键、
 * 以及不依赖选择器表的可见标签诊断都在这里。
 * 语义键（`SelectorKey`）相关的 DOM 操作属于各适配器自己的层，不进本文件——
 * 这样任何产品的选择器表被删除都不会波及共享传输。
 *
 * 连接方式：目标应用以 `--remote-debugging-port=<port>` 启动后，从 `/json` 取页面 WS 地址。
 * 本文件只依赖 Node 内置能力（http + 全局 WebSocket）。
 */
import { get as httpGet } from "node:http";
import { visibleLabelsExpr, normalizeLabels } from "../gui-diagnostics.js";

/** Node 22+ 全局 WebSocket 的最小接口（规避各版本 ambient 类型差异） */
interface CdpWebSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

interface CdpPageTarget {
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl: string;
}

export interface CdpClientOptions {
  port: number;
  /** 页面查找超时（ms） */
  connectTimeoutMs?: number;
  /** 单次 CDP 命令等待响应的超时（ms） */
  sendTimeoutMs?: number;
  /**
   * 多个 page target 时的排序偏好（返回值越小越优先）。
   * 缺省取列表首个 page。Codex 等应用会额外暴露 avatar-overlay 等次级窗口，
   * 需借此收敛到主应用窗口。
   */
  targetRank?: (t: CdpPageTarget) => number;
  /**
   * 错误文案里出现的应用名。本类被多个 GUI 适配器复用，
   * 若硬编码单一名字，「连不上」提示会把用户引到**错误的程序**去排查。
   * 缺省 `TraeWork` 仅为向后兼容；新调用方应显式传入自己的应用名。
   */
  appLabel?: string;
}

/** 通用存活探针的信号位（语义中性：可见 / 不可见）。 */
export interface LivenessProbe {
  stopVisible: boolean;
  tailLoading: boolean;
  thinkingStream: boolean;
}

/** `probeSignals()` 的输入：每条信号各自的候选选择器（按顺序尝试）。 */
export interface LivenessCandidates {
  stopButton: string[];
  tailLoading: string[];
  thinkingStream: string[];
}

export class CdpUnavailableError extends Error {
  constructor(msg: string) {
    super(`CDP_UNAVAILABLE: ${msg}`);
    this.name = "CdpUnavailableError";
  }
}

export class CdpDisconnectedError extends CdpUnavailableError {
  constructor(msg: string) {
    super(`连接已断开: ${msg}`);
    this.name = "CdpDisconnectedError";
  }
}

/** 通用 GUI 页面 CDP 客户端（连接 / 命令 / 求值 / 输入原语） */
export class GuiCdpClient {
  readonly port: number;
  private ws: CdpWebSocket | null = null;
  private isAlive = false;
  private msgId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly opts: CdpClientOptions) {
    this.port = opts.port;
  }

  /** 错误文案用的应用名（见 `CdpClientOptions.appLabel` 的复用说明） */
  private appLabel(): string {
    return this.opts.appLabel ?? "TraeWork";
  }

  get connected(): boolean {
    return this.ws !== null && this.isAlive;
  }

  get alive(): boolean {
    return this.isAlive;
  }

  /** 读取 CDP 页面目标列表（用于就绪探测与诊断） */
  static listTargets(port: number, timeoutMs = 3_000): Promise<CdpPageTarget[]> {
    return new Promise((resolve, reject) => {
      const req = httpGet({ host: "127.0.0.1", port, path: "/json", timeout: timeoutMs }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const list = JSON.parse(body) as CdpPageTarget[];
            resolve(Array.isArray(list) ? list : []);
          } catch (e) {
            reject(new CdpUnavailableError(`/json 响应无法解析: ${(e as Error).message}`));
          }
        });
      });
      req.on("timeout", () => {
        req.destroy();
        reject(new CdpUnavailableError(`连接 127.0.0.1:${port} 超时`));
      });
      req.on("error", (e) => reject(new CdpUnavailableError(`${(e as Error).message}`)));
    });
  }

  /** 端口上是否存在页面目标（就绪探测用） */
  static async probe(port: number, timeoutMs = 3_000): Promise<{ ready: boolean; title?: string; url?: string }> {
    try {
      const targets = await GuiCdpClient.listTargets(port, timeoutMs);
      const page = targets.find((t) => t.type === "page");
      if (!page) return { ready: false };
      return { ready: true, title: page.title, url: page.url };
    } catch {
      return { ready: false };
    }
  }

  /** 从目标列表按偏好选出要连接的 page（缺省取首个） */
  private pickTarget(targets: CdpPageTarget[]): CdpPageTarget | undefined {
    const pages = targets.filter((t) => t.type === "page");
    if (!pages.length) return undefined;
    if (!this.opts.targetRank) return pages[0];
    return [...pages].sort((a, b) => this.opts.targetRank!(a) - this.opts.targetRank!(b))[0];
  }

  /** 连接页面（取第一个 type=page 目标） */
  async connect(): Promise<void> {
    let targets: CdpPageTarget[];
    try {
      targets = await GuiCdpClient.listTargets(this.port, this.opts.connectTimeoutMs ?? 10_000);
    } catch (e) {
      throw new CdpUnavailableError(
        `无法连接端口 ${this.port}（请确认 ${this.appLabel()} 以 --remote-debugging-port=${this.port} 启动且窗口可见）：${(e as Error).message}`,
      );
    }
    const page = this.pickTarget(targets);
    if (!page) {
      throw new CdpUnavailableError(`端口 ${this.port} 上没有页面目标（TraeWork 可能仍在启动中）`);
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl) as unknown as CdpWebSocket;
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      // 失败分支自清理：close 半成品 socket 并清 this.ws，不依赖调用方兜底 disconnect。
      let settled = false;
      const cleanup = (): void => {
        if (this.ws === ws) this.ws = null;
        try {
          ws.close();
        } catch {
          /* 已断开 */
        }
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new CdpUnavailableError("CDP WebSocket 连接超时"));
      }, this.opts.connectTimeoutMs ?? 10_000);
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.isAlive = true;
        resolve();
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(new CdpUnavailableError("CDP WebSocket 连接失败"));
      };
    });
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { id?: number; error?: unknown; result?: unknown };
        if (msg.id && this.pending.has(msg.id)) {
          const pending = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
          else pending.resolve(msg.result);
        }
      } catch {
        // 非法/无关事件不应击穿客户端；对应请求仍由 send 超时收敛。
      }
    };
    ws.onclose = () => this.markDisconnected("WebSocket 已关闭");
    ws.onerror = () => this.markDisconnected("WebSocket 错误");
    await this.send("Runtime.enable");
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.isAlive) {
        reject(new CdpDisconnectedError("CDP 未连接或已关闭"));
        return;
      }
      const id = ++this.msgId;
      const timeoutMs = this.opts.sendTimeoutMs ?? 15_000;
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new CdpUnavailableError(`命令 ${method} 等待响应超时（${timeoutMs}ms）`));
      }, timeoutMs);
      // 不让挂起的响应超时定时器拖住进程退出（脚本性调用断连即走）。
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new CdpDisconnectedError(`命令 ${method} 发送失败：${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  private markDisconnected(reason: string): void {
    if (!this.isAlive && this.pending.size === 0) {
      this.ws = null;
      return;
    }
    this.isAlive = false;
    this.ws = null;
    const error = new CdpDisconnectedError(reason);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  /** 页面内执行表达式并取回值（异常返回 undefined，由调用方决定处理） */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = (await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as {
      exceptionDetails?: {
        text?: string;
        lineNumber?: number;
        columnNumber?: number;
        exception?: { description?: string; value?: unknown };
      };
      result?: { value?: unknown };
    };
    if (r.exceptionDetails) {
      const detail =
        r.exceptionDetails.exception?.description ??
        (r.exceptionDetails.exception?.value === undefined
          ? undefined
          : String(r.exceptionDetails.exception.value)) ??
        r.exceptionDetails.text ??
        "unknown";
      const location =
        r.exceptionDetails.lineNumber === undefined
          ? ""
          : `（${r.exceptionDetails.lineNumber + 1}:${(r.exceptionDetails.columnNumber ?? 0) + 1}）`;
      throw new Error(`页面执行错误${location}: ${detail}`);
    }
    return r.result?.value as T;
  }

  async evaluateString(expression: string): Promise<string> {
    return (await this.evaluate<string>(expression)) || "";
  }

  /**
   * 收集页面可见候选标签（issue #23 诊断机制）。选择器解析失败时用于定位漂移；
   * 永不抛错——失败返回空数组，不影响主流程。
   */
  async visibleLabels(scopeCss?: string): Promise<string[]> {
    try {
      return normalizeLabels(await this.evaluate<unknown>(visibleLabelsExpr({ scope: scopeCss })));
    } catch {
      return [];
    }
  }

  /**
   * 单次页面求值探测所有活跃信号，避免三次 CDP 往返产生观测竞态。
   *
   * 候选选择器由调用方注入（见 `LivenessCandidates`）：方法本身不含任何产品语义，
   * 只回答「这几组 CSS 里有没有可见元素」。与各适配器自带 poll 表达式同一取舍——
   * 权威运行信号必须是**单次求值**，分次读取会产生观测竞态。
   */
  async probeSignals(candidates: LivenessCandidates): Promise<LivenessProbe> {
    const visible = (list: string[] | undefined): string =>
      `visible(${JSON.stringify(Array.isArray(list) ? list : [])})`;
    const expr = `(function(){const visible=(cs)=>{for(const c of cs){const e=document.querySelector(c);if(e){const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return true}}return false};return {stopVisible:${visible(candidates.stopButton)},tailLoading:${visible(candidates.tailLoading)},thinkingStream:${visible(candidates.thinkingStream)}}})()`;
    const value = await this.evaluate<Partial<LivenessProbe>>(expr);
    return {
      stopVisible: value?.stopVisible === true,
      tailLoading: value?.tailLoading === true,
      thinkingStream: value?.thinkingStream === true,
    };
  }

  /* ---------------- 输入 ---------------- */

  /** 鼠标左键点击（坐标） */
  async clickAt(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  /** 插入文本（走真实输入管线，contenteditable 友好） */
  async insertText(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  /** 按键（Enter/Escape 等） */
  async pressKey(key: string, code: string, vk: number, type: "rawKeyDown" | "keyDown" = "keyDown"): Promise<void> {
    await this.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  }

  async pressEnter(): Promise<void> {
    await this.pressKey("Enter", "Enter", 13, "rawKeyDown");
  }

  async pressEscape(): Promise<void> {
    await this.pressKey("Escape", "Escape", 27);
  }

  disconnect(): void {
    const ws = this.ws;
    if (!ws && !this.isAlive && this.pending.size === 0) return;
    this.markDisconnected("客户端主动断开");
    try {
      ws?.close();
    } catch {
      /* 已断开 */
    }
  }
}
