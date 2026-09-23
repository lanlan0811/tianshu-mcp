/**
 * server.ts：组装 —— 加载配置、初始化数据目录/日志、TaskManager/AcceptanceEngine/
 * Registry、注册 11 个工具到 McpServer、触发技能自检安装。被 index.ts 调用以 stdio 启动。
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
import { MCP_SERVER_VERSION } from "./version.generated.js";

export interface ServerAssembly {
  server: McpServer;
  manager: TaskManager;
  dataHome: DataHome;
  store: TaskStore;
  logger: Logger;
  close: () => Promise<void>;
}

export async function buildServer(
  opts: {
    home?: string;
    logger?: Logger;
    skipSkillInstall?: boolean;
    /** issue #16：放行「需变更但按策略未自动覆盖」的技能目录 */
    approveSkillUpdate?: boolean;
    maxRunningOverride?: number;
  } = {},
): Promise<ServerAssembly> {
  const home = opts.home ?? resolveDataHome();
  const logger = opts.logger ?? (await LoggerCtor.create(path.join(home, "logs")));
  const dataHome = new DataHome(home, logger, BUILTIN_PROFILES);
  await dataHome.init();
  const cfg = await dataHome.loadConfig();
  const maxRunning = opts.maxRunningOverride ?? cfg.concurrency?.maxRunning ?? 2;
  // shutdown 预算（issue #14）：GUI 任务在 server 退出时的停止等待上限，注入 manager 供
  // shutdownInterrupt() 使用；与 profile 的 gui.cancelWaitMs（取消路径）解耦。
  const guiStopWaitMs = cfg.shutdown?.guiStopWaitMs ?? 15_000;

  const store = new TaskStore(home, logger);
  const registry = new AgentAdapterRegistry(() => dataHome.loadProfiles(), logger);
  const engine = new AcceptanceEngine(store, logger);
  const manager = new TaskManager(
    store,
    dataHome,
    registry,
    engine,
    logger,
    makeBuildCtx({ store, dataHome }),
  );
  await manager.initialize({ maxRunning, guiStopWaitMs });

  // 技能自检安装（失败仅告警不阻断，§17.5；issue #16：autoInstall 三态 + 覆盖语义 + 放行参数）。
  // 后台执行，不阻塞握手；模块内部按事件分级自行记日志（跳过=info，覆盖/保留/失败=warn），此处只接线。
  const skills = cfg.skills;
  if (!opts.skipSkillInstall && skills?.autoInstall !== false) {
    void skillSelfInstall(logger, {
      mode: skills?.autoInstall === "prompt" ? "prompt" : "auto",
      approveUpdate: opts.approveSkillUpdate === true,
      backupKeep: skills?.backupKeep ?? 3,
    });
  }

  const appCtx: AppContext = { manager, engine, registry, dataHome, store, logger };
  const handlers = makeHandlers(appCtx, {
    defaultAgentId: "codex",
    defaultAutoVerify: true,
    defaultAutoFixRounds: 0,
  });

  const server = new McpServer(
    { name: "tianshu-mcp", version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "tianshu-mcp：调度外部 AI-Agent（codex/zcode/traework/kimicode/qoder）完成项目开发、验收、返修闭环。ZCode 提问或等待用户环境处理时进入 needs_user，可用 continue_task 恢复原会话。run_task 异步返回 taskId，再用 query_task 轮询。",
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
        _meta: { requireApproval: tool.requireApproval, capability: tool.capability },
        annotations: {
          // readOnlyHint 只对 capability:"read" 为 true。capability:"execute"（目前仅 verify_task）
          // 会跑项目侧命令、可产生构建产物，故 readOnlyHint 诚实为 false——但那不等于需要审批：
          // 审批与否由 _meta.requireApproval 单独承载（verify_task 按 R11 仍免审批）。
          readOnlyHint: tool.capability === "read",
          destructiveHint:
            tool.name === "cancel_task" ||
            tool.name === "rework_task" ||
            tool.name === "approve_visual_baseline",
          openWorldHint: tool.name === "run_task",
          // 幂等提示（issue #15）：声明为幂等的**前提**是调用方传入 idempotencyKey
          // （run_task 的 TTL 内重放、verify_task 的进行中/已完成重放），工具描述里已写明。
          idempotentHint: tool.name === "run_task" || tool.name === "verify_task",
          title: tool.name,
        },
      },
      async (args) => {
        try {
          const parsed = tool.inputSchema.safeParse(args ?? {});
          if (!parsed.success) {
            const detail = parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ");
            return {
              content: [{ type: "text" as const, text: `Error: 参数不合法 — ${detail}` }],
              isError: true,
            };
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
    await engine.close();
    try {
      await server.close();
    } catch {
      /* ignore */
    }
  };

  return { server, manager, dataHome, store, logger, close };
}
