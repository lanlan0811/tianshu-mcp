import { describe, expect, it } from "vitest";
import {
  detectQuestion,
  hashText,
  hasRunSignal,
  initialMinimaxState,
  judgeMinimaxPoll,
  questionDetectionEnabled,
  withDetectedQuestion,
  type MinimaxPoll,
} from "../../src/agents/minimax/liveness.js";

/**
 * MiniMax Code 运行判定。
 *
 * 判据的权威性排序（真机实测 + 与既有适配器同一纪律）：
 * 1. 停止按钮（产物提取，真机发送后态未复验 → 缺失时自动降级）；
 * 2. 失败文案（不得判完成）；
 * 3. 文本稳定窗口（**不能单独作为完成判据**，必须先达到 stableRounds）。
 *
 * 关键不变量：
 * - 文本静止 N 秒 ≠ 完成（必须先稳定 N 轮）；
 * - 有运行信号时一律清零稳定轮与空闲计时（长思考不得被提前判完成）；
 * - 停止按钮恒可见 + 文本停滞超 stall → 转 needs_user（打破死锁）。
 */
function poll(extra: Partial<MinimaxPoll> = {}): MinimaxPoll {
  return {
    stopVisible: false,
    assistantText: "",
    retryVisible: false,
    inputText: "",
    sendEnabled: false,
    pageHidden: false,
    ...extra,
  };
}

describe("MiniMax Code 运行判定", () => {
  it("hashText：同文本同哈希、异文本异哈希（稳定判定的基础）", () => {
    expect(hashText("abc")).toBe(hashText("abc"));
    expect(hashText("abc")).not.toBe(hashText("abd"));
    expect(hashText("abc")).toHaveLength(12);
  });

  it("hasRunSignal：只有停止按钮算运行信号（发送按钮双态无法区分空输入与已发送）", () => {
    expect(hasRunSignal(poll({ stopVisible: true }))).toBe(true);
    // 发送按钮禁用**不**算运行信号——输入框为空时它也禁用，据此判定会「发完永远 running」
    expect(hasRunSignal(poll({ sendDisabled: true }))).toBe(false);
    expect(hasRunSignal(poll())).toBe(false);
  });

  it("首次轮询（无文本无信号）→ running，不得判完成", () => {
    const v = judgeMinimaxPoll(poll(), initialMinimaxState(), 4, 600_000, 300_000, { since: 0 });
    expect(v.kind).toBe("running");
  });

  it("有运行信号 → running，且**清零**稳定轮（长思考不得被提前判完成）", () => {
    const prev = { hash: hashText("思考中"), stable: 99, idleSince: 1, sawRunning: true };
    const v = judgeMinimaxPoll(
      poll({ stopVisible: true, assistantText: "思考中" }),
      prev,
      4,
      600_000,
      300_000,
      { since: 0 },
    );
    expect(v.kind).toBe("running");
    expect(v.state.stable).toBe(0);
    expect(v.state.idleSince).toBe(0);
  });

  it("文本变化但未达 stableRounds → running（静止不足以判完成）", () => {
    const prev = { hash: hashText("a"), stable: 3, idleSince: 0, sawRunning: true };
    const v = judgeMinimaxPoll(
      poll({ assistantText: "a" }),
      prev,
      4,
      600_000,
      300_000,
      { since: 0 },
    );
    // 恰好达到阈值的**这一轮**即判完成（与 zcode/kimicode 同构）：
    // 「静止 N 秒」不是判据，「连续 N 轮读数一致」才是。
    expect(v.kind).toBe("finished");
    expect(v.state.stable).toBe(4);
  });

  it("未达 stableRounds（差一轮）→ running", () => {
    const prev = { hash: hashText("a"), stable: 2, idleSince: 0, sawRunning: true };
    const v = judgeMinimaxPoll(
      poll({ assistantText: "a" }),
      prev,
      4,
      600_000,
      300_000,
      { since: 0 },
    );
    expect(v.kind).toBe("running");
    expect(v.state.stable).toBe(3);
  });

  it("文本稳定达 stableRounds 且空闲超时 → idle_timeout", () => {
    const hash = hashText("done");
    const prev = { hash, stable: 5, idleSince: Date.now() - 700_000, sawRunning: true };
    const v = judgeMinimaxPoll(
      poll({ assistantText: "done" }),
      prev,
      4,
      600_000,
      300_000,
      { since: 0 },
    );
    expect(v.kind).toBe("idle_timeout");
  });

  it("曾观测到运行信号 + 文本稳定达 stableRounds 且空闲未超时 → finished", () => {
    const hash = hashText("done");
    // issue #31：完成判定要求「曾观测到运行信号」。sawRunning: true 代表此前见过 stop-button。
    const prev = { hash, stable: 5, idleSince: Date.now(), sawRunning: true };
    const v = judgeMinimaxPoll(
      poll({ assistantText: "done" }),
      prev,
      4,
      600_000,
      300_000,
      { since: 0 },
    );
    expect(v.kind).toBe("finished");
  });

  it("空文本即使稳定也**不得**判完成", () => {
    const prev = { hash: hashText(""), stable: 99, idleSince: 0, sawRunning: true };
    const v = judgeMinimaxPoll(poll(), prev, 4, 600_000, 300_000, { since: 0 });
    expect(v.kind).toBe("running");
  });

  it("失败文案 → failed（绝不得判完成）", () => {
    const v = judgeMinimaxPoll(
      poll({ assistantText: "请求失败，请重试", errorText: "请求失败，请重试" }),
      initialMinimaxState(),
      4,
      600_000,
      300_000,
      { since: 0 },
    );
    expect(v.kind).toBe("failed");
  });

  it("配置的重试按钮命中 → failed（未配置时该键恒 false）", () => {
    const v = judgeMinimaxPoll(
      poll({ retryVisible: true }),
      initialMinimaxState(),
      4,
      600_000,
      300_000,
      { since: 0 },
    );
    expect(v.kind).toBe("failed");
  });

  it("停止按钮恒可见 + 文本停滞超 stall → needs_user（打破死锁）", () => {
    const v = judgeMinimaxPoll(
      poll({ stopVisible: true, assistantText: "同一段" }),
      { hash: hashText("同一段"), stable: 0, idleSince: 0, sawRunning: true },
      4,
      600_000,
      300_000,
      { since: Date.now() - 400_000 },
    );
    expect(v.kind).toBe("needs_user");
    expect(v.question).toMatch(/停止按钮持续可见/);
  });

  it("userGate 命中 → needs_user（优先级最高）", () => {
    const v = judgeMinimaxPoll(
      poll({ userGateVisible: true, stopVisible: true }),
      initialMinimaxState(),
      4,
      600_000,
      300_000,
      { since: 0 },
    );
    expect(v.kind).toBe("needs_user");
  });

  it("evidence 串包含全部命中信号（诊断可读）", () => {
    const v = judgeMinimaxPoll(
      poll({ stopVisible: true, busyVisible: true, pageHidden: true }),
      initialMinimaxState(),
      4,
      600_000,
      300_000,
      { since: Date.now() },
    );
    expect(v.evidence).toContain("stop_button");
    expect(v.evidence).toContain("busy_banner");
    expect(v.evidence).toContain("page_hidden");
  });
});

