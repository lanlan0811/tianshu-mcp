/**
 * 单元测试：验收命令检查有界并行（verifyConcurrency）。
 * - 多个慢 check 并行时墙钟 < 串行之和（报告顺序保持声明顺序）
 * - 每 check 独立 part 日志，结束后按声明顺序拼成同一份 verify-N.log
 * - verifyConcurrency=1 退化为串行（与历史行为一致）
 * - 任务取消：在途 check 被杀（aborted），未启动的 check 标记跳过
 * 假命令沿用 acceptance.test.ts 先例（process.execPath -e）。
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { AcceptanceEngine } from "../../src/verify/acceptance.js";
import { ServerConfigSchema, type AcceptanceCheckDef } from "../../src/config/schema.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { Logger } from "../../src/util/log.js";
import { exists } from "../../src/util/fs.js";
import type { VerifyReport } from "../../src/tasks/task.js";

const logger = new Logger(null, "error");

async function tmpDir(tag: string): Promise<string> {
  const p = path.join(os.tmpdir(), `tsmcp-unit-${tag}-${randomBytes(4).toString("hex")}`);
  await fsp.mkdir(p, { recursive: true });
  return p;
}

/** node -e 假命令：可选打印 marker，sleep ms 后退出 0 */
function sleepCheck(name: string, ms: number, marker?: string): AcceptanceCheckDef {
  const code = `${marker ? `console.log(${JSON.stringify(marker)});` : ""}setTimeout(()=>process.exit(0),${ms})`;
  return { name, cmd: [process.execPath, "-e", code], displayCmd: `sleep-${ms}` };
}

interface RunOutcome {
  report: VerifyReport;
  passed: boolean;
  wallMs: number;
  taskDir: string;
}

async function runVerify(
  projectPath: string,
  options: {
    checks: AcceptanceCheckDef[];
    /** 项目级覆盖：写入 .tianshu-mcp/acceptance.json */
    projectConcurrency?: number;
    /** server 级：经 ServerConfig（config.json 同 schema） */
    serverConcurrency?: number;
    signal?: AbortSignal;
  },
): Promise<RunOutcome> {
  if (options.projectConcurrency !== undefined) {
    await fsp.mkdir(path.join(projectPath, ".tianshu-mcp"), { recursive: true });
    await fsp.writeFile(
      path.join(projectPath, ".tianshu-mcp", "acceptance.json"),
      JSON.stringify({
        checks: [],
        requireChanges: false,
        verifyConcurrency: options.projectConcurrency,
      }),
      "utf8",
    );
  }
  const home = await tmpDir("parallel-home");
  const store = new TaskStore(home, logger);
  const engine = new AcceptanceEngine(store, logger);
  const taskId = `tsk_${randomBytes(4).toString("hex")}`;
  const startedAt = Date.now();
  const { report, passed } = await engine.runVerify({
    taskId,
    projectPath,
    displayPath: projectPath,
    round: 0,
    config:
      options.serverConcurrency !== undefined
        ? ServerConfigSchema.parse({ verifyConcurrency: options.serverConcurrency })
        : undefined,
    extraChecks: options.checks,
    checksMode: "replace",
    signal: options.signal,
    store,
    logger,
  });
  return { report, passed, wallMs: Date.now() - startedAt, taskDir: store.dir(taskId) };
}

