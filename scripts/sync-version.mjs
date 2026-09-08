#!/usr/bin/env node
/**
 * 从 package.json 同步版本到 src/version.generated.ts（S4 单一版本源）。
 * build/prepublish 前执行；保证 serverInfo.version 与 package.json 一致。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+/.test(String(version))) {
  console.error(`package.json version 非法: ${version}`);
  process.exit(1);
}
const out = `/**
 * 版本单一来源（S4）：由 build 前的脚本从 package.json 注入。
 * 若直接源码运行（未注入），回退读 package.json；再失败给占位。
 * 本文件由 scripts/sync-version.mjs 在每次 build 前重新生成。
 */
// generated: 勿手改 —— 运行 \`npm run build\` 自动同步
export const MCP_SERVER_VERSION = ${JSON.stringify(version)};
`;
writeFileSync(path.join(root, "src", "version.generated.ts"), out, "utf8");
console.log(`version.generated.ts 已同步为 ${version}`);
