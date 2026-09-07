#!/usr/bin/env node
/**
 * stub-agent.mjs — 模拟外部 AI-Agent CLI（开发计划 §14）。
 * 行为由项目内 `.tianshu-mcp/playbook.json` 决定（{ playbook: "good" | "fix-on-first" | "never" }）：
 *   - good:         每次都把 done.txt 写成 PASS（一次通过）
 *   - fix-on-first: 第一轮（prompt 无"失败/修复"反馈）写成 FAIL；收到验收失败反馈后写成 PASS
 *   - never:        永远写成 FAIL（验证 needs_attention / 轮次上限）
 * agent 语义：无论写什么都 exit 0（"自认为完成"）；是否合格由验收引擎判定。
 */
import fs from "node:fs";
import path from "node:path";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const cwd = process.cwd();
  const prompt = process.argv.slice(2).join(" ").trim();

  // 读取剧本（来自项目内配置，像真实 agent 依据项目上下文行事）
  let playbook = "good";
  let sleepMs = 400;
  const cfgPath = path.join(cwd, ".tianshu-mcp", "playbook.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (cfg && typeof cfg.playbook === "string") playbook = cfg.playbook;
    if (cfg && typeof cfg.sleepMs === "number") sleepMs = cfg.sleepMs;
  } catch {
    /* 缺省 good */
  }

  console.log(`[stub-agent] playbook=${playbook} 任务目录=${cwd}`);
  console.log(`[stub-agent] 收到任务书（前 200 字）: ${prompt.slice(0, 200)}`);

  // sleep 剧本：长时间不退出（供取消/超时测试）；收到 kill 后退出
  if (playbook === "sleep") {
    console.log(`[stub-agent] sleep 模式：保持运行 ${sleepMs}ms，等待被取消/超时`);
    await sleep(sleepMs);
    process.exit(0);
  }

  await sleep(400); // 模拟一点工作耗时

  const hasFeedback = /失败|修复|修改|请.*改|上一轮验收/.test(prompt);
  let content;
  if (playbook === "never") {
    content = "FAIL";
  } else if (playbook === "fix-on-first") {
    content = hasFeedback ? "PASS" : "FAIL";
  } else {
    content = "PASS";
  }

  const target = path.join(cwd, "done.txt");
  fs.writeFileSync(target, `${content}\n`, "utf8");
  console.log(`[stub-agent] 完成：写入 done.txt = ${content}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[stub-agent] 异常:", e);
  process.exit(1);
});
