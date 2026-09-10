#!/usr/bin/env node
/**
 * 严格 stdio 协议冒烟（issue #1）。
 *
 * 目标：从真实子进程的完整字节流上证明 stdout 只承载合法 MCP JSON-RPC 消息，
 * 所有诊断日志都在 stderr 与日志文件中。
 *
 * 用法：
 *   node scripts/check-stdio.mjs --entry dist/index.js
 *   node scripts/check-stdio.mjs --entry src/index.ts --tsx          # 源码入口（tsx）
 *   node scripts/check-stdio.mjs --entry <pkg>/dist/index.js --repo <repo> --fixtures <repo>/test/stub-agent
 *   node scripts/check-stdio.mjs --entry dist/index.js --scenario task-runtime-logs
 *
 * 选项：
 *   --entry <path>        server 入口（必填，或作为第一个位置参数）
 *   --tsx                 以 `node --import tsx` 启动源码入口
 *   --repo <path>         仓库/包根（默认脚本上级目录）；读取 package.json 与工具定义
 *   --cwd <path>          子进程工作目录（默认与 --repo 相同）
 *   --fixtures <path>     stub-agent 目录（默认 <repo>/test/stub-agent）
 *   --expect-version <v>  期望 serverInfo.version（默认读 <repo>/package.json）
 *   --expect-tools <a,b>  显式期望工具集合（默认自动从 src/ 或 dist/ 读取）
 *   --scenario <a,b>      仅跑指定场景（可重复）
 *   --no-task             跳过 stub 任务场景（无 fixtures 时使用）
 *   --timeout-ms <n>      单场景整体超时（默认 120000）
 *
 * 跨平台：process.execPath + argv 数组 + shell:false + windowsHide + os.tmpdir()，
 * 不依赖 GNU timeout / shell 重定向 / 固定盘符；子进程只注入隔离 HOME，
 * 关闭后（close）才清理临时数据。
 */
import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSONRPCMessageSchema, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(HERE, "..");

/* ---------------- 参数 ---------------- */

function parseArgs(argv) {
  const opts = { repo: DEFAULT_REPO, scenarios: [], nodeArgs: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`选项 ${a} 缺少参数`);
      return v;
    };
    switch (a) {
      case "--entry":
        opts.entry = next();
        break;
      case "--tsx":
        opts.nodeArgs.push("--import", "tsx");
        break;
      case "--repo":
        opts.repo = path.resolve(next());
        break;
      case "--cwd":
        opts.cwdOverride = path.resolve(next());
        break;
      case "--fixtures":
        opts.fixtures = path.resolve(next());
        break;
      case "--expect-version":
        opts.expectVersion = next();
        break;
      case "--expect-tools":
        opts.expectToolsOverride = next().split(",").map((s) => s.trim()).filter(Boolean).sort();
        break;
      case "--scenario":
        opts.scenarios.push(...next().split(",").map((s) => s.trim()).filter(Boolean));
        break;
      case "--no-task":
        opts.noTask = true;
        break;
      case "--timeout-ms":
        opts.timeoutMs = Number(next());
        break;
      default:
        if (a.startsWith("--")) throw new Error(`未知选项 ${a}`);
        positional.push(a);
    }
  }
  if (!opts.entry && positional.length) opts.entry = positional[0];
  if (!opts.entry) throw new Error("缺少 --entry <server 入口>");
  opts.entry = path.resolve(opts.entry);
  opts.cwd = opts.cwdOverride ?? opts.repo;
  opts.fixtures = opts.fixtures ?? path.join(opts.repo, "test", "stub-agent");
  opts.timeoutMs = opts.timeoutMs ?? 120_000;
  opts.expectVersion = opts.expectVersion ?? readPackageVersion(opts.repo);
  opts.expectTools = opts.expectToolsOverride ?? readExpectedTools(opts.repo);
  return opts;
}

function readPackageVersion(repo) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

/**
 * 读取期望工具名：优先 src/mcp/tools.ts（仓库），回退 dist/mcp/tools.js（安装包内无 src）。
 * 保证与源码定义一致，而不是写死清单。
 */
function readExpectedTools(repo) {
  for (const rel of [
    path.join("src", "mcp", "tools.ts"),
    path.join("dist", "mcp", "tools.js"),
  ]) {
    try {
      const src = fs.readFileSync(path.join(repo, rel), "utf8");
      const start = src.indexOf("TOOL_DEFS");
      const end = src.indexOf("findTool");
      if (start < 0) continue;
      const slice = end > start ? src.slice(start, end) : src.slice(start);
      const names = [...slice.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);
      // dist 里 registerTool 等也可能含 name:，用工具集合去重并按 TOOL_DEFS 顺序稳定性无关
      if (names.length) return [...new Set(names)].sort();
    } catch {
      /* 下一个来源 */
    }
  }
  return null;
}

