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
});
