/**
 * Codex GUI 任务编排（开发计划 §4，对应需求 9 步）。
 *
 * 流程：定位安装 → 启动受管 GUI（COM 激活 + 专属 profile）→ 绑定/新建项目 →
 * 选模型与思考等级 → 强制权限 → 输入指令 → 发送确认 → 运行检测 →
 * （验收与返修由 fix-loop 驱动，本模块只负责一轮 agent 执行）。
 *
 * 关键约束：
 * - 必须 activation=msix-com + 专属 user-data-dir，否则 CDP 端口不会开启。
 * - 绝不复用用户手动打开的默认 profile 实例（单实例锁会吞掉调试参数）。
 * - 原生文件夹对话框由 dialog.ts 键盘自动化，fail-closed，绝不碰既有窗口。
 */
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
import { parseCodexModel, exactUiName, levelUiTexts, parseTriggerValue } from "./model.js";
import { matchCodexProject, projectBasename } from "./project.js";
import { judgeCodexPoll, initialCodexState, type CodexPoll, type CodexPollState } from "./liveness.js";
import { CodexCdpClient, CdpDisconnectedError, CdpUnavailableError } from "./cdp.js";
import { discoverCodex } from "./discovery.js";
import { ensureCodexInstance, listCodexProcesses, type CodexReady } from "./instance.js";
import { listCodexDialogs, selectCodexFolder, closeStrayDialogs } from "./dialog.js";
import { focusCodexApp } from "./launcher.js";
import { buildInitialPrompt } from "./input.js";
import { validateTaskReferences } from "../zcode/references.js";

export interface RunCodexArgs {
  ctx: TaskContext;
  resolved: ResolvedAgent;
  opts: AgentRunOptions;
  logFile: string;
  deps?: Partial<CodexRunDeps>;
}
export interface CodexRunDeps {
  discover: typeof discoverCodex;
  ensureInstance: typeof ensureCodexInstance;
  listProcesses: typeof listCodexProcesses;
  createClient: (port: number, timeout: number, selectors: Record<string, string>) => CodexCdpClient;
  listDialogs: typeof listCodexDialogs;
  selectFolder: typeof selectCodexFolder;
  closeDialogs: typeof closeStrayDialogs;
  focusApp: typeof focusCodexApp;
  sleep: (ms: number) => Promise<void>;
}
const DEFAULT_DEPS: CodexRunDeps = {
  discover: discoverCodex,
  ensureInstance: ensureCodexInstance,
  listProcesses: listCodexProcesses,
  createClient: (p, t, s) => new CodexCdpClient(p, t, s),
  listDialogs: listCodexDialogs,
  selectFolder: selectCodexFolder,
  closeDialogs: closeStrayDialogs,
  focusApp: focusCodexApp,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** 归一 Codex GUI 配置（默认值集中在此，profile 只给差异） */
export function codexGuiOf(resolved: ResolvedAgent): GuiProfile {
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
    idleTimeoutMs: g?.idleTimeoutMs ?? 10 * 60_000,
    cdpSendTimeoutMs: g?.cdpSendTimeoutMs ?? 15_000,
    progressIntervalMs: g?.progressIntervalMs ?? 30_000,
    modelSwitch: g?.modelSwitch ?? true,
    modeSwitch: false,
    freshSession: g?.freshSession ?? true,
    selectors: g?.selectors ?? {},
    modelRequired: g?.modelRequired ?? true,
    activation: g?.activation ?? "msix-com",
    userDataDir: g?.userDataDir,
    appxPackageName: g?.appxPackageName ?? "OpenAI.Codex",
    permissionMode: g?.permissionMode ?? "完全访问",
    fixPlanDir: g?.fixPlanDir ?? ".zcode/plans",
    defaultPermissionMode: g?.defaultPermissionMode ?? g?.permissionMode ?? "完全访问",
    defaultAutoFixRounds: g?.defaultAutoFixRounds ?? 5,
  };
}

function fileLogger(
  file: string,
  base: AgentRunLogger,
): { logger: AgentRunLogger; close: () => Promise<void> } {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stream = fs.createWriteStream(file, { flags: "a", encoding: "utf8" });
  stream.write(`\n===== codex-gui run @ ${new Date().toISOString()} =====\n`);
  const wrap = (level: string) => (m: string) => {
    stream.write(`[${level}] ${m}\n`);
    base[level as "info"](m);
  };
  return {
    logger: { info: wrap("info"), warn: wrap("warn"), error: wrap("error"), debug: wrap("debug") },
    close: () => new Promise((r) => stream.end(r)),
  };
}

