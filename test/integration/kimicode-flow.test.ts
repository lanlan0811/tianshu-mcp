import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  KimicodeCdpClient,
  kimicodeMainTargetRank,
  kimicodeOverlayTargetRank,
} from "../../src/agents/kimicode/cdp.js";
import { ensureFreshDraft, locateSession } from "../../src/agents/kimicode/session.js";
import { matchKimicodeWorkspace, normalizeWorkspacePath } from "../../src/agents/kimicode/workspace.js";
import { listOwnedDialogs, selectKimicodeFolder, toNativeDialogPath } from "../../src/agents/kimicode/dialog.js";
import { runKimicodeTask, type KimicodeRunDeps } from "../../src/agents/kimicode/run.js";
import type {
  AgentRunOptions,
  AgentRunResult,
  ResolvedAgent,
  TaskContext,
} from "../../src/agents/adapter.js";
import { AgentProfileSchema } from "../../src/config/schema.js";
import { Logger } from "../../src/util/log.js";
import { makeTmpRoot, rmrf } from "../test-utils.js";
import { makeKimicodeTargets, type FakeKimicodeState, type FakeKimicodeTargets } from "../fake-cdp.js";

/**
 * M2 集成测试：实例接管之后的三件事——**新建草稿 → 工作区绑定（回读）→ 会话定位**。
 *
 * 全部走注入的假 CDP（两个 target：主窗口 `app://renderer/` 与浮层 `browser-overlay.html`）
 * 与 hermetic 的原生对话框桩，不触达真实系统/网络。
 */

/** 与 zcode/run.ts 的 deps 注入同风格：原生对话框能力可替换，测试里绝不触达真实枚举 */
interface DialogDeps {
  listDialogs: typeof listOwnedDialogs;
  selectFolder: typeof selectKimicodeFolder;
  closeDialogs: (pids: number[]) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
}

function hermeticDeps(overrides: Partial<DialogDeps> = {}): DialogDeps {
  return {
    // 真实 listOwnedDialogs / closeStrayDialogs 会外呼 PowerShell/osascript，集成测试必须隔离。
    listDialogs: async () => [],
    selectFolder: async () => ({ ok: true, message: "hermetic" }),
    closeDialogs: async () => 0,
    sleep: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
    ...overrides,
  };
}

interface BindResult {
  ok: boolean;
  reason?: "draft" | "panel" | "ambiguous" | "click" | "native" | "readback";
  boundPath?: string;
  chip?: string;
  candidates?: string[];
  message?: string;
}

/**
 * M2 的绑定流程本体（M3 会把它搬进 run.ts，这里按同一顺序驱动被测模块）：
 * 建草稿 → 开面板 → 读条目 → 完整路径命中则点选，否则走原生对话框新增 → 回读绑定。
 */
async function bindWorkspace(
  cdp: KimicodeCdpClient,
  projectPath: string,
  deps: DialogDeps,
  pids: number[],
  draftBudgetMs = 200,
): Promise<BindResult> {
  // reclickMs 压到 60ms：测试截止时间只有数百毫秒，默认 1500ms 会让「周期重试」在断言里不可见。
  if (
    !(await ensureFreshDraft(cdp, Date.now() + draftBudgetMs, { sleep: deps.sleep, reclickMs: 60 }))
  )
    return { ok: false, reason: "draft" };
  if (!(await cdp.openWorkspacePanel(300))) return { ok: false, reason: "panel" };
  const items = await cdp.workspaceItems();
  const match = matchKimicodeWorkspace(items, projectPath, "win32");
  if (match.ambiguous)
    return { ok: false, reason: "ambiguous", candidates: match.candidates };
  if (match.item) {
    const clicked = await cdp.clickWorkspaceByPath(match.item.path ?? "");
    if (!clicked.clicked) return { ok: false, reason: "click" };
  } else {
    // 目标工作区不在「最近的文件夹」里：先采样基线，再点「选择文件夹…」并只操作新出现的对话框。
    const baseline = await deps.listDialogs(pids, {});
    await cdp.dismissMenus();
    if (!(await cdp.openWorkspacePanel(300))) return { ok: false, reason: "panel" };
    if (!(await cdp.clickChooseFolder())) return { ok: false, reason: "click" };
    const selected = await deps.selectFolder(projectPath, pids, baseline, {});
    if (!selected.ok) return { ok: false, reason: "native", message: selected.message };
  }
  if (!(await cdp.openWorkspacePanel(300))) return { ok: false, reason: "panel" };
  const after = await cdp.workspaceItems();
  const active = after.filter((item) => item.active);
  if (active.length !== 1) return { ok: false, reason: "readback" };
  const bound = active[0]!;
  if (!bound.path) return { ok: false, reason: "readback" };
  if (normalizeWorkspacePath(bound.path, "win32") !== normalizeWorkspacePath(projectPath, "win32"))
    return { ok: false, reason: "readback", candidates: [bound.path] };
  // ws-chip 是否存在即「是否仍在草稿页」：发送后它会从 composer 消失。
  const chip = await cdp.workspaceChipText();
  if (!chip) return { ok: false, reason: "readback" };
  return { ok: true, boundPath: bound.path, chip };
}

function clientFor(targets: FakeKimicodeTargets): KimicodeCdpClient {
  return new KimicodeCdpClient(9666, 1_000, {}, { createClient: targets.createClient });
}

const PROJECT = "D:\\work\\tianshu-mcp";

describe("Kimi Code CDP target 归属", () => {
  it("主窗口与浮层按 URL 区分：主窗口排除 overlay/截图，浮层只认 browser-overlay", () => {
    const targets = [
      { title: "Screenshot", url: "app://renderer/screenshot/index.html?display=1" },
      { title: "Kimi Browser Overlay", url: "app://renderer/browser-overlay.html" },
      { title: "Kimi Code", url: "app://renderer/sessions/abc" },
    ];
    const main = [...targets].sort((a, b) => kimicodeMainTargetRank(a) - kimicodeMainTargetRank(b))[0];
    expect(main?.title).toBe("Kimi Code");
    const overlay = [...targets].sort(
      (a, b) => kimicodeOverlayTargetRank(a) - kimicodeOverlayTargetRank(b),
    )[0];
    expect(overlay?.url).toContain("browser-overlay");
    // 会话页与草稿页是同一个主窗口 target（URL 变、target 不变）。
    expect(kimicodeMainTargetRank({ title: "Kimi Code", url: "app://renderer/" })).toBe(0);
    expect(kimicodeMainTargetRank({ title: "Kimi Code", url: "app://renderer/sessions/x" })).toBe(0);
  });

  it("浮层惰性连接：只按 overlay 窗口的可见性判定菜单开关，DOM 残留不算打开", async () => {
    const targets = makeKimicodeTargets({}, { menuDomPresent: true, overlayVisible: false });
    const cdp = clientFor(targets);
    await cdp.connect();
    expect(await cdp.overlayVisible()).toBe(false);
    expect(cdp.overlayConnected()).toBe(true);
    expect(await cdp.exists("overlay.permissionOption")).toBe(true); // DOM 残留确实存在
    targets.states.overlay.overlayVisible = true;
    expect(await cdp.overlayVisible()).toBe(true);
  });

  it("dismissMenus 同时收起主窗口面板与浮层菜单（Escape 各发到对应 target）", async () => {
    const targets = makeKimicodeTargets({ draft: true, panelOpen: true }, { overlayVisible: true });
    const cdp = clientFor(targets);
    await cdp.connect();
    await cdp.dismissMenus();
    expect(targets.states.main.panelOpen).toBe(false);
    expect(targets.states.overlay.overlayVisible).toBe(false);
  });
});

