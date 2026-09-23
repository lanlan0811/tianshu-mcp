/**
 * 单元测试：Qoder 选择器分层结构（issue #23 D2）。
 * 锁定分层 spec 完整性、候选顺序（覆盖优先）、以及向后兼容的 selector() 语义。
 */
import { describe, it, expect } from "vitest";
import { QODER_SELECTORS, qoderCandidates, qoderPrimary, type QoderSelectorSpec } from "../../src/agents/qoder/selectors.js";

describe("Qoder 选择器分层结构", () => {
  it("每个语义键都有 primary / fallbacks / verifiedVersion / note", () => {
    for (const [key, spec] of Object.entries(QODER_SELECTORS) as [string, QoderSelectorSpec][]) {
      expect(spec.primary.length, `${key}.primary 为空`).toBeGreaterThan(0);
      expect(Array.isArray(spec.fallbacks), `${key}.fallbacks 非数组`).toBe(true);
      expect(typeof spec.verifiedVersion, `${key}.verifiedVersion 非字符串`).toBe("string");
      expect(spec.verifiedVersion.length, `${key}.verifiedVersion 为空`).toBeGreaterThan(0);
      expect(typeof spec.note).toBe("string");
    }
  });

  it("workspace 主选择器为唯一 aria-label（0.3.4 真机：data-* 标记有 2 个会歧义）", () => {
    // issue #23 真机重探修正：0.3.4 有两个 [data-workspace-picker-trigger]，旧 primary 会歧义失败；
    // 唯一标识是 aria-label「切换或清空当前工作区，当前为 <名>」，故它是 primary，data-* 降为回退。
    expect(QODER_SELECTORS.workspace.primary).toBe('button[aria-label^="切换或清空当前工作区"]');
    const list = qoderCandidates("workspace");
    expect(list).toContain("[data-workspace-picker-trigger]");
    expect(list.indexOf(QODER_SELECTORS.workspace.primary)).toBe(0);
    // 不能把宽泛的 switch 标记混入主选择器
    expect(QODER_SELECTORS.workspace.primary).not.toContain("[data-workspace-picker-trigger]");
  });

  it("workspaceSearch / workspaceMenu 标记 0.3.4 已实测", () => {
    expect(QODER_SELECTORS.workspaceSearch.primary).toBe('input[aria-label="搜索工作区"]');
    expect(QODER_SELECTORS.workspaceSearch.verifiedVersion).toBe("0.3.4");
    expect(QODER_SELECTORS.workspaceMenu.verifiedVersion).toBe("0.3.4");
  });
});

describe("qoderCandidates 顺序与覆盖", () => {
  it("默认顺序：primary 在前，fallbacks 在后", () => {
    const list = qoderCandidates("workspace");
    expect(list[0]).toBe(QODER_SELECTORS.workspace.primary);
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  it("覆盖值优先级最高且去重", () => {
    const list = qoderCandidates("workspace", { workspace: ".my-ws" });
    expect(list[0]).toBe(".my-ws");
    expect(list).toContain(QODER_SELECTORS.workspace.primary);
    expect(new Set(list).size).toBe(list.length);
  });

  it("qoderPrimary 返回覆盖值/首选", () => {
    expect(qoderPrimary("workspace")).toBe(QODER_SELECTORS.workspace.primary);
    expect(qoderPrimary("workspace", { workspace: ".x" })).toBe(".x");
  });
});
