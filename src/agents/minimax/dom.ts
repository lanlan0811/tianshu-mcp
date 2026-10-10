/**
 * MiniMax Code 页面内表达式片段（主窗口 + 弹层复用），供 cdp.ts 引用。
 *
 * 设计约束（与 kimicode/dom.ts 同构）：
 * 1) 全部表达式由 selectors.ts 的 mainSpec/menuSpec + resolveFnSource 组装，本文件不另造解析器；
 * 2) 每个表达式内嵌一个形如 mm:exists 的标记注释，供测试的页面桩按语义分发。
 *    标记只描述意图、不参与页面行为：真机行为完全由标记之后的代码决定。
 * 3) 只读表达式一律无副作用；点击类表达式只返回坐标，鼠标事件由 cdp.ts 统一发出。
 * 4) 页面内代码块一律用 String.raw，块内**不得出现反引号**（会提前终止模板）。
 */
import { mainSpec, menuSpec, resolveFnSource } from "./selectors.js";

export type SelectorOverrides = Record<string, string>;

/**
 * 页面内公共 helper。以源码形式保存，使 CDP 表达式与回归测试看到同一份语义。
 * __minimaxResolve 来自 selectors.resolveFnSource()，避免各表达式各自实现元素解析。
 */
export const MINIMAX_DOM = String.raw`
${resolveFnSource()}
const mmVisible = e => {
  if (!e) return false;
  const r = e.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth)) return false;
  for (let n = e; n; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
  }
  return true;
};
const mmNorm = s => (s || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const mmText = e => ((e && (e.innerText || e.textContent)) || '').trim();
// 无障碍名优先：MiniMax Code 的模型项把真实名称放在 span.sr-only，而 innerText 是
// 「省略号分段 x2」的重复拼接（实测形如 M3.1-Flash-Preview + M3.1-Flash + -Preview），
// 拿它当模型名会精确匹配失败。顺序：aria-label -> span.sr-only -> title -> innerText。
const mmLabel = e => {
  if (!e) return '';
  const aria = e.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  const sr = e.querySelector('span.sr-only');
  if (sr && (sr.textContent || '').trim()) return (sr.textContent || '').trim();
  const title = e.getAttribute('title');
  if (title && title.trim()) return title.trim();
  return mmText(e);
};
const mmHasClass = (e, name) => (e.classList ? e.classList.contains(name) : false);
const mmResolve = (spec, onlyVisible) => __minimaxResolve(spec).filter(e => !onlyVisible || mmVisible(e));
const mmIn = (nodes, root) => nodes.filter(n => root === n || root.contains(n));
const mmPoint = e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
`;

/** 元素是否存在（可见） */
export function existsExpression(spec: string): string {
  return `(function(){${MINIMAX_DOM}/*mm:exists*/
    return mmResolve(${spec}, true).length > 0;
  })()`;
}

/** 元素可见文本（第一个可见节点） */
export function textExpression(spec: string): string {
  return `(function(){${MINIMAX_DOM}/*mm:text*/
    const nodes = mmResolve(${spec}, true);
    return nodes.length ? mmText(nodes[0]) : '';
  })()`;
}

/**
 * 元素的「可读名称」（aria-label → span.sr-only → title → innerText）。
 * 模型项的名称必须走这条路径：innerText 是重复拼接，直接读会得到错名。
 */
export function labelExpression(spec: string): string {
  return `(function(){${MINIMAX_DOM}/*mm:label*/
    const nodes = mmResolve(${spec}, true);
    return nodes.length ? mmLabel(nodes[0]) : '';
  })()`;
}

/**
 * 唯一可见目标的中心坐标。多命中返回 count>1 且不给坐标——猜一个点会点到错误的模型/档位。
 */
export function singlePointExpression(spec: string): string {
  return `(function(){${MINIMAX_DOM}/*mm:point*/
    const nodes = mmResolve(${spec}, true);
    if (nodes.length !== 1) return { count: nodes.length };
    return { count: 1, point: mmPoint(nodes[0]) };
  })()`;
}

