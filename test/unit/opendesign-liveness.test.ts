import { describe, expect, it } from "vitest";
import {
  artifactSignatureOf,
  detectQuestion,
  evidenceOf,
  hashText,
  initialOpenDesignState,
  judgeOpenDesignPoll,
  pollFingerprint,
  type OpenDesignPoll,
  type OpenDesignPollState,
  type OpenDesignStallSince,
} from "../../src/agents/opendesign/liveness.js";

const STABLE_ROUNDS = 3;
const IDLE_MS = 60_000;
const STALL_MS = 300_000;

function poll(over: Partial<OpenDesignPoll> = {}): OpenDesignPoll {
  return { stopVisible: false, conversationText: "生成中…", ...over };
}

/** 便捷判定：使用默认参数，可选覆盖 */
function judge(
  p: OpenDesignPoll,
  prev: OpenDesignPollState,
  stall: OpenDesignStallSince,
  now = Date.now(),
  deadline = Infinity,
) {
  return judgeOpenDesignPoll(p, prev, STABLE_ROUNDS, IDLE_MS, STALL_MS, stall, now, deadline);
}

describe("Open Design 运行检测：运行信号", () => {
  it("停止按钮可见 = 运行中，且清零稳定/空闲计时（长思考不得判完成）", () => {
    const prev: OpenDesignPollState = { hash: "x", stable: 9, idleSince: 1 };
    const stall: OpenDesignStallSince = { since: 0 };
    const v = judge(poll({ stopVisible: true }), prev, stall);
    expect(v.kind).toBe("running");
    expect(v.state.stable).toBe(0);
    expect(v.state.idleSince).toBe(0);
    expect(v.evidence).toContain("stop_button");
  });

  it("停止按钮久亮且文本与产物全静止 → needs_user（打破恒 running 死锁）", () => {
    const text = "等待你的确认";
    const prev: OpenDesignPollState = {
      hash: pollFingerprint(poll({ conversationText: text })),
      stable: 0,
      idleSince: 0,
    };
    const stall: OpenDesignStallSince = { since: 1_000 };
    const v = judge(
      poll({ stopVisible: true, conversationText: text }),
      prev,
      stall,
      1_000 + STALL_MS,
    );
    expect(v.kind).toBe("needs_user");
    expect(v.evidence).toContain("stall");
    expect(v.question).toContain("停止按钮持续可见");
  });

  it("停滞计时在文本变化时重置（内容还在更新就不能判等人）", () => {
    const stall: OpenDesignStallSince = { since: 1_000 };
    const prev: OpenDesignPollState = {
      hash: pollFingerprint(poll({ conversationText: "旧" })),
      stable: 0,
      idleSince: 0,
    };
    judge(poll({ stopVisible: true, conversationText: "新" }), prev, stall, 1_000 + STALL_MS);
    // 文本变了 → stallSince 被刷新为 now，因此本轮不判 needs_user
    expect(stall.since).toBe(1_000 + STALL_MS);
  });
});

describe("Open Design 运行检测：完成与超时", () => {
  it("无运行信号 + 指纹连续稳定达 stableRounds → finished", () => {
    const text = "设计稿已生成完成";
    const p = poll({ conversationText: text });
    let state = initialOpenDesignState();
    const base = 1_000_000;
    // 第 1 轮建立基线（stable=0），之后每轮 +1；达到 stableRounds 才判 finished
    const seen: string[] = [];
    for (let i = 0; i < STABLE_ROUNDS + 1; i++) {
      const v = judge(p, state, { since: 0 }, base + i * 3_000);
      seen.push(v.kind);
      state = v.state;
    }
    expect(seen.slice(0, STABLE_ROUNDS)).toEqual(Array(STABLE_ROUNDS).fill("running"));
    expect(seen.at(-1)).toBe("finished");
  });

  it("文本在变 → 稳定计数归零，绝不判完成", () => {
    const stall: OpenDesignStallSince = { since: 0 };
    let state: OpenDesignPollState = { hash: "", stable: 0, idleSince: 0 };
    for (const text of ["第一段", "第二段", "第三段"]) {
      const v = judge(poll({ conversationText: text }), state, stall);
      state = v.state;
      expect(v.kind).toBe("running");
      expect(v.state.stable).toBe(0);
    }
  });

  it("静止持续超过 idleTimeoutMs → idle_timeout（而非 finished）", () => {
    const text = "停住了";
    const p = poll({ conversationText: text });
    const fp = pollFingerprint(p);
    const now = 5_000_000;
    const prev: OpenDesignPollState = { hash: fp, stable: STABLE_ROUNDS, idleSince: now - IDLE_MS };
    const v = judge(p, prev, { since: 0 }, now);
    expect(v.kind).toBe("idle_timeout");
  });

  it("任务总时限到点判 timeout（即使界面仍显示无运行信号）", () => {
    const v = judge(
      poll({ conversationText: "产物写一半" }),
      initialOpenDesignState(),
      { since: 0 },
      9_999,
      9_999,
    );
    expect(v.kind).toBe("timeout");
    expect(v.evidence).toContain("deadline");
  });

  it("对话为空时不判完成（页面还没渲染出内容）", () => {
    const v = judge(poll({ conversationText: "" }), initialOpenDesignState(), { since: 0 });
    expect(v.kind).toBe("running");
  });
});

