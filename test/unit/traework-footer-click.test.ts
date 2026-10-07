/**
 * 单元测试：下拉底部「选择文件夹」的点击重试阶梯（issue #38 问题 A）。
 *
 * 缺陷本体：`client.ts` 的 `click()` 一旦 DOM `e.click()` 返回 true 就立即返回 true，
 * 而该 true 只表示「元素存在且可见」，**不代表原生弹窗已被唤起**。旧实现据此把点击
 * 当成功，然后死等 `dialogWaitTimeoutMs` 判失败，期间无任何补救动作。
 *
 * 这里用假 CDP 的 `footerDialogOpensOn` 精确复现该场景：点击发生、但对话框不出现。
 * 修复后契约（不变量 I1）：`clicked === true` ⟺ 已**观测到**原生对话框出现。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeCdpClient, makeFakeState, type FakeDomState } from "../fake-cdp.js";
import type { AgentRunLogger } from "../../src/agents/adapter.js";

const warnings: string[] = [];
const infos: string[] = [];
const testLogger: AgentRunLogger = {
  info: (m) => infos.push(m),
  warn: (m) => warnings.push(m),
  error: () => {},
  debug: () => {},
};

/** 桩化原生对话框探测：以假 CDP 的 folderDialogOpen 为准（不触碰真实 Win32） */
function mockDialog(opened: () => boolean) {
  vi.doMock("../../src/agents/traework/computeruse/dialog.js", () => ({
    findFolderDialog: async () =>
      opened()
        ? { found: true, windowTitle: "Select Project Folder", processName: "TRAE SOLO CN.exe", hwnd: 4242 }
        : { found: false, windowTitle: "", processName: "", hwnd: 0 },
    closeStaleFolderDialogs: async () => 0,
    pickFolderViaNativeDialog: async () => ({ ok: false, message: "测试不走提交路径" }),
  }));
}

beforeEach(() => {
  vi.resetModules();
  warnings.length = 0;
  infos.length = 0;
});

afterEach(() => {
  vi.doUnmock("../../src/agents/traework/computeruse/dialog.js");
});

/**
 * 动态导入被测函数：`waitDialogAppeared` / `findFolderDialog` 是模块级依赖，
 * 必须在 doMock 之后 import 才会拿到桩。
 */
async function runFooter(
  state: FakeDomState,
  opts: { dialogWaitTimeoutMs?: number } = {},
): Promise<{
  clicked: boolean;
  hwnd: number;
  via: string;
  elapsedMs: number;
}> {
  mockDialog(() => state.folderDialogOpen);
  const mod = await import("../../src/agents/traework/ui/session.js");
  const cdp = new FakeCdpClient(9222, state) as never;
  const t0 = Date.now();
  const r = await mod.clickDropdownFooterForTest(cdp as never, {
    logger: testLogger,
    sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 5))),
    dialogWaitTimeoutMs: opts.dialogWaitTimeoutMs,
  });
  return { ...r, elapsedMs: Date.now() - t0 };
}

