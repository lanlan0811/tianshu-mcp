/**
 * Kimi Code 页面内表达式片段（主窗口 + 浮层复用），供 cdp.ts 引用。
 *
 * 设计约束（与 zcode/dom.ts 同构）：
 * 1) 全部表达式由 selectors.ts 的 mainSpec/overlaySpec + resolveFnSource 组装，本文件不另造解析器；
 * 2) 每个表达式内嵌一个形如 `kc:exists` 的标记注释，供 test/fake-cdp.ts 的页面桩按语义分发。
 *    标记只描述意图、不参与页面行为：真机行为完全由标记之后的代码决定。
 * 3) 只读表达式一律无副作用；点击类表达式只返回坐标，鼠标事件由 cdp.ts 统一发出。
 */
import { mainSpec, resolveFnSource } from "./selectors.js";

export type SelectorOverrides = Record<string, string>;

/**
 * 页面内公共 helper。以源码形式保存，使 CDP 表达式与回归测试看到同一份语义。
 * `__kimicodeResolve` 来自 selectors.resolveFnSource()，避免各表达式各自实现元素解析。
 */
export const KIMICODE_DOM = String.raw`
${resolveFnSource()}
const kcVisible = e => {
  if (!e) return false;
  const r = e.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth)) return false;
  for (let n = e; n; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
  }
  return true;
};
const kcNorm = s => (s || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const kcText = e => ((e && (e.innerText || e.textContent)) || '').trim();
const kcLeafTexts = e => [...e.querySelectorAll('*')].filter(n => !n.children.length).map(n => (n.textContent || '').trim()).filter(Boolean);
const kcLabel = e => (e.getAttribute('aria-label') || e.getAttribute('data-value') || kcLeafTexts(e)[0] || kcText(e) || '').trim();
const kcHasClass = (e, name) => (e.classList ? e.classList.contains(name) : false);
const kcResolve = (spec, onlyVisible) => __kimicodeResolve(spec).filter(e => !onlyVisible || kcVisible(e));
const kcIn = (nodes, root) => nodes.filter(n => root === n || root.contains(n));
const kcPoint = e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
`;

/** 元素是否存在（可见） */
export function existsExpression(spec: string): string {
  return `(function(){${KIMICODE_DOM}/*kc:exists*/
    return kcResolve(${spec}, true).length > 0;
  })()`;
}

/** 元素可见文本（第一个可见节点） */
export function textExpression(spec: string): string {
  return `(function(){${KIMICODE_DOM}/*kc:text*/
    const nodes = kcResolve(${spec}, true);
    return nodes.length ? kcText(nodes[0]) : '';
  })()`;
}

/**
 * 唯一可见目标的中心坐标。多命中返回 count>1 且不给坐标——猜一个点会点到错误的会话/工作区。
 */
export function singlePointExpression(spec: string): string {
  return `(function(){${KIMICODE_DOM}/*kc:point*/
    const nodes = kcResolve(${spec}, true);
    if (nodes.length !== 1) return { count: nodes.length };
    return { count: 1, point: kcPoint(nodes[0]) };
  })()`;
}

/** trusted 坐标点击拿不到目标时的兜底：DOM click（只要求唯一挂载，不要求可见） */
export function domClickExpression(spec: string): string {
  return `(function(){${KIMICODE_DOM}/*kc:dom-click*/
    const nodes = __kimicodeResolve(${spec});
    if (nodes.length !== 1) return false;
    nodes[0].click();
    return true;
  })()`;
}

/** 按可见文本/aria 精确点击（NFKC 归一后全等）；多命中即拒绝 */
export function exactMatchExpression(spec: string, value: string): string {
  return `(function(){${KIMICODE_DOM}/*kc:exact*/
    const nodes = __kimicodeResolve(${spec});
    const labels = nodes.map(e => kcLabel(e));
    const available = labels.filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
    const target = kcNorm(${JSON.stringify(value)});
    const matches = nodes.filter((e, i) => labels[i] && kcNorm(labels[i]) === target && kcVisible(e));
    const result = { count: matches.length, available };
    if (matches.length !== 1) return result;
    return Object.assign({}, result, { point: kcPoint(matches[0]) });
  })()`;
}

