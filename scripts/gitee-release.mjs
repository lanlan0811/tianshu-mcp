#!/usr/bin/env node
/**
 * 创建/更新 Gitee 发行版（Release）——镜像仓库补齐。
 *
 * 背景：GitHub Actions 的 release 工作流只作用于 GitHub；Gitee 作为镜像仓库需要单独创建发行版，
 * 否则会出现「只有 tag、没有发行版」的不一致。本脚本用 Gitee OpenAPI 幂等补齐：
 * 已存在同 tag 发行版则更新正文，不存在则创建。
 *
 * 正文由 scripts/release-body.mjs 合成（双语发布说明 + 绝对链接 + npm/Changelog），
 * 链接指向 gitee.com，确保在 Gitee 页面可点。
 *
 * 用法：
 *   GITEE_TOKEN=<私人令牌> node scripts/gitee-release.mjs <version> [previousVersion]
 *   # 例：GITEE_TOKEN=xxx node scripts/gitee-release.mjs 0.3.0 0.2.0
 *
 * 环境变量：
 *   GITEE_TOKEN   必填（也可用 GITEE_ACCESS_TOKEN；两者都无则跳过并以 0 退出）
 *   GITEE_OWNER   可选，默认 Lan0811
 *   GITEE_REPO    可选，默认 tianshu-mcp
 *   GITEE_BRANCH  可选，默认 master（创建发行版时的目标分支）
 *
 * 令牌获取：Gitee → 设置 → 私人令牌 → 生成新令牌（至少勾选 projects 权限）。
 */
import { composeReleaseBody, repoRoot } from "./release-body.mjs";

const token = (process.env.GITEE_TOKEN || process.env.GITEE_ACCESS_TOKEN || "").trim();
const owner = (process.env.GITEE_OWNER || "Lan0811").trim();
const repo = (process.env.GITEE_REPO || "tianshu-mcp").trim();
const branch = (process.env.GITEE_BRANCH || "master").trim();
void repoRoot;

const version = (process.argv[2] || "").replace(/^v/, "").trim();
const previousVersion = (process.argv[3] || "").replace(/^v/, "").trim() || undefined;
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error("用法: node scripts/gitee-release.mjs <version> [previousVersion]（version 形如 0.3.0）");
  process.exit(2);
}
const tag = `v${version}`;

if (!token) {
  console.log(
    "未设置 GITEE_TOKEN / GITEE_ACCESS_TOKEN，跳过 Gitee 发行版（设置令牌后重跑本脚本或由 CI 自动补齐）。",
  );
  process.exit(0);
}

// 合成正文：双语 + 指向 gitee.com 的绝对链接
let body;
try {
  body = composeReleaseBody({
    version,
    host: "gitee",
    ownerRepo: `${owner}/${repo}`,
    npmPackage: "tianshu-mcp",
    previousVersion,
  });
} catch (e) {
  console.error(`合成发布正文失败：${e.message || e}`);
  process.exit(1);
}
console.log(`发布正文已合成（${body.length} 字符，双语 + gitee 绝对链接）`);

const api = `https://gitee.com/api/v5/repos/${owner}/${repo}`;
const q = new URLSearchParams({ access_token: token }).toString();
const name = `tianshu-mcp ${tag}`;

async function getExisting() {
  const r = await fetch(`${api}/releases/tags/${tag}?${q}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`查询发行版失败 HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function create() {
  const r = await fetch(`${api}/releases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: token, tag_name: tag, name, body, target_commitish: branch }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`创建发行版失败 HTTP ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function update(id) {
  const r = await fetch(`${api}/releases/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: token, tag_name: tag, name, body }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`更新发行版失败 HTTP ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

try {
  const existing = await getExisting();
  if (existing) {
    console.log(`已存在 ${tag} 发行版（id=${existing.id}），更新正文…`);
    const updated = await update(existing.id);
    console.log(`更新成功: ${updated.name} | https://gitee.com/${owner}/${repo}/releases/${tag}`);
  } else {
    console.log(`未找到 ${tag} 发行版，创建中…`);
    const created = await create();
    console.log(`创建成功: ${created.name} | https://gitee.com/${owner}/${repo}/releases/${tag}`);
  }
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}
