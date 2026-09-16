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

it.skipIf(process.env.TIANSHU_VISUAL_BROWSER_TEST !== "1")(
  "semantic-only pages need no baseline and yield a content result (D9)",
  async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "视觉 语义-"));
    const home = resolveDataHome();
    const taskId = `tsk_semantic_${Date.now()}`;
    const logger = new Logger(null, "error");
    const store = new TaskStore(home, logger);
    const engine = new AcceptanceEngine(store, logger);
    const counter = path.join(project, ".tianshu-mcp", "judge-counter.txt");
    try {
      await fs.mkdir(path.join(project, ".tianshu-mcp"));
      process.env.CONTENT_JUDGE_MODE = "pass";
      process.env.CONTENT_JUDGE_COUNTER = counter;
      await fs.writeFile(
        path.join(project, ".tianshu-mcp", "acceptance.json"),
        JSON.stringify({
          checks: [],
          requireChanges: false,
          visual: {
            enabled: true,
            viewports: [{ id: "small", width: 200, height: 150 }],
            content: {
              enabled: true,
              command: process.execPath,
              argsTemplate: [
                path.resolve("test/fixtures/content-judge.mjs"),
                "--image",
                "<image:path>",
                "--expect-file",
                "<expect:file>",
              ],
              samples: 2,
              timeoutMs: 30_000,
            },
            pages: [
              {
                id: "login",
                pixel: false,
                source: { type: "static", root: "." },
                route: "/index.html",
                readySelector: "main",
                content: { expect: "username and password inputs with a login button" },
              },
            ],
          },
        }),
      );
      await fs.writeFile(
        path.join(project, "index.html"),
        '<main style="width:100px;height:100px;background:red">Login</main>',
      );
      const outcome = await engine.runVerify({
        taskId,
        projectPath: project,
        displayPath: project,
        round: 0,
        store,
        logger,
      });
      expect(outcome.passed).toBe(true);
      const results = outcome.report.visual!.results;
      // 语义-only：不产像素项、不要求基准（无 BASELINE_APPROVAL_REQUIRED）
      expect(results).toHaveLength(1);
      expect(results[0]!.kind).toBe("content");
      expect(results[0]!.id).toBe("login-content");
      expect(results[0]!.viewport).toBe("small");
      expect(results[0]!.code).toBe("CONTENT_MATCH");
      expect(results[0]!.artifacts?.source).toBeTruthy();
      expect(
        (await fs.readFile(counter, "utf8")).trim().split(/\r?\n/).filter(Boolean),
      ).toHaveLength(2);
    } finally {
      delete process.env.CONTENT_JUDGE_MODE;
      delete process.env.CONTENT_JUDGE_COUNTER;
      await engine.close();
      await fs.rm(project, { recursive: true, force: true });
      await fs.rm(store.dir(taskId), { recursive: true, force: true });
    }
  },
  120_000,
);

it.skipIf(process.env.TIANSHU_VISUAL_BROWSER_TEST !== "1")(
  "pixel pages with content produce both items from one screenshot and keep the baseline flow",
  async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "视觉 像素内容-"));
    const home = resolveDataHome();
    const taskId = `tsk_pixel_content_${Date.now()}`;
    const logger = new Logger(null, "error");
    const store = new TaskStore(home, logger);
    const engine = new AcceptanceEngine(store, logger);
    const counter = path.join(project, ".tianshu-mcp", "judge-counter.txt");
    let candidateId: string | undefined;
    try {
      await fs.mkdir(path.join(project, ".tianshu-mcp"));
      process.env.CONTENT_JUDGE_MODE = "pass";
      process.env.CONTENT_JUDGE_COUNTER = counter;
      const config = {
        checks: [],
        requireChanges: false,
        visual: {
          enabled: true,
          viewports: [{ id: "small", width: 200, height: 150 }],
          content: {
            enabled: true,
            command: process.execPath,
            argsTemplate: [
              path.resolve("test/fixtures/content-judge.mjs"),
              "--image",
              "<image:path>",
              "--expect-file",
              "<expect:file>",
            ],
            samples: 2,
            timeoutMs: 30_000,
          },
          pages: [
            {
              id: "home",
              source: { type: "static", root: "." },
              route: "/index.html",
              readySelector: "main",
              content: { expect: "hero with product name" },
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
      // 无基准：像素项阻塞（流程与今天一致），内容项仍完成判定
      const blocked = await engine.runVerify({
        taskId,
        projectPath: project,
        displayPath: project,
        round: 0,
        store,
        logger,
      });
      expect(blocked.passed).toBe(false);
      expect(blocked.report.visual?.results).toHaveLength(2);
      expect(blocked.report.visual?.results[0]).toMatchObject({
        id: "home",
        kind: "page",
        code: "BASELINE_APPROVAL_REQUIRED",
      });
      expect(blocked.report.visual?.results[1]).toMatchObject({
        id: "home-content",
        kind: "content",
        code: "CONTENT_MATCH",
        status: "passed",
      });
      expect(
        (await fs.readFile(counter, "utf8")).trim().split(/\r?\n/).filter(Boolean),
      ).toHaveLength(2);
      const candidate = await prepareBaseline(home, { projectPath: project });
      candidateId = candidate.candidateId;
      await approveBaseline(home, {
        candidateId,
        expectedDigest: candidate.digest,
        approvalNote: "Explicit approval of pixel+content fixture",
      });
      const passed = await engine.runVerify({
        taskId: `${taskId}_approved`,
        projectPath: project,
        displayPath: project,
        round: 0,
        store,
        logger,
      });
      expect(passed.passed).toBe(true);
      const results = passed.report.visual!.results;
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ id: "home", kind: "page", status: "passed" });
      expect(results[1]).toMatchObject({ id: "home-content", kind: "content", status: "passed" });
      // 新任务 = 新缓存目录 → 内容判定重跑（任务级缓存隔离）
      expect(
        (await fs.readFile(counter, "utf8")).trim().split(/\r?\n/).filter(Boolean),
      ).toHaveLength(4);
    } finally {
      delete process.env.CONTENT_JUDGE_MODE;
      delete process.env.CONTENT_JUDGE_COUNTER;
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
  180_000,
);
