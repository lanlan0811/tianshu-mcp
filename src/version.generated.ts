/**
 * 版本单一来源（S4）：由 build 前的脚本从 package.json 注入。
 * 若直接源码运行（未注入），回退读 package.json；再失败给占位。
 * 本文件由 scripts/sync-version.mjs 在每次 build 前重新生成。
 */
// generated: 勿手改 —— 运行 `npm run build` 自动同步
export const MCP_SERVER_VERSION = "0.3.1";
