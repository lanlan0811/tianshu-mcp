import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { digest, withVisualLock } from "./lock.js";
import { captureVisualSnapshot } from "./snapshot.js";
import { VisualError } from "./errors.js";
import { writeJsonAtomic } from "../util/fs.js";
import { projectFile } from "./paths.js";
import { visualHtml } from "./report.js";
import { reportToMd } from "../verify/report.js";
import { readAcceptanceConfig } from "./config.js";
import { VisualBudget } from "./budget.js";
import { VisualBrowser } from "./capture.js";
import { VisualServices } from "./services.js";
import { clearContentCache } from "./content-cache.js";
import { resolveCommandPath } from "./content-command.js";
import {
  contentCommandParts,
  hasContentRules,
  probeContent,
  type ContentProbeResult,
} from "./content.js";
import { isDefaultWorkspace, type TaskMeta, type VerifyReport } from "../tasks/task.js";

function taskDirectory(home: string, taskId: string): string {
  if (!/^(?:tsk|vfy)_[A-Za-z0-9_-]+$/.test(taskId))
    throw new VisualError("TASK_ID_INVALID", "Invalid task ID");
  return path.join(home, "tasks", taskId);
}

/**
 * 无项目任务（default 工作区，issue #12）没有项目可做视觉规则检查/基准审批/证据清理：
 * 明确拒绝，避免用空路径去猜一个项目目录。
 */
function requireProjectTask(meta: TaskMeta): void {
  if (isDefaultWorkspace(meta))
    throw new VisualError(
      "TASK_NO_PROJECT",
      "Project-less (default workspace) tasks have no project visual rules or baselines",
    );
}
export async function reviewRules(home: string, taskId: string) {
  const directory = taskDirectory(home, taskId);
  const meta = JSON.parse(await fs.readFile(path.join(directory, "task.json"), "utf8")) as TaskMeta;
  requireProjectTask(meta);
  const current = await captureVisualSnapshot(meta.projectPath);
  const previous = JSON.parse(
    await fs.readFile(path.join(directory, "visual-snapshot.json"), "utf8"),
  ) as unknown;
  const reviewId = randomUUID();
  const review = {
    reviewId,
    taskId,
    projectPath: await fs.realpath(meta.projectPath),
    previous,
    current,
    createdAt: new Date().toISOString(),
  };
  const content = JSON.stringify(review, null, 2);
  const filename = path.join(directory, `visual-review-${reviewId}.json`);
  await fs.writeFile(filename, content, { flag: "wx" });
  return { reviewId, digest: digest(content), filename, previous, current };
}
export async function approveRules(
  home: string,
  taskId: string,
  reviewId: string,
  expectedDigest: string,
  note: string,
) {
  if (!/^[a-f0-9-]{36}$/.test(reviewId) || !note.trim())
    throw new VisualError("REVIEW_INVALID", "Review ID and explicit approval note required");
  const directory = taskDirectory(home, taskId);
  const filename = path.join(directory, `visual-review-${reviewId}.json`);
  const content = await fs.readFile(filename, "utf8");
  if (digest(content) !== expectedDigest)
    throw new VisualError("REVIEW_CHANGED", "Review digest changed");
  const review = JSON.parse(content) as Awaited<ReturnType<typeof reviewRules>> & {
    projectPath: string;
    taskId: string;
  };
  return withVisualLock(home, review.projectPath, async () => {
    const meta = JSON.parse(
      await fs.readFile(path.join(directory, "task.json"), "utf8"),
    ) as TaskMeta;
    requireProjectTask(meta);
    if (
      meta.status !== "needs_attention" ||
      (await fs.realpath(meta.projectPath)) !== review.projectPath ||
      review.taskId !== taskId
    )
      throw new VisualError(
        "TASK_NOT_BLOCKED",
        "Rule approval requires a blocked task in the same project",
      );
    const current = await captureVisualSnapshot(meta.projectPath);
    if (
      current.configDigest !== review.current.configDigest ||
      JSON.stringify(current.baselines) !== JSON.stringify(review.current.baselines)
    )
      throw new VisualError("REVIEW_STALE", "Configuration or baselines changed after review");
    const previous = JSON.parse(
      await fs.readFile(path.join(directory, "visual-snapshot.json"), "utf8"),
    ) as unknown;
    if (JSON.stringify(previous) !== JSON.stringify(review.previous))
      throw new VisualError("REVIEW_STALE", "Task snapshot changed after review");
    const approval = {
      note,
      at: new Date().toISOString(),
      previousDigest: digest(JSON.stringify(previous)),
      reviewId,
      expectedDigest,
    };
    await writeJsonAtomic(path.join(directory, "visual-snapshot.json"), {
      ...current,
      approved: approval,
    });
    await writeJsonAtomic(
      path.join(directory, `visual-review-${reviewId}-approval.json`),
      approval,
    );
    return approval;
  });
}
export async function cleanArtifacts(home: string, taskId: string, apply = false) {
  const directory = taskDirectory(home, taskId);
  return withVisualLock(home, `task:${taskId}`, async () => {    const realHome = await fs.realpath(home);
    const expectedDirectory = path.join(realHome, "tasks", taskId);
    const resolvedDirectory = await projectFile(realHome, path.join("tasks", taskId));
    const samePath = (a: string, b: string): boolean =>
      process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (!samePath(expectedDirectory, resolvedDirectory))
      throw new VisualError("ARTIFACT_PATH", "Task directory is aliased; refusing cleanup");
    const meta = JSON.parse(
      await fs.readFile(path.join(directory, "task.json"), "utf8"),
    ) as TaskMeta;
    requireProjectTask(meta);
    if (["queued", "running", "verify_start", "fixing"].includes(meta.status))
      throw new VisualError("TASK_ACTIVE", "Cannot clean active task evidence");
    const target = await projectFile(directory, "visual");
    if (!samePath(target, path.join(resolvedDirectory, "visual")))
      throw new VisualError("ARTIFACT_PATH", "Visual directory is aliased; refusing cleanup");
    if (!apply) return { preview: true, target };
    // projectFile validates resolved absolute containment before recursive deletion.
    await fs.rm(target, { recursive: true, force: true });
    const cleanedAt = new Date().toISOString();
    for (const name of await fs.readdir(directory)) {
      if (!/^report-\d+\.json$/.test(name)) continue;
      const report = JSON.parse(
        await fs.readFile(path.join(directory, name), "utf8"),
      ) as VerifyReport;
      if (!report.visual) continue;
      report.visual.cleanedAt = cleanedAt;
      await writeJsonAtomic(path.join(directory, name), report);
      await fs.writeFile(
        await projectFile(directory, path.basename(report.files.md)),
        reportToMd(report),
      );
      if (report.files.html)
        await fs.writeFile(
          await projectFile(directory, path.basename(report.files.html)),
          visualHtml(report),
        );
    }
    await writeJsonAtomic(path.join(directory, "visual-cleaned.json"), { cleanedAt, target });
    return { preview: false, target, cleanedAt };
  });
}

