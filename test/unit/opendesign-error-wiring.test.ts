/**
 * OpenDesign 失败态「采集链」回归（真机缺陷，2026-10-11，Open Design 0.24.1）。
 *
 * 真机现象（模型 cline-pass/deepseek-v4.1-flash）：
 *   模型侧失败后，界面明确显示：
 *     [data-testid="chat-run-error-card"]
 *       └ [data-testid="chat-run-error-description"]
 *            「AI 未能生成内容，请重新发起任务，或更换模型后再试。」
 *     上方还有 record-module 的 `运行失败 · 3m 39s`
 *   而适配器日志**持续**输出：
 *     `进度：running；运行证据=send_starting；回复哈希=512033bdec07；稳定轮=0`
 *   —— 一直空等到任务时限，从未识别失败。
 *
 * 根因（**判据层完好，接线层全缺**）：
 *   | 层                                   | 状态 |
 *   |--------------------------------------|------|
 *   | liveness.ts 类型 `errorText`          | 有   |
 *   | liveness.ts `evidenceOf` → error_text | 有   |
 *   | liveness.ts 判定 → kind="failed"      | 有（且有单测） |
 *   | cdp.ts `OpenDesignPollSnapshot`       | **缺** |
 *   | cdp.ts `pollExpression` 采集          | **缺** |
 *   | run.ts poll 组装传递                  | **缺** |
 *
 * 本文件专门盯**接线**：只测纯函数判据是抓不到这个缺陷的（那部分本来就是绿的）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, rel), "utf8");

const cdpTs = read("../../src/agents/opendesign/cdp.ts");
const runTs = read("../../src/agents/opendesign/run.ts");

describe("OpenDesign 失败态：采集链接线（真机回归）", () => {
  it("选择器表含失败态锚点（产品专用 testid：chat-run-error-*）", () => {
    const selectorsTs = read("../../src/agents/opendesign/selectors.ts");
    expect(selectorsTs, "选择器表必须含 chat-run-error-card").toContain("chat-run-error-card");
    expect(selectorsTs, "选择器表必须含 chat-run-error-description").toContain(
      "chat-run-error-description",
    );
  });

  it("cdp.ts 的 poll 快照类型含 errorText（否则判定层永远收不到它）", () => {
    const m = /export interface OpenDesignPollSnapshot\s*\{([\s\S]*?)\}/.exec(cdpTs);
    expect(m, "未找到 OpenDesignPollSnapshot").not.toBeNull();
    expect(
      m![1],
      "OpenDesignPollSnapshot 必须声明 errorText —— liveness.OpenDesignPoll 有它，快照漏了就永远传不过去",
    ).toContain("errorText");
  });

  it("pollExpression 实际采集 errorText（一次页面求值取回，不能只声明不采集）", () => {
    const m = /export function pollExpression\([\s\S]*?\n\}/.exec(cdpTs);
    expect(m, "未找到 pollExpression").not.toBeNull();
    expect(m![0], "pollExpression 必须采集 errorText").toContain("errorText");
  });

  it("run.ts 组装 poll 时把 snapshot.errorText 传下去（三段接线的最后一跳）", () => {
    const m = /const poll: OpenDesignPoll = \{([\s\S]*?)\};/.exec(runTs);
    expect(m, "未找到 poll 组装字面量").not.toBeNull();
    expect(
      m![1],
      "poll 字面量必须传 errorText: snapshot.errorText —— 少这一跳，前两段白接",
    ).toContain("errorText");
  });
});
