/** 单元测试：默认验收集推导 / 代码分析可疑标记扫描 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { deriveDefaultChecks } from "../../src/verify/acceptance.js";
import { scanChangedLinesForSignals } from "../../src/verify/signals.js";
import { parsePorcelain } from "../../src/verify/git-baseline.js";

async function tmpDir(tag: string): Promise<string> {
  const p = path.join(os.tmpdir(), `tsmcp-unit-${tag}-${randomBytes(4).toString("hex")}`);
  await fsp.mkdir(p, { recursive: true });
  return p;
}

describe("deriveDefaultChecks", () => {
  it("package.json 有 build 无 test → 推导 build、跳过 test，并注明缺失", async () => {
    const p = await tmpDir("pkg");
    await fsp.writeFile(
      path.join(p, "package.json"),
      JSON.stringify({ name: "x", scripts: { build: "tsc" } }),
    );
    const { checks, notes } = await deriveDefaultChecks(p);
    const names = checks.map((c) => c.name);
    expect(names).toContain("build");
    expect(names).not.toContain("test");
    expect(notes.join(" ")).toContain("test");
  });

  it("tsconfig 无 package scripts → npx tsc --noEmit", async () => {
    const p = await tmpDir("ts");
    await fsp.writeFile(path.join(p, "tsconfig.json"), "{}");
    const { checks } = await deriveDefaultChecks(p);
    expect(checks.some((c) => c.cmd.join(" ").includes("tsc --noEmit"))).toBe(true);
  });

  it("python 项目 → pytest", async () => {
    const p = await tmpDir("py");
    await fsp.writeFile(path.join(p, "pytest.ini"), "[pytest]\n");
    const { checks } = await deriveDefaultChecks(p);
    expect(checks.some((c) => c.name === "pytest")).toBe(true);
  });

  it("go 项目 → go test", async () => {
    const p = await tmpDir("go");
    await fsp.writeFile(path.join(p, "go.mod"), "module x\n");
    const { checks } = await deriveDefaultChecks(p);
    expect(checks.some((c) => c.name === "go-test")).toBe(true);
  });

  it("空项目 → 空检查（仅 git-diff-check 内置）", async () => {
    const p = await tmpDir("empty");
    const { checks } = await deriveDefaultChecks(p);
    expect(checks).toHaveLength(0);
  });
});

describe("可疑标记扫描", () => {
  it("命中 TODO / console.log / debugger / 注释块 / 密钥形态", () => {
    const lines = [
      "const a = 1; // TODO: 重构",
      "console.log('debug');",
      "// 整块注释",
      "// 整块注释2",
      "// 整块注释3",
      "apiKey: 'sk-1234567890abcdef'",
      "normal code",
    ];
    const s = scanChangedLinesForSignals(lines);
    expect(s.todo).toBeGreaterThan(0);
    expect(s.consoleDebug).toBeGreaterThan(0);
    expect(s.commentedBlock).toBeGreaterThan(0);
    expect(s.secretLike).toBeGreaterThan(0);
  });

  it("干净代码无命中", () => {
    const lines = ["export function add(a: number, b: number) {", "  return a + b;", "}"];
    const s = scanChangedLinesForSignals(lines);
    expect(s.todo).toBe(0);
    expect(s.consoleDebug).toBe(0);
    expect(s.commentedBlock).toBe(0);
    expect(s.secretLike).toBe(0);
  });
});

describe("git porcelain 解析", () => {
  it("区分已改/未跟踪/其它", () => {
    const r = parsePorcelain([" M src/a.ts", "?? new.txt", "A  staged.ts", " M src/b.ts"]);
    expect(r.changed).toContain("src/a.ts");
    expect(r.changed).toContain("src/b.ts");
    expect(r.changed).toContain("staged.ts");
    expect(r.untracked).toContain("new.txt");
  });
});
