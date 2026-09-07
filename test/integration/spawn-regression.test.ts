/**
 * 集成测试：验证 M2 冒烟暴露的两个真实缺陷已修复。
 * 1) Windows 下验收命令能跑 npm 等 .cmd 垫片（cross-spawn，非 shell 拼接）
 * 2) 验收 runner / agent spawn 在子进程退出后仍有晚到输出时不崩（write-after-end 兜底）
 */
import { describe, it, expect, afterAll } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { makeTmpRoot } from "../test-utils.js";
import { runVerifyCommand } from "../../src/verify/runner.js";
import { runChild } from "../../src/agents/spawn.js";

let tempDirs: string[] = [];

afterAll(async () => {
  const { rmrf } = await import("../test-utils.js");
  for (const d of tempDirs) await rmrf(d).catch(() => {});
});

describe("验收命令在 Windows 下能跑 npm .cmd 垫片", () => {
  it("runVerifyCommand 执行 npm --version（npm 是 .cmd 垫片）成功", async () => {
    const root = await makeTmpRoot("cmd");
    tempDirs.push(root);
    const log = path.join(root, "v.log");
    const res = await runVerifyCommand("npm-version", ["npm", "--version"], {
      cwd: root,
      timeoutMs: 30_000,
      logFile: log,
    });
    expect(res.passed, JSON.stringify(res)).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.outputTail).toMatch(/\d+\.\d+\.\d+/);
  }, 60_000);
});

describe("spawn 日志写入在退出竞态下不崩溃", () => {
  it("子进程已 close 后仍有 stdout 晚到 → server 进程不抛未处理异常（这里仅验证 safeEnd 后写入被吞掉）", async () => {
    const root = await makeTmpRoot("race");
    tempDirs.push(root);
    const log = path.join(root, "agent.log");
    // node 脚本：stdout 大量输出，末尾退出码 0 —— 模拟真实 agent
    const res = await runChild(
      {
        command: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(20000)); setTimeout(()=>process.exit(0), 200)"],
        cwd: root,
        env: {},
        logFile: log,
        timeoutMs: 20_000,
        killTree: "taskkill",
      },
      {},
    );
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    // 不抛异常即通过；日志应已写入
    const text = await fsp.readFile(log, "utf8");
    expect(text).toContain("[stdout]");
  }, 60_000);
});
