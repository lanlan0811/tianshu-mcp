/**
 * 发送段判据测试（步 7/8）。
 *
 * 四条纪律固化为回归：
 * 1. **发送前回读**：输入框不含本次任务标记就不点发送（否则会派一份空任务）；受控编辑器
 *    可能晚一拍才反映 `insertText`，因此**重读一次**（计划 §5「重试一次后硬失败」）；
 * 2. **发送按钮不可用 → 重试一次**，仍不可用才硬失败；
 * 3. **只点一次、绝不重发**：确认不到只报 `send_unknown`，不重试（第一次点击可能已生效，再点就是重复派单）；
 * 4. 确认证据分三种（消息落地 / 运行信号 / 输入框清空），但**清空单独不算成功**。
 */
import { describe, expect, it } from "vitest";
import {
  dispatchTask,
  judgeSendConfirmation,
  type OpenDesignSendPage,
} from "../../src/agents/opendesign/send.js";
import type { OpenDesignPollSnapshot } from "../../src/agents/opendesign/cdp.js";

const MARKER = "【tianshu:tsk_x:r0:initial】";

interface StubState {
  inputText: string;
  conversation: string;
  /** 点击发送后产生什么证据 */
  effect?: {
    conversationGrew?: boolean;
    running?: boolean;
    clearInput?: boolean;
  };
  /** 发送按钮可见命中数（≠1 即「不可唯一点击」） */
  sendCount?: number;
  sendClicked?: boolean;
  /** 前 N 次点击发送按钮返回「不可用」（复刻按钮尚未就绪，验证重试一次） */
  sendUnavailableTimes?: number;
  /** 前 N 次输入回读返回「不含标记」的值（复刻编辑器晚一拍才反映 insertText） */
  staleInputTimes?: number;
  /** 清空输入框失败（复刻输入框无法唯一定位）——此时**绝不能**发送 */
  clearInputFails?: boolean;
}

function makePage(state: StubState) {
  let sendClicks = 0;
  let inputReads = 0;
  const page: OpenDesignSendPage = {
    inputText: async () => {
      inputReads += 1;
      if ((state.staleInputTimes ?? 0) >= inputReads) return "";
      return state.inputText;
    },
    conversationText: async () => state.conversation,
    clearInput: async () => {
      if (state.clearInputFails) return false;
      state.inputText = "";
      return true;
    },
    typeText: async (text) => {
      // 与真机同语义：insertText 是**插到光标处**，不清空就会与残留文本混在一起
      state.inputText += text;
    },
    clickKey: async () => {
      sendClicks += 1;
      const count = state.sendCount ?? 1;
      if ((state.sendUnavailableTimes ?? 0) >= sendClicks) return { clicked: false, count: 0 };
      if (count !== 1) return { clicked: false, count };
      const effect = state.effect ?? {};
      if (effect.conversationGrew) state.conversation += `\n${state.inputText}`;
      if (effect.clearInput) state.inputText = "";
      return { clicked: state.sendClicked ?? true, count: 1 };
    },
    poll: async (): Promise<OpenDesignPollSnapshot> => ({
      stopVisible: Boolean(state.effect?.running),
      sendStarting: false,
      conversationText: state.conversation,
      inputText: state.inputText,
      pageHidden: false,
      errorText: "",
    }),
    waitFor: async (_predicate, timeoutMs) =>
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), Math.min(timeoutMs, 10))),
    sleep: async (ms) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 5))),
  };
  return { page, sendClicks: () => sendClicks };
}

describe("judgeSendConfirmation：派发确认判据", () => {
  it("消息落地或运行信号任一成立即算已派发", () => {
    expect(
      judgeSendConfirmation({ seenMessage: true, seenRunning: false, inputCleared: false }),
    ).toBe(true);
    expect(
      judgeSendConfirmation({ seenMessage: false, seenRunning: true, inputCleared: false }),
    ).toBe(true);
  });

  it("只有「输入框被清空」不算成功（可能是误触/Escape，宁可报未知）", () => {
    expect(
      judgeSendConfirmation({ seenMessage: false, seenRunning: false, inputCleared: true }),
    ).toBe(false);
  });
});