/** trusted 坐标点击拿不到目标时的兜底：DOM click（只要求唯一挂载，不要求可见） */
export function domClickExpression(spec: string): string {
  return `(function(){${MINIMAX_DOM}/*mm:dom-click*/
    const nodes = __minimaxResolve(${spec});
    if (nodes.length !== 1) return false;
    nodes[0].click();
    return true;
  })()`;
}

/**
 * 取第一个可见匹配的坐标（不要求唯一）。
 * 用于「任取一个都成立」的语义键（如「在该项目中新建任务」每个分组各一个）。
 */
export function firstPointExpression(spec: string): string {
  return `(function(){${MINIMAX_DOM}/*mm:first-point*/
    const nodes = mmResolve(${spec}, true);
    if (!nodes.length) return { count: 0 };
    return { count: nodes.length, point: mmPoint(nodes[0]) };
  })()`;
}

/** 按可见文本/aria 精确点击（NFKC 归一后全等）；多命中即拒绝 */
export function exactMatchExpression(spec: string, value: string): string {
  return `(function(){${MINIMAX_DOM}/*mm:exact*/
    const nodes = __minimaxResolve(${spec});
    const labels = nodes.map(e => mmLabel(e));
    const available = labels.filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
    const target = mmNorm(${JSON.stringify(value)});
    const matches = nodes.filter((e, i) => labels[i] && mmNorm(labels[i]) === target && mmVisible(e));
    const result = { count: matches.length, available };
    if (matches.length !== 1) return result;
    return Object.assign({}, result, { point: mmPoint(matches[0]) });
  })()`;
}

/**
 * 点击「新建任务」：testid 挂在 kbd 上，**真正的可点击元素是祖先 button**。
 * 直接对 kbd 派发坐标点击无效（实测点不动），必须 closest('button') 后取按钮中心。
 */
export function newTaskPointExpression(overrides: SelectorOverrides = {}): string {
  return `(function(){${MINIMAX_DOM}/*mm:new-task-point*/
    const nodes = mmResolve(${mainSpec("newTask", overrides)}, true);
    if (nodes.length !== 1) return { count: nodes.length };
    const kbd = nodes[0];
    const target = kbd.closest('button') || kbd;
    return { count: 1, point: mmPoint(target) };
  })()`;
}

/**
 * 侧栏项目分组：**项目绑定的权威判据**。
 * data-workspace-dir 是完整绝对路径（实测 D:\Trae项目\tianshu-mcp），比名称匹配可靠；
 * data-project-key 形如 workspace:<dir>。
 */
export function projectGroupsExpression(overrides: SelectorOverrides = {}): string {
  return `(function(){${MINIMAX_DOM}/*mm:project-groups*/
    const groups = mmResolve(${mainSpec("sessionGroup", overrides)}, true);
    return groups.map(g => ({
      dir: g.getAttribute('data-workspace-dir') || '',
      key: g.getAttribute('data-project-key') || '',
      title: (() => { const h = g.querySelector('[aria-label]'); return h ? (h.getAttribute('aria-label') || '').trim() : ''; })(),
      active: mmHasClass(g, 'active') || mmHasClass(g, 'selected'),
    }));
  })()`;
}

/**
 * 会话项：会话 id 在 DOM 里没有显式属性（实测 sidebar-session-group 只给项目路径），
 * 因此会话锚点记为「项目路径 + 会话标题」，与 opendesign 的「续说当前会话」同构。
 */
export function sessionTitlesExpression(overrides: SelectorOverrides = {}): string {
  return `(function(){${MINIMAX_DOM}/*mm:session-titles*/
    const groups = mmResolve(${mainSpec("sessionGroup", overrides)}, false);
    if (!groups.length) return [];
    const out = [];
    const seen = new Set();
    for (const g of groups) {
      const dir = g.getAttribute('data-workspace-dir') || '';
      const rows = [...g.querySelectorAll('[role="button"],button,a,[tabindex]')]
        .map(e => (e.innerText || '').trim().replace(/\\s+/g, ' '))
        .filter(t => t && t.length < 200);
      for (const t of rows) {
        const k = dir + '\\u0000' + t;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ dir, title: t });
      }
    }
    return out;
  })()`;
}

