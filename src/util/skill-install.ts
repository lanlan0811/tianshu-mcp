/**
 * 技能自检安装（开发计划 §17.5 / D19；issue #16 加固）。
 *
 * 启动后把**包内** `skills/tianshu-mcp/` 幂等同步到 `~/.rivet/skills/tianshu-mcp/`
 * （`os.homedir()` 动态解析，Windows 走 USERPROFILE、POSIX 走 $HOME）。失败仅告警不阻断 server。
 *
 * issue #16 的三处加固：
 * 1. **源定位收敛**：源只由 `import.meta.url` 相对定位，不再有基于 `process.cwd()` 的内容发现
 *    （供应链面的经典反模式）。找不到源时沿用既有「跳过安装 + warn」路径。
 * 2. **覆盖语义**：目标目录内维护安装清单 `<dest>/.tianshu-mcp-install.json`（版本 + 内容 hash），
 *    据此区分「未改动的旧版包副本」（可在 auto 模式自动升级）与「用户本地修改」
 *    （默认保留 + 强告警 + 不覆盖）。
 * 3. **安装原子性**：「tmp 目录 → 备份 → 换入」，崩溃/失败不留半成品；覆盖后按
 *    `skills.backupKeep` 收敛历史 `.bak-<ts>`。
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "./log.js";
import { MCP_SERVER_VERSION } from "../version.generated.js";

export const SKILL_NAME = "tianshu-mcp";
export const MANIFEST_FILE = ".tianshu-mcp-install.json";

/** 残留 `.incoming-*` 的清理阈值（毫秒）：早于该时长的临时目录视为崩溃残留 */
export const STALE_INCOMING_MS = 60 * 60_000;

export type AutoInstallMode = "auto" | "prompt";

export interface InstallManifest {
  schema: 1;
  name: string;
  /** 写入清单时的包版本（`MCP_SERVER_VERSION`） */
  packageVersion: string;
  /** 安装时的技能内容 hash（排除清单与平台噪声） */
  contentHash: string;
  installedAt: string;
  /** 诊断用：本次安装的源目录（机器本地路径） */
  sourceDir?: string;
  /** `autoInstall:"prompt"` 下检测到需更新但未自动覆盖时的待确认记录 */
  pendingUpdate?: { packageVersion: string; detectedAt: string };
}

export type InstallDecision =
  | { action: "install"; reason: "first-install" }
  | { action: "skip"; reason: "in-sync"; repairManifest: boolean }
  | { action: "overwrite"; reason: "stale-package-copy" | "approved" }
  | { action: "hold"; reason: "prompt-hold" | "user-modified" | "unknown-source" };

export interface SkillInstallOptions {
  /** 与 `skills.autoInstall` 对应：`auto` 走自动升级，`prompt` 只在需变更时保留并告警 */
  mode?: AutoInstallMode;
  /** `--approve-skill-update` / `TIANSHU_MCP_APPROVE_SKILL_UPDATE=1` */
  approveUpdate?: boolean;
  /** 覆盖后保留的历史备份个数（`skills.backupKeep`，0 = 不清理） */
  backupKeep?: number;
  /** 测试注入：默认 `resolveSkillDestDir()` */
  destDir?: string;
  /** 测试注入：默认 `resolveSkillSourceDir()` */
  sourceDir?: string;
  /** 测试注入：默认 `MCP_SERVER_VERSION` */
  pkgVersion?: string;
  /** 测试注入：拷目录实现（默认 `copySkillTree`），可注入抛错以验证失败回滚 */
  copyImpl?: (src: string, dest: string) => void;
}

export interface SkillInstallResult {
  installed: boolean;
  skipped: boolean;
  failed: boolean;
  /** 该装但按策略未装（prompt 保留 / 用户修改 / 来源不明），调用方不应再记 info */
  held: boolean;
  action: InstallDecision["action"] | "error";
  reason: string;
  destDir: string;
  bakPath?: string;
  message: string;
}

/* ---------------- 源 / 目标定位 ---------------- */

