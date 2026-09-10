/**
 * 日志通道探针（供 test/unit/log.test.ts 以真实子进程调用）。
 * 用法：node --import tsx test/fixtures/log-probe.ts <logDir|-> <minLevel>
 *   logDir 为 "-" 表示不写文件；否则写入 <logDir>/server.log。
 * 依次输出 debug/info/warn/error 四级后短暂等待异步追加完成。
 */
import { Logger, type LogLevel } from "../../src/util/log.js";

const logDir = process.argv[2] ?? "-";
const minLevel = (process.argv[3] ?? "info") as LogLevel;

const logger = logDir === "-" ? new Logger(null, minLevel) : await Logger.create(logDir, minLevel);

logger.debug("probe-debug");
logger.info("probe-info-中文与特殊字符✓");
logger.warn("probe-warn");
logger.error("probe-error");

// 文件追加是异步的：给足时间后退出，父进程按有界等待读文件
await new Promise((r) => setTimeout(r, 200));
