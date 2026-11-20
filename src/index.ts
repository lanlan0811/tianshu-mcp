#!/usr/bin/env node
/**
 * tianshu-mcp 入口：stdio 启动 MCP server。
 * 用法：node dist/index.js [--no-skill-install] [--approve-skill-update]
 *   （env TIANSHU_MCP_HOME 可选覆盖数据目录；env TIANSHU_MCP_NO_SKILL_INSTALL / TIANSHU_MCP_APPROVE_SKILL_UPDATE 等价）
 * 退出：SIGINT/SIGTERM / stdin EOF → 归档任务 → 杀子进程 → 退出。
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { TOOL_DEFS } from "./mcp/tools.js";
import path from "node:path";
import { resolveDataHome } from "./config/store.js";
import { Logger } from "./util/log.js";

async function main(): Promise<void> {
  // 启动分段计时（可观测性修复）：从进程进入 main 起算，用单调时钟 performance.now()，
  // 不受系统时间调整影响。用途是让「握手超时」可归因——回执里唯一承认的测量缺口是
  // 「冷拉取耗时本身未测量」，没有分段埋点时 server.log 在 connect() 之前一片空白。
  const t0 = performance.now();
  const since = (ms: number): number => Math.round(performance.now() - ms);
  if (process.argv[2] === "visual") {
    const { runVisualCli } = await import("./visual/cli.js");
    await runVisualCli(process.argv.slice(3));
    return;
  }
  // issue #20：验收配置三级继承的调试命令（在创建 server 之前返回，不触碰协议 stdout）
  if (process.argv[2] === "config") {
    const { runConfigCli } = await import("./config/cli.js");
    await runConfigCli(process.argv.slice(3));
    return;
  }
  const home = resolveDataHome();
  const logger = await Logger.create(path.join(home, "logs"));
  const tLogger = performance.now();
  // 在「握手可能尚未开始」的最早时刻就留痕：若宿主在 npx 下首次拉起并超时，
  // 这条记录至少能证明进程被拉起来了、卡在哪一段，而不是整段空白。
  logger.info(
    `启动分段：进程就绪 ${since(t0)}ms（node ${process.versions.node}，pid ${process.pid}）`,
  );
  const skipSkillInstall =
    process.argv.includes("--no-skill-install") || process.env.TIANSHU_MCP_NO_SKILL_INSTALL === "1";
  // issue #16：放行「需变更但按策略未自动覆盖」的技能目录（prompt 保留 / 来源不明）。
  // 对已确证含用户本地修改的目标不生效；--no-skill-install 的否决权高于本参数。
  const approveSkillUpdate =
    process.argv.includes("--approve-skill-update") || process.env.TIANSHU_MCP_APPROVE_SKILL_UPDATE === "1";

  const assembly = await buildServer({ logger, skipSkillInstall, approveSkillUpdate });
  const tBuild = performance.now();
  const transport = new StdioServerTransport();
  await assembly.server.connect(transport);
  const tConnect = performance.now();
  const total = since(t0);
  logger.info(
    `tianshu-mcp 已连接（stdio）。数据目录: ${home}，工具数: ${TOOL_DEFS.length}；` +
      `启动分段：logger ${since(t0)}ms（create ${Math.round(tLogger - t0)}ms）/ ` +
      `buildServer ${Math.round(tBuild - tLogger)}ms / connect ${Math.round(tConnect - tBuild)}ms ` +
      `/ 总计 ${total}ms`,
  );
  // 慢启动预警：只告警不阻断。阈值 10s——客户端窗口 60s，留足余量给 npx 拉包与宿主开销，
  // 避免把正常冷启动噪声化。
  if (total > 10_000) {
    logger.warn(
      `启动耗时 ${total}ms 偏高。若宿主在 npx 下首次拉起并报握手超时，` +
        `多为包未预装导致的冷拉取；可执行 npm install -g tianshu-mcp 消除该路径。`,
    );
  }

  let closing = false;
  const shutdown = async (why: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info(`收到 ${why}，开始关闭：归档活动任务并终止子进程…`);
    await assembly.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // 父进程关闭 stdin（EOF）时优雅退出
  process.stdin.on("end", () => void shutdown("stdin EOF"));
  process.stdin.on("close", () => void shutdown("stdin close"));
}

main().catch((e) => {
  console.error("tianshu-mcp 启动失败:", e instanceof Error ? e.message : e);
  process.exit(1);
});
