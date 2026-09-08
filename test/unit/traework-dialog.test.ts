/**
 * 单元测试：原生「选择文件夹」对话框的消息映射与平台分支（开发计划 M5+ 修复）。
 *
 * 背景（实测踩坑 2026-09-08）：
 *  - PowerShell 脚本内部必须只用 ASCII 输出（控制台代码页会把中文变乱码），
 *    因此错误/成功消息在 Node 侧用 localizeDialogMessage 映射回中文。
 *  - 非 Windows 平台必须 fail-closed（明确报错并提示手动操作）。
 */
import { describe, it, expect } from "vitest";
import { localizeDialogMessage, pickFolderViaNativeDialog } from "../../src/agents/traework/computeruse/dialog.js";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe("localizeDialogMessage 消息映射", () => {
  it("把 PowerShell 的 ASCII 结果映射为中文", () => {
    expect(localizeDialogMessage("confirmed via WM_SETTEXT + button click")).toContain("WM_SETTEXT");
    expect(localizeDialogMessage("dialog not found")).toContain("未出现");
    expect(localizeDialogMessage("folder edit box not found")).toContain("文件夹");
    expect(localizeDialogMessage("dialog still open after confirm click")).toContain("仍存在");
    expect(localizeDialogMessage("confirm control (AutomationId=1, Pane) not clickable")).toContain("确认按钮");
  });

  it("未映射的消息原样返回（便于新增分支时不被吞掉）", () => {
    expect(localizeDialogMessage("some brand new message")).toBe("some brand new message");
    expect(localizeDialogMessage("")).toBe("");
  });
});

describe("pickFolderViaNativeDialog 平台分支", () => {
  it("非 win32 平台 fail-closed，提示手动操作", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const r = await pickFolderViaNativeDialog("D:/any/path", { logger: silentLogger });
      expect(r.ok).toBe(false);
      expect(r.message).toContain("不支持");
      expect(r.message).toContain("手动");
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
    }
  });
});
