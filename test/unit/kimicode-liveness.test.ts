import { describe, expect, it } from "vitest";
import {
  detectQuestion,
  hashText,
  initialKimicodeState,
  judgeKimicodePoll,
  questionDetectionEnabled,
  withDetectedQuestion,
  type KimicodePoll,
  type KimicodePollState,
  type KimicodeStallSince,
} from "../../src/agents/kimicode/liveness.js";

/**
 * M3 单测：运行判定。
 *
 * 判据来自真机实测：`button.stop` 是权威运行信号（发送后 0.5–1.2s 出现、完成后消失），
 * `button.send.is-starting` 次权威；`button.ui-button--secondary`（「继续」）与 panes 内的
 * 「模型请求失败」是失败态。核心纪律：长思考期间文本静止绝不能被提前判完成。
 */
function poll(over: Partial<KimicodePoll> = {}): KimicodePoll {
  return {
    stopVisible: false,
    sendStarting: false,
    assistantText: "",
    retryVisible: false,
    inputText: "",
    sendEnabled: true,
    pageHidden: false,
    ...over,
  };
}

/** 一轮判定（跨轮状态与停滞计时由调用方持有，模拟 run.ts 的轮询环） */
function round(
  p: KimicodePoll,
  state: KimicodePollState,
  stall: KimicodeStallSince,
  now: number,
  opts: { stableRounds?: number; idleTimeoutMs?: number; stallTimeoutMs?: number } = {},
) {
  return judgeKimicodePoll(
    p,
    state,
    opts.stableRounds ?? 2,
    opts.idleTimeoutMs ?? 10 * 60_000,
    opts.stallTimeoutMs ?? 300_000,
    stall,
    now,
  );
}

describe("Kimi Code 运行信号优先", () => {
  it("停止按钮可见时文本长期不变仍判 running，并清零稳定轮与空闲计时", () => {
    let state = initialKimicodeState();
    const stall = { since: 0 };
    let now = 1_000_000;
    for (let i = 0; i < 10; i++) {
      const verdict = round(poll({ stopVisible: true, assistantText: "思考中…" }), state, stall, now);
      expect(verdict.kind).toBe("running");
      expect(verdict.state.stable).toBe(0);
      expect(verdict.state.idleSince).toBe(0);
      expect(verdict.evidence).toContain("stop_button");
      state = verdict.state;
      now += 10_000;
    }
    // 停滞计时是「停止按钮可见且文本不变」的起点，不因轮询次数而重置。
    expect(stall.since).toBe(1_000_000);
  });

  it("发送中（send is-starting）同属运行信号", () => {
    const verdict = round(poll({ sendStarting: true, assistantText: "回复" }), initialKimicodeState(), { since: 0 }, 1);
    expect(verdict.kind).toBe("running");
    expect(verdict.evidence).toContain("send_starting");
  });

  it("长思考后停止按钮消失、文本推进 → 不判完成，重新累计稳定轮", () => {
    let state = round(
      poll({ stopVisible: true, assistantText: "第一段" }),
      initialKimicodeState(),
      { since: 0 },
      1,
    ).state;
    const after = round(poll({ assistantText: "第一段+新增" }), state, { since: 0 }, 2, {
      stableRounds: 1,
    });
    expect(after.kind).toBe("running");
    state = after.state;
    expect(state.stable).toBe(0);
    expect(round(poll({ assistantText: "第一段+新增" }), state, { since: 0 }, 3, { stableRounds: 1 }).kind).toBe(
      "finished",
    );
  });
});