/**
 * 输入框文本。实测 tiptap 清空后 innerHTML 仍保留空的 is-empty 段落（innerText 为空串），
 * 所以一律走 mmText（trim），调用方按「归一化后为空串」判定已清空。
 */
export function inputTextExpression(overrides: SelectorOverrides = {}): string {
  return `(function(){${MINIMAX_DOM}/*mm:input-text*/
    const nodes = mmResolve(${mainSpec("chatInput", overrides)}, true);
    return nodes.length ? mmText(nodes[0]) : '';
  })()`;
}

/** 聚焦输入框（真实输入管线 Input.insertText 的前置条件） */
export function focusInputExpression(overrides: SelectorOverrides = {}): string {
  return `(function(){${MINIMAX_DOM}/*mm:focus-input*/
    const nodes = mmResolve(${mainSpec("chatInput", overrides)}, true);
    if (!nodes.length) return false;
    nodes[0].focus();
    return true;
  })()`;
}

/**
 * 发送按钮中心坐标。
 *
 * 实测事实：发送按钮是 **DIV**（不是 button），可用性走 aria-disabled
 * （输入框空时为 "true"，有内容时为 null）。**没有 disabled 属性**——
 * 读 e.disabled 恒为 undefined，据此判断会把禁用态误判为可用。
 * 按钮禁用、被遮挡（elementFromPoint 命中非按钮节点）都不算可点击。
 */
export function sendButtonPointExpression(overrides: SelectorOverrides = {}): string {
  return `(function(){${MINIMAX_DOM}/*mm:send-point*/
    const nodes = mmResolve(${mainSpec("sendButton", overrides)}, true);
    if (nodes.length !== 1) return null;
    const e = nodes[0];
    if (e.disabled === true || e.getAttribute('aria-disabled') === 'true') return null;
    const point = mmPoint(e);
    const hit = document.elementFromPoint(point.x, point.y);
    return hit && (hit === e || e.contains(hit) || hit.contains(e)) ? point : null;
  })()`;
}

/** 发送按钮是否可用（aria-disabled 双态；发送后态可用作运行信号之一） */
export function sendStateExpression(overrides: SelectorOverrides = {}): string {
  return `(function(){${MINIMAX_DOM}/*mm:send-state*/
    const nodes = mmResolve(${mainSpec("sendButton", overrides)}, false);
    const el = nodes.filter(mmVisible)[0];
    if (!el) return { visible: false, disabled: true, count: nodes.length };
    return {
      visible: true,
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      count: nodes.length,
    };
  })()`;
}

/** 对话正文（消息列表；不要用 body，会混入侧栏与推荐位） */
export function conversationTextExpression(overrides: SelectorOverrides = {}): string {
  return `(function(){${MINIMAX_DOM}/*mm:conversation*/
    const nodes = mmResolve(${mainSpec("messageArea", overrides)}, true);
    return nodes.length ? mmText(nodes[0]) : '';
  })()`;
}

/** 主窗口是否被隐藏（窗口被遮挡/最小化 → Chromium 节流 → 合成点击不可靠） */
export function pageHiddenExpression(): string {
  return `(function(){/*mm:page-hidden*/
    return document.visibilityState === 'hidden';
  })()`;
}

/**
 * 弹层菜单是否**打开**（有内容渲染）。
 *
 * **刻意不用 `document.visibilityState`**：真机实测该窗口在菜单关闭时**仍为 `visible`**
 * （窗口常驻、只是内容被清空——与 Kimi Code 的 overlay 语义相反）。
 * 用 visibility 判定的后果：`dismissMenus` 永远认为菜单还开着，向它连发 Esc，
 * 而每次 Esc 都会把**主窗口**的菜单状态搞乱。权威判据是「有 `role=menu` 且在渲染内容」。
 */