describe("Open Design 运行检测：产物信号", () => {
  it("文本不变但产物仍在写 → 不判静止（这是与纯对话 agent 的关键区别）", () => {
    const text = "正在生成页面";
    const now = 2_000_000;
    const before = poll({ conversationText: text, artifactSignature: "a:1:1" });
    const after = poll({ conversationText: text, artifactSignature: "a:2:2" });
    const prev: OpenDesignPollState = {
      hash: pollFingerprint(before),
      stable: STABLE_ROUNDS,
      idleSince: now - IDLE_MS,
    };
    const v = judge(after, prev, { since: 0 }, now);
    // 指纹变了 → 稳定计数归零 → 仍判运行中
    expect(v.kind).toBe("running");
    expect(v.state.stable).toBe(0);
  });

  it("文本与产物都稳定 → 正常判完成", () => {
    const p = poll({ conversationText: "完成", artifactSignature: "a:1:1" });
    const prev: OpenDesignPollState = {
      hash: pollFingerprint(p),
      stable: STABLE_ROUNDS - 1,
      idleSince: 0,
    };
    const v = judge(p, prev, { since: 0 }, 1_000_000);
    expect(v.kind).toBe("finished");
    expect(v.state.stable).toBe(STABLE_ROUNDS);
  });

  it("无产物监视（空串）时退化为纯文本判据，行为与既往一致", () => {
    const withEmpty = poll({ conversationText: "x", artifactSignature: "" });
    const without = poll({ conversationText: "x" });
    expect(pollFingerprint(withEmpty)).toBe(pollFingerprint(without));
  });

  it("artifactSignatureOf：排序后串接，mtime 取整（毫秒抖动不应造成假变化）", () => {
    const sig = artifactSignatureOf([
      { path: "b.html", size: 2, mtimeMs: 1_700_000_000_123.7 },
      { path: "a.html", size: 1, mtimeMs: 1_700_000_000_000.2 },
    ]);
    expect(sig).toBe("a.html:1:1700000000000|b.html:2:1700000000123");
    // 同一批文件的顺序变化不改变指纹
    expect(
      artifactSignatureOf([
        { path: "a.html", size: 1, mtimeMs: 1 },
        { path: "b.html", size: 2, mtimeMs: 2 },
      ]),
    ).toBe(
      artifactSignatureOf([
        { path: "b.html", size: 2, mtimeMs: 2 },
        { path: "a.html", size: 1, mtimeMs: 1 },
      ]),
    );
  });
});

describe("Open Design 运行检测：失败态与提问", () => {
  it("界面给出失败文案 → failed（绝不判完成）", () => {
    const prev: OpenDesignPollState = { hash: "x", stable: 9, idleSince: 1 };
    const v = judge(poll({ errorText: "生成失败：模型不可用" }), prev, { since: 0 });
    expect(v.kind).toBe("failed");
  });

  it("提问检测：无运行信号 + 空输入框 + 文本刚变化 + 问号结尾", () => {
    const text = "请问你希望用哪种配色方案？";
    const prev: OpenDesignPollState = { hash: "different", stable: 0, idleSince: 0 };
    const v = judge(poll({ conversationText: text, inputText: "" }), prev, { since: 0 });
    expect(v.kind).toBe("needs_user");
    expect(v.question).toContain("配色方案");
  });

  it("输入框非空时不判提问（用户正在写，别抢判）", () => {
    const text = "请问你希望用哪种配色方案？";
    const prev: OpenDesignPollState = { hash: "different", stable: 0, idleSince: 0 };
    const v = judge(poll({ conversationText: text, inputText: "我来回答" }), prev, { since: 0 });
    expect(v.kind).not.toBe("needs_user");
  });

  it("无上一轮基线时不判提问（首轮无基线，避免误判）", () => {
    expect(
      detectQuestion(poll({ conversationText: "要哪个？" }), initialOpenDesignState()),
    ).toBeUndefined();
  });

  it("文本未变化时不判提问（同一段问句不反复判成新提问）", () => {
    const p = poll({ conversationText: "要哪个？" });
    const prev: OpenDesignPollState = { hash: pollFingerprint(p), stable: 1, idleSince: 0 };
    expect(detectQuestion(p, prev)).toBeUndefined();
  });

  it("问句不以问号结尾时不判提问（保守：宁漏判不误判）", () => {
    const prev: OpenDesignPollState = { hash: "different", stable: 0, idleSince: 0 };
    expect(detectQuestion(poll({ conversationText: "请选择配色。" }), prev)).toBeUndefined();
  });
});

describe("Open Design 运行检测：辅助函数", () => {
  it("evidenceOf 汇总命中信号；无信号时为 none", () => {
    expect(evidenceOf(poll())).toBe("none");
    expect(evidenceOf(poll({ stopVisible: true, artifactSignature: "a:1:1" }))).toBe(
      "stop_button,artifact",
    );
  });

  it("hashText 稳定且短（12 位十六进制）", () => {
    expect(hashText("abc")).toBe(hashText("abc"));
    expect(hashText("abc")).toMatch(/^[0-9a-f]{12}$/);
    expect(hashText("abc")).not.toBe(hashText("abd"));
  });
});
