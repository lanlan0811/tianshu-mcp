/**
 * 单元测试：原生「选择文件夹」对话框的路径规范化、消息映射与平台分支。
 *
 * 背景（实测踩坑 2026-09-08 / v0.1.7）：
 *  - **根因**：MCP 内部用 `normPath()` 规范化路径（小写盘符 + 正斜杠），而 Windows 原生
 *    文件夹选择器**不接受** `d:/a/b` 形式——写入后回读虽一致，点击确认时对话框不会关闭。
 *    必须转成 `D:\a\b`（`toNativeWindowsPath`）。
 *  - PowerShell 脚本内部必须只用 ASCII 输出（控制台代码页会把中文变乱码），
 *    因此错误/成功消息在 Node 侧用 `localizeDialogMessage` 映射回中文。
 *  - 非 Windows 平台必须 fail-closed（明确报错并提示手动操作）。
 */
import { describe, it, expect } from "vitest";
import {
  localizeDialogMessage,
  pickFolderViaNativeDialog,
  toNativeWindowsPath,
} from "../../src/agents/traework/computeruse/dialog.js";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe("toNativeWindowsPath 路径规范化（v0.1.7 根因修复）", () => {
  it("正斜杠 → 反斜杠，盘符大写", () => {
    expect(toNativeWindowsPath("d:/Trae项目/AI游戏/象棋")).toBe("D:\\Trae项目\\AI游戏\\象棋");
    expect(toNativeWindowsPath("d:/trae项目/ts-bind-test")).toBe("D:\\trae项目\\ts-bind-test");
  });

  it("已是原生形式时保持不变", () => {
    expect(toNativeWindowsPath("D:\\Trae项目\\AI游戏\\象棋")).toBe("D:\\Trae项目\\AI游戏\\象棋");
  });

  it("保留 CJK 与空格", () => {
    expect(toNativeWindowsPath("d:/a b/中文 目录")).toBe("D:\\a b\\中文 目录");
  });

  it("空值原样返回", () => {
    expect(toNativeWindowsPath("")).toBe("");
  });

  it("非盘符开头的路径只替换分隔符", () => {
    expect(toNativeWindowsPath("/tmp/x")).toBe("\\tmp\\x");
  });
});

describe("localizeDialogMessage 消息映射", () => {
  it("把 PowerShell 的 ASCII 结果映射为中文", () => {
    expect(localizeDialogMessage("path verified and dialog closed")).toContain("回读校验");
    expect(localizeDialogMessage("path write verification failed")).toContain("未点击确认");
    expect(localizeDialogMessage("dialog not found")).toContain("未出现");
    expect(localizeDialogMessage("folder edit box not found")).toContain("文件夹");
    expect(localizeDialogMessage("dialog still open after confirm click")).toContain("仍存在");
    expect(localizeDialogMessage("confirm control (AutomationId=1, Pane, lower half) not found")).toContain("确认按钮");
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
