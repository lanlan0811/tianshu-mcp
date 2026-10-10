/**
 * 菜单诊断快照表达式（真机缺陷加固，2026-10-10）。
 *
 * 背景：`hoverModel` 观察期内失败的现场只留 `hoverModel elapsed=9630ms`，
 * 无法区分四种可能（菜单没开 / 开的是别的窗口 / 子菜单归属不对 / 子菜单容器为空）。
 * 本表达式把判定所需的全部事实一次取回，用于失败时记日志。
 *
 * 用 linkedom + runInNewContext 在真机形状的 DOM 上驱动（与 project-point 测试同构）。
 */
import { parseHTML } from "linkedom";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { menuDiagnosticsExpression } from "../../src/agents/minimax/dom.js";

const MODEL = "M3.1-Flash-Preview";

/** 真机形状：顶层菜单（aria-label=选择模型）+ 各模型项；子菜单是第二个 role=menu，aria-label=模型名 */
function makePage(opts: {
  topLevel?: boolean;
  submenuFor?: string | null;
  submenuHasContent?: boolean;
  modelOptions?: string[];
}): { evaluate: (expr: string) => unknown } {
  const models = opts.modelOptions ?? [MODEL, "M3", "M2.7"];
  // 真机结构（selectors.ts modelOption）：`button[role="menuitemradio"][aria-haspopup="menu"]`，
  // 名称在 `span.sr-only`（项内另有 aria-hidden 分段，innerText 是重复拼接，不能用）。
  const items = models
    .map(
      (m) =>
        `<button role="menuitemradio" aria-haspopup="menu" aria-checked="false"><span aria-hidden="true">${m}</span><span class="sr-only">${m}</span></button>`,
    )
    .join("");
  const top = opts.topLevel === false ? "" : `<div role="menu" aria-label="选择模型">${items}</div>`;
  let sub = "";
  if (opts.submenuFor) {
    const content = opts.submenuHasContent === false ? "" : `<div role="group" aria-label="推理等级"></div>`;
    sub = `<div role="menu" aria-label="${opts.submenuFor}">${content}</div>`;
  }
  const { document } = parseHTML(
    `<html><body><div id="root">${top}${sub}</div></body></html>`,
  );
  return {
    evaluate(expression: string): unknown {
      return runInNewContext(expression, {
        document,
        location: { href: "file:///.../dist/model-menu/index.html" },
        innerWidth: 800,
        innerHeight: 600,
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      });
    },
  };
}

describe("MiniMax 菜单诊断快照", () => {
  it("子菜单已展开且内容就绪 → targetMenuCount=1 且 hoverPointFound", () => {
    const page = makePage({ submenuFor: MODEL });
    const diag = page.evaluate(menuDiagnosticsExpression(MODEL)) as Record<string, unknown>;
    expect(diag.targetMenuCount).toBe(1);
    expect(diag.topLevelCount).toBe(1);
    expect(diag.hoverPointFound).toBe(true);
    expect(Array.isArray(diag.menus)).toBe(true);
    const menus = diag.menus as Array<{ label: string; effortGroups: number }>;
    const sub = menus.find((m) => m.label === MODEL);
    expect(sub?.effortGroups).toBe(1);
  });

  it("子菜单归属是别的模型 → 能如实报出（targetMenuCount=0）", () => {
    const page = makePage({ submenuFor: "M3" });
    const diag = page.evaluate(menuDiagnosticsExpression(MODEL)) as Record<string, unknown>;
    expect(diag.targetMenuCount).toBe(0);
    const menus = diag.menus as Array<{ label: string }>;
    expect(menus.some((m) => m.label === "M3")).toBe(true);
  });

  it("子菜单容器存在但为空 → targetMenuCount=1 但两个组计数均为 0", () => {
    const page = makePage({ submenuFor: MODEL, submenuHasContent: false });
    const diag = page.evaluate(menuDiagnosticsExpression(MODEL)) as Record<string, unknown>;
    expect(diag.targetMenuCount).toBe(1);
    const menus = diag.menus as Array<{ label: string; contexts: number; effortGroups: number }>;
    const sub = menus.find((m) => m.label === MODEL);
    expect(sub?.contexts).toBe(0);
    expect(sub?.effortGroups).toBe(0);
  });

  it("菜单完全没开 → 计数全为 0（可区分于「归属不符」）", () => {
    const page = makePage({ topLevel: false, submenuFor: null });
    const diag = page.evaluate(menuDiagnosticsExpression(MODEL)) as Record<string, unknown>;
    expect(diag.targetMenuCount).toBe(0);
    expect(diag.topLevelCount).toBe(0);
    expect(diag.menuRootCount).toBe(0);
    expect(diag.hoverPointFound).toBe(false);
  });

  it("表达式是纯读取：执行两次结果一致（无副作用）", () => {
    const page = makePage({ submenuFor: MODEL });
    const a = page.evaluate(menuDiagnosticsExpression(MODEL));
    const b = page.evaluate(menuDiagnosticsExpression(MODEL));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
