/**
 * Open Design 任务的执行面（P0：接管与只读盘点；P1 起逐步补齐 12 步流程）。
 *
 * **为什么 P0 明确硬失败而不是「假装成功」**：`run_task` 一旦返回 ok，编排器就会进入
 * 验收与返修记账——一个还没真正派活却报成功的结果，比一条清晰的「尚未实现」错误危险得多。
 * 所以本文件当前阶段：接管实例 → 校验版本 → 只读盘点页面 → 硬失败并如实说明缺什么。
 */
import fs from "node:fs";
import path from "node:path";
import type {
  AgentRunOptions,
  AgentRunLogger,
  AgentRunResult,
  ResolvedAgent,
  TaskContext,
} from "../adapter.js";
import type { GuiProfile, OpenDesignProfile } from "../../config/schema.js";
import { OPEN_DESIGN_DEFAULTS, ZCODE_SETUP_DEFAULTS } from "../../config/schema.js";
import {
  ensureOpenDesignInstance,
  probeOpenDesignPort,
  readAppConfig,
  versionGateError,
  type OpenDesignReady,
} from "./instance.js";
import { readInstallInfo, openDesignNamespaceRoot, openDesignAppConfigPath } from "./discovery.js";
import { createOpenDesignPageClient, probeLayout, type OpenDesignDocumentProbe } from "./cdp.js";
import { missingSelectorKeys, OPEN_DESIGN_LAYOUT_GUARD_KEYS } from "./selectors.js";
import { normalizeOpenDesignDirection, directionLabel } from "./model.js";
import type { KimicodePageClient } from "../kimicode/cdp.js";

export interface RunOpenDesignArgs {
  ctx: TaskContext;
  resolved: ResolvedAgent;
  opts: AgentRunOptions;
  logFile: string;
  deps?: Partial<OpenDesignRunDeps>;
}

