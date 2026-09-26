/**
 * Markdown 渲染（`report-<round>.md` 用）。
 *
 * 安全边界：`html: false` —— Markdown 源中的内联 HTML **不会被解析执行**，
 * 因此 v-html 渲染的是 markdown-it 自己产出的受控标记，而不是报告里的原始 HTML。
 * 视觉验收的 HTML 报告则一律走 sandbox iframe，两者不混用。
 */
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
});

export function renderMarkdown(source: string): string {
  return md.render(source);
}