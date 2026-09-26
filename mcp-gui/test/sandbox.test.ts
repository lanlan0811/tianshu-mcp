import { describe, expect, it } from "vitest";
import { buildSandboxHtml } from "@/core/sandbox";

const SAMPLE = `<!doctype html><html><head><title>视觉验收</title>
<script>window.__evil = 1;</script>
</head><body><img src="https://example.com/a.png"><script src="https://cdn.example.com/x.js"></script></body></html>`;

describe("buildSandboxHtml", () => {
  it("注入 CSP：默认拒绝一切来源（含外部图片与脚本）", () => {
    const html = buildSandboxHtml(SAMPLE);
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("img-src data: blob:");
  });

  it("剥离内联与外链 script（即使 sandbox 被误配置也不执行）", () => {
    const html = buildSandboxHtml(SAMPLE);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("__evil");
    expect(html).not.toContain("cdn.example.com");
  });

  it("保留正文内容与内联样式能力", () => {
    const html = buildSandboxHtml(SAMPLE);
    expect(html).toContain("视觉验收");
    expect(html).toContain("style-src 'unsafe-inline'");
  });

  it("缺少 head 时自动补齐结构", () => {
    const html = buildSandboxHtml("<p>只有片段</p>");
    expect(html).toContain("<head>");
    expect(html).toContain("<p>只有片段</p>");
    expect(html).toContain("default-src 'none'");
  });

  it("大小写与自闭合 script 也要剥离", () => {
    const html = buildSandboxHtml('<SCRIPT>1</SCRIPT><script src="x" />');
    expect(html.toLowerCase()).not.toContain("<script");
  });
});