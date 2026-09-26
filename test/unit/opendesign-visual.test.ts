import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findStaticEntries,
  hasPreviewableProject,
  suggestVisualPages,
} from "../../src/agents/opendesign/visual.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-od-visual-"));
});

afterEach(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响断言 */
  }
});

function write(rel: string, content = "<html></html>"): void {
  const full = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe("Open Design 视觉验收：静态入口发现", () => {
  it("找到根目录 index.html，建议静态根为项目根（用 `.`）", () => {
    write("index.html");
    const hint = suggestVisualPages(root);
    expect(hint.configured).toBe(true);
    expect(hint.sourceType).toBe("static");
    expect(hint.root).toBe(".");
    expect(hint.candidates[0]!.relPath).toBe("index.html");
    expect(hint.candidates[0]!.route).toBe("/index.html");
    expect(hint.message).toContain("acceptance.json");
    // 关键纪律：明说不会自动改配置
    expect(hint.message).toContain("不会自动修改项目配置");
  });

  it("子目录入口：静态根取该子目录，route 带路径", () => {
    write("site/prototype.html");
    const hint = suggestVisualPages(root);
    expect(hint.configured).toBe(true);
    expect(hint.root).toBe("site");
    expect(hint.candidates[0]!.relPath).toBe("site/prototype.html");
    expect(hint.candidates[0]!.route).toBe("/site/prototype.html");
  });

  it("入口文件名有优先级：index.html 优先于 home.html", () => {
    write("home.html");
    write("index.html");
    const candidates = findStaticEntries(root);
    expect(candidates[0]!.relPath).toBe("index.html");
  });

  it("层级浅优先：根 index.html 胜过子目录 index.html", () => {
    write("deep/nested/index.html");
    write("index.html");
    const candidates = findStaticEntries(root);
    expect(candidates[0]!.relPath).toBe("index.html");
  });

  it("跳过 node_modules 与 .tianshu-mcp 等噪声目录（不被依赖里的 index.html 误导）", () => {
    write("node_modules/pkg/index.html");
    write(".tianshu-mcp/reports/index.html");
    write(".opendesign/plans/index.html");
    expect(findStaticEntries(root)).toEqual([]);
  });

  it("深度上限：过深的入口不参与推导（避免深挖噪声）", () => {
    write("a/b/c/d/index.html");
    expect(findStaticEntries(root)).toEqual([]);
  });

  it("只认入口文件名，不把任意 html 当入口", () => {
    write("about.html");
    write("contact.html");
    expect(findStaticEntries(root)).toEqual([]);
  });

  it("空目录不抛错，返回空集", () => {
    expect(findStaticEntries(root)).toEqual([]);
  });
});

describe("Open Design 视觉验收：工程结构判定", () => {
  it("package.json / vite 配置 / index.html 任一存在即视为可起预览", () => {
    expect(hasPreviewableProject(root)).toBe(false);
    write("package.json", "{}");
    expect(hasPreviewableProject(root)).toBe(true);
  });

  it("有工程但无静态入口 → 建议走 command 形态，且不猜启动命令", () => {
    write("package.json", '{"scripts":{"dev":"vite"}}');
    const hint = suggestVisualPages(root);
    expect(hint.configured).toBe(false);
    expect(hint.sourceType).toBe("command");
    expect(hint.message).toContain("command");
    expect(hint.message).toContain("不猜启动命令");
  });
});

describe("Open Design 视觉验收：推导不出来时如实说明", () => {
  it("既无入口也无工程结构 → configured:false + 可操作提示，绝不硬编码 /index.html", () => {
    const hint = suggestVisualPages(root);
    expect(hint.configured).toBe(false);
    expect(hint.sourceType).toBeUndefined();
    expect(hint.candidates).toEqual([]);
    expect(hint.message).toContain("visual.pages");
    expect(hint.message).toContain("static / command / existing");
  });

  it("提示里不含任何硬编码的默认路由（必须由人工/配置决定）", () => {
    const hint = suggestVisualPages(root);
    expect(hint.message).not.toContain('route:"/index.html"');
  });
});
