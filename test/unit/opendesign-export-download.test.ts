/**
 * OpenDesign 导出链路：**下载目录机制**回归（真机缺陷，2026-10-11）。
 *
 * 真机取证（模型 cline-pass/deepseek-v4.1-flash，产物 minecraft-promo.html）：
 *
 *   点工具栏「导出」→ 菜单 4 项实测文案：
 *     ["导出为 PDF","导出为图片","下载为 .zip","导出为独立 HTML"]
 *
 *   点「导出为独立 HTML」后**没有原生保存对话框**，而是：
 *     1. 出现一个 `#32770` 空壳窗口，标题是 `blob:od://app/<uuid>`（无任何子控件）；
 *     2. 下载落到 `~/Downloads/<uuid>.tmp` 后**卡住不再增长**（24279 字节恒定）。
 *
 *   —— 即产品走的是**浏览器式下载**（blob + `will-download`），
 *   那个 blob 窗口是 Electron 的下载宿主窗口，**不是**可供 Win32/UIA 驱动的保存对话框。
 *   所以 `saveViaNativeDialog` 那条路（填地址栏 + 点保存）在 0.24.1 上根本不适用，
 *   真机表现就是「下载永远停在 .tmp、产物永远等不到」。
 *
 *   正解（真机复现成功，两种格式各一轮）：
 *     `Page.setDownloadBehavior({ behavior:'allow', downloadPath: 目标目录 })`
 *     → 再点菜单项 → 文件**直接落盘到目标目录**，无需任何对话框交互。
 *     实测：html → minecraft-promo.html(24279B/753 行/完整文档)；
 *           zip  → Website-Clone.zip(11748B/魔数 504b0304/testzip 无损坏/3 条目)。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, rel), "utf8");

const exportTs = read("../../src/agents/opendesign/export.ts");
const cdpTs = read("../../src/agents/opendesign/cdp.ts");

describe("OpenDesign 导出：下载目录机制（真机回归）", () => {
  it("ExportPage 暴露 setDownloadDir（直接落盘，不依赖保存对话框）", () => {
    const m = /export interface OpenDesignExportPage\s*\{([\s\S]*?)\}/.exec(exportTs);
    expect(m, "未找到 OpenDesignExportPage").not.toBeNull();
    expect(
      m![1],
      "ExportPage 必须提供 setDownloadDir —— 真机实测产品是浏览器式下载，唯一可靠路径是 CDP 指定下载目录",
    ).toMatch(/setDownloadDir/);
  });

  it("cdp.ts 实现 setDownloadDir 且调用 Page.setDownloadBehavior", () => {
    expect(cdpTs, "cdp.ts 必须实现 setDownloadDir").toContain("setDownloadDir");
    expect(
      cdpTs,
      "必须走 CDP 的 Page.setDownloadBehavior（真机取证：指定 downloadPath 后文件直接落盘）",
    ).toContain("Page.setDownloadBehavior");
  });

  it("exportArtifact 主流程调用 setDownloadDir（不是只声明不调用）", () => {
    const m = /export async function exportArtifact[\s\S]*?\n\}/.exec(exportTs);
    expect(m, "未找到 exportArtifact").not.toBeNull();
    expect(
      m![0],
      "exportArtifact 必须在点菜单项**之前**设置下载目录，否则文件落到默认 Downloads",
    ).toContain("setDownloadDir");
  });

  it("下载目录必须在点菜单项之前设置（顺序错则落错盘）", () => {
    const body = exportTs.slice(exportTs.indexOf("export async function exportArtifact"));
    const setIdx = body.indexOf("setDownloadDir");
    const clickIdx = body.indexOf("clickMenuItem");
    expect(setIdx, "未找到 setDownloadDir 调用").toBeGreaterThan(-1);
    expect(clickIdx, "未找到 clickMenuItem 调用").toBeGreaterThan(-1);
    expect(
      setIdx,
      `setDownloadDir 必须先于 clickMenuItem（当前 set@${setIdx}，click@${clickIdx}）——点完才开始下载就晚了`,
    ).toBeLessThan(clickIdx);
  });

  it("下载目录的设置属于 page 能力，不额外塞进 ExportArtifactDeps", () => {
    // 设计纪律：setDownloadDir 是「页面/会话级动作」，归 OpenDesignExportPage；
    // 若把它做成 deps 条目，真机 cdp 客户端那条唯一实现反而容易被漏接。
    const m = /export interface ExportArtifactDeps\s*\{([\s\S]*?)\n\}/.exec(exportTs);
    expect(m, "未找到 ExportArtifactDeps").not.toBeNull();
    expect(
      m![1],
      "ExportArtifactDeps 不应包含 setDownloadDir —— 它属于 ExportPage",
    ).not.toContain("setDownloadDir");
  });
});

describe("OpenDesign 导出：下载直落盘时不得被保存对话框拦住（真机回归）", () => {
  it("saveViaNativeDialog 失败**不**直接判导出失败（浏览器式下载无需对话框）", () => {
    const body = exportTs.slice(exportTs.indexOf("export async function exportArtifact"));
    // 该调用必须被 .catch() 包住（调用本身失败也不能炸掉整个导出）
    expect(body, "saveViaNativeDialog 调用必须带 .catch 兜底").toMatch(
      /saveViaNativeDialog[\s\S]{0,400}?\.catch\(/,
    );
    // 且其后**不得**紧跟 `return { ok: false ... }` —— 那会把常见的正常路径拦死
    const callIdx = body.indexOf("saveViaNativeDialog");
    const afterCall = body.slice(callIdx, callIdx + 1200);
    expect(
      afterCall,
      "对话框失败后必须继续走「等产物落盘」，不能立即 return 失败",
    ).not.toMatch(/if \(!saved\.ok\)\s*return/);
    expect(afterCall, "失败时应记日志说明按浏览器式下载处理").toMatch(/浏览器式下载/);
  });

  it("等产物落盘是唯一的成败判据（对话框只是可选前置）", () => {
    const body = exportTs.slice(exportTs.indexOf("export async function exportArtifact"));
    // 「导出后 N ms 内目标目录未出现产物」这条错误信息必须存在：它才是真判据
    expect(body).toMatch(/目标目录未出现产物/);
  });
});
