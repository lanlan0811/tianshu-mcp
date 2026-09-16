import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AcceptanceEngine } from "../../src/verify/acceptance.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { Logger } from "../../src/util/log.js";
import { loadSharp } from "../../src/visual/runtime.js";
import type { VerifyReport } from "../../src/tasks/task.js";

/**
 * 整轮级阻塞与单项失败的分界（issue #13 计划 §5 G 组 / P2、P3 收口）：
 * 有效命令不可解析、env 引用缺失 → 抛错升级为整轮 configurationError，**不产出 VisualResult 行**；
 * 命令已能执行但退出码非 0/超时/输出非法 → 仅单项 blocked，整轮其余结果照常。
 */
const JUDGE = path.resolve("test/fixtures/content-judge.mjs");
const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

interface Scenario {
  /** 全局 content 块（会与默认值合并） */
  content?: Record<string, unknown>;
  /** 逐规则覆盖 */
  rule?: Record<string, unknown>;
  /** 追加的第二条规则（用于 P3：只有该规则覆盖的 command 缺失） */
  secondRule?: Record<string, unknown>;
  /** 判定桩行为 */
  mode?: string;
}

async function run(options: Scenario): Promise<{ report: VerifyReport; passed: boolean }> {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "视觉 阻塞-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "视觉 阻塞-home-"));
  dirs.push(project, home);
  await fs.mkdir(path.join(project, "assets"), { recursive: true });
  await fs.mkdir(path.join(project, ".tianshu-mcp"), { recursive: true });
  const sharp = await loadSharp();
  await sharp({ create: { width: 4, height: 4, channels: 3, background: "#3355aa" } })
    .png()
    .toFile(path.join(project, "assets", "logo.png"));
  const base = {
    id: "logo",
    files: ["assets/logo.png"],
    expect: "blue gear with TIANSHU text",
  };
  const config = {
    checks: [],
    requireChanges: false,
    visual: {
      enabled: true,
      content: {
        enabled: true,
        command: process.execPath,
        argsTemplate: [JUDGE, "--image", "<image:path>", "--expect-file", "<expect:file>"],
        samples: 2,
        timeoutMs: 30_000,
        ...options.content,
      },
      contents: [
        { ...base, ...options.rule },
        ...(options.secondRule ? [{ ...base, id: "hero", ...options.secondRule }] : []),
      ],
    },
  };
  await fs.writeFile(
    path.join(project, ".tianshu-mcp", "acceptance.json"),
    JSON.stringify(config),
  );
  savedEnv.CONTENT_JUDGE_MODE = process.env.CONTENT_JUDGE_MODE;
  process.env.CONTENT_JUDGE_MODE = options.mode ?? "pass";
  const logger = new Logger(null, "error");
  const store = new TaskStore(home, logger);
  const engine = new AcceptanceEngine(store, logger);
  try {
    return await engine.runVerify({
      taskId: `tsk_content_blocked_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      projectPath: project,
      displayPath: project,
      round: 0,
      store,
      logger,
    });
  } finally {
    await engine.close();
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

it("unresolvable global command blocks the whole round without producing result rows (P2)", async () => {
  const { report, passed } = await run({ content: { command: "definitely-missing-vision-cli-xyz" } });
  expect(passed).toBe(false);
  expect(report.blockingIssues?.[0]?.code).toBe("CONTENT_COMMAND_MISSING");
  expect(report.message).toContain("验收阻塞 [CONTENT_COMMAND_MISSING]");
  // 整轮级码不存在 status/repairable，也不得产出一条 VisualResult 行
  expect(report.visual).toBeUndefined();
});

it("a rule-level command override that cannot resolve blocks the whole round too (P3)", async () => {
  // 全局命令可解析，仅第二条规则覆盖了一个不存在的命令：不得只解析全局命令而静默跳过该规则
  const { report, passed } = await run({
    secondRule: { command: "definitely-missing-override-cli" },
  });
  expect(passed).toBe(false);
  expect(report.blockingIssues?.[0]?.code).toBe("CONTENT_COMMAND_MISSING");
  expect(report.blockingIssues?.[0]?.message).toContain("hero");
  expect(report.visual).toBeUndefined();
});

it("a missing declared host environment variable blocks the whole round", async () => {
  const { report, passed } = await run({
    content: { env: { VISION_API_KEY: "TIANSHU_MISSING_HOST_VAR_FOR_TEST" } },
  });
  expect(passed).toBe(false);
  expect(report.blockingIssues?.[0]?.code).toBe("CONTENT_ENV_MISSING");
  expect(report.visual).toBeUndefined();
});

it("a failing judge command stays a single-item blocked result, not a round blocker", async () => {
  const { report, passed } = await run({ mode: "exit" });
  // optional:true 的告警项：单项 blocked，但整轮结论不受影响
  expect(passed).toBe(true);
  const result = report.visual!.results[0]!;
  expect(result.code).toBe("CONTENT_COMMAND_FAILED");
  expect(result.status).toBe("blocked");
  expect(result.optional).toBe(true);
  expect(report.blockingIssues ?? []).toEqual([]);
  expect(report.message).toContain("AI 内容告警未通过（不影响结论）: logo [CONTENT_COMMAND_FAILED]");
});

it("a blocking rule with an invalid judge output blocks only that item and fails the round", async () => {
  const { report, passed } = await run({ mode: "invalid", rule: { blocking: true } });
  expect(passed).toBe(false);
  const result = report.visual!.results[0]!;
  expect(result.code).toBe("CONTENT_OUTPUT_INVALID");
  expect(result.status).toBe("blocked");
  expect(result.optional).toBe(false);
  // blocking=true 的 blocked 项进 visualBlocked → blockingIssues（与整轮级码不同）
  expect(report.blockingIssues?.map((i) => i.code)).toContain("CONTENT_OUTPUT_INVALID");
});