describe("Kimi Code 完成判定", () => {
  it("无运行信号但未达 stableRounds：不判完成", () => {
    let state = initialKimicodeState();
    const first = round(poll({ assistantText: "回复" }), state, { since: 0 }, 1, { stableRounds: 3 });
    expect(first.kind).toBe("running");
    state = first.state;
    const second = round(poll({ assistantText: "回复" }), state, { since: 0 }, 2, { stableRounds: 3 });
    expect(second.kind).toBe("running");
    expect(second.state.stable).toBe(1);
  });

  it("无运行信号且文本稳定达 stableRounds → finished", () => {
    let state = initialKimicodeState();
    // 首轮对话文本从空到有：哈希变化，稳定轮从 0 起算（绝不把首帧当稳定）。
    let verdict = round(poll({ assistantText: "回复" }), state, { since: 0 }, 1);
    expect(verdict.kind).toBe("running");
    state = verdict.state;
    verdict = round(poll({ assistantText: "回复" }), state, { since: 0 }, 2);
    expect(verdict.kind).toBe("running");
    state = verdict.state;
    verdict = round(poll({ assistantText: "回复" }), state, { since: 0 }, 3);
    expect(verdict.kind).toBe("finished");
    expect(verdict.evidence).toBe("none");
    expect(verdict.state.hash).toBe(hashText("回复"));
  });

  it("空对话文本不判完成（避免把「还没开始」当成「已完成」）", () => {
    let state = initialKimicodeState();
    for (let i = 0; i < 5; i++) {
      const verdict = round(poll({ assistantText: "" }), state, { since: 0 }, i, { stableRounds: 1 });
      expect(verdict.kind).toBe("running");
      state = verdict.state;
    }
  });

  it("稳定后超过 idleTimeoutMs → idle_timeout（保留现场，不判完成）", () => {
    let state = initialKimicodeState();
    let verdict = round(poll({ assistantText: "回复" }), state, { since: 0 }, 1, {
      stableRounds: 1,
      idleTimeoutMs: 0,
    });
    expect(verdict.kind).toBe("running");
    state = verdict.state;
    verdict = round(poll({ assistantText: "回复" }), state, { since: 0 }, 2, {
      stableRounds: 1,
      idleTimeoutMs: 0,
    });
    // 空闲判定先于完成判定：stableRounds 达标即开始计时，超时优先收敛为 idle_timeout。
    expect(verdict.kind).toBe("idle_timeout");
  });
});

describe("Kimi Code 失败态与等待用户", () => {
  it("出现「继续」按钮 → failed，绝不判完成", () => {
    const verdict = round(
      poll({ assistantText: "模型请求失败，本轮对话已中断", retryVisible: true }),
      initialKimicodeState(),
      { since: 0 },
      1,
    );
    expect(verdict.kind).toBe("failed");
    expect(verdict.evidence).toContain("retry_button");
  });

  it("panes 内出现失败文案 → failed", () => {
    const verdict = round(
      poll({ assistantText: "provider.auth_error · HTTP 403", errorText: "provider.auth_error · HTTP 403" }),
      initialKimicodeState(),
      { since: 0 },
      1,
    );
    expect(verdict.kind).toBe("failed");
    expect(verdict.evidence).toContain("error_text");
  });

  it("停止按钮持续可见且文本停滞超 stallTimeoutMs → needs_user（打破恒 running 死锁）", () => {
    const stall = { since: 0 };
    const first = round(poll({ stopVisible: true, assistantText: "等你确认" }), initialKimicodeState(), stall, 1_000, {
      stallTimeoutMs: 30_000,
    });
    expect(first.kind).toBe("running");
    expect(stall.since).toBe(1_000);
    const stalled = round(poll({ stopVisible: true, assistantText: "等你确认" }), first.state, stall, 31_000, {
      stallTimeoutMs: 30_000,
    });
    expect(stalled.kind).toBe("needs_user");
    expect(stalled.question).toMatch(/停止按钮持续可见/);
    expect(stalled.evidence).toContain("+stall");
  });

  it("停滞期间文本一旦推进就重新计时", () => {
    const stall = { since: 0 };
    const first = round(poll({ stopVisible: true, assistantText: "一段" }), initialKimicodeState(), stall, 1_000, {
      stallTimeoutMs: 30_000,
    });
    const moved = round(poll({ stopVisible: true, assistantText: "一段+二段" }), first.state, stall, 40_000, {
      stallTimeoutMs: 30_000,
    });
    expect(moved.kind).toBe("running");
    expect(stall.since).toBe(40_000);
  });

  it("question 命中 → needs_user 并带回问题原文", () => {
    const verdict = round(
      poll({ assistantText: "请选择", question: "请确认是否继续安装依赖？" }),
      initialKimicodeState(),
      { since: 0 },
      1,
    );
    expect(verdict.kind).toBe("needs_user");
    expect(verdict.question).toBe("请确认是否继续安装依赖？");
  });
});

describe("Kimi Code 页面隐藏", () => {
  it("pageHidden 不改变判定，但必须作为证据输出（窗口不在前台时点击可能被吞）", () => {
    const running = round(
      poll({ stopVisible: true, pageHidden: true, assistantText: "回复" }),
      initialKimicodeState(),
      { since: 0 },
      1,
    );
    expect(running.kind).toBe("running");
    expect(running.evidence).toContain("page_hidden");
    let state = initialKimicodeState();
    let verdict = round(poll({ pageHidden: true, assistantText: "回复" }), state, { since: 0 }, 1, {
      stableRounds: 1,
    });
    expect(verdict.kind).toBe("running");
    state = verdict.state;
    verdict = round(poll({ pageHidden: true, assistantText: "回复" }), state, { since: 0 }, 2, {
      stableRounds: 1,
    });
    expect(verdict.kind).toBe("finished");
    expect(verdict.evidence).toContain("page_hidden");
  });
});

