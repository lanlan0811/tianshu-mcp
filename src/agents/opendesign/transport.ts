/**
 * Open Design 的 CDP 传输层。
 *
 * **为什么不用 `GuiCdpClient`**：既有 GUI 传输在 `connect()` 里走 HTTP `/json` 取页面
 * WebSocket 地址。真机实测（Open Design 0.24.1 / Electron 41.3.0）发现：浏览器进程的
 * `/json/version` 正常，但 `/json` 与 `/json/list` 会**连接成功却长时间无响应**
 * （`Target` 枚举走 UI 线程，产品主线程在启动期被自身的计费/遥测请求占住时即挂起）。
 * 用它做传输会让适配器在真机上永远卡在 connect。
 *
 * 因此这里的策略是**两条路径**：
 *   1. 快路径：HTTP `/json`（正常版本上最快，且与既有实现语义一致）；
 *   2. 慢路径：`/json/version` 拿到**浏览器级** WebSocket 地址 → 用 `Target.getTargets`
 *      枚举目标 → `Target.attachToTarget(flatten)` 拿到 `sessionId` 后在会话上执行命令。
 *
 * 两条路径都失败才报错，且错误信息必须写明「试过什么」，避免又变成一句无从下手的
 * `CDP_UNAVAILABLE`。
 */
import { fetchCdpJson, type CdpJsonFetcher } from "../kimicode/instance.js";

/** Node 22+ 全局 WebSocket 的最小接口（规避各版本 ambient 类型差异） */
export interface CdpSocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface CdpPageTargetLike {
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
  targetId?: string;
}

export class OpenDesignCdpError extends Error {
  constructor(msg: string) {
    super(`CDP_UNAVAILABLE: ${msg}`);
    this.name = "OpenDesignCdpError";
  }
}

export class OpenDesignCdpDisconnected extends OpenDesignCdpError {
  constructor(msg: string) {
    super(`连接已断开: ${msg}`);
    this.name = "OpenDesignCdpDisconnected";
  }
}

/** 浏览器级方法（不经会话，直接发到浏览器 WebSocket） */
const BROWSER_LEVEL = /^(Target|Browser)\./;

