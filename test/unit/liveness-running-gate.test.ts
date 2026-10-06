import { describe, expect, it } from "vitest";
import { initialCodexState, judgeCodexPoll, type CodexPollState } from "../../src/agents/codex/liveness.js";
import {
  initialKimicodeState,
  judgeKimicodePoll,
  hashText,
  type KimicodePoll,
  type KimicodePollState,
} from "../../src/agents/kimicode/liveness.js";
import {
  initialMinimaxState,
  judgeMinimaxPoll,
  type MinimaxPoll,
  type MinimaxPollState,
} from "../../src/agents/minimax/liveness.js";
import {
  initialOpenDesignState,
  judgeOpenDesignPoll,
  pollFingerprint,
  type OpenDesignPoll,
  type OpenDesignPollState,
} from "../../src/agents/opendesign/liveness.js";
import { judgeZcodePoll, type ZcodePollState } from "../../src/agents/zcode/liveness.js";

/**
 * issue #31：完成判定的「曾观测到运行信号」门（跨 driver 契约测试）。
 *
 * 本文件把同一条不变量在**全部 driver** 上一次性钉死，而不是逐个 driver 各写一份——
 * 因为这条不变量的违反点历史上就是这么扩散的（Codex 有门，ZCode/Kimi/MiniMax/OD 忘了）。
 *
 * 不变量（对齐 ARCHITECTURE.md §8.3 流程图与 §8.4 取值表）：
 *   1. 本轮**从未**观测到运行信号 → 永远不得判 `finished`；
 *   2. 该情形只允许收敛为 `idle_timeout`（异常结束、保留实例）；
 *   3. 曾观测到运行信号后再静止 → 仍须正常判 `finished`（回归面：加门不得误伤正常完成）。
 *
 * 复现来源：`.rivet/scratch/issue31-red.ts` 的 RED 探针（本文件是其转正形态）。
 */

const STABLE_ROUNDS = 4;
const POLL_MS = 3_000;
const IDLE_MS = 15_000;
const STALL_MS = 300_000;
const T0 = 1_000_000;
/** 足够走完「4 轮建稳定基线 + 空闲计时耗尽」的轮数 */
const ROUNDS = 12;

/** 断言 1+2：全程无运行信号时不得出现 finished，且必须收敛为 idle_timeout */
function expectNeverFinishedWithoutRunSignal(kinds: string[]) {
  expect(kinds).not.toContain("finished");
  expect(kinds).toContain("idle_timeout");
}

