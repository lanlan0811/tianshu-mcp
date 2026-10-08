/**
 * TraeWork 取消路径回归锁。
 *
 * 真机测试暴露的两个缺陷（2026-10-08），均属「与其它 GUI 适配器不一致」族：
 *
 * 1. **漏 `await`**：`abortResult()` 是 async，取消分支写成 `return abortResult()`
 *    而非 `return await abortResult()`。JS 语义下，`return <promise>` 会**立即**执行
 *    外层 `finally`（含 `cdp.disconnect()`），不等 async 函数内部完成——
 *    于是 `stopGuiTurn` 点停止按钮时 CDP 已被本函数的 finally 断开。
 *    实测报文：`取消时停止 GUI 运行失败：CDP_UNAVAILABLE: 连接已断开: 客户端主动断开`，
 *    `guiStop={clicked:false, idle:false}`，任务被标 `guiStopUnconfirmed`。
 *    对照：kimicode / minimax / opendesign 均写 `return await abortResult()`。
 *
 * 2. **click() 执行顺序反了**：原实现先 `element.click()`、抛错才回退坐标；
 *    但语义键常命中**图标类元素**（`stopButton` = `.chat-input-v2-send-button-stop-icon`），
 *    这类元素没有 `click()` 方法 → `TypeError: e.click is not a function` 直接冒泡，
 *    调用方只拿到异常、点不到按钮。改为坐标点击优先、DOM click 兜底且吞异常。
 *
 * 本文件用源码级断言锁定这两个不变量（真机行为已另行验证，见 docs/traework-cdp.md）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const RUN_TS = path.join(REPO, "src", "agents", "traework", "run.ts");
const CLIENT_TS = path.join(REPO, "src", "agents", "traework", "cdp", "client.ts");

describe("TraeWork 取消路径不变量", () => {
  it("abortResult 的调用点必须 await（否则外层 finally 会抢在点停止按钮前断开 CDP）", () => {
    const src = fs.readFileSync(RUN_TS, "utf8");
    const calls = [...src.matchAll(/return (await )?abortResult\(\)/g)];
    expect(calls.length, "应有两处取消分支调用 abortResult()").toBe(2);
    for (const m of calls) {
      expect(
        m[1],
        "取消分支必须写 `return await abortResult()`——漏 await 会让 finally 的 cdp.disconnect() 抢跑，" +
          "导致 stopGuiTurn 拿到的只有「CDP 已断开」，点不到停止按钮",
      ).toBe("await ");
    }
  });

  it("abortResult 内部必须调用 stopGuiTurn 并把 guiStop 带进结果", () => {
    const src = fs.readFileSync(RUN_TS, "utf8");
    const body = /const abortResult = async[\s\S]*?\n  \};/.exec(src)?.[0];
    expect(body, "未找到 abortResult 定义").toBeTruthy();
    expect(body, "abortResult 必须调用 stopGuiTurn 去点界面停止按钮").toContain("stopGuiTurn(");
    expect(body, "abortResult 必须把 guiStop 写进结果，供 guiStopDisclosure 生成终态文案").toContain("guiStop");
  });

  it("click() 必须坐标点击优先、DOM click 兜底，且不因元素不支持 click 而抛错", () => {
    const src = fs.readFileSync(CLIENT_TS, "utf8");
    const body = /async click\(key: SelectorKey[\s\S]*?\n  \}/.exec(src)?.[0];
    expect(body, "未找到 click() 实现").toBeTruthy();
    // 顺序：clickAt（坐标）出现在 e.click()（DOM）之前
    const iCoord = body.indexOf("clickAt(");
    const iDom = body.indexOf(".click()");
    expect(iCoord, "click() 应先尝试坐标点击").toBeGreaterThan(-1);
    expect(iDom, "click() 应保留 DOM click 作为兜底").toBeGreaterThan(-1);
    expect(iCoord, "坐标点击必须先于 DOM click——stopButton 等图标类元素没有 click() 方法")
      .toBeLessThan(iDom);
    // DOM click 前必须判 typeof，避免 TypeError 冒泡
    expect(body, "DOM click 前必须用 typeof e.click==='function' 守卫").toContain("typeof e.click");
  });

  it("stopButton 选择器命中的是图标元素（解释为何必须坐标点击优先）", () => {
    const sel = fs.readFileSync(path.join(REPO, "src", "agents", "traework", "cdp", "selectors.ts"), "utf8");
    const block = /stopButton: \{[\s\S]*?\},/.exec(sel)?.[0];
    expect(block, "未找到 stopButton 选择器定义").toBeTruthy();
    expect(block, "stopButton 主选择器应为 -icon 结尾的图标元素").toMatch(/-icon/);
  });
});