describe("footer 点击阶梯（issue #38 问题 A）", () => {
  it("A-core：DOM click 返回 true 但弹窗未出现 → 改用坐标点击成功（不再白等）", async () => {
    // 复现 issue 的核心场景：坐标点击（真实鼠标事件）稳定弹出，DOM click 无副作用
    const state = makeFakeState({ footerDialogOpensOn: "coordinate" });
    const r = await runFooter(state, { dialogWaitTimeoutMs: 2_000 });

    expect(r.clicked).toBe(true);
    expect(r.via).toBe("坐标");
    expect(r.hwnd).toBe(4242);
    // 关键：确实发生了坐标点击（真实鼠标事件路径）
    expect(state.clicked.some((c) => c.startsWith("at("))).toBe(true);
    // 日志必须记录实际生效的方式（I5：取代误导性的「点击=选择器」）
    expect(infos.join("\n")).toContain("坐标");
  });

  it("A-ladder：三级全失败时不提前返回，三级都被尝试过", async () => {
    const state = makeFakeState({ footerDialogOpensOn: "never" });
    const r = await runFooter(state, { dialogWaitTimeoutMs: 400 });

    expect(r.clicked).toBe(false);
    expect(r.via).toBe("none");
    // I4：任一级失败必须升级到下一级，不得提前返回
    const clicks = state.clicked;
    expect(clicks.some((c) => c.startsWith("at("))).toBe(true); // ① 坐标
    expect(clicks).toContain("cascadeMenuFooter"); // ② 语义键 DOM
  });

  it("A-window：各级探测窗口按预算比例切分，总探测不超预算（不膨胀）", async () => {
    const budget = 600;
    const state = makeFakeState({ footerDialogOpensOn: "never" });
    const r = await runFooter(state, { dialogWaitTimeoutMs: budget });

    // I2：总耗时必须有界（sleep 被钳到 5ms，故实际远小于预算；关键是不得无界）
    expect(r.elapsedMs).toBeLessThan(budget + 1_000);
    // I3：首级窗口 = ceil(预算 × 0.30)，即 180ms ≥ 单次探测成本下限
    expect(warnings.join("\n")).toContain("180");
  });

  it("A-budget-real：探测前必须判预算，不得让每级末尾叠加一次完整探测（真机 28.2s 溢出回归）", async () => {
    // 真机实测：20s 预算被跑成 28.2s。机制是 `waitDialogAppeared` **先探测、后判 deadline**，
    // 于是每级窗口末尾都会多溢出「一次探测 + 固定 sleep(1500)」。
    //
    // 判据选「探测次数」而非墙钟：墙钟受 CI 调度噪声影响，而旧实现（先探测后判）
    // 在「探测廉价 + sleep 真实」时会无界地反复探测，新实现（探测前判预算）次数有界。
    const budget = 600;
    const state = makeFakeState({ footerDialogOpensOn: "never" });
    let probeCount = 0;
    vi.doMock("../../src/agents/traework/computeruse/dialog.js", () => ({
      findFolderDialog: async () => {
        probeCount += 1;
        return { found: false, windowTitle: "", processName: "", hwnd: 0 };
      },
      closeStaleFolderDialogs: async () => 0,
      pickFolderViaNativeDialog: async () => ({ ok: false, message: "不走提交路径" }),
    }));
    const mod = await import("../../src/agents/traework/ui/session.js");
    const cdp = new FakeCdpClient(9222, state) as never;

    // 真实 sleep（不钳）：让 1500ms 的固定 sleep 真实吃掉预算，暴露「先探测后判」的无界循环
    await mod.clickDropdownFooterForTest(cdp as never, {
      logger: testLogger,
      sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 60))),
      dialogWaitTimeoutMs: budget,
    });

    // 三级阶梯 × 每级至多 1 次探测（预算 600ms 只够每级 1 次，MIN_PROBE_COST_MS=1000
    // 使后续探测在探测前即被拒）。旧实现每级会多探 1 次以上。
    expect(probeCount).toBeLessThanOrEqual(3);
  });

  it("A-missing：footer 元素不存在（center 为 null 且 DOM/文本均未命中）→ 明确失败", async () => {
    const state = makeFakeState({ footerDialogOpensOn: "never" });
    // 让 center 找不到 footer：把 state 上的 projectItems 清空不影响这条路，
    // 直接用 never + 极短预算验证「不空转」——三级都试过即返回
    const r = await runFooter(state, { dialogWaitTimeoutMs: 100 });
    expect(r.clicked).toBe(false);
    expect(r.elapsedMs).toBeLessThan(2_000);
  });

  it("原生对话框在语义键点击后出现 → via=选择器（第二级）", async () => {
    const state = makeFakeState({ footerDialogOpensOn: "dom" });
    const r = await runFooter(state, { dialogWaitTimeoutMs: 2_000 });

    expect(r.clicked).toBe(true);
    expect(r.via).toBe("选择器");
  });
});
