/**
 * 集成测试：query_task 的细粒度事件回传（issue #18）。
 *
 * 用真实 buildServer + SDK client 走完整 MCP 层。stub agent 是 CLI 适配器、不上报事件，
 * 因此这里直接往任务事件流里追加事件来模拟「实现了上报的 GUI 适配器」，验证读取侧
 * （readRecentAgentEvents → meta.recentEvents + 文本区）以及默认参数与条数上限。
 * 同时覆盖验收标准中「未实现事件上报的适配器行为与既有版本一致」——见第一个用例。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startTestServer,
  makeGitProject,
  callTool,
  parseMeta,
  waitForTerminal,
  rmrf,
  type TestServer,
} from "../test-utils.js";

let ts: TestServer;
let project: string;

type MetaWithEvents = { recentEvents?: { ts: string; event: string; detail?: string }[] };

beforeAll(async () => {
  ts = await startTestServer();
  project = await makeGitProject("good");
}, 60_000);

afterAll(async () => {
  await ts?.close();
  if (project) await rmrf(project).catch(() => {});
  if (ts) await rmrf(ts.home).catch(() => {});
});

async function runStubTask(task: string): Promise<string> {
  const { text } = await callTool(ts.client, "run_task", {
    projectPath: project,
    agentId: "stub",
    task,
    autoVerify: false,
    autoFixRounds: 0,
  });
  const { meta } = parseMeta(text);
  expect(meta).not.toBeNull();
  const taskId = meta!.taskId as string;
  await waitForTerminal(ts.client, taskId);
  return taskId;
}

describe("query_task 的 recentEvents（issue #18）", () => {
  it("未实现事件上报的适配器：recentEvents 为空数组，其余字段与既有行为一致", async () => {
    const taskId = await runStubTask("请实现：新建 no-events.txt，内容为 PASS。");

    const { text } = await callTool(ts.client, "query_task", { taskId });
    const { meta } = parseMeta(text);
    const m = meta as MetaWithEvents;
    // 纯增量字段：存在但为空，且不改变既有字段
    expect(m.recentEvents).toEqual([]);
    expect(meta!.status).toBe("succeeded");
    expect(meta!.taskId).toBe(taskId);
    expect(meta!.ok).toBe(true);
    expect(typeof meta!.message).toBe("string");
    // 文本区不应出现事件段落
    const before = text.split("---tianshu-mcp-meta---")[0]!;
    expect(before).not.toContain("最近事件");
  });

  it("上报了事件的适配器：meta.recentEvents 与文本区都能看到最近事件", async () => {
    const taskId = await runStubTask("请实现：新建 with-events.txt，内容为 PASS。");

    // 模拟 GUI 适配器在关键节点上报
    await ts.assembly.store.appendEvent(taskId, "task_dispatched", "running", "指令已确认送达");
    await ts.assembly.store.appendEvent(taskId, "confirmation_dialog_detected", "running", "已唤起原生「选择文件夹」对话框");
    await ts.assembly.store.appendEvent(taskId, "file_modification_started", "running", "停止按钮出现，开始执行（可能开始改动文件）");

    const { text } = await callTool(ts.client, "query_task", { taskId });
    const { meta } = parseMeta(text);
    const m = meta as MetaWithEvents;

    expect(m.recentEvents?.map((e) => e.event)).toEqual([
      "task_dispatched",
      "confirmation_dialog_detected",
      "file_modification_started",
    ]);
    expect(m.recentEvents?.map((e) => e.detail)).toEqual([
      "指令已确认送达",
      "已唤起原生「选择文件夹」对话框",
      "停止按钮出现，开始执行（可能开始改动文件）",
    ]);

    // 文本区同样可读（便于人直接看，不必解析 meta 块）
    const before = text.split("---tianshu-mcp-meta---")[0]!;
    expect(before).toContain("最近事件（3 条，旧 → 新）");
    expect(before).toContain("task_dispatched — 指令已确认送达");
    expect(before).toContain("file_modification_started");
  });

  it("eventLimit 控制条数，且取最近的 N 条", async () => {
    const taskId = await runStubTask("请实现：新建 limit-events.txt，内容为 PASS。");
    const kinds = [
      "task_dispatched",
      "confirmation_dialog_detected",
      "awaiting_user_authorization",
      "file_modification_started",
      "rework_triggered",
    ] as const;
    for (const k of kinds) {
      await ts.assembly.store.appendEvent(taskId, k, "running", `d-${k}`);
    }

    const { text } = await callTool(ts.client, "query_task", { taskId, eventLimit: 2 });
    const { meta } = parseMeta(text);
    const m = meta as MetaWithEvents;
    expect(m.recentEvents?.map((e) => e.event)).toEqual([
      "file_modification_started",
      "rework_triggered",
    ]);
  });

  it("不传 eventLimit 时默认返回最近 10 条", async () => {
    const taskId = await runStubTask("请实现：新建 default-limit.txt，内容为 PASS。");
    // 写 12 条，默认应只回 10 条
    for (let i = 0; i < 12; i++) {
      await ts.assembly.store.appendEvent(taskId, "task_dispatched", "running", `第 ${i} 条`);
    }

    const { text } = await callTool(ts.client, "query_task", { taskId });
    const { meta } = parseMeta(text);
    const m = meta as MetaWithEvents;
    expect(m.recentEvents).toHaveLength(10);
    expect(m.recentEvents?.[0]?.detail).toBe("第 2 条");
    expect(m.recentEvents?.at(-1)?.detail).toBe("第 11 条");
  });

  it("eventLimit 超上限被协议层拒绝", async () => {
    const taskId = await runStubTask("请实现：新建 reject-limit.txt，内容为 PASS。");
    const res = await ts.client.callTool({
      name: "query_task",
      arguments: { taskId, eventLimit: 51 },
    });
    expect(res.isError).toBe(true);
  });
});

describe("rework_task 上报 rework_triggered（issue #18）", () => {
  it("手动返修写入类型化事件而非匿名 note", async () => {
    const taskId = await runStubTask("请实现：新建 rework-events.txt，内容为 PASS。");

    const { text } = await callTool(ts.client, "rework_task", {
      taskId,
      feedback: "补充单元测试",
    });
    expect(parseMeta(text).meta?.taskId).toBe(taskId);

    const recent = await ts.assembly.store.readRecentAgentEvents(taskId, 10);
    const rework = recent.filter((e) => e.event === "rework_triggered");
    expect(rework).toHaveLength(1);
    expect(rework[0]!.detail).toContain("补充单元测试");
    expect(rework[0]!.data).toEqual({ mode: "manual" });
  });

  it("自动返修由编排器上报 rework_triggered（mode=auto）", async () => {
    // fix-on-first 剧本：首轮验收失败，返修后通过 —— 必然经过自动返修分支
    const reworkProject = await makeGitProject("fix-on-first");
    const { text } = await callTool(ts.client, "run_task", {
      projectPath: reworkProject,
      agentId: "stub",
      task: "请实现：让验收检查通过。",
      autoVerify: true,
      autoFixRounds: 2,
    });
    const taskId = parseMeta(text).meta!.taskId as string;
    await waitForTerminal(ts.client, taskId);
    await rmrf(reworkProject).catch(() => {});

    const recent = await ts.assembly.store.readRecentAgentEvents(taskId, 20);
    const rework = recent.filter((e) => e.event === "rework_triggered");
    expect(rework).toHaveLength(1);
    expect(rework[0]!.data?.mode).toBe("auto");
    expect(rework[0]!.data?.round).toBe(1);
    expect(Array.isArray(rework[0]!.data?.failedChecks)).toBe(true);
  });
});