/* ---------------- 输出断言 ---------------- */

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/* ---------------- 临时目录 ---------------- */

async function mkIsolatedHome(tag) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), `tianshu-stdio-${tag}-`));
  return home;
}

function childEnv(home) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TIANSHU_MCP_HOME: home,
  };
}

/* ---------------- 严格 stdout 客户端 ---------------- */

class ProtocolClient {
  constructor(child, opts) {
    this.child = child;
    this.opts = opts;
    this.nextId = 1;
    this.pending = new Map();
    this.messages = [];
    this.notifications = [];
    this.errors = [];
    this.stderrText = "";
    this.stdoutBytes = 0;
    this.stderrBytes = 0;
    this.lineCount = 0;
    this.closed = false;
    this.exitCode = null;
    this._buf = "";
    this._decoder = new StringDecoder("utf8");
    this._closeResolvers = [];
    this._wire();
  }

  _wire() {
    this.child.stdout.on("data", (chunk) => {
      this.stdoutBytes += chunk.length;
      this._ingest(this._decoder.write(chunk));
    });
    this.child.stdout.on("end", () => this._flushTail());
    this.child.stderr.on("data", (chunk) => {
      this.stderrBytes += chunk.length;
      this.stderrText += chunk.toString("utf8");
    });
    this.child.on("error", (e) => this.errors.push(`子进程错误: ${e.message}`));
    this.child.on("close", (code) => {
      this._flushTail();
      this.exitCode = code;
      this.closed = true;
      // 关闭时仍在等待的请求必须收敛，否则调用方会一直挂起
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        p.reject(new Error(`子进程已关闭（code=${code}），请求 id=${id} 仍未收到响应`));
      }
      for (const r of this._closeResolvers.splice(0)) r(code);
    });
  }

  _ingest(text) {
    this._buf += text;
    let idx;
    while ((idx = this._buf.indexOf("\n")) >= 0) {
      const line = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 1);
      this.lineCount++;
      this._onLine(line, this.lineCount);
    }
  }

  /** 退出时残留片段同样非法（含未换行的日志） */
  _flushTail() {
    if (this._buf.length > 0) {
      this.lineCount++;
      this._onLine(this._buf, this.lineCount);
      this._buf = "";
    }
    // 解码器残留（不完整多字节）也视为异常
    const rest = this._decoder.end();
    if (rest.length > 0) this._ingest(rest);
  }

  _onLine(rawLine, n) {
    const line = rawLine;
    if (line.length === 0) {
      this.errors.push(`stdout 第 ${n} 行为空行（非协议内容）`);
      return;
    }
    if (line.endsWith("\r")) {
      this.errors.push(`stdout 第 ${n} 行以 CR 结尾：${truncate(line)}`);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.errors.push(`stdout 第 ${n} 行非法 JSON（parser error）：${truncate(line)}`);
      return;
    }
    const check = JSONRPCMessageSchema.safeParse(parsed);
    if (!check.success) {
      this.errors.push(
        `stdout 第 ${n} 行不是合法 MCP 消息：${check.error.issues.map((i) => i.message).join("; ")}；原文 ${truncate(line)}`,
      );
      return;
    }
    const msg = check.data;
    this.messages.push(msg);
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && msg.method) {
      // server→client 请求：本 server 不使用，回错误避免挂起
      this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "client does not support server requests" } });
      return;
    }
    if (hasId) {
      const p = this.pending.get(msg.id);
      if (!p) {
        this.errors.push(`stdout 收到无法对应用户请求的响应 id=${JSON.stringify(msg.id)}`);
        return;
      }
      this.pending.delete(msg.id);
      p.resolve(msg);
      return;
    }
    // 无 id 的通知：允许（但不承载协议外的诊断日志——诊断日志已要求走 stderr）
    this.notifications.push(msg);
  }

  send(msg) {
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  request(method, params, timeoutMs = 20_000) {
    const id = this.nextId++;
    const key = id;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`请求 ${method}(id=${id}) 在 ${timeoutMs}ms 内无响应`));
      }, timeoutMs);
      this.pending.set(key, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
    this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return { id, promise };
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  waitClose(timeoutMs = 20_000) {
    if (this.closed) return Promise.resolve(this.exitCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`EOF 后 ${timeoutMs}ms 子进程未退出`)), timeoutMs);
      this._closeResolvers.push((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  waitStderr(substr, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (this.stderrText.includes(substr)) return resolve(this.stderrText);
        if (Date.now() > deadline) {
          return reject(new Error(`等待 stderr 出现「${substr}」超时；当前 stderr:\n${truncate(this.stderrText, 2000)}`));
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  }
}

function truncate(s, n = 400) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/* ---------------- 启动子进程 ---------------- */

function startServer(opts, { home, extraArgs = [], entry = opts.entry } = {}) {
  const child = spawn(process.execPath, [...opts.nodeArgs, entry, ...extraArgs], {
    cwd: opts.cwd,
    env: childEnv(home),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  return new ProtocolClient(child, opts);
}

/* ---------------- 握手 / 通用调用 ---------------- */

async function handshake(client, opts) {
  const { id, promise } = client.request("initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "check-stdio", version: "1.0.0" },
  });
  const res = await promise;
  assert(!res.error, `initialize 返回错误：${JSON.stringify(res.error)}`);
  const r = res.result ?? {};
  assert(r.serverInfo?.name === "tianshu-mcp", `serverInfo.name 应为 tianshu-mcp，实际 ${r.serverInfo?.name}`);
  if (opts.expectVersion) {
    assert(
      r.serverInfo?.version === opts.expectVersion,
      `serverInfo.version(${r.serverInfo?.version}) 应等于 package.json(${opts.expectVersion})`,
    );
  }
  assert(r.capabilities?.tools, "initialize 结果缺少 tools 能力");
  client.notify("notifications/initialized");
  void id;
}

async function listTools(client, opts) {
  const { promise } = client.request("tools/list", {});
  const res = await promise;
  assert(!res.error, `tools/list 返回错误：${JSON.stringify(res.error)}`);
  const names = (res.result?.tools ?? []).map((t) => t.name).sort();
  if (opts.expectTools) {
    assert(
      JSON.stringify(names) === JSON.stringify(opts.expectTools),
      `工具集合与源码定义不一致：\n  实际 ${JSON.stringify(names)}\n  期望 ${JSON.stringify(opts.expectTools)}`,
    );
  }
  assert(names.length > 0, "tools/list 返回空集合");
  return names;
}

/** 只读调用 + 返回格式校验（文本 + ---tianshu-mcp-meta--- JSON 块） */
async function readOnlyCall(client) {
  const { promise } = client.request("tools/call", { name: "list_tasks", arguments: {} });
  const res = await promise;
  assert(!res.error, `tools/call 返回错误：${JSON.stringify(res.error)}`);
  assert(res.result?.isError !== true, `list_tasks 返回 isError=true：${JSON.stringify(res.result)}`);
  const text = (res.result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  assert(text.includes("---tianshu-mcp-meta---"), "tools/call 结果缺少 ---tianshu-mcp-meta--- JSON 块");
  const m = text.match(/---tianshu-mcp-meta---\n([\s\S]*?)\n---tianshu-mcp-meta---/);
  assert(m, "meta 块无法解析");
  const meta = JSON.parse(m[1]);
  assert(meta.ok === true, `list_tasks meta.ok 应为 true，实际 ${meta.ok}`);
  return { text, meta };
}

/* ---------------- stub 任务 ---------------- */

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败(${r.status}): ${r.stderr || r.stdout}`);
}

async function makeGitProject(opts, tag) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `tianshu-stdio-proj-${tag}-`));
  await fsp.cp(path.join(opts.fixtures, "fixture"), dir, { recursive: true });
  await fsp.mkdir(path.join(dir, ".tianshu-mcp"), { recursive: true });
  await fsp.writeFile(
    path.join(dir, ".tianshu-mcp", "playbook.json"),
    JSON.stringify({ playbook: "good", sleepMs: 200 }, null, 2),
    "utf8",
  );
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "check-stdio@example.com"], dir);
  git(["config", "user.name", "check-stdio"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-m", "baseline"], dir);
  return dir;
}

async function writeStubProfile(opts, home) {
  const profile = {
    profiles: {
      stub: {
        displayName: "Stub Agent (check-stdio)",
        type: "cli",
        status: "ready",
        command: process.execPath,
        argsTemplate: [path.join(opts.fixtures, "stub-agent.mjs"), "<prompt:arg>"],
        promptMode: "arg",
        cwd: "task",
        env: {},
        timeoutMs: 60_000,
        killTree: "taskkill",
        authNote: "check-stdio stub",
      },
    },
  };
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(path.join(home, "agent-profiles.json"), JSON.stringify(profile, null, 2), "utf8");
}

async function runStubTask(client, opts, home) {
  const project = await makeGitProject(opts, "task");
  await writeStubProfile(opts, home);
  const { promise } = client.request("tools/call", {
    name: "run_task",
    arguments: {
      projectPath: project,
      agentId: "stub",
      task: "新建 done.txt，内容为 PASS，确保验收检查通过。",
      autoVerify: true,
      autoFixRounds: 0,
    },
  });
  const res = await promise;
  assert(!res.error, `run_task 返回错误：${JSON.stringify(res.error)}`);
  const text = (res.result?.content ?? []).map((c) => c.text ?? "").join("\n");
  const m = text.match(/---tianshu-mcp-meta---\n([\s\S]*?)\n---tianshu-mcp-meta---/);
  assert(m, `run_task 结果缺少 meta 块：${truncate(text)}`);
  const taskId = JSON.parse(m[1]).taskId;
  assert(typeof taskId === "string" && taskId.startsWith("tsk_"), `run_task 未返回 taskId：${truncate(text)}`);

  const deadline = Date.now() + 90_000;
  for (;;) {
    const { promise: qp } = client.request("tools/call", {
      name: "query_task",
      arguments: { taskId },
    });
    const qres = await qp;
    const qtext = (qres.result?.content ?? []).map((c) => c.text ?? "").join("\n");
    const qm = qtext.match(/---tianshu-mcp-meta---\n([\s\S]*?)\n---tianshu-mcp-meta---/);
    const status = qm ? JSON.parse(qm[1]).status : undefined;
    if (["succeeded", "failed", "needs_attention", "cancelled", "interrupted"].includes(status)) {
      assert(status === "succeeded", `stub 任务终态应为 succeeded，实际 ${status}`);
      assert(qtext.includes("done.txt"), "任务结果应包含 changedFiles done.txt");
      return { taskId, project };
    }
    if (Date.now() > deadline) throw new Error(`stub 任务 ${taskId} 轮询超时（最近状态 ${status}）`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/* ---------------- 场景 ---------------- */

function baseScenarios() {
  return [
    "first-start",
    "second-start-skill-matched",
    "no-skill-install",
    "corrupt-config-warn",
    "task-runtime-logs",
    "eof-close",
  ];
}

/**
 * 每个场景：启动 → initialize → initialized → tools/list → tools/call → EOF → close，
 * 全程按字节校验 stdout；stderr 只允许作为诊断通道。
 */
async function runScenario(name, opts, ctx) {
  const failures = [];
  let client = null;
  let projectToClean = null;
  let scenarioTimer = null;
  const sharesHome = name === "first-start" || name === "second-start-skill-matched";
  const home = sharesHome ? ctx.sharedHome : await mkIsolatedHome(name);
  const ownsHome = !sharesHome;

  const extraArgs = [];
  if (name === "no-skill-install") extraArgs.push("--no-skill-install");

  if (name === "corrupt-config-warn") {
    await fsp.mkdir(home, { recursive: true });
    await fsp.writeFile(path.join(home, "config.json"), "{ 这不是合法 JSON ", "utf8");
  }

  try {
    client = startServer(opts, { home, extraArgs });
    // 单场景整体超时：到点杀子进程，待处理请求随之收敛为失败
    const timedOut = new Promise((_, reject) => {
      scenarioTimer = setTimeout(() => {
        reject(new Error(`场景 ${name} 超过 ${opts.timeoutMs}ms 未完成`));
        try {
          client?.child.kill();
        } catch {
          /* ignore */
        }
      }, opts.timeoutMs);
      scenarioTimer.unref?.();
    });

    return await Promise.race([
      (async () => {
        await handshake(client, opts);
        const tools = await listTools(client, opts);
        await readOnlyCall(client);

        if (name === "first-start") {
          await client.waitStderr("技能已安装到", 30_000);
          await client.waitStderr("[INFO]", 5_000);
        } else if (name === "second-start-skill-matched") {
          await client.waitStderr("技能已安装且内容一致", 30_000);
        } else if (name === "no-skill-install") {
          // 给技能安装若发生留出时间，再断言未出现
          await new Promise((r) => setTimeout(r, 1500));
          assert(!client.stderrText.includes("技能已安装到"), "--no-skill-install 仍出现技能安装日志");
          assert(!client.stderrText.includes("技能已安装且内容一致"), "--no-skill-install 仍出现技能自检日志");
        } else if (name === "corrupt-config-warn") {
          await client.waitStderr("config.json JSON 损坏", 15_000);
        } else if (name === "task-runtime-logs") {
          const r = await runStubTask(client, opts, home);
          projectToClean = r.project;
          await client.waitStderr("run_task 已提交", 5_000);
          await client.waitStderr("任务", 5_000);
        }

        // 正常 EOF 关闭
        client.child.stdin.end();
        const code = await client.waitClose(30_000);
        assert(code === 0, `EOF 关闭后退出码应为 0，实际 ${code}`);

        // 严格 stdout 断言（close 后已 finalize）
        assert(client.errors.length === 0, `stdout 存在非协议内容：\n  - ${client.errors.join("\n  - ")}`);
        assert(client.lineCount > 0, "stdout 未产生任何 MCP 消息");
        // 所有请求都有响应
        assert(client.pending.size === 0, `有 ${client.pending.size} 个请求未收到响应`);
        // 日志必须留在 stderr（默认 INFO 阈值必然产生日志）
        assert(client.stderrText.includes("[INFO]"), "stderr 未包含 INFO 日志（日志通道异常）");

        return {
          name,
          ok: true,
          tools: tools.length,
          stdoutLines: client.lineCount,
          stderrBytes: client.stderrBytes,
        };
      })(),
      timedOut,
    ]);
  } catch (e) {
    failures.push(e instanceof Error ? e.message : String(e));
    if (client && !client.closed) {
      try {
        client.child.kill();
      } catch {
        /* ignore */
      }
      try {
        await client.waitClose(5_000);
      } catch {
        /* ignore */
      }
    }
    return { name, ok: false, errors: failures };
  } finally {
    if (scenarioTimer) clearTimeout(scenarioTimer);
    if (client) {
      if (client.errors.length) failures.push(...client.errors.map((x) => `stdout: ${x}`));
    }
    // 等待进程关闭后再清理（Windows 文件锁）
    if (projectToClean) await fsp.rm(projectToClean, { recursive: true, force: true }).catch(() => {});
    if (ownsHome) await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const known = new Set(baseScenarios());
  for (const s of opts.scenarios) {
    if (!known.has(s)) throw new Error(`未知场景 ${s}；可选：${[...known].join(", ")}`);
  }
  if (opts.noTask && opts.scenarios.includes("task-runtime-logs")) {
    throw new Error("--no-task 与 task-runtime-logs 场景冲突");
  }
  // 未显式指定场景时：--no-task 从默认集合里剔除任务场景
  const wanted = opts.scenarios.length
    ? opts.scenarios
    : baseScenarios().filter((s) => !(opts.noTask && s === "task-runtime-logs"));

  assert(fs.existsSync(opts.entry), `入口不存在：${opts.entry}`);
  assert(opts.expectTools, `无法从 ${opts.repo}/src/mcp/tools.ts（或 dist）读取工具定义（需 --repo 指向包根）`);
  if (wanted.includes("task-runtime-logs")) {
    assert(
      fs.existsSync(path.join(opts.fixtures, "fixture")) && fs.existsSync(path.join(opts.fixtures, "stub-agent.mjs")),
      `stub-agent fixtures 缺失（需 --fixtures <dir>，当前 ${opts.fixtures}）；或用 --no-task 跳过任务场景`,
    );
  }

  console.log(`check-stdio: entry=${opts.entry}`);
  console.log(`  repo=${opts.repo}  version=${opts.expectVersion}  tools=${opts.expectTools.join(",")}`);
  if (opts.nodeArgs.length) console.log(`  node args: ${opts.nodeArgs.join(" ")}`);

  const ctx = { sharedHome: null };
  const results = [];
  // first-start 与 second-start 共享同一 home，验证"已有技能再次启动"
  for (const name of wanted) {
    if (name === "first-start") {
      ctx.sharedHome = await mkIsolatedHome("shared-skills");
    }
    const r = await runScenario(name, opts, ctx);
    results.push(r);
    const mark = r.ok ? "PASS" : "FAIL";
    console.log(`  [${mark}] ${name}${r.ok ? ` (stdout 行=${r.stdoutLines}, tools=${r.tools}, stderr 字节=${r.stderrBytes})` : ""}`);
    if (!r.ok) for (const e of r.errors) console.log(`         ${e.split("\n").join("\n         ")}`);
  }
  if (ctx.sharedHome) await fsp.rm(ctx.sharedHome, { recursive: true, force: true }).catch(() => {});

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`\ncheck-stdio: ${failed.length}/${results.length} 场景失败`);
    process.exit(1);
  }
  console.log(`\ncheck-stdio: 全部 ${results.length} 个场景通过（stdout 无非协议内容）`);
}

main().catch((e) => {
  console.error(`check-stdio 失败: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
