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
