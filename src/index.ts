#!/usr/bin/env node
/**
 * tianshu-mcp 入口：stdio 启动 MCP server。
 * 用法：node dist/index.js   （env TIANSHU_MCP_HOME 可选覆盖数据目录）
 * 退出：SIGINT/SIGTERM / stdin EOF → 归档任务 → 杀子进程 → 退出。
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import path from "node:path";
import { resolveDataHome } from "./config/store.js";
import { Logger } from "./util/log.js";

async function main(): Promise<void> {
  const home = resolveDataHome();
  const logger = await Logger.create(path.join(home, "logs"));
  const skipSkillInstall =
    process.argv.includes("--no-skill-install") || process.env.TIANSHU_MCP_NO_SKILL_INSTALL === "1";

  const assembly = await buildServer({ logger, skipSkillInstall });
  const transport = new StdioServerTransport();
  await assembly.server.connect(transport);
  logger.info(`tianshu-mcp 已连接（stdio）。数据目录: ${home}，工具数: 8`);

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