export function menuOpenExpression(): string {
  return `(function(){/*mm:menu-open*/
    const menus = [...document.querySelectorAll('[role="menu"]')];
    return menus.some(m => (m.innerText || '').trim().length > 0 || m.querySelector('button,[role="menuitemradio"]'));
  })()`;
}

/** 主窗口内当前可见的菜单/对话框数量（dismissMenus 用） */
export function menuOpenCountExpression(): string {
  return `(function(){${MINIMAX_DOM}/*mm:menu-count*/
    return [...document.querySelectorAll('[role="menu"],[role="dialog"]')].filter(mmVisible).length;
  })()`;
}

/* ------------------------------ 弹层窗口（Model menu） ------------------------------ */

/**
 * 模型候选：名称（aria-label -> span.sr-only）+ 是否当前项 + **是否带子菜单** + 坐标。
 *
 * hasPopup 是选模型路径的分叉点：只有带 aria-haspopup="menu" 的项能展开
 * 推理等级/上下文窗口二级子菜单；不带子菜单的项（实测 M2.7-highspeed / M2.7）
 * 只能直接选，且**读不到档位集合**——因此「指定了 reasoningLevel 但模型无子菜单」
 * 必须在发送前响亮报错，绝不能静默沿用界面当前档。
 */
export function menuModelItemsExpression(overrides: SelectorOverrides = {}): string {
  return `(function(){${MINIMAX_DOM}/*mm:menu-model-items*/
    const items = mmResolve(${menuSpec("modelOption", overrides)}, false);
    return items.map(e => {
      const r = e.getBoundingClientRect();
      return {
        name: mmLabel(e),
        current: e.getAttribute('aria-checked') === 'true',
        hasPopup: e.getAttribute('aria-haspopup') === 'menu',
        expanded: e.getAttribute('aria-expanded') === 'true',
        point: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
      };
    });
  })()`;
}

/** 模型菜单是否已渲染出候选（点击触发器后的后置条件，不能只看窗口是否存在） */
export function menuModelReadyExpression(overrides: SelectorOverrides = {}): string {
  return `(function(){${MINIMAX_DOM}/*mm:menu-model-ready*/
    return mmResolve(${menuSpec("menuRoot", overrides)}, false).length > 0
      && mmResolve(${menuSpec("modelOption", overrides)}, false).length > 0;
  })()`;
}

/**
 * 二级子菜单是否已展开**且属于指定模型**。
 *
 * 两个判据缺一不可（真机实测教训）：
 * 1) **归属**：子菜单根是第二个 `role="menu"`，其 `aria-label` 恰为目标模型名
 *    （实测顶层是「选择模型」、子菜单是 `"M3"` / `"M3.1-Flash-Preview"`）。
 *    只检查「有 group」会读到**上一个悬停模型残留的 DOM**——子菜单容器是复用的，
 *    移开再移入时内容会短暂保留旧值，据此选档位会选到别的模型的档位集合。
 * 2) **内容**：子菜单里至少渲染出一个 group（上下文窗口或推理等级）——
 *    空 `<div role=menu>` 会先出现、稍后才填充。
 *
 * 另外：**不是每个模型都有推理等级组**。实测 `M3` / `deepseek-v4.1-flash` 只有上下文窗口组，
 * `M3.1-Flash-Preview` 才两组都有。所以 `wants` 只约束归属，不要求某个组必须存在
 * （档位缺失由调用方的 assertLevelSupported 按空集合 fail-closed）。
 */
export function submenuOpenExpression(model: string): string {
  return `(function(){${MINIMAX_DOM}/*mm:submenu-open*/
    const target = mmNorm(${JSON.stringify(model)});
    const menus = [...document.querySelectorAll('[role="menu"]')];
    const sub = menus.filter(m => mmNorm(m.getAttribute('aria-label') || '') === target);
    if (sub.length !== 1) return false;
    const root = sub[0];
    const ctx = root.querySelectorAll('[data-testid="model-context-control"]').length;
    const effort = root.querySelectorAll('[role="group"][aria-label]').length;
    return ctx > 0 || effort > 0;
  })()`;
}

