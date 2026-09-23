/**
 * 单元测试：技能自检安装（issue #16 加固）。
 *
 * 覆盖计划 §5.1 的 A–E 五组：
 * A 源定位（问题 1 回归）/ B hash 与清单 / C 判定矩阵（纯函数，§3 全覆盖）
 * D 端到端行为（真实 fs）/ E 真实包内目录冒烟。
 *
 * 一律使用 temp 目录注入（destDir/sourceDir/copyImpl），不触碰真实 `~/.rivet`，
 * 也不 chdir/HOME-mock（Windows `os.homedir()` 读 USERPROFILE，进程内 mock 易踩坑）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { Logger, LogLevel } from "../../src/util/log.js";
import {
  SKILL_NAME,
  MANIFEST_FILE,
  STALE_INCOMING_MS,
  decideInstall,
  hashSkillTree,
  isExcludedName,
  planBackups,
  readManifest,
  resolveSkillSourceDir,
  skillSelfInstall,
  type DecideInput,
  type InstallManifest,
} from "../../src/util/skill-install.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_FILE = path.join(THIS_DIR, "..", "..", "src", "util", "skill-install.ts");
const REAL_SKILL_SRC = path.resolve(THIS_DIR, "..", "..", "skills", SKILL_NAME);

/* ---------------- 测试脚手架 ---------------- */

interface Recorded {
  level: LogLevel;
  msg: string;
}

function recordLogger(): { logger: Logger; lines: Recorded[] } {
  const lines: Recorded[] = [];
  const push = (level: LogLevel) => (msg: string) => {
    lines.push({ level, msg });
  };
  const logger = { debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") };
  return { logger: logger as unknown as Logger, lines };
}

function tmpRoot(tag: string): string {
  const p = path.join(os.tmpdir(), `tianshu-skill-${tag}-${randomBytes(4).toString("hex")}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** 造一棵「包内技能」源目录（内容固定的稳定 hash） */
function makeFakeSkillSource(tag: string, extra?: (dir: string) => void): string {
  const dir = path.join(tmpRoot(tag), SKILL_NAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${SKILL_NAME}\n---\n\n正文 A\n`, "utf8");
  fs.writeFileSync(path.join(dir, "usage-examples.md"), "示例 B\n", "utf8");
  fs.writeFileSync(path.join(dir, "sub"), "");
  fs.rmSync(path.join(dir, "sub"));
  if (extra) extra(dir);
  return dir;
}

function writeManifestFile(dest: string, hash: string, version = "0.5.10"): void {
  const m: InstallManifest = {
    schema: 1,
    name: SKILL_NAME,
    packageVersion: version,
    contentHash: hash,
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dest, MANIFEST_FILE), `${JSON.stringify(m, null, 2)}\n`, "utf8");
}

/** 把「源」内容（含可选改动）复制成目标目录，并可写/不写清单 */
function seedDest(dest: string, source: string, opts: { manifest: "ok" | "missing" | "stale-hash" | "corrupt"; version?: string; tamper?: boolean }): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(source, dest, { recursive: true });
  // 目标 hash 需在清单写入前算（清单会被排除，顺序无关）
  const destHash = opts.tamper ? "0".repeat(64) : hashSkillTree(dest);
  if (opts.manifest === "ok") writeManifestFile(dest, destHash, opts.version ?? "0.5.10");
  else if (opts.manifest === "stale-hash") writeManifestFile(dest, hashSkillTree(source), opts.version ?? "0.5.10");
  else if (opts.manifest === "corrupt") fs.writeFileSync(path.join(dest, MANIFEST_FILE), "{ 这不是 JSON ", "utf8");
}

