#!/usr/bin/env node
/**
 * Codex 真机冒烟脚本（手动运行，不入 CI）。
 *
 * 用途：在已安装并已登录 Codex（ChatGPT 桌面端 MSIX）的机器上，经真实 MCP 工具面
 * （run_task → query_task → manage_task(action=continue|cancel)）驱动完整闭环，用于验收
 * GUI adapter 的受管实例启动、**项目绑定/新建**、模型选择、**思考等级（reasoningLevel）**、
 * 权限模式、任务发送、运行检测与自动验收。
 *
 * 护栏（与 scripts/smoke-zcode.mjs / smoke-traework.mjs 一致）：
 *   必须显式传 `--confirm-send`、`--model`、`--task` 三者齐全才发送；
 *   使用隔离的数据目录（tmp），不污染用户 ~/.tianshu-mcp。
 *
 * 与其它 smoke 的差异（Codex 特有）：
 *   - `--reasoning-level <低|中|高|low|medium|high>`：Codex 的思考强度是**滑块**，
 *     界面文案为 无/极低/轻度/中/高/极高/Max/Ultra 等（随版本变化），
 *     适配器内部归一为 low/medium/high 三档再映射回界面文案。
 *   - 项目绑定是**应用内项目**（Codex 侧栏的 proj 列表），不是窗口级工作区：
 *     适配器按 `projectPath` 的 basename 匹配既有项目，无匹配则**新建项目**并导入该目录。
 *   - 受管实例走 MSIX COM 激活（AUMID），profile 隔离在 tianshu-mcp 数据目录下。
 *
 * 用法：
 *   node scripts/smoke-codex.mjs --confirm-send --model "5.6 Luna" \
 *     --reasoning-level 中 --task "..." --project "D:\Trae项目\AI游戏\Minecraft" \
 *     [--auto-verify] [--auto-fix-rounds <0-10>] [--answer <续答>]
 *     [--cancel-after-ms <毫秒>] [--timeout-ms <毫秒>] [--home <数据目录>]
 *
 * 注：Codex 窗口需保持可见（发送依赖模拟输入与焦点）。
 */
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildServer } from "../dist/server.js";
import { Logger } from "../dist/util/log.js";

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseMeta(text) {
  const match = text.match(/---tianshu-mcp-meta---\n([\s\S]*?)\n---tianshu-mcp-meta---/);
  return match ? JSON.parse(match[1]) : null;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = (Array.isArray(result.content) ? result.content : [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
  return { result, text, meta: parseMeta(text) };
}

const projectPath = path.resolve(readArg("--project") ?? process.cwd());
const model = readArg("--model");
const reasoningLevel = readArg("--reasoning-level");
const task = readArg("--task");
const timeoutMs = Number(readArg("--timeout-ms") ?? 15 * 60_000);
const answer = readArg("--answer");
const cancelAfterMs = Number(readArg("--cancel-after-ms") ?? 0);
const autoVerify = process.argv.includes("--auto-verify");
const autoFixRounds = Number(readArg("--auto-fix-rounds") ?? (autoVerify ? 2 : 0));

if (
  !process.argv.includes("--confirm-send") ||
  !model ||
  !task ||
  !Number.isInteger(autoFixRounds) ||
  autoFixRounds < 0 ||
  autoFixRounds > 10
) {
  process.stderr.write(
    "用法: node scripts/smoke-codex.mjs --confirm-send --model <模型名> --task <任务> [--project <绝对路径>] [--reasoning-level <低|中|高|low|medium|high>] [--auto-verify] [--auto-fix-rounds <0-10>] [--answer <续答>] [--cancel-after-ms <毫秒>] [--timeout-ms <毫秒>] [--home <数据目录>]\n" +
      "  --model：界面上的模型名（真机 26.930 实测形态：「5.6 Luna」「6 Sol」「5.5」等）。\n" +
      "  --reasoning-level：思考强度，中英双语都接受；未指定则沿用面板当前档位（不碰滑块）。\n" +
      "  --cancel-after-ms：任务进入 running 后等待该毫秒数再调用 manage_task(action=cancel)，用于验证取消真停路径。\n" +
      "  注意：Codex 窗口需保持可见（发送依赖模拟输入）。\n",
  );
  process.exit(2);
}

const home =
  readArg("--home") ??
  path.join(os.tmpdir(), `tianshu-codex-smoke-${Date.now()}-${randomBytes(3).toString("hex")}`);
await fsp.mkdir(home, { recursive: true });
const logger = await Logger.create(path.join(home, "logs"), "info");
const assembly = await buildServer({ home, logger, skipSkillInstall: true, maxRunningOverride: 1 });
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
await assembly.server.connect(serverTransport);
const client = new Client({ name: "codex-smoke", version: "1.0.0" }, { capabilities: {} });
await client.connect(clientTransport);

let finalMeta;
try {
  const submitted = await call(client, "run_task", {
    projectPath,
    task,
    agentId: "codex",
    model,
    ...(reasoningLevel ? { reasoningLevel } : {}),
    autoVerify,
    autoFixRounds,
    taskTimeoutMs: timeoutMs,
  });
  if (submitted.result.isError || !submitted.meta?.taskId)
    throw new Error(`run_task 失败：${submitted.text}`);
  const taskId = submitted.meta.taskId;
  process.stdout.write(
    `${JSON.stringify({
      event: "submitted",
      taskId,
      home,
      projectPath,
      model,
      reasoningLevel: reasoningLevel ?? "(沿用面板当前档位)",
    })}\n`,
  );
  const startedAt = Date.now();
  let previous = "";
  let continued = false;
  let cancelled = false;
  for (;;) {
    const current = await call(client, "query_task", { taskId, tailLines: 20 });
    const meta = current.meta ?? {};
    const signature = JSON.stringify({
      status: meta.status,
      lastRunSignal: meta.lastRunSignal,
      progressSummary: meta.progressSummary,
      agentEndReason: meta.agentEndReason,
      pendingQuestion: meta.pendingQuestion,
    });
    if (signature !== previous) {
      process.stdout.write(
        `${JSON.stringify({ event: "status", taskId, ...JSON.parse(signature) })}\n`,
      );
      previous = signature;
    }
    /**
     * 取消触发点：等到 agent 真的在生成（lastRunSignal=stop_button）之后再取消，
     * 否则取消会落在 setup 阶段——那时 CDP 尚未连接，验证不到「点停止按钮 + 有界等待」路径。
     */
    if (
      cancelAfterMs > 0 &&
      !cancelled &&
      meta.status === "running" &&
      meta.lastRunSignal === "stop_button"
    ) {
      cancelled = true;
      const res = await call(client, "manage_task", {
        taskId,
        action: "cancel",
        reason: "smoke cancel validation",
      });
      if (res.result.isError) throw new Error(`manage_task(action=cancel) 失败：${res.text}`);
      process.stdout.write(
        `${JSON.stringify({ event: "cancel-requested", taskId, text: res.text })}\n`,
      );
      previous = "";
      continue;
    }
    if (meta.status === "needs_user" && answer && !continued) {
      const resumed = await call(client, "manage_task", {
        taskId,
        action: "continue",
        message: answer,
      });
      if (resumed.result.isError) throw new Error(`manage_task(action=continue) 失败：${resumed.text}`);
      continued = true;
      previous = "";
      process.stdout.write(
        `${JSON.stringify({ event: "continued", taskId, message: answer, meta: resumed.meta })}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    if (
      ["succeeded", "failed", "needs_attention", "cancelled", "interrupted", "needs_user"].includes(
        meta.status,
      )
    ) {
      finalMeta = meta;
      break;
    }
    if (Date.now() - startedAt > timeoutMs + 30_000) throw new Error(`轮询 ${taskId} 超时`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
} finally {
  await client.close();
  await assembly.close();
}

process.stdout.write(`${JSON.stringify({ event: "finished", home, meta: finalMeta })}\n`);
// 取消验证场景下 cancelled 就是期望结果；其余场景要求 succeeded。
const expected = cancelAfterMs > 0 ? "cancelled" : "succeeded";
if (finalMeta?.status !== expected) process.exitCode = 1;
