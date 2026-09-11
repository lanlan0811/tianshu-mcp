#!/usr/bin/env node
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
const task = readArg("--task");
const timeoutMs = Number(readArg("--timeout-ms") ?? 15 * 60_000);
const answer = readArg("--answer");
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
    "用法: node scripts/smoke-zcode.mjs --confirm-send --model <供应商/模型> --task <任务> [--project <绝对路径>] [--auto-verify] [--auto-fix-rounds <0-10>] [--answer <续答>] [--timeout-ms <毫秒>]\n",
  );
  process.exit(2);
}

const home = path.join(
  os.tmpdir(),
  `tianshu-zcode-smoke-${Date.now()}-${randomBytes(3).toString("hex")}`,
);
await fsp.mkdir(home, { recursive: true });
const logger = await Logger.create(path.join(home, "logs"), "info");
const assembly = await buildServer({ home, logger, skipSkillInstall: true, maxRunningOverride: 1 });
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
await assembly.server.connect(serverTransport);
const client = new Client({ name: "zcode-smoke", version: "1.0.0" }, { capabilities: {} });
await client.connect(clientTransport);

let finalMeta;
try {
  const submitted = await call(client, "run_task", {
    projectPath,
    task,
    agentId: "zcode",
    model,
    autoVerify,
    autoFixRounds,
    taskTimeoutMs: timeoutMs,
  });
  if (submitted.result.isError || !submitted.meta?.taskId)
    throw new Error(`run_task 失败：${submitted.text}`);
  const taskId = submitted.meta.taskId;
  process.stdout.write(`${JSON.stringify({ event: "submitted", taskId, home })}\n`);
  const startedAt = Date.now();
  let previous = "";
  let continued = false;
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
      process.stdout.write(`${JSON.stringify({ event: "status", taskId, ...JSON.parse(signature) })}\n`);
      previous = signature;
    }
    if (meta.status === "needs_user" && answer && !continued) {
      const resumed = await call(client, "continue_task", { taskId, message: answer });
      if (resumed.result.isError)
        throw new Error(`continue_task 失败：${resumed.text}`);
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
    if (Date.now() - startedAt > timeoutMs + 30_000)
      throw new Error(`轮询 ${taskId} 超时`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
} finally {
  await client.close();
  await assembly.close();
}

process.stdout.write(`${JSON.stringify({ event: "finished", home, meta: finalMeta })}\n`);
if (finalMeta?.status !== "succeeded") process.exitCode = 1;