/** 目录内容快照（文件相对路径 → 内容），用于断言「逐字节不变」 */
function snap(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out[path.relative(dir, full).split(path.sep).join("/")] = fs.readFileSync(full, "utf8");
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** 技能文件快照（不含清单）——用于「用户内容逐字节不变」断言 */
function snapSkills(dir: string): Record<string, string> {
  const s = snap(dir);
  delete s[MANIFEST_FILE];
  return s;
}

/** 去掉注释后的代码（A3 用：避免把注释里提到的反模式名当作代码命中） */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const BASE: DecideInput = {
  destExists: false,
  destIsDir: false,
  destHash: null,
  manifestState: "missing",
  manifest: null,
  pkgHash: "a".repeat(64),
  pkgVersion: "0.6.0",
  mode: "auto",
  approveUpdate: false,
};

const decide = (over: Partial<DecideInput>) => decideInstall({ ...BASE, ...over });
const okManifest = (hash: string): InstallManifest => ({
  schema: 1,
  name: SKILL_NAME,
  packageVersion: "0.5.10",
  contentHash: hash,
  installedAt: new Date().toISOString(),
});

let roots: string[] = [];
afterEach(async () => {
  for (const r of roots) await fsp.rm(r, { recursive: true, force: true }).catch(() => {});
  roots = [];
});
beforeEach(() => {
  roots = [];
});

function track<T extends string>(p: string): T {
  roots.push(p);
  return p as T;
}

/** 造「可信旧版包副本」目标：内容来自源但已不同于当前包，且清单记录 == 目标当前 hash */
function seedTrustedOld(dest: string, source: string, version = "0.5.10"): void {
  seedDest(dest, source, { manifest: "missing" });
  fs.appendFileSync(path.join(dest, "SKILL.md"), "旧版包内容（区别于当前包）\n", "utf8");
  writeManifestFile(dest, hashSkillTree(dest), version);
}

/* ---------------- A 源定位（问题 1 回归） ---------------- */

describe("A 源定位：只来自包自身（issue #16 问题 1）", () => {
  it("A1 返回 <模块>/../../skills/tianshu-mcp 且真实存在", () => {
    const p = resolveSkillSourceDir();
    expect(p.endsWith(path.join("skills", SKILL_NAME))).toBe(true);
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.existsSync(path.join(p, "SKILL.md"))).toBe(true);
  });

  it("A2 诱饵回归：cwd 下有同路径结构也不改变源", async () => {
    const bait = track(tmpRoot("bait"));
    const decoy = path.join(bait, "skills", SKILL_NAME);
    fs.mkdirSync(decoy, { recursive: true });
    fs.writeFileSync(path.join(decoy, "SKILL.md"), "诱饵内容，不该被安装\n", "utf8");
    const prev = process.cwd();
    try {
      process.chdir(bait);
      expect(resolveSkillSourceDir()).toBe(resolveSkillSourceDir()); // 稳定
      expect(resolveSkillSourceDir()).not.toContain("bait");
      const dest = path.join(track(tmpRoot("dest-a2")), "skills", SKILL_NAME);
      const { logger } = recordLogger();
      const r = await skillSelfInstall(logger, { destDir: dest, backupKeep: 0 });
      expect(r.installed).toBe(true);
      expect(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8")).not.toContain("诱饵");
    } finally {
      process.chdir(prev);
    }
  });

  it("A3 源码不再出现 process.cwd()（防回归，issue 同类反模式）", () => {
    // 只查代码，不看注释（模块头注释里会提到该反模式的名字）
    const code = stripComments(fs.readFileSync(SRC_FILE, "utf8"));
    expect(code.includes("process.cwd()")).toBe(false);
  });
});

/* ---------------- B hash 与清单 ---------------- */

describe("B hash 排除规则与清单解析", () => {
  it("B1 平台噪声与清单自身不改变 hash", () => {
    const src = track(makeFakeSkillSource("b1"));
    const h0 = hashSkillTree(src);
    fs.writeFileSync(path.join(src, ".DS_Store"), "x", "utf8");
    fs.writeFileSync(path.join(src, "Thumbs.db"), "x", "utf8");
    fs.writeFileSync(path.join(src, "desktop.ini"), "x", "utf8");
    fs.writeFileSync(path.join(src, "._resource"), "x", "utf8");
    fs.writeFileSync(path.join(src, ".gitignore"), "node_modules\n", "utf8");
    fs.mkdirSync(path.join(src, ".git"), { recursive: true });
    fs.writeFileSync(path.join(src, ".git", "HEAD"), "ref: x", "utf8");
    writeManifestFile(src, h0);
    expect(hashSkillTree(src)).toBe(h0);
  });

  it("B1b isExcludedName 边界", () => {
    for (const n of [MANIFEST_FILE, ".DS_Store", "Thumbs.db", "desktop.ini", "._x", ".git", ".gitignore", ".gitattributes"]) {
      expect(isExcludedName(n), n).toBe(true);
    }
    for (const n of ["SKILL.md", "usage-examples.md", "git.md", ".env", "DS_Store"]) {
      expect(isExcludedName(n), n).toBe(false);
    }
  });

  it("B2 内容或文件名变化 → hash 变化", () => {
    const src = track(makeFakeSkillSource("b2"));
    const h0 = hashSkillTree(src);
    fs.writeFileSync(path.join(src, "SKILL.md"), "改了\n", "utf8");
    const h1 = hashSkillTree(src);
    expect(h1).not.toBe(h0);
    fs.renameSync(path.join(src, "usage-examples.md"), path.join(src, "usage.md"));
    expect(hashSkillTree(src)).not.toBe(h1);
  });

  it("B3 readManifest：缺失/非法 JSON/schema/name/hash 非 64hex → corrupt", () => {
    const dir = track(path.join(tmpRoot("b3"), "d"));
    fs.mkdirSync(dir, { recursive: true });
    expect(readManifest(dir).state).toBe("missing");
    fs.writeFileSync(path.join(dir, MANIFEST_FILE), "{ 坏 ", "utf8");
    expect(readManifest(dir).state).toBe("corrupt");
    fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ schema: 2, name: SKILL_NAME, packageVersion: "1", contentHash: "a".repeat(64), installedAt: "x" }), "utf8");
    expect(readManifest(dir).state).toBe("corrupt");
    fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ schema: 1, name: "other", packageVersion: "1", contentHash: "a".repeat(64), installedAt: "x" }), "utf8");
    expect(readManifest(dir).state).toBe("corrupt");
    fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ schema: 1, name: SKILL_NAME, packageVersion: "1", contentHash: "abc", installedAt: "x" }), "utf8");
    expect(readManifest(dir).state).toBe("corrupt");
    writeManifestFile(dir, "b".repeat(64));
    const r = readManifest(dir);
    expect(r.state).toBe("ok");
    expect(r.manifest?.contentHash).toBe("b".repeat(64));
  });
});

