/**
 * 协议级测试：官方 SDK client 连接 in-memory transport 后的 server。
 * 断言 11 个工具可见、调用返回格式（文本 + meta 块 / 参数校验错误）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestServer, callTool, parseMeta, rmrf, type TestServer } from "../test-utils.js";
import { TOOL_DEFS } from "../../src/mcp/tools.js";
import pkg from "../../package.json" with { type: "json" };

let ts: TestServer;

beforeAll(async () => {
  ts = await startTestServer();
}, 60_000);
afterAll(async () => {
  await ts?.close();
  if (ts) await rmrf(ts.home);
});

describe("服务版本", () => {
  it("MCP serverInfo.version 等于 package.json.version（单一版本源，S4）", async () => {
    const info = ts.client.getServerVersion()!;
    expect(info.name).toBe("tianshu-mcp");
    expect(info.version).toBe(pkg.version);
  });
});

describe("工具 annotations（S4/S6：直接断言真实 tools/list）", () => {
  it("read 类工具 readOnlyHint=true，write/execute 类 false；cancel/rework destructiveHint=true", async () => {
    const tools = await ts.client.listTools();
    const byName = new Map(tools.tools.map((t) => [t.name, t]));
    // 读类
    for (const name of ["query_task", "list_tasks", "get_task_report", "get_profiles"]) {
      expect(byName.get(name)?.annotations?.readOnlyHint, `${name} readOnly`).toBe(true);
    }
    // 写类 + execute 类
    for (const name of ["run_task", "cancel_task", "rework_task", "continue_task", "verify_task"]) {
      expect(byName.get(name)?.annotations?.readOnlyHint, `${name} readOnly`).toBe(false);
    }
    // destructive
    expect(byName.get("cancel_task")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("rework_task")?.annotations?.destructiveHint).toBe(true);
    // openWorld：仅 run_task
    expect(byName.get("run_task")?.annotations?.openWorldHint).toBe(true);
    expect(byName.get("query_task")?.annotations?.openWorldHint).toBe(false);
  });

  // issue #17：capability 真值表——11 工具 × capability × 四个 MCP 注解逐一锁定。
  // verify_task 自 v0.6.1 起归 execute：会跑项目命令，故 readOnlyHint 诚实为 false，
  // 但 requireApproval 仍为 false（免审批），这是本次唯一对外可见的元数据变更。
  it("能力真值表：capability / requireApproval / 四注解逐工具一致", async () => {
    const { tools } = await ts.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const table: Array<{
      name: string;
      capability: "read" | "write" | "execute";
      requireApproval: boolean;
      readOnlyHint: boolean;
      destructiveHint: boolean;
      openWorldHint: boolean;
      idempotentHint: boolean;
    }> = [
      { name: "run_task", capability: "write", requireApproval: true, readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true },
      { name: "continue_task", capability: "write", requireApproval: true, readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      { name: "query_task", capability: "read", requireApproval: false, readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      { name: "list_tasks", capability: "read", requireApproval: false, readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      { name: "get_task_report", capability: "read", requireApproval: false, readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      { name: "cancel_task", capability: "write", requireApproval: true, readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
      { name: "verify_task", capability: "execute", requireApproval: false, readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      { name: "rework_task", capability: "write", requireApproval: true, readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
      { name: "get_profiles", capability: "read", requireApproval: false, readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      { name: "prepare_visual_baseline", capability: "write", requireApproval: true, readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      { name: "approve_visual_baseline", capability: "write", requireApproval: true, readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
    ];
    // 真值表必须与真实工具面一一对应（多一个少一个都算漂移）
    expect(table.map((r) => r.name).sort()).toEqual([...byName.keys()].sort());
    for (const row of table) {
      const def = TOOL_DEFS.find((d) => d.name === row.name);
      expect(def?.capability, `${row.name} capability(TOOL_DEFS)`).toBe(row.capability);
      expect(def?.requireApproval, `${row.name} requireApproval(TOOL_DEFS)`).toBe(row.requireApproval);
      const tool = byName.get(row.name);
      expect(tool?._meta?.capability, `${row.name} _meta.capability`).toBe(row.capability);
      expect(tool?._meta?.requireApproval, `${row.name} _meta.requireApproval`).toBe(row.requireApproval);
      const ann = tool?.annotations;
      expect(ann?.readOnlyHint, `${row.name} readOnlyHint`).toBe(row.readOnlyHint);
      expect(ann?.destructiveHint, `${row.name} destructiveHint`).toBe(row.destructiveHint);
      expect(ann?.openWorldHint, `${row.name} openWorldHint`).toBe(row.openWorldHint);
      expect(ann?.idempotentHint, `${row.name} idempotentHint`).toBe(row.idempotentHint);
    }
  });

  // issue #15：MCP 四注解补齐——幂等提示只在支持 idempotencyKey 的两个工具上为 true
  it("idempotentHint 仅 run_task / verify_task 为 true", async () => {
    const tools = await ts.client.listTools();
    const byName = new Map(tools.tools.map((t) => [t.name, t]));
    for (const name of ["run_task", "verify_task"]) {
      expect(byName.get(name)?.annotations?.idempotentHint, `${name} idempotent`).toBe(true);
    }
    for (const name of [
      "query_task",
      "list_tasks",
      "get_task_report",
      "get_profiles",
      "cancel_task",
      "rework_task",
      "continue_task",
      "prepare_visual_baseline",
      "approve_visual_baseline",
    ]) {
      expect(byName.get(name)?.annotations?.idempotentHint, `${name} idempotent`).not.toBe(true);
    }
  });
});

describe("工具面", () => {
  it("注册 11 个工具且名称与能力标注符合视觉验收计划", async () => {
    const tools = await ts.client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "approve_visual_baseline",
      "cancel_task",
      "continue_task",
      "get_profiles",
      "get_task_report",
      "list_tasks",
      "prepare_visual_baseline",
      "query_task",
      "rework_task",
      "run_task",
      "verify_task",
    ]);
    // 每个工具在 TOOL_DEFS 有声明
    for (const t of tools.tools) {
      const def = TOOL_DEFS.find((d) => d.name === t.name);
      expect(def, `工具 ${t.name} 缺声明`).toBeDefined();
      expect(def!.inputSchema).toBeDefined();
      expect(["read", "write", "execute"]).toContain(def!.capability);
    }
    // issue #17：数量硬断言——TOOL_DEFS 与真实工具面必须一一对应。
    // 仅比对名字数组相等时，TOOL_DEFS 多一条无人注册的条目不会被拦住。
    expect(TOOL_DEFS).toHaveLength(tools.tools.length);
    expect(new Set(TOOL_DEFS.map((d) => d.name)).size).toBe(tools.tools.length);
  });

  it("continue_task 是需审批的写工具", () => {
    const def = TOOL_DEFS.find((d) => d.name === "continue_task");
    expect(def?.capability).toBe("write");
    expect(def?.requireApproval).toBe(true);
  });

  it("视觉基准工具公开有副作用与宿主审批元数据", async () => {
    const { tools } = await ts.client.listTools();
    for (const name of ["prepare_visual_baseline", "approve_visual_baseline"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.annotations?.readOnlyHint).toBe(false);
      expect(tool?._meta?.requireApproval).toBe(true);
    }
    expect(tools.find((t) => t.name === "approve_visual_baseline")?.annotations?.destructiveHint).toBe(true);
  });

  it("get_profiles 返回文本 + 可解析 meta 块", async () => {
    const { text } = await callTool(ts.client, "get_profiles", {});
    const { meta } = parseMeta(text);
    expect(meta).not.toBeNull();
    expect(meta!.ok).toBe(true);
    expect(text).toContain("stub");
    expect(text).toContain("zcode");
    expect(text).toContain("driver=gui");
    expect(text).toContain("profileStatus=research");
  });

  it("list_tasks 空表也返回合法格式", async () => {
    const { text } = await callTool(ts.client, "list_tasks", {});
    const { meta } = parseMeta(text);
    expect(meta!.ok).toBe(true);
  });

  it("参数校验：run_task 缺 projectPath 时协议层放行，由语义层拒绝不支持的 agent", async () => {
    // 显式用 stub agent（startTestServer 已注入其 profile）：若依赖默认 agent=codex，
    // 断言会随「本机装了 codex / CI 没装」两条路径分叉，测试就不再跨平台确定。
    const res = await ts.client.callTool({
      name: "run_task",
      arguments: { agentId: "stub", task: "没有项目路径" },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[]).map((c) => c.text).join("\n");
    // issue #12：projectPath 已可选——协议层必须放行（不再 -32602 / 参数不合法），
    // 由语义层说明「该 agent 需要 projectPath」，且绝不真的提交任务。
    expect(text).not.toMatch(/-32602|参数不合法|Invalid arguments|Input validation/i);
    expect(text).toMatch(/需要 projectPath/);
    expect(text).toMatch(/仅支持 ZCode/);
    expect(text).not.toMatch(/任务已提交/);
  });

  it("参数校验：不存在目录被拒绝", async () => {
    const res = await ts.client.callTool({
      name: "run_task",
      arguments: { projectPath: "D:/__definitely_not_exists__/x", task: "xx" },
    });
    expect(res.isError).toBe(true);
  });
});
