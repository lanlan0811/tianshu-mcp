import { candidateExpr } from "./selectors.js";

/** Shared browser-side helpers. Kept as source so CDP and DOM regression tests execute identical code. */
export const ZCODE_DOM = String.raw`
const visible = e => {
  if (!e) return false;
  const r = e.getBoundingClientRect();
  const s = getComputedStyle(e);
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
    r.top < innerHeight && r.left < innerWidth && s.visibility !== 'hidden' && s.display !== 'none';
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
    const labels = [...e.querySelectorAll('*')].filter(n => !n.children.length && visible(n));
    const texts = [...new Set(labels.map(n => (n.textContent||'').trim()).filter(t=>t && norm(t)!==norm(ariaLabel)))];
    const titled = [e,...labels].filter(n=>visible(n) && n.getAttribute('title'));
    const titles = [...new Set(titled.map(n=>n.getAttribute('title').trim()).filter(t=>t && norm(t)!==norm(ariaLabel)))];
    const data = e.closest('[data-model-id],[data-model],[data-value]') ||
      e.querySelector('[data-model-id],[data-model],[data-value]') || e;
    return {display:(e.value||e.textContent||'').trim(), ariaLabel,
      visibleLabel:texts.length===1?texts[0]:'', title:titles.length===1?titles[0]:'',
      ambiguous:texts.length>1 || titles.length>1,
      currentValue:(e.getAttribute('data-model-current-value')||'').trim(),
      legacyInternal:(data.getAttribute('data-model-id')||data.getAttribute('data-model')||data.getAttribute('data-value')||'').trim()};
  })()`;
}
