/**
 * 单元测试：computer-use 白名单守卫（决策 21：仅允许驱动 AI-Agent，其他一律拒绝）。
 */
import { describe, it, expect } from "vitest";
import { assertAllowed, isAllowed, ComputerUseDeniedError, allowedProcessNames } from "../../src/agents/traework/computeruse/guard.js";

describe("computer-use 守卫", () => {
  it("放行 TraeWork 的文件夹选择对话框", () => {
    expect(() =>
      assertAllowed({ windowTitle: "Select Project Folder", processName: "TRAE SOLO CN.exe", intent: "选择项目文件夹" }),
    ).not.toThrow();
    expect(() =>
      assertAllowed({ windowTitle: "选择项目文件夹", processName: "TRAE SOLO CN.exe", intent: "选择项目文件夹" }),
    ).not.toThrow();
    expect(
      isAllowed({ windowTitle: "选择文件夹", processName: "explorer.exe", intent: "选择项目文件夹" }),
    ).toBe(true);
  });

  it("拒绝任意其他窗口（标题不匹配）", () => {
    const targets = [
      { windowTitle: "记事本", processName: "TRAE SOLO CN.exe", intent: "打字" },
      { windowTitle: "Windows PowerShell", processName: "explorer.exe", intent: "执行命令" },
      { windowTitle: "Google Chrome", processName: "explorer.exe", intent: "打开网页" },
      { windowTitle: "文件资源管理器", processName: "explorer.exe", intent: "删除文件" },
    ];
    for (const t of targets) {
      expect(() => assertAllowed(t), `应拒绝: ${t.windowTitle}`).toThrow(ComputerUseDeniedError);
      expect(isAllowed(t)).toBe(false);
    }
  });

  it("拒绝非允许宿主进程", () => {
    expect(() =>
      assertAllowed({ windowTitle: "选择项目文件夹", processName: "notepad.exe", intent: "选择文件夹" }),
    ).toThrow(/不在允许列表/);
  });

  it("拒绝空标题", () => {
    expect(() => assertAllowed({ windowTitle: "", processName: "TRAE SOLO CN.exe", intent: "x" })).toThrow(/无标题/);
  });

  it("错误信息说明仅用于 AI-Agent", () => {
    try {
      assertAllowed({ windowTitle: "记事本", processName: "explorer.exe", intent: "x" });
      expect.unreachable("应抛错");
    } catch (e) {
      expect((e as Error).message).toContain("仅用于驱动 AI-Agent");
      expect((e as Error).message).toContain("COMPUTER_USE_DENIED");
    }
  });

  it("允许进程清单非空且含 TraeWork", () => {
    const names = allowedProcessNames();
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain("trae solo cn.exe");
  });
});
