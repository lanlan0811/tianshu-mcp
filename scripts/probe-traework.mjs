/**
 * TraeWork CDP 真机探针（开发计划 §7：真机探针不入 CI，手动运行）。
 *
 * 用法：
 *   node scripts/probe-traework.mjs                 # 连接并 dump 选择器状态
 *   node scripts/probe-traework.mjs selectors       # 同上（显式）
 *   node scripts/probe-traework.mjs send "任务书"    # 端到端：新建会话 → 发送 → 等回复
 *   node scripts/probe-traework.mjs project <路径>   # 新建会话 → 绑定项目文件夹
 *
 * 前提：TraeWork 已以 --remote-debugging-port=<port> 启动且窗口可见。
 * 端口取 TRAEWORK_CDP_PORT 环境变量，默认 9222。
 */
import { TraeworkCdpClient } from "../dist/agents/traework/cdp/client.js";
import { SELECTORS, resolveSelectors } from "../dist/agents/traework/cdp/selectors.js";
import { startNewSession, bindProject, listSessions, readProjectItems } from "../dist/agents/traework/ui/session.js";
import { typeAndSend } from "../dist/agents/traework/ui/composer.js";
import { judgePoll, makeMarker, parseAdded } from "../dist/agents/traework/ui/reply.js";

const PORT = Number(process.env.TRAEWORK_CDP_PORT || 9222);
const mode = process.argv[2] || "selectors";

const logger = {
  info: (m) => console.log(`[probe] ${m}`),
  warn: (m) => console.warn(`[probe][warn] ${m}`),
  error: (m) => console.error(`[probe][error] ${m}`),
  debug: (m) => console.log(`[probe][debug] ${m}`),
};

const cdp = new TraeworkCdpClient({ port: PORT });
await cdp.connect();
console.log(`[probe] CDP 已连接（端口 ${PORT}）`);

if (mode === "selectors") {
  console.log("[probe] 选择器实测状态：");
  for (const key of Object.keys(SELECTORS)) {
    const spec = SELECTORS[key];
    const exists = await cdp.exists(key);
    const text = exists ? (await cdp.text(key)).slice(0, 60) : "";
    const mark = exists ? "OK  " : "MISS";
    console.log(`  ${mark} ${key.padEnd(22)} verified=${spec.verified ? "Y" : "N"} ${exists ? JSON.stringify(text) : `(${resolveSelectors(key)[0]})`}`);
  }
  console.log("[probe] 任务列表：", (await listSessions(cdp)).slice(0, 10).join(" | ") || "(空)");
}

if (mode === "project") {
  const target = process.argv[3];
  if (!target) {
    console.error("[probe] 用法: node scripts/probe-traework.mjs project <项目绝对路径>");
    process.exit(1);
  }
  await startNewSession(cdp, { logger });
  console.log("[probe] 已新建会话");
  const items = await readProjectItems(cdp);
  console.log(`[probe] 下拉项目 ${items.length} 项：`, items.map((i) => i.name).join("、") || "(空)");
  const r = await bindProject(cdp, target, { logger });
  console.log("[probe] 绑定结果：", JSON.stringify(r));
}

if (mode === "send") {
  const text = process.argv[3];
  if (!text) {
    console.error('[probe] 用法: node scripts/probe-traework.mjs send "任务书"');
    process.exit(1);
  }
  await startNewSession(cdp, { logger });
  const marker = makeMarker();
  await typeAndSend(cdp, marker + text, { logger });
  console.log("[probe] 已发送，开始轮询…");
  const base = await cdp.text("messageContainer");
  let state = { prev: "", stable: 0 };
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (Date.now() > deadline) {
      console.log("[probe] 超时");
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
    const current = await cdp.text("messageContainer");
    const v = judgePoll(current, marker, base, state, 12);
    if (v.kind === "finished" || v.kind === "ask_user") {
      const parsed = parseAdded(v.added);
      console.log(`[probe] 结束（${v.kind}），正文 ${parsed.content.length} 字符：`);
      console.log(parsed.content.slice(0, 2000));
      break;
    }
    state = v.state;
  }
}

cdp.disconnect();
console.log("[probe] 完成");