/* ---------------- C 判定矩阵（纯函数，计划 §3） ---------------- */

describe("C 判定矩阵（纯函数）", () => {
  const PKG = "p".repeat(64);
  const OLD = "o".repeat(64);
  const USER = "u".repeat(64);

  it("C1 行1：目标不存在 → install（两种模式、放行与否都是首次安装）", () => {
    for (const mode of ["auto", "prompt"] as const) {
      for (const approveUpdate of [false, true]) {
        expect(decide({ mode, approveUpdate })).toEqual({ action: "install", reason: "first-install" });
      }
    }
  });

  it("C2 行2：内容一致 → skip；清单缺失时 repairManifest=true", () => {
    const base = { destExists: true, destIsDir: true, destHash: PKG, pkgHash: PKG };
    expect(decide({ ...base, manifestState: "ok", manifest: okManifest(PKG) })).toEqual({
      action: "skip",
      reason: "in-sync",
      repairManifest: false,
    });
    expect(decide({ ...base, manifestState: "missing", manifest: null })).toMatchObject({ action: "skip", repairManifest: true });
    // 清单存在但 hash 记录陈旧 → 也需校准
    expect(decide({ ...base, manifestState: "ok", manifest: okManifest(OLD) })).toMatchObject({ action: "skip", repairManifest: true });
  });

  it("C3 行3：清单可证未改动的旧版副本（destHash==recHash≠pkgHash）", () => {
    const base = { destExists: true, destIsDir: true, destHash: OLD, manifestState: "ok" as const, manifest: okManifest(OLD) };
    expect(decide({ ...base, mode: "auto" })).toEqual({ action: "overwrite", reason: "stale-package-copy" });
    expect(decide({ ...base, mode: "prompt" })).toEqual({ action: "hold", reason: "prompt-hold" });
    expect(decide({ ...base, mode: "prompt", approveUpdate: true })).toEqual({ action: "overwrite", reason: "approved" });
    expect(decide({ ...base, mode: "auto", approveUpdate: true })).toEqual({ action: "overwrite", reason: "stale-package-copy" });
  });

  it("C4 行4：确证的用户本地修改 → 恒 hold(user-modified)，放行不生效（D9 硬边界）", () => {
    const base = { destExists: true, destIsDir: true, destHash: USER, manifestState: "ok" as const, manifest: okManifest(OLD) };
    for (const mode of ["auto", "prompt"] as const) {
      for (const approveUpdate of [false, true]) {
        expect(decide({ ...base, mode, approveUpdate })).toEqual({ action: "hold", reason: "user-modified" });
      }
    }
  });

  it("C5 行5：无有效清单（缺失/损坏）→ 默认 hold(unknown-source)，放行则 overwrite(approved)（D13）", () => {
    for (const manifestState of ["missing", "corrupt"] as const) {
      const base = { destExists: true, destIsDir: true, destHash: USER, manifestState, manifest: null };
      for (const mode of ["auto", "prompt"] as const) {
        expect(decide({ ...base, mode })).toEqual({ action: "hold", reason: "unknown-source" });
      }
      expect(decide({ ...base, approveUpdate: true })).toEqual({ action: "overwrite", reason: "approved" });
    }
  });

  it("C6 行6：目标是文件/不可读（destHash=null）→ 与来源不明同语义", () => {
    const base = { destExists: true, destIsDir: false, destHash: null, manifestState: "missing" as const, manifest: null };
    expect(decide(base)).toEqual({ action: "hold", reason: "unknown-source" });
    expect(decide({ ...base, approveUpdate: true })).toEqual({ action: "overwrite", reason: "approved" });
  });
});

