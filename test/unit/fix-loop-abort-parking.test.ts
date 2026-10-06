import { describe, expect, it } from "vitest";
import {
  AGENT_ABORT_END_REASONS,
  AGENT_ABORT_PARKING_AGENTS,
  shouldParkAsNeedsAttention,
} from "../../src/loop/fix-loop.js";

/**
 * issue #31：agent 侧异常结束 → needs_attention（不得进入项目验收链）。
 *
 * 这是本 issue 后果链的**后半段**：只给 driver 加 `sawRunning` 门，误判只是从
 * `reply_stable`（进验收）变成 `idle_timeout`（仍进验收，因为 autoVerify 默认 true，
 * fix-loop 里的两个 `!autoVerify` 出口都会被跳过）。必须同时让这几个 driver 的
 * `idle_timeout` 落 needs_attention 才算闭环。
 */
describe("issue #31 · agent 异常结束应转 needs_attention", () => {
  it("五个 GUI driver 的 idle_timeout / task_timeout / cdp_disconnected 均在集合内", () => {
    for (const agent of AGENT_ABORT_PARKING_AGENTS) {
      for (const reason of AGENT_ABORT_END_REASONS) {
        expect(shouldParkAsNeedsAttention(agent, reason), `${agent} / ${reason}`).toBe(true);
      }
    }
  });

  it("回归面：成功终态绝不落入该分支", () => {
    for (const agent of AGENT_ABORT_PARKING_AGENTS) {
      expect(shouldParkAsNeedsAttention(agent, "reply_stable")).toBe(false);
      expect(shouldParkAsNeedsAttention(agent, "completion_mark")).toBe(false);
      expect(shouldParkAsNeedsAttention(agent, undefined)).toBe(false);
    }
  });

  it("无 endReason 或未知 agent 时不误判", () => {
    expect(shouldParkAsNeedsAttention("zcode", undefined)).toBe(false);
    expect(shouldParkAsNeedsAttention("some-future-agent", "idle_timeout")).toBe(false);
  });

  it("集合本身不重复、不含空串（防手改后语义漂移）", () => {
    expect(new Set(AGENT_ABORT_END_REASONS).size).toBe(AGENT_ABORT_END_REASONS.length);
    expect(new Set(AGENT_ABORT_PARKING_AGENTS).size).toBe(AGENT_ABORT_PARKING_AGENTS.length);
    expect(AGENT_ABORT_END_REASONS.every((r) => r.trim().length > 0)).toBe(true);
    expect(AGENT_ABORT_PARKING_AGENTS.every((a) => a.trim().length > 0)).toBe(true);
  });

  it("issue #31 的两个关键 driver 必须在内（否则后果链未关闭）", () => {
    expect(AGENT_ABORT_PARKING_AGENTS).toContain("kimicode");
    expect(AGENT_ABORT_PARKING_AGENTS).toContain("minimax");
    expect(AGENT_ABORT_PARKING_AGENTS).toContain("opendesign");
  });
});
