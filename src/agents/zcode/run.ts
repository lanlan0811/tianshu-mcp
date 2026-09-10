import fs from "node:fs";
import path from "node:path";
import type {
  AgentRunLogger,
  AgentRunOptions,
  AgentRunResult,
  ResolvedAgent,
  TaskContext,
} from "../adapter.js";
import type { GuiProfile } from "../../config/schema.js";
import { mkdirp } from "../../util/fs.js";
import { parseZcodeModel, exactUiName } from "./model.js";
import { validateTaskReferences } from "./references.js";
import { matchZcodeProject, normalizeProjectPath } from "./project.js";
import { judgeZcodePoll, type ZcodePollState } from "./liveness.js";
import { ZcodeCdpClient, CdpDisconnectedError, CdpUnavailableError } from "./cdp.js";
import { ensureZcodeInstance, listZcodeProcesses, type ZcodeReady } from "./instance.js";
import { listOwnedDialogs, selectZcodeFolder } from "./dialog.js";

export interface RunZcodeArgs {
  ctx: TaskContext;
  resolved: ResolvedAgent;
  opts: AgentRunOptions;
  logFile: string;
  deps?: Partial<ZcodeRunDeps>;
}
export interface ZcodeRunDeps {
  ensureInstance: typeof ensureZcodeInstance;
  createClient: (
    port: number,
    timeout: number,
    selectors: Record<string, string>,
  ) => ZcodeCdpClient;
  listDialogs: typeof listOwnedDialogs;
  selectFolder: typeof selectZcodeFolder;
  sleep: (ms: number) => Promise<void>;
}
const DEFAULT_DEPS: ZcodeRunDeps = {
  ensureInstance: ensureZcodeInstance,
  createClient: (p, t, s) => new ZcodeCdpClient(p, t, s),
  listDialogs: listOwnedDialogs,
  selectFolder: selectZcodeFolder,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

function guiOf(resolved: ResolvedAgent): GuiProfile {
  const g = resolved.profile.gui;
  return {
    cdpPort: g?.cdpPort ?? 9333,
    cdpPortAuto: g?.cdpPortAuto ?? true,
    cdpPortRange: g?.cdpPortRange ?? 30,
    exePath: g?.exePath,
    exeArgs: g?.exeArgs ?? ["--remote-debugging-port=<port>"],
    windowMode: g?.windowMode ?? "reuse",
    launchTimeoutMs: g?.launchTimeoutMs ?? 60_000,
    pollIntervalMs: g?.pollIntervalMs ?? 3_000,
    stableRounds: g?.stableRounds ?? 4,
    idleTimeoutMs: g?.idleTimeoutMs ?? 600_000,
    cdpSendTimeoutMs: g?.cdpSendTimeoutMs ?? 15_000,
    progressIntervalMs: g?.progressIntervalMs ?? 30_000,
    modelSwitch: g?.modelSwitch ?? true,
    modeSwitch: false,
    freshSession: g?.freshSession ?? true,
    selectors: g?.selectors ?? {},
    modelRequired: g?.modelRequired ?? true,
    defaultPermissionMode: g?.defaultPermissionMode ?? "完全访问",
    defaultAutoFixRounds: g?.defaultAutoFixRounds ?? 2,
  };
}

function fileLogger(
  file: string,
  base: AgentRunLogger,
): { logger: AgentRunLogger; close: () => Promise<void> } {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stream = fs.createWriteStream(file, { flags: "a", encoding: "utf8" });
  stream.write(`\n===== zcode-gui run @ ${new Date().toISOString()} =====\n`);
  const wrap = (level: string) => (m: string) => {
    stream.write(`[${level}] ${m}\n`);
    base[level as "info"](m);
  };
  return {
    logger: { info: wrap("info"), warn: wrap("warn"), error: wrap("error"), debug: wrap("debug") },
    close: () => new Promise((r) => stream.end(r)),
  };
}

function prompt(ctx: TaskContext, refs: ReturnType<typeof validateTaskReferences>): string {
  let out =
    ctx.resume?.kind === "continue" && ctx.resume.sendMessage
      ? (ctx.resume.message ?? "")
      : ctx.task;
  if (ctx.context?.trim() && !ctx.resume) out += `\n\n【上下文与约束】\n${ctx.context}`;
  if (refs.length && !ctx.resume)
    out += `\n\n【已验证项目引用】\n${refs.map((r) => `- ${r.directory ? "目录" : "文件"}: ${r.source} => ${r.absolutePath}`).join("\n")}`;
  if (ctx.feedback?.trim()) out += `\n\n【自动验收返修】\n${ctx.feedback}`;
  return out;
}

async function waitBound(
  cdp: ZcodeCdpClient,
  target: string,
  deps: ZcodeRunDeps,
): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    const p = await cdp.boundProjectPath();
    if (p && normalizeProjectPath(p) === normalizeProjectPath(target)) return true;
    await deps.sleep(300);
  }
  return false;
}

