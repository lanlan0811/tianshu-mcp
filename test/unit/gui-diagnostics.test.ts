/**
 * 单元测试：GUI 选择器诊断 helper（issue #23 D7）。
 * 环境为 node，故用最小 document 桩在 vm 中执行页面表达式，验证采集/归一/格式化语义。
 */
import { describe, it, expect } from "vitest";
import vm from "node:vm";
import {
  visibleLabelsExpr,
  normalizeLabels,
  formatCandidates,
  withDiagnostics,
  DEFAULT_DIAGNOSTIC_LIMIT,
} from "../../src/agents/gui-diagnostics.js";

interface StubEl {
  aria?: string;
  text?: string;
  w?: number;
  h?: number;
}

/** 构造最小 document 桩：querySelectorAll 返回带 getAttribute/innerText/getBoundingClientRect 的元素 */
function runExpr(els: StubEl[], scope = false): unknown {
  const make = (e: StubEl) => ({
    getAttribute: (n: string) => (n === "aria-label" ? e.aria ?? null : null),
    innerText: e.text ?? "",
    textContent: e.text ?? "",
    getBoundingClientRect: () => ({ width: e.w ?? 10, height: e.h ?? 10, top: 0, left: 0, right: 10, bottom: 10 }),
  });
  const nodes = els.map(make);
  const document = {
    querySelector: (_sel: string) => nodes[0] ?? null,
    querySelectorAll: () => nodes,
  };
  const sandbox = { document, innerWidth: 1000, innerHeight: 1000, __scope: scope };
  const expr = visibleLabelsExpr({ scope: scope ? "#root" : undefined });
  return vm.runInNewContext(expr, sandbox);
}

describe("visibleLabelsExpr", () => {
  it("采集 aria-label 与可见文本，去重并归零空白", () => {
    const out = runExpr([
      { aria: "选择项目：tianshu" },
      { text: "  多   余 空白 " },
      { aria: "选择项目：tianshu" },
      { text: "" },
    ]) as string[];
    expect(out).toContain("选择项目：tianshu");
    expect(out).toContain("多 余 空白");
    // 去重：同 aria 只保留一条
    expect(out.filter((s) => s === "选择项目：tianshu")).toHaveLength(1);
  });

  it("不可见元素（宽高为 0）被过滤", () => {
    const out = runExpr([{ aria: "隐藏项", w: 0, h: 0 }, { aria: "可见项" }]) as string[];
    expect(out).toContain("可见项");
    expect(out).not.toContain("隐藏项");
  });

  it("scope 选择器不存在时返回空集（不退化到全局）", () => {
    const make = { getAttribute: () => null, innerText: "", textContent: "", getBoundingClientRect: () => ({ width: 0, height: 0 }) };
    const document = { querySelector: () => null, querySelectorAll: () => [make] };
    const expr = visibleLabelsExpr({ scope: "#no-such" });
    const out = vm.runInNewContext(expr, { document, innerWidth: 1000, innerHeight: 1000 });
    expect(out).toEqual([]);
  });

  it("页面异常时安全降级为空数组", () => {
    const document = { querySelector: () => ({ querySelectorAll: () => { throw new Error("boom"); } }), querySelectorAll: () => { throw new Error("boom"); } };
    const out = vm.runInNewContext(visibleLabelsExpr(), { document, innerWidth: 1000, innerHeight: 1000 });
    expect(out).toEqual([]);
  });
});

describe("normalizeLabels", () => {
  it("过滤非字符串、去重、截断到上限", () => {
    const raw = ["a", 1, null, "a", "b", "  ", "c"];
    expect(normalizeLabels(raw)).toEqual(["a", "b", "c"]);
    expect(normalizeLabels(Array.from({ length: 30 }, (_, i) => `x${i}`))).toHaveLength(DEFAULT_DIAGNOSTIC_LIMIT);
    expect(normalizeLabels("not-array")).toEqual([]);
  });
});

describe("formatCandidates / withDiagnostics", () => {
  it("无候选返回空串", () => {
    expect(formatCandidates([])).toBe("");
    expect(formatCandidates(undefined)).toBe("");
  });

  it("有候选产出可读后缀", () => {
    expect(formatCandidates(["选择项目：a", "添加新项目"])).toBe("；页面可见候选=[选择项目：a | 添加新项目]");
  });

  it("withDiagnostics 幂等（已含候选段不重复拼接）", () => {
    const once = withDiagnostics("未出现触发器", ["选择项目：a"]);
    expect(once).toContain("页面可见候选=[选择项目：a]");
    const twice = withDiagnostics(once, ["别的"]);
    expect(twice).toBe(once);
  });
});
