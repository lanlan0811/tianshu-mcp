import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { runInNewContext } from "node:vm";
import {
  conversationTextExpression,
  countExpression,
  directionItemVisibleExpression,
  dismissExpression,
  exactMatchExpression,
  existsExpression,
  firstPointExpression,
  inputValueExpression,
  layoutProbeExpression,
  listLabelsExpression,
  singlePointExpression,
  textExpression,
  triggerTextExpression,
} from "../../src/agents/opendesign/dom.js";
import {
  cssCandidates,
  OPEN_DESIGN_LAYOUT_GUARD_KEYS,
  OPEN_DESIGN_SELECTORS,
  missingSelectorKeys,
  resolveFnSource,
  selectorSpec,
  specArgs,
  type OpenDesignSelectorKey,
} from "../../src/agents/opendesign/selectors.js";

/**
 * 一个**最小真机形状**的 Open Design 草稿页 fixture。
 * 选择器用 data-od 钩子代表「采集后写回 primary 的值」——测试验证的是表达式契约，
 * 不是某个具体 CSS，因此这里用稳定的钩子而不是从截图目测的类名。
 */
const FIXTURE = `
  <header><h1 data-od="title">让我们创建原型</h1></header>
  <main>
    <form data-od="composer">
      <textarea data-od="input" placeholder="为落地页设计一段"></textarea>
      <button data-od="working-dir" aria-haspopup="menu" aria-expanded="false">工作目录</button>
      <span data-od="working-dir-value">D:\\Trae项目\\tianshu-mcp</span>
      <button data-od="model" aria-haspopup="menu">v4.1-flash</button>
      <button data-od="design-system" aria-haspopup="dialog">Claude (Anthropic)</button>
      <button data-od="direction" aria-haspopup="menu">原型</button>
      <button data-od="send" type="submit" aria-label="发送">发送</button>
      <button data-od="stop" aria-label="停止" hidden>停止</button>
    </form>
    <div data-od="conversation" role="log">好的作品，从这里开始</div>
  </main>
`;

/** 采集结果：语义键 → primary 选择器（模拟 P1 采集后写回 selectors.ts 的样子） */
const CAPTURED: Record<string, string> = {
  title: '[data-od="title"]',
  composer: '[data-od="composer"]',
  inputBox: '[data-od="input"]',
  workingDirTrigger: '[data-od="working-dir"]',
  workingDirValue: '[data-od="working-dir-value"]',
  modelTrigger: '[data-od="model"]',
  designSystemTrigger: '[data-od="design-system"]',
  designDirectionTrigger: '[data-od="direction"]',
  sendButton: '[data-od="send"]',
  stopButton: '[data-od="stop"]',
  conversationText: '[data-od="conversation"]',
  selectDirItem: '[data-od="menu-item"]',
  modelMenuItem: "[data-od='model-item']",
  designSystemItem: "[data-od='ds-item']",
  designDirectionItem: "[data-od='dir-item']",
  designSystemSearch: '[data-od="ds-search"]',
};

/**
 * 执行页面内表达式。与 `zcode-dom.test.ts` 同构：linkedom 造 DOM +
 * `runInNewContext` 注入浏览器全局（innerWidth/getComputedStyle 等）。
 */
function evaluate(html: string, expression: string): unknown {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  for (const element of document.querySelectorAll("*")) {
    Object.assign(element, {
      getBoundingClientRect: () => {
        const hidden = element.closest("[hidden], [style*='display:none']");
        const top = Number(element.getAttribute("data-top") || 0);
        return {
          x: 0,
          y: top,
          left: 0,
          top,
          width: hidden ? 0 : 100,
          height: hidden ? 0 : 20,
          right: 100,
          bottom: top + 20,
        };
      },
    });
  }
  return runInNewContext(expression, {
    document,
    location: { href: "od://app/drafts", origin: "od://app" },
    innerWidth: 1366,
    innerHeight: 705,
    getComputedStyle: (e: {
      style: { display?: string; visibility?: string; opacity?: string };
    }) => ({
      display: e.style.display || "block",
      visibility: e.style.visibility || "visible",
      opacity: e.style.opacity || "1",
    }),
    KeyboardEvent: class {
      constructor(
        public type: string,
        public init: Record<string, unknown> = {},
      ) {}
    },
  });
}

