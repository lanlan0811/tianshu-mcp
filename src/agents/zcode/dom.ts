import { candidateExpr } from "./selectors.js";

/** Shared browser-side helpers. Kept as source so CDP and DOM regression tests execute identical code. */
export const ZCODE_DOM = String.raw`
const visible = e => {
  if (!e) return false;
  const r = e.getBoundingClientRect();
  let left=Math.max(0,r.left),top=Math.max(0,r.top),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom);
  for(let n=e;n;n=n.parentElement){
    const s=getComputedStyle(n);
    if(s.visibility==='hidden'||s.display==='none'||s.opacity==='0')return false;
    if(n!==e){const p=n.getBoundingClientRect();
      if(/hidden|clip|auto|scroll/.test(s.overflowX||s.overflow||'')){left=Math.max(left,p.left);right=Math.min(right,p.right);}
      if(/hidden|clip|auto|scroll/.test(s.overflowY||s.overflow||'')){top=Math.max(top,p.top);bottom=Math.min(bottom,p.bottom);}
    }
  }
  return r.width>0&&r.height>0&&right>left&&bottom>top;
};
const norm = s => (s || '').normalize('NFKC').trim().toLocaleLowerCase();
const pick = selectors => {
  for (const selector of selectors) {
    const nodes = [...document.querySelectorAll(selector)].filter(visible);
    if (nodes.length) return { node: nodes.length === 1 ? nodes[0] : null, count: nodes.length, selector };
  }
  return { node: null, count: 0, selector: '' };
};
const pathOf = e => e?.getAttribute('data-project-path') ||
  ((e?.getAttribute('data-testid') || '').startsWith('workspace-item-')
    ? e.getAttribute('data-testid').slice('workspace-item-'.length) : '');
const labelOf = e => (e.getAttribute('data-project-name') || e.textContent || '').normalize('NFKC').trim();
`;

export function projectTriggerDom(overrides: Record<string, string>): string {
  return `${ZCODE_DOM}\nconst triggerMatch = pick(${candidateExpr("projectTrigger", overrides)});
const trigger = triggerMatch.node;`;
}

export function workspaceBindingExpression(overrides: Record<string, string>): string {
  return `(function(){${projectTriggerDom(overrides)}
    if (!trigger) return {triggerText:'',projectPath:'',ambiguous:triggerMatch.count>1};
    const triggerText = labelOf(trigger);
    // A path anywhere in the sidebar is not evidence of the composer's binding.
    const explicit = pathOf(trigger) || pathOf(trigger.querySelector('[data-project-path]'));
    const rows = [...document.querySelectorAll('[data-testid^="workspace-item-"]')];
    const matches = rows.filter(e => norm(labelOf(e)) === norm(triggerText));
    const paths = [...new Set(matches.map(pathOf).filter(Boolean))];
    return {triggerText, projectPath:explicit || (paths.length===1?paths[0]:''),
      ambiguous:!explicit && paths.length>1};
  })()`;
}

export function modelSelectionExpression(overrides: Record<string, string>): string {
  return `(function(){${ZCODE_DOM}
    const found = pick(${candidateExpr("modelValue", overrides)});
    const e = found.node;
    if (!e) return {display:'',ambiguous:found.count>1};
    const ariaLabel = (e.getAttribute('aria-label') || '').trim();
    const labels = [...e.querySelectorAll('*')].filter(n => !n.children.length && visible(n) && !n.closest('[aria-hidden="true"]'));
    const texts = [...new Set(labels.map(n => (n.textContent||'').trim()).filter(t=>t && norm(t)!==norm(ariaLabel)))];
    const titled = [e,...e.querySelectorAll('[title]')].filter(n=>visible(n) && n.getAttribute('title') && !n.closest('[aria-hidden="true"]'));
    const titles = [...new Set(titled.map(n=>n.getAttribute('title').trim()).filter(t=>t && norm(t)!==norm(ariaLabel)))];
    const data = e.closest('[data-model-id],[data-model],[data-value]') ||
      e.querySelector('[data-model-id],[data-model],[data-value]') || e;
    return {display:(e.value||e.textContent||'').trim(), ariaLabel,
      visibleLabel:texts.join(''), title:titles.length===1?titles[0]:'',
      ambiguous:titles.length>1 || (texts.length>1 && !titles.length && !e.getAttribute('data-model-current-value')),
      currentValue:(e.getAttribute('data-model-current-value')||'').trim(),
      legacyInternal:(data.getAttribute('data-model-id')||data.getAttribute('data-model')||data.getAttribute('data-value')||'').trim()};
  })()`;
}

