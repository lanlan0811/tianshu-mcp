/**
 * server.ts：组装 —— 加载配置、初始化数据目录/日志、TaskManager/AcceptanceEngine/
 * Registry、注册 8 个工具到 McpServer、触发技能自检安装。被 index.ts 调用以 stdio 启动。
 */
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveDataHome, DataHome } from "./config/store.js";
import { BUILTIN_PROFILES } from "./agents/builtin.js";
import { AgentAdapterRegistry } from "./agents/registry.js";
import { TaskStore } from "./tasks/task-store.js";
import { AcceptanceEngine } from "./verify/acceptance.js";
import { TaskManager } from "./tasks/task-manager.js";
import { makeBuildCtx } from "./mcp/context.js";
import { makeHandlers, type AppContext } from "./mcp/handlers.js";
import { TOOL_DEFS } from "./mcp/tools.js";
import type { Logger } from "./util/log.js";
import { Logger as LoggerCtor } from "./util/log.js";
import { skillSelfInstall } from "./util/skill-install.js";

export interface ServerAssembly {
  server: McpServer;
  manager: TaskManager;
  dataHome: DataHome;
  store: TaskStore;
  logger: Logger;
  close: () => Promise<void>;
}

export async function buildServer(opts: { home?: string; logger?: Logger; skipSkillInstall?: boolean; maxRunningOverride?: number } = {}): Promise<ServerAssembly> {
  const home = opts.home ?? resolveDataHome();
  const logger = opts.logger ?? (await LoggerCtor.create(path.join(home, "logs")));
  const dataHome = new DataHome(home, logger, BUILTIN_PROFILES);
  await dataHome.init();
  const cfg = await dataHome.loadConfig();
  const maxRunning = opts.maxRunningOverride ?? cfg.concurrency?.maxRunning ?? 2;

  const store = new TaskStore(home, logger);
  const registry = new AgentAdapterRegistry(() => dataHome.loadProfiles(), logger);
  const engine = new AcceptanceEngine(store, logger);
  const manager = new TaskManager(store, dataHome, registry, engine, logger, makeBuildCtx({ store, dataHome }));
  await manager.initialize(maxRunning);

  // 技能自检安装（失败仅告警不阻断，§17.5）；后台执行，不阻塞握手
  if (!opts.skipSkillInstall && (cfg.skills?.autoInstall ?? true)) {
    void skillSelfInstall(logger).then((r) => {
      if (r.installed) logger.info(r.message);
      if (r.failed) logger.warn(r.message);
    });
  }

  const appCtx: AppContext = { manager, engine, registry, dataHome, store, logger };
  const handlers = makeHandlers(appCtx, {
    defaultAgentId: "codex",
    defaultAutoVerify: true,
    defaultAutoFixRounds: 0,
  });

  const server = new McpServer(
    { name: "tianshu-mcp", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "tianshu-mcp：调度外部 AI-Agent（codex/zcode）完成 项目开发 → 验收 → 返修 闭环。工具返回文本 + ---tianshu-mcp-meta--- JSON 块。run_task 是异步的：先拿 taskId 再用 query_task 轮询。",
    },
  );

  for (const tool of TOOL_DEFS) {
    const handler = handlers[tool.name as keyof typeof handlers];
    if (!handler) {
      logger.error(`工具 ${tool.name} 没有 handler`);
      continue;
    }
    server.registerTool(
      tool.name,
      {
        title: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: tool.capability === "read",
          destructiveHint: tool.name === "cancel_task" || tool.name === "rework_task",
          openWorldHint: tool.name === "run_task",
          title: tool.name,
        },
      },
      async (args) => {
        try {
          const parsed = tool.inputSchema.safeParse(args ?? {});
          if (!parsed.success) {
            const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
            return { content: [{ type: "text" as const, text: `Error: 参数不合法 — ${detail}` }], isError: true };
          }
          return await handler(parsed.data as Record<string, unknown>);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
        }
      },
    );
  }

  const close = async (): Promise<void> => {
    logger.info("server 关闭：归档活动任务并终止子进程…");
    await manager.shutdownInterrupt();
    try {
      await server.close();
    } catch {
      /* ignore */
    }
  };

  return { server, manager, dataHome, store, logger, close };
}
