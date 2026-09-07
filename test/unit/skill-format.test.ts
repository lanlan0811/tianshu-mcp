/**
 * 单元测试：技能 frontmatter 合规性（开发计划 §17.8）。
 * 防踩坑：description 不以 [ 开头、无外层引号；triggers 无 /斜杠/ 定界符、可编译为正则。
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(THIS_DIR, "../../skills/tianshu-mcp");

function readFrontmatter(file: string): Record<string, string> {
  const text = fs.readFileSync(path.join(SKILL_DIR, file), "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  expect(m, "必须有 frontmatter").not.toBeNull();
  const body = m![1]!;
  const out: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const kv = line.match(/^([A-Za-z]+):\s*(.*)$/);
    if (kv) {
      let v = kv[2]!;
      // 去掉 YAML 包裹引号（'...' / "..."）
      const q = v.match(/^(['"])(.*)\1$/s);
      if (q) v = q[2]!;
      out[kv[1]!] = v;
    }
  }
  return out;
}

describe("skills/tianshu-mcp/SKILL.md frontmatter", () => {
  const fm = readFrontmatter("SKILL.md");

  it("name = tianshu-mcp", () => {
    expect(fm["name"]).toBe("tianshu-mcp");
  });

  it("description 存在、不以 [ 开头、无外层引号、字数合理", () => {
    const d = fm["description"] ?? "";
    expect(d.length).toBeGreaterThan(50);
    expect(d.length).toBeLessThan(400);
    expect(d.startsWith("[")).toBe(false);
    expect(/^["']|["']$/.test(d)).toBe(false);
    expect(d).toContain("run_task");
  });

  it("triggers 无 /斜杠/ 定界符且每条可编译为正则", () => {
    const t = fm["triggers"] ?? "";
    expect(t).not.toContain("^/");
    const parts = t.split("|");
    expect(parts.length).toBeGreaterThan(5);
    for (const p of parts) {
      expect(() => new RegExp(p, "i"), `触发词不可编译: ${p}`).not.toThrow();
    }
    expect(parts.some((p) => p === "codex")).toBe(true);
    expect(parts.some((p) => p === "开发")).toBe(true);
  });

  it("正文以强指令开头（首行即指令）", () => {
    const text = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
    const body = text.split("---\n")[2] ?? "";
    expect(body.trim().startsWith("# tianshu-mcp")).toBe(true);
    expect(body).toContain("首行强指令");
  });
});

describe("skills/tianshu-mcp/usage-examples.md 存在且结构齐全", () => {
  it("含任务书模板 / meta 解读 / 返修提示语模板", () => {
    const text = fs.readFileSync(path.join(SKILL_DIR, "usage-examples.md"), "utf8");
    expect(text).toContain("任务书模板");
    expect(text).toContain("meta 块解读");
    expect(text).toContain("返修提示语模板");
  });
});
