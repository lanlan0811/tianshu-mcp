#!/usr/bin/env node
/**
 * 组合发布正文（GitHub / Gitee 发行版共用）。
 *
 * 目的：把每个版本的双语发布说明文档（docs/release-v<版本>.md 与 .en.md）合成为发行版正文，并：
 *   1) 把文档里的**相对链接**改写为指向该 tag 的**绝对链接**（否则 Release 页上会 404）；
 *   2) 末尾追加 npm 包链接、CI 链接（可选）与 Full Changelog 比较链接。
 *
 * 用法（CLI）：
 *   node scripts/release-body.mjs <version> <github|gitee> [ownerRepo] [npmPackage] [ciRunId] [previousVersion]
 *   例：node scripts/release-body.mjs 0.3.0 github lanlan0811/tianshu-mcp tianshu-mcp 34661265199 0.2.0
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "..");

/**
 * host 标识 → 站点域名（避免把 "gitee" 当成域名拼出 `https://gitee/...`）。
 * @param {"github"|"gitee"} host
 */
export function hostDomain(host) {
  return host === "gitee" ? "gitee.com" : "github.com";
}

/**
 * 把文档中的相对 markdown 链接改写为该 tag 的绝对链接。
 * 仅改写形如 `](name.md)` / `](name.en.md)` 的文档内相对链接；已是 http(s) 的保持原样。
 * @param {string} text
 * @param {{host: "github"|"gitee", ownerRepo: string, tag: string}} ctx
 */
export function absolutizeDocLinks(text, { host, ownerRepo, tag }) {
  const base = `https://${hostDomain(host)}/${ownerRepo}/blob/${tag}/docs/`;
  return text.replace(/\]\((?!https?:\/\/)([^)\s]+\.md)(#[^)]*)?\)/g, (_m, file, anchor) => {
    return `](${base}${file}${anchor ?? ""})`;
  });
}

/**
 * 读取发布说明文档；缺失时返回 null。
 * @param {string} version
 * @param {"zh"|"en"} lang
 */
export function readReleaseDoc(version, lang) {
  const suffix = lang === "en" ? ".en.md" : ".md";
  const p = path.join(repoRoot, "docs", `release-v${version}${suffix}`);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : null;
}

/**
 * @typedef {Object} ComposeOptions
 * @property {string} version
 * @property {"github"|"gitee"} host
 * @property {string} ownerRepo   形如 lanlan0811/tianshu-mcp 或 Lan0811/tianshu-mcp
 * @property {string} [npmPackage]
 * @property {string|number} [ciRunId]
 * @property {string} [previousVersion]  用于 Full Changelog 的上一版本 tag（不含 v）
 */

/**
 * 合成双语发布正文。
 * @param {ComposeOptions} opts
 * @returns {string}
 */
export function composeReleaseBody(opts) {
  const version = String(opts.version).replace(/^v/, "");
  const tag = `v${version}`;
  const { host, ownerRepo } = opts;
  const npmPackage = opts.npmPackage ?? "tianshu-mcp";

  const zh = readReleaseDoc(version, "zh");
  const en = readReleaseDoc(version, "en");
  if (!zh && !en) {
    throw new Error(
      `未找到发布说明文档 docs/release-v${version}.md / .en.md；请先写好发布说明再发布。`,
    );
  }

  /** @type {string[]} */
  const parts = [];
  if (zh) parts.push(absolutizeDocLinks(zh, { host, ownerRepo, tag }));
  if (en) {
    parts.push("---");
    parts.push(absolutizeDocLinks(en, { host, ownerRepo, tag }));
  }

  /** @type {string[]} */
  const footer = ["---", ""];
  footer.push(`**npm**: https://www.npmjs.com/package/${npmPackage}/v/${version}`);
  if (opts.ciRunId) footer.push(`**CI**: https://github.com/${ownerRepo}/actions/runs/${opts.ciRunId}`);
  const prev = opts.previousVersion ? `v${String(opts.previousVersion).replace(/^v/, "")}` : "";
  if (host === "github") {
    footer.push(
      prev
        ? `**Full Changelog**: https://github.com/${ownerRepo}/compare/${prev}...${tag}`
        : `**Full Changelog**: https://github.com/${ownerRepo}/commits/${tag}`,
    );
  } else {
    // Gitee 的比较页路径与 GitHub 不同，指向该 tag 的提交列表更稳
    footer.push(`**Full Changelog**: https://gitee.com/${ownerRepo}/commits/${tag}`);
  }
  parts.push(footer.join("\n"));

  return parts.join("\n\n").trimEnd() + "\n";
}

// CLI 入口（跨平台判断：比较解析后的文件路径）
const invokedDirectly =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const [, , version, host, ownerRepo, npmPackage, ciRunId, previousVersion] = process.argv;
  if (!version || !host) {
    console.error(
      "用法: node scripts/release-body.mjs <version> <github|gitee> [ownerRepo] [npmPackage] [ciRunId] [previousVersion]",
    );
    process.exit(2);
  }
  if (host !== "github" && host !== "gitee") {
    console.error("host 必须是 github 或 gitee");
    process.exit(2);
  }
  const repo = ownerRepo || (host === "github" ? "lanlan0811/tianshu-mcp" : "Lan0811/tianshu-mcp");
  try {
    process.stdout.write(
      composeReleaseBody({
        version,
        host,
        ownerRepo: repo,
        npmPackage: npmPackage || "tianshu-mcp",
        ciRunId: ciRunId || undefined,
        previousVersion: previousVersion || undefined,
      }),
    );
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}