/** 工作区下拉面板是否真正可见（点击后的后置条件，不能只看 DOM 是否挂载） */
export function workspacePanelOpenExpression(overrides: SelectorOverrides = {}): string {
  return `(function(){${KIMICODE_DOM}/*kc:workspace-panel-open*/
    return kcResolve(${mainSpec("workspacePanel", overrides)}, true).length > 0;
  })()`;
}

/**
 * 触发器上的工作区名。`button.ws-chip` 在发送消息后会从 composer 消失，
 * 因此这个值同时是「是否仍在草稿页」的辅助判据。
 */
export function workspaceChipTextExpression(overrides: SelectorOverrides = {}): string {
  return `(function(){${KIMICODE_DOM}/*kc:workspace-chip-text*/
    const chip = kcResolve(${mainSpec("workspaceChip", overrides)}, true);
    if (!chip.length) return '';
    const names = kcIn(kcResolve(${mainSpec("workspaceChipName", overrides)}, false), chip[0]);
    return names.length ? kcText(names[0]) : kcText(chip[0]);
  })()`;
}

/** 工作区面板条目：显示名 + **完整路径**（绑定判据）+ 是否当前选中（class `on`） */
export function workspaceItemsExpression(overrides: SelectorOverrides = {}): string {
  return `(function(){${KIMICODE_DOM}/*kc:workspace-items*/
    const rows = kcResolve(${mainSpec("workspaceRow", overrides)}, true);
    const names = kcResolve(${mainSpec("workspaceName", overrides)}, false);
    const paths = kcResolve(${mainSpec("workspacePath", overrides)}, false);
    const firstText = (list, row) => { const hit = kcIn(list, row); return hit.length ? kcText(hit[0]) : ''; };
    return rows.map(row => ({
      name: firstText(names, row) || kcText(row),
      path: firstText(paths, row),
      active: kcHasClass(row, 'on'),
    }));
  })()`;
}

/** 第 index 个可见工作区条目的中心坐标（索引按 workspaceItems 的 DOM 顺序） */
export function workspaceRowPointExpression(
  overrides: SelectorOverrides = {},
  index: number,
): string {
  return `(function(){${KIMICODE_DOM}/*kc:workspace-row-point*/
    const rows = kcResolve(${mainSpec("workspaceRow", overrides)}, true);
    const index = ${JSON.stringify(index)};
    return rows[index] ? kcPoint(rows[index]) : null;
  })()`;
}

/** 侧栏会话列表（`div.se[data-session-id]`，标题在 `span.t`） */
export function sessionsExpression(overrides: SelectorOverrides = {}): string {
  return `(function(){${KIMICODE_DOM}/*kc:sessions*/
    const items = __kimicodeResolve(${mainSpec("sessionItem", overrides)});
    const titles = __kimicodeResolve(${mainSpec("sessionTitle", overrides)});
    const out = [];
    for (const item of items) {
      const id = item.getAttribute('data-session-id') || '';
      if (!id) continue;
      const titleNodes = kcIn(titles, item);
      out.push({ id, title: (titleNodes.length ? kcText(titleNodes[0]) : kcText(item)).slice(0, 240) || undefined });
    }
    return out;
  })()`;
}

/**
 * 当前会话 id：先读主窗口 URL（`app://renderer/sessions/<id>`），再回退侧栏选中项。
 * 两条独立来源可用于交叉校验；都没有时返回 source:'none'，绝不猜「最近会话」。
 */
export function currentSessionExpression(overrides: SelectorOverrides = {}): string {
  return `(function(){${KIMICODE_DOM}/*kc:current-session*/
    const href = location.href || '';
    const matched = new RegExp('/sessions/([^/?#]+)').exec(href);
    if (matched) return { id: decodeURIComponent(matched[1]), source: 'url' };
    const items = kcResolve(${mainSpec("sessionItem", overrides)}, true);
    const active = items.filter(e => kcHasClass(e, 'on') || kcHasClass(e, 'active') || kcHasClass(e, 'is-active') || kcHasClass(e, 'is-current') || e.getAttribute('aria-current') === 'true' || e.getAttribute('aria-selected') === 'true');
    if (active.length === 1) return { id: active[0].getAttribute('data-session-id') || '', source: 'dom' };
    return { id: '', source: 'none', ambiguous: active.length > 1 };
  })()`;
}

