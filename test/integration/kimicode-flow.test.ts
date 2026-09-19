import { describe, expect, it } from "vitest";
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
import { makeKimicodeTargets, type FakeKimicodeTargets } from "../fake-cdp.js";

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
  sleep: (ms: number) => Promise<void>;
}

function hermeticDeps(overrides: Partial<DialogDeps> = {}): DialogDeps {
  return {
    // 真实 listOwnedDialogs 会外呼 PowerShell/osascript，集成测试必须隔离。
    listDialogs: async () => [],
    selectFolder: async () => ({ ok: true, message: "hermetic" }),
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
): Promise<BindResult> {
  if (!(await ensureFreshDraft(cdp, Date.now() + 200, { sleep: deps.sleep })))
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

  it("草稿建立失败：回退「在此工作区新建会话」一次后仍失败 → fail-closed，不做绑定", async () => {
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
    const result = await bindWorkspace(cdp, PROJECT, hermeticDeps(), [4242]);
    expect(result).toMatchObject({ ok: false, reason: "draft" });
    // 两个入口各点一次，且没有任何工作区点击/原生对话框副作用。
    expect(targets.states.main.clicks).toEqual(["new-session", "workspace-add-session"]);
    expect(targets.states.main.chooseFolderClicks).toBe(0);
  });

  it("主入口点不动时回退分组入口并真正建立草稿", async () => {
    const targets = makeKimicodeTargets({
      draft: false,
      draftBlocked: true,
      url: "app://renderer/sessions/s-old",
      sessions: [{ id: "s-old", title: "上一任务" }],
      workspaces: [{ name: "tianshu-mcp", path: PROJECT, active: true }],
    });
    const cdp = clientFor(targets);
    await cdp.connect();
    const result = await bindWorkspace(cdp, PROJECT, hermeticDeps(), [4242]);
    expect(result).toMatchObject({ ok: true, boundPath: PROJECT });
    expect(targets.states.main.clicks).toEqual([
      "new-session",
      "workspace-add-session",
      "workspace-chip",
      "workspace-row:0",
      "workspace-chip",
    ]);
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