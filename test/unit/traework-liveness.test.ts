import { describe, expect, it } from "vitest";
import { interpretLiveness } from "../../src/agents/traework/cdp/client.js";

describe("interpretLiveness", () => {
  it("仅停止按钮可见时判定运行中", () => {
    expect(interpretLiveness({ stopVisible: true, tailLoading: false, thinkingStream: false })).toEqual({
      running: true,
      evidence: "stop_button",
    });
  });

  it("仅 task tail loading 时判定运行中", () => {
    expect(interpretLiveness({ stopVisible: false, tailLoading: true, thinkingStream: false })).toEqual({
      running: true,
      evidence: "task_tail_loading",
    });
  });

  it("仅 thinking stream 时不阻塞结束", () => {
    expect(interpretLiveness({ stopVisible: false, tailLoading: false, thinkingStream: true })).toEqual({
      running: false,
      evidence: "thinking_stream(diagnostic)",
    });
  });

  it("全部为空时失败开放", () => {
    expect(interpretLiveness({ stopVisible: false, tailLoading: false, thinkingStream: false })).toEqual({
      running: false,
      evidence: "none",
    });
  });
});
