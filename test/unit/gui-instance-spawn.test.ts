import { describe, expect, it } from "vitest";
import { guiInstanceSpawnOptions } from "../../src/agents/gui-instance.js";

describe("GUI 桌面实例的 spawn 选项", () => {
  it("桌面实例必须 detached：父进程（server 或一次性 smoke 脚本）退出不得连坐", () => {
    // 真机实测（Windows 10 / Node 24.18.0，2026-09-15）：同一段 spawn，
    // non-detached 子进程在父进程退出后存活 0，detached 存活 1。
    // zcode/codex 此前按平台分支在 Windows 上给 false，使 `keptInstance` 的
    // 「实例跨 server 退出驻留」在 Windows 上失效——needs_user 恢复时 ZCode 窗口已消失。
    const options = guiInstanceSpawnOptions(false);
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe("ignore");
    expect(options.windowsHide).toBe(false);
  });

  it("默认隐藏窗口；ZCode / TraeWork 这类需要可见窗口的 GUI 显式传 false", () => {
    expect(guiInstanceSpawnOptions().windowsHide).toBe(true);
  });
});