/** 会话项：按 id 优先、其次标题（NFKC + 折叠空白归一）唯一定位并回坐标 */
export function selectSessionExpression(
  overrides: SelectorOverrides = {},
  id?: string,
  title?: string,
): string {
  return `(function(){${KIMICODE_DOM}/*kc:select-session*/
    const byId = ${JSON.stringify(id ?? "")};
    const byTitle = kcNorm(${JSON.stringify(title ?? "")});
    const items = __kimicodeResolve(${mainSpec("sessionItem", overrides)});
    const titles = __kimicodeResolve(${mainSpec("sessionTitle", overrides)});
    const titleOf = e => { const hit = kcIn(titles, e); return kcNorm(hit.length ? kcText(hit[0]) : kcText(e)); };
    const matches = items.filter(e => byId ? e.getAttribute('data-session-id') === byId : (!!byTitle && titleOf(e) === byTitle));
    if (matches.length !== 1) return { count: matches.length };
    if (!kcVisible(matches[0])) return { count: 1, hidden: true };
    return { count: 1, point: kcPoint(matches[0]) };
  })()`;
}

/**
 * 输入框文本。实测：ProseMirror 清空后 innerText 仍可能是空 `<p>`（长度 1），
 * 所以一律走 kcText（trim），调用方按「归一化后为空串」判定已清空。
 */
export function inputTextExpression(overrides: SelectorOverrides = {}): string {
  return `(function(){${KIMICODE_DOM}/*kc:input-text*/
    const nodes = kcResolve(${mainSpec("chatInput", overrides)}, true);
    return nodes.length ? kcText(nodes[0]) : '';
  })()`;
}

/** 聚焦输入框（真实输入管线 Input.insertText 的前置条件） */
export function focusInputExpression(overrides: SelectorOverrides = {}): string {
  return `(function(){${KIMICODE_DOM}/*kc:focus-input*/
    const nodes = kcResolve(${mainSpec("chatInput", overrides)}, true);
    if (!nodes.length) return false;
    nodes[0].focus();
    return true;
  })()`;
}

/**
 * 发送按钮中心坐标。按钮禁用、被遮挡（elementFromPoint 命中非按钮节点）都不算可点击——
 * 窗口被遮挡时 Chromium 会节流页面，合成事件会被吞掉，必须让调用方据此报出真因。
 */
export function sendButtonPointExpression(overrides: SelectorOverrides = {}): string {
  return `(function(){${KIMICODE_DOM}/*kc:send-point*/
    const nodes = kcResolve(${mainSpec("sendButton", overrides)}, true);
    if (nodes.length !== 1) return null;
    const e = nodes[0];
    if (e.disabled || e.getAttribute('aria-disabled') === 'true') return null;
    const point = kcPoint(e);
    const hit = document.elementFromPoint(point.x, point.y);
    return hit && (hit === e || e.contains(hit)) ? point : null;
  })()`;
}

/** 对话正文（`div.panes`；不要用 body，会混入侧栏与会话标题） */
export function conversationTextExpression(overrides: SelectorOverrides = {}): string {
  return `(function(){${KIMICODE_DOM}/*kc:conversation*/
    const nodes = kcResolve(${mainSpec("messageArea", overrides)}, true);
    return nodes.length ? kcText(nodes[0]) : '';
  })()`;
}

/** 主窗口内当前可见的菜单/对话框数量（dismissMenus 用） */
export function menuOpenCountExpression(): string {
  return `(function(){${KIMICODE_DOM}/*kc:menu-count*/
    return [...document.querySelectorAll('[role="menu"],[role="dialog"]')].filter(kcVisible).length;
  })()`;
}

/**
 * 浮层窗口是否可见。**菜单开/关的唯一权威判据**：菜单关闭时 overlay 的
 * `document.visibilityState === 'hidden'`，关闭后 DOM 可能短暂残留。
 */
export function overlayVisibleExpression(): string {
  return `(function(){/*kc:overlay-visible*/
    return document.visibilityState === 'visible';
  })()`;
}

/** 主窗口是否被隐藏（窗口被遮挡/最小化 → Chromium 节流 → 合成点击不可靠） */
export function pageHiddenExpression(): string {
  return `(function(){/*kc:page-hidden*/
    return document.visibilityState === 'hidden';
  })()`;
}