/**
 * 源目录定位：**只**由 `import.meta.url` 相对包自身定位（issue #16 问题 1）。
 * - 源码直跑：`<repo>/src/util/skill-install.ts` → `<repo>/skills/tianshu-mcp`
 * - dist 运行：`<pkg>/dist/util/skill-install.js` → `<pkg>/skills/tianshu-mcp`
 * 两种布局相对深度一致，无需候选链；刻意不再回退 `process.cwd()`（不受控目录）。
 */
export function resolveSkillSourceDir(): string {
  const here = fileURLToPath(import.meta.url); // 正确处理 Windows 盘符与非 ASCII 路径（提交 55cf2d0）
  return path.resolve(path.dirname(here), "..", "..", "skills", SKILL_NAME);
}

export function resolveSkillDestDir(): string {
  return path.join(os.homedir(), ".rivet", "skills", SKILL_NAME);
}

/* ---------------- 排除规则与 hash ---------------- */

/**
 * hash / 拷贝统一排除的条目名（按 basename，任意深度生效；命中目录则整棵跳过）。
 * - 安装清单自身：否则「写清单」会被下一轮当成内容变更。
 * - 平台噪声：`.DS_Store`（macOS）、`Thumbs.db`/`desktop.ini`（Windows）、`._*`（AppleDouble）。
 * - `.git*`：用户自带的版本控制元数据。
 */
export function isExcludedName(name: string): boolean {
  if (name === MANIFEST_FILE) return true;
  if (name === ".DS_Store" || name === "Thumbs.db" || name === "desktop.ini") return true;
  if (name.startsWith("._")) return true;
  if (name.startsWith(".git")) return true;
  return false;
}

