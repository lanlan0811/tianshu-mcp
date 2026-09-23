#!/usr/bin/env node
/**
 * 技能状态种子（dev-only，issue #16 加固验证用）。
 *
 * 把隔离 home 下的 `~/.rivet/skills/tianshu-mcp` 播种为指定状态，供
 * `scripts/check-stdio.mjs` 的两个技能场景与真机手工复验复用。
 *
 * 用法：
 *   node scripts/seed-skill-state.mjs --home <dir> --repo <pkgRoot> --state <state> [--version 0.5.10]
 *
 * 状态：
 *   absent       目标目录不存在（首次安装路径）
 *   pristine-old 可信旧版副本：内容≠包内，且清单记录的 hash == 目标当前内容 hash
 *   customized   用户本地修改：清单记录 hash == 安装时内容 hash，但内容已被改动
 *   unknown      来源不明：内容≠包内，且**没有**安装清单
 *
 * 说明：本脚本为**测试夹具**，`hashSkillTreeMirror` 刻意镜像
 * `src/util/skill-install.ts` 的算法以便生成"可信旧版"这种需要 hash 自洽的状态；
 * 即便两边算法日后漂移，`customized` 场景的判定也不受影响（内容被改动后
 * 目标 hash 必然 ≠ 清单记录 hash，仍正确归为"用户本地修改"）。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SKILL_NAME = "tianshu-mcp";
export const MANIFEST_FILE = ".tianshu-mcp-install.json";

/** 与 src/util/skill-install.ts 的排除规则保持一致（排除清单与平台噪声） */
export function isExcludedName(name) {
  if (name === MANIFEST_FILE) return true;
  if (name === ".DS_Store" || name === "Thumbs.db" || name === "desktop.ini") return true;
  if (name.startsWith("._")) return true;
  if (name.startsWith(".git")) return true;
  return false;
}

/** 镜像 src/util/skill-install.ts 的 hashSkillTree（相对路径 + 内容，文件按路径排序） */
export function hashSkillTreeMirror(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (isExcludedName(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) files.push(full);
    }
  };
  walk(dir);
  files.sort();
  const h = createHash("sha256");
  for (const f of files) {
    h.update(path.relative(dir, f).split(path.sep).join("/"));
    h.update(fs.readFileSync(f));
  }
  return h.digest("hex");
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (isExcludedName(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

function writeManifest(dest, contentHash, version) {
  const data = {
    schema: 1,
    name: SKILL_NAME,
    packageVersion: version,
    contentHash,
    installedAt: new Date().toISOString(),
    sourceDir: "<seed: 非真实安装>",
  };
  fs.writeFileSync(path.join(dest, MANIFEST_FILE), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function resolveDest(home) {
  return path.join(home, ".rivet", "skills", SKILL_NAME);
}

/**
 * 播种技能状态。
 * @param {string} home 隔离的 home 目录
 * @param {string} repo 包根（提供 skills/tianshu-mcp 作为包内内容）
 * @param {"absent"|"pristine-old"|"customized"|"unknown"} state
 * @param {{version?: string}} [opts]
 * @returns {{dest: string, state: string}}
 */
export function seedSkillState(home, repo, state, opts = {}) {
  const version = opts.version ?? "0.5.10";
  const src = path.join(repo, "skills", SKILL_NAME);
  const dest = resolveDest(home);

  if (state === "absent") {
    fs.rmSync(dest, { recursive: true, force: true });
    return { dest, state };
  }

  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (state === "unknown") {
    // 内容≠包内，无清单
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(
      path.join(dest, "SKILL.md"),
      `---\nname: ${SKILL_NAME}\ndescription: 来源不明的技能内容（种子）\n---\n\n这不是包内版本。\n`,
      "utf8",
    );
    return { dest, state };
  }

  // pristine-old / customized：先拷包内内容
  copyTree(src, dest);

  if (state === "customized") {
    // 清单记录"安装时"的 hash，然后改动内容 → 目标 hash ≠ 清单记录
    const installedHash = hashSkillTreeMirror(dest);
    writeManifest(dest, installedHash, version);
    fs.appendFileSync(path.join(dest, "SKILL.md"), "\n<!-- 用户本地调优（种子） -->\n", "utf8");
    return { dest, state };
  }

  if (state === "pristine-old") {
    // 内容≠包内（模拟旧版包），清单记录 == 当前内容 → 未改动的可信旧版副本
    fs.appendFileSync(path.join(dest, "SKILL.md"), "\n<!-- 旧版包内容（种子） -->\n", "utf8");
    const hash = hashSkillTreeMirror(dest);
    writeManifest(dest, hash, version);
    return { dest, state };
  }

  throw new Error(`未知状态：${state}`);
}

/* ---------------- CLI ---------------- */

function parseCli(argv) {
  const out = { home: null, repo: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), state: null, version: "0.5.10" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`选项 ${a} 缺少参数`);
      return v;
    };
    if (a === "--home") out.home = path.resolve(next());
    else if (a === "--repo") out.repo = path.resolve(next());
    else if (a === "--state") out.state = next();
    else if (a === "--version") out.version = next();
    else throw new Error(`未知选项 ${a}`);
  }
  if (!out.home) throw new Error("缺少 --home <dir>");
  if (!out.state) throw new Error("缺少 --state <absent|pristine-old|customized|unknown>");
  return out;
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  try {
    const cli = parseCli(process.argv.slice(2));
    const r = seedSkillState(cli.home, cli.repo, cli.state, { version: cli.version });
    console.log(`seed-skill-state: ${r.state} → ${r.dest}`);
  } catch (e) {
    console.error(`seed-skill-state 失败: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
