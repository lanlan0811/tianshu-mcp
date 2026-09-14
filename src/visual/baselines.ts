import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readAcceptanceConfig } from "./config.js";
import { VisualError } from "./errors.js";
import { VisualBudget } from "./budget.js";
import { VisualBrowser } from "./capture.js";
import { VisualServices } from "./services.js";
import { projectFile } from "./paths.js";
import { decodeImage } from "./images.js";
import { loadSharp } from "./runtime.js";
import { digest, withVisualLock } from "./lock.js";
import { baselineRelative, captureVisualSnapshot, fileDigest } from "./snapshot.js";
import { writeJsonAtomic } from "../util/fs.js";
import { execFileAsync } from "../verify/exec.js";
import { projectRelativePath } from "./schema.js";

const safeId = z.string().uuid();
export const PrepareBaselineSchema = z
  .object({
    projectPath: z.string().min(1),
    caseIds: z.array(z.string()).min(1).optional(),
    viewportIds: z.array(z.string()).min(1).optional(),
    imports: z
      .array(
        z
          .object({ caseId: z.string(), viewportId: z.string(), file: projectRelativePath })
          .strict(),
      )
      .optional(),
  })
  .strict();
export const ApproveBaselineSchema = z
  .object({
    candidateId: safeId,
    expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    approvalNote: z.string().trim().min(1),
    taskId: z
      .string()
      .regex(/^tsk_[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();
interface CandidateEntry {
  target: string;
  image: string;
  digest: string;
  originalDigest: string | null;
  originalManifestDigest: string | null;
  manifest: Record<string, unknown>;
}
interface Candidate {
  id: string;
  projectPath: string;
  configDigest: string;
  entries: CandidateEntry[];
  createdAt: string;
}
export async function prepareBaseline(
  home: string,
  args: z.infer<typeof PrepareBaselineSchema>,
  signal?: AbortSignal,
) {
  const project = await fs.realpath(args.projectPath);
  return withVisualLock(home, project, async () => {
    const config = (await readAcceptanceConfig(project))?.visual;
    if (!config?.enabled || !config.pages.length)
      throw new VisualError(
        "BASELINE_CONFIG",
        "Enable visual page rules before preparing baselines",
      );
    if (
      args.caseIds?.some((id) => !config.pages.some((p) => p.id === id)) ||
      args.viewportIds?.some((id) => !config.viewports.some((v) => v.id === id))
    )
      throw new VisualError("BASELINE_SELECTION", "Unknown check or viewport ID");
    const snapshot = await captureVisualSnapshot(project);
    const id = randomUUID();
    const directory = path.join(home, "visual-candidates", id);
    const budget = new VisualBudget(config.limits, signal);
    const browser = new VisualBrowser(config, home, budget);
    const services = new VisualServices(project, budget);
    const entries: CandidateEntry[] = [];
    const usedImports = new Set<number>();
    let browserStarted = false;
    try {
      for (const rule of config.pages.filter((p) => !args.caseIds || args.caseIds.includes(p.id))) {
        for (const viewport of config.viewports.filter(
          (v) =>
            (!rule.viewports || rule.viewports.includes(v.id)) &&
            (!args.viewportIds || args.viewportIds.includes(v.id)),
        )) {
          const target = baselineRelative(config, rule, viewport.id);
          if (entries.some((entry) => entry.target === target))
            throw new VisualError(
              "BASELINE_TARGET_CONFLICT",
              "Multiple captures address the same shared baseline; prepare each shared reference explicitly",
            );
          const imported =
            args.imports?.filter((i) => i.caseId === rule.id && i.viewportId === viewport.id) ?? [];
          if (imported.length > 1)
            throw new VisualError("BASELINE_IMPORT_CONFLICT", "Duplicate import mapping");
          let image: Buffer, evidence: Record<string, unknown>;
          if (imported[0]) {
            usedImports.add(args.imports!.indexOf(imported[0]));
            const source = await projectFile(project, imported[0].file);
            const decoded = await decodeImage(source, budget);
            const sharp = await loadSharp();
            image = await sharp(decoded.data, { raw: decoded.info }).png().toBuffer();
            evidence = {
              importedFrom: imported[0].file,
              sourceDigest: digest(decoded.input),
              viewport,
              browserKind: config.browser.mode,
              platform: process.platform,
            };
          } else {
            if (!browserStarted) {
              await browser.start();
              browserStarted = true;
            }
            const captured = await browser.capture(
              project,
              rule,
              viewport,
              await services.get(rule.source),
            );
            image = captured.image;
            evidence = { ...captured.environment, masks: captured.masks };
          }
          const imageName = `${rule.id}-${viewport.id}.png`;
          await budget.write(path.join(directory, imageName), image);
          entries.push({
            target,
            image: imageName,
            digest: digest(image),
            originalDigest: snapshot.baselines[target] ?? null,
            originalManifestDigest: snapshot.baselines[`${target}.manifest.json`] ?? null,
            manifest: {
              ...evidence,
              caseId: rule.id,
              viewport,
              effectiveRules: { defaults: config.defaults, page: rule },
              normalizedDigest: digest(image),
            },
          });
        }
      }
      if (!entries.length || usedImports.size !== (args.imports?.length ?? 0))
        throw new VisualError("BASELINE_SELECTION", "Empty selection or unused import mapping");
      const candidate: Candidate = {
        id,
        projectPath: project,
        configDigest: snapshot.configDigest,
        entries,
        createdAt: new Date().toISOString(),
      };
      const content = JSON.stringify(candidate, null, 2);
      await budget.write(path.join(directory, "candidate.json"), content);
      const preview = path.join(directory, "preview.html");
      await budget.write(
        preview,
        `<!doctype html><meta charset="utf-8"><title>Visual baseline candidates</title><h1>Review before approval</h1>${entries.map((entry) => `<figure><img style="max-width:100%" src="${encodeURIComponent(entry.image)}"><figcaption>${entry.digest}</figcaption></figure>`).join("")}`,
      );
      return {
        candidateId: id,
        digest: digest(content),
        preview,
        entries: entries.map((e) => ({ target: e.target, digest: e.digest })),
      };
    } finally {
      await browser.close();
      await services.close();
      budget.dispose();
    }
  });
}
/** Host/user approval is mandatory; automated repair must never invoke this service. */
export async function approveBaseline(home: string, args: z.infer<typeof ApproveBaselineSchema>) {
  ApproveBaselineSchema.parse(args);
  const directory = path.join(home, "visual-candidates", args.candidateId);
  const content = await fs.readFile(path.join(directory, "candidate.json"), "utf8");
  if (digest(content) !== args.expectedDigest)
    throw new VisualError("CANDIDATE_CHANGED", "Candidate metadata digest changed");
  const candidate = JSON.parse(content) as Candidate;
  const project = await fs.realpath(candidate.projectPath);
  return withVisualLock(home, project, async () => {
    if (candidate.id !== args.candidateId || candidate.projectPath !== project)
      throw new VisualError("CANDIDATE_PROJECT", "Candidate identity/project mismatch");
    const current = await captureVisualSnapshot(project);
    if (current.configDigest !== candidate.configDigest)
      throw new VisualError("CONFIG_CHANGED", "Visual configuration changed since preparation");
    const loaded: { target: string; image: Buffer; entry: CandidateEntry }[] = [];
    for (const entry of candidate.entries) {
      const target = await projectFile(project, entry.target);
      const image = await fs.readFile(await projectFile(directory, entry.image));
      if (digest(image) !== entry.digest)
        throw new VisualError("CANDIDATE_CHANGED", "Candidate image digest changed");
      if (
        (await fileDigest(target)) !== entry.originalDigest ||
        (await fileDigest(`${target}.manifest.json`)) !== entry.originalManifestDigest
      )
        throw new VisualError(
          "BASELINE_CHANGED",
          "Original baseline or manifest changed since preparation",
        );
      const ignored = await execFileAsync(
        "git",
        ["check-ignore", "--", entry.target, `${entry.target}.manifest.json`],
        { cwd: project, timeoutMs: 5000 },
      );
      if (ignored.status === 0)
        throw new VisualError(
          "BASELINE_IGNORED",
          "Baseline target is ignored by Git; review ignore rules explicitly",
        );
      loaded.push({ target, image, entry });
    }
    if (args.taskId) {
      const task = JSON.parse(
        await fs.readFile(path.join(home, "tasks", args.taskId, "task.json"), "utf8"),
      ) as { projectPath: string; status: string };
      if ((await fs.realpath(task.projectPath)) !== project || task.status !== "needs_attention")
        throw new VisualError(
          "TASK_NOT_BLOCKED",
          "Task must be blocked in this candidate's project",
        );
    }
    const approvedAt = new Date().toISOString();
    // Readers hold the same project lock. Each file replacement is atomic; snapshot detects interrupted pairs.
    for (const { target, image, entry } of loaded) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, image, { flag: "wx" });
        await fs.rename(temp, target);
      } finally {
        await fs.rm(temp, { force: true });
      }
      await writeJsonAtomic(`${target}.manifest.json`, {
        ...entry.manifest,
        approval: {
          note: args.approvalNote,
          at: approvedAt,
          candidateId: candidate.id,
          candidateDigest: args.expectedDigest,
        },
      });
    }
    if (args.taskId) {
      await writeJsonAtomic(path.join(home, "tasks", args.taskId, "visual-snapshot.json"), {
        ...(await captureVisualSnapshot(project)),
        approved: { note: args.approvalNote, at: approvedAt, previousDigest: current.configDigest },
      });
    }
    await writeJsonAtomic(path.join(directory, "approval.json"), {
      note: args.approvalNote,
      at: approvedAt,
      candidateDigest: args.expectedDigest,
      taskId: args.taskId,
    });
    return { approvedAt, targets: loaded.map((e) => e.target) };
  });
}