/** 技能树内容 hash：相对路径（统一 `/`）+ 文件内容，文件按路径排序；排除见 `isExcludedName`。 */
export function hashSkillTree(dir: string): string {
  const files: string[] = [];
  const walk = (d: string): void => {
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

function copySkillTree(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (isExcludedName(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copySkillTree(s, d);
    } else if (e.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

/* ---------------- 安装清单 ---------------- */

const HEX64 = /^[0-9a-f]{64}$/;

export function readManifest(destDir: string): {
  state: "ok" | "missing" | "corrupt";
  manifest: InstallManifest | null;
} {
  let text: string;
  try {
    text = fs.readFileSync(path.join(destDir, MANIFEST_FILE), "utf8");
  } catch {
    return { state: "missing", manifest: null };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { state: "corrupt", manifest: null };
  }
  const m = raw as Partial<InstallManifest> | null;
  const valid =
    m !== null &&
    typeof m === "object" &&
    m.schema === 1 &&
    m.name === SKILL_NAME &&
    typeof m.packageVersion === "string" &&
    m.packageVersion.length > 0 &&
    typeof m.contentHash === "string" &&
    HEX64.test(m.contentHash) &&
    typeof m.installedAt === "string";
  if (!valid) return { state: "corrupt", manifest: null };
  return { state: "ok", manifest: m as InstallManifest };
}

function writeManifest(
  destDir: string,
  pkgVersion: string,
  contentHash: string,
  sourceDir: string,
  pendingUpdate?: InstallManifest["pendingUpdate"],
): void {
  const data: InstallManifest = {
    schema: 1,
    name: SKILL_NAME,
    packageVersion: pkgVersion,
    contentHash,
    installedAt: new Date().toISOString(),
  };
  if (sourceDir) data.sourceDir = sourceDir;
  if (pendingUpdate) data.pendingUpdate = pendingUpdate;
  fs.writeFileSync(path.join(destDir, MANIFEST_FILE), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/* ---------------- 判定（纯函数，覆盖计划 §3 的 6×4 矩阵） ---------------- */

export interface DecideInput {
  destExists: boolean;
  destIsDir: boolean;
  /** 目标内容 hash；目标不存在/非目录/不可读时为 null */
  destHash: string | null;
  manifestState: "ok" | "missing" | "corrupt";
  manifest: InstallManifest | null;
  pkgHash: string;
  pkgVersion: string;
  mode: AutoInstallMode;
  approveUpdate: boolean;
}

export function decideInstall(input: DecideInput): InstallDecision {
  const { destExists, destHash, manifestState, manifest, pkgHash, mode, approveUpdate } = input;

  // #1 首次安装
  if (!destExists) return { action: "install", reason: "first-install" };

  // #2 内容一致：跳过（按需补写/校准清单，改动清单不影响 hash）
  if (destHash !== null && destHash === pkgHash) {
    const manifestMatches = manifestState === "ok" && manifest !== null && manifest.contentHash === pkgHash;
    return { action: "skip", reason: "in-sync", repairManifest: !manifestMatches };
  }

  // 读不了目标（非目录/不可读）：无法证明任何事 → 来源不明语义
  if (destHash === null) {
    return approveUpdate
      ? { action: "overwrite", reason: "approved" }
      : { action: "hold", reason: "unknown-source" };
  }

  if (manifestState === "ok" && manifest !== null) {
    // #3 清单可证未被改动 → 未改动的旧版包副本
    if (destHash === manifest.contentHash) {
      if (mode === "auto") return { action: "overwrite", reason: "stale-package-copy" };
      if (approveUpdate) return { action: "overwrite", reason: "approved" };
      return { action: "hold", reason: "prompt-hold" };
    }
    // #4 清单在且内容不等 → 已确证的用户本地修改（放行参数不生效，须人工处置）
    return { action: "hold", reason: "user-modified" };
  }

  // #5 无有效清单（缺失/损坏）且内容不等 → 来源不明（默认保留，CLI 可放行）
  return approveUpdate
    ? { action: "overwrite", reason: "approved" }
    : { action: "hold", reason: "unknown-source" };
}

/* ---------------- 备份清理 ---------------- */

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 扫描历史备份并给出保留/删除决策（不执行删除）。只匹配 `<SKILL_NAME>.bak-<数字>` 目录。 */
export function planBackups(parentDir: string, keep: number): { keep: string[]; remove: string[] } {
  if (keep <= 0) return { keep: [], remove: [] };
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return { keep: [], remove: [] };
  }
  const re = new RegExp(`^${escapeRe(SKILL_NAME)}\\.bak-(\\d+)$`);
  const matched: { p: string; ts: number }[] = [];
  for (const e of entries) {
    const m = re.exec(e.name);
    if (!m) continue;
    const full = path.join(parentDir, e.name);
    try {
      if (!fs.statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    matched.push({ p: full, ts: Number(m[1]) });
  }
  matched.sort((a, b) => b.ts - a.ts); // 时间戳降序：新的在前
  return { keep: matched.slice(0, keep).map((x) => x.p), remove: matched.slice(keep).map((x) => x.p) };
}

function pruneBackups(parentDir: string, keep: number, logger: Logger): string[] {
  const { remove } = planBackups(parentDir, keep);
  const removed: string[] = [];
  for (const p of remove) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      removed.push(p);
    } catch (e) {
      logger.warn(`技能备份清理失败（不影响安装）：${p} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return removed;
}

/** 清理崩溃残留的 `<SKILL_NAME>.incoming-<ts>-<hex>`（仅当 mtime 早于阈值）。 */
function cleanStaleIncoming(parentDir: string, logger: Logger, olderThanMs = STALE_INCOMING_MS): string[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const re = new RegExp(`^${escapeRe(SKILL_NAME)}\\.incoming-\\d+-[0-9a-f]+$`);
  const removed: string[] = [];
  const now = Date.now();
  for (const e of entries) {
    if (!re.test(e.name)) continue;
    const full = path.join(parentDir, e.name);
    try {
      if (now - fs.statSync(full).mtimeMs > olderThanMs) {
        fs.rmSync(full, { recursive: true, force: true });
        removed.push(full);
      }
    } catch {
      /* ignore */
    }
  }
  if (removed.length > 0) {
    logger.info(`技能安装临时目录清理：已删除 ${removed.length} 个残留（${removed.join("，")}）。`);
  }
  return removed;
}

/* ---------------- 安装（tmp → 备份 → 换入） ---------------- */

interface InstallOutcome {
  bakPath: string | null;
  alreadyExisted: boolean;
}

function installFromSource(
  src: string,
  dest: string,
  pkgHash: string,
  pkgVersion: string,
  copyImpl: (src: string, dest: string) => void,
  logger: Logger,
): InstallOutcome {
  const parent = path.dirname(dest);
  fs.mkdirSync(parent, { recursive: true });
  cleanStaleIncoming(parent, logger);

  const tmp = `${dest}.incoming-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const alreadyExisted = fs.existsSync(dest);
  let bakPath: string | null = null;
  try {
    copyImpl(src, tmp);
    writeManifest(tmp, pkgVersion, pkgHash, src);
    if (alreadyExisted) {
      bakPath = `${dest}.bak-${Date.now()}`;
      fs.renameSync(dest, bakPath);
    }
    fs.renameSync(tmp, dest);
    return { bakPath, alreadyExisted };
  } catch (e) {
    // 失败回滚：清掉 tmp；若已把 dest 挪成 bak 则挪回来（回滚失败仅告警，bak 仍在）
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    if (bakPath) {
      try {
        if (!fs.existsSync(dest)) fs.renameSync(bakPath, dest);
      } catch (e2) {
        logger.warn(
          `技能安装回滚失败（原目录仍在 ${bakPath}，下次启动会按首次安装重试）：${
            e2 instanceof Error ? e2.message : String(e2)
          }`,
        );
      }
    }
    throw e;
  }
}

/* ---------------- 对外入口 ---------------- */

const h8 = (hash: string): string => hash.slice(0, 8);

export async function skillSelfInstall(
  logger: Logger,
  opts: SkillInstallOptions = {},
): Promise<SkillInstallResult> {
  const mode: AutoInstallMode = opts.mode ?? "auto";
  const approveUpdate = opts.approveUpdate === true;
  const backupKeep = opts.backupKeep ?? 3;
  const src = opts.sourceDir ?? resolveSkillSourceDir();
  const dest = opts.destDir ?? resolveSkillDestDir();
  const copyImpl = opts.copyImpl ?? copySkillTree;
  const pkgVersion = opts.pkgVersion ?? MCP_SERVER_VERSION;

  try {
    if (!fs.existsSync(src)) {
      const msg = `技能源目录不存在（${src}），跳过安装。`;
      logger.warn(msg);
      return { installed: false, skipped: true, failed: false, held: false, action: "skip", reason: "source-missing", destDir: dest, message: msg };
    }

    const pkgHash = hashSkillTree(src);

    const destExists = fs.existsSync(dest);
    let destIsDir = false;
    let destHash: string | null = null;
    if (destExists) {
      try {
        destIsDir = fs.statSync(dest).isDirectory();
      } catch {
        destIsDir = false;
      }
      if (destIsDir) {
        try {
          destHash = hashSkillTree(dest);
        } catch {
          destHash = null; // 读不了目标：无法证明任何事
        }
      }
    }
    const { state: manifestState, manifest } = destIsDir
      ? readManifest(dest)
      : { state: "missing" as const, manifest: null };

    const decision = decideInstall({
      destExists,
      destIsDir,
      destHash,
      manifestState,
      manifest,
      pkgHash,
      pkgVersion,
      mode,
      approveUpdate,
    });

    switch (decision.action) {
      case "install": {
        const { bakPath } = installFromSource(src, dest, pkgHash, pkgVersion, copyImpl, logger);
        const msg = `技能已安装到 ${dest}（新会话生效，无热加载）。`;
        logger.info(msg);
        return { installed: true, skipped: false, failed: false, held: false, action: "install", reason: decision.reason, destDir: dest, bakPath: bakPath ?? undefined, message: msg };
      }

      case "skip": {
        if (decision.repairManifest) {
          try {
            writeManifest(dest, pkgVersion, pkgHash, src);
            logger.info(
              `技能安装清单已${manifestState === "missing" ? "补写" : "校准"}（${path.join(dest, MANIFEST_FILE)}）：包版本 v${pkgVersion}，内容 hash ${h8(pkgHash)}。`,
            );
          } catch (e) {
            logger.warn(`技能安装清单写入失败（不影响技能使用）：${e instanceof Error ? e.message : String(e)}`);
          }
        }
        const msg = `技能已安装且内容一致，跳过（${dest}）。`;
        logger.info(msg);
        return { installed: false, skipped: true, failed: false, held: false, action: "skip", reason: decision.reason, destDir: dest, message: msg };
      }

      case "overwrite": {
        const { bakPath } = installFromSource(src, dest, pkgHash, pkgVersion, copyImpl, logger);
        const msg =
          decision.reason === "approved"
            ? `技能已按 --approve-skill-update 授权覆盖：${dest} → 备份 ${bakPath} → 包内版本 v${pkgVersion}（新会话生效）。`
            : `技能旧版副本已升级：${dest} → 备份 ${bakPath} → 覆盖为包内版本 v${pkgVersion}（hash ${h8(pkgHash)}，新会话生效）。`;
        logger.warn(msg);
        const removed = pruneBackups(path.dirname(dest), backupKeep, logger);
        if (backupKeep > 0) {
          logger.info(
            `技能备份清理：保留最近 ${backupKeep} 个，已删除 ${removed.length} 个${removed.length ? `（${removed.join("，")}）` : ""}。`,
          );
        }
        return { installed: true, skipped: false, failed: false, held: false, action: "overwrite", reason: decision.reason, destDir: dest, bakPath: bakPath ?? undefined, message: msg };
      }

      case "hold": {
        let msg: string;
        if (decision.reason === "prompt-hold") {
          const installedVer = manifest?.packageVersion ?? "未知";
          msg = `skills.autoInstall="prompt" 且技能需更新：已保留 ${dest}（已装 v${installedVer}，包内 v${pkgVersion}），未自动覆盖。`;
          logger.warn(msg);
          logger.warn(
            `确认升级请带 --approve-skill-update（或 TIANSHU_MCP_APPROVE_SKILL_UPDATE=1）重启 server；覆盖前会先备份到 .bak-<时间戳>。`,
          );
          if (manifestState === "ok" && manifest) {
            try {
              const next: InstallManifest = { ...manifest, pendingUpdate: { packageVersion: pkgVersion, detectedAt: new Date().toISOString() } };
              fs.writeFileSync(path.join(dest, MANIFEST_FILE), `${JSON.stringify(next, null, 2)}\n`, "utf8");
              logger.info(`技能安装清单已记录待确认更新（pendingUpdate：v${pkgVersion}）。`);
            } catch (e) {
              logger.warn(`技能安装清单写入失败（不影响技能使用）：${e instanceof Error ? e.message : String(e)}`);
            }
          }
        } else if (decision.reason === "user-modified") {
          const recHash8 = manifest ? h8(manifest.contentHash) : "无";
          msg = `检测到技能目录含本地修改：${dest}（内容 hash ${h8(destHash ?? "")} ≠ 清单记录 ${recHash8}），包内版本 v${pkgVersion}；已保留你的版本、未做覆盖。`;
          logger.warn(msg);
          logger.warn(
            `处置方式二选一：① 以包内版本为准 → 把 ${dest} 改名或删除后重启 server（会自动重装）；` +
              `② 保留改动 → 手工把改动合并进包内副本后再重启。注意 --approve-skill-update 对含本地修改的目录不生效。`,
          );
        } else {
          msg = `技能目录与包内版本不一致，且无有效安装清单可证未改动（来源不明）：${dest}；已保留现有内容、未覆盖。`;
          logger.warn(msg);
          logger.warn(`确认可覆盖时带 --approve-skill-update 重启 server（覆盖前先备份到 .bak-<时间戳>）。`);
        }
        return { installed: false, skipped: false, failed: false, held: true, action: "hold", reason: decision.reason, destDir: dest, message: msg };
      }
    }
  } catch (e) {
    const msg = `技能自检安装失败（仅告警，不影响 MCP 工具面）：${e instanceof Error ? e.message : String(e)}`;
    logger.warn(msg);
    return { installed: false, skipped: false, failed: true, held: false, action: "error", reason: "error", destDir: dest, message: msg };
  }
}