/* ---------------- D 端到端行为（真实 fs） ---------------- */

describe("D 端到端行为", () => {
  it("D1 首次安装：装齐内容 + 清单 hash 与包一致", async () => {
    const src = track(makeFakeSkillSource("d1-src"));
    const dest = path.join(track(tmpRoot("d1-dest")), "skills", SKILL_NAME);
    const { logger } = recordLogger();
    const r = await skillSelfInstall(logger, { destDir: dest, sourceDir: src, pkgVersion: "0.6.0" });
    expect(r).toMatchObject({ installed: true, action: "install", failed: false });
    expect(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8")).toBe(fs.readFileSync(path.join(src, "SKILL.md"), "utf8"));
    const m = readManifest(dest);
    expect(m.state).toBe("ok");
    expect(m.manifest?.contentHash).toBe(hashSkillTree(src));
    expect(m.manifest?.packageVersion).toBe("0.6.0");
  });

  it("D2 幂等：第二次 skip，且目标目录内容不变", async () => {
    const src = track(makeFakeSkillSource("d2-src"));
    const dest = path.join(track(tmpRoot("d2-dest")), "skills", SKILL_NAME);
    const { logger } = recordLogger();
    await skillSelfInstall(logger, { destDir: dest, sourceDir: src, pkgVersion: "0.6.0" });
    const before = snap(dest);
    const r2 = await skillSelfInstall(logger, { destDir: dest, sourceDir: src, pkgVersion: "0.6.0" });
    expect(r2.action).toBe("skip");
    expect(r2.skipped).toBe(true);
    expect(snap(dest)).toEqual(before);
  });

  it("D3 一致但清单缺失 → 补写清单且不改动技能文件", async () => {
    const src = track(makeFakeSkillSource("d3-src"));
    const dest = path.join(track(tmpRoot("d3-dest")), "skills", SKILL_NAME);
    seedDest(dest, src, { manifest: "missing" });
    const before = snap(dest);
    const { logger, lines } = recordLogger();
    const r = await skillSelfInstall(logger, { destDir: dest, sourceDir: src, pkgVersion: "0.6.0" });
    expect(r.action).toBe("skip");
    expect(readManifest(dest).state).toBe("ok");
    const after = snap(dest);
    delete after[MANIFEST_FILE];
    expect(after).toEqual(before);
    expect(lines.some((l) => l.level === "info" && l.msg.includes("技能安装清单已补写"))).toBe(true);
  });

  it("D4 可信旧版 + auto → 覆盖：生成 .bak，目标==包内，清单版本更新", async () => {
    const src = track(makeFakeSkillSource("d4-src"));
    const dest = path.join(track(tmpRoot("d4-dest")), "skills", SKILL_NAME);
    seedTrustedOld(dest, src, "0.5.10");
    expect(hashSkillTree(dest)).not.toBe(hashSkillTree(src)); // 确实是旧版内容
    const beforeBaks = countBaks(dest);
    const { logger, lines } = recordLogger();
    const r = await skillSelfInstall(logger, { destDir: dest, sourceDir: src, pkgVersion: "0.6.0", mode: "auto" });
    expect(r.action).toBe("overwrite");
    expect(r.reason).toBe("stale-package-copy");
    expect(r.bakPath).toBeTruthy();
    expect(fs.existsSync(r.bakPath!)).toBe(true);
    expect(hashSkillTree(dest)).toBe(hashSkillTree(src));
    expect(readManifest(dest).manifest?.packageVersion).toBe("0.6.0");
    expect(countBaks(dest)).toBe(beforeBaks + 1);
    expect(lines.some((l) => l.level === "warn" && l.msg.includes("技能旧版副本已升级"))).toBe(true);
  });

  it("D5 用户本地修改 → 内容逐字节不变、无 .bak、无 .incoming 残留", async () => {
    const src = track(makeFakeSkillSource("d5-src"));
    const dest = path.join(track(tmpRoot("d5-dest")), "skills", SKILL_NAME);
    seedDest(dest, src, { manifest: "ok" });
    fs.appendFileSync(path.join(dest, "SKILL.md"), "我的本地调优\n", "utf8"); // 改内容 → hash ≠ 清单记录
    const before = snap(dest);
    const { logger, lines } = recordLogger();
    const r = await skillSelfInstall(logger, { destDir: dest, sourceDir: src, pkgVersion: "0.6.0", mode: "auto" });
    expect(r).toMatchObject({ action: "hold", held: true, installed: false });
    expect(r.reason).toBe("user-modified");
    expect(snap(dest)).toEqual(before);
    expect(countBaks(dest)).toBe(0);
    expect(countIncoming(dest)).toBe(0);
    expect(lines.some((l) => l.level === "warn" && l.msg.includes("含本地修改"))).toBe(true);
    expect(lines.some((l) => l.msg.includes("二选一"))).toBe(true);
  });

  it("D5b 用户修改 + 放行参数 → 仍 hold（D9）", async () => {
    const src = track(makeFakeSkillSource("d5b-src"));
    const dest = path.join(track(tmpRoot("d5b-dest")), "skills", SKILL_NAME);
    seedDest(dest, src, { manifest: "ok" });
    fs.appendFileSync(path.join(dest, "SKILL.md"), "本地改动\n", "utf8");
    const before = snap(dest);
    const { logger } = recordLogger();
    const r = await skillSelfInstall(logger, { destDir: dest, sourceDir: src, pkgVersion: "0.6.0", approveUpdate: true });
    expect(r.reason).toBe("user-modified");
    expect(snap(dest)).toEqual(before);
  });

  it("D6 prompt 保留 → 内容不变 + 清单写 pendingUpdate + warn 未自动覆盖", async () => {
    const src = track(makeFakeSkillSource("d6-src"));
    const dest = path.join(track(tmpRoot("d6-dest")), "skills", SKILL_NAME);
    seedTrustedOld(dest, src, "0.5.10");
    const before = snapSkills(dest);
    const { logger, lines } = recordLogger();
    const r = await skillSelfInstall(logger, { destDir: dest, sourceDir: src, pkgVersion: "0.6.0", mode: "prompt" });
    expect(r).toMatchObject({ action: "hold", held: true, reason: "prompt-hold" });
    expect(snapSkills(dest)).toEqual(before);
    expect(countBaks(dest)).toBe(0);
    const m = readManifest(dest);
    expect(m.manifest?.pendingUpdate?.packageVersion).toBe("0.6.0");
    expect(lines.some((l) => l.level === "warn" && l.msg.includes("未自动覆盖"))).toBe(true);
    expect(lines.some((l) => l.msg.includes("--approve-skill-update"))).toBe(true);
  });

  it("D6b prompt + 放行 → 覆盖（D9 的另一半）", async () => {
    const src = track(makeFakeSkillSource("d6b-src"));
    const dest = path.join(track(tmpRoot("d6b-dest")), "skills", SKILL_NAME);
    seedTrustedOld(dest, src, "0.5.10");
    const { logger } = recordLogger();
    const r = await skillSelfInstall(logger, { destDir: dest, sourceDir: src, pkgVersion: "0.6.0", mode: "prompt", approveUpdate: true });
    expect(r.action).toBe("overwrite");
    expect(r.reason).toBe("approved");
    expect(hashSkillTree(dest)).toBe(hashSkillTree(src));
    expect(countBaks(dest)).toBe(1);
  });

  it("D7 放行覆盖 unknown-source 且目标是文件 → 文件被备份，dest 变目录", async () => {
    const src = track(makeFakeSkillSource("d7-src"));
    const parent = path.join(track(tmpRoot("d7-dest")), "skills");
    fs.mkdirSync(parent, { recursive: true });
    const dest = path.join(parent, SKILL_NAME);
    fs.writeFileSync(dest, "我是个占位文件\n", "utf8");
    const { logger, lines } = recordLogger();
    const r = await skillSelfInstall(logger, { destDir: dest, sourceDir: src, pkgVersion: "0.6.0", approveUpdate: true });
    expect(r.action).toBe("overwrite");
    expect(fs.statSync(dest).isDirectory()).toBe(true);
    expect(r.bakPath).toBeTruthy();
    expect(fs.readFileSync(r.bakPath!, "utf8")).toContain("占位文件");
    expect(lines.some((l) => l.msg.includes("授权覆盖"))).toBe(true);
  });

  it("D8 安装失败（copyImpl 抛错）→ failed，目标原状，无 .incoming 残留", async () => {
    const src = track(makeFakeSkillSource("d8-src"));
    const dest = path.join(track(tmpRoot("d8-dest")), "skills", SKILL_NAME);
    seedTrustedOld(dest, src, "0.5.10");
    const before = snap(dest);
    const { logger, lines } = recordLogger();
    const r = await skillSelfInstall(logger, {
      destDir: dest,
      sourceDir: src,
      pkgVersion: "0.6.0",
      copyImpl: () => {
        throw new Error("模拟拷贝失败");
      },
    });
    expect(r.failed).toBe(true);
    expect(r.action).toBe("error");
    expect(snap(dest)).toEqual(before);
    expect(countIncoming(dest)).toBe(0);
    expect(countBaks(dest)).toBe(0); // 未走到备份步骤
    expect(lines.some((l) => l.level === "warn" && l.msg.includes("技能自检安装失败"))).toBe(true);
  });

  it("D9 备份保留：预置 6 个 .bak + 覆盖 → 保留最新 3", async () => {
    const { src, dest } = seedOldWithBaks("d9", [1000, 2000, 3000, 4000, 5000, 6000]);
    const { logger } = recordLogger();
    await skillSelfInstall(logger, { destDir: dest, sourceDir: src, pkgVersion: "0.6.0", mode: "auto", backupKeep: 3 });
    const kept = listBaks(dest);
    expect(kept.length).toBe(3);
    expect(kept.some((n) => n.endsWith("bak-6000"))).toBe(true);
    expect(kept.some((n) => n.endsWith("bak-5000"))).toBe(true);
    expect(kept.some((n) => n.endsWith("bak-4000"))).toBe(false);
  });

  it("D9b backupKeep=0 → 不清理（保留全部）", async () => {
    const { src, dest } = seedOldWithBaks("d9b", [1000, 2000, 3000]);
    const { logger } = recordLogger();
    await skillSelfInstall(logger, { destDir: dest, sourceDir: src, pkgVersion: "0.6.0", mode: "auto", backupKeep: 0 });
    expect(listBaks(dest).length).toBe(4); // 3 旧 + 1 新
  });

  it("D10 非精确匹配（.bak-abc / .bak-1789.old / 名为 .bak-999 的文件）不被删", async () => {
    const src = track(makeFakeSkillSource("d10-src"));
    const parent = track(path.join(tmpRoot("d10-dest"), "skills"));
    fs.mkdirSync(parent, { recursive: true });
    const dest = path.join(parent, SKILL_NAME);
    // 造可信旧版目标（触发一次覆盖，从而真正跑到清理逻辑）
    seedTrustedOld(dest, src, "0.5.10");
    const noise = ["tianshu-mcp.bak-abc", "tianshu-mcp.bak-1789.old"];
    for (const n of noise) {
      fs.mkdirSync(path.join(parent, n), { recursive: true });
      fs.writeFileSync(path.join(parent, n, "x.md"), "x", "utf8");
    }
    fs.writeFileSync(path.join(parent, "tianshu-mcp.bak-999"), "i'm a file", "utf8");
    const { logger } = recordLogger();
    await skillSelfInstall(logger, { destDir: dest, sourceDir: src, pkgVersion: "0.6.0", mode: "auto", backupKeep: 1 });
    for (const n of noise) expect(fs.existsSync(path.join(parent, n))).toBe(true);
    expect(fs.existsSync(path.join(parent, "tianshu-mcp.bak-999"))).toBe(true);
    // 直接验证 planBackups 只认精确模式
    const plan = planBackups(parent, 1);
    expect(plan.remove.every((p) => /tianshu-mcp\.bak-\d+$/.test(p))).toBe(true);
  });

  it("D11 残留 .incoming-* 清理：旧的删、新的留", async () => {
    const src = track(makeFakeSkillSource("d11-src"));
    const parent = track(path.join(tmpRoot("d11-dest"), "skills"));
    fs.mkdirSync(parent, { recursive: true });
    const dest = path.join(parent, SKILL_NAME);
    const stale = path.join(parent, "tianshu-mcp.incoming-1700000000000-abcdef");
    const fresh = path.join(parent, "tianshu-mcp.incoming-9999999999999-abcdef");
    fs.mkdirSync(stale, { recursive: true });
    fs.mkdirSync(fresh, { recursive: true });
    const old = new Date(Date.now() - STALE_INCOMING_MS - 60_000);
    fs.utimesSync(stale, old, old);
    const { logger, lines } = recordLogger();
    await skillSelfInstall(logger, { destDir: dest, sourceDir: src, pkgVersion: "0.6.0" });
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(lines.some((l) => l.msg.includes("技能安装临时目录清理"))).toBe(true);
  });

  it("D12 日志分级：跳过=info；覆盖/保留/来源不明/失败=warn", async () => {
    const src = track(makeFakeSkillSource("d12-src"));
    const destRoot = track(tmpRoot("d12-dest"));
    const dest = path.join(destRoot, "skills", SKILL_NAME);
    const { logger, lines } = recordLogger();

    await skillSelfInstall(logger, { destDir: dest, sourceDir: src, pkgVersion: "0.6.0" }); // install
    const skip = await skillSelfInstall(logger, { destDir: dest, sourceDir: src, pkgVersion: "0.6.0" }); // skip
    expect(skip.action).toBe("skip");
    const skipLine = lines.find((l) => l.msg.includes("技能已安装且内容一致"));
    expect(skipLine?.level).toBe("info");

    // 来源不明（删清单 + 改内容）
    fs.appendFileSync(path.join(dest, "SKILL.md"), "改动\n", "utf8");
    fs.rmSync(path.join(dest, MANIFEST_FILE));
    const held = await skillSelfInstall(logger, { destDir: dest, sourceDir: src, pkgVersion: "0.6.0" });
    expect(held.reason).toBe("unknown-source");
    const holdLine = lines.find((l) => l.msg.includes("来源不明"));
    expect(holdLine?.level).toBe("warn");

    // 放行覆盖 → warn
    const over = await skillSelfInstall(logger, { destDir: dest, sourceDir: src, pkgVersion: "0.6.0", approveUpdate: true });
    expect(over.action).toBe("overwrite");
    const overLine = lines.find((l) => l.msg.includes("授权覆盖"));
    expect(overLine?.level).toBe("warn");

    // 失败 → warn
    const fail = await skillSelfInstall(logger, {
      destDir: path.join(destRoot, "skills2", SKILL_NAME),
      sourceDir: src,
      pkgVersion: "0.6.0",
      copyImpl: () => {
        throw new Error("boom");
      },
    });
    expect(fail.failed).toBe(true);
    expect(lines.find((l) => l.msg.includes("技能自检安装失败"))?.level).toBe("warn");
  });

  it("D13 源目录不存在 → skip + warn（既有路径保持）", async () => {
    const dest = path.join(track(tmpRoot("d13")), "skills", SKILL_NAME);
    const { logger, lines } = recordLogger();
    const r = await skillSelfInstall(logger, { destDir: dest, sourceDir: path.join(track(tmpRoot("d13-src")), "nope") });
    expect(r).toMatchObject({ skipped: true, failed: false });
    expect(r.reason).toBe("source-missing");
    const line = lines.find((l) => l.msg.includes("技能源目录不存在"));
    expect(line?.level).toBe("warn");
  });
});

/* ---------------- E 真实包内目录冒烟 ---------------- */

describe("E 真实 skills/tianshu-mcp 冒烟", () => {
  it("E1 以真实技能目录为源安装到临时 dest，内容逐字节一致且清单 hash 与源一致", async () => {
    const dest = path.join(track(tmpRoot("e1-dest")), "skills", SKILL_NAME);
    const { logger } = recordLogger();
    const r = await skillSelfInstall(logger, { destDir: dest, sourceDir: REAL_SKILL_SRC, pkgVersion: "0.6.0" });
    expect(r.installed).toBe(true);
    const srcFiles = fs.readdirSync(REAL_SKILL_SRC).filter((n) => !isExcludedName(n)).sort();
    expect(fs.readdirSync(dest).filter((n) => !isExcludedName(n)).sort()).toEqual(srcFiles);
    for (const f of srcFiles) {
      expect(fs.readFileSync(path.join(dest, f)).equals(fs.readFileSync(path.join(REAL_SKILL_SRC, f))), f).toBe(true);
    }
    expect(readManifest(dest).manifest?.contentHash).toBe(hashSkillTree(REAL_SKILL_SRC));
    // 幂等：再跑一次 → skip
    expect((await skillSelfInstall(logger, { destDir: dest, sourceDir: REAL_SKILL_SRC, pkgVersion: "0.6.0" })).action).toBe("skip");
  });
});

/* ---------------- 辅助：备份/临时目录计数 ---------------- */

function listBaks(dest: string): string[] {
  const parent = path.dirname(dest);
  if (!fs.existsSync(parent)) return [];
  return fs.readdirSync(parent).filter((n) => new RegExp(`^${SKILL_NAME}\\.bak-\\d+$`).test(n));
}
function countBaks(dest: string): number {
  return listBaks(dest).length;
}
function countIncoming(dest: string): number {
  const parent = path.dirname(dest);
  if (!fs.existsSync(parent)) return 0;
  return fs.readdirSync(parent).filter((n) => new RegExp(`^${SKILL_NAME}\\.incoming-\\d+-[0-9a-f]+$`).test(n)).length;
}

/** 造「可信旧版目标 + 一批历史备份」场景，返回源与目标路径 */
function seedOldWithBaks(tag: string, bakTs: number[]): { src: string; dest: string } {
  const src = track(makeFakeSkillSource(`${tag}-src`));
  const parent = track(path.join(tmpRoot(`${tag}-dest`), "skills"));
  fs.mkdirSync(parent, { recursive: true });
  const dest = path.join(parent, SKILL_NAME);
  seedDest(dest, src, { manifest: "ok" });
  fs.appendFileSync(path.join(dest, "SKILL.md"), "旧版\n", "utf8");
  writeManifestFile(dest, hashSkillTree(dest), "0.5.10"); // 可证未改动 → 可信旧版
  for (const ts of bakTs) {
    const b = path.join(parent, `${SKILL_NAME}.bak-${ts}`);
    fs.mkdirSync(b, { recursive: true });
    fs.writeFileSync(path.join(b, "old.md"), String(ts), "utf8");
  }
  return { src, dest };
}
