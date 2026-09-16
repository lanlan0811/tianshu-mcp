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
 * 内容校验全链路（issue #13 计划 §5 G 组，无浏览器）：
 * 以 test/fixtures/content-judge.mjs 为自备命令，覆盖
 * 告警不改 verdict / blocking 致败 / uncertain 不致败 / 缓存零重跑 / 单项失败仅告警可见。
 */
const JUDGE = path.resolve("test/fixtures/content-judge.mjs");
const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

async function scenario(options: {
  blocking?: boolean;
  mode: string;
  samples?: number;
  rounds?: number;
  minConfidence?: number;
}): Promise<{
  reports: { report: VerifyReport; passed: boolean }[];
  counterLines: () => Promise<number>;
  store: TaskStore;
}> {
  const blocking = options.blocking ?? false;
  const samples = options.samples ?? 2;
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "视觉 内容-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "视觉 内容-home-"));
  dirs.push(project, home);
  await fs.mkdir(path.join(project, "assets"), { recursive: true });
  await fs.mkdir(path.join(project, ".tianshu-mcp"), { recursive: true });
  const sharp = await loadSharp();
  await sharp({ create: { width: 4, height: 4, channels: 3, background: "#3355aa" } })
    .png()
    .toFile(path.join(project, "assets", "logo.png"));
  const counter = path.join(project, ".tianshu-mcp", "judge-counter.txt");
  const config = {
    checks: [],
    requireChanges: false,
    visual: {
      enabled: true,
      content: {
        enabled: true,
        command: process.execPath,
        argsTemplate: [JUDGE, "--image", "<image:path>", "--expect-file", "<expect:file>"],
        samples,
        timeoutMs: 30_000,
        ...(options.minConfidence !== undefined ? { minConfidence: options.minConfidence } : {}),
      },
      contents: [
        { id: "logo", files: ["assets/logo.png"], expect: "blue gear with TIANSHU text", blocking },
      ],
    },
  };
  await fs.writeFile(
    path.join(project, ".tianshu-mcp", "acceptance.json"),
    JSON.stringify(config),
  );
  savedEnv.CONTENT_JUDGE_MODE = process.env.CONTENT_JUDGE_MODE;
  savedEnv.CONTENT_JUDGE_COUNTER = process.env.CONTENT_JUDGE_COUNTER;
  process.env.CONTENT_JUDGE_MODE = options.mode;
  process.env.CONTENT_JUDGE_COUNTER = counter;
  const logger = new Logger(null, "error");
  const store = new TaskStore(home, logger);
  const engine = new AcceptanceEngine(store, logger);
  const taskId = `tsk_content_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const reports: { report: VerifyReport; passed: boolean }[] = [];
  try {
    for (let round = 0; round < (options.rounds ?? 1); round++) {
      reports.push(
        await engine.runVerify({
          taskId,
          projectPath: project,
          displayPath: project,
          round,
          store,
          logger,
        }),
      );
    }
  } finally {
    await engine.close();
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  return {
    reports,
    counterLines: async () => {
      try {
        return (await fs.readFile(counter, "utf8")).trim().split(/\r?\n/).filter(Boolean).length;
      } catch {
        return 0;
      }
    },
    store,
  };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

it("warning content checks pass the round and land in reports with stable codes", async () => {
  const { reports, counterLines } = await scenario({ mode: "pass" });
  const { report, passed } = reports[0]!;
  expect(passed).toBe(true);
  const result = report.visual!.results[0]!;
  expect(result.kind).toBe("content");
  expect(result.code).toBe("CONTENT_MATCH");
  expect(result.status).toBe("passed");
  expect(result.optional).toBe(true);
  expect(result.message).toContain("blue gear with TIANSHU text");
  expect(result.content?.cached).toBe(false);
  expect(result.content?.provider).toBe(process.execPath);
  expect(await counterLines()).toBe(2);
  const md = await fs.readFile(report.files.md, "utf8");
  expect(md).toContain("CONTENT_MATCH");
  expect(md).toContain("期望描述：blue gear with TIANSHU text");
  expect(md).toContain("内容校验项默认为告警");
  const json = JSON.parse(await fs.readFile(report.files.json, "utf8"));
  expect(json.visual.results[0].code).toBe("CONTENT_MATCH");
  const html = await fs.readFile(report.files.html!, "utf8");
  expect(html).toContain("<th>Sample</th>");
  expect(html).toContain("blue gear with TIANSHU text");
  // 证据图落任务目录（离线自包含）
  expect(result.artifacts?.source).toBeTruthy();
  await expect(fs.access(result.artifacts!.source!)).resolves.toBeUndefined();
});

it("blocking content mismatches fail the round", async () => {
  const { reports } = await scenario({ mode: "fail", blocking: true });
  const { report, passed } = reports[0]!;
  expect(passed).toBe(false);
  const result = report.visual!.results[0]!;
  expect(result.optional).toBe(false);
  expect(result.code).toBe("CONTENT_MISMATCH");
  expect(result.status).toBe("failed");
  expect(result.repairable).toBe(true);
  expect(report.message).toContain("视觉缺陷: logo");
});

it("uncertain verdicts never gate the round and surface as a warning line", async () => {
  const { reports, counterLines } = await scenario({ mode: "flip", samples: 2 });
  const { report, passed } = reports[0]!;
  expect(passed).toBe(true);
  const result = report.visual!.results[0]!;
  expect(result.code).toBe("CONTENT_UNCERTAIN");
  expect(result.status).toBe("uncertain");
  expect(result.optional).toBe(true);
  expect(report.message).toContain("AI 内容判定不确定（仅告警）: logo");
  expect(await counterLines()).toBe(2);
});

it("low confidence downgrades to uncertain when a gate is configured", async () => {
  const { reports } = await scenario({ mode: "low-confidence", samples: 2, minConfidence: 0.6 });
  const result = reports[0]!.report.visual!.results[0]!;
  expect(result.status).toBe("uncertain");
  expect(result.code).toBe("CONTENT_UNCERTAIN");
  expect(result.content?.confidenceGate).toBe("downgraded");
  expect(result.message).toContain("below configured 0.6");
});

it("commands that omit confidence are not misjudged by the configured gate", async () => {
  const { reports } = await scenario({ mode: "no-confidence", samples: 2, minConfidence: 0.6 });
  const result = reports[0]!.report.visual!.results[0]!;
  expect(result.status).toBe("passed");
  expect(result.content?.confidenceGate).toBe("no-confidence");
  const md = await fs.readFile(reports[0]!.report.files.md, "utf8");
  expect(md).toContain("命令未提供 confidence，minConfidence 未生效");
});

it("single-item command failures stay warnings but become visible in the round message", async () => {
  const { reports, counterLines } = await scenario({ mode: "invalid" });
  const { report, passed } = reports[0]!;
  expect(passed).toBe(true);
  const result = report.visual!.results[0]!;
  expect(result.code).toBe("CONTENT_OUTPUT_INVALID");
  expect(result.status).toBe("blocked");
  expect(result.optional).toBe(true);
  expect(report.message).toContain("AI 内容告警未通过（不影响结论）: logo [CONTENT_OUTPUT_INVALID]");
  expect(report.blockingIssues ?? []).toEqual([]);
  // 命令级失败发生在首个采样 → 只调用了一次
  expect(await counterLines()).toBe(1);
});

it("cache makes the second round run zero judge invocations", async () => {
  const { reports, counterLines } = await scenario({ mode: "pass", rounds: 2 });
  expect(reports[1]!.report.round).toBe(1);
  const first = reports[0]!.report.visual!.results[0]!;
  const second = reports[1]!.report.visual!.results[0]!;
  expect(first.content?.cached).toBe(false);
  expect(second.content?.cached).toBe(true);
  expect(second.code).toBe(first.code);
  expect(second.status).toBe(first.status);
  expect(await counterLines()).toBe(2);
  expect(reports[1]!.passed).toBe(true);
});