describe("dispatchTask：输入并发送", () => {
  it("输入框有残留模板 → 先清空再输入，标记读得到并正常发送（真机 2026-09-28 回归）", async () => {
    // 真机现象：首页输入框残留产品模板（「游戏化习惯应用…」），insertText 插到光标处，
    // 结果「模板 + 任务书」混成 55 字、回读不含标记 → fail-closed 放弃发送。
    // 用户看到的现象就是「没有点击发送按钮」。
    const state: StubState = {
      inputText: "游戏化习惯应用 设计一款把每日习惯变成闯关任务的应用",
      conversation: "",
      effect: { conversationGrew: true },
    };
    const { page } = makePage(state);
    const res = await dispatchTask({
      page,
      text: `${MARKER}\n任务书正文`,
      marker: MARKER,
      confirmBudgetMs: 200,
      pollIntervalMs: 10,
    });
    expect(res.ok).toBe(true);
    // 关键：输入框里**只有**本次任务（残留被清掉了），而不是模板与任务混杂
    expect(state.conversation).toContain("任务书正文");
    expect(state.conversation).not.toContain("游戏化习惯应用");
  });

  it("输入框无法唯一定位（清空失败）→ input_mismatch 且不发送", async () => {
    const state: StubState = {
      inputText: "残留文本",
      conversation: "",
      clearInputFails: true,
    };
    const { page, sendClicks } = makePage(state);
    const res = await dispatchTask({
      page,
      text: `${MARKER}\n任务书正文`,
      marker: MARKER,
      confirmBudgetMs: 200,
      pollIntervalMs: 10,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("input_mismatch");
    // 清不掉旧文本就绝不输入、更不发送，避免把任务插进残留内容里
    expect(state.inputText).toBe("残留文本");
    expect(sendClicks()).toBe(0);
  });

  it("输入框始终不含标记 → input_mismatch，且**不点发送**", async () => {
    const state: StubState = { inputText: "", conversation: "" };
    const { page, sendClicks } = makePage(state);
    // typeText 被替换成「什么都没输进去」（复刻 insertText 没落进受控编辑器）
    const broken: OpenDesignSendPage = { ...page, typeText: async () => {} };
    const out = await dispatchTask({
      page: broken,
      text: `${MARKER}\n任务`,
      marker: MARKER,
      confirmBudgetMs: 200,
      pollIntervalMs: 5,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("input_mismatch");
    expect(sendClicks()).toBe(0);
  });

  it("编辑器晚一拍才反映输入 → 重读一次后正常发送（不误判 input_mismatch）", async () => {
    const state: StubState = {
      inputText: "",
      conversation: "",
      staleInputTimes: 1, // 首次回读为空，重读才拿到文本
      effect: { conversationGrew: true, running: true },
    };
    const { page, sendClicks } = makePage(state);
    const out = await dispatchTask({
      page,
      text: `${MARKER}\n任务`,
      marker: MARKER,
      confirmBudgetMs: 200,
      pollIntervalMs: 5,
    });
    expect(out.ok).toBe(true);
    expect(sendClicks()).toBe(1);
  });

  it("发送按钮前一次不可用 → 重试一次后成功", async () => {
    const state: StubState = {
      inputText: "",
      conversation: "",
      sendUnavailableTimes: 1, // 第一次点不到，重试成功
      effect: { conversationGrew: true, running: true },
    };
    const { page, sendClicks } = makePage(state);
    const out = await dispatchTask({
      page,
      text: `${MARKER}\n任务`,
      marker: MARKER,
      confirmBudgetMs: 200,
      pollIntervalMs: 5,
    });
    expect(out.ok).toBe(true);
    expect(sendClicks()).toBe(2);
  });

  it("发送按钮始终不可唯一点击 → send_failed（含重试共 2 次尝试）", async () => {
    const state: StubState = { inputText: "", conversation: "", sendCount: 2 };
    const { page, sendClicks } = makePage(state);
    const out = await dispatchTask({
      page,
      text: `${MARKER}\n任务`,
      marker: MARKER,
      confirmBudgetMs: 200,
      pollIntervalMs: 5,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("send_failed");
    expect(out.message).toContain("已尝试 2 次");
    expect(sendClicks()).toBe(2);
  });

  it("消息落地 → 确认成功（只点一次）", async () => {
    const state: StubState = {
      inputText: "",
      conversation: "",
      effect: { conversationGrew: true, running: true },
    };
    const { page, sendClicks } = makePage(state);
    const out = await dispatchTask({
      page,
      text: `${MARKER}\n任务`,
      marker: MARKER,
      confirmBudgetMs: 200,
      pollIntervalMs: 5,
    });
    expect(out.ok).toBe(true);
    expect(out.evidence?.seenMessage).toBe(true);
    expect(sendClicks()).toBe(1);
  });

  it("无任何证据 → send_unknown 且绝不重发（点击次数恒为 1）", async () => {
    const state: StubState = { inputText: "", conversation: "", effect: {} };
    const { page, sendClicks } = makePage(state);
    const out = await dispatchTask({
      page,
      text: `${MARKER}\n任务`,
      marker: MARKER,
      confirmBudgetMs: 50,
      pollIntervalMs: 5,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("send_unknown");
    expect(out.message).toContain("不重复发送");
    expect(sendClicks()).toBe(1);
  });
});