describe("MiniMax Code 提问检测（保守启发式，默认关闭）", () => {
  it("questionDetectionEnabled：未配置 userGate → 关闭", () => {
    expect(questionDetectionEnabled({})).toBe(false);
    expect(questionDetectionEnabled({ userGate: "" })).toBe(false);
    expect(questionDetectionEnabled({ userGate: '#q[role="dialog"]' })).toBe(true);
  });

  it("withDetectedQuestion：未配置 userGate → 不启用（默认不判 agent_question）", () => {
    const raw = poll({ assistantText: "要继续吗？" });
    const out = withDetectedQuestion(raw, { hash: hashText("旧"), stable: 0, idleSince: 0, sawRunning: true }, {});
    expect(out.question).toBeUndefined();
  });

  it("detectQuestion：无运行信号 + 输入框空 + 文本已变化 + 问句结尾 → 命中", () => {
    const q = detectQuestion(
      poll({ assistantText: "请确认是否继续？" }),
      { hash: hashText("前一段"), stable: 0, idleSince: 0, sawRunning: true },
    );
    expect(q).toBe("请确认是否继续？");
  });

  it("detectQuestion：有运行信号 → 不判（生成中不可能是等待输入）", () => {
    expect(
      detectQuestion(poll({ stopVisible: true, assistantText: "要继续吗？" }), {
        hash: hashText("旧"),
        stable: 0,
        idleSince: 0,
        sawRunning: true,
      }),
    ).toBeUndefined();
  });

  it("detectQuestion：输入框有内容 → 不判（别抢用户的输入）", () => {
    expect(
      detectQuestion(poll({ assistantText: "要继续吗？", inputText: "我正在写" }), {
        hash: hashText("旧"),
        stable: 0,
        idleSince: 0,
        sawRunning: true,
      }),
    ).toBeUndefined();
  });

  it("detectQuestion：首轮无基线 → 不判（避免把历史问句当新提问）", () => {
    expect(
      detectQuestion(poll({ assistantText: "要继续吗？" }), initialMinimaxState()),
    ).toBeUndefined();
  });

  it("detectQuestion：文本未变化 → 不判（避免同一问句反复命中）", () => {
    const text = "要继续吗？";
    expect(
      detectQuestion(poll({ assistantText: text }), {
        hash: hashText(text),
        stable: 0,
        idleSince: 0,
        sawRunning: true,
      }),
    ).toBeUndefined();
  });

  it("detectQuestion：非问句结尾 → 不判（保守：宁可漏判走 idle_timeout）", () => {
    expect(
      detectQuestion(poll({ assistantText: "已完成，输出如下。" }), {
        hash: hashText("旧"),
        stable: 0,
        idleSince: 0,
        sawRunning: true,
      }),
    ).toBeUndefined();
  });
});