/** 二级子菜单的当前归属模型名（诊断用：与目标不符时如实报出实际值） */
export function submenuOwnerExpression(): string {
  return `(function(){${MINIMAX_DOM}/*mm:submenu-owner*/
    const menus = [...document.querySelectorAll('[role="menu"]')];
    const subs = menus.filter(m => mmNorm(m.getAttribute('aria-label') || '') !== mmNorm('选择模型'));
    return subs.length ? (subs[0].getAttribute('aria-label') || '') : '';
  })()`;
}

/**
 * 菜单诊断快照（真机缺陷，2026-10-10）。
 *
 * 动机：`hoverModel` 观察期内失败的现场**没有可诊断信息**——日志只留
 * `hoverModel elapsed=9630ms`，无法区分「菜单没开」「开的是别的窗口」「子菜单渲染了但归属不对」
 * 「子菜单容器为空」这四种情况，只能靠重跑猜。本表达式一次性把判定所需的全部事实取回。
 *
 * 返回（全部为纯读取，无副作用）：
 * - `menus`：当前文档里每个 `[role="menu"]` 的 aria-label 与两个组的渲染计数；
 * - `targetMenuCount`：aria-label 恰等于目标模型名的菜单数（`submenuOpenExpression` 要求 ===1）；
 * - `topLevelCount`：aria-label 为「选择模型」的菜单数（顶层菜单）；
 * - `hoverPointFound`：目标模型项是否能算出悬停坐标（false = 该项没渲染/多命中）。
 */
export function menuDiagnosticsExpression(
  model: string,
  overrides: SelectorOverrides = {},
): string {
  return `(function(){${MINIMAX_DOM}/*mm:menu-diagnostics*/
    const target = mmNorm(${JSON.stringify(model)});
    const menus = [...document.querySelectorAll('[role="menu"]')];
    const describe = m => ({
      label: m.getAttribute('aria-label') || '',
      contexts: m.querySelectorAll('[data-testid="model-context-control"]').length,
      effortGroups: m.querySelectorAll('[role="group"][aria-label]').length,
    });
    const found = mmResolve(${menuSpec("modelOption", overrides)}, false)
      .filter(e => mmNorm(mmLabel(e)) === target);
    return {
      menus: menus.map(describe),
      targetMenuCount: menus.filter(m => mmNorm(m.getAttribute('aria-label') || '') === target).length,
      topLevelCount: menus.filter(m => mmNorm(m.getAttribute('aria-label') || '') === mmNorm('选择模型')).length,
      hoverPointFound: found.length === 1,
      modelOptionCount: mmResolve(${menuSpec("modelOption", overrides)}, false).length,
      menuRootCount: mmResolve(${menuSpec("menuRoot", overrides)}, false).length,
    };
  })()`;
}

/** 二级子菜单里的推理等级候选（标签 + 是否当前档 + 坐标）。**限定在目标模型的子菜单内** */
export function effortOptionsExpression(model: string, overrides: SelectorOverrides = {}): string {
  return `(function(){${MINIMAX_DOM}/*mm:effort-options*/
    const target = mmNorm(${JSON.stringify(model)});
    const parts = ${menuSpec("effortOption", overrides)};
    const roots = [...document.querySelectorAll('[role="menu"]')].filter(m => mmNorm(m.getAttribute('aria-label') || '') === target);
    if (roots.length !== 1) return [];
    const items = __minimaxResolve(parts).filter(e => roots[0].contains(e));
    return items.map(e => {
      const r = e.getBoundingClientRect();
      return {
        // 推理等级 button **没有 aria-label**：标签在 span 里，mmLabel 会回退到 innerText。
        label: mmLabel(e),
        current: e.getAttribute('aria-checked') === 'true',
        point: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
      };
    });
  })()`;
}

