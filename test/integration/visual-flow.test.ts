import { expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { prepareBaseline, approveBaseline } from "../../src/visual/baselines.js";
import { AcceptanceEngine } from "../../src/verify/acceptance.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { Logger } from "../../src/util/log.js";
import { resolveDataHome } from "../../src/config/store.js";

it.skipIf(process.env.TIANSHU_VISUAL_BROWSER_TEST !== "1")(
  "requires explicit approval then detects page defects and protects frozen rules",
  async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "视觉 测试-"));
    const home = resolveDataHome();
    const taskId = `tsk_visual_test_${Date.now()}`;
    const logger = new Logger(null, "error");
    const store = new TaskStore(home, logger);
    const engine = new AcceptanceEngine(store, logger);
    let candidateId: string | undefined;
    try {
      await fs.mkdir(path.join(project, ".tianshu-mcp"));
      const config = {
        checks: [],
        requireChanges: false,
        visual: {
          enabled: true,
          viewports: [{ id: "small", width: 200, height: 150 }],
          pages: [
            {
              id: "home",
              source: { type: "static", root: "." },
              route: "/index.html",
              readySelector: "main",
            },
          ],
        },
      };
      await fs.writeFile(
        path.join(project, ".tianshu-mcp", "acceptance.json"),
        JSON.stringify(config),
      );
      await fs.writeFile(
        path.join(project, "index.html"),
        '<main style="width:100px;height:100px;background:red">Test</main>',
      );
      const req = { taskId, projectPath: project, displayPath: project, round: 0, store, logger };
      const missing = await engine.runVerify(req);
      expect(missing.passed).toBe(false);
      expect(missing.report.visual?.results[0]?.code).toBe("BASELINE_APPROVAL_REQUIRED");
      const candidate = await prepareBaseline(home, { projectPath: project });
      candidateId = candidate.candidateId;
      await approveBaseline(home, {
        candidateId,
        expectedDigest: candidate.digest,
        approvalNote: "Explicit approval of isolated test fixture",
      });
      // New task gets newly approved baseline; the original frozen task correctly blocks until approved refresh.
      const frozen = await engine.runVerify(req);
      expect(frozen.report.blockingIssues?.[0]?.code).toBe("VISUAL_INTEGRITY");
      const newReq = { ...req, taskId: `${taskId}_approved` };
      const passed = await engine.runVerify(newReq);
      expect(passed.report.visual?.results[0]?.message).toBe(
        "Screenshot matches approved baseline",
      );
      expect(passed.passed).toBe(true);
      await fs.writeFile(
        path.join(project, "index.html"),
        '<main style="width:100px;height:100px;background:blue">Test</main>',
      );
      const failed = await engine.runVerify(newReq);
      expect(failed.passed).toBe(false);
      expect(failed.report.visual?.results[0]?.code).toBe("PIXEL_DIFFERENCE");
      expect(failed.report.round).toBe(passed.report.round + 1);
      expect(await fs.readFile(failed.report.files.html!, "utf8")).toContain("Actual opacity");
      config.visual.enabled = false;
      await fs.writeFile(
        path.join(project, ".tianshu-mcp", "acceptance.json"),
        JSON.stringify(config),
      );
      const tampered = await engine.runVerify(newReq);
      expect(tampered.report.blockingIssues?.[0]?.code).toBe("VISUAL_INTEGRITY");
    } finally {
      await engine.close();
      await fs.rm(project, { recursive: true, force: true });
      await fs.rm(store.dir(taskId), { recursive: true, force: true });
      await fs.rm(store.dir(`${taskId}_approved`), { recursive: true, force: true });
      if (candidateId)
        await fs.rm(path.join(home, "visual-candidates", candidateId), {
          recursive: true,
          force: true,
        });
    }
  },
  120_000,
);
