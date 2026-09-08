/**
 * 单元测试：TraeWork 回复提取与完成判定（纯函数，开发计划 §7）。
 * 覆盖：标记提取、完成标志截断、稳定兜底、ask_user 挂起、原生工具痕迹、模型名匹配。
 */
import { describe, it, expect } from "vitest";
import {
  cutAtCompletionMark,
  hasCompletionMark,
  hasNativeToolTrace,
  isAskUserPending,
  isThinking,
  judgePoll,
  makeMarker,
  modelNameMatch,
  normModelName,
  parseAdded,
  stripStaleBase,
} from "../../src/agents/traework/ui/reply.js";

describe("marker 与完成标志", () => {
  it("makeMarker 生成唯一标记", () => {
    const a = makeMarker();
    const b = makeMarker();
    expect(a).toMatch(/^【ts[a-z0-9]+】$/);
    expect(a).not.toBe(b);
  });

  it("cutAtCompletionMark 在「由AI生成」处截断（含空格变体）", () => {
    expect(cutAtCompletionMark("正文内容由AI生成12:30")).toBe("正文内容");
    expect(cutAtCompletionMark("正文内容由 AI 生成 12:30")).toBe("正文内容");
    expect(cutAtCompletionMark("无标志内容")).toBe("无标志内容");
  });

  it("hasCompletionMark / isThinking 识别状态词", () => {
    expect(hasCompletionMark("xx由AI生成")).toBe(true);
    expect(hasCompletionMark("xx由 AI 生成")).toBe(true);
    expect(hasCompletionMark("xx")).toBe(false);
    expect(isThinking("思考中")).toBe(true);
    expect(isThinking("已完成")).toBe(false);
  });
});

describe("ask_user 与原生工具痕迹", () => {
  it("识别 ask_user 挂起", () => {
    expect(isAskUserPending("正在向用户提问：请选择方案")).toBe(true);
    expect(isAskUserPending("等待你的回复")).toBe(true);
    expect(isAskUserPending("已完成")).toBe(false);
  });

  it("只认真正的工具执行证据，收尾样板不算", () => {
    expect(hasNativeToolTrace("已执行 3 条命令")).toBe(true);
    expect(hasNativeToolTrace("命令已真实执行")).toBe(true);
    expect(hasNativeToolTrace("退出码 1")).toBe(true);
    // 收尾样板（每条回复都带）绝不能当痕迹
    expect(hasNativeToolTrace("任务耗时 12.5s已初始化环境")).toBe(false);
    expect(hasNativeToolTrace("")).toBe(false);
  });
});

describe("stripStaleBase", () => {
  it("裁掉尾部历史", () => {
    expect(stripStaleBase("新内容旧历史", "旧历史")).toBe("新内容");
  });
  it("不匹配时回退全窗口", () => {
    expect(stripStaleBase("新内容", "不匹配")).toBe("新内容");
  });
});

describe("parseAdded 文本清理", () => {
  it("去掉用户消息前缀与 TraeWork 前缀", () => {
    const r = parseAdded("我的问题12:30TraeWork这是回复");
    expect(r.content).toBe("这是回复");
  });

  it("去掉尾部完成标志、时间戳、消耗与收尾样板", () => {
    const r = parseAdded("12:30TraeWork任务耗时 3.2s已初始化环境实际回复内容由AI生成12:31");
    expect(r.content).toBe("实际回复内容");
  });

  it("分离思考过程与正文", () => {
    const r = parseAdded("12:30TraeWork思考过程先分析需求再写代码12:31");
    expect(r.reasoning).toContain("先分析需求");
  });

  it("空输入返回空", () => {
    expect(parseAdded("")).toEqual({ content: "", reasoning: "" });
  });
});