async function connectStableCodex(
  ready: CodexReady,
  gui: GuiProfile,
  deps: CodexRunDeps,
  allowLogin = false,
): Promise<CodexCdpClient> {
  const attempts = Math.max(1, Math.ceil(gui.launchTimeoutMs / 500));
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    const candidate = deps.createClient(ready.port, gui.cdpSendTimeoutMs, gui.selectors);
    try {
      // eslint-disable-next-line no-await-in-loop
      await candidate.connect();
      // 列出的 target 可能属于正在重载的 renderer，要求一次真实 DOM 往返
      // eslint-disable-next-line no-await-in-loop
      if (await candidate.exists("chatInput")) return candidate;
      // eslint-disable-next-line no-await-in-loop
      if (allowLogin && (await candidate.exists("loginIndicator"))) return candidate;
      lastError = new Error("Codex 输入框尚未恢复");
    } catch (error) {
      lastError = error;
    }
    candidate.disconnect();
    // eslint-disable-next-line no-await-in-loop
    await deps.sleep(500);
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Codex CDP 未在 ${gui.launchTimeoutMs}ms 内恢复`);
}

/** 轮询等待某语义键出现（用于对话框/弹层渲染完成） */
async function waitFor(
  cdp: CodexCdpClient,
  key: Parameters<CodexCdpClient["exists"]>[0],
  deps: CodexRunDeps,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await cdp.exists(key)) return true;
    // eslint-disable-next-line no-await-in-loop
    await deps.sleep(300);
  }
  return false;
}

async function waitBound(cdp: CodexCdpClient, target: string, deps: CodexRunDeps): Promise<boolean> {
  const want = projectBasename(target).toLocaleLowerCase();
  for (let i = 0; i < 40; i++) {
    // eslint-disable-next-line no-await-in-loop
    const bound = await cdp.boundProjectName();
    if (bound && bound.toLocaleLowerCase() === want) return true;
    // eslint-disable-next-line no-await-in-loop
    await deps.sleep(300);
  }
  return false;
}

export async function runCodexTask(args: RunCodexArgs): Promise<AgentRunResult> {
  const started = Date.now();
  const { ctx, resolved, opts, logFile } = args;
  const deps = { ...DEFAULT_DEPS, ...args.deps };
  const gui = codexGuiOf(resolved);
  const { logger, close } = fileLogger(logFile, opts.logger);
  let cdp: CodexCdpClient | undefined;
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

    // ---- 步骤 1/2：定位 + 启动受管实例 ----
    const spec = parseCodexModel(ctx.model, ctx.reasoningLevel);
    const found = deps.discover(resolved.profile);
    const exePath = resolved.command || found?.path;
    const aumid = found?.aumid;
    if (!exePath)
      return result({ hardFailure: true, error: "未找到 Codex 安装（Appx 查询与扫盘均失败）", endReason: "setup_failed" });
    if (gui.activation === "msix-com" && !aumid)
      return result({
        hardFailure: true,
        error: "未能解析 Codex AUMID（MSIX 激活必需）；请确认已安装 Codex 桌面端",
        endReason: "setup_failed",
      });
    logger.info(`[codex] 安装：${exePath}；AUMID=${aumid ?? "n/a"}`);

    const inst = await deps.ensureInstance({ path: exePath, aumid }, gui, logger);
    if (!inst.ready)
      return result({ hardFailure: true, error: "Codex 实例未就绪", endReason: "setup_failed" });
    const ready: CodexReady = inst.ready;

    cdp = await connectStableCodex(ready, gui, deps, true);
    logger.info("[codex] CDP 页面与输入状态已稳定");
    if (await cdp.exists("loginIndicator"))
      return result({
        endReason: "needs_user",
        needsUserKind: "login_required",
        pendingQuestion: "请在 Codex 窗口中完成登录或引导，然后调用 continue_task 确认。",
        session: { boundProjectPath: ctx.projectPath, model: spec.model, permissionMode: gui.defaultPermissionMode },
      });

    await cdp.dismissMenus();

    const resuming = Boolean(ctx.resume && (ctx.resume.sessionId || ctx.resume.kind !== undefined));
    const isContinueConfirm = ctx.resume?.kind === "continue" && !ctx.resume.sendMessage;

    // ---- 步骤 3：创建会话 + 绑定/新建项目 ----
    if (!resuming) {
      if (gui.freshSession && !(await cdp.click("newChat")))
        return result({ hardFailure: true, error: "无法点击 Codex「新对话」", endReason: "setup_failed" });
      await deps.sleep(600);

      const items = await cdp.projects();
      const matched = matchCodexProject(items, ctx.projectPath);
      if (matched.ambiguous)
        return result({
          hardFailure: true,
          error: `Codex 项目同名，无法消歧：${projectBasename(ctx.projectPath)}（同名 ${items.filter((i) => i.name.toLocaleLowerCase() === matched.target).length} 个）`,
          endReason: "project_ambiguous",
        });
      if (matched.item) {
        const label = `在 ${matched.item.name} 中开始新聊天`;
        if (!(await cdp.clickByAriaLabel(label))) {
          // 回退：直接点项目项本身
          if (!(await cdp.clickByAriaLabel(matched.item.actionsLabel ?? "")))
            return result({
              hardFailure: true,
              error: `无法点击 Codex 项目项「${matched.item.name}」`,
              endReason: "setup_failed",
            });
        }
        logger.info(`[codex] 已选择既有项目：${matched.item.name}`);
      } else {
        const created = await createProject(cdp, ctx.projectPath, aumid, gui, deps, logger);
        if (!created.ok)
          return result({
            hardFailure: true,
            error: created.error,
            endReason: "project_create_failed",
            session: { boundProjectPath: ctx.projectPath, model: spec.model, permissionMode: gui.defaultPermissionMode },
          });
      }
      if (!(await waitBound(cdp, ctx.projectPath, deps)))
        return result({
          hardFailure: true,
          error: `Codex 项目绑定回读与目标不一致（期望 ${projectBasename(ctx.projectPath)}）`,
          endReason: "project_mismatch",
        });
      logger.info(`[codex] 项目绑定回读通过：${projectBasename(ctx.projectPath)}`);
    } else {
      logger.info("[codex] 返修/续答轮：复用当前会话与已绑定项目");
    }

    // ---- 步骤 4：模型 + 思考等级 + 权限 ----
    const modelOk = await ensureModelAndLevel(cdp, spec, gui, deps, logger);
    if (!modelOk.ok)
      return result({ hardFailure: true, error: modelOk.error, endReason: modelOk.endReason });
    const permOk = await ensurePermission(cdp, gui, deps, logger);
    if (!permOk.ok)
      return result({ hardFailure: true, error: permOk.error, endReason: "permission_unknown" });

    // ---- 步骤 4/5：输入指令 + 发送 ----
    if (isContinueConfirm) logger.info("[codex] 用户确认文本不发送给模型；环境复检通过后发送原始任务书");

    // 返修轮：ctx.feedback 即 fix-loop 生成的修复指令（引用 codex-fix-r<N>.md）；
    // 续答轮：ctx.resume.message 是用户答复。两者都不应退回重发原始任务书。
    const message = resuming
      ? ctx.resume?.sendMessage
        ? (ctx.resume.message?.trim() || ctx.feedback?.trim() || ctx.task)
        : ctx.task
      : buildInitialPrompt({
          task: ctx.task,
          context: ctx.context,
          planDoc: ctx.planDoc,
          designSystem: ctx.designSystem,
          refs: safeRefs(ctx),
        });

    const attempt =
      ctx.resume?.kind === "continue"
        ? `continue:${createHash("sha256").update(ctx.resume.message ?? "confirmed").digest("hex").slice(0, 8)}`
        : (ctx.resume?.kind ?? "initial");
    const marker = `【tianshu:${ctx.taskId}:r${ctx.round}:${attempt}】`;
    const beforeText = (await cdp.poll()).conversationText;

    await cdp.typeText(marker + message);
    const typed = await cdp.inputText();
    if (!typed.includes(marker))
      return result({ hardFailure: true, error: "Codex 输入框回读不一致，未发送", endReason: "input_mismatch" });

    await cdp.sendMessage();

    // 发送确认：任一直接证据成立即认定已提交——
    //   a) 输入框不再含标记（文本已离开输入框）
    //   b) 对话区出现标记
    //   c) 出现运行信号（停止按钮）
    // 注意：无论确认与否都**不会重发**（重发风险高于误判），故宁可放宽确认条件；
    // 真机教训：对话区选择器曾命中空壳 main，导致明明发送成功却报 send_unknown。
    let seenMessage = beforeText.includes(marker);
    let seenCleared = false;
    let seenRunning = false;
    const confirmAttempts = Math.ceil(Math.min(60_000, Math.max(5_000, ctx.taskTimeoutMs)) / 250);
    const confirmed = (): boolean => seenCleared || seenMessage || seenRunning;
    for (let i = 0; i < confirmAttempts && !confirmed(); i++) {
      // eslint-disable-next-line no-await-in-loop
      await deps.sleep(250);
      // eslint-disable-next-line no-await-in-loop
      const [poll, input] = await Promise.all([cdp.poll(), cdp.inputText()]);
      seenMessage ||= poll.conversationText.includes(marker);
      seenCleared ||= !input.includes(marker);
      seenRunning ||= poll.stopVisible;
    }
    if (!confirmed())
      return result({
        hardFailure: true,
        error: `Codex 发送结果无法确认（用户消息=${seenMessage}，输入清空=${seenCleared}，运行信号=${seenRunning}）；不重复发送`,
        endReason: "send_unknown",
      });
    logger.info(
      `[codex] 指令已确认发送（对话区=${seenMessage}，输入清空=${seenCleared}，运行信号=${seenRunning}）`,
    );

    // ---- 步骤 6：运行检测 ----
    const deadline = started + ctx.taskTimeoutMs;
    let state: CodexPollState = initialCodexState();
    let lastProgress = 0;
    for (;;) {
      if (opts.signal?.aborted) return result({ killed: true, endReason: "aborted" });
      if (Date.now() >= deadline)
        return result({
          timeout: true,
          endReason: "task_timeout",
          error: "Codex 任务总时限已到；已停止 MCP 等待并保留 Codex 现场",
        });
      // eslint-disable-next-line no-await-in-loop
      await deps.sleep(gui.pollIntervalMs);
      // eslint-disable-next-line no-await-in-loop
      const poll: CodexPoll = await cdp.poll();
      const verdict = judgeCodexPoll(poll, state, gui.stableRounds, gui.idleTimeoutMs);
      state = verdict.state;
      if (Date.now() - lastProgress >= gui.progressIntervalMs) {
        const note = `Codex 进度：${verdict.kind}；运行证据=${verdict.evidence}；对话哈希=${state.hash}；稳定轮=${state.stable}`;
        await Promise.resolve(opts.onProgress?.(note)).catch(() => {});
        logger.info(note);
        lastProgress = Date.now();
      }
      if (verdict.kind === "needs_login")
        return result({
          endReason: "needs_user",
          needsUserKind: "login_required",
          pendingQuestion: "Codex 需要登录，请在窗口中完成登录后调用 continue_task 确认。",
          session: { boundProjectPath: ctx.projectPath, model: spec.model, permissionMode: gui.defaultPermissionMode },
        });
      if (verdict.kind === "idle_timeout")
        return result({ endReason: "idle_timeout", error: "Codex 空闲超时；已停止 MCP 等待并保留现场" });
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
          session: { boundProjectPath: ctx.projectPath, model: spec.model, permissionMode: gui.defaultPermissionMode },
          progressSummary: "Codex 已完成回复",
        };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`[codex] 执行异常：${msg}${e instanceof Error && e.stack ? `\n${e.stack}` : ""}`);
    if (e instanceof CdpDisconnectedError || e instanceof CdpUnavailableError)
      return result({ hardFailure: true, error: msg, endReason: "cdp_disconnected" });
    return result({ hardFailure: true, error: msg, endReason: "internal" });
  } finally {
    cdp?.disconnect();
    await close();
  }
}

function safeRefs(ctx: TaskContext): ReturnType<typeof validateTaskReferences> {
  try {
    return validateTaskReferences(ctx.task, ctx.context, ctx.projectPath);
  } catch {
    // 引用校验由 handler 预先拦截；此处仅用于拼装补充说明，失败不阻断
    return [];
  }
}

/**
 * 新建项目流程（截图 2→5）：
 * 打开项目选择层 → 新建项目 → 点源文件夹中心空白区 → 原生对话框键盘填路径 →
 * 确认源文件夹 → 点创建项目。任一步无法唯一定位即 fail-closed。
 */
async function createProject(
  cdp: CodexCdpClient,
  projectPath: string,
  aumid: string | undefined,
  gui: GuiProfile,
  deps: CodexRunDeps,
  logger: AgentRunLogger,
): Promise<{ ok: boolean; error?: string }> {
  // 新建会话后输入框会重渲染，触发器可能短暂缺席 —— 先等它出现再点。
  if (!(await waitFor(cdp, "projectPickerTrigger", deps, 12_000)))
    return {
      ok: false,
      error: "新建会话后未出现项目选择触发器（可用 gui.selectors.projectPickerTrigger 热修复）",
    };
  if (!(await cdp.click("projectPickerTrigger")))
    return { ok: false, error: "项目选择触发器点击失败" };
  if (!(await waitFor(cdp, "newProjectMenuItem", deps, 8_000)))
    return { ok: false, error: "项目选择弹层未出现（找不到「新建项目」项）" };

  const menu = await cdp.clickExact("newProjectMenuItem", "新建项目");
  if (!menu.clicked)
    return {
      ok: false,
      error: `无法唯一选择「新建项目」菜单项（匹配 ${menu.count}${menu.available.length ? `；可见候选=${menu.available.slice(0, 20).join("、")}` : ""}）`,
    };
  // 等「创建项目」对话框渲染完成，再点源文件夹；否则 trusted 点击会落空、不弹原生选择器
  if (!(await waitFor(cdp, "sourceFolderArea", deps, 10_000)))
    return { ok: false, error: "「创建项目」对话框未出现（找不到源文件夹按钮）" };

  const pids = deps.listProcesses()
    .filter((p) => !/--type=|crashpad/i.test(p.commandLine))
    .map((p) => p.pid);
  // 先清理残留原生对话框（上一轮失败可能留下，遮挡界面且会让本轮误判「无新对话框」）
  const closed = await deps.closeDialogs(pids);
  if (closed) logger.warn(`[codex] 已清理 ${closed} 个残留原生对话框`);
  // 原生文件夹选择器只在应用窗口处于前台时弹出；无人值守下先用 COM 激活把窗口带到前台
  // （SetForegroundWindow 会被前台锁拒绝，应用模型激活不会）。
  const focused = aumid ? await deps.focusApp(aumid) : false;
  logger.info(`[codex] 窗口置前：${focused ? "成功" : "未确认（继续尝试）"}`);
  await deps.sleep(500);

  // 点源文件夹 drop zone（截图明确：不要直接点「创建项目」）。
  // 必须用 trusted 鼠标事件：DOM .click() 是 untrusted，应用会忽略而不弹原生对话框。
  const baseline = await deps.listDialogs(pids);
  if (!(await cdp.clickTrusted("sourceFolderArea")))
    return { ok: false, error: "无法触发「源文件夹」点击（元素不可见或落点被遮挡）" };
  await deps.sleep(1500);

  const selected = await deps.selectFolder(projectPath, pids, baseline);
  if (!selected.ok) return { ok: false, error: `原生文件夹对话框驱动失败：${selected.message}` };
  logger.info("[codex] 原生文件夹对话框已提交，等待创建项目对话框回填");
  await deps.sleep(1000);

  // 确认源文件夹已挂上目标目录（读整个对话框文本，比读单个区域更稳）
  const srcText = await cdp.createProjectDialogText();
  if (!srcText.toLocaleLowerCase().includes(projectBasename(projectPath).toLocaleLowerCase()))
    return { ok: false, error: `源文件夹未回填目标目录（对话框文本「${srcText.slice(0, 120)}」）` };

  const created = await cdp.clickExact("createProjectButton", "创建项目");
  if (!created.clicked)
    return { ok: false, error: `无法点击「创建项目」（匹配 ${created.count}）` };
  logger.info(`[codex] 已创建项目：${projectBasename(projectPath)}`);
  return { ok: true };
}

/** 选择模型与思考等级，并回读校验 */
async function ensureModelAndLevel(
  cdp: CodexCdpClient,
  spec: ReturnType<typeof parseCodexModel>,
  gui: GuiProfile,
  deps: CodexRunDeps,
  logger: AgentRunLogger,
): Promise<{ ok: boolean; error?: string; endReason?: string }> {
  const triggerValue = parseTriggerValue(await cdp.modelTriggerText());
  const modelMatches = exactUiName(triggerValue.model, spec.model);
  const levelMatches = !spec.level || triggerValue.level === spec.level;
  if (modelMatches && levelMatches) {
    logger.info(`[codex] 模型/等级回读已匹配，复用 ${triggerValue.model}${triggerValue.level ? ` ${triggerValue.level}` : ""}`);
    return { ok: true };
  }
  if (!gui.modelSwitch) {
    logger.warn("[codex] profile.gui.modelSwitch=false，忽略指定模型");
    return { ok: true };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await cdp.click("modelTrigger")))
      return { ok: false, error: "无法打开 Codex 模型菜单", endReason: "setup_failed" };
    // eslint-disable-next-line no-await-in-loop
    await deps.sleep(400);

    if (!modelMatches) {
      // eslint-disable-next-line no-await-in-loop
      const model = await cdp.clickExact("menuItem", spec.model);
      if (!model.clicked)
        return {
          ok: false,
          endReason: "model_unavailable",
          error: `模型不存在或同名歧义：${spec.model}（匹配 ${model.count}${model.available.length ? `；可见候选=${model.available.slice(0, 20).join("、")}` : ""}）`,
        };
      // eslint-disable-next-line no-await-in-loop
      await deps.sleep(400);
    }
    if (spec.level) {
      const candidateTexts = levelUiTexts(spec.level);
      let levelHit = { clicked: false, count: 0, available: [] as string[] };
      for (const text of candidateTexts) {
        // eslint-disable-next-line no-await-in-loop
        levelHit = await cdp.clickExact("menuItem", text);
        if (levelHit.clicked) break;
      }
      if (!levelHit.clicked)
        return {
          ok: false,
          endReason: "model_unavailable",
          error: `思考等级不存在或同名歧义：${spec.level}（候选=${candidateTexts.join("/")}）`,
        };
      // eslint-disable-next-line no-await-in-loop
      await deps.sleep(400);
    }
    // eslint-disable-next-line no-await-in-loop
    const after = parseTriggerValue(await cdp.modelTriggerText());
    if (exactUiName(after.model, spec.model) && (!spec.level || after.level === spec.level))
      return { ok: true };
  }
  const finalValue = parseTriggerValue(await cdp.modelTriggerText());
  return {
    ok: false,
    endReason: "model_mismatch",
    error: `模型/等级切换回读不一致：期望 ${spec.model}${spec.level ? ` ${spec.level}` : ""}，实际 ${finalValue.model}${finalValue.level ? ` ${finalValue.level}` : ""}`,
  };
}

/** 强制权限模式（决策 5：完全访问） */
async function ensurePermission(
  cdp: CodexCdpClient,
  gui: GuiProfile,
  deps: CodexRunDeps,
  logger: AgentRunLogger,
): Promise<{ ok: boolean; error?: string }> {
  const target = gui.permissionMode || gui.defaultPermissionMode;
  if (!target) return { ok: true };
  // 真机实测：权限 chip 只在会话/项目就绪后才渲染；缺失说明该界面未暴露权限控制，
  // 不是「权限错误」。此时跳过强制（fail-open）并告警，避免误判为硬失败。
  if (!(await cdp.exists("permissionTrigger"))) {
    logger.warn(`[codex] 未发现权限触发器，跳过「${target}」强制（界面未暴露权限控制）`);
    return { ok: true };
  }
  const current = await cdp.permissionText();
  if (exactUiName(current, target)) {
    logger.info(`[codex] 权限回读已匹配，复用 ${target}`);
    return { ok: true };
  }
  if (!(await cdp.click("permissionTrigger")))
    return { ok: false, error: "无法打开 Codex 权限菜单" };
  await deps.sleep(350);
  for (const text of [target, "完全访问", "Full access"]) {
    // eslint-disable-next-line no-await-in-loop
    const hit = await cdp.clickExact("permissionOption", text);
    if (hit.clicked) {
      // eslint-disable-next-line no-await-in-loop
      await deps.sleep(350);
      // eslint-disable-next-line no-await-in-loop
      const after = await cdp.permissionText();
      if (exactUiName(after, target)) return { ok: true };
    }
  }
  return { ok: false, error: `无法将 Codex 权限切换为「${target}」` };
}
