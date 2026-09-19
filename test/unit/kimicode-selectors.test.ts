/**
 * 选择器规范回归（真机教训，2026-09-20）。
 *
 * 背景：`click()` 的坐标点击要求「唯一可见匹配」，匹配数 ≠ 1 时它会退化为 DOM click，
 * 而 Kimi Code 的部分按钮只认 trusted 点击 → 表现为「点了毫无反应」。
 * 真机上 `newSession` 曾配了 `aside.side button` 这种宽泛回退：草稿页恰好只有少数侧栏按钮时
 * 侥幸命中 1 个，一旦停在会话页（侧栏按钮变多）就变成 6 个匹配，新建会话从此必然失败，
 * 且错误信息只会说「选择器未挂载」，极难定位。
 *
 * 因此这里把「窄回退」固化成断言，防止再次引入同类宽泛选择器。
 */
import { describe, expect, it } from "vitest";
import { KIMICODE_SELECTORS } from "../../src/agents/kimicode/selectors.js";

/** 已知的宽泛容器型选择器：单独作为回退会命中整片区域，绝不能出现在点击路径上 */
const BROAD_CONTAINER_SELECTORS = [
  "aside.side button",
  "aside button",
  "nav button",
  "aside.side button.search + button",
  "div[class]",
  "button",
];

describe("Kimi Code 选择器规范", () => {
  it("任何键的回退选择器都不得是宽泛容器型（多命中会让坐标点击失效）", () => {
    const offenders: string[] = [];
    for (const [key, spec] of Object.entries(KIMICODE_SELECTORS)) {
      for (const fallback of spec.fallbacks) {
        if (BROAD_CONTAINER_SELECTORS.includes(fallback.trim()))
          offenders.push(`${key}: ${fallback}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("newSession 的每个候选都必须锚定 btn-new-chat（唯一入口）", () => {
    const spec = KIMICODE_SELECTORS.newSession;
    expect(spec.primary).toBe("button.btn-new-chat");
    for (const candidate of [spec.primary, ...spec.fallbacks]) {
      expect(candidate).toContain("btn-new-chat");
    }
  });

  it("workspaceAddSession 天然多命中（每个工作区分组一个），故不得依赖唯一匹配", () => {
    const spec = KIMICODE_SELECTORS.workspaceAddSession;
    // 主选择器按 aria 定位（可读性），但多分组下仍会有多个 → 调用方必须用 clickFirst。
    expect(spec.primary).toContain("gh-add");
    expect(spec.note).toContain("clickFirst");
  });

  it("运行信号的选择器必须窄（stop 与 send 是权威判据，宽泛会误判运行中）", () => {
    expect(KIMICODE_SELECTORS.stopButton.primary).toBe("button.stop");
    expect(KIMICODE_SELECTORS.sendButton.primary).toBe("button.send");
    // 停止按钮不得混入「取消」等宽泛文案（等待用户界面会误命中，Codex 踩过同一个坑）。
    const stopTexts = KIMICODE_SELECTORS.stopButton.texts ?? [];
    expect(stopTexts.some((t) => t.includes("取消"))).toBe(false);
  });
});