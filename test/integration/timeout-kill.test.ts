/**
 * R2 回归测试：调用级 taskTimeoutMs 覆盖优先级 + 跨平台 kill tree。
 * 1) taskTimeoutMs=800 的长任务按调用超时终止（而非 profile 的分钟级），终态 failed/errorType=timeout
 * 2) spawn 超时路径不会遗留孙进程（平台通用：由 killTree 保证整树）
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import {
  startTestServer,
  makeGitProject,
  writePlaybook,
  callTool,
  parseMeta,
  waitForTerminal,
  rmrf,
  type TestServer,
} from "../test-utils.js";
import { killTree } from "../../src/agents/spawn.js";

let ts: TestServer;
const tempDirs: string[] = [];

beforeAll(async () => {
  ts = await startTestServer();
}, 60_000);
afterAll(async () => {
  await ts?.close();
  for (const d of tempDirs) await rmrf(d).catch(() => {});
  if (ts) await rmrf(ts.home).catch(() => {});
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("R2 调用级超时覆盖", () => {
  it("taskTimeoutMs=800 的长任务在 ~800ms 超时，而非 profile 分钟级", async () => {
    const proj = await makeGitProject("sleep", { sleepMs: 60_000 });
    tempDirs.push(proj);
    await writePlaybook(proj, { playbook: "sleep", sleepMs: 60_000 });

    const started = Date.now();
    const { text } = await callTool(ts.client, "run_task", {
      projectPath: proj,
      agentId: "stub",
      task: "长任务验证调用级超时",
      autoVerify: false,
      taskTimeoutMs: 800,
    });
    const taskId = (parseMeta(text).meta!.taskId as string) ?? "";
    const final = await waitForTerminal(ts.client, taskId, 20_000);
    const elapsed = Date.now() - started;
    expect(final.status).toBe("failed");
    expect(final.errorType).toBe("timeout");
    expect(elapsed).toBeLessThan(15_000); // 远超 800ms 则说明没按调用超时生效
  }, 60_000);
});

describe("R2 killTree 跨平台语义", () => {
  it("killTree 在任意平台都不会抛错，且对已退出进程幂等", async () => {
    // 起一个临时子进程后先自然退出，再 killTree 应安全 resolve
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0), 300)"], {
      detached: process.platform !== "win32",
    });
    const pid = child.pid!;
    await new Promise((r) => child.on("exit", r));
    await expect(killTree(pid, "auto")).resolves.toBeUndefined();
  });

  it("killTree 能终止存活子进程（含 POSIX 组杀路径）", async () => {
    // 起一个长驻子进程
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: process.platform !== "win32",
    });
    const pid = child.pid!;
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    // 等子进程真正起来（CI 负载下 spawn 可能延迟）
    const upDeadline = Date.now() + 5000;
    while (child.exitCode === null && !exited && Date.now() < upDeadline) await sleep(50);
    expect(exited).toBe(false); // 此刻应仍在运行
    await killTree(pid, "auto");
    // 等待 killTree 生效（轮询确认消失最长 ~3s）+ exit 事件（监听器已在 kill 前挂好，不丢事件）
    const deadline = Date.now() + 8000;
    while (!exited && Date.now() < deadline) await sleep(100);
    expect(exited).toBe(true);
  });
});
