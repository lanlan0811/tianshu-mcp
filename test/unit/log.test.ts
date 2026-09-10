/**
 * 统一日志通道契约回归测试（issue #1）。
 *
 * MCP stdio 规范：stdout 只承载合法 MCP 消息；所有级别诊断日志必须走 stderr。
 * 输出通道用真实子进程（独立 stdout/stderr 管道）按字节断言，而非「是否调用了
 * 某个 console 方法」。文件日志按有界等待读取，避免异步追加竞态。
 */
import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import { makeTmpRoot, rmrf } from "../test-utils.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(THIS_DIR, "..", "fixtures", "log-probe.ts");

interface ProbeResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 用 tsx 起真实子进程，独立捕获 stdout/stderr 字节流 */
function probe(logDir: string, minLevel: string): ProbeResult {
  const r = spawnSync(process.execPath, ["--import", "tsx", PROBE, logDir, minLevel], {
    cwd: path.resolve(THIS_DIR, "..", ".."),
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const LINE_RE = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[(DEBUG|INFO|WARN|ERROR)\] /;
const lines = (s: string): string[] => s.split("\n").filter((l) => l.length > 0);
const levelOf = (line: string): string => LINE_RE.exec(line)?.[1] ?? "";
const sortedLevels = (ls: string[]): string[] => ls.map(levelOf).sort();

const homes: string[] = [];
afterEach(async () => {
  for (const h of homes.splice(0)) await rmrf(h);
});

/** 文件追加是异步操作：有界轮询等待，避免立即读文件导致竞态 */
async function waitForLines(file: string, minLines: number, timeoutMs = 3000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ls: string[] = [];
    try {
      ls = lines(await fsp.readFile(file, "utf8"));
    } catch {
      /* 文件尚未创建 */
    }
    if (ls.length >= minLines) return ls;
    if (Date.now() > deadline) {
      throw new Error(`等待日志文件 ${file} 达到 ${minLines} 行超时（当前 ${ls.length} 行）`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("Logger 输出通道（stdout 必须保持为空）", () => {
  it("默认 INFO 阈值：DEBUG 被过滤，INFO/WARN/ERROR 全部走 stderr，stdout 为空", () => {
    const r = probe("-", "info");
    expect(r.code).toBe(0);
    expect(r.stdout, `stdout 应为空，实际收到:\n${r.stdout}`).toBe("");
    const ls = lines(r.stderr);
    expect(sortedLevels(ls)).toEqual(["ERROR", "INFO", "WARN"]);
    for (const l of ls) expect(l).toMatch(LINE_RE);
    expect(r.stderr).not.toContain("probe-debug");
  });

  it("DEBUG 阈值：四级日志全部走 stderr，stdout 为空，级别标签保留", () => {
    const r = probe("-", "debug");
    expect(r.code).toBe(0);
    expect(r.stdout, `stdout 应为空，实际收到:\n${r.stdout}`).toBe("");
    const ls = lines(r.stderr);
    expect(sortedLevels(ls)).toEqual(["DEBUG", "ERROR", "INFO", "WARN"]);
    for (const l of ls) expect(l).toMatch(LINE_RE);
  });

  it("ERROR 阈值：仅 error 输出，debug/info/warn 全部静默", () => {
    const r = probe("-", "error");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    const ls = lines(r.stderr);
    expect(sortedLevels(ls)).toEqual(["ERROR"]);
  });
});

describe("Logger 文件日志", () => {
  it("阈值过滤后写文件：WARN 阈值只落 warn/error，内容 UTF-8 无损", async () => {
    const home = await makeTmpRoot("logfile");
    homes.push(home);
    const r = probe(home, "warn");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    const ls = await waitForLines(path.join(home, "server.log"), 2);
    expect(sortedLevels(ls)).toEqual(["ERROR", "WARN"]);
    const text = ls.join("\n");
    expect(text).toContain("probe-warn");
    expect(text).toContain("probe-error");
    expect(text).not.toContain("probe-debug");
    expect(text).not.toContain("probe-info");
  });

  it("DEBUG 阈值：文件保留全部四级且内容 UTF-8 无损", async () => {
    const home = await makeTmpRoot("logutf8");
    homes.push(home);
    const r = probe(home, "debug");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    const ls = await waitForLines(path.join(home, "server.log"), 4);
    expect(sortedLevels(ls)).toEqual(["DEBUG", "ERROR", "INFO", "WARN"]);
    // UTF-8 内容无损（中文 + 非 ASCII 符号）
    expect(ls.some((l) => l.includes("probe-info-中文与特殊字符✓"))).toBe(true);
  });

  it("追加不覆盖：两次运行后文件保留 8 行", async () => {
    const home = await makeTmpRoot("logappend");
    homes.push(home);
    probe(home, "debug");
    await waitForLines(path.join(home, "server.log"), 4);
    probe(home, "debug");
    const ls = await waitForLines(path.join(home, "server.log"), 8);
    expect(ls).toHaveLength(8);
    expect(ls.filter((l) => l.includes("probe-debug"))).toHaveLength(2);
  });
});
