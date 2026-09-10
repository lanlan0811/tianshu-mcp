/**
 * 极简日志：同时写 server.log 与 stderr，UTF-8，ISO 时间戳。
 *
 * 通道契约（MCP stdio 规范）：stdout 由 MCP transport 独占，只承载合法 JSON-RPC 消息；
 * 所有通过阈值的诊断日志（DEBUG/INFO/WARN/ERROR）一律写 stderr。stderr 出现 INFO/WARN
 * 只表示诊断信息，不代表服务器发生错误。详见 issue #1。
 *
 * 注意：不记录环境变量/密钥（开发计划 §12 脱敏约束）。
 */
import { appendLine, mkdirp } from "./fs.js";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor(
    private readonly logFile: string | null,
    private readonly minLevel: LogLevel = "info",
  ) {}

  static async create(logDir: string, minLevel: LogLevel = "info"): Promise<Logger> {
    await mkdirp(logDir);
    const file = path.join(logDir, "server.log");
    return new Logger(file, minLevel);
  }

  log(level: LogLevel, msg: string): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return;
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
    // 统一走 stderr：stdout 留给 MCP transport，禁止任何日志污染协议流。
    console.error(line);
    if (this.logFile) void appendLine(this.logFile, line).catch(() => {});
  }

  debug(msg: string): void {
    this.log("debug", msg);
  }
  info(msg: string): void {
    this.log("info", msg);
  }
  warn(msg: string): void {
    this.log("warn", msg);
  }
  error(msg: string): void {
    this.log("error", msg);
  }
}
