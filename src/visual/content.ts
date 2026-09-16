/**
 * 内容校验单项编排（issue #13 计划 §5 C 组）：
 * 路径闸门与图片解码复用校验 → 查缓存 → 逐次采样调用用户自备命令 → 多数票汇总 → 组装 VisualResult。
 * 判定委托用户命令（凭证零管理红线）；采样在单项内串行，项间仍受 limits.concurrency 约束。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { VisualError, visualError } from "./errors.js";
import { decodeImage } from "./images.js";
import { projectFile } from "./paths.js";
import { digest } from "./lock.js";
import {
  parseVerdictLine,
  prepareCommandArgs,
  resolveCommandIdentity,
  resolveCommandPath,
  resolveContentEnv,
  runContentCommand,
} from "./content-command.js";
import { tallyContentVotes, type ContentTally } from "./content-verdict.js";
import {
  cacheableContentStatus,
  contentCacheKey,
  contentEnvDigest,
  readContentCache,
  writeContentCache,
} from "./content-cache.js";
import type { VisualConfig, VisualContentCheck } from "./schema.js";
import type { ContentConfidenceGate, ContentVote, VisualResult } from "./types.js";
import type { VisualBudget } from "./budget.js";

/** 每条内容检查的有效命令参数（逐规则覆盖优先于全局声明） */
export interface EffectiveContentCommand {
  command: string;
  argsTemplate: string[];
  cwd: string;
  env: Record<string, string>;
  allowRemote: boolean;
  samples: number;
}

export function contentCommandParts(
  config: VisualConfig,
  check: VisualContentCheck,
): EffectiveContentCommand {
  const command = check.command ?? config.content.command;
  const argsTemplate = check.argsTemplate ?? config.content.argsTemplate;
  // 运行期兜底（正常应由 schema 拦截）：启用状态下有效命令/模板缺失不可静默
  if (!command || !argsTemplate)
    throw new VisualError(
      "CONTENT_CONFIG_INVALID",
      "Content checks require an effective command and argsTemplate",
    );
  return {
    command,
    argsTemplate,
    cwd: check.cwd ?? config.content.cwd ?? ".",
    env: check.env ?? config.content.env ?? {},
    allowRemote: check.allowRemote ?? config.content.allowRemote,
    samples: check.samples ?? config.content.samples,
  };
}

export function hasContentRules(config: VisualConfig): boolean {
  return config.contents.length > 0 || config.pages.some((page) => page.content !== undefined);
}

/** 逐条内容规则（contents[] + pages[].content）统一为可枚举形态：预检、doctor、probe 共用 */
export function contentRulesOf(
  config: VisualConfig,
): { label: string; check: VisualContentCheck }[] {
  return [
    ...config.contents.map((rule) => ({ label: rule.id, check: rule as VisualContentCheck })),
    ...config.pages
      .filter((page) => page.content)
      .map((page) => ({ label: `${page.id} (page content)`, check: page.content! })),
  ];
}

/**
 * 内容预检（整轮级，P2/P3 收口）：枚举每条规则的有效 command/argsTemplate/env 逐个校验——
 * 不得只解析全局 command（逐规则命令缺失若仅产出 optional blocked 项会被归口挡掉，
 * 等于「启用了却静默不跑」）。任一失败即抛错，经 acceptance.ts 升级为整轮 configurationError，
 * 不产出任何 VisualResult 行。
 */
export async function assertContentReady(config: VisualConfig, project: string): Promise<void> {
  if (!config.content.enabled || !hasContentRules(config)) return;
  for (const { label, check } of contentRulesOf(config)) {
    const effective = contentCommandParts(config, check);
    const cwd = await projectFile(project, effective.cwd);
    const resolved = await resolveCommandPath(effective.command, cwd);
    if (!resolved)
      throw new VisualError(
        "CONTENT_COMMAND_MISSING",
        `${label}: cannot resolve content judge command '${effective.command}'`,
      );
    resolveContentEnv(effective.env);
  }
}

export interface ContentCheckContext {
  config: VisualConfig;
  project: string;
  /** 任务目录（缓存落 &lt;taskDir&gt;/visual-content-cache） */
  taskDir: string;
  /** 本轮产物目录（证据图落 &lt;artifactDir&gt;/content/...） */
  artifactDir: string;
  budget: VisualBudget;
}

/** 单个内容校验任务：contents[] 规则与页面语义项共用（页面项由 engine 传入截图路径） */
export interface ContentJob {
  id: string;
  /** 项目相对路径（contents）或 route（页面语义项），仅用于报告展示 */
  target: string;
  viewport?: string;
  /** blocking=false 映射为 optional=true：仅告警，不构成门禁 */
  optional: boolean;
  check: VisualContentCheck;
  /** 被检图片绝对路径（已通过 projectFile 闸门或为本轮截图） */
  imagePath: string;
  /** 证据目录：source.png 落此处；一个源文件/截图只落一份（采样共用） */
  evidenceDir: string;
}