describe("judgePoll 轮询状态机", () => {
  const marker = "【tsabc123】";
  const initial = { prev: "", stable: 0, idleSince: 0 };
  const notRunning = { stopVisible: false, tailLoading: false, thinkingStream: false };

  it("出现完成标志即结束", () => {
    const v = judgePoll(`前缀${marker}回复内容由AI生成12:30`, marker, "", initial, 12);
    expect(v.kind).toBe("finished");
    if (v.kind === "finished") expect(v.added).toBe("回复内容");
  });

  it("思考中不判完成", () => {
    const v = judgePoll(`${marker}回复由AI生成思考中`, marker, "", initial, 12);
    expect(v.kind).toBe("pending");
  });

  it("ask_user 挂起立即结束", () => {
    const v = judgePoll(`${marker}正在向用户提问：选 A 还是 B`, marker, "", initial, 12);
    expect(v.kind).toBe("ask_user");
  });

  it("运行信号优先：即使有完成标志仍 pending", () => {
    const v = judgePoll(`${marker}回复由AI生成12:30`, marker, "", initial, 2, {
      liveness: { ...notRunning, stopVisible: true },
    });
    expect(v.kind).toBe("pending");
  });

  it("达到稳定轮数但未到 idleTimeoutMs 仍 pending，到时返回 idle", () => {
    const text = `${marker}一直没完成的正文`;
    const first = judgePoll(text, marker, "", initial, 2, { now: 1_000, idleTimeoutMs: 5_000 });
    expect(first.kind).toBe("pending");
    if (first.kind !== "pending") return;
    const second = judgePoll(text, marker, "", first.state, 2, { now: 2_000, idleTimeoutMs: 5_000 });
    expect(second.kind).toBe("pending");
    if (second.kind !== "pending") return;
    const threshold = judgePoll(text, marker, "", second.state, 2, { now: 3_000, idleTimeoutMs: 5_000 });
    expect(threshold.kind).toBe("pending");
    if (threshold.kind !== "pending") return;
    expect(threshold.state.idleSince).toBe(3_000);
    const idle = judgePoll(text, marker, "", threshold.state, 2, { now: 8_000, idleTimeoutMs: 5_000 });
    expect(idle.kind).toBe("idle");
  });

  it("内容持续变化则稳定计数归零", () => {
    const v1 = judgePoll(`${marker}内容1`, marker, "", { prev: "", stable: 5, idleSince: 123 }, 3);
    expect(v1.kind).toBe("pending");
    if (v1.kind === "pending") expect(v1.state).toEqual({ prev: `${marker}内容1`, stable: 0, idleSince: 0 });
  });

  it("运行信号清零稳定轮数与空闲计时", () => {
    const v = judgePoll(`${marker}静态`, marker, "", { prev: `${marker}静态`, stable: 9, idleSince: 100 }, 3, {
      liveness: { ...notRunning, tailLoading: true },
      now: 10_000,
      idleTimeoutMs: 1,
    });
    expect(v.kind).toBe("pending");
    if (v.kind === "pending") expect(v.state).toEqual({ prev: `${marker}静态`, stable: 0, idleSince: 0 });
  });

  it("thinkingStream 只作诊断，不阻塞完成", () => {
    const v = judgePoll(`${marker}已完成由AI生成`, marker, "", initial, 2, {
      liveness: { ...notRunning, thinkingStream: true },
    });
    expect(v.kind).toBe("finished");
  });

  it("未出现标记时保持 pending", () => {
    const v = judgePoll("完全无关的内容", marker, "", initial, 2);
    expect(v.kind).toBe("pending");
  });
});

describe("模型名匹配", () => {
  it("归一化去分隔符与补贴后缀", () => {
    expect(normModelName("GLM-5.3")).toBe("glm53");
    expect(normModelName("GLM-5.3专属补贴")).toBe("glm53");
  });

  it("精确匹配与档位后缀容错", () => {
    expect(modelNameMatch("GLM-5.3Max", "glm-5.3")).toBe(true);
    expect(modelNameMatch("GLM-5.3", "GLM-5.3")).toBe(true);
    expect(modelNameMatch("DeepSeek-V4-Flash", "DeepSeek-V4-Flash")).toBe(true);
  });

  it("拒绝版本号延续", () => {
    expect(modelNameMatch("GLM-5.3Max", "GLM-5")).toBe(false);
    expect(modelNameMatch("Kimi-K3", "Kimi-K2.7")).toBe(false);
  });

  it("空值不匹配", () => {
    expect(modelNameMatch("", "glm")).toBe(false);
    expect(modelNameMatch("glm", undefined)).toBe(false);
  });
});
