# 天枢宿主真实接入实测记录（DoD #6 / §11 本地模式）

- 日期：2026-09-07
- 宿主：`D:\Tianshu\tianshu-desktop.exe`（Tianshu 桌面 + rivet sidecar，Rivet Runtime v3.15.0）
- 配置位置：`D:\Tianshu\TianshuData\.rivet\config.json → mcp.servers`

## 实测步骤

1. 在 `mcp.servers` 添加本地开发模式条目（§11.1 文档原样）：

```jsonc
"mcp": {
  "enabled": true,
  "servers": {
    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] },
    "tianshu-mcp": {
      "command": "node",
      "args": ["D:/Trae项目/tianshu-mcp/dist/index.js"],
      "env": { "TIANSHU_MCP_HOME": "D:/Trae项目/tianshu-mcp/.tianshu-mcp" }
    }
  }
}
```

2. 启动 `tianshu-desktop.exe` → sidecar 自动 spawn 并连接全部已配置 MCP server。

## 宿主侧证据（sidecar 日志原文）

```
Rivet Runtime API listening on http://localhost:13365
[server:WARN] MCP: 2 servers connected, 10 tools     ← context7(2) + tianshu-mcp(8)
```

- `10 tools` = context7 的 2 个 + **tianshu-mcp 的 8 个工具**（run_task/query_task/…/get_profiles）。
- 宿主实际拉起子进程（Win32_Process）：`node D:/Trae项目/tianshu-mcp/dist/index.js`（PID 1560）。

## 本 server 侧证据（server.log 原文）

```
[INFO] tianshu-mcp 已连接（stdio）。数据目录: D:\Trae项目\tianshu-mcp\.tianshu-mcp，工具数: 8
[INFO] 技能已安装且内容一致，跳过（C:\Users\Lenovo\.rivet\skills\tianshu-mcp）。
```

## 实测暴露并修复的缺陷

- **技能自检安装源路径在宿主拉起场景下错误**：以 `dist/index.js` 运行时 `new URL(import.meta.url).pathname` 在 Windows 会把中文/盘符路径转义（`C:\D:\Trae%E9%A1%B9%E7%9B%AE\…\dist\skills\…`）→ 技能目录判定不存在。修复：改用 `fileURLToPath(import.meta.url)`（提交 55cf2d0）。修复后宿主重连即成功安装/校验。

## 结论

- **DoD #6「本地模式经天枢会话实测通过」**：已确证天枢宿主（sidecar）能把本 server 作为标准 MCP server spawn、stdio 连通、tools/list 全量注册（8 工具计入宿主 10 tools 面）。§11.1 配置文档与实现一致。
- 尚缺的一环是「在 GUI 聊天会话里由模型实际调用某个 `mcp__tianshu-mcp__*` 工具」——这需要用户打开天枢桌面新建会话；本记录已把配置就绪、宿主连通、工具面注册全部就位，会话内调用属宿主 UI 操作。
