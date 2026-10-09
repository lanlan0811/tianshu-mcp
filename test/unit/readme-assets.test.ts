/**
 * 双语 README 的资源引用完整性回归测试。
 *
 * 不变量：README.md / README.en.md 中以相对路径引用的本地资源（assets/ 下的图片）
 * 必须真实存在于磁盘，且档案非空。README 的图片引用失效不会让任何构建失败，
 * 只会在 GitHub 页面上呈现坏图——静默失败，必须由测试兜住。
 *
 * 同时锁定每份 README 引用的是自己语言版本的插图（zh -> -zh.png, en -> -en.png），
 * 防止中英文档串用插图。
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** 取出 markdown 里所有本地相对资源引用（排除 http/https/data 与锚点） */
function localRefs(markdown: string): string[] {
  const refs = new Set<string>();
  // markdown 图片语法 ![alt](path) 与 HTML <img src="path">
  const patterns = [/!\[[^\]]*\]\(([^)\s]+)/g, /<img[^>]+src="([^"]+)"/g];
  for (const re of patterns) {
    for (const m of markdown.matchAll(re)) {
      const target = m[1];
      if (target === undefined) continue;
      if (/^(https?:|data:|mailto:|#)/.test(target)) continue;
      refs.add(target.split("#")[0] ?? target);
    }
  }
  return [...refs];
}

const CASES = [
  { file: "README.md", lang: "zh" },
  { file: "README.en.md", lang: "en" },
] as const;

describe("README 资源引用完整性", () => {
  for (const { file, lang } of CASES) {
    it(`${file} 引用的本地资源全部存在且非空`, () => {
      const markdown = fs.readFileSync(path.join(ROOT, file), "utf8");
      const refs = localRefs(markdown);
      expect(refs.length, `${file} 未解析出任何本地资源引用`).toBeGreaterThan(0);

      const missing: string[] = [];
      const empty: string[] = [];
      for (const ref of refs) {
        const abs = path.resolve(ROOT, ref.replace(/^\.\//, ""));
        if (!fs.existsSync(abs)) missing.push(ref);
        else if (fs.statSync(abs).size === 0) empty.push(ref);
      }
      expect(missing, `${file} 引用了不存在的资源`).toEqual([]);
      expect(empty, `${file} 引用了空文件`).toEqual([]);
    });

    it(`${file} 的项目插图全部为 ${lang} 语言版本`, () => {
      const markdown = fs.readFileSync(path.join(ROOT, file), "utf8");
      const figs = localRefs(markdown).filter((r) => /(^|\/)fig-.*\.png$/.test(r));
      expect(figs.length, `${file} 未引用任何 fig-* 插图`).toBeGreaterThan(0);

      const wrongLang = figs.filter((f) => !f.endsWith(`-${lang}.png`));
      expect(wrongLang, `${file} 引用了非 ${lang} 版本的插图`).toEqual([]);

      // 反向：另一语言的插图不应出现在本文件
      const other = lang === "zh" ? "en" : "zh";
      const leaked = figs.filter((f) => f.endsWith(`-${other}.png`));
      expect(leaked, `${file} 混入了 ${other} 版本插图`).toEqual([]);
    });
  }
});
