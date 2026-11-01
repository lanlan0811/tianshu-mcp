/**
 * TraeWork 页面客户端的选择器语义层：`probeLiveness` 必须把 SELECTORS 的候选列表
 * 全量塞进**一次**页面求值（三次往返会产生观测竞态，误判运行已停止）。
 */
import { describe, expect, it, vi } from "vitest";
import { TraeworkCdpClient } from "../../src/agents/traework/cdp/client.js";

describe("TraeworkCdpClient 选择器语义层", () => {
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
