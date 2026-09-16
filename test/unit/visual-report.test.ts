import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AcceptanceEngine } from "../../src/verify/acceptance.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { Logger } from "../../src/util/log.js";
import { loadSharp } from "../../src/visual/runtime.js";
import { cleanArtifacts } from "../../src/visual/manage.js";
import { visualEvidence, visualHtml } from "../../src/visual/report.js";
import type { VerifyReport } from "../../src/tasks/task.js";
import type { VisualResult } from "../../src/visual/types.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "visual-report-"));
  dirs.push(root);
  const project = path.join(root, "project"),
    home = path.join(root, "home");
  await fs.mkdir(path.join(project, ".tianshu-mcp"), { recursive: true });
  const sharp = await loadSharp();
  await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
    .png()
    .toFile(path.join(project, "image.png"));
  await fs.writeFile(
    path.join(project, ".tianshu-mcp", "acceptance.json"),
    JSON.stringify({
      checks: [],
      requireChanges: false,
      visual: { enabled: true, images: [{ id: "image", files: ["image.png"] }] },
    }),
  );
  const logger = new Logger(null, "error"),
    store = new TaskStore(home, logger),
    engine = new AcceptanceEngine(store, logger);
  const taskId = "tsk_report";
  const request = { taskId, projectPath: project, displayPath: project, round: 0, store, logger };
  const { report } = await engine.runVerify(request);
  await fs.writeFile(
    store.snapshotPath(taskId),
    JSON.stringify({ taskId, projectPath: project, status: "succeeded" }),
  );
  return { home, project, store, engine, taskId, report, request };
}
it("escapes report text and preserves independent visual JSON", async () => {
  const h = await fixture();
  const json = JSON.parse(await fs.readFile(h.report.files.json, "utf8"));
  expect(json.visual.results[0].status).toBe("passed");
  expect(json.checks.some((c: { name: string }) => c.name === "image")).toBe(false);
  h.report.visual!.results[0]!.message = '<script>alert("unsafe")</script>';
  const html = visualHtml(h.report);
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain('<script>alert("unsafe")');
});
it("retains reports and other task artifacts during explicit cleanup", async () => {
  const h = await fixture();
  const visual = path.join(h.store.dir(h.taskId), "visual");
  await fs.mkdir(visual, { recursive: true });
  await fs.writeFile(path.join(visual, "evidence.png"), "evidence");
  const other = path.join(h.home, "tasks", "tsk_other", "visual");
  await fs.mkdir(other, { recursive: true });
  await fs.writeFile(path.join(other, "keep.png"), "keep");
  expect((await cleanArtifacts(h.home, h.taskId)).preview).toBe(true);
  expect(await fs.readFile(path.join(visual, "evidence.png"), "utf8")).toBe("evidence");
  await cleanArtifacts(h.home, h.taskId, true);
  await expect(fs.access(visual)).rejects.toThrow();
  expect(await fs.readFile(path.join(other, "keep.png"), "utf8")).toBe("keep");
  expect(JSON.parse(await fs.readFile(h.report.files.json, "utf8")).visual.cleanedAt).toBeTruthy();
  expect(await fs.readFile(h.report.files.html!, "utf8")).toContain("Artifacts explicitly cleaned");
  expect((await h.engine.runVerify(h.request)).report.round).toBe(1);
});
it("refuses visual directory aliases rather than deleting task reports", async () => {
  const h = await fixture();
  await fs.symlink(
    h.store.dir(h.taskId),
    path.join(h.store.dir(h.taskId), "visual"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(cleanArtifacts(h.home, h.taskId, true)).rejects.toMatchObject({
    code: "ARTIFACT_PATH",
  });
  expect(await fs.readFile(h.report.files.md, "utf8")).toContain("视觉验收");
});

/** 合成报告：内容项渲染断言（期望原文、票型、缓存与提供者命令；uncertain 档位；闸门未生效标注） */
function syntheticReport(result: Partial<VisualResult> & Pick<VisualResult, "status" | "code" | "id">): VerifyReport {
  return {
    round: 0,
    taskId: "tsk_content",
    projectPath: "/project",
    startedAt: "2026-09-15T00:00:00.000Z",
    finishedAt: "2026-09-15T00:00:01.000Z",
    passed: true,
    verdict: "passed",
    checks: [],
    analysis: {
      changedFiles: [],
      untrackedFiles: [],
      diffstat: { totalAdd: 0, totalDel: 0, perFile: [] },
      signals: { todo: 0, consoleDebug: 0, commentedBlock: 0, secretLike: 0 },
      bigFileChanges: [],
      warnings: [],
      notes: [],
    },
    files: { md: "/project/report.md", json: "/project/report.json", html: "/project/report.html" },
    message: "验收通过。",
    visual: {
      results: [
        {
          kind: "content",
          target: "assets/logo.png",
          optional: true,
          message: "sample 0: ok",
          durationMs: 42,
          repairable: false,
          content: {
            provider: "vision-cli",
            expect: "蓝色齿轮与白色文字 TIANSHU",
            cacheKey: "k".repeat(64),
            cached: false,
            votes: [
              { index: 0, passed: true, confidence: 0.9, reason: "sample 0: ok" },
              { index: 1, passed: false, confidence: 0.4, reason: "sample 1: no" },
            ],
            confidence: 0.65,
            confidenceGate: "no-confidence",
          },
          ...result,
        },
      ],
      artifactDirectory: "/project/visual/0",
      artifactBytes: 0,
    },
  } as VerifyReport;
}
it("renders content check details in evidence markdown and offline HTML", () => {
  const report = syntheticReport({ id: "logo-elements", status: "uncertain", code: "CONTENT_UNCERTAIN" });
  const evidence = visualEvidence(report);
  expect(evidence).toContain("内容校验项默认为告警");
  expect(evidence).toContain("期望描述：蓝色齿轮与白色文字 TIANSHU");
  expect(evidence).toContain("2 次采样：1 通过 / 1 不通过 / 0 无效；置信度均值 0.65");
  expect(evidence).toContain("置信度闸门：命令未提供 confidence，minConfidence 未生效");
  expect(evidence).toContain("提供者命令：vision-cli；命中缓存：否");
  const html = visualHtml(report);
  expect(html).toContain('<option>uncertain</option>');
  expect(html).toContain('data-status="uncertain"');
  expect(html).toContain("蓝色齿轮与白色文字 TIANSHU");
  expect(html).toContain("minConfidence did not apply");
  expect(html).toContain("<th>Sample</th>");
});
it("renders the cache-hit flag for cached content verdicts", () => {
  const report = syntheticReport({ id: "logo-elements", status: "passed", code: "CONTENT_MATCH" });
  report.visual!.results[0]!.content!.cached = true;
  expect(visualEvidence(report)).toContain("命中缓存：是");
  expect(visualHtml(report)).toContain("<strong>cache hit:</strong> yes");
});
it("keeps content detail markup out of non-content results", () => {
  const report = syntheticReport({ id: "logo-elements", status: "passed", code: "CONTENT_MATCH" });
  delete report.visual!.results[0]!.content;
  const html = visualHtml(report);
  expect(html).not.toContain("Content check");
  expect(visualEvidence(report)).not.toContain("期望描述");
});
