import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VisualConfigSchema } from "../../src/visual/schema.js";
import { readAcceptanceConfig } from "../../src/visual/config.js";
import { assertVisualRuntime, loadSharp, resolveBrowser } from "../../src/visual/runtime.js";
import { AcceptanceEngine } from "../../src/verify/acceptance.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { Logger } from "../../src/util/log.js";

const JUDGE = path.resolve("test/fixtures/content-judge.mjs");
const dirs: string[] = [];
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "visual-config-"));
  dirs.push(dir);
  await fs.mkdir(path.join(dir, ".tianshu-mcp"));
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

/**
 * 判定归口回归（issue #13 计划 §5 G 组）：内容项默认仅告警、`uncertain` 不致败，
 * 只有逐规则 `blocking:true` 才参与致败。归口逻辑在 AcceptanceEngine 内联，故走完整 runVerify。
 */
async function contentVerdict(mode: string, blocking: boolean): Promise<boolean> {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "visual-verdict-"));
  dirs.push(project);
  await fs.mkdir(path.join(project, "assets"), { recursive: true });
  await fs.mkdir(path.join(project, ".tianshu-mcp"), { recursive: true });
  const sharp = await loadSharp();
  await sharp({ create: { width: 4, height: 4, channels: 3, background: "#3355aa" } })
    .png()
    .toFile(path.join(project, "assets", "logo.png"));
  await fs.writeFile(
    path.join(project, ".tianshu-mcp", "acceptance.json"),
    JSON.stringify({
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
        },
        contents: [
          { id: "logo", files: ["assets/logo.png"], expect: "blue gear", blocking },
        ],
      },
    }),
  );
  const savedMode = process.env.CONTENT_JUDGE_MODE;
  const savedCounter = process.env.CONTENT_JUDGE_COUNTER;
  process.env.CONTENT_JUDGE_MODE = mode;
  process.env.CONTENT_JUDGE_COUNTER = path.join(project, ".tianshu-mcp", "counter.txt");
  const logger = new Logger(null, "error");
  const store = new TaskStore(project, logger);
  const engine = new AcceptanceEngine(store, logger);
  try {
    const { passed } = await engine.runVerify({
      taskId: `tsk_verdict_${Math.random().toString(36).slice(2, 8)}`,
      projectPath: project,
      displayPath: project,
      round: 0,
      store,
      logger,
    });
    return passed;
  } finally {
    await engine.close();
    if (savedMode === undefined) delete process.env.CONTENT_JUDGE_MODE;
    else process.env.CONTENT_JUDGE_MODE = savedMode;
    if (savedCounter === undefined) delete process.env.CONTENT_JUDGE_COUNTER;
    else process.env.CONTENT_JUDGE_COUNTER = savedCounter;
  }
}

describe("content verdict attribution", () => {
  it("warns only (never fails) when blocking is false, even on a mismatch", async () => {
    expect(await contentVerdict("fail", false)).toBe(true);
  });
  it("never fails on an uncertain verdict regardless of blocking", async () => {
    // flip 两次采样一正一反 → 平票 uncertain；blocking:true 也不得致败
    expect(await contentVerdict("flip", true)).toBe(true);
  });
  it("fails the round only when a blocking rule mismatches", async () => {
    expect(await contentVerdict("fail", true)).toBe(false);
  });
  it("passes when a blocking rule matches", async () => {
    expect(await contentVerdict("pass", true)).toBe(true);
  });
});

describe("visual configuration", () => {
  it("preserves omitted commands versus explicitly empty commands", async () => {
    const dir = await fixture();
    expect(await readAcceptanceConfig(dir)).toBeNull();
    const file = path.join(dir, ".tianshu-mcp", "acceptance.json");
    await fs.writeFile(file, JSON.stringify({ visual: { enabled: false } }));
    expect((await readAcceptanceConfig(dir))?.checks).toBeUndefined();
    await fs.writeFile(file, JSON.stringify({ checks: [] }));
    expect((await readAcceptanceConfig(dir))?.checks).toEqual([]);
  });
  it.each([
    { enabled: true },
    { enabled: false, typo: 1 },
    { defaults: { maxDiffRatio: 1.001 } },
    { images: [{ id: "a", files: ["../secret.png"] }] },
    {
      images: [
        { id: "a", files: ["a.png"] },
        { id: "A", files: ["b.png"] },
      ],
    },
    { pages: [{ id: "a", source: { type: "existing", url: "https://example.com" } }] },
    { allowedOrigins: ["https://example.com/path"] },
    { images: [{ id: "a", files: ["a.png"], width: { exact: 2, max: 3 } }] },
    { pages: [{ id: "a", source: { type: "static", root: "." }, steps: [{ type: "wait" }] }] },
  ])("rejects invalid rules: %j", (config) => {
    expect(VisualConfigSchema.safeParse(config).success).toBe(false);
  });
  it("accepts inclusive threshold boundaries and centralized defaults", () => {
    const parsed = VisualConfigSchema.parse({ defaults: { maxDiffRatio: 0, pixelThreshold: 1 } });
    expect(parsed.limits.concurrency).toBe(1);
    expect(parsed.viewports.map((v) => v.id)).toEqual(["desktop", "mobile"]);
  });
  it("blocks malformed config even when temporary checks replace commands", async () => {
    const dir = await fixture();
    await fs.writeFile(path.join(dir, ".tianshu-mcp", "acceptance.json"), "{");
    const logger = new Logger(null, "error");
    const store = new TaskStore(dir, logger);
    const { report, passed } = await new AcceptanceEngine(store, logger).runVerify({
      taskId: "tsk_invalid",
      projectPath: dir,
      displayPath: dir,
      round: 0,
      store,
      logger,
      checksMode: "replace",
      extraChecks: [
        {
          name: "should-not-run",
          cmd: [process.execPath, "-e", "process.exit(0)"],
          displayCmd: "node",
        },
      ],
    });
    expect(passed).toBe(false);
    expect(report.blockingIssues?.[0]?.code).toBe("CONFIG_INVALID");
    expect(report.checks.some((c) => c.name === "should-not-run")).toBe(false);
  });
  it("reports missing browser instead of falling back", async () => {
    await expect(resolveBrowser({ mode: "managed" }, await fixture())).rejects.toMatchObject({
      code: "BROWSER_MISSING",
    });
  });
  it("requires Node 20.3 only for visual runtime", () => {
    expect(() => assertVisualRuntime("20.2.0")).toThrow();
    expect(() => assertVisualRuntime("20.3.0")).not.toThrow();
    expect(() => assertVisualRuntime("24.0.0")).not.toThrow();
  });
});
