import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
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

async function clickExactWhenReady(
  cdp: ZcodeCdpClient,
  key: "providerOption" | "modelOption" | "permissionOption",
  value: string,
  deps: ZcodeRunDeps,
): ReturnType<ZcodeCdpClient["clickExact"]> {
  let last = { clicked: false, count: 0, available: [] as string[] };
  for (let i = 0; i < 15; i++) {
    // eslint-disable-next-line no-await-in-loop
    last = await cdp.clickExact(key, value);
    if (last.clicked || last.count > 1) return last;
    // eslint-disable-next-line no-await-in-loop
    await deps.sleep(200);
  }
  return last;
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

    const sessionsBefore = ctx.resume ? [] : await cdp.sessions();

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
    const activeSession = ctx.resume
      ? { id: ctx.resume.sessionId, title: ctx.resume.sessionTitle }
      : await cdp.session();

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
      if (!(await waitBound(cdp, ctx.projectPath, deps))) {
        // ZCode may ignore a menu click while its workspace list is still
        // animating. Retrying this pre-send, idempotent binding is safe.
        if (!(await cdp.click("projectTrigger")))
          return result({
            hardFailure: true,
            error: "项目首次绑定未生效，且无法重新打开项目列表",
            endReason: "project_mismatch",
          });
        await deps.sleep(300);
        const retried = matchZcodeProject(await cdp.projects(), ctx.projectPath);
        if (
          retried.ambiguous ||
          !retried.item ||
          !(await cdp.clickProject(retried.item.id, retried.item.path))
        )
          return result({
            hardFailure: true,
            error: "项目首次绑定未生效，重试时无法唯一选择目标项目",
            endReason: "project_mismatch",
          });
      }
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
          session: selected.needsPermission
            ? {
                id: activeSession.id,
                title: activeSession.title,
                boundProjectPath: ctx.projectPath,
                provider: spec.provider,
                model: spec.model,
                permissionMode: gui.defaultPermissionMode,
              }
            : undefined,
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
    const provider = await clickExactWhenReady(cdp, "providerOption", spec.provider, deps);
    if (!provider.clicked)
      return result({
        hardFailure: true,
        error: `供应商不存在或同名歧义：${spec.provider}（匹配 ${provider.count}${provider.available?.length ? `；可见候选=${provider.available.slice(0, 20).join("、")}` : ""}）`,
        endReason: "model_unavailable",
      });
    await deps.sleep(250);
    const model = await clickExactWhenReady(cdp, "modelOption", spec.model, deps);
    if (!model.clicked)
      return result({
        hardFailure: true,
        error: `模型不存在或同名歧义：${spec.provider}/${spec.model}（匹配 ${model.count}${model.available?.length ? `；可见候选=${model.available.slice(0, 20).join("、")}` : ""}）`,
        endReason: "model_unavailable",
      });
    await deps.sleep(300);
    const modelValue = await cdp.selection("modelValue");
    const displayMatches =
      exactUiName(modelValue.display, spec.model) ||
      exactUiName(modelValue.display, `${spec.provider}/${spec.model}`);
    const internalMatches = exactUiName(modelValue.internal, spec.model);
    if (!displayMatches || !internalMatches)
      return result({
        hardFailure: true,
        error: `模型切换回读不一致：display=${modelValue.display || "空"}，internal=${modelValue.internal || "空"}`,
        endReason: "model_mismatch",
      });
    const permission = gui.defaultPermissionMode ?? "完全访问";
    if (!(await cdp.click("permissionTrigger")))
      return result({
        hardFailure: true,
        error: "无法打开 ZCode 权限菜单",
        endReason: "permission_unknown",
      });
    const perm = await clickExactWhenReady(cdp, "permissionOption", permission, deps);
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

    let session = activeSession;
    const message = prompt(ctx, refs);
    {
      if (ctx.resume?.kind === "continue" && !ctx.resume.sendMessage) {
        logger.info("[zcode] 用户确认文本不发送给模型；环境复检通过后发送原始任务书");
      }
      const attempt =
        ctx.resume?.kind === "continue"
          ? `continue:${createHash("sha256")
              .update(ctx.resume.message ?? "confirmed")
              .digest("hex")
              .slice(0, 8)}`
          : (ctx.resume?.kind ?? "initial");
      const marker = `【tianshu:${ctx.taskId}:r${ctx.round}:${attempt}】`;
      const before = await cdp.conversationText();
      const beforePoll = await cdp.poll();
      await cdp.typeText(marker + message);
      const typed = await cdp.inputText();
      if (!typed.includes(marker))
        return result({
          hardFailure: true,
          error: "ZCode 输入框回读不一致，未发送",
          endReason: "input_mismatch",
        });
      await cdp.sendMessage();
      let seenMessage = before.includes(marker);
      let seenStateChange = false;
      let seenRunning = false;
      let markedSession: Awaited<ReturnType<ZcodeCdpClient["sessionForMarker"]>> = undefined;
      for (let i = 0; i < 20 && !(seenMessage && (seenStateChange || seenRunning || markedSession)); i++) {
        // eslint-disable-next-line no-await-in-loop
        await deps.sleep(250);
        // eslint-disable-next-line no-await-in-loop
        const [after, input, polled] = await Promise.all([
          cdp.conversationText(),
          cdp.inputText(),
          cdp.poll(),
        ]);
        seenMessage ||= after.includes(marker);
        seenStateChange ||= !input.includes(marker);
        seenRunning ||= polled.stopVisible || polled.loading || polled.activeTool;
        if (polled.assistantText && polled.assistantText !== beforePoll.assistantText)
          seenRunning = true;
        // eslint-disable-next-line no-await-in-loop
        markedSession ||= await cdp.sessionForMarker(marker);
      }
      if (!(seenMessage && (seenStateChange || seenRunning || markedSession))) {
        return result({
          hardFailure: true,
          error: `发送结果无法确认（用户消息=${seenMessage}，输入状态变化=${seenStateChange}，运行信号=${seenRunning}，标记会话=${!!markedSession}）；不重复发送`,
          endReason: "send_unknown",
        });
      }
      if (markedSession) session = markedSession;
      if (!ctx.resume) {
        const previousIds = new Set(sessionsBefore.map((item) => item.id));
        let added: Awaited<ReturnType<ZcodeCdpClient["sessions"]>> = [];
        for (let i = 0; i < 20; i++) {
          // eslint-disable-next-line no-await-in-loop
          const current = await cdp.sessions();
          added = current.filter((item) => !previousIds.has(item.id));
          if (added.length === 1) break;
          // eslint-disable-next-line no-await-in-loop
          await deps.sleep(250);
        }
        if (!session.id && added.length === 1) session = added[0]!;
        else if (!session.id) {
          const current = await cdp.session();
          if (current.id) session = current;
        }
      }
      if (!session.id)
        return result({
          hardFailure: true,
          error: "任务已发送，但无法唯一取得 ZCode 新会话 ID；已保留现场且不会重复发送",
          endReason: "session_lost",
        });
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
