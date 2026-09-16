import path from "node:path";
import fs from "node:fs/promises";
import { VisualBrowser } from "./capture.js";
import { VisualBudget } from "./budget.js";
import { VisualServices } from "./services.js";
import { VisualError, visualError } from "./errors.js";
import { checkImage } from "./images.js";
import { projectFile } from "./paths.js";
import { baselineRelative, fileDigest } from "./snapshot.js";
import { compareImages } from "./compare.js";
import { assertContentReady, checkContent, hasContentRules } from "./content.js";
import type { VisualConfig } from "./schema.js";
import type { VisualReport, VisualResult } from "./types.js";

export async function runVisual(
  config: VisualConfig,
  project: string,
  home: string,
  directory: string,
  signal?: AbortSignal,
): Promise<VisualReport> {
  const budget = new VisualBudget(config.limits, signal);
  const browser = new VisualBrowser(config, home, budget);
  const services = new VisualServices(project, budget);
  // directory = <taskDir>/visual/<round>；内容判定缓存落任务目录级
  const taskDir = path.dirname(path.dirname(directory));
  const results: VisualResult[] = [];
  let browserError: unknown;
  try {
    // 内容预检（整轮级）：命令不可解析 / env 引用缺失 → 抛错 → 整轮 configurationError，
    // 不产出任何结果行（P2/P3：预检枚举逐规则有效命令，不得只查全局）
    if (config.content.enabled && hasContentRules(config)) {
      await assertContentReady(config, project);
    }
    if (config.pages.length)
      try {
        await browser.start();
      } catch (e) {
        browserError = e;
      }
    const jobs: (() => Promise<VisualResult[]>)[] = [];
    for (const rule of config.images)
      for (const file of rule.files)
        jobs.push(async () => [await checkImage(project, rule, file, budget)]);
    for (const rule of config.contents)
      for (const [fileIndex, file] of rule.files.entries())
        jobs.push(async () => [
          await checkContent(
            { config, project, taskDir, artifactDir: directory, budget },
            {
              id: rule.id,
              target: file,
              optional: !rule.blocking,
              check: rule,
              imagePath: await projectFile(project, file),
              evidenceDir: path.join(directory, "content", rule.id, String(fileIndex)),
            },
          ),
        ]);
    for (const rule of config.pages)
      for (const viewport of config.viewports.filter(
        (v) => !rule.viewports || rule.viewports.includes(v.id),
      ))
        jobs.push(async () => {
          const started = Date.now();
          const result: VisualResult = {
            id: rule.id,
            kind: "page",
            target: rule.route,
            viewport: viewport.id,
            optional: rule.optional,
            status: "passed",
            code: "PIXELS_MATCH",
            message: "Screenshot matches approved baseline",
            durationMs: 0,
            repairable: false,
          };
          try {
            budget.check();
            if (browserError) throw browserError;
            const captured = await browser.capture(
              project,
              rule,
              viewport,
              await services.get(rule.source),
            );
            const itemDir = path.join(directory, rule.id, viewport.id);
            const actual = path.join(itemDir, "actual.png");
            await budget.write(actual, captured.image);
            Object.assign(result, {
              environment: captured.environment,
              rules: captured.rules,
              masks: captured.masks,
              artifacts: { actual },
            });
            const baseline = await projectFile(
              project,
              baselineRelative(config, rule, viewport.id),
            );
            if (
              (await fileDigest(baseline)) === null ||
              (await fileDigest(`${baseline}.manifest.json`)) === null
            )
              throw new VisualError(
                "BASELINE_APPROVAL_REQUIRED",
                "Approved baseline missing. Prepare and review a candidate, then explicitly approve it; this capture does not pass.",
              );
            let manifest: { normalizedDigest?: string; approval?: unknown };
            try {
              manifest = JSON.parse(
                await fs.readFile(`${baseline}.manifest.json`, "utf8"),
              ) as typeof manifest;
            } catch {
              throw new VisualError("VISUAL_INTEGRITY", "Baseline manifest is invalid");
            }
            if (!manifest.approval || manifest.normalizedDigest !== (await fileDigest(baseline)))
              throw new VisualError(
                "VISUAL_INTEGRITY",
                "Baseline content does not match approved manifest",
              );
            const compared = await compareImages(
              baseline,
              actual,
              itemDir,
              {
                pixelThreshold: rule.pixelThreshold ?? config.defaults.pixelThreshold,
                maxDiffRatio: rule.maxDiffRatio ?? config.defaults.maxDiffRatio,
                masks: captured.masks,
              },
              budget,
            );
            Object.assign(result, {
              status: compared.passed ? "passed" : "failed",
              code: compared.code,
              message: compared.passed
                ? result.message
                : "Screenshot differs from approved baseline",
              repairable: !compared.passed,
              metrics: compared.metrics,
              artifacts: compared.artifacts,
              regions: compared.regions,
            });
          } catch (e) {
            const error = visualError(e);
            Object.assign(result, {
              status: error.kind === "cancelled" ? "skipped" : error.kind,
              code: error.code,
              message: error.message,
              repairable: error.kind === "failed",
            });
          }
          result.durationMs = Date.now() - started;
          return [result];
        });
    let cursor = 0;
    const collected: VisualResult[][] = new Array(jobs.length);
    await Promise.all(
      Array.from({ length: Math.min(config.limits.concurrency, jobs.length) }, async () => {
        while (cursor < jobs.length) {
          const index = cursor++;
          collected[index] = await jobs[index]!();
        }
      }),
    );
    // 按声明序回填后展平，保证既有顺序与多结果项（页面像素+内容）的确定性
    results.push(...collected.flat());
    return { results, artifactDirectory: directory, artifactBytes: budget.bytes };
  } finally {
    await browser.close();
    await services.close();
    budget.dispose();
  }
}