/* ============================ M4：提问检测与 userGate ============================ */

/** 有基线的跨轮状态（提问检测要求「有基线且本轮文本已变化」） */
function baseline(text: string): KimicodePollState {
  return { hash: hashText(text), stable: 0, idleSince: 0 };
}

describe("Kimi Code 提问检测（保守判据，待真机验证）", () => {
  it("无运行信号 + 输入框空 + 文本已变化 + 问句结尾 → 命中并带回问题原文", () => {
    const question = detectQuestion(
      poll({ assistantText: "已完成依赖安装，是否继续执行数据库迁移？" }),
      baseline("已完成依赖安装"),
    );
    expect(question).toBe("已完成依赖安装，是否继续执行数据库迁移？");
    // 半角问号同样命中
    expect(
      detectQuestion(poll({ assistantText: "Should I continue?" }), baseline("step 1 done")),
    ).toBe("Should I continue?");
  });

  it("正常完成文案（非问句结尾）→ 不命中，退回 idle_timeout 而不是误判 needs_user", () => {
    expect(
      detectQuestion(poll({ assistantText: "任务已完成，全部测试通过。" }), baseline("任务进行中")),
    ).toBeUndefined();
    // 问号出现在中间、末尾不是问句 → 不命中
    expect(
      detectQuestion(
        poll({ assistantText: "为什么失败？已修复该问题。" }),
        baseline("正在排查"),
      ),
    ).toBeUndefined();
  });

  it("仍在生成（停止按钮可见 / send is-starting）→ 绝不判提问", () => {
    expect(
      detectQuestion(
        poll({ stopVisible: true, assistantText: "是否继续？" }),
        baseline("生成中"),
      ),
    ).toBeUndefined();
    expect(
      detectQuestion(
        poll({ sendStarting: true, assistantText: "是否继续？" }),
        baseline("生成中"),
      ),
    ).toBeUndefined();
  });

  it("输入框非空（用户正在写）或文本未变化 / 无基线 → 不命中", () => {
    // 只有空白也算空（ProseMirror 清空后保留空 <p>，与发送确认判据一致）
    expect(
      detectQuestion(poll({ assistantText: "是否继续？", inputText: "  " }), baseline("之前")),
    ).toBe("是否继续？");
    expect(
      detectQuestion(poll({ assistantText: "是否继续？", inputText: "是的" }), baseline("之前")),
    ).toBeUndefined();
    // 文本与上一轮完全一致：同一段问句不会被反复判成新提问
    expect(
      detectQuestion(poll({ assistantText: "是否继续？" }), baseline("是否继续？")),
    ).toBeUndefined();
    // 首轮无基线：保守不判（宁可漏判）
    expect(detectQuestion(poll({ assistantText: "是否继续？" }), initialKimicodeState())).toBeUndefined();
  });

  it("未配置 gui.selectors.userGate 时默认关闭检测；配置后才接入 poll", () => {
    const p = poll({ assistantText: "是否继续安装依赖？" });
    const prev = baseline("安装中");
    expect(questionDetectionEnabled({})).toBe(false);
    expect(questionDetectionEnabled({ userGate: "   " })).toBe(false);
    expect(questionDetectionEnabled({ userGate: "[class*='ask']" })).toBe(true);
    // 未配置 → 不注入 question（判据默认禁用）
    expect(withDetectedQuestion(p, prev, {}).question).toBeUndefined();
    // 配置 → 注入 question，交给判定层转 needs_user
    expect(withDetectedQuestion(p, prev, { userGate: "[class*='ask']" }).question).toBe(
      "是否继续安装依赖？",
    );
    // 页面若直接给出 question（未来接缝），不再被检测覆盖
    expect(withDetectedQuestion({ ...p, question: "原文" }, prev, {}).question).toBe("原文");
  });

  it("userGate 命中 → needs_user（user_gate 证据），优先于完成判定", () => {
    const verdict = round(
      poll({ userGateVisible: true, assistantText: "已完成回复" }),
      baseline("已完成回复"),
      { since: 0 },
      1,
    );
    expect(verdict.kind).toBe("needs_user");
    expect(verdict.evidence).toContain("user_gate");
  });

  it("userGate 命中时不再走提问检测：question 保持为空，由 userGate 独立判定", () => {
    const verdict = round(
      poll({ userGateVisible: true, assistantText: "请确认是否继续？" }),
      baseline("安装中"),
      { since: 0 },
      1,
    );
    expect(verdict.kind).toBe("needs_user");
    expect(verdict.evidence).toContain("user_gate");
    expect(verdict.question).toBeUndefined();
  });
});