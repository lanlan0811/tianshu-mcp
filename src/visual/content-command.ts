/**
 * 内容判定命令契约（issue #13 计划 §4.2）：
 * 占位符展开、跨平台命令解析（where/which）、子进程执行（shell:false + 结构化 argv）、
 * stdout 末行 JSON 判定解析。MCP 全程不读取/不存储/不转发任何凭证。
 */
import path from "node:path";
import fs from "node:fs/promises";
import crossSpawn from "cross-spawn";
import { execFileAsync } from "../verify/exec.js";
import { killTree } from "../agents/spawn.js";
import { VisualError } from "./errors.js";
import { digest } from "./lock.js";
import { CONTENT_PLACEHOLDERS, ContentVerdictSchema } from "./schema.js";
import type { VisualContentVerdict } from "./schema.js";

/** 命令解析：where（Windows）/ which（POSIX）先例见 agents/registry.ts；含路径分隔符时直接按路径解析 */
export async function resolveCommandPath(command: string, cwd: string): Promise<string | null> {
  if (/[\\/]/.test(command)) {
    const target = path.resolve(cwd, command);
    try {
      return (await fs.stat(target)).isFile() ? target : null;
    } catch {
      return null;
    }
  }
  const whichCmd = process.platform === "win32" ? "where" : "which";
  const res = await execFileAsync(whichCmd, [command], { cwd, timeoutMs: 10_000 });
  if (res.status !== 0 || !res.stdout) return null;
  return res.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0) ?? null;
}

export interface CommandIdentity {
  /** 解析出的可执行绝对路径；解析失败为 null（该判定项不做缓存） */
  commandPath: string | null;
  /** 可执行 + 模板内项目内实际存在的文件实参（如 node 脚本）的内容摘要；不可读为 null */
  commandDigest: string | null;
}

async function digestFile(filename: string): Promise<string> {
  return digest(await fs.readFile(filename));
}

/**
 * 命令二进制身份：把自备 CLI 的升级纳入缓存失效（键含 commandPath/commandDigest）。
 * 无法可靠计算时返回 null digest —— 宁可不缓存，也不固化一个身份不明的键。
 */
export async function resolveCommandIdentity(
  command: string,
  argsTemplate: string[],
  cwd: string,
): Promise<CommandIdentity> {
  const commandPath = await resolveCommandPath(command, cwd);
  if (!commandPath) return { commandPath: null, commandDigest: null };
  let executableDigest: string;
  try {
    executableDigest = await digestFile(commandPath);
  } catch {
    return { commandPath, commandDigest: null };
  }
  const parts = [executableDigest];
  for (const token of argsTemplate) {
    if (CONTENT_PLACEHOLDERS.some((p) => token.includes(p))) continue;
    try {
      const target = path.resolve(cwd, token);
      if ((await fs.stat(target)).isFile()) parts.push(`${token}:${await digestFile(target)}`);
    } catch {
      /* 非文件实参（开关、字面量），跳过 */
    }
  }
  return { commandPath, commandDigest: digest(parts.join("\n")) };
}

/** 用户声明式 env 引用（services.ts 先例）：{ 子进程变量名: 宿主环境变量名 }，缺失即整轮阻塞 */
export function resolveContentEnv(env: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [name, reference] of Object.entries(env)) {
    const value = process.env[reference];
    if (value === undefined)
      throw new VisualError(
        "CONTENT_ENV_MISSING",
        `Missing environment variable reference: ${reference}`,
      );
    resolved[name] = value;
  }
  return resolved;
}

export interface CommandPrepareInput {
  argsTemplate: string[];
  /** 被检图片绝对路径（经 projectFile 路径闸门） */
  imagePath: string;
  expect: string;
  /** 临时文件目录（调用方保证唯一，属于易失输入而非证据） */
  tempDir: string;
}
export interface PreparedCommand {
  argv: string[];
  /** 本轮创建的临时文件，调用方在 finally 中删除 */
  tempFiles: string[];
}

/**
 * 占位符展开：token 内不重复展开（replaceAll 只扫原文）；未使用的占位符不生成对应文件。
 * 期望文本走临时文件而非命令行，规避转义/长度上限，也避免进入系统审计日志。
 */