describe("issue #31 · 无运行信号不得判完成（跨 driver 契约）", () => {
  it("ZCode：从未见 stop/loading/activeTool → 不判 finished，收敛 idle_timeout", () => {
    let state: ZcodePollState = { hash: "", stable: 0, idleSince: 0, sawRunning: false };
    const kinds: string[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const v = judgeZcodePoll(
        {
          stopVisible: false,
          loading: false,
          activeTool: false,
          // 选择器漂移场景：任务其实仍在进行，但界面「看起来」静止
          assistantText: "正在分析需求",
          inputEnabled: true,
          sendEnabled: false,
        },
        state,
        STABLE_ROUNDS,
        IDLE_MS,
        T0 + i * POLL_MS,
      );
      kinds.push(v.kind);
      state = v.state;
    }
    expectNeverFinishedWithoutRunSignal(kinds);
  });

  it("Kimi Code：从未见 stop/sendStarting → 不判 finished，收敛 idle_timeout", () => {
    let state: KimicodePollState = initialKimicodeState();
    const stall = { since: 0 };
    const poll: KimicodePoll = {
      stopVisible: false,
      sendStarting: false,
      assistantText: "正在分析需求",
      retryVisible: false,
      inputText: "",
      sendEnabled: false,
      pageHidden: false,
    };
    const kinds: string[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const v = judgeKimicodePoll(poll, state, STABLE_ROUNDS, IDLE_MS, STALL_MS, stall, T0 + i * POLL_MS);
      kinds.push(v.kind);
      state = v.state;
    }
    expectNeverFinishedWithoutRunSignal(kinds);
  });

  it("MiniMax Code：从未见 stop-button → 不判 finished，收敛 idle_timeout", () => {
    let state: MinimaxPollState = initialMinimaxState();
    const stall = { since: 0 };
    const poll: MinimaxPoll = {
      stopVisible: false,
      assistantText: "正在分析需求",
      retryVisible: false,
      inputText: "",
      sendEnabled: false,
      pageHidden: false,
    };
    const kinds: string[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const v = judgeMinimaxPoll(poll, state, STABLE_ROUNDS, IDLE_MS, STALL_MS, stall, T0 + i * POLL_MS);
      kinds.push(v.kind);
      state = v.state;
    }
    expectNeverFinishedWithoutRunSignal(kinds);
  });

  it("Open Design：从未见 stop/sendStarting → 不判 finished，收敛 idle_timeout", () => {
    let state: OpenDesignPollState = initialOpenDesignState();
    const stall = { since: 0 };
    const poll: OpenDesignPoll = {
      stopVisible: false,
      sendStarting: false,
      conversationText: "正在生成页面",
      // 产物指纹恒定：证明「产物不变」也不能单独充当运行信号
      artifactSignature: "index.html:1024:1700000000000",
    };
    const kinds: string[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const v = judgeOpenDesignPoll(poll, state, STABLE_ROUNDS, IDLE_MS, STALL_MS, stall, T0 + i * POLL_MS);
      kinds.push(v.kind);
      state = v.state;
    }
    expectNeverFinishedWithoutRunSignal(kinds);
  });

  it("Codex（对照组，门在 issue 前已存在）：同样不判 finished", () => {
    let state: CodexPollState = initialCodexState();
    const kinds: string[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const v = judgeCodexPoll(
        { stopVisible: false, composerText: "", conversationText: "正在分析需求", loginVisible: false },
        state,
        STABLE_ROUNDS,
        IDLE_MS,
        T0 + i * POLL_MS,
        STALL_MS,
      );
      kinds.push(v.kind);
      state = v.state;
    }
    expectNeverFinishedWithoutRunSignal(kinds);
  });
});

