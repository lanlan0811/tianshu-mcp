#!/usr/bin/env node
/**
 * 生成 / 合并 Tauri updater 更新清单。
 *
 * 两种模式：
 *  1) fragment —— 在某个平台的构建产物目录里找出更新载体（Windows 为 `*.nsis.zip`，
 *     macOS 为 `*.app.tar.gz`）与同名 `.sig`，产出一个单平台片段 JSON；
 *  2) merge —— 把所有片段合并为最终 `latest.json`（或改写 URL 后的 `latest-gitee.json`）。
 *
 * 为什么自己生成而不是用 tauri-action：双源发布需要**同一份签名、两套下载地址**，
 * 自己生成清单才能精确改写 Gitee 侧的 url 而保持签名不变。
 *
 * 用法：
 *   node build-updater-manifest.mjs fragment --platform windows-x86_64 --bundle-dir <dir> \
 *        --base-url <release-assets-url> --out <fragment.json>
 *   node build-updater-manifest.mjs merge --fragments <dir> --version <v> [--notes <text>] \
 *        [--rewrite-url <mapping.json>] --out <latest.json>
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

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

const UPSTREAM_SUFFIXES = [".nsis.zip", ".app.tar.gz"];

function isUpdaterArtifact(name) {
  return UPSTREAM_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function buildFragment(args) {
  const bundleDir = path.resolve(args["bundle-dir"] ?? ".");
  const platform = args.platform;
  const baseUrl = (args["base-url"] ?? "").replace(/\/+$/, "");
  if (!platform) throw new Error("fragment 模式需要 --platform");

  const files = walk(bundleDir);
  const artifact = files.find((f) => isUpdaterArtifact(path.basename(f)));
  if (!artifact) {
    throw new Error(`在 ${bundleDir} 未找到更新载体（${UPSTREAM_SUFFIXES.join(" / ")}）`);
  }
  const sigFile = `${artifact}.sig`;
  if (!files.includes(sigFile)) {
    throw new Error(
      `缺少签名文件 ${sigFile}：请确认已配置 TAURI_SIGNING_PRIVATE_KEY（签名不通过时必须拒绝安装）`,
    );
  }
  const filename = path.basename(artifact);
  const fragment = {
    platform,
    filename,
    signature: readFileSync(sigFile, "utf8").trim(),
    url: `${baseUrl}/${encodeURIComponent(filename)}`,
  };
  const out = args.out;
  if (out) {
    writeFileSync(out, `${JSON.stringify(fragment, null, 2)}\n`, "utf8");
    console.log(`[manifest] 片段已写入 ${out}（${platform} → ${filename}）`);
  } else {
    process.stdout.write(`${JSON.stringify(fragment, null, 2)}\n`);
  }
}

function buildMerged(args) {
  const fragmentsDir = path.resolve(args.fragments ?? ".");
  const version = args.version;
  if (!version) throw new Error("merge 模式需要 --version");

  // --rewrite-url name=url 可重复，用于把下载地址换成另一源（Gitee 附件）
  const rewrites = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--rewrite-url") {
      const pair = argv[i + 1] ?? "";
      const at = pair.indexOf("=");
      if (at > 0) rewrites[pair.slice(0, at)] = pair.slice(at + 1);
      i += 1;
    }
  }

  const platforms = {};
  for (const file of walk(fragmentsDir)) {
    if (!file.endsWith(".json")) continue;
    const fragment = JSON.parse(readFileSync(file, "utf8"));
    if (!fragment.platform || !fragment.url || !fragment.signature) continue;
    const filename = fragment.filename ?? decodeURIComponent(fragment.url.split("/").pop() ?? "");
    platforms[fragment.platform] = {
      signature: fragment.signature,
      url: rewrites[filename] ?? fragment.url,
    };
  }
  if (Object.keys(platforms).length === 0) {
    throw new Error(`在 ${fragmentsDir} 未找到任何有效的平台片段`);
  }

  const manifest = {
    version,
    notes: args.notes ?? "",
    pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    platforms,
  };
  const out = args.out;
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (out) {
    writeFileSync(out, text, "utf8");
    console.log(
      `[manifest] 已写入 ${out}（version=${version}，平台 ${Object.keys(platforms).join(", ")}）`,
    );
  } else {
    process.stdout.write(text);
  }
}

const mode = process.argv[2];
const args = parseArgs(process.argv.slice(2));
try {
  if (mode === "fragment") buildFragment(args);
  else if (mode === "merge") buildMerged(args);
  else {
    console.error("用法：build-updater-manifest.mjs <fragment|merge> [--选项...]");
    process.exit(2);
  }
} catch (err) {
  console.error(`[manifest] 失败：${err.message}`);
  process.exit(1);
}