/** 浏览器级一次性请求（连接 → 一条命令 → 关闭），用于慢路径的目标枚举 */
async function browserWsCall(
  port: number,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  fetchJson: CdpJsonFetcher,
): Promise<unknown> {
  const version = (await fetchJson(port, "/json/version", timeoutMs)) as {
    webSocketDebuggerUrl?: string;
  } | null;
  const wsUrl = version?.webSocketDebuggerUrl;
  if (!wsUrl) throw new OpenDesignCdpError(`/json/version 未返回 webSocketDebuggerUrl`);
  const ws = new WebSocket(wsUrl) as unknown as CdpSocketLike;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* 已关闭 */
      }
      reject(new OpenDesignCdpError(`${method} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* 已关闭 */
      }
      fn();
    };
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { id?: number; error?: unknown; result?: unknown };
        if (msg.id !== 1) return;
        if (msg.error) finish(() => reject(new OpenDesignCdpError(`${method}: ${JSON.stringify(msg.error)}`)));
        else finish(() => resolve(msg.result));
      } catch {
        /* 无关事件 */
      }
    };
    ws.onerror = () => finish(() => reject(new OpenDesignCdpError(`${method} 连接失败`)));
    ws.onclose = () => finish(() => reject(new OpenDesignCdpError(`${method} 连接被关闭`)));
  });
}

/** `resolvePageTargets` 的注入点（单测据此完全绕开网络） */
export interface ResolveTargetsDeps {
  /** CDP 只读 JSON 抓取（快路径 `/json` 与慢路径 `/json/version` 共用同一注入点） */
  fetchJson?: CdpJsonFetcher;
  /** 慢路径的浏览器级一次性调用 */
  browserCall?: typeof browserWsCall;
}

/**
 * 枚举页面目标：先 HTTP `/json`，失败（挂起/解析失败/空列表）再走浏览器级 `Target.getTargets`。
 * 就绪探测与传输装配共用同一份实现——两处各写一套必然漂移。
 *
 * 快路径使用**带超时的** `fetchJson`：真机上 `/json` 会挂起，超时后立即转慢路径，
 * 不会让 connect 无限等。
 */
export async function resolvePageTargets(
  port: number,
  timeoutMs: number,
  deps: ResolveTargetsDeps = {},
): Promise<CdpPageTargetLike[]> {
  const fetchJson = deps.fetchJson ?? fetchCdpJson;
  const viaHttp = await fetchJson(port, "/json", timeoutMs).catch(() => undefined);
  const httpTargets = (Array.isArray(viaHttp) ? viaHttp : []).filter(
    (t) => (t as CdpPageTargetLike).type === "page",
  ) as CdpPageTargetLike[];
  if (httpTargets.length) return httpTargets;
  const call = deps.browserCall ?? browserWsCall;
  const viaWs = await call(port, "Target.getTargets", {}, timeoutMs, fetchJson).catch(() => undefined);
  const infos = (viaWs as { targetInfos?: CdpPageTargetLike[] } | undefined)?.targetInfos ?? [];
  return infos.filter((t) => t.type === "page");
}

export interface OpenDesignTransportOptions {
  port: number;
  /** 单次命令等待响应的超时 */
  sendTimeoutMs?: number;
  /** 连接/枚举目标的总超时 */
  connectTimeoutMs?: number;
  /** 多页面时的排序偏好（越小越优先） */
  targetRank?: (target: CdpPageTargetLike) => number;
  /** `/json` 与 `/json/version` 抓取（可注入，便于单测） */
  fetchJson?: CdpJsonFetcher;
  /** 慢路径浏览器级调用（可注入，便于单测） */
  browserCall?: typeof browserWsCall;
  /** WebSocket 构造（可注入，便于单测） */
  createSocket?: (url: string) => CdpSocketLike;
}

/**
 * Open Design 页面级 CDP 传输。
 * 满足 `KimicodePageClient` 契约（connect / disconnect / send / evaluate），
 * 语义层（`OpenDesignCdpClient`）只依赖该契约，因此单测可以整体替换掉网络。
 */
export class OpenDesignTransport {
  readonly port: number;
  private socket: CdpSocketLike | null = null;
  private alive = false;
  private sessionId: string | null = null;
  private msgId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(private readonly opts: OpenDesignTransportOptions) {
    this.port = opts.port;
  }

  get connected(): boolean {
    return this.socket !== null && this.alive;
  }

  get aliveState(): boolean {
    return this.alive;
  }

  private get timeoutMs(): number {
    return this.opts.sendTimeoutMs ?? 15_000;
  }

  async connect(): Promise<void> {
    const timeoutMs = this.opts.connectTimeoutMs ?? 10_000;
    // 快路径（HTTP /json）在真机上会挂起：给它一个更短的上限，超时即转慢路径，
    // 不把整个 connect 预算都耗在等一个已知会挂的端点上。
    const fastTimeoutMs = Math.min(timeoutMs, 3_000);
    const targets = await resolvePageTargets(this.port, timeoutMs, {
      fetchJson: this.opts.fetchJson
        ? this.opts.fetchJson
        : (p, path, t) => fetchCdpJson(p, path, Math.min(t, fastTimeoutMs)),
      browserCall: this.opts.browserCall,
    });
    const candidates = targets.filter((t) => t.type === "page");
    if (!candidates.length)
      throw new OpenDesignCdpError(`端口 ${this.port} 上没有页面目标（Open Design 可能仍在启动中）`);
    const pick = this.opts.targetRank
      ? [...candidates].sort((a, b) => this.opts.targetRank!(a) - this.opts.targetRank!(b))[0]!
      : candidates[0]!;

    // 快路径拿到的目标自带页面级 WS 地址，直接连即可（与既有实现一致）
    if (pick.webSocketDebuggerUrl) {
      await this.openSocket(pick.webSocketDebuggerUrl, timeoutMs);
      await this.send("Runtime.enable").catch(() => undefined);
      return;
    }

    // 慢路径：目标是浏览器级 `Target.getTargets` 的结果，只有 targetId
    const version = (await (this.opts.fetchJson ?? fetchCdpJson)(
      this.port,
      "/json/version",
      timeoutMs,
    )) as { webSocketDebuggerUrl?: string } | null;
    const browserWs = version?.webSocketDebuggerUrl;
    if (!browserWs)
      throw new OpenDesignCdpError(
        `既拿不到页面级 WS 地址（/json 不可用），也拿不到浏览器级 WS 地址（/json/version 未返回 webSocketDebuggerUrl）`,
      );
    if (!pick.targetId)
      throw new OpenDesignCdpError(`目标缺少 targetId，无法在浏览器级会话上接入`);
    await this.openSocket(browserWs, timeoutMs);
    const attached = (await this.send("Target.attachToTarget", {
      targetId: pick.targetId,
      flatten: true,
    })) as { sessionId?: string } | undefined;
    if (!attached?.sessionId)
      throw new OpenDesignCdpError(`Target.attachToTarget 未返回 sessionId`);
    this.sessionId = attached.sessionId;
    await this.send("Runtime.enable").catch(() => undefined);
  }

  private openSocket(url: string, timeoutMs: number): Promise<void> {
    const factory =
      this.opts.createSocket ?? ((u: string) => new WebSocket(u) as unknown as CdpSocketLike);
    const socket = factory(url);
    this.socket = socket;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.cleanup(socket);
        reject(new OpenDesignCdpError("CDP WebSocket 连接超时"));
      }, timeoutMs);
      socket.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.alive = true;
        resolve();
      };
      socket.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cleanup(socket);
        reject(new OpenDesignCdpError("CDP WebSocket 连接失败"));
      };
      socket.onmessage = (ev) => this.onMessage(ev);
      socket.onclose = () => this.markDisconnected("WebSocket 已关闭");
    });
  }

  private cleanup(socket: CdpSocketLike): void {
    if (this.socket === socket) this.socket = null;
    this.alive = false;
    try {
      socket.close();
    } catch {
      /* 已关闭 */
    }
  }

  private onMessage(ev: { data: unknown }): void {
    try {
      const msg = JSON.parse(String(ev.data)) as { id?: number; error?: unknown; result?: unknown };
      if (!msg.id || !this.pending.has(msg.id)) return;
      const pending = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
    } catch {
      // 非法/无关事件不应击穿客户端；对应请求仍由 send 超时收敛。
    }
  }

  private markDisconnected(reason: string): void {
    this.alive = false;
    this.socket = null;
    const error = new OpenDesignCdpDisconnected(reason);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.alive) {
        reject(new OpenDesignCdpDisconnected("CDP 未连接或已关闭"));
        return;
      }
      const id = ++this.msgId;
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new OpenDesignCdpError(`命令 ${method} 等待响应超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      const payload: Record<string, unknown> = { id, method, params };
      // 会话隔离：页面级命令必须带 sessionId，浏览器级命令不能带（带了会被拒）
      if (this.sessionId && !BROWSER_LEVEL.test(method)) payload.sessionId = this.sessionId;
      try {
        this.socket.send(JSON.stringify(payload));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          new OpenDesignCdpDisconnected(
            `命令 ${method} 发送失败：${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }
    });
  }

  /** 页面内执行表达式并取回值（异常抛出，由调用方决定处理） */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = (await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as {
      exceptionDetails?: { text?: string; exception?: { description?: string; value?: unknown } };
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
      throw new Error(`页面执行错误: ${detail}`);
    }
    return r.result?.value as T;
  }

  disconnect(): void {
    const socket = this.socket;
    if (!socket && !this.alive && this.pending.size === 0) return;
    this.markDisconnected("客户端主动断开");
    try {
      socket?.close();
    } catch {
      /* 已断开 */
    }
  }
}