describe("issue #31 · 回归面：曾观测到运行信号后仍正常判完成", () => {
  it("ZCode：先在跑（stop）→ 再静止 → finished", () => {
    let state: ZcodePollState = { hash: "", stable: 0, idleSince: 0, sawRunning: false };
    // 第 1 轮：权威运行信号出现
    const running = judgeZcodePoll(
      { stopVisible: true, loading: false, activeTool: false, assistantText: "回复中", inputEnabled: false, sendEnabled: false },
      state,
      STABLE_ROUNDS,
      IDLE_MS,
      T0,
    );
    expect(running.kind).toBe("running");
    state = running.state;

    // 之后：运行信号消失，文本稳定
    const kinds: string[] = [];
    for (let i = 1; i <= STABLE_ROUNDS + 1; i++) {
      const v = judgeZcodePoll(
        { stopVisible: false, loading: false, activeTool: false, assistantText: "回复中", inputEnabled: true, sendEnabled: false },
        state,
        STABLE_ROUNDS,
        IDLE_MS,
        T0 + i * POLL_MS,
      );
      kinds.push(v.kind);
      state = v.state;
    }
    expect(kinds).toContain("finished");
  });

  it("Kimi Code：先在跑（stop）→ 再静止 → finished", () => {
    let state: KimicodePollState = initialKimicodeState();
    const stall = { since: 0 };
    const running = judgeKimicodePoll(
      { stopVisible: true, sendStarting: false, assistantText: "回复中", retryVisible: false, inputText: "", sendEnabled: false, pageHidden: false },
      state,
      STABLE_ROUNDS,
      IDLE_MS,
      STALL_MS,
      stall,
      T0,
    );
    expect(running.kind).toBe("running");
    state = running.state;

    const kinds: string[] = [];
    for (let i = 1; i <= STABLE_ROUNDS + 1; i++) {
      const v = judgeKimicodePoll(
        { stopVisible: false, sendStarting: false, assistantText: "回复中", retryVisible: false, inputText: "", sendEnabled: false, pageHidden: false },
        state,
        STABLE_ROUNDS,
        IDLE_MS,
        STALL_MS,
        stall,
        T0 + i * POLL_MS,
      );
      kinds.push(v.kind);
      state = v.state;
    }
    expect(kinds).toContain("finished");
  });

  it("MiniMax Code：先在跑（stop）→ 再静止 → finished", () => {
    let state: MinimaxPollState = initialMinimaxState();
    const stall = { since: 0 };
    const running = judgeMinimaxPoll(
      { stopVisible: true, assistantText: "回复中", retryVisible: false, inputText: "", sendEnabled: false, pageHidden: false },
      state,
      STABLE_ROUNDS,
      IDLE_MS,
      STALL_MS,
      stall,
      T0,
    );
    expect(running.kind).toBe("running");
    state = running.state;

    const kinds: string[] = [];
    for (let i = 1; i <= STABLE_ROUNDS + 1; i++) {
      const v = judgeMinimaxPoll(
        { stopVisible: false, assistantText: "回复中", retryVisible: false, inputText: "", sendEnabled: false, pageHidden: false },
        state,
        STABLE_ROUNDS,
        IDLE_MS,
        STALL_MS,
        stall,
        T0 + i * POLL_MS,
      );
      kinds.push(v.kind);
      state = v.state;
    }
    expect(kinds).toContain("finished");
  });

  it("Open Design：先在跑（stop）→ 再静止（文本+产物双稳定）→ finished", () => {
    let state: OpenDesignPollState = initialOpenDesignState();
    const stall = { since: 0 };
    const running = judgeOpenDesignPoll(
      { stopVisible: true, sendStarting: false, conversationText: "生成中", artifactSignature: "index.html:1024:1700000000000" },
      state,
      STABLE_ROUNDS,
      IDLE_MS,
      STALL_MS,
      stall,
      T0,
    );
    expect(running.kind).toBe("running");
    state = running.state;

    const kinds: string[] = [];
    for (let i = 1; i <= STABLE_ROUNDS + 1; i++) {
      const v = judgeOpenDesignPoll(
        { stopVisible: false, sendStarting: false, conversationText: "生成中", artifactSignature: "index.html:1024:1700000000000" },
        state,
        STABLE_ROUNDS,
        IDLE_MS,
        STALL_MS,
        stall,
        T0 + i * POLL_MS,
      );
      kinds.push(v.kind);
      state = v.state;
    }
    expect(kinds).toContain("finished");
  });
});

