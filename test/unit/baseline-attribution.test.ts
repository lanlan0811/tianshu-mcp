/**
 * R3 回归测试：Git 基线差异归因。
 * - 干净仓库：新增/修改/删除都能报告
 * - 动工前已有脏文件（staged/unstaged/untracked），agent 只改其中一部分 → 只归因任务新增
 * - agent 创建 commit 后变更不丢失
 * - 空仓库 / 非 git 项目行为明确
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { captureBaseline } from "../../src/verify/git-baseline.js";
import { analyzeChanges } from "../../src/verify/code-analysis.js";
import { makeTmpRoot } from "../test-utils.js";

function git(cwd: string, args: string[], opts: { allowFail?: boolean } = {}): { code: number; out: string } {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    if (opts.allowFail) return { code: 1, out: String((e as { stdout?: string }).stdout ?? "") };
    throw e;
  }
}

async function tmpRepo(): Promise<string> {
  const p = await makeTmpRoot("r3");
  await git(p, ["init", "-b", "main"]);
  git(p, ["config", "user.email", "r3@test"]);
  git(p, ["config", "user.name", "R3"]);
  await fsp.writeFile(path.join(p, "base.txt"), "base\n");
  await fsp.mkdir(path.join(p, "src"), { recursive: true });
  await fsp.writeFile(path.join(p, "src", "a.ts"), "export const a = 1;\n");
  git(p, ["add", "-A"]);
  git(p, ["commit", "-m", "base"]);
  return p;
}

describe("R3 干净仓库差异归因", () => {
  it("新增/修改/删除都能报告，diffstat 准确", async () => {
    const p = await tmpRepo();
    const baseline = await captureBaseline(p);
    // agent 改动：改 a.ts、新增 b.ts、删 base.txt
    await fsp.writeFile(path.join(p, "src", "a.ts"), "export const a = 2;\nexport const a2 = 3;\n");
    await fsp.writeFile(path.join(p, "src", "b.ts"), "export const b = 1;\n");
    await fsp.rm(path.join(p, "base.txt"));
    const analysis = await analyzeChanges({ baseline, projectPath: p, taskText: "改 src .ts 文件" });
    expect(analysis.changedFiles).toContain("src/a.ts");
    expect(analysis.changedFiles).toContain("base.txt"); // 删除也进 changedFiles
    expect(analysis.untrackedFiles).toContain("src/b.ts"); // 新增未跟踪
    const aRow = analysis.diffstat.perFile.find((r) => r.file === "src/a.ts");
    expect(aRow?.add).toBe(2);
  });
});

describe("R3 动工前脏工作区归因", () => {
  it("基线前已有且未变化的未跟踪文件不计入任务变更", async () => {
    const p = await tmpRepo();
    await fsp.writeFile(path.join(p, "src", "a.ts"), "export const a = 999;\n");
    await fsp.mkdir(path.join(p, "scratch"), { recursive: true });
    await fsp.writeFile(path.join(p, "scratch", "user-file.txt"), "user stuff\n");
    const baseline = await captureBaseline(p);
    expect(baseline.dirty).toBe(true);
    expect(baseline.preExistingUntracked).toContain("scratch/user-file.txt");

    // "agent" 只新增 agent.txt，不碰 scratch/user-file.txt
    await fsp.writeFile(path.join(p, "agent.txt"), "agent work\n");

    const analysis = await analyzeChanges({ baseline, projectPath: p, taskText: "增加 agent.txt" });
    expect(analysis.untrackedFiles).toContain("agent.txt");
    // 核心 R3 断言：基线前已有且内容未变的用户文件不得被算作任务变更
    expect(analysis.untrackedFiles).not.toContain("scratch/user-file.txt");
  }, 30_000);

  it("agent 改动基线前已存在的未跟踪文件 → 整文件计入并提示", async () => {
    const p = await tmpRepo();
    await fsp.mkdir(path.join(p, "scratch"), { recursive: true });
    await fsp.writeFile(path.join(p, "scratch", "user-file.txt"), "user stuff\n");
    const baseline = await captureBaseline(p);
    // agent 改了这个文件
    await fsp.writeFile(path.join(p, "scratch", "user-file.txt"), "user stuff\nagent changed this\n");
    const analysis = await analyzeChanges({ baseline, projectPath: p, taskText: "改 scratch" });
    expect(analysis.untrackedFiles).toContain("scratch/user-file.txt");
    expect(analysis.notes.some((n) => n.includes("内容发生变化"))).toBe(true);
  }, 30_000);

  it("agent 提交后变更仍保留（不因 HEAD 前移丢失）", async () => {
    const p = await tmpRepo();
    const baseline = await captureBaseline(p);
    // agent 修改并提交
    await fsp.writeFile(path.join(p, "src", "a.ts"), "export const a = 5;\nexport const a5 = 6;\nexport const a7 = 8;\n");
    git(p, ["add", "-A"]);
    git(p, ["commit", "-m", "agent commit"]);
    const headNow = git(p, ["rev-parse", "HEAD"]).out.trim();
    expect(headNow).not.toBe(baseline.head); // HEAD 已前移

    const analysis = await analyzeChanges({ baseline, projectPath: p, taskText: "修改 a.ts" });
    const aRow = analysis.diffstat.perFile.find((r) => r.file === "src/a.ts");
    // 相对基线的净增行：base 1 行 → 3 行 = +2（内容变了）
    expect(aRow?.add).toBeGreaterThan(0);
    expect(analysis.changedFiles).toContain("src/a.ts");
    expect(analysis.notes.some((n) => n.includes("git 提交"))).toBe(true);
  }, 30_000);
});

describe("R3 边界", () => {
  it("非 git 项目返回空变更 + 提示", async () => {
    const p = await makeTmpRoot("r3-nongit");
    await fsp.writeFile(path.join(p, "x.txt"), "x\n");
    const baseline = await captureBaseline(p);
    expect(baseline.isRepo).toBe(false);
    const analysis = await analyzeChanges({ baseline, projectPath: p });
    expect(analysis.changedFiles).toHaveLength(0);
    expect(analysis.notes.some((n) => n.includes("git 仓库"))).toBe(true);
  });
});

describe("未跟踪超帽截断（>5000）归因", () => {
  it("截断发生时：基线前未跟踪但无哈希的文件聚合一条 note，且不计入变更判定", async () => {
    const p = await tmpRepo();
    // 两个「基线前已存在」的未跟踪文件
    await fsp.writeFile(path.join(p, "old1.txt"), "old1\n");
    await fsp.writeFile(path.join(p, "old2.txt"), "old2\n");
    const realBaseline = await captureBaseline(p);
    expect(realBaseline.untrackedHashTruncated).toBeUndefined(); // 少量文件不截断
    expect(realBaseline.preExistingUntracked).toContain("old1.txt");
    // 合成截断基线：模拟 >5000 超帽后这两个文件未哈希（无 preDirtyHashes）
    const baseline = {
      ...realBaseline,
      preDirtyHashes: {},
      preUntrackedHashes: {},
      untrackedHashTruncated: 2,
    };
    const analysis = await analyzeChanges({ baseline, projectPath: p, taskText: "noop" });
    // 不得计入变更判定（untrackedFiles / changedFiles / diffstat 均为空）
    expect(analysis.untrackedFiles).toHaveLength(0);
    expect(analysis.changedFiles).toHaveLength(0);
    expect(analysis.diffstat.perFile).toHaveLength(0);
    expect(analysis.diffstat.totalAdd).toBe(0);
    // 不发逐文件假 note，改为一条聚合 note
    expect(analysis.notes.filter((n) => n.includes("无法按行精确归因"))).toHaveLength(0);
    const agg = analysis.notes.filter((n) => n.includes("超出哈希上限 5000") && n.includes("无法归因"));
    expect(agg).toHaveLength(1);
    expect(agg[0]).toContain("2 个基线前未跟踪文件");
  }, 30_000);

  it("截断发生时：任务新增的未跟踪文件仍正常归因（只豁免超帽旧文件）", async () => {
    const p = await tmpRepo();
    await fsp.writeFile(path.join(p, "old1.txt"), "old1\n");
    const realBaseline = await captureBaseline(p);
    const baseline = { ...realBaseline, preDirtyHashes: {}, preUntrackedHashes: {}, untrackedHashTruncated: 1 };
    // agent 任务期间新增 new.txt
    await fsp.writeFile(path.join(p, "new.txt"), "new\n");
    const analysis = await analyzeChanges({ baseline, projectPath: p, taskText: "新增 new.txt" });
    expect(analysis.untrackedFiles).toEqual(["new.txt"]);
    expect(analysis.diffstat.perFile.find((r) => r.file === "new.txt")).toBeTruthy();
    expect(analysis.notes.some((n) => n.includes("1 个基线前未跟踪文件"))).toBe(true);
  }, 30_000);

  it("未截断时：同样的无哈希场景保持逐文件归因（现状逐字节一致）", async () => {
    const p = await tmpRepo();
    await fsp.writeFile(path.join(p, "old1.txt"), "old1\n");
    const realBaseline = await captureBaseline(p);
    // 无截断字段：无哈希（如基线读取失败形态）→ 维持逐文件归因旧行为
    const baseline = { ...realBaseline, preDirtyHashes: {}, preUntrackedHashes: {} };
    const analysis = await analyzeChanges({ baseline, projectPath: p, taskText: "noop" });
    expect(analysis.untrackedFiles).toContain("old1.txt");
    expect(analysis.notes.some((n) => n.includes("无法按行精确归因"))).toBe(true);
    expect(analysis.notes.some((n) => n.includes("超出哈希上限"))).toBe(false);
  }, 30_000);
});
