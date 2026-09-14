import path from "node:path";
import type { VerifyReport } from "../tasks/task.js";
export function escapeHtml(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
export function visualEvidence(report: VerifyReport): string {
  if (!report.visual) return "";
  const lines = [
    "## 视觉验收",
    "",
    "不得通过修改基准、阈值、屏蔽区域或检查开关绕过失败；基准与规则变更必须由用户审阅批准。",
    "",
  ];
  if (report.visual.cleanedAt) lines.push(`产物已显式清理：${report.visual.cleanedAt}`, "");
  for (const result of report.visual.results) {
    lines.push(
      `### ${result.id} / ${result.viewport ?? result.target} [${result.status}]`,
      `- 目标：${result.target}`,
      `- 原因：${result.code} — ${result.message}`,
      `- 可选：${result.optional}；可自动返修：${result.repairable}`,
      `- 预期规则：${JSON.stringify(result.rules ?? {})}`,
      `- 实际指标：${JSON.stringify(result.metrics ?? {})}`,
      `- 差异区域：${JSON.stringify(result.regions ?? [])}`,
      `- 屏蔽区域：${JSON.stringify(result.masks ?? [])}`,
      `- 环境：${JSON.stringify(result.environment ?? {})}`,
    );
    for (const [kind, file] of Object.entries(result.artifacts ?? {}))
      lines.push(`- ${kind}：[${kind}](<${file}>)`);
    lines.push("");
  }
  if (report.files.html) lines.push(`离线报告：[HTML](<${report.files.html}>)`, "");
  return lines.join("\n");
}
export function visualHtml(report: VerifyReport): string {
  const link = (file: string): string =>
    path
      .relative(path.dirname(report.files.html!), file)
      .split(path.sep)
      .map(encodeURIComponent)
      .join("/");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Visual acceptance</title>
<style>body{font:16px system-ui;margin:2rem;background:#f4f6f8;color:#18212b}article{background:white;padding:1rem;margin:1rem 0;border:1px solid #bbc5d0;border-radius:8px}.images{display:flex;gap:1rem;overflow:auto}figure{margin:0;min-width:200px;flex:1}img{max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere}.overlay{position:relative;width:max-content;max-width:100%}.overlay img+img{position:absolute;left:0;top:0}button,select,input{font:inherit}h2{overflow-wrap:anywhere}</style>
<h1>Visual acceptance — ${escapeHtml(report.verdict)}</h1><p>${escapeHtml(report.message)}</p>
${report.visual?.cleanedAt ? `<p>Artifacts explicitly cleaned: ${escapeHtml(report.visual.cleanedAt)}</p>` : ""}
<label>Status <select id="filter"><option value="all">All</option>${["passed", "failed", "blocked", "skipped"].map((s) => `<option>${s}</option>`).join("")}</select></label>
${
  report.visual?.results
    .map(
      (
        r,
      ) => `<article data-status="${r.status}"><h2>${escapeHtml(r.id)} / ${escapeHtml(r.viewport ?? r.target)} — ${r.status}</h2><p>${escapeHtml(r.code)}: ${escapeHtml(r.message)}</p>
<div class="images">${Object.entries(r.artifacts ?? {})
        .filter(([kind]) => kind !== "metrics")
        .filter(() => !report.visual?.cleanedAt)
        .map(
          ([kind, file]) =>
            `<figure><figcaption>${escapeHtml(kind)}</figcaption><a href="${escapeHtml(link(file))}"><img alt="${escapeHtml(kind)}" src="${escapeHtml(link(file))}"></a></figure>`,
        )
        .join("")}</div>
${!report.visual?.cleanedAt && r.artifacts?.baseline && r.artifacts.actual ? `<h3>Overlay</h3><label>Actual opacity <input class="opacity" type="range" min="0" max="1" step="0.01" value="0.5"></label><div class="overlay"><img alt="baseline" src="${escapeHtml(link(r.artifacts.baseline))}"><img class="actual" style="opacity:.5" alt="actual overlay" src="${escapeHtml(link(r.artifacts.actual))}"><svg class="region-map" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none" viewBox="0 0 ${Number(r.metrics?.width ?? r.metrics?.actualWidth ?? 1)} ${Number(r.metrics?.height ?? r.metrics?.actualHeight ?? 1)}">${(r.regions ?? []).map((region, i) => `<rect data-region="${i}" x="${Number(region.x)}" y="${Number(region.y)}" width="${Number(region.width)}" height="${Number(region.height)}" fill="none" stroke="red" stroke-width="1"/>`).join("")}</svg></div><p>${(r.regions ?? []).map((region, i) => `<button class="region" data-region="${i}">Region ${i + 1}: (${Number(region.x)}, ${Number(region.y)}) ${Number(region.width)}×${Number(region.height)}</button>`).join(" ")}</p>` : ""}
<details><summary>Metrics, rules, environment and regions</summary><pre>${escapeHtml(JSON.stringify({ target: r.target, metrics: r.metrics, rules: r.rules, environment: r.environment, masks: r.masks, regions: r.regions }, null, 2))}</pre></details></article>`,
    )
    .join("") ?? ""
}
<script>document.querySelector('#filter').addEventListener('change',function(){document.querySelectorAll('article').forEach(a=>a.hidden=this.value!=='all'&&a.dataset.status!==this.value)});document.querySelectorAll('.opacity').forEach(input=>input.addEventListener('input',()=>{input.closest('article').querySelector('.actual').style.opacity=input.value}));document.querySelectorAll('button.region').forEach(button=>button.addEventListener('click',()=>{const article=button.closest('article');article.querySelectorAll('rect').forEach(r=>{r.setAttribute('stroke',r.dataset.region===button.dataset.region?'blue':'red');r.setAttribute('stroke-width',r.dataset.region===button.dataset.region?'3':'1')});article.querySelector('.overlay').scrollIntoView({block:'center'})}));</script></html>`;
}
