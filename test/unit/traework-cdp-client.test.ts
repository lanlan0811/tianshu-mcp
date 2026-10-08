import { describe, expect, it, vi } from "vitest";
import { CdpDisconnectedError, TraeworkCdpClient } from "../../src/agents/traework/cdp/client.js";

interface FakeSocket {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onopen: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

function attach(client: TraeworkCdpClient): FakeSocket {
  const socket: FakeSocket = {
    send: vi.fn(),
    close: vi.fn(),
    onopen: null,
    onerror: null,
    onclose: null,
    onmessage: null,
  };
  const writable = client as unknown as { ws: FakeSocket; isAlive: boolean };
  writable.ws = socket;
  writable.isAlive = true;
  // connect() 正常完成后注册的处理器在这里等价复现，调用私有收敛逻辑。
  const disconnect = (client as unknown as { markDisconnected: (reason: string) => void }).markDisconnected.bind(client);
  socket.onclose = () => disconnect("WebSocket 已关闭");
  socket.onerror = () => disconnect("WebSocket 错误");
  return socket;
}

describe("TraeworkCdpClient 健壮性", () => {
  it("send 超时会拒绝并移除 pending", async () => {
    vi.useFakeTimers();
    try {
      const client = new TraeworkCdpClient({ port: 9222, sendTimeoutMs: 25 });
      attach(client);
      const pending = client.send("Runtime.evaluate");
      const assertion = expect(pending).rejects.toThrow(/等待响应超时/);
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
      expect((client as unknown as { pending: Map<number, unknown> }).pending.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("onclose 拒绝全部 pending 并标记不再存活", async () => {
    const client = new TraeworkCdpClient({ port: 9222, sendTimeoutMs: 5_000 });
    const socket = attach(client);
    const first = client.send("Runtime.evaluate");
    const second = client.send("DOM.getDocument");
    const firstAssertion = expect(first).rejects.toBeInstanceOf(CdpDisconnectedError);
    const secondAssertion = expect(second).rejects.toBeInstanceOf(CdpDisconnectedError);
    socket.onclose?.({});
    await Promise.all([firstAssertion, secondAssertion]);
    expect(client.alive).toBe(false);
    expect((client as unknown as { pending: Map<number, unknown> }).pending.size).toBe(0);
  });

  it("probeLiveness 单次表达式包含全部候选选择器", async () => {
    const client = new TraeworkCdpClient({ port: 9222 });
    let expression = "";
    client.evaluate = vi.fn(async (expr: string) => {
      expression = expr;
      return { stopVisible: false, tailLoading: false, thinkingStream: false };
    }) as typeof client.evaluate;
    await client.probeLiveness({ stopButton: ".custom-stop" });
    expect(expression).toContain(".custom-stop");
    expect(expression).toContain("chat-input-v2-send-button-stop-icon");
    expect(expression).toContain("core-task-tail--loading");
    expect(expression).toContain("thinking-stream-content");
    expect(expression).toContain("getBoundingClientRect");
  });

  /**
   * 回归锁：连不上端口时的提示文案必须指向**当前应用**（真机 2026-10-08）。
   *
   * `TraeworkCdpClient` 被 6 个 GUI 适配器复用（traework / codex / kimicode /
   * minimax / opendesign / qoder）。文案原先硬编码「TraeWork」，于是 Codex 任务
   * 在进程退出后报的是「请确认 **TraeWork** 以 --remote-debugging-port=9333 启动」——
   * 用户会去翻一个跟本次失败毫无关系的程序。
   */
  it("连接失败文案使用 appLabel 指定的应用名，缺省仍为 TraeWork", async () => {
    // 让 listTargets 失败（模拟 ECONNREFUSED）
    const orig = TraeworkCdpClient.listTargets;
    TraeworkCdpClient.listTargets = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9333");
    }) as typeof TraeworkCdpClient.listTargets;
    try {
      // ① 显式传 Codex → 文案必须说 Codex，且不得出现 TraeWork
      const codex = new TraeworkCdpClient({ port: 9333, appLabel: "Codex" });
      await expect(codex.connect()).rejects.toThrow(/请确认 Codex 以 --remote-debugging-port=9333/);
      await expect(codex.connect()).rejects.not.toThrow(/TraeWork/);

      // ② 未传 → 向后兼容，仍是 TraeWork
      const legacy = new TraeworkCdpClient({ port: 9333 });
      await expect(legacy.connect()).rejects.toThrow(/请确认 TraeWork 以 --remote-debugging-port=9333/);

      // ③ 其余复用方各自的名字也生效（真机错误形态逐字核对）
      for (const [label, port] of [
        ["Kimi Code", 9334],
        ["MiniMax Code", 9335],
        ["Open Design", 9336],
        ["Qoder", 9337],
      ] as const) {
        const c = new TraeworkCdpClient({ port, appLabel: label });
        // eslint-disable-next-line no-await-in-loop
        await expect(c.connect()).rejects.toThrow(new RegExp(`请确认 ${label} 以 --remote-debugging-port=${port}`));
      }
    } finally {
      TraeworkCdpClient.listTargets = orig;
    }
  });
});
