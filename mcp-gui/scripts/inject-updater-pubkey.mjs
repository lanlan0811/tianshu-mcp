#!/usr/bin/env node
/**
 * 把 CI 提供的 minisign 公钥注入 `src-tauri/tauri.conf.json`。
 *
 * 为什么需要注入：公钥与私钥都由维护者在 CI Secret 中配置，
 * 仓库里只保留占位符 `__UPDATER_PUBKEY__`；构建前替换，运行时由
 * `tauri-plugin-updater` 用它校验更新包签名（**验签不通过一律拒绝安装**）。
 *
 * 未提供公钥时**不失败**（只提示）：构建照常产出安装包，但自动更新不可用。
 *
 * 用法：node mcp-gui/scripts/inject-updater-pubkey.mjs "<pubkey>" [--conf <path>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PLACEHOLDER = "__UPDATER_PUBKEY__";

const here = path.dirname(fileURLToPath(import.meta.url));
const guiRoot = path.resolve(here, "..");

const argv = process.argv.slice(2);
const pubkey = (argv[0] ?? "").trim();
const confIndex = argv.indexOf("--conf");
const confPath =
  confIndex >= 0 && argv[confIndex + 1]
    ? path.resolve(process.cwd(), argv[confIndex + 1])
    : path.join(guiRoot, "src-tauri", "tauri.conf.json");

if (!pubkey) {
  console.log(
    "[inject-updater-pubkey] 未提供公钥（UPDATER_PUBKEY 为空），保留占位符；本次构建的自动更新不可用。",
  );
  process.exit(0);
}

const conf = JSON.parse(readFileSync(confPath, "utf8"));
const updater = conf.plugins?.updater;
if (!updater) {
  console.error("[inject-updater-pubkey] tauri.conf.json 缺少 plugins.updater 配置");
  process.exit(1);
}
if (updater.pubkey !== PLACEHOLDER && updater.pubkey !== pubkey) {
  console.log("[inject-updater-pubkey] 公钥已是自定义值，保持原样（不覆盖）。");
  process.exit(0);
}
updater.pubkey = pubkey;
writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`, "utf8");
console.log(`[inject-updater-pubkey] 已注入公钥到 ${confPath}`);