export interface OpenDesignRunDeps {
  ensureInstance: typeof ensureOpenDesignInstance;
  createPageClient: (port: number, sendTimeoutMs: number) => KimicodePageClient;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_DEPS: OpenDesignRunDeps = {
  ensureInstance: ensureOpenDesignInstance,
  createPageClient: (port, sendTimeoutMs) =>
    createOpenDesignPageClient("main", port, sendTimeoutMs),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** profile 缺省值兜底（与 kimicodeGuiOf 同构：profile 是数据，默认值只在读取点提供） */
export function openDesignGuiOf(resolved: ResolvedAgent): GuiProfile {
  const g = resolved.profile.gui;
  return {
    setupRecoveryTimeoutMs:
      g?.setupRecoveryTimeoutMs ?? ZCODE_SETUP_DEFAULTS.setupRecoveryTimeoutMs,
    projectTriggerTimeoutMs:
      g?.projectTriggerTimeoutMs ?? ZCODE_SETUP_DEFAULTS.projectTriggerTimeoutMs,
    workspaceTriggerTimeoutMs: g?.workspaceTriggerTimeoutMs,
    dialogProbeTimeoutMs: g?.dialogProbeTimeoutMs ?? ZCODE_SETUP_DEFAULTS.dialogProbeTimeoutMs,
    dialogOperationTimeoutMs:
      g?.dialogOperationTimeoutMs ?? ZCODE_SETUP_DEFAULTS.dialogOperationTimeoutMs,
    setupRecoveryMaxRetries:
      g?.setupRecoveryMaxRetries ?? ZCODE_SETUP_DEFAULTS.setupRecoveryMaxRetries,
    cdpPort: g?.cdpPort ?? 9889,
    cdpPortAuto: g?.cdpPortAuto ?? true,
    cdpPortRange: g?.cdpPortRange ?? 10,
    exePath: g?.exePath,
    exeArgs: g?.exeArgs ?? ["--remote-debugging-port=<port>"],
    windowMode: g?.windowMode ?? "reuse",
    launchTimeoutMs: g?.launchTimeoutMs ?? 90_000,
    pollIntervalMs: g?.pollIntervalMs ?? 3_000,
    stableRounds: g?.stableRounds ?? 4,
    idleTimeoutMs: g?.idleTimeoutMs ?? 600_000,
    stallTimeoutMs: g?.stallTimeoutMs ?? 300_000,
    cancelWaitMs: g?.cancelWaitMs ?? 15_000,
    cdpSendTimeoutMs: g?.cdpSendTimeoutMs ?? 15_000,
    progressIntervalMs: g?.progressIntervalMs ?? 30_000,
    modelSwitch: g?.modelSwitch ?? true,
    modeSwitch: g?.modeSwitch ?? true,
    freshSession: g?.freshSession ?? true,
    selectors: g?.selectors ?? {},
    modelRequired: g?.modelRequired ?? true,
    activation: g?.activation ?? "spawn",
    defaultAutoFixRounds: g?.defaultAutoFixRounds ?? 2,
  };
}

/** Open Design 专属配置兜底 */
export function openDesignProfileOf(
  profile: OpenDesignProfile | undefined,
): Required<
  Pick<
    OpenDesignProfile,
    | "supportedVersions"
    | "workingDirPanelTimeoutMs"
    | "nativeDialogTimeoutMs"
    | "modelMenuTimeoutMs"
    | "designSystemTimeoutMs"
    | "designDirectionTimeoutMs"
    | "sendReadyTimeoutMs"
    | "planDir"
    | "directionLabels"
  >
> {
  return {
    supportedVersions: profile?.supportedVersions ?? {},
    workingDirPanelTimeoutMs:
      profile?.workingDirPanelTimeoutMs ?? OPEN_DESIGN_DEFAULTS.workingDirPanelTimeoutMs,
    nativeDialogTimeoutMs:
      profile?.nativeDialogTimeoutMs ?? OPEN_DESIGN_DEFAULTS.nativeDialogTimeoutMs,
    modelMenuTimeoutMs: profile?.modelMenuTimeoutMs ?? OPEN_DESIGN_DEFAULTS.modelMenuTimeoutMs,
    designSystemTimeoutMs:
      profile?.designSystemTimeoutMs ?? OPEN_DESIGN_DEFAULTS.designSystemTimeoutMs,
    designDirectionTimeoutMs:
      profile?.designDirectionTimeoutMs ?? OPEN_DESIGN_DEFAULTS.designDirectionTimeoutMs,
    sendReadyTimeoutMs: profile?.sendReadyTimeoutMs ?? OPEN_DESIGN_DEFAULTS.sendReadyTimeoutMs,
    planDir: profile?.planDir ?? OPEN_DESIGN_DEFAULTS.planDir,
    directionLabels: profile?.directionLabels ?? {},
  };
}

/** 把 adapter 日志同时写进任务日志文件（与 kimi/zcode 同构） */
function fileLogger(
  file: string,
  base: AgentRunLogger,
): { logger: AgentRunLogger; close: () => Promise<void> } {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stream = fs.createWriteStream(file, { flags: "a", encoding: "utf8" });
  stream.write(`\n===== opendesign-gui run @ ${new Date().toISOString()} =====\n`);
  const wrap = (level: string) => (m: string) => {
    stream.write(`[${level}] ${m}\n`);
    base[level as "info"](m);
  };
  return {
    logger: { info: wrap("info"), warn: wrap("warn"), error: wrap("error"), debug: wrap("debug") },
    close: () => new Promise((r) => stream.end(r)),
  };
}

export async function runOpenDesignTask(args: RunOpenDesignArgs): Promise<AgentRunResult> {
  const started = Date.now();
  const { ctx, resolved, opts, logFile } = args;
  const deps: OpenDesignRunDeps = { ...DEFAULT_DEPS, ...args.deps };
  const gui = openDesignGuiOf(resolved);
  const od = openDesignProfileOf(resolved.profile.opendesign);
  const { logger, close } = fileLogger(logFile, opts.logger);
  let client: KimicodePageClient | undefined;
  const result = (extra: Partial<AgentRunResult>): AgentRunResult => ({
    ok: false,
    exitCode: null,
    timeout: false,
    killed: false,
    durationMs: Date.now() - started,
    logFile,
    keptInstance: true,
    ...extra,
  });
  const hardFail = (error: string, endReason: string): AgentRunResult =>
    result({ hardFailure: true, error, endReason });

  try {
    // ---- 入口校验：能在参数层判定的，绝不拖到 GUI 里才发现 ----
    const direction = normalizeOpenDesignDirection(ctx.designDirection);
    if (!direction.ok) return hardFail(direction.error, "setup_failed");
    if (ctx.resume === undefined && ctx.round === 0 && !ctx.task.trim())
      return hardFail("Open Design 任务书（task）不能为空", "setup_failed");
    if (!resolved.command) return hardFail("未找到 Open Design 可执行文件", "setup_failed");

    // ---- 步 1-2：接管或启动实例 ----
    const inst: { ready?: OpenDesignReady; needsClose?: boolean } = await deps.ensureInstance(
      resolved.command,
      gui,
      logger,
      { signal: opts.signal },
    );
    if (inst.needsClose) {
      return result({
        needsUserKind: "close_existing_instance",
        endReason: "needs_user",
        pendingQuestion:
          "检测到本机已有 Open Design 实例在运行，但它没有开启 CDP 调试端口，无法接管。" +
          "请先手动关闭该 Open Design 窗口（不要 kill 其他无关进程），然后调用 continue_task 继续。",
        progressSummary: "Open Design 已在运行但未开启调试端口，等待用户关闭后重试",
      });
    }
    const ready = inst.ready!;
    logger.info(`[opendesign] 已接管实例：port=${ready.port} title=${ready.title ?? "(未知)"}`);

    // ---- 版本门禁（fail-closed）：只对接已真机验证的版本 ----
    // 判据用**产品版本**（安装目录 resources/open-design-config.json 的 appVersion）；
    // CDP /json/version 的 Browser 是 Electron 版本（实测 Electron/41.3.0），只能作诊断信息。
    const probe = await probeOpenDesignPort(ready.port);
    const info = readInstallInfo(resolved.command);
    const namespaceRoot = info ? openDesignNamespaceRoot(info) : null;
    const appConfigPath = openDesignAppConfigPath(namespaceRoot);
    const appConfig = readAppConfig(namespaceRoot);
    logger.info(
      `[opendesign] 安装信息：appVersion=${info?.appVersion ?? "?"} namespace=${info?.namespace ?? "?"}` +
        ` electron=${probe.version ?? "?"}` +
        ` appConfig=${appConfigPath ?? "(不可定位)"}` +
        `${appConfig ? ` recentLinkedDirs=${JSON.stringify(appConfig.recentLinkedDirs ?? [])}` : ""}`,
    );
    const gate = versionGateError(od.supportedVersions, info?.appVersion);
    if (gate) return hardFail(gate, "version_mismatch");

    // ---- 只读盘点页面：布局守卫（不点任何东西） ----
    client = deps.createPageClient(ready.port, gui.cdpSendTimeoutMs);
    await client.connect();
    let document: OpenDesignDocumentProbe | undefined;
    try {
      document = await probeLayout(client, gui.selectors);
    } catch (error) {
      logger.warn(`[opendesign] 页面盘点失败：${String(error)}`);
    }
    logger.info(
      `[opendesign] 页面盘点：${document ? `${document.title} ${document.url}` : "(失败)"}`,
    );

    // ---- 设计方向与目标模型（进入 GUI 前先如实记录，便于终态文案） ----
    logger.info(
      `[opendesign] 设计方向=${direction.direction}（菜单文本「${directionLabel(direction.direction, od.directionLabels)}」）` +
        ` 模型=${ctx.model ?? "(沿用当前)"} 设计系统=${ctx.designSystem ?? "(不指定)"}`,
    );

    // ---- 门禁 1：选择器是否已采集（缺键绝不点坐标） ----
    const missing = missingSelectorKeys(gui.selectors);
    if (missing.length) {
      return hardFail(
        `Open Design 适配器尚未完成界面驱动（缺少关键选择器：${missing.join(", ")}，共 ${missing.length} 个）。` +
          `请先关闭 Open Design 并执行 \`npm run probe:opendesign -- anchors --launch\` 采集锚点，` +
          `再把稳定选择器写入 src/agents/opendesign/selectors.ts（或在 profile.gui.selectors 里按语义键覆盖）。` +
          `判据见 .dsh/plans/opendesign-gui-adapter-plan.md 的 P1 阶段。` +
          `本轮只完成了实例接管与页面盘点（${document ? `页面标题「${document.title}」` : "页面盘点失败"}）。`,
        "selector_drift",
      );
    }

    // ---- 门禁 2：选择器有值但页面锚点全缺 = UI 漂移，同样不进点击 ----
    if (document) {
      const dead = document.anchors.filter((a) => a.count <= 0).map((a) => a.key);
      if (dead.length) {
        logger.warn(`[opendesign] 布局守卫未命中：${dead.join(", ")}`);
        return hardFail(
          `Open Design 页面结构已漂移（布局守卫未命中：${dead.join(", ")}）；` +
            `已跳过全部点击。请用 \`npm run probe:opendesign -- anchors\` 重新采集选择器。` +
            `当前页面：${document.title} ${document.url}（可见文本 ${document.bodyTextLength} 字）`,
          "selector_drift",
        );
      }
      const guard = OPEN_DESIGN_LAYOUT_GUARD_KEYS.length;
      logger.info(`[opendesign] 布局守卫 ${guard - dead.length}/${guard} 通过`);
    }

    // 后续阶段（P2~P6）在此接入：目录绑定 → 模型 → 设计系统 → 设计方向 → 输入发送 → 运行检测。
    return hardFail(
      "Open Design 界面驱动尚未实现（P2 起：目录绑定 / 模型 / 设计系统 / 方向 / 输入发送 / 运行检测）",
      "not_implemented",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[opendesign] 执行失败：${message}`);
    return hardFail(message, "setup_failed");
  } finally {
    try {
      client?.disconnect();
    } catch {
      /* 断开失败不影响终态 */
    }
    await close();
  }
}

/** 供 probe 脚本复用的实例就绪探测（不带 Tauri/Electron 语义，仅端口 + 产品校验） */
export async function probeReady(port: number): Promise<boolean> {
  const r = await probeOpenDesignPort(port);
  return r.ready;
}