/** `visual content cache clear <taskId>`：判定缓存是派生物、可重算，故无需 --apply */
export async function clearContentCacheForTask(home: string, taskId: string) {
  const directory = taskDirectory(home, taskId);
  const removed = await clearContentCache(directory);
  return { taskId, removed };
}

export interface ContentProbeOutput {
  project: string;
  results: ContentProbeResult[];
  /** 逐规则命令解析结果，便于用户核对自备命令是否可执行 */
  commands: { id: string; command: string; resolved: boolean; allowRemote: boolean }[];
}

/**
 * `visual content probe <project> [ruleId]`（F 组）：按声明规则跑真实判定，但**不写证据、不写缓存**，
 * 供用户先验证自备命令是否可用、判定是否稳定。语义页面（pages[].content）会按需临时截图。
 */
export async function probeContentRules(
  home: string,
  projectPath: string,
  ruleId?: string,
): Promise<ContentProbeOutput> {
  const config = (await readAcceptanceConfig(projectPath))?.visual;
  if (!config?.enabled || !hasContentRules(config))
    throw new VisualError("CONTENT_CONFIG_INVALID", "No enabled content rules in acceptance.json");
  const contents = config.contents.filter((rule) => !ruleId || rule.id === ruleId);
  const pages = config.pages.filter((page) => page.content && (!ruleId || `${page.id}-content` === ruleId));
  if (ruleId && !contents.length && !pages.length)
    throw new VisualError("CONTENT_RULE_UNKNOWN", `Unknown content rule: ${ruleId}`);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tianshu-content-probe-"));
  const budget = new VisualBudget(config.limits);
  const services = new VisualServices(projectPath, budget);
  const browser = new VisualBrowser(config, home, budget);
  const results: ContentProbeResult[] = [];
  const commands: ContentProbeOutput["commands"] = [];
  try {
    if (pages.length) await browser.start();
    for (const rule of contents) {
      const effective = contentCommandParts(config, rule);
      commands.push({
        id: rule.id,
        command: effective.command,
        resolved: (await resolveCommandPath(effective.command, await projectFile(projectPath, effective.cwd))) !== null,
        allowRemote: effective.allowRemote,
      });
      for (const [fileIndex, file] of rule.files.entries())
        results.push(
          await probeContent(
            { config, project: projectPath, budget, tempDir: tempRoot },
            {
              id: rule.files.length > 1 ? `${rule.id}[${fileIndex}]` : rule.id,
              target: file,
              check: rule,
              imagePath: await projectFile(projectPath, file),
            },
          ),
        );
    }
    for (const page of pages) {
      const effective = contentCommandParts(config, page.content!);
      commands.push({
        id: `${page.id}-content`,
        command: effective.command,
        resolved: (await resolveCommandPath(effective.command, await projectFile(projectPath, effective.cwd))) !== null,
        allowRemote: effective.allowRemote,
      });
      for (const viewport of config.viewports.filter(
        (v) => page.viewports === undefined || page.viewports.includes(v.id),
      )) {
        const captured = await browser.capture(
          projectPath,
          page,
          viewport,
          await services.get(page.source),
        );
        const imagePath = path.join(tempRoot, `${page.id}-${viewport.id}.png`);
        await fs.mkdir(path.dirname(imagePath), { recursive: true });
        await fs.writeFile(imagePath, captured.image);
        results.push(
          await probeContent(
            { config, project: projectPath, budget, tempDir: tempRoot },
            {
              id: `${page.id}-content`,
              target: page.route,
              viewport: viewport.id,
              check: page.content!,
              imagePath,
            },
          ),
        );
      }
    }
  } finally {
    await browser.close();
    await services.close();
    budget.dispose();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
  return { project: projectPath, results, commands };
}
