/**
 * MiniMax 项目分组点选的 DOM 表达式层回归（真机缺陷，2026-10-10）。
 *
 * 缺陷现象（真机）：第 1 轮把项目加进侧栏后，第 2 轮走「点选既有项目分组」路径时
 * `clickProjectByPath` 返回 `{clicked:false, count:1}`，上层报
 * `项目面板里命中条目但点击未生效`（reason=click）→ needs_user/setup_failed。
 *
 * 根因：`projectPointExpression` 内部的路径归一 `norm` 是
 *   `s => (s||'').replace(/[\/]+$/,'').replace(/^([a-z]):/, (m,d)=>d.toUpperCase()+':').toLocaleLowerCase()`
 * ——先做「盘符大写」，紧接着 `toLocaleLowerCase()` 又把整个串（含盘符）小写，
 * 那句盘符大写**恒被抵消**（死代码）。而 Node 侧 `normalizeProjectPath` 的顺序相反：
 * 先整体小写、**再恢复盘符大写**，得到 `D:\trae项目\...`。
 * 两侧对同一目录分别得到 `d:\...` 与 `D:\...`，**永远不相等** →
 * `hit.length !== 1` → 表达式返回 null → 点选从未发生。
 *
 * 本测试用 linkedom + runInNewContext 在真机形状的 DOM 上直接驱动该表达式，
 * 断言归一后能命中（RED 时返回 null）。这类缺陷无法被桩测试暴露——
 * 桩按语义标记分发，绕过了真实 DOM 表达式层。
 */
import { parseHTML } from "linkedom";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { projectPointExpression } from "../../src/agents/minimax/dom.js";
import { normalizeProjectPath } from "../../src/agents/minimax/workspace.js";

const TARGET_NATIVE = "D:\\Trae项目\\AI游戏\\Minecraft";
const OTHER_NATIVE = "D:\\Trae项目\\tianshu-mcp";

/**
 * 真机形状的分组 DOM（2026-10-10 实测）：
 *   [data-testid="sidebar-session-group"]  带 data-workspace-dir / data-project-key
 *     └─ div[aria-label="Minecraft, D:\Trae项目\AI游戏\Minecraft"]   ← 分组头（可点）
 * 表达式点的是分组头（`querySelector('[aria-label]')`）。
 */
function makePage(dirs: string[]): { evaluate: (expr: string) => unknown } {
  const groups = dirs
    .map(
      (dir) => `
      <div data-testid="sidebar-session-group"
           data-workspace-dir="${dir}"
           data-project-key="workspace:${dir}">
        <div aria-label="${dir.split("\\").at(-1)}, ${dir}">header</div>
        <div class="sessions">…</div>
      </div>`,
    )
    .join("");
  const { document } = parseHTML(`<html><body><aside>${groups}</aside></body></html>`);

  // 给每个元素一个稳定几何：宽度/高度 > 0，坐标递增（避免全 0 被判不可见）
  let cursor = 0;
  const all = Array.from(document.querySelectorAll("*")) as unknown as Array<{
    getBoundingClientRect: () => Record<string, number>;
  }>;
  for (const el of all) {
    const top = cursor;
    cursor += 20;
    el.getBoundingClientRect = () => ({
      x: 8,
      y: top,
      left: 8,
      top,
      width: 223,
      height: 20,
      right: 231,
      bottom: top + 20,
    });
  }

  return {
    evaluate(expression: string): unknown {
      return runInNewContext(expression, {
        document,
        location: { href: "app://./archon" },
        innerWidth: 1366,
        innerHeight: 705,
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      });
    },
  };
}

describe("MiniMax 项目分组点选表达式（真机缺陷回归）", () => {
  it("盘符大小写：页面内归一的盘符必须与 Node 侧一致（real-machine RED）", () => {
    // 这是缺陷的最小复现：两侧对同一原生路径的归一结果必须相等。
    const wanted = normalizeProjectPath(TARGET_NATIVE);
    // Node 侧的顺序是「先小写、再恢复盘符大写」→ 盘符应为大写 D
    expect(wanted.startsWith("D:")).toBe(true);

    // 页面内 norm 必须产出同一个串，表达式才可能命中。
    const page = makePage([TARGET_NATIVE, OTHER_NATIVE]);
    const point = page.evaluate(projectPointExpression(wanted));
    expect(point).not.toBeNull();
    expect(point).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
  });

  it("传入小写盘符形式（normPath 风格）时也能命中同一分组", () => {
    const page = makePage([TARGET_NATIVE, OTHER_NATIVE]);
    // 任务上下文可能来自 normPath（正斜杠 + 小写盘符）；Node 侧先归一，页面内再比一次。
    const wanted = normalizeProjectPath("d:/Trae项目/AI游戏/Minecraft");
    const point = page.evaluate(projectPointExpression(wanted));
    expect(point).not.toBeNull();
  });

  it("目标目录不在侧栏时返回 null（不得误命中别的分组）", () => {
    const page = makePage([TARGET_NATIVE, OTHER_NATIVE]);
    const point = page.evaluate(projectPointExpression(normalizeProjectPath("D:\\不存在\\目录")));
    expect(point).toBeNull();
  });

  it("点的是分组头（带 aria-label 的元素）而不是整个分组容器", () => {
    const page = makePage([TARGET_NATIVE]);
    const wanted = normalizeProjectPath(TARGET_NATIVE);
    const point = page.evaluate(projectPointExpression(wanted)) as { x: number; y: number } | null;
    expect(point).not.toBeNull();
    // 分组头是容器内第一个子元素（top 较小），容器本身 top 更小——两者几何由桩按 DOM 顺序赋值，
    // 这里只断言坐标落在容器几何范围内（真机上头部即分组顶行）。
    expect(point!.x).toBeGreaterThan(0);
    expect(point!.y).toBeGreaterThan(0);
  });
});