/** 二级子菜单里的上下文窗口候选。**限定在目标模型的子菜单内**（理由同 effortOptionsExpression） */
export function contextOptionsExpression(model: string, overrides: SelectorOverrides = {}): string {
  return `(function(){${MINIMAX_DOM}/*mm:context-options*/
    const target = mmNorm(${JSON.stringify(model)});
    const parts = ${menuSpec("contextOption", overrides)};
    const tags = ${menuSpec("higherUsageTag", overrides)};
    const roots = [...document.querySelectorAll('[role="menu"]')].filter(m => mmNorm(m.getAttribute('aria-label') || '') === target);
    if (roots.length !== 1) return [];
    const items = __minimaxResolve(parts).filter(e => roots[0].contains(e));
    const tagNodes = __minimaxResolve(tags);
    return items.map(e => {
      const r = e.getBoundingClientRect();
      return {
        // 上下文窗口 button **有 aria-label**（就是候选文本），mmLabel 直接命中。
        label: mmLabel(e),
        current: e.getAttribute('aria-checked') === 'true',
        higherUsage: tagNodes.some(t => e.contains(t)),
        point: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
      };
    });
  })()`;
}

/**
 * 按完整路径唯一点选项目分组的中心坐标（分组是容器：点它的头部才是切换项目的语义）。
 *
 * `wanted` 由 Node 侧用 normalizeProjectPath 归一后传入，页面内只做同样的词法归一并比较，
 * 避免两处各写一套归一逻辑产生分歧（与 Kimi Code 的 clickWorkspaceByPath 同一思路）。
 *
 * 注意：归一顺序必须与 Node 侧 `normalizeProjectPath` **逐字一致**（真机缺陷，2026-10-10）：
 * 先整体 `toLocaleLowerCase()`，**再**把盘符恢复成大写。
 * 旧实现写成「先盘符大写、后整体小写」——后一步把盘符又压回小写，
 * 那句盘符大写恒被抵消（死代码），页面侧得 `d:\...` 而 Node 侧得 `D:\...`，
 * 两侧**永不相等** → 点选从未发生 → 上层报「命中条目但点击未生效」。
 */
export function projectPointExpression(
  wanted: string,
  overrides: SelectorOverrides = {},
): string {
  return `(function(){${MINIMAX_DOM}/*mm:project-point*/
    const target = ${JSON.stringify(wanted)};
    // 与 Node 侧 normalizeProjectPath 同序：先去尾部分隔符 → 整体小写 → 恢复盘符大写。
    const norm = s => (s || '').replace(/[\\/]+$/, '').toLocaleLowerCase().replace(/^([a-z]):/, (m, d) => d.toUpperCase() + ':');
    const groups = __minimaxResolve(${mainSpec("sessionGroup", overrides)});
    const hit = groups.filter(g => norm(g.getAttribute('data-workspace-dir') || '') === target);
    if (hit.length !== 1) return null;
    const header = hit[0].querySelector('[aria-label]') || hit[0];
    return mmPoint(header);
  })()`;
}

/**
 * 「创建项目」**应用内模态框**相关表达式（真机实测：点「新建项目」先弹它，不直接弹原生对话框）。
 *
 * 模态框判据是 `.responsive-modal-mask` **且内含「创建项目」标题**——
 * 只看 mask 会把其它模态（如引导页）当成创建项目框。
 */
export function modalOpenExpression(): string {
  return `(function(){/*mm:modal-open*/
    const masks = [...document.querySelectorAll('.responsive-modal-mask')];
    return masks.some(m => (m.innerText || '').includes('创建项目'));
  })()`;
}

/** 模态框全文（诊断：文件夹行是否已回填路径） */
export function modalProjectExpression(): string {
  return `(function(){/*mm:modal-text*/
    const masks = [...document.querySelectorAll('.responsive-modal-mask')];
    const hit = masks.find(m => (m.innerText || '').includes('创建项目'));
    return hit ? (hit.innerText || '').replace(/\s+/g, ' ').trim() : '';
  })()`;
}

/**
 * 模态框里「选择文件夹」按钮的中心坐标。
 *
 * 只认**按钮内文本以「选择文件夹」开头**的元素：该行还有快捷键提示（Ctrl+O），
 * 用全等匹配会漏；用「包含」会同时命中标题「选择文件夹以创建项目」，故用 startsWith。
 */
