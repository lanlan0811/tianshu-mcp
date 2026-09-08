/**
 * 单元测试：TraeWork 选择器表与回退（开发计划 §4.6）。
 */
import { describe, it, expect } from "vitest";
import { SELECTORS, resolveSelectors, candidateArrayExpr } from "../../src/agents/traework/cdp/selectors.js";

describe("选择器表", () => {
  it("包含实现所需的关键语义键", () => {
    const required = [
      "chatInput",
      "newTask",
      "taskListItem",
      "modelTrigger",
      "modelTriggerValue",
      "modelOption",
      "projectButton",
      "cascadeMenu",
      "cascadeMenuItem",
      "cascadeMenuFooter",
      "messageContainer",
      "toolCard",
    ];
    for (const k of required) {
      expect(SELECTORS[k as keyof typeof SELECTORS], `缺少选择器: ${k}`).toBeDefined();
    }
  });

  it("每个语义键都有主选择器与回退候选", () => {
    for (const [key, spec] of Object.entries(SELECTORS)) {
      expect(spec.primary.length, `${key}.primary 为空`).toBeGreaterThan(0);
      expect(Array.isArray(spec.fallbacks), `${key}.fallbacks 非数组`).toBe(true);
      expect(typeof spec.note).toBe("string");
    }
  });

  it("实测项标记 verified=true（含聊天输入与新建任务）", () => {
    expect(SELECTORS.chatInput.verified).toBe(true);
    expect(SELECTORS.newTask.verified).toBe(true);
    expect(SELECTORS.projectButton.verified).toBe(true);
    expect(SELECTORS.cascadeMenuItem.verified).toBe(true);
  });
});

describe("resolveSelectors", () => {
  it("默认顺序：主选择器在前，回退在后", () => {
    const list = resolveSelectors("chatInput");
    expect(list[0]).toBe(SELECTORS.chatInput.primary);
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  it("覆盖值优先级最高", () => {
    const list = resolveSelectors("chatInput", { chatInput: ".my-custom-input" });
    expect(list[0]).toBe(".my-custom-input");
    expect(list).toContain(SELECTORS.chatInput.primary);
  });

  it("去重且保序", () => {
    const list = resolveSelectors("newTask", { newTask: SELECTORS.newTask.primary });
    expect(new Set(list).size).toBe(list.length);
  });

  it("未知语义键抛错", () => {
    expect(() => resolveSelectors("notExist" as never)).toThrow(/未知选择器/);
  });
});

describe("candidateArrayExpr", () => {
  it("生成可解析的 JSON 数组字面量", () => {
    const expr = candidateArrayExpr("modelOption");
    const arr = JSON.parse(expr) as string[];
    expect(Array.isArray(arr)).toBe(true);
    expect(arr[0]).toBe(SELECTORS.modelOption.primary);
  });

  it("覆盖值出现在数组首位", () => {
    const arr = JSON.parse(candidateArrayExpr("cascadeMenuItem", { cascadeMenuItem: ".x" })) as string[];
    expect(arr[0]).toBe(".x");
  });
});
