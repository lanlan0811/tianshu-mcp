/**
 * GUI 选择器解析失败的统一诊断（issue #23「机制」建议）。
 *
 * 三个 GUI agent（codex / qoder / traework）的选择器解析失败信息往往只有
 * 「未出现 X」——但报告者真正需要的是「页面上实际有什么」。issue #23 的调查里，
 * 最有价值的线索（`aria-haspopup="dialog"` 恰 1 个、aria-label 已变成「选择项目」）
 * 是人工打开 CDP 探针才拿到的。本模块把这步自动化：解析失败时把页面可见候选
 * 标签一并写进错误信息与日志。
 *
 * 约定：本模块只产出「页面内表达式」与「文本」，不参与任何控制流或判定，
 * 因此注入失败、页面无元素等情况都必须安全降级为空候选。
 */

/** 诊断采集选项 */
export interface DiagnosticOptions {
  /** 扫描范围选择器（缺省整页） */
  scope?: string;
  /** 最多返回多少条标签（默认 20） */
  limit?: number;
  /** 是否把可见文本也算作标签（默认 true；false 时只收 aria-label） */
  includeText?: boolean;
}

export const DEFAULT_DIAGNOSTIC_LIMIT = 20;

/** 交互元素扫描选择器（与 codex resolve 的 scan 面保持一致，宁可多扫后截断） */
const DIAGNOSTIC_SCAN =
  '[aria-label],[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"],[role="tab"],button,a,label';

/**
 * 生成页面内表达式：收集当前可见、带 aria-label 或可见文本的交互元素标签
 * （归一化、去重、截断）。返回 `string[]`，可直接交给 `cdp.evaluate`。
 */
export function visibleLabelsExpr(opts: DiagnosticOptions = {}): string {
  const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_DIAGNOSTIC_LIMIT));
  const scopeSel = opts.scope ? JSON.stringify(opts.scope) : "''";
  const includeText = opts.includeText !== false;
  const scan = JSON.stringify(DIAGNOSTIC_SCAN);
  return `(function(){
    try{
      var limit=${limit},includeText=${includeText},scopeSel=${scopeSel},scan=${scan};
      var root=scopeSel?document.querySelector(scopeSel):document;
      if(!root)return [];
      var vis=function(e){try{var r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth}catch(_){return false}};
      var norm=function(s){return (s||'').normalize('NFC').replace(/\\s+/g,' ').trim()};
      var out=[],seen={};
      var push=function(s){var v=norm(s);if(!v||v.length>80)return;var k=v.toLocaleLowerCase();if(seen[k])return;seen[k]=1;out.push(v)};
      var nodes=root.querySelectorAll(scan);
      for(var i=0;i<nodes.length;i++){
        if(out.length>=limit)break;
        var e=nodes[i];
        if(!vis(e))continue;
        var aria=norm(e.getAttribute('aria-label')||'');
        if(aria){push(aria);continue}
        if(includeText){var t=norm(e.innerText||e.textContent||'');if(t&&t.length<=40)push(t)}
      }
      return out;
    }catch(_){return []}
  })()`;
}

/** 从 CDP 返回值安全提取字符串标签数组（过滤非字符串、去重、截断）。 */
export function normalizeLabels(raw: unknown, max = DEFAULT_DIAGNOSTIC_LIMIT): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const v = item.replace(/\s+/g, " ").trim();
    if (!v) continue;
    const key = v.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/** 把候选标签渲染成错误信息后缀（无候选返回空串）。 */
export function formatCandidates(
  labels: readonly string[] | undefined,
  max = DEFAULT_DIAGNOSTIC_LIMIT,
): string {
  const list = normalizeLabels(labels, max);
  if (!list.length) return "";
  return `；页面可见候选=[${list.join(" | ")}]`;
}

/** 幂等追加诊断：已含候选段时原样返回，避免重复拼接。 */
export function withDiagnostics(
  message: string,
  labels: readonly string[] | undefined,
  max = DEFAULT_DIAGNOSTIC_LIMIT,
): string {
  if (/页面可见候选=/.test(message)) return message;
  return message + formatCandidates(labels, max);
}
