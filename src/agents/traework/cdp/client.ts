/**
 * CDP 客户端：通过 Chrome DevTools Protocol 连接 TraeWork 页面并执行 DOM 读写与输入。
 *
 * 原理（实测，2026-09-08）：TraeWork 的 agent 请求在 TTNet 层 TDE 加密，无法在客户端外构造；
 * 唯一可行路径是驱动完整客户端 UI（renderer → ai_agent → 网关），从 DOM 提取结果。
 * 连接方式：`TRAE SOLO CN.exe --remote-debugging-port=<port>`，从 /json 取页面 WS 地址。
 *
 * 参考实现：D:\Trae项目\oh-dsh-trae-api\src\cdpClient.ts（已验证的选择器与交互机制）。
 * 本文件只依赖 Node 内置能力（http + 全局 WebSocket），不引入任何 dsh 依赖。
 */
import { get as httpGet } from "node:http";
import type { SelectorKey, SelectorOverrides } from "./selectors.js";
import { candidateArrayExpr } from "./selectors.js";

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
}

export interface LivenessProbe {
  stopVisible: boolean;
  tailLoading: boolean;
  thinkingStream: boolean;
}

export interface LivenessInterpretation {
  running: boolean;
  evidence: string;
}

/** 只有会可靠消失的停止按钮与 loading tail 才是权威运行信号。 */
export function interpretLiveness(probe: LivenessProbe): LivenessInterpretation {
  const evidence: string[] = [];
  if (probe.stopVisible) evidence.push("stop_button");
  if (probe.tailLoading) evidence.push("task_tail_loading");
  if (probe.thinkingStream) evidence.push("thinking_stream(diagnostic)");
  return { running: probe.stopVisible || probe.tailLoading, evidence: evidence.join(",") || "none" };
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

/** 连接 TraeWork 页面的 CDP 客户端 */
export class TraeworkCdpClient {
  readonly port: number;
  private ws: CdpWebSocket | null = null;
  private isAlive = false;
  private msgId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly opts: CdpClientOptions) {
    this.port = opts.port;
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

  /** 端口上是否存在 TraeWork 页面（就绪探测用） */
  static async probe(port: number, timeoutMs = 3_000): Promise<{ ready: boolean; title?: string; url?: string }> {
    try {
      const targets = await TraeworkCdpClient.listTargets(port, timeoutMs);
      const page = targets.find((t) => t.type === "page");
      if (!page) return { ready: false };
      return { ready: true, title: page.title, url: page.url };
    } catch {
      return { ready: false };
    }
  }

  /** 连接页面（取第一个 type=page 目标） */
  async connect(): Promise<void> {
    let targets: CdpPageTarget[];
    try {
      targets = await TraeworkCdpClient.listTargets(this.port, this.opts.connectTimeoutMs ?? 10_000);
    } catch (e) {
      throw new CdpUnavailableError(
        `无法连接端口 ${this.port}（请确认 TraeWork 以 --remote-debugging-port=${this.port} 启动且窗口可见）：${(e as Error).message}`,
      );
    }
    const page = targets.find((t) => t.type === "page");
    if (!page) {
      throw new CdpUnavailableError(`端口 ${this.port} 上没有页面目标（TraeWork 可能仍在启动中）`);
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl) as unknown as CdpWebSocket;
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpUnavailableError("CDP WebSocket 连接超时")), this.opts.connectTimeoutMs ?? 10_000);
      ws.onopen = () => {
        clearTimeout(timer);
        this.isAlive = true;
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
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

  /* ---------------- DOM 查询（带选择器回退） ---------------- */

  /** 某语义键是否存在可见元素 */
  async exists(key: SelectorKey, overrides?: SelectorOverrides): Promise<boolean> {
    const expr = `(function(){const cs=${candidateArrayExpr(key, overrides)};for(const c of cs){const e=document.querySelector(c);if(e){const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return true}}return false})()`;
    return (await this.evaluate<boolean>(expr)) === true;
  }

  /** 读取某语义键第一个可见元素的文本 */
  async text(key: SelectorKey, overrides?: SelectorOverrides): Promise<string> {
    const expr = `(function(){const cs=${candidateArrayExpr(key, overrides)};for(const c of cs){const e=document.querySelector(c);if(e){const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return (e.textContent||'').trim()}}return ''})()`;
    return this.evaluateString(expr);
  }

  /** 单次页面求值探测所有活跃信号，避免三次 CDP 往返产生观测竞态。 */
  async probeLiveness(overrides?: SelectorOverrides): Promise<LivenessProbe> {
    const stop = candidateArrayExpr("stopButton", overrides);
    const tail = candidateArrayExpr("taskTailLoading", overrides);
    const thinking = candidateArrayExpr("thinkingStream", overrides);
    const expr = `(function(){const visible=(cs)=>{for(const c of cs){const e=document.querySelector(c);if(e){const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return true}}return false};return {stopVisible:visible(${stop}),tailLoading:visible(${tail}),thinkingStream:visible(${thinking})}})()`;
    const value = await this.evaluate<Partial<LivenessProbe>>(expr);
    return {
      stopVisible: value?.stopVisible === true,
      tailLoading: value?.tailLoading === true,
      thinkingStream: value?.thinkingStream === true,
    };
  }

  /** 读取某语义键第一个可见元素的中心坐标（坐标点击用） */
  async center(key: SelectorKey, overrides?: SelectorOverrides): Promise<{ x: number; y: number } | null> {
    const expr = `(function(){const cs=${candidateArrayExpr(key, overrides)};for(const c of cs){const e=document.querySelector(c);if(!e)continue;const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})}return ''})()`;
    const raw = await this.evaluateString(expr);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as { x: number; y: number };
    } catch {
      return null;
    }
  }

  /* ---------------- 输入 ---------------- */

  /** 鼠标左键点击（坐标） */
  async clickAt(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  /** 点击某语义键对应的元素（DOM click 优先，失败回退坐标点击） */
  async click(key: SelectorKey, overrides?: SelectorOverrides): Promise<boolean> {
    const expr = `(function(){const cs=${candidateArrayExpr(key, overrides)};for(const c of cs){const e=document.querySelector(c);if(e){const r=e.getBoundingClientRect();if(r.width>0&&r.height>0){e.click();return true}}}return false})()`;
    if ((await this.evaluate<boolean>(expr)) === true) return true;
    const pos = await this.center(key, overrides);
    if (!pos) return false;
    await this.clickAt(pos.x, pos.y);
    return true;
  }

  /** 聚焦某语义键元素 */
  async focus(key: SelectorKey, overrides?: SelectorOverrides): Promise<boolean> {
    const expr = `(function(){const cs=${candidateArrayExpr(key, overrides)};for(const c of cs){const e=document.querySelector(c);if(e){e.focus();return true}}return false})()`;
    return (await this.evaluate<boolean>(expr)) === true;
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