export async function prepareCommandArgs(input: CommandPrepareInput): Promise<PreparedCommand> {
  const { argsTemplate, imagePath, expect, tempDir } = input;
  for (const token of argsTemplate)
    for (const match of token.matchAll(/<[^<>\s]*>/g))
      if (!(CONTENT_PLACEHOLDERS as readonly string[]).includes(match[0]))
        throw new VisualError(
          "CONTENT_CONFIG_INVALID",
          `Unknown placeholder in argsTemplate: ${match[0]}`,
        );
  let expectFile: string | null = null;
  let base64File: string | null = null;
  const argv: string[] = [];
  for (const token of argsTemplate) {
    let expanded = token;
    if (expanded.includes("<image:path>"))
      expanded = expanded.replaceAll("<image:path>", imagePath);
    if (expanded.includes("<expect:file>")) {
      if (!expectFile) {
        expectFile = path.join(tempDir, "expect.txt");
        await fs.mkdir(tempDir, { recursive: true });
        await fs.writeFile(expectFile, expect, "utf8");
      }
      expanded = expanded.replaceAll("<expect:file>", expectFile);
    }
    if (expanded.includes("<image:base64:file>")) {
      if (!base64File) {
        base64File = path.join(tempDir, "image.b64");
        await fs.mkdir(tempDir, { recursive: true });
        await fs.writeFile(base64File, (await fs.readFile(imagePath)).toString("base64"), "utf8");
      }
      expanded = expanded.replaceAll("<image:base64:file>", base64File);
    }
    argv.push(expanded);
  }
  return { argv, tempFiles: [expectFile, base64File].filter((f): f is string => f !== null) };
}

export interface ContentCommandSpec {
  command: string;
  argv: string[];
  cwd: string;
  /** 完整子进程环境（调用方组装 {...process.env, ...resolveContentEnv(...)}） */
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  /** stdout/stderr 采集上限（字符，保留尾部）；默认 256KB */
  maxOutputChars?: number;
}
export interface ContentCommandOutcome {
  exitCode: number | null;
  timeout: boolean;
  aborted: boolean;
  spawnError: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** 执行判定命令：超时杀进程树（复用 agents/spawn.ts 的 killTree），stdout/stderr 只保尾部 */
export function runContentCommand(spec: ContentCommandSpec): Promise<ContentCommandOutcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    const maxChars = spec.maxOutputChars ?? 262_144;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: ReturnType<typeof crossSpawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: Partial<ContentCommandOutcome>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: null,
        timeout: false,
        aborted: false,
        spawnError: null,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        ...outcome,
      });
    };
    const capture = (text: string, chunk: Buffer | string): string => {
      const next = text + String(chunk);
      return next.length > maxChars ? next.slice(next.length - maxChars) : next;
    };
    const onAbort = (): void => {
      finish({ aborted: true });
      if (child?.pid) void killTree(child.pid);
    };
    timer = setTimeout(() => {
      finish({ timeout: true });
      if (child?.pid) void killTree(child.pid);
    }, spec.timeoutMs);
    if (spec.signal?.aborted) {
      finish({ aborted: true });
      return;
    }
    spec.signal?.addEventListener("abort", onAbort, { once: true });
    child = crossSpawn(spec.command, spec.argv, {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = capture(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = capture(stderr, chunk);
    });
    child.on("error", (e: Error) => finish({ spawnError: e.message }));
    child.on("close", (code: number | null) => finish({ exitCode: code, spawnError: null }));
  });
}

/** stdout 解析：取最后一行非空文本，严格校验判定契约（.strict()） */
export function parseVerdictLine(stdout: string): VisualContentVerdict {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1];
  if (!last) throw new VisualError("CONTENT_OUTPUT_INVALID", "Judge command produced no stdout");
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    throw new VisualError(
      "CONTENT_OUTPUT_INVALID",
      `Judge command stdout last line is not JSON: ${last.slice(0, 200)}`,
    );
  }
  const verdict = ContentVerdictSchema.safeParse(parsed);
  if (!verdict.success)
    throw new VisualError(
      "CONTENT_OUTPUT_INVALID",
      `Judge command stdout violates the verdict contract: ${JSON.stringify(
        verdict.error.issues,
      ).slice(0, 300)}`,
    );
  return verdict.data;
}