export function modalChooseFolderPointExpression(): string {
  return `(function(){/*mm:modal-choose-folder*/
    const masks = [...document.querySelectorAll('.responsive-modal-mask')];
    const modal = masks.find(m => (m.innerText || '').includes('创建项目'));
    if (!modal) return null;
    const btns = [...modal.querySelectorAll('button,[role="button"]')];
    const hit = btns.filter(b => (b.innerText || '').trim().startsWith('选择文件夹'));
    if (hit.length !== 1) return null;
    const r = hit[0].getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`;
}

/** 模态框里「创建项目」提交按钮的中心坐标（最后一步） */
export function modalSubmitPointExpression(): string {
  return `(function(){/*mm:modal-submit*/
    const masks = [...document.querySelectorAll('.responsive-modal-mask')];
    const modal = masks.find(m => (m.innerText || '').includes('创建项目'));
    if (!modal) return null;
    const btns = [...modal.querySelectorAll('button,[role="button"]')];
    // 「创建项目」既是标题也是提交按钮文案：取**非取消**且文本恰为「创建项目」的按钮。
    const hit = btns.filter(b => (b.innerText || '').trim() === '创建项目');
    if (hit.length !== 1) return null;
    const r = hit[0].getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`;
}

/** 悬停某个模型项的中心坐标（悬停以展开二级子菜单）；cdp.ts 用鼠标事件派发 */
export function hoverPointExpression(name: string, overrides: SelectorOverrides = {}): string {
  return `(function(){${MINIMAX_DOM}/*mm:hover-point*/
    const target = mmNorm(${JSON.stringify(name)});
    const items = mmResolve(${menuSpec("modelOption", overrides)}, false);
    const matches = items.filter(e => mmNorm(mmLabel(e)) === target);
    if (matches.length !== 1) return { count: matches.length, available: items.map(e => mmLabel(e)).filter(Boolean) };
    return { count: 1, point: mmPoint(matches[0]) };
  })()`;
}

/**
 * 单次轮询的全部运行信号。**一次求值**是刻意的：分多次求值会把不同瞬间的状态
 * 拼成一个自相矛盾快照，进而把长思考误判成完成。
 *
 * stopVisible 用产物提取的 stop-button（真机发送后态未复验 → 缺失时三信号自动降级）。
 */
export function pollExpression(overrides: SelectorOverrides = {}): string {
  return `(function(){${MINIMAX_DOM}/*mm:poll*/
    const stop = mmResolve(${mainSpec("stopButton", overrides)}, true);
    const sendNodes = mmResolve(${mainSpec("sendButton", overrides)}, false);
    const retry = mmResolve(${mainSpec("errorRetryButton", overrides)}, true);
    const gate = mmResolve(${mainSpec("userGate", overrides)}, true);
    const question = mmResolve(${mainSpec("questionDialog", overrides)}, true);
    const busy = mmResolve(${mainSpec("busyBanner", overrides)}, true);
    const area = mmResolve(${mainSpec("messageArea", overrides)}, true);
    const input = mmResolve(${mainSpec("chatInput", overrides)}, true);
    const text = area.length ? mmText(area[0]) : '';
    const failed = /(请求失败[^\\n]{0,80}|网络异常[^\\n]{0,60}|provider\\.[a-z_]{2,}[^\\n]{0,60}|HTTP\\s*\\d{3}[^\\n]{0,60})/i.exec(text);
    const send = sendNodes.filter(mmVisible)[0];
    return {
      stopVisible: stop.length > 0,
      sendVisible: !!send,
      sendDisabled: send ? (send.disabled === true || send.getAttribute('aria-disabled') === 'true') : true,
      assistantText: text,
      errorText: failed ? failed[0].trim() : '',
      retryVisible: retry.length > 0,
      userGateVisible: gate.length > 0,
      questionVisible: question.length > 0,
      busyVisible: busy.length > 0,
      inputText: input.length ? mmText(input[0]) : '',
      sendEnabled: !!send && send.disabled !== true && send.getAttribute('aria-disabled') !== 'true',
      pageHidden: document.visibilityState === 'hidden',
    };
  })()`;
}
