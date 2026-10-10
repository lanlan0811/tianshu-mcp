/**
 * MiniMax 子菜单选项切换的**收敛等待**回归（真机缺陷，2026-10-10）。
 *
 * 缺陷现象（真机，8 轮定量复现 1/8 成功）：模型已匹配、需要把上下文窗口从 512K 切到 1M 时，
 * `pickOption` 点击后只等固定 `sleep(350)` 就回读，读到**旧值 512K** → 抛
 * `上下文窗口切换回读不一致：期望「1M」，实际「512K」` → `model_mismatch` 硬失败。
 *
 * 真机取证（同一轮内连续观测）：
 *   +350ms  → current = 512K   ← 旧实现据此报失败
 *   +1550ms → current = 1M     ← 实际早已切成功，只是慢
 * 即**点击生效了，回读太早**——UI 更新耗时不稳定（实测 350ms–1.5s+）。
 *
 * 这与项目既有最佳实践相悖：`focusMainWindow()` 明确用「等可见性收敛」而非固定时长
 * （注释：置前是异步生效的，实测需数百毫秒，所以以收敛为准，而不是盲等固定时长）。
 *
 * 正解：把「固定 sleep + 单次回读」改为**有界轮询至收敛**（读到目标值即返回，超时才报错）。
 */
import { describe, expect, it } from "vitest";
import {
  selectModel,
  type SelectModelArgs,
} from "../../src/agents/minimax/model-select.js";

/** 子菜单候选的最小形状（与 MinimaxContextOption 结构兼容） */
interface Opt {
  label: string;
  current: boolean;
  higherUsage?: boolean;
  point: { x: number; y: number };
}

/**
 * 可控桩：`contextOptions` 每次调用返回一份快照；点击后经过 `settleAfterReads` 次读取
 * 才把 `current` 切到目标值——复刻真机「UI 异步更新」。
 */
function makeStubCdp(opts: { settleAfterReads: number; target: string; initial: string }) {
  let current = opts.initial;
  let readsSinceClick = -1; // -1 = 尚未点击
  const calls = { clickMenuPoint: 0, contextOptions: 0, effortOptions: 0, dismissMenus: 0 };

  const snapshot = (labels: string[]): Opt[] =>
    labels.map((label, index) => ({
      label,
      current: label === current,
      higherUsage: label === "1M",
      point: { x: 340, y: 60 + index * 33 },
    }));

  return {
    calls,
    get current(): string {
      return current;
    },
    async openModelMenu(): Promise<boolean> {
      return true;
    },
    async menuModels() {
      return [{ name: "M3.1-Flash-Preview", current: true, hasPopup: true }];
    },
    async hoverModel(): Promise<boolean> {
      return true;
    },
    async submenuOwner(): Promise<string> {
      return "M3.1-Flash-Preview";
    },
    async effortOptions(): Promise<Opt[]> {
      calls.effortOptions += 1;
      return snapshot(["default", "low", "medium", "high", "xhigh", "max"]).map((o) => ({
        ...o,
        current: o.label === "high",
      }));
    },
    async contextOptions(): Promise<Opt[]> {
      calls.contextOptions += 1;
      if (readsSinceClick >= 0) {
        readsSinceClick += 1;
        if (readsSinceClick >= opts.settleAfterReads) current = opts.target;
      }
      return snapshot(["512K", "1M"]);
    },
    async clickMenuPoint(): Promise<void> {
      calls.clickMenuPoint += 1;
      readsSinceClick = 0; // 点击后开始计数：再过 N 次读取才反映新值
    },
    async clickExact() {
      return { clicked: true, count: 1, available: ["M3.1-Flash-Preview"] };
    },
    async modelTriggerText(): Promise<string> {
      return `M3.1-Flash-Preview\nhigh`;
    },
    async dismissMenus(): Promise<void> {
      calls.dismissMenus += 1;
    },
  };
}

function makeArgs(cdp: ReturnType<typeof makeStubCdp>): SelectModelArgs {
  return {
    cdp: cdp as unknown as SelectModelArgs["cdp"],
    // level/contextWindow 取真机实测值（M3.1-Flash-Preview 六档 + 512K/1M）
    spec: { model: "M3.1-Flash-Preview", level: "high", contextWindow: "1M" },
    submenuTimeoutMs: 8_000,
    menuBudget: () => 10_000,
    sleep: async () => {}, // 桩里不需要真实等待：收敛由「读取次数」表达
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as SelectModelArgs["logger"],
  };
}

describe("MiniMax 子菜单选项切换：必须等 UI 收敛，不能盲等固定时长", () => {
  it("点击后 UI 需要多次读取才收敛 → 仍应成功（真机 RED：固定 sleep 会在此失败）", async () => {
    const cdp = makeStubCdp({ settleAfterReads: 3, target: "1M", initial: "512K" });
    const outcome = await selectModel(makeArgs(cdp));
    expect(outcome.ok).toBe(true);
    expect(cdp.current).toBe("1M");
    expect(cdp.calls.clickMenuPoint).toBe(1);
    // 至少读取 3 次（收敛点）——证明是轮询而不是单次读数
    expect(cdp.calls.contextOptions).toBeGreaterThanOrEqual(3);
  });

  it("点击后立刻收敛 → 不浪费额外轮询（首读即为目标值）", async () => {
    const cdp = makeStubCdp({ settleAfterReads: 0, target: "1M", initial: "512K" });
    const outcome = await selectModel(makeArgs(cdp));
    expect(outcome.ok).toBe(true);
    expect(cdp.current).toBe("1M");
  });

  it("UI 始终不收敛 → 有界失败并保留可诊断文案（不得无限等待）", async () => {
    const cdp = makeStubCdp({ settleAfterReads: Number.POSITIVE_INFINITY, target: "1M", initial: "512K" });
    const outcome = await selectModel(makeArgs(cdp));
    expect(outcome.ok).toBe(false);
    expect(outcome.endReason).toBe("model_mismatch");
    expect(outcome.error).toContain("上下文窗口切换回读不一致");
    expect(outcome.error).toContain("1M");
  });

  it("目标已是当前值 → 不点击（短路保持）", async () => {
    const cdp = makeStubCdp({ settleAfterReads: 1, target: "1M", initial: "1M" });
    const outcome = await selectModel(makeArgs(cdp));
    expect(outcome.ok).toBe(true);
    expect(cdp.calls.clickMenuPoint).toBe(0);
  });
});
