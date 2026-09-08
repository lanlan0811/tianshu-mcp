/**
 * 回归测试：rework 指示不得被上一轮的收尾清空（并发竞态）。
 *
 * 背景（实测偶发，负载下放大）：终态快照先落盘，调用方看到 failed 后立即
 * `rework_task(feedback)`；而上一轮 `startTask` 的收尾会 `delete meta.reworkFeedback`
 * ——若两者交错，新写入的返修指示被抹掉，返修轮拿不到 feedback（stub 因此再次写 FAIL）。
 *
 * 修复：启动时原子取走并清空 reworkFeedback（不再在收尾 delete）。
 * 本测试用极短的收尾窗口 + 立即 rework 来复现该交错。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startTestServer,
  makeGitProject,
  callTool,
  parseMeta,
  waitForTerminal,
  rmrf,
  type TestServer,
} from "../test-utils.js";

let ts: TestServer;
const dirs: string[] = [];

beforeAll(async () => {
  ts = await startTestServer();
}, 60_000);

afterAll(async () => {
  await ts?.close();
  for (const d of dirs) await rmrf(d).catch(() => {});
  if (ts) await rmrf(ts.home).catch(() => {});
});

describe("rework 反馈竞态（R-REWORK-1）", () => {
  it("连续多轮「失败→立即 rework」，返修轮始终能拿到 feedback 并最终通过", async () => {
    // 多轮循环放大竞态窗口（每轮都紧跟 rework）
    for (let round = 0; round < 3; round++) {
      const proj = await makeGitProject("fix-on-first");
      dirs.push(proj);

      const { text } = await callTool(ts.client, "run_task", {
        projectPath: proj,
        agentId: "stub",
        task: "新建 done.txt 内容为 PASS，让验收检查通过。",
        autoVerify: true,
        autoFixRounds: 0,
      });
      const taskId = (parseMeta(text).meta!.taskId as string) ?? "";
      const failed = await waitForTerminal(ts.client, taskId);
      expect(failed.status).toBe("failed"); // fix-on-first 首轮写 FAIL

      // 立即 rework（不给收尾留时间，制造交错）
      const rw = await callTool(ts.client, "rework_task", {
        taskId,
        feedback: "上一轮验收失败：done.txt 内容必须是 PASS。请修复。",
      });
      expect(parseMeta(rw.text).meta?.status).toBe("queued");

      const final = await waitForTerminal(ts.client, taskId);
      // 关键断言：返修轮必须收到 feedback 才能写出 PASS
      expect(final.status, `第 ${round} 轮 rework 后应通过`).toBe("succeeded");
    }
  }, 180_000);
});
