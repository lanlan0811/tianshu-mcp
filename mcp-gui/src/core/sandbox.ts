/**
 * 视觉验收 HTML 的沙箱化预处理。
 *
 * 三层隔离（**缺一不可**）：
 *  1. 渲染侧：iframe 带 `sandbox=""`（无 `allow-scripts` / `allow-same-origin`）；
 *  2. 内容侧：注入 `Content-Security-Policy` 的 `default-src 'none'`，阻断一切外部资源与网络请求；
 *  3. 本函数：**剥掉所有 `<script>` 标签**，即使 sandbox 被误配置也不会执行报告内的脚本。
 */

const CSP = [
  "default-src 'none'",
  "img-src data: blob:",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "media-src data: blob:",
].join("; ");

function stripScripts(html: string): string {
  // 同时覆盖 <script ...>...</script> 与自闭合写法；大小写不敏感、跨行匹配。
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*\/?>/gi, "");
}

function injectMeta(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (m) => `${m}${meta}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${meta}</head>`);
  }
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

export function buildSandboxHtml(rawHtml: string): string {
  return injectMeta(stripScripts(rawHtml));
}