/**
 * Open Design 页面内表达式片段，供 `cdp.ts` / `run.ts` 引用。
 *
 * 设计约束（与 `kimicode/dom.ts` 同构）：
 * 1) 全部表达式由 `selectors.ts` 的 `selectorSpec` / `resolveFnSource` 组装，本文件不另造解析器；
 * 2) 每个表达式内嵌形如 `od:exists` 的标记注释，供测试桩按语义分发；标记只描述意图，
 *    真机行为完全由标记之后的代码决定；
 * 3) 只读表达式一律无副作用；点击类表达式只返回**坐标**，鼠标事件由 `cdp.ts` 统一发出；
 * 4) 关键锚点缺失时返回结构化 `missing` 而不是抛错——由调用方判 `selector_drift`。
 */
import { resolveFnSource, selectorSpec, type OpenDesignSelectorKey } from "./selectors.js";

export type SelectorOverrides = Record<string, string>;

/** 语义键 → 页面内 spec（含 `gui.selectors` 覆盖）；workspace 等上层模块只认语义键 */
export function selectorSpecFor(
  key: OpenDesignSelectorKey,
  overrides: SelectorOverrides = {},
): string {
  return selectorSpec(key, overrides);
}

/**
 * 页面内公共 helper。以源码形式保存，使 CDP 表达式与回归测试看到同一份语义。
 * `__opendesignResolve` 来自 `selectors.resolveFnSource()`。
 */
export const OPEN_DESIGN_DOM = String.raw`
${resolveFnSource()}
const odVisible = e => {
  if (!e) return false;
  const r = e.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth)) return false;
  for (let n = e; n; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
  }
  return true;
};
const odNorm = s => (s || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const odText = e => ((e && (e.innerText || e.textContent)) || '').trim();
const odLeafTexts = e => [...e.querySelectorAll('*')].filter(n => !n.children.length).map(n => (n.textContent || '').trim()).filter(Boolean);
const odLabel = e => (e.getAttribute('aria-label') || e.getAttribute('data-value') || odLeafTexts(e)[0] || odText(e) || '').trim();
const odResolve = (spec, onlyVisible) => __opendesignResolve(spec).filter(e => !onlyVisible || odVisible(e));
const odPoint = e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
`;

/** 元素是否存在（可见） */
export function existsExpression(spec: string): string {
  return `(function(){${OPEN_DESIGN_DOM}/*od:exists*/
    return odResolve(${spec}, true).length > 0;
  })()`;
}

/** 元素可见文本（第一个可见节点） */
export function textExpression(spec: string): string {
  return `(function(){${OPEN_DESIGN_DOM}/*od:text*/
    const nodes = odResolve(${spec}, true);
    return nodes.length ? odText(nodes[0]) : '';
  })()`;
}

/**
 * 按可见文本/aria 精确匹配并给出点击坐标（NFKC 归一后全等）；多命中即拒绝并回显候选。
 * 与 `exactMatchExpression` 的区别：本函数直接返回 `point` 供可信点击使用，且**要求唯一**。
 */
export function exactMatchPointExpression(
  key: OpenDesignSelectorKey,
  value: string,
  overrides: SelectorOverrides = {},
): string {
  return `(function(){${OPEN_DESIGN_DOM}/*od:exact-point*/
    const nodes = __opendesignResolve(${selectorSpec(key, overrides)});
    const labels = nodes.map(e => odLabel(e));
    const available = labels.filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
    const target = odNorm(${JSON.stringify(value)});
    const matches = nodes.filter((e, i) => labels[i] && odNorm(labels[i]) === target && odVisible(e));
    const result = { count: matches.length, available };
    if (matches.length !== 1) return result;
    return Object.assign({}, result, { point: odPoint(matches[0]) });
  })()`;
}

/**
 * 唯一可见目标的中心坐标。多命中返回 count>1 且不给坐标——猜一个点会点到错误的菜单项/方向。
 */
export function singlePointExpression(spec: string): string {
  return `(function(){${OPEN_DESIGN_DOM}/*od:point*/
    const nodes = odResolve(${spec}, true);
    if (nodes.length !== 1) return { count: nodes.length };
    return { count: 1, point: odPoint(nodes[0]) };
  })()`;
}

/** 取第一个可见匹配的坐标（不要求唯一），并回报命中总数供诊断 */
export function firstPointExpression(spec: string): string {
  return `(function(){${OPEN_DESIGN_DOM}/*od:first-point*/
    const nodes = odResolve(${spec}, true);
    if (!nodes.length) return { count: 0 };
    return { count: nodes.length, point: odPoint(nodes[0]) };
  })()`;
}

/** 按可见文本/aria 精确点击（NFKC 归一后全等）；多命中即拒绝并回显候选 */
export function exactMatchExpression(spec: string, value: string): string {
  return `(function(){${OPEN_DESIGN_DOM}/*od:exact*/
    const nodes = __opendesignResolve(${spec});
    const labels = nodes.map(e => odLabel(e));
    const available = labels.filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
    const target = odNorm(${JSON.stringify(value)});
    const matches = nodes.filter((e, i) => labels[i] && odNorm(labels[i]) === target && odVisible(e));
    const result = { count: matches.length, available };
    if (matches.length !== 1) return result;
    return Object.assign({}, result, { point: odPoint(matches[0]) });
  })()`;
}