export interface ContentSampleInput {
  config: VisualConfig;
  check: VisualContentCheck;
  /** 被检图片绝对路径（已过路径闸门或为本轮截图） */
  imagePath: string;
  /** 已解析的 cwd 绝对路径 */
  cwd: string;
  /** 已解析的子进程环境变量（仅用户声明引用，不含宿主全量） */
  envValues: Record<string, string>;
  budget: VisualBudget;
  /** 临时输入文件目录（调用方负责最终清理） */
  tempDir: string;
}

/**
 * 单项内串行采样（项间由 limits.concurrency 并行）：避免同一命令并发抢占与输出交错，
 * 同时保持单项超时语义线性可解释。命令级失败（非零退出/超时/输出非法）直接抛错，
 * 由调用方判 blocked——不把基础设施故障混进「不确定」。
 */
export async function sampleContentVotes(input: ContentSampleInput): Promise<ContentVote[]> {
  const { config, check, imagePath, cwd, envValues, budget, tempDir } = input;
  const effective = contentCommandParts(config, check);
  const votes: ContentVote[] = [];
  for (let index = 0; index < effective.samples; index++) {
    budget.check();
    const prepared = await prepareCommandArgs({
      argsTemplate: effective.argsTemplate,
      imagePath,
      expect: check.expect,
      tempDir,
    });
    try {
      const outcome = await runContentCommand({
        command: effective.command,
        argv: prepared.argv,
        cwd,
        env: { ...process.env, ...envValues },
        timeoutMs: budget.timeout(config.content.timeoutMs),
        signal: budget.signal,
      });
      if (outcome.aborted)
        throw new VisualError("CANCELLED", "Visual acceptance cancelled", "cancelled");
      if (outcome.timeout)
        throw new VisualError(
          "CONTENT_TIMEOUT",
          `Judge command timed out after ${config.content.timeoutMs}ms`,
        );
      if (outcome.spawnError)
        throw new VisualError(
          "CONTENT_COMMAND_FAILED",
          `Judge command failed to start: ${outcome.spawnError}`,
        );
      if (outcome.exitCode !== 0)
        throw new VisualError(
          "CONTENT_COMMAND_FAILED",
          `Judge command exited with ${outcome.exitCode}: ${outcome.stderr.slice(-2000)}`,
        );
      const verdict = parseVerdictLine(outcome.stdout);
      votes.push({
        index,
        passed: verdict.passed,
        ...(verdict.confidence !== undefined ? { confidence: verdict.confidence } : {}),
        reason: verdict.reason,
      });
    } finally {
      // 易失输入而非证据：每轮采样用完即删，不走 budget.write 记账
      await Promise.allSettled(prepared.tempFiles.map((file) => fs.rm(file, { force: true })));
    }
  }
  return votes;
}

export async function checkContent(
  ctx: ContentCheckContext,
  job: ContentJob,
): Promise<VisualResult> {
  const started = Date.now();
  const { config, budget } = ctx;
  const effective = contentCommandParts(config, job.check);
  const minConfidence = config.content.minConfidence;
  const result: VisualResult = {
    id: job.id,
    kind: "content",
    target: job.target,
    ...(job.viewport !== undefined ? { viewport: job.viewport } : {}),
    optional: job.optional,
    status: "passed",
    code: "CONTENT_MATCH",
    message: "Content matches the declared expectation",
    durationMs: 0,
    repairable: false,
    rules: job.check,
  };
  const fail = (error: VisualError): VisualResult => {
    Object.assign(result, {
      status: error.kind === "cancelled" ? "skipped" : error.kind,
      code: error.code,
      message: error.message,
      repairable: error.kind === "failed",
    });
    result.durationMs = Date.now() - started;
    return result;
  };
  try {
    budget.check();
    const decoded = await decodeImage(job.imagePath, budget);
    const imageSha256 = digest(decoded.input);
    // 证据图：离线报告自包含；走 budget.write 计入 artifactBytes
    const sourcePath = path.join(job.evidenceDir, "source.png");
    await budget.write(sourcePath, decoded.input);
    Object.assign(result, { artifacts: { source: sourcePath } });

    const cwd = await projectFile(ctx.project, effective.cwd);
    const identity = await resolveCommandIdentity(effective.command, effective.argsTemplate, cwd);
    const envValues = resolveContentEnv(effective.env);
    const key = contentCacheKey({
      imageSha256,
      expect: job.check.expect,
      command: effective.command,
      commandPath: identity.commandPath,
      commandDigest: identity.commandDigest,
      argsTemplate: effective.argsTemplate,
      cwd,
      envDigest: contentEnvDigest(envValues),
      allowRemote: effective.allowRemote,
      samples: effective.samples,
      ...(minConfidence !== undefined ? { minConfidence } : {}),
    });
    const detail = {
      provider: effective.command,
      expect: job.check.expect,
      cacheKey: key,
    };

    if (config.content.cache) {
      const cached = await readContentCache(ctx.taskDir, key);
      if (cached) {
        // 命中缓存：不调用命令；票型重放多数票得到与首轮一致的结论
        const tally = tallyContentVotes({
          votes: cached.votes,
          samples: effective.samples,
          ...(minConfidence !== undefined ? { minConfidence } : {}),
        });
        Object.assign(result, {
          status: tally.status,
          code: tally.code,
          message: tally.reason,
          repairable: tally.status === "failed",
          content: {
            ...detail,
            cached: true,
            votes: cached.votes,
            ...(tally.confidence !== undefined ? { confidence: tally.confidence } : {}),
            confidenceGate: tally.confidenceGate,
          },
          metrics: contentMetrics(tally, effective.samples, true),
        });
        result.durationMs = Date.now() - started;
        return result;
      }
    }

    const votes = await sampleContentVotes({
      config,
      check: job.check,
      imagePath: job.imagePath,
      cwd,
      envValues,
      budget,
      tempDir: path.join(job.evidenceDir, "input"),
    });
    const tally = tallyContentVotes({
      votes,
      samples: effective.samples,
      ...(minConfidence !== undefined ? { minConfidence } : {}),
    });
    // 仅成功完成的判定入缓存；命令身份不可靠时不缓存（不固化身份不明的键）
    if (config.content.cache && identity.commandDigest && cacheableContentStatus(tally.status)) {
      await writeContentCache(ctx.taskDir, {
        schemaVersion: 1,
        key,
        imageSha256,
        expectDigest: digest(job.check.expect),
        status: tally.status,
        code: tally.code,
        votes,
        ...(tally.confidence !== undefined ? { confidence: tally.confidence } : {}),
        createdAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      });
    }
    Object.assign(result, {
      status: tally.status,
      code: tally.code,
      message: tally.reason,
      repairable: tally.status === "failed",
      content: {
        ...detail,
        cached: false,
        votes,
        ...(tally.confidence !== undefined ? { confidence: tally.confidence } : {}),
        confidenceGate: tally.confidenceGate,
      },
      metrics: contentMetrics(tally, effective.samples, false),
    });
    result.durationMs = Date.now() - started;
    return result;
  } catch (e) {
    return fail(visualError(e));
  }
}