describe("Open Design 选择器注册表", () => {
  it("每个键都有 primary 字段（空串 = 未采集，而非缺失字段）", () => {
    for (const [key, spec] of Object.entries(OPEN_DESIGN_SELECTORS)) {
      expect(spec, key).toHaveProperty("primary");
      expect(typeof spec.primary).toBe("string");
    }
  });

  it("回退候选不得是宽泛容器型（多命中会让坐标点击失效）", () => {
    // 真机教训：宽泛回退（如 `button`、`div[class]`）在页面元素变多后会命中多个，
    // 坐标点击拒绝执行，错误信息却只说「选择器未挂载」。这里固化成断言。
    const broad = ["button", "div", "div[class]", "li", "main", "*"];
    for (const [key, spec] of Object.entries(OPEN_DESIGN_SELECTORS)) {
      for (const fallback of spec.fallbacks ?? []) {
        expect(broad, `${key} 的回退 ${fallback}`).not.toContain(fallback.trim());
      }
    }
  });

  it("布局守卫只收「初始页面就存在」的锚点，不含运行期才出现的键", () => {
    const runtimeOnly: OpenDesignSelectorKey[] = [
      "selectDirItem",
      "modelMenuItem",
      "designSystemItem",
      "designDirectionItem",
      "designSystemSearch",
      "stopButton",
    ];
    for (const key of runtimeOnly) expect(OPEN_DESIGN_LAYOUT_GUARD_KEYS).not.toContain(key);
    // 正向：输入区与各触发器必须在守卫里
    for (const key of ["title", "composer", "inputBox", "sendButton"] as const)
      expect(OPEN_DESIGN_LAYOUT_GUARD_KEYS).toContain(key);
  });

  it("未采集时 missingSelectorKeys 报出全部守卫键（fail-closed）", () => {
    expect(missingSelectorKeys()).toEqual([...OPEN_DESIGN_LAYOUT_GUARD_KEYS]);
  });

  it("覆盖值可解除缺键（profile.gui.selectors 热修复路径）", () => {
    expect(missingSelectorKeys(CAPTURED)).toEqual([]);
    // 只覆盖一部分 → 只报剩余部分
    const partial = { ...CAPTURED };
    delete partial.sendButton;
    expect(missingSelectorKeys(partial)).toEqual(["sendButton"]);
    // 空白覆盖值不生效（否则会把守卫静默打开）
    expect(missingSelectorKeys({ ...CAPTURED, sendButton: "   " })).toEqual(["sendButton"]);
  });

  it("cssCandidates 去重且覆盖优先", () => {
    const spec = { primary: "a", fallbacks: ["b", "a"] };
    expect(cssCandidates(spec, { k: "c" }, "k")).toEqual(["c", "a", "b"]);
    expect(cssCandidates(spec)).toEqual(["a", "b"]);
  });

  it("specArgs 输出 [css, texts, ariaLabels, ariaPatterns, excludes, scope] 六元组", () => {
    const parsed = JSON.parse(
      specArgs(
        {
          primary: "p",
          fallbacks: ["f"],
          texts: ["t"],
          ariaLabels: ["a"],
          ariaPatterns: ["^x"],
          excludes: ["e"],
          scope: "s",
        },
        {},
        "k",
      ),
    );
    expect(parsed).toEqual([["p", "f"], ["t"], ["a"], ["^x"], ["e"], "s"]);
  });

  it("resolveFnSource 是可用函数源码（品牌化为 __opendesignResolve，不与 kimi 冲突）", () => {
    expect(resolveFnSource()).toContain("function __opendesignResolve");
    expect(resolveFnSource()).not.toContain("__kimicodeResolve");
    expect(() => new Function(`${resolveFnSource()}; return __opendesignResolve;`)()).not.toThrow();
  });
});

