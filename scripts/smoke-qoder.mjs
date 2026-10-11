#!/usr/bin/env node
/**
 * Qoder CN 真机冒烟：走完整 MCP 链路（buildServer → run_task → wait_task），
 * 与 `smoke-minimax.mjs` / `smoke-opendesign.mjs` 同构，但按 Qoder 的参数集裁剪。
 *
 * 与其他 GUI agent 的差异（写脚本前先读代码确认，别照抄别人的参数集）：
 * - **不支持 `contextWindow`**：Qoder 的上下文窗口是界面里模型自带的属性，不是可传参数
 *   （`handlers.ts` 里 contextWindow 只对 minimax-gui 生效）；
 * - **不支持 `mode`**：`handlers.ts` 对 qoder-gui 显式拒绝 `mode`；
 * - **支持 `modelSource`**（Qoder CN 专用）：`system` / `custom` 等来源，与模型名一起消歧
 *   （`matchModel` 要求 name + source 联合唯一，否则抛 `qoder_model_ambiguous`）；
 * - **思考强度有专属别名**：`低|中|高|极高|最大|关闭思考` 与英文档位等价
 *   （`model.ts` 的 LEVEL_LABELS / normalizeLevel），本脚本用中文档位调用。
 *
 * 用法：
 *   node scripts/smoke-qoder.mjs --confirm-send \
 *     --model "Qwen3.8-Max" --reasoning-level 中 \
 *     --project "D:\path\to\workspace" --task "..." \
 *     [--model-source system|custom] [--answer <续答>] [--timeout-ms <ms>]
 *     [--cancel-after-ms <ms>] [--home <数据目录>]
 *
 * `--confirm-send` 是硬闸门：没有它不发送任何任务（与其他 smoke 一致）。
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

/**
 * 调用 MCP 工具。
 *
 * `timeout` 必须显式传递：SDK 的默认请求超时是 60s，而 `wait_task` 的 `timeoutMs`
 * 是 20 分钟——不带此项时，服务端仍在正常轮询，客户端却先抛 `McpError -32001`
 * （RequestTimeout），把「任务还在跑」误报成调用失败。请求预算取调用方给的 timeMs
 * 再加 30s 余量（留给服务端收尾与日志落盘）。
 */
async function call(client, name, args, opts = {}) {
  const requestOptions = {};
  if (typeof opts.timeMs === "number") requestOptions.timeout = opts.timeMs + 30_000;
  const result = await client.callTool({ name, arguments: args }, undefined, requestOptions);
  const text = (Array.isArray(result.content) ? result.content : [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
  return { result, text, meta: parseMeta(text) };
}

const projectPath = path.resolve(readArg("--project") ?? process.cwd());
const planDoc = readArg("--plan-doc");
const model = readArg("--model");
const modelSource = readArg("--model-source");
const reasoningLevel = readArg("--reasoning-level");
const task = readArg("--task");
const timeoutMs = Number(readArg("--timeout-ms") ?? 20 * 60_000);
const answer = readArg("--answer");
const cancelAfterMs = Number(readArg("--cancel-after-ms") ?? 0);

if (
  !process.argv.includes("--confirm-send") ||
  !model ||
  !task ||
  !planDoc
) {
  process.stderr.write(
    "用法: node scripts/smoke-qoder.mjs --confirm-send --model <模型名> --plan-doc <项目内相对路径> --task <任务> " +
      "[--project <绝对路径>] [--model-source <system|custom>] " +
      "[--reasoning-level <低|中|高|极高|最大|关闭思考>] " +
      "[--answer <续答>] [--cancel-after-ms <毫秒>] [--timeout-ms <毫秒>] [--home <数据目录>]\n" +
      "  --plan-doc（必需）：项目根下的计划文档相对路径；Qoder 适配器硬性要求它存在且可读。\n" +
      "  --reasoning-level：Qoder 专属别名（低/中/高/极高/最大/关闭思考），等价于 low/medium/high/xhigh/max/off。\n" +
      "  --model-source：Qoder 模型来源（system/custom）；模型名在同名多来源时需要它消歧。\n" +
      "  注意：Qoder 不支持 contextWindow 与 mode（前者是界面属性，后者被 handler 显式拒绝）。\n",
  );
  process.exit(2);
}

const home =
  readArg("--home") ??
  path.join(os.tmpdir(), `tianshu-qoder-smoke-${Date.now()}-${randomBytes(3).toString("hex")}`);
await fsp.mkdir(home, { recursive: true });
const logger = await Logger.create(path.join(home, "logs"), "info");
const assembly = await buildServer({ home, logger, skipSkillInstall: true, maxRunningOverride: 1 });
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
await assembly.server.connect(serverTransport);
const client = new Client({ name: "qoder-smoke", version: "1.0.0" }, { capabilities: {} });
await client.connect(clientTransport);

let finalMeta;
try {
  const submitted = await call(client, "run_task", {
    projectPath,
    task,
    agentId: "qoder",
    planDoc,
    model,
    ...(modelSource ? { modelSource } : {}),
    ...(reasoningLevel ? { reasoningLevel } : {}),
  });
  const taskId = submitted.meta?.taskId;
  process.stdout.write(
    `${JSON.stringify({ event: "submitted", taskId, home, projectPath, planDoc, model, modelSource, reasoningLevel })}\n`,
  );
  if (!taskId) {
    process.stderr.write(`提交未返回 taskId，原始响应：\n${submitted.text}\n`);
    process.exitCode = 1;
  } else {
    if (cancelAfterMs > 0) {
      // 等任务进入 running 再取消（取消真停路径的验证）
      await new Promise((r) => setTimeout(r, cancelAfterMs));
      const cancelled = await call(client, "manage_task", { taskId, action: "cancel" });
      process.stdout.write(`${JSON.stringify({ event: "cancel_requested", text: cancelled.text.slice(0, 400) })}\n`);
    } else if (answer) {
      const continued = await call(client, "manage_task", { taskId, action: "continue", message: answer });
      process.stdout.write(`${JSON.stringify({ event: "continued", text: continued.text.slice(0, 400) })}\n`);
    }
    const waited = await call(client, "wait_task", { taskId, timeoutMs }, { timeMs: timeoutMs });
    finalMeta = waited.meta;
    process.stdout.write(`${JSON.stringify({ event: "waited", text: waited.text.slice(0, 2000) })}\n`);
  }
} finally {
  if (finalMeta) process.stdout.write(`${JSON.stringify({ event: "finished", home, meta: finalMeta }, null, 2)}\n`);
  await client.close().catch(() => {});
  await assembly.server.close().catch(() => {});
}