function contentMetrics(tally: ContentTally, samples: number, cached: boolean) {
  return {
    samples,
    passedVotes: tally.passedVotes,
    failedVotes: tally.failedVotes,
    invalidVotes: tally.invalidVotes,
    confidenceGate: tally.confidenceGate,
    cached,
  };
}

export interface ContentProbeResult {
  id: string;
  target: string;
  viewport?: string;
  /** 有效命令与参数模板（用于用户核对命令契约） */
  provider: string;
  argsTemplate: string[];
  cwd: string;
  allowRemote: boolean;
  samples: number;
  status: VisualResult["status"];
  code: string;
  reason: string;
  confidence?: number;
  confidenceGate?: ContentConfidenceGate;
  votes: ContentVote[];
  durationMs: number;
}

export interface ContentProbeJob {
  id: string;
  target: string;
  viewport?: string;
  check: VisualContentCheck;
  /** 被检图片绝对路径 */
  imagePath: string;
}

/**
 * `visual content probe`（F 组）：按声明规则跑真实判定，但**不写证据、不写缓存**，
 * 供用户先验证自备命令是否可用、判定是否稳定。命令级失败不抛错，以结果码回传便于打印。
 */
export async function probeContent(
  ctx: { config: VisualConfig; project: string; budget: VisualBudget; tempDir: string },
  job: ContentProbeJob,
): Promise<ContentProbeResult> {
  const started = Date.now();
  const { config, budget } = ctx;
  const effective = contentCommandParts(config, job.check);
  const base: ContentProbeResult = {
    id: job.id,
    target: job.target,
    ...(job.viewport !== undefined ? { viewport: job.viewport } : {}),
    provider: effective.command,
    argsTemplate: effective.argsTemplate,
    cwd: effective.cwd,
    allowRemote: effective.allowRemote,
    samples: effective.samples,
    status: "passed",
    code: "CONTENT_MATCH",
    reason: "",
    votes: [],
    durationMs: 0,
  };
  try {
    budget.check();
    const cwd = await projectFile(ctx.project, effective.cwd);
    const envValues = resolveContentEnv(effective.env);
    const votes = await sampleContentVotes({
      config,
      check: job.check,
      imagePath: job.imagePath,
      cwd,
      envValues,
      budget,
      tempDir: path.join(ctx.tempDir, job.id),
    });
    const tally = tallyContentVotes({
      votes,
      samples: effective.samples,
      ...(config.content.minConfidence !== undefined
        ? { minConfidence: config.content.minConfidence }
        : {}),
    });
    Object.assign(base, {
      cwd,
      status: tally.status,
      code: tally.code,
      reason: tally.reason,
      votes,
      confidenceGate: tally.confidenceGate,
      ...(tally.confidence !== undefined ? { confidence: tally.confidence } : {}),
    });
  } catch (e) {
    const error = visualError(e);
    Object.assign(base, {
      status: error.kind === "cancelled" ? "skipped" : error.kind,
      code: error.code,
      reason: error.message,
    });
  }
  base.durationMs = Date.now() - started;
  return base;
}