describe("验收命令检查有界并行（verifyConcurrency）", () => {
  it("慢 check 并行：墙钟 < 串行之和，报告顺序保持声明顺序", async () => {
    const project = await tmpDir("parallel-wall");
    const checks = [sleepCheck("a", 500, "A"), sleepCheck("b", 500, "B"), sleepCheck("c", 500, "C")];
    const { report, passed, wallMs } = await runVerify(project, {
      checks,
      projectConcurrency: 3,
    });
    expect(passed).toBe(true);
    const cmd = report.checks.filter((c) => ["a", "b", "c"].includes(c.name));
    // 展示顺序 = 声明顺序（不是完成顺序）
    expect(cmd.map((c) => c.name)).toEqual(["a", "b", "c"]);
    const sum = cmd.reduce((acc, c) => acc + c.durationMs, 0);
    expect(wallMs).toBeGreaterThan(400); // 确实执行了 ~500ms 的检查
    // 串行墙钟 ≥ 各检查耗时之和；wall < sum 证明发生了真并行
    expect(wallMs).toBeLessThan(sum);
  }, 30_000);

  it("日志按声明顺序拼接（与完成顺序无关），parts 目录被清理", async () => {
    const project = await tmpDir("parallel-log");
    // 声明顺序 a,b,c；完成顺序被刻意设计为 c,b,a
    const checks = [
      sleepCheck("a", 400, "MARK_A"),
      sleepCheck("b", 200, "MARK_B"),
      sleepCheck("c", 0, "MARK_C"),
    ];
    const { passed, taskDir } = await runVerify(project, { checks, projectConcurrency: 3 });
    expect(passed).toBe(true);
    const log = await fsp.readFile(path.join(taskDir, "verify-0.log"), "utf8");
    const headerA = log.indexOf("=== check: a —");
    const headerB = log.indexOf("=== check: b —");
    const headerC = log.indexOf("=== check: c —");
    expect(headerA).toBeGreaterThanOrEqual(0);
    expect(headerA).toBeLessThan(headerB);
    expect(headerB).toBeLessThan(headerC);
    expect(log.indexOf("MARK_A")).toBeLessThan(log.indexOf("MARK_B"));
    expect(log.indexOf("MARK_B")).toBeLessThan(log.indexOf("MARK_C"));
    // 每条 check 都有 exit 行（part 内容完整拼入）
    expect(log.match(/\[exit\] code=0/g)).toHaveLength(3);
    // 临时 parts 目录拼接后被清理
    expect(await exists(path.join(taskDir, "verify-0.parts"))).toBe(false);
  }, 30_000);

  it("verifyConcurrency=1 退化为串行（墙钟 ≥ 各检查耗时之和）", async () => {
    const project = await tmpDir("parallel-serial");
    const checks = [sleepCheck("a", 300, "S_A"), sleepCheck("b", 300, "S_B")];
    const { report, passed, wallMs, taskDir } = await runVerify(project, {
      checks,
      projectConcurrency: 1,
    });
    expect(passed).toBe(true);
    const cmd = report.checks.filter((c) => ["a", "b"].includes(c.name));
    const sum = cmd.reduce((acc, c) => acc + c.durationMs, 0);
    // 串行：墙钟 ≈ 之和 + 间隙（留 100ms 计时余量）；并行实现会明显低于之和
    expect(wallMs).toBeGreaterThanOrEqual(sum - 100);
    expect(wallMs).toBeGreaterThanOrEqual(550); // 两个 300ms sleep 串行不可能更快
    const log = await fsp.readFile(path.join(taskDir, "verify-0.log"), "utf8");
    expect(log.indexOf("S_A")).toBeLessThan(log.indexOf("S_B"));
    // 串行路径不产生 parts 目录
    expect(await exists(path.join(taskDir, "verify-0.parts"))).toBe(false);
  }, 30_000);

  it("任务取消：在途 check 被杀（aborted），未启动的 check 标记跳过", async () => {
    const project = await tmpDir("parallel-abort");
    const ac = new AbortController();
    const checks = [sleepCheck("a", 30_000), sleepCheck("b", 30_000), sleepCheck("c", 30_000)];
    const timer = setTimeout(() => ac.abort(), 250);
    try {
      const { report, wallMs } = await runVerify(project, {
        checks,
        serverConcurrency: 2, // server 级配置路径：a/b 在途，c 未启动
        signal: ac.signal,
      });
      // 不能中断的话需要 ~30s（c 等待 a/b 腾出槽位）
      expect(wallMs).toBeLessThan(5_000);
      const byName = new Map(report.checks.map((c) => [c.name, c]));
      expect(byName.get("a")?.aborted).toBe(true);
      expect(byName.get("b")?.aborted).toBe(true);
      expect(byName.get("c")?.skipped).toBe(true);
      expect(byName.get("c")?.reason).toContain("任务取消");
    } finally {
      clearTimeout(timer);
    }
  }, 30_000);
});
