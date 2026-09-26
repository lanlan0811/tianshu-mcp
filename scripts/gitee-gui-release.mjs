#!/usr/bin/env node
/**
 * Gitee 侧 GUI 测试版发布（issue #25 §5.4）。
 *
 * 与 MCP 主包的 `gitee-release.mjs` **分开实现**：GUI 的 tag 形态（`gui-v*`）、
 * 版本序列（独立 `0.1.0-beta.N`）与正文来源都不同，混在一个脚本里会把 GUI 分支
 * 引入主包发布路径。凭据沿用仓库 Secret `GITEE_TOKEN`，不新建重复实现。
 *
 * 职责：
 *  1. 幂等创建/更新 Gitee **预发布**（pre-release）；
 *  2. **上传安装包附件**（现有主包脚本没有这个能力）；
 *  3. 用附件下载地址改写更新清单中的 url，生成 `latest-gitee.json`；
 *  4. 通过 Gitee Contents API 把清单写入仓内 raw 路径（双源自动更新的 Gitee 端点）。
 *
 * 用法：
 *   GITEE_TOKEN=xxx node scripts/gitee-gui-release.mjs \
 *     --version 0.1.0-beta.1 --tag gui-v0.1.0-beta.1 \
 *     --files "/abs/a.nsis.zip,/abs/b.dmg" \
 *     --github-manifest ./latest.json --out-manifest ./latest-gitee.json
 *
 * 环境变量：GITEE_TOKEN / GITEE_ACCESS_TOKEN（必填，缺则 exit 1）；
 *          GITEE_OWNER（默认 lan0811）、GITEE_REPO（默认 tianshu-mcp）、GITEE_BRANCH（默认 master）。
 */
import { readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";

const token = (process.env.GITEE_TOKEN || process.env.GITEE_ACCESS_TOKEN || "").trim();
const owner = (process.env.GITEE_OWNER || "lan0811").trim();
const repo = (process.env.GITEE_REPO || "tianshu-mcp").trim();
const branch = (process.env.GITEE_BRANCH || "master").trim();

/** Gitee raw 清单路径（与 src-tauri/tauri.conf.json 的端点一致） */
const MANIFEST_REPO_PATH = "update/gui/latest-gitee.json";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key.startsWith("--")) {
      args[key.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const version = (args.version || "").replace(/^gui-v/, "").replace(/^v/, "").trim();
const tag = (args.tag || `gui-v${version}`).trim();
const files = (args.files || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const githubManifest = args["github-manifest"];
const outManifest = args["out-manifest"] || "latest-gitee.json";

if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error("用法：node scripts/gitee-gui-release.mjs --version 0.1.0-beta.1 --tag gui-v0.1.0-beta.1 --files a,b [--github-manifest x.json] [--out-manifest y.json]");
  process.exit(2);
}
if (!token) {
  console.error("缺少 GITEE_TOKEN / GITEE_ACCESS_TOKEN：Gitee 侧发布是双源更新的必要条件，拒绝跳过。");
  process.exit(1);
}
for (const file of files) {
  if (!statSync(path.resolve(file), { throwIfNoEntry: false })) {
    console.error(`附件不存在：${file}`);
    process.exit(1);
  }
}

const api = `https://gitee.com/api/v5/repos/${owner}/${repo}`;
const q = `access_token=${encodeURIComponent(token)}`;
const releaseName = `Tianshu-mcp 日志台 ${tag}（测试版）`;

function releaseBody() {
  return [
    `## Tianshu-mcp 日志台 ${version}（测试版 / pre-release）`,
    "",
    "本地只读查看天枢 MCP 的运行日志与任务产物（Tauri 2.x + Vue 3）。",
    "",
    "### 本轮产物",
    ...files.map((f) => `- \`${path.basename(f)}\``),
    "",
    "### 说明",
    "- 应用**全程只读**业务数据，不写入任何业务目录。",
    "- 自动更新强制校验 minisign 签名，**验签不通过一律拒绝安装**。",
    "- 更新源按实测择优：中国大陆命中 Gitee，境外（含中国香港、中国台湾）命中 GitHub。",
    "- 英文说明与完整文档见仓库 `docs/gui-log-viewer.md` / `.en.md`。",
    "",
    `> GUI 使用独立版本号与独立 tag（\`gui-v*\`），不随 MCP 主包发布。`,
  ].join("\n");
}

async function getExistingRelease() {
  const res = await fetch(`${api}/releases/tags/${tag}?${q}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`查询发行版失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function createRelease() {
  const res = await fetch(`${api}/releases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      access_token: token,
      tag_name: tag,
      name: releaseName,
      body: releaseBody(),
      target_commitish: branch,
      prerelease: true,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`创建发行版失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function updateRelease(id) {
  const res = await fetch(`${api}/releases/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      access_token: token,
      tag_name: tag,
      name: releaseName,
      body: releaseBody(),
      prerelease: true,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`更新发行版失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function listAttachments(releaseId) {
  const res = await fetch(`${api}/releases/${releaseId}/attach_files?${q}`);
  if (!res.ok) {
    // 附件列表接口不可用时返回空列表，由上传接口的幂等行为兜底
    return [];
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function attachmentUrl(attachment) {
  return attachment.download_url || attachment.browser_download_url || attachment.url || "";
}

async function uploadAttachment(releaseId, filePath) {
  const filename = path.basename(filePath);
  const buffer = readFileSync(filePath);
  const form = new FormData();
  form.append("access_token", token);
  form.append("file", new Blob([buffer]), filename);
  const res = await fetch(`${api}/releases/${releaseId}/attach_files`, {
    method: "POST",
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`上传附件 ${filename} 失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function putRepoFile(repoPath, content) {
  const getRes = await fetch(`${api}/contents/${repoPath}?${q}&ref=${branch}`);
  let sha;
  if (getRes.ok) {
    const existing = await getRes.json();
    sha = existing?.sha;
  } else if (getRes.status !== 404) {
    throw new Error(`读取仓内文件失败 HTTP ${getRes.status}`);
  }
  const body = {
    access_token: token,
    content: Buffer.from(content, "utf8").toString("base64"),
    message: `chore(gui): 更新 Gitee 更新清单到 ${tag}`,
    branch,
  };
  if (sha) body.sha = sha;
  const res = await fetch(`${api}/contents/${repoPath}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`写入仓内文件 ${repoPath} 失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
}

async function main() {
  const existing = await getExistingRelease();
  const release = existing ? await updateRelease(existing.id) : await createRelease();
  console.log(`Gitee 预发布就绪：${release.name ?? releaseName}（id=${release.id}）`);

  const before = await listAttachments(release.id);
  const urlByName = new Map();
  for (const item of before) {
    if (item?.name) urlByName.set(item.name, attachmentUrl(item));
  }

  for (const file of files) {
    const filename = path.basename(file);
    if (urlByName.has(filename)) {
      console.log(`附件已存在，跳过上传：${filename}`);
      continue;
    }
    const uploaded = await uploadAttachment(release.id, file);
    const url = attachmentUrl(uploaded);
    if (!url) {
      throw new Error(`上传 ${filename} 成功但未返回下载地址，无法生成更新清单`);
    }
    urlByName.set(filename, url);
    console.log(`已上传附件：${filename} → ${url}`);
  }

  // 用 Gitee 附件地址改写清单（签名保持不变：同一份 minisign 签名，两端内容等价）
  const gh = JSON.parse(readFileSync(path.resolve(githubManifest), "utf8"));
  const platforms = {};
  const missing = [];
  for (const [platform, entry] of Object.entries(gh.platforms ?? {})) {
    const filename = decodeURIComponent(String(entry.url).split("/").pop() ?? "");
    const url = urlByName.get(filename);
    if (!url) {
      missing.push(filename);
      platforms[platform] = entry;
      continue;
    }
    platforms[platform] = { signature: entry.signature, url };
  }
  if (missing.length > 0) {
    console.warn(`以下平台未在 Gitee 找到对应附件，沿用 GitHub 地址：${missing.join(", ")}`);
  }

  const manifest = { ...gh, platforms };
  writeFileSync(path.resolve(outManifest), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`已生成 Gitee 清单：${outManifest}（平台 ${Object.keys(platforms).join(", ")}）`);

  await putRepoFile(MANIFEST_REPO_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`已写入 Gitee 仓内清单：${MANIFEST_REPO_PATH}`);
}

main().catch((err) => {
  console.error(String(err.message || err));
  process.exit(1);
});