describe("Kimi Code 工作区绑定流程", () => {
  it("工作区已在「最近的文件夹」里：完整路径命中 → 新建草稿 → 回读绑定通过", async () => {
    const targets = makeKimicodeTargets({
      draft: false,
      url: "app://renderer/sessions/s-old",
      sessions: [{ id: "s-old", title: "上一任务" }],
      workspaces: [
        { name: "other", path: "D:\\other", active: true },
        { name: "tianshu-mcp", path: PROJECT, active: false },
      ],
    });
    const cdp = clientFor(targets);
    await cdp.connect();
    const result = await bindWorkspace(cdp, PROJECT, hermeticDeps(), [4242]);
    expect(result).toMatchObject({ ok: true, boundPath: PROJECT, chip: "tianshu-mcp" });
    // 点击必须是 trusted 事件（run 层 clickAt），不是 DOM click 兜底。
    expect(targets.states.main.clicks).toContain("new-session");
    expect(targets.states.main.clicks).toContain("workspace-row:1");
    expect(targets.states.main.clicks).not.toContain("dom-click");
    // 绑定结果落到面板的选中项上，且没有多余的条目。
    expect(targets.states.main.workspaces.filter((item) => item.active)).toEqual([
      { name: "tianshu-mcp", path: PROJECT, active: true },
    ]);
  });

  it("工作区未登记：只操作新出现的原生对话框并在回读通过后才算绑定", async () => {
    const targets = makeKimicodeTargets({
      workspaces: [{ name: "other", path: "D:\\other", active: true }],
    });
    const seen: { folder?: string; pids?: number[]; baseline?: string[] } = {};
    let chooseFolderBeforeNative = -1;
    const deps = hermeticDeps({
      listDialogs: async () => ["dialog:777:添加工作区"],
      selectFolder: async (folder, pids, baseline) => {
        seen.folder = folder;
        seen.pids = pids;
        seen.baseline = baseline;
        chooseFolderBeforeNative = targets.states.main.chooseFolderClicks;
        // 对话框确认后应用会新增并绑定该工作区（回读值刻意用原生形式，复刻真机）；
        // 绑定是互斥的：原选中项必须让位，否则回读会出现两个 active。
        targets.states.main.workspaces.forEach((item) => (item.active = false));
        targets.states.main.workspaces.push({
          name: path.win32.basename(folder),
          path: toNativeDialogPath(folder),
          active: true,
        });
        return { ok: true, message: "selected" };
      },
    });
    const cdp = clientFor(targets);
    await cdp.connect();
    const result = await bindWorkspace(cdp, PROJECT, deps, [4242]);
    expect(result).toMatchObject({ ok: true, boundPath: PROJECT, chip: "tianshu-mcp" });
    expect(seen.folder).toBe(PROJECT);
    expect(seen.pids).toEqual([4242]);
    // 基线是点击前采样的：只允许操作不在基线里的新对话框。
    expect(seen.baseline).toEqual(["dialog:777:添加工作区"]);
    expect(chooseFolderBeforeNative).toBe(1);
  });

  it("同名不同路径：路径不命中且名称命中两条 → 歧义停止，不点选也不开原生对话框", async () => {
    const targets = makeKimicodeTargets({
      workspaces: [
        { name: "tianshu-mcp", path: "D:\\work\\tianshu-mcp", active: true },
        { name: "tianshu-mcp", path: "E:\\copy\\tianshu-mcp", active: false },
      ],
    });
    const cdp = clientFor(targets);
    await cdp.connect();
    const result = await bindWorkspace(cdp, "D:\\Trae项目\\tianshu-mcp", hermeticDeps(), [4242]);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("ambiguous");
    expect(result.candidates).toEqual(["D:\\work\\tianshu-mcp", "E:\\copy\\tianshu-mcp"]);
    expect(targets.states.main.clicks.filter((click) => click.startsWith("workspace-row"))).toEqual([]);
    expect(targets.states.main.clicks).not.toContain("choose-folder");
  });

  it("草稿建立失败：两个入口都建立不了草稿 → fail-closed，不做绑定", async () => {
    const targets = makeKimicodeTargets({
      draft: false,
      draftBlocked: true,
      addSessionBlocked: true,
      url: "app://renderer/sessions/s-old",
      sessions: [{ id: "s-old", title: "上一任务" }],
      workspaces: [{ name: "tianshu-mcp", path: PROJECT, active: true }],
    });
    const cdp = clientFor(targets);
    await cdp.connect();
    const result = await bindWorkspace(cdp, PROJECT, hermeticDeps(), [4242], 400);
    expect(result).toMatchObject({ ok: false, reason: "draft" });
    // 两个入口都被尝试过（有界重试里交替），且没有任何工作区点击/原生对话框副作用。
    expect(targets.states.main.clicks).toContain("new-session");
    expect(targets.states.main.clicks).toContain("workspace-add-session");
    expect(targets.states.main.clicks.some((c) => c.startsWith("workspace-row"))).toBe(false);
    expect(targets.states.main.chooseFolderClicks).toBe(0);
  });

  it("主入口点不动时由分组入口建立草稿（有界重试）", async () => {
    const targets = makeKimicodeTargets({
      draft: false,
      draftBlocked: true,
      url: "app://renderer/sessions/s-old",
      sessions: [{ id: "s-old", title: "上一任务" }],
      workspaces: [{ name: "tianshu-mcp", path: PROJECT, active: true }],
    });
    const cdp = clientFor(targets);
    await cdp.connect();
    const result = await bindWorkspace(cdp, PROJECT, hermeticDeps(), [4242], 400);
    expect(result).toMatchObject({ ok: true, boundPath: PROJECT });
    const clicks = targets.states.main.clicks;
    // 先试全局入口（被阻塞），重试时切到分组入口并真正建立草稿；随后才是绑定动作。
    expect(clicks.indexOf("new-session")).toBe(0);
    expect(clicks).toContain("workspace-add-session");
    expect(clicks.indexOf("workspace-add-session")).toBeLessThan(clicks.indexOf("workspace-row:0"));
  });

  /**
   * 真机回归（2026-09-20）：Chromium 节流会吞掉单次合成点击，表现为「点新建会话毫无反应」。
   * 修复要点是「以 ws-chip 挂载为准做有界重试」，而不是只点一次就 fail-closed。
   */
  it("单次新建会话点击被吞 → 周期重试后仍能建立草稿（真机节流回归）", async () => {
    const targets = makeKimicodeTargets({
      draft: false,
      // 前两次「新建会话」点击被吞；同时堵住分组入口，确保救场只能来自重试本身。
      draftSwallowCount: 2,
      addSessionBlocked: true,
      url: "app://renderer/sessions/s-old",
      sessions: [{ id: "s-old", title: "上一任务" }],
      workspaces: [{ name: "tianshu-mcp", path: PROJECT, active: true }],
    });
    const cdp = clientFor(targets);
    await cdp.connect();
    const result = await bindWorkspace(cdp, PROJECT, hermeticDeps(), [4242], 800);
    expect(result).toMatchObject({ ok: true, boundPath: PROJECT });
    // 被吞两次 + 成功一次 = 至少 3 次「新建会话」点击，证明重试真的发生了。
    expect(targets.states.main.clicks.filter((c) => c === "new-session").length).toBeGreaterThanOrEqual(
      3,
    );
  });
});