describe("Open Design 页面内表达式（真实 DOM 执行）", () => {
  it("exists / text / count 按可见性解析", () => {
    expect(evaluate(FIXTURE, existsExpression(selectorSpec("title", CAPTURED)))).toBe(true);
    expect(evaluate(FIXTURE, textExpression(selectorSpec("title", CAPTURED)))).toBe(
      "让我们创建原型",
    );
    // hidden 的停止按钮不算可见命中——这是「运行中」判据的基础
    expect(evaluate(FIXTURE, countExpression(selectorSpec("stopButton", CAPTURED)))).toBe(0);
  });

  it("单点表达式：唯一命中给坐标，多命中拒绝给坐标", () => {
    const unique = evaluate(
      FIXTURE,
      singlePointExpression(selectorSpec("sendButton", CAPTURED)),
    ) as { count: number; point?: { x: number; y: number } };
    expect(unique.count).toBe(1);
    expect(unique.point).toEqual({ x: 50, y: 10 });

    const multi = evaluate(
      `${FIXTURE}<button data-od="dup">A</button><button data-od="dup">B</button>`,
      singlePointExpression(JSON.stringify([['[data-od="dup"]']])),
    ) as { count: number; point?: unknown };
    expect(multi.count).toBe(2);
    expect(multi.point).toBeUndefined();
  });

  it("firstPoint 在多命中时仍给首个坐标并回报总数", () => {
    const res = evaluate(
      `${FIXTURE}<button data-od="dup">A</button><button data-od="dup">B</button>`,
      firstPointExpression(JSON.stringify([['[data-od="dup"]']])),
    ) as { count: number; point?: unknown };
    expect(res.count).toBe(2);
    expect(res.point).toBeDefined();
  });

  it("裸数组与 JSON 字符串两种 spec 形态都支持（防静默零命中）", () => {
    // 回归：resolver 曾只认数组，specArgs() 的 JSON 字符串被当作 css → 永远零命中
    const asString = evaluate(FIXTURE, countExpression(selectorSpec("title", CAPTURED)));
    const asArray = evaluate(FIXTURE, countExpression(JSON.stringify([[CAPTURED.title]])));
    expect(asString).toBe(1);
    expect(asArray).toBe(1);
  });

  it("exactMatch 精确匹配文本；未命中回显可见候选（不退化模糊匹配）", () => {
    const menu = `
      <div role="menu">
        <div role="menuitem" data-od="model-item">v4.1-flash</div>
        <div role="menuitem" data-od="model-item">v4-flash</div>
        <div role="menuitem" data-od="model-item">v4-pro</div>
      </div>`;
    const hit = evaluate(
      menu,
      exactMatchExpression(selectorSpec("modelMenuItem", CAPTURED), "V4.1-FLASH"),
    ) as { count: number; available: string[]; point?: unknown };
    expect(hit.count).toBe(1);
    expect(hit.point).toBeDefined();

    const miss = evaluate(
      menu,
      exactMatchExpression(selectorSpec("modelMenuItem", CAPTURED), "v5-flash"),
    ) as { count: number; available: string[] };
    expect(miss.count).toBe(0);
    expect(miss.available).toEqual(["v4.1-flash", "v4-flash", "v4-pro"]);
  });

  it("exactMatch 不做包含匹配：v4-flash 不会命中 v4.1-flash", () => {
    const menu = `<div role="menu"><div role="menuitem" data-od="model-item">v4.1-flash</div></div>`;
    const res = evaluate(
      menu,
      exactMatchExpression(selectorSpec("modelMenuItem", CAPTURED), "v4-flash"),
    ) as { count: number };
    expect(res.count).toBe(0);
  });

  it("listLabels 去重并带上限，供 fail-closed 报错回显", () => {
    const menu = `<div role="menu">
      <div role="menuitem" data-od="model-item">opus-4.8</div>
      <div role="menuitem" data-od="model-item">opus-4.8</div>
      <div role="menuitem" data-od="model-item">fable-5</div>
    </div>`;
    expect(evaluate(menu, listLabelsExpression(selectorSpec("modelMenuItem", CAPTURED)))).toEqual([
      "opus-4.8",
      "fable-5",
    ]);
  });

  it("layoutProbe 汇总锚点命中与页面文本长度", () => {
    const res = evaluate(
      FIXTURE,
      layoutProbeExpression(OPEN_DESIGN_LAYOUT_GUARD_KEYS, CAPTURED),
    ) as {
      title: string;
      anchors: Array<{ key: string; count: number; text?: string }>;
      bodyTextLength: number;
    };
    expect(res.title).toBe("");
    const byKey = Object.fromEntries(res.anchors.map((a) => [a.key, a]));
    expect(Object.keys(byKey).sort()).toEqual([...OPEN_DESIGN_LAYOUT_GUARD_KEYS].sort());
    for (const key of OPEN_DESIGN_LAYOUT_GUARD_KEYS)
      expect(byKey[key]!.count, key).toBeGreaterThan(0);
    expect(byKey.title!.text).toBe("让我们创建原型");
    expect(byKey.sendButton!.text).toBe("发送");
    expect(res.bodyTextLength).toBeGreaterThan(0);
  });

  it("layoutProbe 对缺失锚点报 count=0（selector_drift 的判据）", () => {
    // 只保留一个真实锚点 → 其余守卫键应当全部报 0
    const res = evaluate(
      `<header><h1 data-od="title">x</h1></header>`,
      layoutProbeExpression(OPEN_DESIGN_LAYOUT_GUARD_KEYS, CAPTURED),
    ) as { anchors: Array<{ key: string; count: number }> };
    const dead = res.anchors.filter((a) => a.count <= 0).map((a) => a.key);
    expect(dead).toContain("sendButton");
    expect(dead).toContain("modelTrigger");
    expect(dead).not.toContain("title");
  });

  it("坏候选不会打断整轮盘点的结构化返回（按候选逐个容错）", () => {
    // 真机意义：某条候选在 UI 改版后失效时，其余候选仍要继续尝试，
    // 且**整轮盘点不得抛错**——否则 selector_drift 的诊断信息会一起丢掉。
    // 注意：不同 DOM 引擎对畸形选择器行为不同（Chromium 抛错 / linkedom 静默），
    // 因此这里只断言「不抛错 + 返回结构完整」，不锁定具体 count。
    const res = evaluate(FIXTURE, layoutProbeExpression(["title"], { title: ":::bad(" })) as {
      anchors: Array<{ key: string; count: number; text?: string }>;
    };
    expect(res.anchors).toHaveLength(1);
    expect(res.anchors[0]!.key).toBe("title");
    expect(typeof res.anchors[0]!.count).toBe("number");
  });

  it("inputValue 读 textarea 的 value；输入框缺失时报 found=0", () => {
    const filled = FIXTURE.replace("></textarea>", ">做一个订单跟</textarea>");
    const res = evaluate(filled, inputValueExpression(CAPTURED)) as {
      found: number;
      value: string;
      length: number;
    };
    expect(res.found).toBeGreaterThan(0);
    expect(res.length).toBeGreaterThan(0);
    const empty = evaluate("<main></main>", inputValueExpression(CAPTURED)) as { found: number };
    expect(empty.found).toBe(0);
  });

  it("triggerText / conversationText 用于回读与运行检测", () => {
    expect(evaluate(FIXTURE, triggerTextExpression("modelTrigger", CAPTURED))).toBe("v4.1-flash");
    expect(evaluate(FIXTURE, triggerTextExpression("workingDirValue", CAPTURED))).toBe(
      "D:\\Trae项目\\tianshu-mcp",
    );
    const conv = evaluate(FIXTURE, conversationTextExpression(CAPTURED)) as string;
    expect(conv).toBe("好的作品，从这里开始");
    // 完全没有对话容器时返回空串（而不是抛错）
    expect(evaluate("<main></main>", conversationTextExpression(CAPTURED))).toBe("");
  });

  it("directionItemVisible 只认精确菜单文本", () => {
    const menu = `<div role="menu">
      <div role="menuitem" data-od="dir-item">原型</div>
      <div role="menuitem" data-od="dir-item">幻灯片</div>
      <div role="menuitem" data-od="dir-item">文档</div>
    </div>`;
    expect(evaluate(menu, directionItemVisibleExpression("文档", CAPTURED))).toBe(true);
    expect(evaluate(menu, directionItemVisibleExpression("网站复刻", CAPTURED))).toBe(false);
  });

  it("dismiss 派发 Escape 并回报关闭前的菜单项数量", () => {
    const menu = `<div role="menu"><div role="menuitem" data-od="model-item">v4-pro</div></div>`;
    const res = evaluate(menu, dismissExpression(CAPTURED)) as { openBefore: number };
    expect(res.openBefore).toBe(1);
  });

  it("所有表达式都是**语法有效**的 JS（防止拼串漏括号）", () => {
    const expressions: string[] = [
      existsExpression(selectorSpec("composer", CAPTURED)),
      textExpression(selectorSpec("title", CAPTURED)),
      singlePointExpression(selectorSpec("sendButton", CAPTURED)),
      firstPointExpression(selectorSpec("sendButton", CAPTURED)),
      exactMatchExpression(selectorSpec("modelMenuItem", CAPTURED), "v4-pro"),
      listLabelsExpression(selectorSpec("modelMenuItem", CAPTURED)),
      countExpression(selectorSpec("stopButton", CAPTURED)),
      inputValueExpression(CAPTURED),
      conversationTextExpression(CAPTURED),
      triggerTextExpression("designSystemTrigger", CAPTURED),
      layoutProbeExpression(OPEN_DESIGN_LAYOUT_GUARD_KEYS, CAPTURED),
      dismissExpression(CAPTURED),
      directionItemVisibleExpression("原型", CAPTURED),
    ];
    for (const expression of expressions) {
      expect(expression).toContain("od:");
      expect(() => new Function(expression), expression.slice(0, 60)).not.toThrow();
    }
    // 表达式里必须内联了 specArgs 的六元组（而不是未解析的字符串）
    expect(layoutProbeExpression(["title"], CAPTURED)).toContain('"[[\\"');
  });
});