/**
 * 列出（可见的）候选项文本，供 fail-closed 报错回显与诊断。
 * 这是「未命中就报错并回显候选」这条纪律的数据来源：绝不退化成模糊匹配。
 */
export function listLabelsExpression(spec: string): string {
  return `(function(){${OPEN_DESIGN_DOM}/*od:labels*/
    const nodes = odResolve(${spec}, true);
    const labels = nodes.map(e => odLabel(e)).filter(Boolean);
    return labels.filter((v, i, a) => a.indexOf(v) === i).slice(0, 50);
  })()`;
}

/** 可见节点数量（用于区分「菜单没打开」与「文案漂移」） */
export function countExpression(spec: string): string {
  return `(function(){${OPEN_DESIGN_DOM}/*od:count*/
    return odResolve(${spec}, true).length;
  })()`;
}

/** 输入框当前值（空态判定用；ProseMirror 类富文本可能保留空节点，故一并回报长度） */
export function inputValueExpression(overrides: SelectorOverrides = {}): string {
  return `(function(){${OPEN_DESIGN_DOM}/*od:input-value*/
    const nodes = odResolve(${selectorSpec("inputBox", overrides)}, true);
    if (!nodes.length) return { found: 0, value: '', length: 0 };
    const e = nodes[0];
    const raw = ('value' in e && typeof e.value === 'string') ? e.value : odText(e);
    return { found: nodes.length, value: raw, length: raw.length };
  })()`;
}

/** 对话正文文本（运行检测的文本哈希来源） */
export function conversationTextExpression(overrides: SelectorOverrides = {}): string {
  return `(function(){${OPEN_DESIGN_DOM}/*od:conversation-text*/
    const nodes = odResolve(${selectorSpec("conversationText", overrides)}, true);
    if (!nodes.length) return '';
    return nodes.map(e => odText(e)).join('\\n');
  })()`;
}

/** 触发器上的当前值文本（模型/设计系统/设计方向/工作目录回读共用） */
export function triggerTextExpression(
  key: OpenDesignSelectorKey,
  overrides: SelectorOverrides = {},
): string {
  return `(function(){${OPEN_DESIGN_DOM}/*od:trigger-text*/
    const nodes = odResolve(${selectorSpec(key, overrides)}, true);
    if (!nodes.length) return '';
    return odText(nodes[0]);
  })()`;
}

export interface LayoutProbeEntry {
  key: string;
  /** 可见命中数；-1 = 选择器语法错误 */
  count: number;
  /** 首个可见节点的文本（截断 200 字） */
  text?: string;
}

export interface LayoutProbe {
  url: string;
  title: string;
  /** 关键锚点的存在性；key 缺失即代表页面结构变了或还没渲染完 */
  anchors: LayoutProbeEntry[];
  bodyTextLength: number;
}

/**
 * 布局守卫探针：一次性盘点全部关键锚点，返回结构化结果。
 * `run.ts` 据 `anchors` 里 count<=0 的键判 `selector_drift`——**不进任何坐标点击**。
 */
export function layoutProbeExpression(
  keys: readonly OpenDesignSelectorKey[],
  overrides: SelectorOverrides = {},
): string {
  const specs = keys.map((key) => [key, selectorSpec(key, overrides)] as const);
  return `(function(){${OPEN_DESIGN_DOM}/*od:layout-probe*/
    const specs = ${JSON.stringify(specs)};
    const anchors = specs.map(([key, spec]) => {
      let nodes = [];
      try { nodes = odResolve(spec, true); } catch (e) { return { key, count: -1, text: String(e && e.message ? e.message : e) }; }
      if (nodes.length && nodes[0].__odSpecError) return { key, count: -1, text: 'spec-error: ' + nodes[0].__odSpecError };
      const entry = { key, count: nodes.length };
      if (nodes.length) {
        const raw = odText(nodes[0]);
        entry.text = raw.length > 200 ? raw.slice(0, 200) : raw;
      }
      return entry;
    });
    return {
      url: location.href,
      title: document.title,
      anchors,
      bodyTextLength: (document.body ? (document.body.innerText || '') : '').length,
    };
  })()`;
}

/**
 * 无副作用的菜单关闭：先 Escape，再在「菜单外」点一下。
 * 键盘事件用 try/catch 包裹：它是**尽力而为**的收尾动作，构造/派发失败不应影响后续回读
 * （真实 Chromium 不会失败，但测试桩的 KeyboardEvent 实现可能不兼容）。
 */
export function dismissExpression(overrides: SelectorOverrides = {}): string {
  return `(function(){${OPEN_DESIGN_DOM}/*od:dismiss*/
    const before = odResolve(${selectorSpec("modelMenuItem", overrides)}, true).length;
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
    } catch (_) { /* 尽力而为 */ }
    return { openBefore: before };
  })()`;
}

/** 判断设计方向菜单里某一项是否可见（点击后的后置条件，不能只看菜单是否挂载） */
export function directionItemVisibleExpression(
  label: string,
  overrides: SelectorOverrides = {},
): string {
  return `(function(){${OPEN_DESIGN_DOM}/*od:direction-item-visible*/
    const nodes = odResolve(${selectorSpec("designDirectionItem", overrides)}, true);
    const target = odNorm(${JSON.stringify(label)});
    return nodes.some(e => odNorm(odLabel(e)) === target);
  })()`;
}