/** Read-only readiness check; a disabled or covered button is not a dispatch target. */
export function sendButtonPointExpression(overrides: Record<string, string>): string {
  return `(function(){${ZCODE_DOM}
    const found=pick(${candidateExpr("sendButton", overrides)}), e=found.node;
    if(!e || e.disabled || e.getAttribute('aria-disabled')==='true')return null;
    const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
    const hit=document.elementFromPoint(x,y);
    return hit && (hit===e || e.contains(hit)) ? {x,y} : null;
  })()`;
}

/**
 * 项目触发器结构化探测：等待与点击共用这一份就绪判据，消除「exists 说有、click 说没有」
 * （exists 只看宽高，pick 还要求该优先级层唯一且未被祖先裁剪）。
 *
 * 返回 selector / 该层匹配数 count / 全部候选命中的挂载数 mounted / 命中节点最小诊断属性，
 * 让上层区分未挂载、不可见、不唯一、禁用、遮挡与真实超时，而不是统统归成「等待超时」。
 * 只用于项目触发器；登录页等其它 exists 调用语义不变。
 */
export function projectTriggerProbeExpression(overrides: Record<string, string>): string {
  return `(function(){${ZCODE_DOM}
    const describe = e => e ? String(e.tagName || '')
      + (e.getAttribute('data-testid') ? '#' + e.getAttribute('data-testid') : '')
      + (e.getAttribute('aria-label') ? '[' + e.getAttribute('aria-label') + ']' : '') : '';
    const sels = ${candidateExpr("projectTrigger", overrides)};
    const mountedNodes = new Set();
    for (const s of sels) for (const e of document.querySelectorAll(s)) mountedNodes.add(e);
    const mounted = mountedNodes.size;
    const m = pick(sels);
    // 窗口被其他窗口完全遮挡时 Chromium 判定 occluded 并节流页面，合成点击常被吞掉——
    // 这个环境事实必须随探测结果一起回传，否则失败信息会把用户引向错误方向。
    const pageHidden = document.visibilityState === 'hidden';
    const base = { selector: m.selector, count: m.count, mounted, ready: false, pageHidden };
    if (!mounted) return Object.assign({}, base, { state: 'missing' });
    if (m.count === 0)
      return Object.assign({}, base, { state: 'hidden', detail: describe(mountedNodes.values().next().value) });
    if (m.count > 1) return Object.assign({}, base, { state: 'ambiguous' });
    const node = m.node;
    if (node.disabled || node.getAttribute('aria-disabled') === 'true')
      return Object.assign({}, base, { state: 'disabled', detail: describe(node) });
    const r = node.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    // 命中目标本身或其子树才算命中目标；被别的元素盖住不是可点击状态。
    if (!hit || !(hit === node || node.contains(hit)))
      return Object.assign({}, base, { state: 'covered', detail: describe(hit) });
    return Object.assign({}, base, { state: 'ready', ready: true, point: { x, y }, detail: describe(node) });
  })()`;
}

/**
 * 点击项目触发器后的后置条件：项目菜单必须真正可见。
 * 鼠标事件发出去本身不算成功——菜单没开就说明这次点击没有生效。
 */
export function projectMenuOpenExpression(): string {
  return `(function(){${ZCODE_DOM}
    if ([...document.querySelectorAll('[role="menu"]')].some(visible)) return true;
    return [...document.querySelectorAll('[role="menuitemcheckbox"]')].some(visible);
  })()`;
}

/**
 * 「不在项目中工作」菜单项（`composer-work-outside-project`）：ZCode 用它进入 default
 * （无项目）工作区。要求命中层唯一可见，否则不点击——多匹配说明菜单结构已漂移，
 * 猜一个点会把任务送到错误的工作区。
 */
export function workOutsideProjectExpression(overrides: Record<string, string>): string {
  return `(function(){${ZCODE_DOM}
    const found = pick(${candidateExpr("workOutsideProject", overrides)});
    if (!found.node) return { count: found.count };
    const r = found.node.getBoundingClientRect();
    return { count: found.count, point: { x: r.left + r.width / 2, y: r.top + r.height / 2 } };
  })()`;
}
