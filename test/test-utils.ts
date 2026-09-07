/**
 * 集成/协议测试共用工具：
 * - 在临时目录造 git 仓库示例项目（相对基线的验收）
 * - 向数据目录注入 stub agent profile
 * - buildServer + 官方 SDK 客户端（in-memory transport）连上，返回可直接 callTool 的 client
 */
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildServer, type ServerAssembly } from "../src/server.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Logger } from "../src/util/log.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.join(THIS_DIR, "stub-agent", "fixture");
export const STUB_SCRIPT = path.join(THIS_DIR, "stub-agent", "stub-agent.mjs");

export type Playbook = "good" | "fix-on-first" | "never" | "sleep";

export async function makeTmpRoot(tag: string): Promise<string> {
  const root = path.join(os.tmpdir(), `tianshu-mcp-test-${tag}-${randomBytes(4).toString("hex")}`);
  await fsp.mkdir(root, { recursive: true });
  return root;
}

function execGit(cwd: string, args: string[]): void {
  const res = execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  void res;
}

/** 复制 fixture 为一个独立 git 仓库项目（含初始 commit 基线） */
export async function makeGitProject(playbook: Playbook, extra?: { sleepMs?: number }): Promise<string> {
  const tmp = await makeTmpRoot("proj");
  await fsp.mkdir(path.join(tmp, ".tianshu-mcp"), { recursive: true });
  // 复制 fixture 文件（不含 .git 等）
  const entries = await fsp.readdir(FIXTURE_DIR, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(FIXTURE_DIR, e.name);
    const d = path.join(tmp, e.name);
    if (e.isDirectory()) {
      await fsp.cp(s, d, { recursive: true });
    } else {
      await fsp.copyFile(s, d);
    }
  }
  await fsp.writeFile(
    path.join(tmp, ".tianshu-mcp", "playbook.json"),
    JSON.stringify({ playbook, ...(extra?.sleepMs ? { sleepMs: extra.sleepMs } : {}) }, null, 2),
    "utf8",
  );
  await gitInitAndCommit(tmp);
  return tmp;
}

/** 修改已有项目的 playbook 配置（供中途换剧本/加 sleep） */
export async function writePlaybook(projectPath: string, cfg: { playbook: string; sleepMs?: number }): Promise<void> {
  await fsp.writeFile(path.join(projectPath, ".tianshu-mcp", "playbook.json"), JSON.stringify(cfg, null, 2), "utf8");
}

export async function gitInitAndCommit(projectPath: string): Promise<void> {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: projectPath, stdio: "ignore" });
  } catch {
    execGit(projectPath, ["init", "-b", "main"]);
  }
  execGit(projectPath, ["config", "user.email", "tianshu-mcp-test@example.com"]);
  execGit(projectPath, ["config", "user.name", "tianshu-mcp-test"]);
  execGit(projectPath, ["add", "-A"]);
  execGit(projectPath, ["commit", "-m", "test baseline"]);
}

/** 在数据目录写入 stub profile（指向本机 node + stub-agent.mjs） */
export async function writeStubProfile(home: string): Promise<void> {
  const profile = {
    profiles: {
      stub: {
        displayName: "Stub Agent (test)",
        type: "cli",
        status: "ready",
        command: process.execPath,
        argsTemplate: [STUB_SCRIPT, "<prompt:arg>"],
        promptMode: "arg",
        cwd: "task",
        env: {},
        timeoutMs: 120_000,
        killTree: "taskkill",
        authNote: "test-only stub",
      },
    },
  };
  await fsp.writeFile(path.join(home, "agent-profiles.json"), JSON.stringify(profile, null, 2), "utf8");
}

export interface TestServer {
  assembly: ServerAssembly;
  client: Client;
  home: string;
  close: () => Promise<void>;
}

let loggerCounter = 0;

/** 构建 server（临时数据目录 + stub profile）并用官方 SDK client 连上（in-memory transport） */
export async function startTestServer(opts: { home?: string } = {}): Promise<TestServer> {
  const home = opts.home ?? (await makeTmpRoot("home"));
  await fsp.mkdir(home, { recursive: true });
  const logger = await Logger.create(path.join(home, "logs"), "warn");
  const assembly = await buildServer({
    home,
    logger,
    skipSkillInstall: true,
    maxRunningOverride: 4,
  });
  // 注入 stub profile（须在工具调用前，registry 每次 resolve 都会 loadProfiles，可在启动后写）
  await writeStubProfile(home);

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await assembly.server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: {} });
  await client.connect(clientTransport);

  loggerCounter++;
  void loggerCounter;
  return {
    assembly,
    client,
    home,
    close: async () => {
      await client.close();
      await assembly.close();
    },
  };
}

export async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const content = Array.isArray(res.content) ? res.content : [];
  const text = (content as { type?: string; text?: string }[])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  return { res, text };
}

/** 解析结果文本里的 meta JSON 块 */
export function parseMeta(text: string): { before: string; meta: Record<string, unknown> | null } {
  const m = text.match(/---tianshu-mcp-meta---\n([\s\S]*?)\n---tianshu-mcp-meta---/);
  if (!m) return { before: text, meta: null };
  try {
    return { before: text.replace(m[0], "").trim(), meta: JSON.parse(m[1]!) as Record<string, unknown> };
  } catch {
    return { before: text, meta: null };
  }
}

/** 轮询直到任务终态（interval 由调用方传入） */
export async function waitForTerminal(
  client: Client,
  taskId: string,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  for (;;) {
    const { text } = await callTool(client, "query_task", { taskId });
    const { meta } = parseMeta(text);
    if (meta?.status) {
      const s = meta.status as string;
      if (["succeeded", "failed", "needs_attention", "cancelled", "interrupted"].includes(s)) return meta;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`等待任务 ${taskId} 终态超时（${timeoutMs}ms）。最近输出：\n${text.slice(0, 800)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** 清理（尽力而为） */
export async function rmrf(p: string): Promise<void> {
  await fsp.rm(p, { recursive: true, force: true });
}

export function gitFileExists(projectPath: string, file: string): boolean {
  return fs.existsSync(path.join(projectPath, file));
}
