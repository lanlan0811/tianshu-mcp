/**
 * 集成测试：任务终态 webhook 通知（issue #22）。
 *
 * 用真实 buildServer + stub agent + 真实本地 http 服务，验证：
 * - 状态跃迁时**恰好一次** POST，且请求体/事件头正确；
 * - 不同状态映射到不同事件类别（含 needs_attention 走干跑违规路径）；
 * - 端点恒 500 / 端口不可达时，**任务仍到达终态**（通知绝不阻塞或改变状态机）；
 * - 未配置时零请求（默认关闭）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import {
  startTestServer,
  makeGitProject,
  callTool,
  parseMeta,
  waitForTerminal,
  startMockWebhook,
  closedPortUrl,
  waitForCondition,
  rmrf,
  type TestServer,
  type MockWebhook,
} from "../test-utils.js";

let ts: TestServer;
const projects: string[] = [];
const hooks: MockWebhook[] = [];

beforeAll(async () => {
  ts = await startTestServer();
}, 60_000);

afterEach(async () => {
  await Promise.all(hooks.splice(0).map((h) => h.close()));
  await fsp.rm(path.join(ts.home, "config.json"), { force: true }).catch(() => {});
});

afterAll(async () => {
  await Promise.all(hooks.splice(0).map((h) => h.close()));
  await ts?.close();
  for (const p of projects) await rmrf(p).catch(() => {});
  if (ts) await rmrf(ts.home).catch(() => {});
});

async function newProject(playbook: "good" | "never" | "dry-run-edit"): Promise<string> {
  const p = await makeGitProject(playbook);
  projects.push(p);
  return p;
}

async function newHook(opts: { status?: number; failFirst?: number } = {}): Promise<MockWebhook> {
  const h = await startMockWebhook(opts);
  hooks.push(h);
  return h;
}

/** 写全局 config.json（notifier 每次发送前惰性读取，故可在 server 启动后写） */
async function writeWebhookConfig(webhook: unknown): Promise<void> {
  await fsp.writeFile(
    path.join(ts.home, "config.json"),
    JSON.stringify({ notifications: { webhook } }, null, 2),
    "utf8",
  );
}

async function runTask(
  projectPath: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { text } = await callTool(ts.client, "run_task", {
    projectPath,
    agentId: "stub",
    task: "请实现：让验收检查通过。",
    autoVerify: true,
    autoFixRounds: 0,
    ...extra,
  });
  const meta = parseMeta(text).meta;
  expect(meta, `run_task 未返回 meta：${text.slice(0, 400)}`).not.toBeNull();
  return waitForTerminal(ts.client, meta!.taskId as string, 90_000);
}

describe("终态跃迁触发通知", () => {
  it("任务成功 → 恰好一次 POST，事件为 done，请求体含任务标识与状态", async () => {
    const h = await newHook();
    await writeWebhookConfig({ enabled: true, url: h.url, backoffMs: 0 });

    const final = await runTask(await newProject("good"));
    expect(final.status).toBe("succeeded");
    expect(await waitForCondition(() => h.received.length >= 1)).toBe(true);

    // 恰好一次（等一小会儿确认没有重复投递）
    await new Promise((r) => setTimeout(r, 500));
    expect(h.received).toHaveLength(1);

    const got = h.received[0]!;
    expect(got.status).toBe(200);
    expect(got.headers["x-tianshu-event"]).toBe("done");
    const body = got.body as Record<string, unknown>;
    expect(body.taskId).toBe(final.taskId);
    expect(body.event).toBe("done");
    expect(body.status).toBe("succeeded");
    expect(typeof body.ts).toBe("string");
    expect(body.agentId).toBe("stub");
  }, 150_000);

  it("任务失败 → 事件为 failed", async () => {
    const h = await newHook();
    await writeWebhookConfig({ enabled: true, url: h.url, backoffMs: 0 });

    const final = await runTask(await newProject("never"));
    expect(final.status).toBe("failed");
    expect(await waitForCondition(() => h.received.length >= 1)).toBe(true);
    expect((h.received[0]!.body as Record<string, unknown>).event).toBe("failed");
    expect(h.received[0]!.headers["x-tianshu-event"]).toBe("failed");
  }, 150_000);

  it("needs_attention（干跑违规）→ 事件为 needs_human", async () => {
    const h = await newHook();
    await writeWebhookConfig({ enabled: true, url: h.url, backoffMs: 0 });

    const final = await runTask(await newProject("dry-run-edit"), { dryRun: true });
    expect(final.status).toBe("needs_attention");
    expect(await waitForCondition(() => h.received.length >= 1)).toBe(true);
    expect((h.received[0]!.body as Record<string, unknown>).event).toBe("needs_human");
  }, 150_000);
});

describe("默认关闭与订阅过滤", () => {
  it("未配置 webhook → 零请求，任务照常到终态", async () => {
    const h = await newHook();
    // 不写 config.json
    const final = await runTask(await newProject("good"));
    expect(final.status).toBe("succeeded");
    await new Promise((r) => setTimeout(r, 600));
    expect(h.attempts()).toBe(0);
  }, 150_000);

  it("enabled=false → 零请求", async () => {
    const h = await newHook();
    await writeWebhookConfig({ enabled: false, url: h.url });

    const final = await runTask(await newProject("good"));
    expect(final.status).toBe("succeeded");
    await new Promise((r) => setTimeout(r, 600));
    expect(h.attempts()).toBe(0);
  }, 150_000);

  it("只订阅 failed 时，成功任务不触发通知", async () => {
    const h = await newHook();
    await writeWebhookConfig({ enabled: true, url: h.url, events: ["failed"], backoffMs: 0 });

    const final = await runTask(await newProject("good"));
    expect(final.status).toBe("succeeded");
    await new Promise((r) => setTimeout(r, 600));
    expect(h.attempts()).toBe(0);
  }, 150_000);
});

describe("发送失败不影响状态机", () => {
  it("端点恒 500 → 任务仍成功到终态；尝试次数 = 1 + maxRetries 后放弃", async () => {
    const h = await newHook({ status: 500 });
    await writeWebhookConfig({ enabled: true, url: h.url, maxRetries: 1, backoffMs: 0 });

    const final = await runTask(await newProject("good"));
    // 关键：通知全失败也没有影响任务本体
    expect(final.status).toBe("succeeded");
    expect(await waitForCondition(() => h.attempts() >= 2)).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(h.attempts()).toBe(2);
  }, 150_000);

  it("端口不可达 → 任务仍到终态（仅告警，不抛错）", async () => {
    const url = await closedPortUrl();
    await writeWebhookConfig({ enabled: true, url, maxRetries: 0, backoffMs: 0 });

    const final = await runTask(await newProject("good"));
    expect(final.status).toBe("succeeded");
  }, 150_000);

  it("webhook 配置写坏（enabled 但缺 url）→ 落到 last-known-good，任务不受影响", async () => {
    await fsp.writeFile(
      path.join(ts.home, "config.json"),
      JSON.stringify({ notifications: { webhook: { enabled: true } } }, null, 2),
      "utf8",
    );
    const final = await runTask(await newProject("good"));
    expect(final.status).toBe("succeeded");
  }, 150_000);
});
