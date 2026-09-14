import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AcceptanceEngine } from "../../src/verify/acceptance.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { Logger } from "../../src/util/log.js";
import { loadSharp } from "../../src/visual/runtime.js";
import { cleanArtifacts } from "../../src/visual/manage.js";
import { visualHtml } from "../../src/visual/report.js";

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
