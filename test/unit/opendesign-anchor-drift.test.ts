/**
 * OpenDesign 0.24.1 页面锚点漂移回归（真机缺陷，2026-10-11）。
 *
 * 真机现象（模型 cline-pass/deepseek-v4.1-flash，工作区 D:\Trae项目\AI游戏\Minecraft）：
 *   任务 tsk_20261011081412_a43de4 连接阶段硬失败：
 *     `Open Design 页面结构已漂移（布局守卫未命中：title）`
 *     endReason = selector_drift
 *   而当时产品完全正常（用户此前刚用它跑完一个设计任务）。
 *
 * 真因（真机 DOM 取证 + 流程阅读，**两页形态不同**）：
 *
 *   | 页面                        | home-hero | home-view | workspace-home-chrome | working-dir-trigger |
 *   |-----------------------------|-----------|-----------|-----------------------|---------------------|
 *   | 首页 `od://app/`            |     1     |     1     |          1            |          1          |
 *   | 会话页 `od://app/.../files/`|     0     |     0     |          1            |          0          |
 *
 *   run.ts 的流程是「先 `ensureHomePage()` 回首页，再跑布局守卫」：
 *     1. `ensureHomePage()` 用 `exists("title")` 判「是否已在首页」，不在则点
 *        `OPEN_DESIGN_HOME_ENTRY_SELECTOR`；点完再等 title；
 *     2. `probe()` 检查布局守卫 4 键，任一为 0 即 `hardFail("selector_drift")`。
 *
 *   而 `OPEN_DESIGN_HOME_ENTRY_SELECTOR` 原本只有 `entry-view-home` / `entry-nav-home`——
 *   这两个在**会话页不存在**（只在首页的左侧导航里），于是会话页点空气 → 回不了首页 →
 *   守卫在**会话页**上检查 → `title` 恒 0 → 硬失败。
 *
 * 正解：会话页存在、且点击后 URL 变 `od://app/` 的入口是 `workspace-home-chrome`
 *   （实测 aria-label = 「主页」，坐标 (42,22)）。补进 `HOME_ENTRY` 即可。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  OPEN_DESIGN_LAYOUT_GUARD_KEYS,
  OPEN_DESIGN_SELECTORS,
} from "../../src/agents/opendesign/selectors.js";

const here = dirname(fileURLToPath(import.meta.url));
const runTs = readFileSync(resolve(here, "../../src/agents/opendesign/run.ts"), "utf8");

/** 从 run.ts 源码里取出 HOME_ENTRY 常量值（避免 import 触发整条依赖链） */
function homeEntrySelector(): string {
  const m = /OPEN_DESIGN_HOME_ENTRY_SELECTOR\s*=\s*([\s\S]*?);/.exec(runTs);
  if (!m?.[1]) throw new Error("未在 run.ts 里找到 OPEN_DESIGN_HOME_ENTRY_SELECTOR");
  return m[1].replace(/\s+/g, " ").trim();
}

describe("OpenDesign 0.24.1：首页入口必须能在会话页点回首页", () => {
  it("HOME_ENTRY 含会话页唯一可用的入口 workspace-home-chrome", () => {
    const sel = homeEntrySelector();
    expect(
      sel,
      `首页入口必须含 workspace-home-chrome（0.24.1 实测：会话页只有它点击后能回 od://app/）；当前=${sel}`,
    ).toContain("workspace-home-chrome");
  });

  it("HOME_ENTRY 保留旧入口（首页左侧导航里仍存在，用于首页内切换）", () => {
    const sel = homeEntrySelector();
    expect(sel).toContain("entry-view-home");
    expect(sel).toContain("entry-nav-home");
  });

  it("HOME_ENTRY 不含会话区容器（点它们不会切回首页）", () => {
    const sel = homeEntrySelector();
    // chat-composer / chat-log 在会话页存在，但点击不会导航到首页
    expect(sel).not.toContain("chat-composer");
    expect(sel).not.toContain("chat-log");
  });

  it("title 锚点保持「仅首页命中」语义（不能被会话页也存在的键污染）", () => {
    const spec = OPEN_DESIGN_SELECTORS.title;
    const all = [spec.primary, ...(spec.fallbacks ?? [])].join(" ");
    // title 被 ensureHomePage 用作「是否已在首页」的判据：
    // 一旦把会话页也存在的键（chat-composer 等）放进去，停留会话页会被误判成
    // 「已在首页」→ 跳过回首页 → 后续首页专属控件（working-dir-trigger 等）必然 0 命中。
    expect(all).not.toContain("chat-composer");
    expect(all).not.toContain("chat-log");
    // home-hero 仍是权威标志
    expect(all).toContain("home-hero");
  });

  it("title 仍在布局守卫键里（守卫语义不变）", () => {
    expect(OPEN_DESIGN_LAYOUT_GUARD_KEYS).toContain("title");
  });
});