export async function runZcodeTask(args: RunZcodeArgs): Promise<AgentRunResult> {
  const started = Date.now(),
    { ctx, resolved, opts, logFile } = args,
    deps = { ...DEFAULT_DEPS, ...args.deps };
  const gui = guiOf(resolved);
  const { logger, close } = fileLogger(logFile, opts.logger);
  let cdp: ZcodeCdpClient | undefined;
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
  try {
    await mkdirp(path.dirname(logFile));
    const spec = parseZcodeModel(ctx.model);
    const refs = validateTaskReferences(ctx.task, ctx.context, ctx.projectPath);
    if (!resolved.command)
      return result({
        hardFailure: true,
        error: "未找到 ZCode 可执行文件",
        endReason: "setup_failed",
      });
    const inst = await deps.ensureInstance(resolved.command, gui, logger);
    if (inst.needsClose)
      return result({
        endReason: "needs_user",
        needsUserKind: "close_existing_instance",
        pendingQuestion:
          "检测到未开启 CDP 的 ZCode 实例。请保存工作并手动关闭所有 ZCode 窗口，然后调用 continue_task 确认。",
        progressSummary: "等待用户关闭既有 ZCode 实例",
      });
    if (!inst.ready)
      return result({ hardFailure: true, error: "ZCode 实例未就绪", endReason: "setup_failed" });
    const ready: ZcodeReady = inst.ready;
    cdp = deps.createClient(ready.port, gui.cdpSendTimeoutMs, gui.selectors);
    await cdp.connect();
    if (await cdp.exists("loginPage"))
      return result({
        endReason: "needs_user",
        needsUserKind: "login_required",
        pendingQuestion: "请在 ZCode 窗口中完成登录或引导，然后调用 continue_task 确认。",
        session: {
          boundProjectPath: ctx.projectPath,
          provider: spec.provider,
          model: spec.model,
          permissionMode: gui.defaultPermissionMode,
        },
      });

    if (ctx.resume?.sendMessage || ctx.resume?.sessionId || ctx.resume?.sessionTitle) {
      if (!ctx.resume.sessionId && !ctx.resume.sessionTitle)
        return result({
          hardFailure: true,
          error: "缺少原 ZCode 会话定位信息，拒绝打开最近会话",
          endReason: "session_lost",
        });
      if (!(await cdp.selectSession(ctx.resume.sessionId, ctx.resume.sessionTitle)))
        return result({
          hardFailure: true,
          error: "无法唯一定位原 ZCode 会话，已 fail-closed",
          endReason: "session_lost",
        });
    } else if (gui.freshSession && !(await cdp.click("newTask")))
      return result({
        hardFailure: true,
        error: "无法创建新的 ZCode 任务会话",
        endReason: "setup_failed",
      });
    await deps.sleep(500);

    if (!(await cdp.click("projectTrigger")))
      return result({
        hardFailure: true,
        error: "无法打开 ZCode 项目列表",
        endReason: "setup_failed",
      });
    await deps.sleep(300);
    const items = await cdp.projects();
    const matched = matchZcodeProject(items, ctx.projectPath);
    if (matched.ambiguous)
      return result({
        hardFailure: true,
        error: `项目同名或路径重复，无法消歧：${ctx.projectPath}`,
        endReason: "project_ambiguous",
      });
    if (matched.item) {
      if (!(await cdp.clickProject(matched.item.id, matched.item.path)))
        return result({
          hardFailure: true,
          error: "精确项目项点击失败",
          endReason: "setup_failed",
        });
    } else {
      const pids = listZcodeProcesses().map((p) => p.pid);
      const before = await deps.listDialogs(pids);
      if (!(await cdp.click("chooseFolder")))
        return result({
          hardFailure: true,
          error: "找不到 ZCode 选择文件夹入口",
          endReason: "setup_failed",
        });
      const selected = await deps.selectFolder(ctx.projectPath, pids, before);
      if (!selected.ok)
        return result({
          endReason: selected.needsPermission ? "needs_user" : "setup_failed",
          needsUserKind: selected.needsPermission ? "system_permission" : undefined,
          pendingQuestion: selected.needsPermission
            ? "请为 ZCode/System Events 授予 Accessibility 权限后调用 continue_task 确认。"
            : undefined,
          error: selected.needsPermission ? undefined : selected.message,
          hardFailure: !selected.needsPermission,
        });
    }
    if (!(await waitBound(cdp, ctx.projectPath, deps)))
      return result({
        hardFailure: true,
        error: "ZCode 项目绑定回读与 projectPath 不一致",
        endReason: "project_mismatch",
      });

    if (!(await cdp.click("modelTrigger")))
      return result({
        hardFailure: true,
        error: "无法打开 ZCode 模型菜单",
        endReason: "setup_failed",
      });
    await deps.sleep(250);
    const provider = await cdp.clickExact("providerOption", spec.provider);
    if (!provider.clicked)
      return result({
        hardFailure: true,
        error: `供应商不存在或同名歧义：${spec.provider}（匹配 ${provider.count}）`,
        endReason: "model_unavailable",
      });
    await deps.sleep(250);
    const model = await cdp.clickExact("modelOption", spec.model);
    if (!model.clicked)
      return result({
        hardFailure: true,
        error: `模型不存在或同名歧义：${spec.provider}/${spec.model}（匹配 ${model.count}）`,
        endReason: "model_unavailable",
      });
    await deps.sleep(300);
    const modelValue = await cdp.text("modelValue");
    if (
      !exactUiName(modelValue, spec.model) &&
      !exactUiName(modelValue, `${spec.provider}/${spec.model}`)
    )
      return result({
        hardFailure: true,
        error: `模型切换回读不一致：${modelValue}`,
        endReason: "model_mismatch",
      });
    const permission = gui.defaultPermissionMode ?? "完全访问";
    if (!(await cdp.click("permissionTrigger")))
      return result({
        hardFailure: true,
        error: "无法打开 ZCode 权限菜单",
        endReason: "permission_unknown",
      });
    const perm = await cdp.clickExact("permissionOption", permission);
    if (!perm.clicked)
      return result({
        hardFailure: true,
        error: `无法唯一选择权限模式：${permission}`,
        endReason: "permission_unknown",
      });
    await deps.sleep(250);
    if (!exactUiName(await cdp.text("permissionValue"), permission))
      return result({
        hardFailure: true,
        error: "权限模式回读不是完全访问",
        endReason: "permission_unknown",
      });

    const session = await cdp.session();
    const message = prompt(ctx, refs);
    {
      if (ctx.resume?.kind === "continue" && !ctx.resume.sendMessage) {
        logger.info("[zcode] 用户确认文本不发送给模型；环境复检通过后发送原始任务书");
      }
      const marker = `【tianshu:${ctx.taskId}:r${ctx.round}】`;
      const before = await cdp.conversationText();
      await cdp.typeText(marker + message);
      const typed = await cdp.inputText();
      if (!typed.includes(marker))
        return result({
          hardFailure: true,
          error: "ZCode 输入框回读不一致，未发送",
          endReason: "input_mismatch",
        });
      await cdp.sendMessage();
      await deps.sleep(500);
      const after = await cdp.conversationText();
      const polled = await cdp.poll();
      if (!after.includes(marker) && !polled.stopVisible && !polled.loading && !polled.activeTool) {
        if (before.includes(marker)) logger.info("[zcode] 会话已存在同一消息，避免重复发送");
        else
          return result({
            hardFailure: true,
            error: "发送结果无法确认，未观察到用户消息或运行信号",
            endReason: "send_unknown",
          });
      }
    }

    const deadline = started + ctx.taskTimeoutMs;
    let state: ZcodePollState = { hash: "", stable: 0, idleSince: 0 },
      lastProgress = 0;
    for (;;) {
      if (opts.signal?.aborted) return result({ killed: true, endReason: "aborted" });
      if (Date.now() >= deadline)
        return result({
          timeout: true,
          endReason: "task_timeout",
          error: "ZCode 任务总时限已到；已停止 MCP 等待并保留 ZCode 现场",
        });
      await deps.sleep(gui.pollIntervalMs);
      const poll = await cdp.poll();
      const verdict = judgeZcodePoll(poll, state, gui.stableRounds, gui.idleTimeoutMs);
      state = verdict.state;
      if (Date.now() - lastProgress >= gui.progressIntervalMs) {
        const note = `ZCode 进度：${verdict.kind}；运行证据=${verdict.evidence}；回复哈希=${state.hash}；稳定轮=${state.stable}`;
        await Promise.resolve(opts.onProgress?.(note)).catch(() => {});
        logger.info(note);
        lastProgress = Date.now();
      }
      if (verdict.kind === "needs_user")
        return result({
          endReason: "needs_user",
          needsUserKind: "agent_question",
          pendingQuestion: verdict.question,
          session: {
            id: session.id,
            title: session.title,
            boundProjectPath: ctx.projectPath,
            provider: spec.provider,
            model: spec.model,
            permissionMode: permission,
          },
          progressSummary: "ZCode 等待用户回答",
        });
      if (verdict.kind === "idle_timeout")
        return result({
          endReason: "idle_timeout",
          error: "ZCode 空闲超时；已停止 MCP 等待并保留现场",
        });
      if (verdict.kind === "finished")
        return {
          ok: true,
          exitCode: 0,
          timeout: false,
          killed: false,
          durationMs: Date.now() - started,
          logFile,
          endReason: "reply_stable",
          keptInstance: true,
          session: {
            id: session.id,
            title: session.title,
            boundProjectPath: ctx.projectPath,
            provider: spec.provider,
            model: spec.model,
            permissionMode: permission,
          },
          progressSummary: "ZCode 已完成回复",
        };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof CdpDisconnectedError || e instanceof CdpUnavailableError)
      return result({ hardFailure: true, error: msg, endReason: "cdp_disconnected" });
    return result({ hardFailure: true, error: msg, endReason: "internal" });
  } finally {
    cdp?.disconnect();
    await close();
  }
}