describe("Kimi Code 会话定位", () => {
  it("当前 URL 就是目标会话时按 URL 命中，不点侧栏", async () => {
    const targets = makeKimicodeTargets({ url: "app://renderer/sessions/s-1", sessions: [{ id: "s-1" }] });
    const cdp = clientFor(targets);
    await cdp.connect();
    expect(await locateSession(cdp, "s-1")).toEqual({ found: true, id: "s-1", source: "url" });
    expect(targets.states.main.clicks).toEqual([]);
  });

  it("侧栏唯一定位后切页并回读 URL；找不到时返回未找到而不是打开最近会话", async () => {
    const targets = makeKimicodeTargets({
      url: "app://renderer/",
      sessions: [
        { id: "s-new", title: "最近任务" },
        { id: "s-old", title: "目标任务" },
      ],
    });
    const cdp = clientFor(targets);
    await cdp.connect();
    expect(await locateSession(cdp, "s-old")).toEqual({
      found: true,
      id: "s-old",
      title: "目标任务",
      source: "dom",
    });
    expect(targets.states.main.clicks).toEqual(["session:1"]);
    expect(await locateSession(cdp, "s-missing")).toMatchObject({ found: false, reason: "not-found" });
    // 无锚点时既不点最近会话，也不猜标题。
    expect((await locateSession(cdp)).reason).toBe("missing-anchor");
  });
});

