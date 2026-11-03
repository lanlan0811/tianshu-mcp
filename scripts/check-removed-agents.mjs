#!/usr/bin/env node
/**
 * 零残留审计门禁（1.0.0-beta.3）。
 *
 * 目的：确保已移除的两个 GUI agent（TraeWork / Qoder CN）**不会以任何形式回流**。
 * 只要有人把它们加回源码、测试、脚本、打包清单或 CI 配置，本脚本即非 0 退出。
 *
 * 白名单（允许命中，且必须逐条说明理由）：
 *   - `docs/release-v*.md` / `.en.md`：历史发布说明，忠实记录当时的变更（改写=篡改历史）。
 *   - `CHANGELOG*.md`：同上。
 *   - `HANDOFF.md`：历史快照段落（各版本交接记录）。
 *   - `README.md` / `README.en.md` / `ARCHITECTURE*.md` / `docs/*.md`：里程碑表与
 *     「移除 XXX」的说明性文字（面向用户的迁移指引，删掉会让读者以为从未存在过）。
 *   - `test/integration/legacy-removed-agent-rework.test.ts`：0.9.10 的显式验收用例，
 *     必须保留已移除 agentId 作为输入以证明 fail-closed（删了就没有这道锁）。
 *   - `mcp-gui/fixtures/**`：历史日志样本（「日志里出现过什么」的样本，不是当前 agent 清单）。
 *   - `mcp-gui/**`：GUI 交付面自带独立门禁，不参与主包 CI。
 *
 * 强约束（**零容忍，任何命中即失败**）：
 *   - `src/**`：源码面必须零命中（含注释）——G2。
 *   - `scripts/**`、`package.json`：打包/工具面必须零命中。
 *   - `.github/workflows/**`：CI 必需清单不得引用已移除产物。
 *
 * 用法：
 *   node scripts/check-removed-agents.mjs            # 从仓库根扫描
 *   node scripts/check-removed-agents.mjs --root .   # 指定根
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  let root = path.resolve(__dirname, "..");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) root = path.resolve(argv[++i]);
  }
  return { root };
}

const NEEDLES = ["traework", "qoder"];

/** 零容忍目录/文件（相对根，posix 形式）：任何命中即失败。 */
const ZERO_TOLERANCE = [
  { prefix: "src/", label: "源码面" },
  { prefix: "scripts/", label: "脚本面" },
];
const ZERO_TOLERANCE_FILES = ["package.json"];
/** 本脚本自身必须包含被禁字符串（它就是判据），显式豁免。 */
const SELF = "scripts/check-removed-agents.mjs";

/** 白名单：允许命中，逐条给出理由（**必须逐条列名**，不用宽泛前缀，防止回流被吞掉）。 */
const ALLOW = [
  { test: (p) => /^docs\/release-v.*\.(en\.)?md$/.test(p), reason: "历史发布说明（忠实记录当时的变更）" },
  { test: (p) => /^CHANGELOG(\.en)?\.md$/.test(p), reason: "更新日志（历史记录）" },
  { test: (p) => p === "HANDOFF.md", reason: "交接文档的历史快照段落" },
  {
    test: (p) => p === "test/integration/legacy-removed-agent-rework.test.ts",
    reason: "0.9.10 显式验收用例（必须保留已移除 agentId 以证明 fail-closed）",
  },
  { test: (p) => p.startsWith("mcp-gui/"), reason: "GUI 独立交付面（自带门禁，不参与主包 CI）" },
  { test: (p) => /^README(\.en)?\.md$/.test(p), reason: "README 里程碑表与迁移说明" },
  { test: (p) => /^ARCHITECTURE(\.en)?\.md$/.test(p), reason: "架构文档的历史/迁移说明" },
  { test: (p) => /^CONTRIBUTING(\.en)?\.md$/.test(p), reason: "贡献指南的目录说明" },
  { test: (p) => /^SECURITY(\.en)?\.md$/.test(p), reason: "安全策略的历史说明" },
  {
    test: (p) => /^skills\/tianshu-mcp\/usage-examples\.md$/.test(p),
    reason: "技能示例的迁移说明（已废弃参数的处置）",
  },
  {
    test: (p) => /^docs\/[a-z0-9-]+(\.en)?\.md$/.test(p),
    reason: "docs/ 说明性文档（迁移说明/历史记录）",
  },
  {
    test: (p) => /^test\/unit\/(gui-cdp-client|gui-stop-disclosure|opendesign-discovery)\.test\.ts$/.test(p),
    reason: "回归用例中作为「已移除产品名」的边界样例（与具体 agent 无关）",
  },
];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "target", ".tmp-check", "tianshu-mcp-web"]);

/** 跳过仓库根的本地工具/缓存目录（不属于交付内容，且各带自己的历史副本）。 */
function isLocalToolDir(name) {
  return name.startsWith(".") && name !== ".github";
}
const TEXT_EXT = new Set([
  ".ts", ".mjs", ".js", ".json", ".md", ".yml", ".yaml", ".rs", ".txt", ".nsh", ".html", ".vue", ".css",
]);

function walk(dir, root, out, depth = 0) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (depth === 0 && isLocalToolDir(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, root, out, depth + 1);
    else out.push(path.relative(root, abs).split(path.sep).join("/"));
  }
}

function allowReason(rel) {
  for (const a of ALLOW) if (a.test(rel)) return a.reason;
  return null;
}

function isZeroTolerance(rel) {
  if (ZERO_TOLERANCE_FILES.includes(rel)) return "清单面";
  for (const z of ZERO_TOLERANCE) if (rel.startsWith(z.prefix)) return z.label;
  if (rel.startsWith(".github/workflows/")) return "CI 配置";
  return null;
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const files = [];
  walk(root, root, files);

  const violations = [];
  const allowed = [];
  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(root, rel), "utf8");
    } catch {
      continue;
    }
    const lower = text.toLowerCase();
    if (!NEEDLES.some((n) => lower.includes(n))) continue;
    if (rel === SELF) continue;
    const zone = isZeroTolerance(rel);
    const reason = allowReason(rel);
    if (zone) violations.push({ rel, zone });
    else if (reason) allowed.push({ rel, reason });
    // 既不在零容忍区、也不在白名单：视为未分类 → 失败（宁可显式销账，不让回流被静默放过）。
    else violations.push({ rel, zone: "未分类（请显式加入白名单或改为中性表述）" });
  }

  if (violations.length > 0) {
    console.error("✗ 已移除 agent 出现回流（零容忍区命中）：");
    for (const v of violations) console.error(`  [${v.zone}] ${v.rel}`);
    console.error(
      "\n源码 / 脚本 / package.json / .github/workflows 中不得再出现 traework 或 qoder。" +
        "若确需提及，请改为中性表述（如「某个已移除的 GUI 适配器」）。",
    );
    process.exit(1);
  }

  console.log(`✓ 零残留审计通过：扫描 ${files.length} 个文件，零容忍区 0 命中。`);
  if (allowed.length > 0) {
    console.log(`  白名单命中 ${allowed.length} 处（说明性文字 / 历史记录 / 显式验收用例）：`);
    for (const a of allowed) console.log(`    - ${a.rel} —— ${a.reason}`);
  }
}

main();
