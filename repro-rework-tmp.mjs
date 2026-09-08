/** 临时诊断（验证后删除）：复现 rework_task 返回无 meta 的偶发失败。 */
import { startTestServer, makeGitProject, callTool, parseMeta, waitForTerminal, rmrf } from "./test/test-utils.js";

const N = Number(process.argv[2] || 6);
const ts = await startTestServer();
try {
  for (let i = 0; i < N; i++) {
    const proj = await makeGitProject("fix-on-first");
    const { text } = await callTool(ts.client, "run_task", {
      projectPath: proj, agentId: "stub",
      task: "新建 done.txt 内容为 PASS，让验收检查通过。",
      autoVerify: true, autoFixRounds: 0,
    });
    const taskId = parseMeta(text).meta?.taskId;
    const failed = await waitForTerminal(ts.client, taskId);
    if (failed.status !== "failed") { console.log(`[iter ${i}] unexpected first terminal: ${failed.status}`); continue; }

    const rw = await callTool(ts.client, "rework_task", { taskId, feedback: "上一轮验收失败：done.txt 内容必须是 PASS。请修复。" });
    const rwMeta = parseMeta(rw.text).meta;
    if (rwMeta?.status !== "queued") {
      console.log(`[iter ${i}] REWORK NOT QUEUED`);
      console.log("--- raw rework response ---");
      console.log(rw.text.slice(0, 1200));
      console.log("--- first terminal meta ---");
      console.log(JSON.stringify(failed, null, 2).slice(0, 800));
      process.exit(1);
    }
    console.log(`[iter ${i}] ok`);
  }
  console.log("all ok");
} finally {
  await ts.close();
  await rmrf(ts.home).catch(() => {});
}