describe("Kimi Code 原生对话框脚本", () => {
  const source = fs.readFileSync(
    path.resolve("src", "agents", "kimicode", "dialog.ts"),
    "utf8",
  );

  it("路径只经环境变量进入脚本，脚本源码里没有任何路径插值", () => {
    // 只取两段 PowerShell 脚本文本：路径若被插值进源码，CJK/空格会被命令行代码页破坏。
    const scripts = source.slice(
      source.indexOf("WINDOWS_LIST_SCRIPT"),
      source.indexOf("export async function listOwnedDialogs"),
    );
    expect(scripts).toContain("$env:TIANSHU_KIMICODE_FOLDER");
    expect(source).toContain("TIANSHU_KIMICODE_FOLDER: nativePath");
    expect(scripts).not.toContain("${");
    expect(scripts).not.toMatch(/\$pid\b/i);
  });

  it("写入用 WM_SETTEXT + WM_GETTEXT 回读，回读不一致的 throw 发生在点确认之前", () => {
    expect(source).toContain("WM_SETTEXT");
    expect(source).toContain("WM_GETTEXT");
    expect(source).toContain("'1152'");
    expect(source).toContain("'#32770'");
    const readbackGuard = source.indexOf("Kimi Code 工作区路径回读不一致");
    const submit = source.indexOf("native:submit-once");
    expect(readbackGuard).toBeGreaterThan(0);
    expect(submit).toBeGreaterThan(readbackGuard);
  });

  it("确认按钮按 AutomationId=1 + 矩形位于对话框下半部定位（无 InvokePattern 只能坐标点击）", () => {
    const scripts = source.slice(
      source.indexOf("WINDOWS_SELECT_SCRIPT"),
      source.indexOf("export async function listOwnedDialogs"),
    );
    expect(scripts).not.toMatch(/GetCurrentPattern|\.Invoke\(/);
    expect(scripts).toContain("$dialogRect.Height/2");
    expect(scripts).toContain("MOUSEEVENTF_LEFTDOWN");
  });

  it("原生路径形式：盘符大写 + 反斜杠（原生选择器拒绝正斜杠）", () => {
    expect(toNativeDialogPath("d:/Trae项目/tianshu-mcp/")).toBe("D:\\Trae项目\\tianshu-mcp");
    expect(toNativeDialogPath("D:\\work\\demo")).toBe("D:\\work\\demo");
    // 仅盘符在对话框里等价于盘根（win32.normalize 会补成 `d:.`，不能原样送进对话框）。
    expect(toNativeDialogPath("d:")).toBe("D:\\");
  });
});

/* ============================ M3：主链路（模型/档位/模式/发送/运行判定） ============================ */

const m3Logger = new Logger(null, "error");
const m3Cleanup: string[] = [];
afterAll(async () => {
  for (const dir of m3Cleanup) await rmrf(dir);
});

/** M3 的每轮 ctx：任务总时限刻意短（10s），配合空 sleep 让轮询环瞬时收敛 */
function m3Ctx(
  projectPath: string,
  over: Partial<TaskContext> = {},
): TaskContext {
  return {
    taskId: "tsk_kimicode",
    projectPath,
    displayPath: projectPath,
    agentId: "kimicode",
    task: "完成开发",
    model: "K3",
    round: 0,
    taskDir: path.join(projectPath, "task-data"),
    workDir: projectPath,
    taskTimeoutMs: 10_000,
    ...over,
  };
}

function m3Resolved(guiOverrides: Record<string, unknown> = {}): ResolvedAgent {
  const profile = AgentProfileSchema.parse({
    displayName: "Kimi Code test",
    driver: "gui",
    adapter: "kimicode-gui",
    status: "ready",
    command: process.execPath,
    gui: {
      pollIntervalMs: 1,
      stableRounds: 1,
      idleTimeoutMs: 60_000,
      stallTimeoutMs: 60_000,
      progressIntervalMs: 1,
      launchTimeoutMs: 1_000,
      setupRecoveryTimeoutMs: 5_000,
      projectTriggerTimeoutMs: 2_000,
      workspaceTriggerTimeoutMs: 2_000,
      defaultPermissionMode: "完全自动",
      ...guiOverrides,
    },
  });
  return {
    id: "kimicode",
    displayName: "Kimi Code test",
    profile,
    command: process.execPath,
    argsTemplate: [],
    ok: true,
    message: "test",
  };
}

interface M3Harness {
  ctx: TaskContext;
  resolved: ResolvedAgent;
  opts: AgentRunOptions;
  logFile: string;
  deps: Partial<KimicodeRunDeps>;
  events: string[];
}

/** 一站式装配：假 CDP + hermetic 原生对话框桩 + 空 sleep（不触达真实系统与真实时钟） */
async function m3Harness(
  targets: FakeKimicodeTargets,
  over: {
    ctx?: Partial<TaskContext>;
    gui?: Record<string, unknown>;
    deps?: Partial<KimicodeRunDeps>;
  } = {},
): Promise<M3Harness> {
  const root = await makeTmpRoot("kimicode-m3");
  m3Cleanup.push(root);
  const events: string[] = [];
  const clientForFake = new KimicodeCdpClient(9666, 1_000, {}, {
    createClient: targets.createClient,
  });
  return {
    // 工作区绑定用固定 fixture 路径（与 M2 用例一致）：绑定判据是归一化后的完整路径，
    // 因此假面板里的 ws-path 必须与 ctx.projectPath 对齐。
    ctx: m3Ctx(PROJECT, over.ctx),
    resolved: m3Resolved(over.gui),
    opts: {
      logger: m3Logger,
      onProgress: (note) => {
        events.push(note);
      },
    },
    logFile: path.join(root, "agent.log"),
    deps: {
      ensureInstance: async () => ({ ready: { port: 9666, pid: 4242, title: "Kimi Code" } }),
      listProcesses: async () => [{ pid: 4242, commandLine: "Kimi Code.exe" }],
      createClient: () => clientForFake,
      listDialogs: async () => [],
      selectFolder: async () => ({ ok: true, message: "hermetic" }),
      closeDialogs: async () => 0,
      sleep: async () => {},
      ...over.deps,
    },
    events,
  };
}

async function runM3(h: M3Harness): Promise<AgentRunResult> {
  return runKimicodeTask({
    ctx: h.ctx,
    resolved: h.resolved,
    opts: h.opts,
    logFile: h.logFile,
    deps: h.deps,
  });
}

/** 已登记的「最近文件夹」：绑定走完整路径命中，不触发原生对话框 */
const M3_PROJECT_WORKSPACES = [{ name: "tianshu-mcp", path: PROJECT, active: true }];

/** 发送后收敛到完成的三帧运行状态：运行中 → 文本推进 → 静止 */
function finishingScript(): Array<Partial<FakeKimicodeState>> {
  return [
    { stopVisible: true, sendStarting: true },
    { stopVisible: false, sendStarting: false, conversation: "用户任务书Kimi 回复完成" },
    { stopVisible: false, sendStarting: false },
  ];
}

describe("Kimi Code M3 模型与档位", () => {
  it("模型不匹配：开浮层菜单精确选中 K3（不误命中 K3-256k）→ 回读通过 → 发送", async () => {
    const targets = makeKimicodeTargets({
      modelPill: "K3-256k · High",
      currentModel: "K3-256k",
      modelOptions: ["K3-256k", "K3"],
      workspaces: M3_PROJECT_WORKSPACES,
      pollScript: finishingScript(),
    });
    const result = await runM3(await m3Harness(targets));
    expect(result.ok).toBe(true);
    expect(result.endReason).toBe("reply_stable");
    expect(result.session?.id).toBe("s-new");
    expect(result.keptInstance).toBe(true);
    // 精确选择：模型名按全等匹配，K3-256k 不会被当成 K3 而跳过切换。
    expect(targets.states.overlay.clicks).toEqual(["overlay-model:K3"]);
    expect(targets.states.main.modelPill).toBe("K3 · High");
    expect(targets.states.main.sendClicks).toBe(1);
    // 档位与模型都回读一致，不需要点档位与执行模式。
    expect(targets.states.main.clicks).toContain("model-pill");
    expect(targets.states.main.clicks).not.toContain("permission-pill");
  });

  it("档位集合不支持（官方模型收「中」）→ 不发送", async () => {
    const targets = makeKimicodeTargets({
      tiers: ["Low", "High", "Max"],
      workspaces: M3_PROJECT_WORKSPACES,
    });
    const result = await runM3(
      await m3Harness(targets, { ctx: { reasoningLevel: "中" } }),
    );
    expect(result.ok).toBe(false);
    expect(result.hardFailure).toBe(true);
    expect(result.endReason).toBe("model_mismatch");
    expect(result.error).toContain("模型 K3 的思考等级仅支持 Low/High/Max，收到「中」（medium）");
    expect(targets.states.main.sendClicks).toBe(0);
    expect(targets.states.main.clicks).not.toContain("send");
  });

  it("非官方模型（On/Off）收到「高」→ 不发送", async () => {
    const targets = makeKimicodeTargets({
      modelPill: "stepfun/step-3.7-flash:free · 思考",
      currentModel: "stepfun/step-3.7-flash:free",
      tiers: ["On", "Off"],
      currentTier: "On",
      workspaces: M3_PROJECT_WORKSPACES,
    });
    const result = await runM3(
      await m3Harness(targets, {
        ctx: { model: "stepfun/step-3.7-flash:free", reasoningLevel: "高" },
      }),
    );
    expect(result.endReason).toBe("model_mismatch");
    expect(result.error).toContain("仅支持 On/Off，收到「高」（high）");
    expect(targets.states.main.sendClicks).toBe(0);
  });

  it("档位集合读不到（浮层档位标签缺失）→ fail-closed 且不发送", async () => {
    const targets = makeKimicodeTargets({
      tiers: ["思考"],
      workspaces: M3_PROJECT_WORKSPACES,
    });
    const result = await runM3(await m3Harness(targets, { ctx: { reasoningLevel: "high" } }));
    expect(result.endReason).toBe("model_mismatch");
    expect(result.error).toContain("无法从界面读到模型 K3 的思考档位标签");
    expect(targets.states.main.sendClicks).toBe(0);
  });

  it("档位不匹配：点击目标档位并回读通过后发送", async () => {
    const targets = makeKimicodeTargets({
      modelPill: "K3 · Low",
      currentTier: "Low",
      pollScript: finishingScript(),
      workspaces: M3_PROJECT_WORKSPACES,
    });
    const result = await runM3(await m3Harness(targets, { ctx: { reasoningLevel: "max" } }));
    expect(result.ok).toBe(true);
    expect(targets.states.overlay.clicks).toEqual(["overlay-tier:Max"]);
    expect(targets.states.main.modelPill).toBe("K3 · Max");
  });

  it("省略档位时非官方模型强制切到 On", async () => {
    const targets = makeKimicodeTargets({
      modelPill: "stepfun/step-3.7-flash:free · 思考",
      currentModel: "stepfun/step-3.7-flash:free",
      tiers: ["On", "Off"],
      currentTier: "Off",
      pollScript: finishingScript(),
      workspaces: M3_PROJECT_WORKSPACES,
    });
    const result = await runM3(
      await m3Harness(targets, { ctx: { model: "stepfun/step-3.7-flash:free" } }),
    );
    expect(result.ok).toBe(true);
    expect(targets.states.overlay.clicks).toEqual(["overlay-tier:On"]);
  });
});

describe("Kimi Code M3「更多模型…」对话框（非官方模型的唯一入口）", () => {
  it("快捷菜单没有目标模型 → 走「更多模型…」→ 搜索 → 精确选中 → 回读通过 → 发送", async () => {
    const targets = makeKimicodeTargets({
      modelPill: "K2.8 Preview · High",
      currentModel: "K2.8 Preview",
      // 快捷菜单里**没有** K3-256k（复刻非官方模型不在快捷菜单的真实场景）
      modelOptions: ["K2.8 Preview"],
      modelDialogModels: ["K2.8 Preview", "K3", "K3-256k"],
      pollScript: finishingScript(),
      workspaces: M3_PROJECT_WORKSPACES,
    });
    const result = await runM3(await m3Harness(targets, { ctx: { model: "K3-256k" } }));
    expect(result.ok).toBe(true);
    expect(result.endReason).toBe("reply_stable");
    // 走的是「更多模型…」这条二级入口，且对话框里按完整名精确命中
    expect(targets.states.overlay.clicks).toEqual(["overlay-more-models"]);
    expect(targets.states.main.clicks).toContain("dialog-model:K3-256k");
    expect(targets.states.main.modelPill).toBe("K3-256k · High");
    expect(targets.states.main.sendClicks).toBe(1);
  });

  it("对话框里 K3 与 K3-256k 并存时按全等只点中 K3", async () => {
    const targets = makeKimicodeTargets({
      modelPill: "K2.8 Preview · High",
      currentModel: "K2.8 Preview",
      modelOptions: ["K2.8 Preview"],
      modelDialogModels: ["K3-256k", "K3"],
      pollScript: finishingScript(),
      workspaces: M3_PROJECT_WORKSPACES,
    });
    const result = await runM3(await m3Harness(targets, { ctx: { model: "K3" } }));
    expect(result.ok).toBe(true);
    expect(targets.states.main.clicks).toContain("dialog-model:K3");
    expect(targets.states.main.clicks).not.toContain("dialog-model:K3-256k");
    expect(targets.states.main.currentModel).toBe("K3");
  });

  it("切到非官方模型后档位集合随之为 On/Off，且省略档位时强制 On", async () => {
    const targets = makeKimicodeTargets({
      modelPill: "K2.8 Preview · High",
      currentModel: "K2.8 Preview",
      modelOptions: ["K2.8 Preview"],
      modelDialogModels: ["K2.8 Preview", "stepfun/step-3.7-flash:free"],
      modelDialogTiers: { "stepfun/step-3.7-flash:free": ["On", "Off"] },
      pollScript: finishingScript(),
      workspaces: M3_PROJECT_WORKSPACES,
    });
    const result = await runM3(
      await m3Harness(targets, { ctx: { model: "stepfun/step-3.7-flash:free" } }),
    );
    expect(result.ok).toBe(true);
    // 含 `/` 的模型名先用完整名搜索（0 命中后才会退化为 provider 搜索）
    expect(targets.states.main.clicks).toContain("dialog-model:stepfun/step-3.7-flash:free");
    expect(targets.states.main.tiers).toEqual(["On", "Off"]);
    expect(targets.states.main.modelPill).toBe("stepfun/step-3.7-flash:free · 思考");
  });

  it("对话框点中但界面没生效 → model_mismatch 硬失败且未发送", async () => {
    const targets = makeKimicodeTargets({
      modelPill: "K2.8 Preview · High",
      currentModel: "K2.8 Preview",
      modelOptions: ["K2.8 Preview"],
      modelDialogModels: ["K2.8 Preview", "K3-256k"],
      dialogClickNoop: true,
      workspaces: M3_PROJECT_WORKSPACES,
    });
    const result = await runM3(await m3Harness(targets, { ctx: { model: "K3-256k" } }));
    expect(result.ok).toBe(false);
    expect(result.hardFailure).toBe(true);
    expect(result.endReason).toBe("model_mismatch");
    expect(result.error).toContain("模型切换回读不一致");
    expect(targets.states.main.clicks).toContain("dialog-model:K3-256k");
    expect(targets.states.main.sendClicks).toBe(0);
  });

  it("对话框里也不存在目标模型 → model_unavailable，错误文案带两侧候选", async () => {
    const targets = makeKimicodeTargets({
      modelPill: "K2.8 Preview · High",
      currentModel: "K2.8 Preview",
      modelOptions: ["K2.8 Preview"],
      modelDialogModels: ["K2.8 Preview", "K3-256k"],
      workspaces: M3_PROJECT_WORKSPACES,
    });
    const result = await runM3(
      await m3Harness(targets, { ctx: { model: "stepfun/step-3.7-flash:free" } }),
    );
    expect(result.ok).toBe(false);
    expect(result.endReason).toBe("model_unavailable");
    expect(result.error).toContain("模型不存在或同名歧义：stepfun/step-3.7-flash:free");
    expect(result.error).toContain("快捷菜单候选=K2.8 Preview");
    expect(targets.states.main.sendClicks).toBe(0);
  });

  it("完整名搜索 0 命中 → 退化为按 provider 搜一次（先清空搜索框），再按完整名精确选中", async () => {
    const targets = makeKimicodeTargets({
      modelPill: "K2.8 Preview · High",
      currentModel: "K2.8 Preview",
      modelOptions: ["K2.8 Preview"],
      modelDialogModels: ["K2.8 Preview", "stepfun/step-3.7-flash:free"],
      modelDialogTiers: { "stepfun/step-3.7-flash:free": ["On", "Off"] },
      // 只索引 provider 的过滤面：完整模型名搜不到任何行，必须退化为 provider 搜索
      modelDialogFilterBy: "provider",
      pollScript: finishingScript(),
      workspaces: M3_PROJECT_WORKSPACES,
    });
    const result = await runM3(
      await m3Harness(targets, { ctx: { model: "stepfun/step-3.7-flash:free" } }),
    );
    expect(result.ok).toBe(true);
    expect(targets.states.main.clicks).toContain("dialog-model:stepfun/step-3.7-flash:free");
    // 第二次搜索前搜索框被清空（否则会变成「完整名+provider」的复合串，永远搜不到）
    expect(targets.states.main.modelDialogQuery).toBe("stepfun");
    expect(targets.states.main.modelPill).toBe("stepfun/step-3.7-flash:free · 思考");
  });
});

describe("Kimi Code M3 执行模式与发送", () => {
  it("执行模式不是「完全自动」→ 切换并回读 → 发送", async () => {
    const targets = makeKimicodeTargets({
      permissionPill: "始终询问",
      currentPermission: "始终询问",
      pollScript: finishingScript(),
      workspaces: M3_PROJECT_WORKSPACES,
    });
    const result = await runM3(await m3Harness(targets));
    expect(result.ok).toBe(true);
    expect(targets.states.overlay.clicks).toEqual(["overlay-permission:完全自动"]);
    expect(targets.states.main.permissionPill).toBe("完全自动");
    expect(targets.states.main.sendClicks).toBe(1);
  });

  it("执行模式回读不一致（点击被吞）→ fail-closed 且不发送", async () => {
    const targets = makeKimicodeTargets({
      permissionPill: "始终询问",
      currentPermission: "始终询问",
      permissionOptions: ["始终询问"],
      workspaces: M3_PROJECT_WORKSPACES,
    });
    const result = await runM3(await m3Harness(targets));
    expect(result.hardFailure).toBe(true);
    expect(result.endReason).toBe("permission_unknown");
    expect(targets.states.main.sendClicks).toBe(0);
  });

  it("发送后 60s 内没有任何确认证据 → send_unknown，且只点击一次发送", async () => {
    const targets = makeKimicodeTargets({
      sendSwallowed: true,
      workspaces: M3_PROJECT_WORKSPACES,
    });
    const result = await runM3(await m3Harness(targets));
    expect(result.ok).toBe(false);
    expect(result.hardFailure).toBe(true);
    expect(result.endReason).toBe("send_unknown");
    expect(result.error).toMatch(/发送结果无法确认/);
    expect(result.error).toContain("不重复发送");
    expect(targets.states.main.sendClicks).toBe(1);
  });

  it("输入框回读不一致（标记未写入）→ 不点发送", async () => {
    const targets = makeKimicodeTargets({ workspaces: M3_PROJECT_WORKSPACES });
    // 写入后立刻清空输入框：回读不到标记即必须停在发送之前。
    const original = targets.main.send.bind(targets.main);
    targets.main.send = async (method: string, params: Record<string, unknown> = {}) => {
      const out = await original(method, params);
      if (method === "Input.insertText") targets.states.main.inputText = "";
      return out;
    };
    const result = await runM3(await m3Harness(targets));
    expect(result.endReason).toBe("input_mismatch");
    expect(targets.states.main.sendClicks).toBe(0);
  });

  it("composer 未挂载（停在登录/引导页）→ needs_user/login_required，不发送", async () => {
    const targets = makeKimicodeTargets({ composerMissing: true });
    const result = await runM3(await m3Harness(targets));
    expect(result.endReason).toBe("needs_user");
    expect(result.needsUserKind).toBe("login_required");
    expect(result.keptInstance).toBe(true);
    expect(targets.states.main.sendClicks).toBe(0);
  });
});

describe("Kimi Code M3 运行检测", () => {
  it("长生成期间文本多次静止仍 running，最终稳定才判完成", async () => {
    const script: Array<Partial<FakeKimicodeState>> = [
      { stopVisible: true, sendStarting: true },
      { stopVisible: true, conversation: "用户任务书思考中…第一段" },
      { stopVisible: true },
      { stopVisible: true },
      { stopVisible: false, sendStarting: false, conversation: "用户任务书思考中…第一段+最终回复" },
      { stopVisible: false, sendStarting: false },
    ];
    const targets = makeKimicodeTargets({
      pollScript: script,
      workspaces: M3_PROJECT_WORKSPACES,
    });
    const harness = await m3Harness(targets);
    const result = await runM3(harness);
    expect(result.ok).toBe(true);
    expect(result.endReason).toBe("reply_stable");
    expect(result.progressSummary).toBe("Kimi Code 已完成回复");
    // 六帧全部被消费：停止按钮可见期间（含三次文本静止）从未提前判完成。
    expect(script.length).toBe(0);
    expect(harness.events.some((note) => note.includes("Kimi Code 进度"))).toBe(true);
  });

  it("失败态（出现「继续」按钮）→ agent_error，不判完成也不保留假成功", async () => {
    const targets = makeKimicodeTargets({
      pollScript: [
        { stopVisible: true, sendStarting: true },
        {
          stopVisible: false,
          sendStarting: false,
          retryVisible: true,
          errorText: "模型请求失败，本轮对话已中断 · provider.auth_error · HTTP 403",
        },
      ],
      workspaces: M3_PROJECT_WORKSPACES,
    });
    const result = await runM3(await m3Harness(targets));
    expect(result.ok).toBe(false);
    expect(result.hardFailure).toBe(true);
    expect(result.endReason).toBe("agent_error");
    expect(result.error).toContain("模型请求失败");
    expect(result.keptInstance).toBe(true);
  });

  it("空闲超时（stableRounds 达标后无变化）→ idle_timeout 并保留现场", async () => {
    const targets = makeKimicodeTargets({
      pollScript: [
        { stopVisible: true, sendStarting: true },
        { stopVisible: false, sendStarting: false, conversation: "用户任务书静止回复" },
      ],
      workspaces: M3_PROJECT_WORKSPACES,
    });
    const result = await runM3(await m3Harness(targets, { gui: { idleTimeoutMs: 0 } }));
    expect(result.ok).toBe(false);
    expect(result.endReason).toBe("idle_timeout");
    expect(result.keptInstance).toBe(true);
  });

  it("停止按钮恒可见且文本停滞超 stallTimeoutMs → needs_user/user_confirmation（不判完成）", async () => {
    const targets = makeKimicodeTargets({
      pollScript: [{ stopVisible: true, sendStarting: true }],
      workspaces: M3_PROJECT_WORKSPACES,
    });
    // stallTimeoutMs 取最小值：把「恒可见 → 恒 running」的死锁路径压到几轮内可观测。
    const result = await runM3(await m3Harness(targets, { gui: { stallTimeoutMs: 1 } }));
    expect(result.ok).toBe(false);
    expect(result.endReason).toBe("needs_user");
    expect(result.needsUserKind).toBe("user_confirmation");
    expect(result.pendingQuestion).toMatch(/停止按钮持续可见/);
    expect(result.keptInstance).toBe(true);
  });
});

/* ==================== M4：needs_user 五类 / continue_task 恢复 / 取消真停 ==================== */

/** 与 M3 同构的装配，额外支持：deps 覆盖、取消信号、每次 poll 后回调（运行中触发取消） */
interface M4Harness extends M3Harness {
  client: KimicodeCdpClient;
  controller: AbortController;
  counters: { processList: number; instance: number };
}

async function m4Harness(
  targets: FakeKimicodeTargets,
  over: {
    ctx?: Partial<TaskContext>;
    gui?: Record<string, unknown>;
    deps?: (client: KimicodeCdpClient) => Partial<KimicodeRunDeps>;
    /** 每次 cdp.poll 之后回调（计数从 1 起）：用于在运行中触发取消 */
    onPoll?: (count: number) => void;
  } = {},
): Promise<M4Harness> {
  const base = await m3Harness(targets, { ctx: over.ctx, gui: over.gui });
  const client = base.deps.createClient!(9666, 1_000, {});
  const counters = { processList: 0, instance: 0 };
  let polls = 0;
  const originalPoll = client.poll.bind(client);
  client.poll = async () => {
    const result = await originalPoll();
    polls += 1;
    over.onPoll?.(polls);
    return result;
  };
  const controller = new AbortController();
  const deps: Partial<KimicodeRunDeps> = {
    // 先继承 hermetic 桩（原生对话框 / 空 sleep 绝不能被真实实现顶替），再覆盖实例与客户端
    ...base.deps,
    ensureInstance: async () => {
      counters.instance += 1;
      return { ready: { port: 9666, pid: 4242, title: "Kimi Code" } };
    },
    listProcesses: async () => {
      counters.processList += 1;
      return [{ pid: 4242, commandLine: "Kimi Code.exe" }];
    },
    createClient: () => client,
    ...over.deps?.(client),
  };
  return {
    ...base,
    deps,
    client,
    counters,
    controller,
    opts: { ...base.opts, signal: controller.signal },
  };
}

/** 发送到输入框并落进对话正文的内容（去掉发送前的种子文本） */
function sentText(targets: FakeKimicodeTargets, seed: string): string {
  return targets.states.main.conversation.slice(seed.length);
}

describe("Kimi Code M4 needs_user 五类", () => {
  it("既有实例无 CDP 端口 → close_existing_instance：不发送任何消息、不 kill 进程", async () => {
    const targets = makeKimicodeTargets({});
    const h = await m4Harness(targets, {
      deps: () => ({ ensureInstance: async () => ({ needsClose: true }) }),
    });
    const result = await runM3(h);
    expect(result.endReason).toBe("needs_user");
    expect(result.needsUserKind).toBe("close_existing_instance");
    expect(result.pendingQuestion).toContain("关闭所有 Kimi Code 窗口");
    expect(result.pendingQuestion).toContain("不会自动结束你的进程");
    expect(result.keptInstance).toBe(true);
    // 未连接 CDP：既没有发送，也没有任何 UI 动作（更没有进程终止路径）
    expect(targets.states.main.sendClicks).toBe(0);
    expect(targets.states.main.clicks).toEqual([]);
    expect(h.counters.processList).toBe(0);
    // 实例信息（工作区/模型）仍然带回，供 continue_task 恢复使用
    expect(result.session?.boundProjectPath).toBe(PROJECT);
  });

  it("登录/引导页（composer 未挂载）→ login_required：不发送", async () => {
    const targets = makeKimicodeTargets({ composerMissing: true });
    const result = await runM3(await m4Harness(targets));
    expect(result.needsUserKind).toBe("login_required");
    expect(result.pendingQuestion).toContain("continue_task");
    expect(targets.states.main.sendClicks).toBe(0);
  });

  it("工作区绑定失败 → setup_recovery：不发送，且明示不会向其它工作区发送任务", async () => {
    // 「最近的文件夹」为空且原生对话框不落地 → 回读不到目标工作区（fail-closed）。
    const targets = makeKimicodeTargets({ workspaces: [] });
    const result = await runM3(await m4Harness(targets));
    // endReason 沿用 M3/zcode 既有约定（绑定失败 = setup_failed），恢复语义由 needsUserKind 决定：
    // fix-loop 先看 needsUserKind 再判 hardFailure，所以状态仍落 needs_user、可 continue_task 恢复。
    expect(result.endReason).toBe("setup_failed");
    expect(result.needsUserKind).toBe("setup_recovery");
    expect(result.pendingQuestion).toContain("工作区绑定回读不一致");
    expect(result.pendingQuestion).toContain("请在 Kimi Code 中确认目标工作区后调用 continue_task");
    expect(result.pendingQuestion).toContain("不会向其它工作区发送任务");
    expect(targets.states.main.sendClicks).toBe(0);
    expect(targets.states.main.clicks).not.toContain("send");
  });

  it("提问检测命中 → agent_question：带回完整问题原文且保留实例", async () => {
    const targets = makeKimicodeTargets({
      workspaces: M3_PROJECT_WORKSPACES,
      pollScript: [
        { stopVisible: true, sendStarting: true },
        { stopVisible: false, sendStarting: false, conversation: "用户任务书Kimi 已完成依赖安装" },
        {
          stopVisible: false,
          sendStarting: false,
          conversation: "用户任务书Kimi 已完成依赖安装，是否继续执行数据库迁移？",
        },
      ],
    });
    // 提问检测默认关闭：只有配置了 gui.selectors.userGate 才启用（本用例只配置、不让它命中）
    const result = await runM3(
      await m4Harness(targets, { gui: { selectors: { userGate: "[class*='ask-card']" } } }),
    );
    expect(result.endReason).toBe("needs_user");
    expect(result.needsUserKind).toBe("agent_question");
    expect(result.pendingQuestion).toContain("是否继续执行数据库迁移？");
    expect(result.pendingQuestion).toContain("continue_task");
    expect(result.session?.id).toBe("s-new");
    expect(result.keptInstance).toBe(true);
  });
});

describe("Kimi Code M4 continue_task 恢复", () => {
  const QUESTION_SEED = "用户任务书Kimi 已完成依赖安装，是否继续执行数据库迁移？";

  /**
   * 真机教训（Codex 同款）：上一轮失败/取消留下的「添加工作区」模态框会吞掉主窗口点击，
   * 让下一轮把「点新建会话毫无反应」误判成选择器失效。启动时必须先清掉自己 pid 的残留对话框。
   */
  it("启动时按实例 pid 清理残留原生对话框（模态框会吞掉主窗口点击）", async () => {
    const targets = makeKimicodeTargets({
      workspaces: M3_PROJECT_WORKSPACES,
      pollScript: [{ stopVisible: true, sendStarting: true }, { stopVisible: false, sendStarting: false }],
    });
    const seen: number[][] = [];
    const result = await runM3(
      await m3Harness(targets, {
        deps: {
          closeDialogs: async (pids) => {
            seen.push(pids);
            return 1;
          },
        },
      }),
    );
    expect(result.ok).toBe(true);
    // 必须用受管实例的 pid（4242），不能空集也不能拿别的进程去关。
    expect(seen).toEqual([[4242]]);
  });

  it("agent_question 恢复：回答写进原会话（不重发任务书）并观察至完成", async () => {
    const targets = makeKimicodeTargets({
      url: "app://renderer/sessions/s-1",
      draft: false,
      sessions: [{ id: "s-1", title: "Kimi 提问会话" }],
      conversation: QUESTION_SEED,
      pollScript: [
        { stopVisible: true, sendStarting: true },
        {
          stopVisible: false,
          sendStarting: false,
          conversation: `${QUESTION_SEED}是，请继续执行迁移Kimi 迁移已完成`,
        },
        { stopVisible: false, sendStarting: false },
      ],
    });
    const result = await runM3(
      await m4Harness(targets, {
        gui: { selectors: { userGate: "[class*='ask-card']" } },
        ctx: {
          round: 1,
          resume: {
            kind: "continue",
            sendMessage: true,
            message: "是，请继续执行迁移",
            sessionId: "s-1",
            sessionTitle: "Kimi 提问会话",
          },
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.endReason).toBe("reply_stable");
    expect(result.session?.id).toBe("s-1");
    // 发送内容 = 标记 + 回答：**不含任务书、上下文与引用**（不重发任务书）
    const sent = sentText(targets, QUESTION_SEED);
    expect(sent).toContain("是，请继续执行迁移");
    expect(sent).not.toContain("完成开发");
    expect(sent).not.toContain("【上下文与约束】");
    expect(targets.states.main.sendClicks).toBe(1);
    // 定位走 URL（当前会话就是它），没有点侧栏、也没有新建草稿
    expect(targets.states.main.clicks).not.toContain("new-session");
  });

  it("user_confirmation 恢复：用户确认文本不发给模型（发送次数为 0），重连观察后完成", async () => {
    // 被观察的 turn 复检前已暂停；用户在 Kimi Code 里处理后 turn 已自行继续并完成。
    // 重观察轮不发送任何消息 → 假 CDP 的 pollScript 不会被消费（依赖 sendClicks>0），
    // 所以这里直接让界面处于「已完成」状态，观察环靠 stableRounds 收敛到 finished。
    const conversation = "用户任务书Kimi 用户确认后已继续执行并完成迁移";
    const targets = makeKimicodeTargets({
      url: "app://renderer/sessions/s-1",
      draft: false,
      sessions: [{ id: "s-1", title: "Kimi 等待确认" }],
      conversation,
      userGateVisible: false,
    });
    const result = await runM3(
      await m4Harness(targets, {
        gui: { selectors: { userGate: "[class*='ask-card']" } },
        ctx: {
          round: 1,
          resume: {
            kind: "continue",
            sendMessage: false,
            reobserve: true,
            message: "已处理",
            sessionId: "s-1",
            sessionTitle: "Kimi 等待确认",
          },
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.endReason).toBe("reply_stable");
    // 关键断言：一次都没发送，输入框也没被写过（确认文本绝不发给模型）
    expect(targets.states.main.sendClicks).toBe(0);
    expect(targets.states.main.clicks).not.toContain("send");
    expect(targets.states.main.inputText).toBe("");
    expect(targets.states.main.conversation).not.toContain("已处理");
    // 重观察不改模型/执行模式（正在进行的 turn 不允许被打断）
    expect(targets.states.main.clicks).not.toContain("model-pill");
    expect(targets.states.main.clicks).not.toContain("permission-pill");
  });

  it("close_existing_instance 恢复：环境复检通过后补发完整任务书（含上下文），确认文本不发送", async () => {
    const targets = makeKimicodeTargets({
      workspaces: M3_PROJECT_WORKSPACES,
      // 无锚点恢复 = 全新派发并发任务书；pollScript 不覆盖 conversation（保留已发送的任务书）
      pollScript: [{ stopVisible: true, sendStarting: true }, { stopVisible: false, sendStarting: false }],
    });
    const h = await m4Harness(targets, {
      ctx: {
        context: "上下文约束X：不要改动 tianshu-mcp-web 目录",
        resume: { kind: "continue", sendMessage: false, message: "已关闭旧窗口" },
      },
    });
    const result = await runM3(h);
    expect(result.ok).toBe(true);
    expect(result.endReason).toBe("reply_stable");
    const sent = sentText(targets, "");
    // 补发完整任务书 + 上下文（与初始派发一致）
    expect(sent).toContain("完成开发");
    expect(sent).toContain("【上下文与约束】");
    expect(sent).toContain("上下文约束X：不要改动 tianshu-mcp-web 目录");
    // 用户确认文本只作「已处理」说明，绝不发给模型
    expect(sent).not.toContain("已关闭旧窗口");
    expect(targets.states.main.sendClicks).toBe(1);
    expect(targets.states.main.clicks).toContain("new-session");
  });

  it("返修轮（rework）：唯一定位原会话 → 回读模型/执行模式 → 发送返修消息", async () => {
    const seed = "用户任务书Kimi 上一轮回复完成";
    const targets = makeKimicodeTargets({
      url: "app://renderer/sessions/s-1",
      draft: false,
      sessions: [{ id: "s-1", title: "Kimi 返修会话" }],
      conversation: seed,
      // 不覆盖 conversation：保留发送的返修消息（任务书 + 自动验收返修）
      pollScript: [{ stopVisible: true, sendStarting: true }, { stopVisible: false, sendStarting: false }],
    });
    const result = await runM3(
      await m4Harness(targets, {
        ctx: {
          round: 1,
          feedback: "验收失败：tests/foo.test.ts 断言失败",
          resume: {
            kind: "rework",
            sendMessage: true,
            sessionId: "s-1",
            sessionTitle: "Kimi 返修会话",
          },
        },
      }),
    );
    expect(result.ok).toBe(true);
    const sent = sentText(targets, seed);
    // 返修消息 = 任务书 + 【自动验收返修】反馈（追加到原会话）
    expect(sent).toContain("完成开发");
    expect(sent).toContain("【自动验收返修】");
    expect(sent).toContain("验收失败：tests/foo.test.ts 断言失败");
    expect(targets.states.main.clicks).not.toContain("new-session");
    expect(targets.states.main.sendClicks).toBe(1);
  });

  it("原会话定位不到 → session_lost 硬失败，且未发送任何消息", async () => {
    const targets = makeKimicodeTargets({
      url: "app://renderer/sessions/s-other",
      draft: false,
      sessions: [{ id: "s-other", title: "别的会话" }],
      conversation: "用户任务书Kimi 旧回复",
    });
    const result = await runM3(
      await m4Harness(targets, {
        ctx: {
          round: 1,
          resume: {
            kind: "continue",
            sendMessage: true,
            message: "是",
            sessionId: "s-1",
            sessionTitle: "已不存在的会话",
          },
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.hardFailure).toBe(true);
    expect(result.endReason).toBe("session_lost");
    expect(result.error).toContain("无法唯一定位原 Kimi Code 会话");
    // 绝不退化打开最近会话，也绝不发送
    expect(targets.states.main.sendClicks).toBe(0);
    expect(targets.states.main.clicks).not.toContain("session:0");
    expect(targets.states.main.clicks).not.toContain("send");
  });

  it("恢复轮缺会话定位信息 → session_lost（拒绝打开最近会话）", async () => {
    const targets = makeKimicodeTargets({ workspaces: M3_PROJECT_WORKSPACES });
    const result = await runM3(
      await m4Harness(targets, {
        ctx: { round: 1, resume: { kind: "continue", sendMessage: true, message: "是" } },
      }),
    );
    expect(result.endReason).toBe("session_lost");
    expect(result.error).toContain("缺少原 Kimi Code 会话定位信息");
    expect(targets.states.main.sendClicks).toBe(0);
  });
});

describe("Kimi Code M4 取消真停与重派护栏", () => {
  it("取消后点击停止按钮并确认消失 → aborted + guiStop.idle=true", async () => {
    const targets = makeKimicodeTargets({
      workspaces: M3_PROJECT_WORKSPACES,
      pollScript: [{ stopVisible: true, sendStarting: true }],
      stopStopsOnClick: true,
    });
    // 第 4 次 poll 已在观察环内（护栏 1 + 基线 1 + 发送确认 1 之后）：此时取消
    const h = await m4Harness(targets, {
      gui: { cancelWaitMs: 500 },
      onPoll: (count) => {
        if (count === 4) h.controller.abort();
      },
    });
    const result = await runM3(h);
    expect(result.killed).toBe(true);
    expect(result.endReason).toBe("aborted");
    expect(result.keptInstance).toBe(true);
    expect(targets.states.main.clicks).toContain("stop-button");
    expect(result.guiStop).toEqual({ clicked: true, idle: true });
    expect(result.progressSummary).toContain("GUI 内运行已停止");
  });

  it("停止按钮点击未生效（未确认消失）→ guiStop.idle=false 且文案明示任务可能仍在继续", async () => {
    const targets = makeKimicodeTargets({
      workspaces: M3_PROJECT_WORKSPACES,
      pollScript: [{ stopVisible: true, sendStarting: true }],
      // 点击被吞：运行信号不消失
      stopStopsOnClick: false,
    });
    const h = await m4Harness(targets, {
      gui: { cancelWaitMs: 500 },
      onPoll: (count) => {
        if (count === 4) h.controller.abort();
      },
    });
    const result = await runM3(h);
    expect(result.killed).toBe(true);
    expect(result.endReason).toBe("aborted");
    expect(targets.states.main.clicks).toContain("stop-button");
    expect(result.guiStop).toEqual({ clicked: true, idle: false });
    // 未确认停止必须如实说明：不得谎报已停止
    expect(result.progressSummary).toContain("Kimi Code 窗口中的任务可能仍在继续");
    expect(result.keptInstance).toBe(true);
  });

  it("重派护栏：实例上仍有运行信号且停止未生效 → instance_busy 硬失败且不发送", async () => {
    const targets = makeKimicodeTargets({
      workspaces: M3_PROJECT_WORKSPACES,
      stopVisible: true,
      sendStarting: true,
      stopStopsOnClick: false,
    });
    const result = await runM3(await m4Harness(targets, { gui: { cancelWaitMs: 500 } }));
    expect(result.ok).toBe(false);
    expect(result.hardFailure).toBe(true);
    expect(result.endReason).toBe("instance_busy");
    expect(result.error).toContain("避免新旧任务交叠");
    expect(targets.states.main.sendClicks).toBe(0);
    expect(targets.states.main.clicks).toContain("stop-button");
  });

  it("重派护栏：运行信号在点击停止后消失 → 继续正常派发", async () => {
    const targets = makeKimicodeTargets({
      workspaces: M3_PROJECT_WORKSPACES,
      stopVisible: true,
      sendStarting: true,
      stopStopsOnClick: true,
      pollScript: [
        { stopVisible: true, sendStarting: true },
        { stopVisible: false, sendStarting: false, conversation: "用户任务书Kimi 完成" },
        { stopVisible: false, sendStarting: false },
      ],
    });
    const result = await runM3(await m4Harness(targets, { gui: { cancelWaitMs: 500 } }));
    expect(result.ok).toBe(true);
    expect(result.endReason).toBe("reply_stable");
    expect(targets.states.main.clicks).toContain("stop-button");
    expect(targets.states.main.sendClicks).toBe(1);
  });
});