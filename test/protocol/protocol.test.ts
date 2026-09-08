/**
 * 协议级测试：官方 SDK client 连接 in-memory transport 后的 server。
 * 断言 8 个工具可见、调用返回格式（文本 + meta 块 / 参数校验错误）。
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
  it("read 类工具 readOnlyHint=true，write 类 false；cancel/rework destructiveHint=true", async () => {
    const tools = await ts.client.listTools();
    const byName = new Map(tools.tools.map((t) => [t.name, t]));
    // 读类
    for (const name of ["query_task", "list_tasks", "get_task_report", "get_profiles"]) {
      expect(byName.get(name)?.annotations?.readOnlyHint, `${name} readOnly`).toBe(true);
    }
    // 写类
    for (const name of ["run_task", "cancel_task", "rework_task", "verify_task"]) {
      const ann = byName.get(name)?.annotations;
      if (name === "verify_task") {
        expect(ann?.readOnlyHint).toBe(true); // read 能力
      } else {
        expect(ann?.readOnlyHint).toBe(false);
      }
    }
    // destructive
    expect(byName.get("cancel_task")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("rework_task")?.annotations?.destructiveHint).toBe(true);
    // openWorld：仅 run_task
    expect(byName.get("run_task")?.annotations?.openWorldHint).toBe(true);
    expect(byName.get("query_task")?.annotations?.openWorldHint).toBe(false);
  });
});

describe("工具面", () => {
  it("注册 8 个工具且名称与能力标注符合开发计划 §5", async () => {
    const tools = await ts.client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["cancel_task", "get_profiles", "get_task_report", "list_tasks", "query_task", "rework_task", "run_task", "verify_task"]);
    // 每个工具在 TOOL_DEFS 有声明
    for (const t of tools.tools) {
      const def = TOOL_DEFS.find((d) => d.name === t.name);
      expect(def, `工具 ${t.name} 缺声明`).toBeDefined();
      expect(def!.inputSchema).toBeDefined();
      expect(["read", "write", "execute", "network"]).toContain(def!.capability);
    }
  });

  it("get_profiles 返回文本 + 可解析 meta 块", async () => {
    const { text } = await callTool(ts.client, "get_profiles", {});
    const { meta } = parseMeta(text);
    expect(meta).not.toBeNull();
    expect(meta!.ok).toBe(true);
    expect(text).toContain("stub");
  });

  it("list_tasks 空表也返回合法格式", async () => {
    const { text } = await callTool(ts.client, "list_tasks", {});
    const { meta } = parseMeta(text);
    expect(meta!.ok).toBe(true);
  });

  it("参数校验：run_task 缺 projectPath 返回 isError", async () => {
    const res = await ts.client.callTool({ name: "run_task", arguments: { task: "没有项目路径" } });
    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[]).map((c) => c.text).join("\n");
    // SDK 客户端侧 zod 校验先拦截（MCP error -32602），或由 server 侧给出 参数不合法
    expect(text).toMatch(/参数不合法|Invalid arguments|Input validation/i);
  });

  it("参数校验：不存在目录被拒绝", async () => {
    const res = await ts.client.callTool({
      name: "run_task",
      arguments: { projectPath: "D:/__definitely_not_exists__/x", task: "xx" },
    });
    expect(res.isError).toBe(true);
  });
});
