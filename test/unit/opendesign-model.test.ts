import { describe, expect, it } from "vitest";
import {
  directionLabel,
  exactUiName,
  matchMenuCandidate,
  normalizeKey,
  normalizeOpenDesignDirection,
  parseTriggerValue,
  OPEN_DESIGN_DIRECTION_LABELS,
  OPEN_DESIGN_REJECTED_DIRECTIONS,
} from "../../src/agents/opendesign/model.js";

describe("Open Design 设计方向归一", () => {
  it("只接受原型/文档/网站复刻（含英文与常见同义写法）", () => {
    expect(normalizeOpenDesignDirection("原型")).toEqual({ ok: true, direction: "prototype" });
    expect(normalizeOpenDesignDirection("文档")).toEqual({ ok: true, direction: "document" });
    expect(normalizeOpenDesignDirection("网站复刻")).toEqual({ ok: true, direction: "clone" });
    expect(normalizeOpenDesignDirection("prototype")).toEqual({ ok: true, direction: "prototype" });
    expect(normalizeOpenDesignDirection("DOCUMENT")).toEqual({ ok: true, direction: "document" });
    expect(normalizeOpenDesignDirection("doc")).toEqual({ ok: true, direction: "document" });
    expect(normalizeOpenDesignDirection("clone")).toEqual({ ok: true, direction: "clone" });
    expect(normalizeOpenDesignDirection("  原型  ")).toEqual({ ok: true, direction: "prototype" });
  });

  it("UI 里存在但不允许的方向被显式拒绝（不是「未识别」）", () => {
    for (const rejected of OPEN_DESIGN_REJECTED_DIRECTIONS) {
      const result = normalizeOpenDesignDirection(rejected);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("不支持设计方向");
    }
    const slides = normalizeOpenDesignDirection("幻灯片");
    expect(slides.ok).toBe(false);
    if (!slides.ok) expect(slides.error).toContain("幻灯片");
  });

  it("空值与未知值 fail-closed，错误信息给出可操作取值", () => {
    const empty = normalizeOpenDesignDirection(undefined);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain("原型 / 文档 / 网站复刻");

    const unknown = normalizeOpenDesignDirection("随便写点什么");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain("随便写点什么");
  });

  it("方向 → 菜单文本：默认中文，profile 可覆盖", () => {
    expect(directionLabel("prototype")).toBe("原型");
    expect(directionLabel("clone")).toBe("网站复刻");
    expect(directionLabel("document", { document: "Docs" })).toBe("Docs");
    // 空覆盖值不生效（避免把标签覆盖成空串导致点不到菜单项）
    expect(directionLabel("document", { document: "   " })).toBe("文档");
    expect(OPEN_DESIGN_DIRECTION_LABELS.prototype).toBe("原型");
  });
});

describe("Open Design 菜单候选匹配", () => {
  const models = [
    { label: "v4.1-flash" },
    { label: "v4-flash" },
    { label: "v4-pro" },
    { label: "fable-5" },
    { label: "opus-4.8" },
  ];

  it("精确匹配（忽略大小写与首尾空白），返回命中的下标与文本", () => {
    expect(matchMenuCandidate(models, "v4.1-flash")).toEqual({
      ok: true,
      index: 0,
      label: "v4.1-flash",
    });
    expect(matchMenuCandidate(models, "  OPUS-4.8 ").index).toBe(4);
  });

  it("未命中时 fail-closed 并回显当前可见候选（不退化到模糊匹配）", () => {
    const result = matchMenuCandidate(models, "v5-flash");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("v5-flash");
    expect(result.error).toContain("v4.1-flash");
    expect(result.candidates).toHaveLength(5);
  });

  it("不做包含匹配：`v4-flash` 不会命中 `v4.1-flash`", () => {
    const only = [{ label: "v4.1-flash" }];
    expect(matchMenuCandidate(only, "v4-flash").ok).toBe(false);
  });

  it("空候选列表给出「没有可见候选项」，便于区分菜单没打开与文案漂移", () => {
    const result = matchMenuCandidate([], "claude");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("没有可见候选项");
  });

  it("同名多项取首个（UI 无法区分时行为稳定）", () => {
    const dup = [{ label: "Claude" }, { label: "Claude" }];
    expect(matchMenuCandidate(dup, "claude").index).toBe(0);
  });
});

describe("Open Design 回读与触发区文本", () => {
  it("normalizeKey 处理全角空格/多空格/大小写", () => {
    expect(normalizeKey("Claude\u3000(Anthropic)")).toBe("claude (anthropic)");
    expect(normalizeKey("  a   b  ")).toBe("a b");
  });

  it("exactUiName 只认完全一致，空白串一律不通过", () => {
    expect(exactUiName("Claude (Anthropic)", "claude (anthropic)")).toBe(true);
    expect(exactUiName("Claude", "Claude (Anthropic)")).toBe(false);
    expect(exactUiName("", "Claude")).toBe(false);
    expect(exactUiName(undefined, "Claude")).toBe(false);
  });

  it("parseTriggerValue 去掉装饰箭头并压缩空白", () => {
    expect(parseTriggerValue("v4.1-flash")).toBe("v4.1-flash");
    expect(parseTriggerValue("v4.1-flash ▾")).toBe("v4.1-flash");
    expect(parseTriggerValue("  原型  ▼ ")).toBe("原型");
    expect(parseTriggerValue("   ")).toBeUndefined();
    expect(parseTriggerValue(undefined)).toBeUndefined();
  });
});
