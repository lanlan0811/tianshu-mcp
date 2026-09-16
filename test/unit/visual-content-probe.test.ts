import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadSharp } from "../../src/visual/runtime.js";
import { clearContentCacheForTask, probeContentRules } from "../../src/visual/manage.js";
import { writeContentCache } from "../../src/visual/content-cache.js";

/**
 * F 组 CLI 能力（issue #13）：
 * `visual content probe` 按声明规则跑真实判定但**不写证据、不写缓存**；
 * `visual content cache clear` 清理任务级判定缓存（派生物，无需 --apply）。
 */
const JUDGE = path.resolve("test/fixtures/content-judge.mjs");
const dirs: string[] = [];

async function fixture(): Promise<{ project: string; home: string }> {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "视觉 探测-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "视觉 探测-home-"));
  dirs.push(project, home);
  await fs.mkdir(path.join(project, "assets"), { recursive: true });
  await fs.mkdir(path.join(project, ".tianshu-mcp"), { recursive: true });
  const sharp = await loadSharp();
  await sharp({ create: { width: 4, height: 4, channels: 3, background: "#3355aa" } })
    .png()
    .toFile(path.join(project, "assets", "logo.png"));
  await fs.writeFile(
    path.join(project, ".tianshu-mcp", "acceptance.json"),
    JSON.stringify({
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
          { id: "logo", files: ["assets/logo.png"], expect: "blue gear with TIANSHU text" },
        ],
      },
    }),
  );
  return { project, home };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

it("probe runs the declared rule without writing evidence or cache", async () => {
  const { project, home } = await fixture();
  const saved = process.env.CONTENT_JUDGE_MODE;
  process.env.CONTENT_JUDGE_MODE = "pass";
  try {
    const output = await probeContentRules(home, project);
    expect(output.results).toHaveLength(1);
    const probe = output.results[0]!;
    expect(probe.id).toBe("logo");
    expect(probe.status).toBe("passed");
    expect(probe.code).toBe("CONTENT_MATCH");
    expect(probe.votes).toHaveLength(2);
    expect(probe.provider).toBe(process.execPath);
    expect(output.commands).toEqual([
      { id: "logo", command: process.execPath, resolved: true, allowRemote: false },
    ]);
    // 不落证据、不落缓存
    const taskRoot = path.join(project, "visual");
    await expect(fs.access(taskRoot)).rejects.toThrow();
    await expect(fs.access(path.join(project, "visual-content-cache"))).rejects.toThrow();
  } finally {
    if (saved === undefined) delete process.env.CONTENT_JUDGE_MODE;
    else process.env.CONTENT_JUDGE_MODE = saved;
  }
});

it("probe can select a single rule and rejects unknown rule ids", async () => {
  const { project, home } = await fixture();
  const saved = process.env.CONTENT_JUDGE_MODE;
  process.env.CONTENT_JUDGE_MODE = "pass";
  try {
    expect((await probeContentRules(home, project, "logo")).results).toHaveLength(1);
    await expect(probeContentRules(home, project, "missing")).rejects.toMatchObject({
      code: "CONTENT_RULE_UNKNOWN",
    });
  } finally {
    if (saved === undefined) delete process.env.CONTENT_JUDGE_MODE;
    else process.env.CONTENT_JUDGE_MODE = saved;
  }
});

it("probe reports command-level failures as result codes instead of throwing", async () => {
  const { project, home } = await fixture();
  const saved = process.env.CONTENT_JUDGE_MODE;
  process.env.CONTENT_JUDGE_MODE = "exit";
  try {
    const probe = (await probeContentRules(home, project)).results[0]!;
    expect(probe.status).toBe("blocked");
    expect(probe.code).toBe("CONTENT_COMMAND_FAILED");
  } finally {
    if (saved === undefined) delete process.env.CONTENT_JUDGE_MODE;
    else process.env.CONTENT_JUDGE_MODE = saved;
  }
});

it("cache clear removes only the task-level judgement cache", async () => {
  const { home } = await fixture();
  const taskDir = path.join(home, "tasks", "tsk_cache");
  await fs.mkdir(taskDir, { recursive: true });
  await writeContentCache(taskDir, {
    schemaVersion: 1,
    key: "abc",
    imageSha256: "x",
    expectDigest: "y",
    status: "passed",
    code: "CONTENT_MATCH",
    votes: [],
    createdAt: new Date().toISOString(),
    durationMs: 1,
  });
  const cleared = await clearContentCacheForTask(home, "tsk_cache");
  expect(cleared).toEqual({ taskId: "tsk_cache", removed: 1 });
  await expect(fs.access(path.join(taskDir, "visual-content-cache"))).rejects.toThrow();
  // 已清空后再清是幂等的
  expect(await clearContentCacheForTask(home, "tsk_cache")).toEqual({
    taskId: "tsk_cache",
    removed: 0,
  });
});
