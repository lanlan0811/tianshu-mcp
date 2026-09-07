/**
 * 极简日志：同时写 server.log 与控制台，UTF-8，ISO 时间戳。
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
    if (level === "error") {
      console.error(line);
    } else {
      console.log(line);
    }
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