describe("issue #31 · 重观察轮种子（reobserve seed）", () => {
  /**
   * `user_confirmation` 恢复走「重连观察、不发送」，被观察的 turn 在恢复**之前**就已确认在运行。
   * run.ts 在 isReobserve 时把 state.sawRunning 种为 true（照 codex/run.ts 的做法）。
   * 不种的话，「恢复后 turn 恰好已完成 → 观察期内从未见运行信号 → 判不了 finished
   * → 白等 idleTimeoutMs 误落 idle_timeout」。
   *
   * 这里钉死种子在纯函数层的语义：默认起点无运行信号；种子后即可正常判 finished。
   * run.ts 的接线（三处 isReobserve → sawRunningSeed:true）由集成层覆盖。
   */
  it("默认起点不携带运行信号（未种子 → 判不了完成）", () => {
    expect(initialKimicodeState().sawRunning).toBe(false);
    expect(initialMinimaxState().sawRunning).toBe(false);
    expect(initialOpenDesignState().sawRunning).toBe(false);
    expect(initialCodexState().sawRunning).toBe(false);
  });

  it("种子 sawRunning=true 后，恢复轮里已完成且稳定的 turn 能正常判 finished", () => {
    // 模拟「恢复时 turn 已经跑完」：文本稳定、无任何运行信号，仅靠种子获得完成资格。
    const text = "已完成全部改动";
    const prev = { hash: pollFingerprint({ stopVisible: false, conversationText: text }), stable: 99, idleSince: 0, sawRunning: true };
    const v = judgeOpenDesignPoll(
      { stopVisible: false, sendStarting: false, conversationText: text },
      prev,
      STABLE_ROUNDS,
      IDLE_MS,
      STALL_MS,
      { since: 0 },
      T0,
    );
    expect(v.kind).toBe("finished");
  });

  it("同一场景若不种子（sawRunning=false）→ 判不了完成（证明种子是必需的）", () => {
    const text = "已完成全部改动";
    const prev = { hash: pollFingerprint({ stopVisible: false, conversationText: text }), stable: 99, idleSince: 0, sawRunning: false };
    const v = judgeOpenDesignPoll(
      { stopVisible: false, sendStarting: false, conversationText: text },
      prev,
      STABLE_ROUNDS,
      IDLE_MS,
      STALL_MS,
      { since: 0 },
      T0,
    );
    expect(v.kind).not.toBe("finished");
  });
});

describe("issue #31 · 发送确认阶段的运行信号必须传给观察循环", () => {
  /**
   * 执行期发现（计划外）：发送确认循环本就会 poll()，并已把真实运行信号累加进
   * 各 driver 的 `seenRunning`，但该变量此前只用于「发送是否确认」判据，**从未传给观察循环**。
   * 加门之后，若选择器漂移、或 turn 在观察循环开始前已跑完，观察循环整段采不到运行信号
   * → 判不了 finished → 已启动的任务被误落 idle_timeout。
   *
   * 本组用例钉死「种子 → 可判完成」的语义契约（run.ts 的接线由集成测试覆盖，
   * 见 test/integration/zcode-flow.test.ts 与 kimicode-flow.test.ts）。
   */
  it("种子后：发送阶段见过运行信号的任务在观察循环里能正常判完成", () => {
    const text = "已完成开发";
    // 模拟观察循环起点：文本已稳定、无运行信号，但发送阶段见过 → 种 sawRunning
    const seeded = { hash: hashText(text), stable: 99, idleSince: 0, sawRunning: true };
    const verdict = judgeKimicodePoll(
      {
        stopVisible: false,
        sendStarting: false,
        assistantText: text,
        retryVisible: false,
        inputText: "",
        sendEnabled: false,
        pageHidden: false,
      },
      seeded,
      STABLE_ROUNDS,
      IDLE_MS,
      STALL_MS,
      { since: 0 },
      T0,
    );
    expect(verdict.kind).toBe("finished");
  });

  it("未种子（发送阶段也没见过信号）→ 同一场景判不了完成，只能收敛 idle_timeout", () => {
    const text = "已完成开发";
    const unseeded = { hash: hashText(text), stable: 99, idleSince: 0, sawRunning: false };
    const poll = {
      stopVisible: false,
      sendStarting: false,
      assistantText: text,
      retryVisible: false,
      inputText: "",
      sendEnabled: false,
      pageHidden: false,
    };
    const verdict = judgeKimicodePoll(
      poll,
      unseeded,
      STABLE_ROUNDS,
      IDLE_MS,
      STALL_MS,
      { since: 0 },
      T0,
    );
    expect(verdict.kind).not.toBe("finished");
    // 空闲耗尽后如实落 idle_timeout（保留实例、可 continue 恢复）
    expect(
      judgeKimicodePoll(poll, verdict.state, STABLE_ROUNDS, IDLE_MS, STALL_MS, { since: 0 }, T0 + IDLE_MS + 1)
        .kind,
    ).toBe("idle_timeout");
  });
});
