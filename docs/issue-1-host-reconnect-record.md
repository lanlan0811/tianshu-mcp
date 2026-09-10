# issue #1 桌面宿主重连验收记录（v0.1.10）

- 日期：2026-09-10
- 关联：[GitHub issue #1](https://github.com/lanlan0811/tianshu-mcp/issues/1)（报告者 `liuchsong`）
- 目标版本：`tianshu-mcp@0.1.10`（npm 已发布，`latest=0.1.10`）

## 0. 报告者环境与本机复现环境对照

| 项 | 报告者 | 本次验收本机 |
|---|---|---|
| tianshu-mcp | v0.1.9（npm 全局 / `npx -y tianshu-mcp`） | **v0.1.10**（registry 发布版） |
| Node | v24.18.0（Windows） | v24.18.0 |
| 桌面宿主 | 天枢桌面端 v3.16.1（WebView2 152.0.4191.66） | **天枢桌面端 v3.16.1**（本次会话中由 v3.15.0 自动升级） |
| 宿主数据目录 | `~/.tianshu-mcp` | `C:\Users\Lenovo\.tianshu-mcp` |

> 本机天枢在验收过程中自动升级到与报告者相同的 3.16.1，因此宿主侧行为与报告者一致。

## 1. 报告者原始复现命令（stdout 契约）

报告者的复现命令（`2>/dev/null` 隐藏 stderr），v0.1.10 下：

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  | npx -y tianshu-mcp 2>/dev/null
```

实际输出（stdout，逐字节只有一行 JSON-RPC）：

```json
{"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"tianshu-mcp","version":"0.1.10"},"instructions":"…"},"jsonrpc":"2.0","id":1}
```

- 不再出现任何 `[INFO]` 行（v0.1.9 报告中此处混入 4 条日志）。
- 退出码 0。

## 2. 桌面宿主真实重连

宿主 `mcp.servers` 条目指向本次发布的 0.1.10 入口后重启桌面端，宿主编排（rivet sidecar）日志：

```text
Rivet Runtime API listening on http://localhost:12137
[server:WARN] MCP: 2 servers connected, 10 tools
```

- `2 servers connected, 10 tools` = context7（2）+ **tianshu-mcp（8）**，与报告者 §临时绕过 中
  「1/1 已连接 · 8 个工具可用」一致，且**未使用任何过滤包装器**。
- 本 server 侧 `server.log`：

```text
[INFO] 技能已安装且内容一致，跳过（C:\Users\Lenovo\.rivet\skills\tianshu-mcp）。
[INFO] tianshu-mcp 已连接（stdio）。数据目录: C:\Users\Lenovo\.tianshu-mcp，工具数: 8
```

## 3. 桌面会话内真实工具调用

在宿主新建会话（临时项目目录）里让模型调用只读工具 `get_profiles`，宿主运行时事件流原文：

```text
event: tool_use
data: {"id":"call_00_fsJDwDwDfOncOjMsY6KK9553","name":"mcp__test__get_profiles","input":{}}

event: tool_result
data: {"id":"call_00_fsJDwDwDfOncOjMsY6KK9553","name":"mcp__test__get_profiles","isError":false,
"result":"Agent 适配与可执行探测结果（列: 可用 / agentId / 名称 / 说明）\n
[PASS] 可用\tcodex\tCodex (OpenAI 桌面端 CLI)\t探测到可执行: C:\\Users\\Lenovo\\AppData\\Local\\OpenAI\\Codex\\bin\\…\\codex.exe [探测来源: discovery]\n
[FAIL] 不可用\tzcode\tZcode (ZCode 桌面)\t… unsupported …\n
[PASS] 可用\ttraework\tTraeWork (TRAE SOLO CN)\t探测到可执行: D:\\TRAE Work CN\\TRAE SOLO CN.exe [探测来源: discovery]\n
[FAIL] 不可用\tstub\tstub\t未配置 agent 'stub'，请在 agent-profiles.json 中添加 profile\n
---tianshu-mcp-meta---\n{ \"ok\": true, \"message\": \"共 4 个 agent\", \"checks\": [] }\n---tianshu-mcp-meta---\n
[MCP: test · unknown · approval-required]"}
```

- `isError:false`，返回体为「人类可读文本 + `---tianshu-mcp-meta---` JSON 块」，协议兼容。
- 说明：宿主把该 server 条目显示为 `test`，故工具名为 `mcp__test__get_profiles`；工具名前缀由宿主按条目 ID 生成，与本 server 无关。

## 4. 过程中的重要发现（宿主侧回归，非本 server 缺陷）

本次验收还观察到：天枢 3.16.1 自带的 `node-runtime` 内嵌 npx 已损坏，**任何** `npx -y <server>` 形式的
条目都会失败，包括与本 server 无关的 context7：

```text
npm error Class extends value undefined is not a constructor or null
[server:ERROR] MCP: 0 connected, 0 tools, 2 failed: {"failedServers":[
  "context7 — MCP error -32000: Connection closed …",
  "Tianshu-mcp — MCP error -32000: Connection closed …"]}
```

- 该 `-32000 Connection closed` 与报告者现象文字相同，但**根因不同**：报告者是 v0.1.9 的 stdout 日志污染；
  这里是宿主 3.16.1 内嵌 npm 本身启动失败，连无关服务器也一起失败。
- 判定依据：用宿主自带 node（v24.18.0）直接运行本 server 入口正常；用宿主内嵌 npx 运行 context7 同样报错。

### 4.1 根因定位（2026-09-10 追加，天枢 3.17.0）

用户升级到天枢 **3.17.0** 后，UI 仍是 `0/2 已连接 · 0 个工具可用`，context7 与 tianshu-mcp 双双 `-32000`。
用宿主自带 node 复现内嵌 npx 失败，npm 调试日志给出精确位置：

```text
verbose stack TypeError: Class extends value undefined is not a constructor or null
    at Object.<anonymous> (...\npm\node_modules\minipass-flush\index.js:5:21)
```

逐层剖析：

- `minipass-flush@1.0.6` 声明 `dependencies.minipass = ^7.1.3`，源码 `const { Minipass } = require('minipass')` 后
  `class Flush extends Minipass`。
- 但 `minipass-flush/node_modules/minipass` 里残留着一份 **3.3.6**（v3 的导出形态是 `module.exports = Minipass`，
  没有 `Minipass` 具名导出）。Node 就近解析优先命中这份陈旧副本 → `Minipass === undefined` → `class extends undefined`。
- 顶层 `npm/node_modules/minipass` 实际是 **7.1.3**（正确），但被最近的嵌套副本遮蔽。
- 同类污染不止一处，均「声明 ^7.x、嵌套却是 3.3.6/5.0.0」：

  | 包 | 声明 minipass | 嵌套实际 |
  |---|---|---|
  | `minipass-sized` | `^7.1.2` | `3.3.6` ❌ |
  | `minizlib` | `^7.1.2` | `3.3.6` ❌ |
  | `minipass-flush` | `^7.1.3` | `3.3.6` ❌ |
  | `tar` | `^7.1.2` | `5.0.0` ❌ |
  | `tar/node_modules/fs-minipass` | `^7.0.3` | `3.3.6` ❌ |
  | `minipass-pipeline` | `^3.0.0` | `3.3.6` ✅（合法） |

结论：这是**天枢 3.16/3.17 内嵌 node-runtime 的 npm 依赖树被旧副本污染**，与 tianshu-mcp 无关；
所以升级 3.17 不会自动修好，`重试` 也无效。

### 4.2 修复方法（本机已执行并验证）

把「声明 ^7.x 却嵌套旧版」的副本移开，让 Node 回落到顶层的正确 7.1.3：
（`<TS>` = 天枢安装目录，默认 `D:\Tianshu`；操作前建议关闭天枢）

```powershell
$M = "<TS>\node-runtime\win-x64\node_modules\npm\node_modules"
foreach ($p in "minipass-sized","minizlib","minipass-flush","tar","tar\node_modules\fs-minipass") {
  $d = Join-Path $M "$p\node_modules\minipass"
  if (Test-Path $d) { Rename-Item $d "$d.broken-bak" }
}
```

> 保留 `minipass-pipeline/node_modules/minipass`（它确实要求 `^3.0.0`，不可动）。

修复后（同一台机器、同一个天枢安装）：

```text
Rivet Runtime API listening on http://localhost:7418
[server:WARN] MCP: 2 servers connected, 10 tools
```

宿主自身 MCP 状态接口（`GET /mcp/status`，需 sidecar token）原文：

```json
{"servers":[
  {"serverId":"context7","transport":"stdio","status":"connected","toolCount":2},
  {"serverId":"tianshu-mcp","transport":"stdio","status":"connected","toolCount":8}
],"totalTools":10,"enabled":true,"managerReady":true}
```

即 UI 的 `0/2 已连接 · 0 个工具可用` 变为 `2/2 已连接 · 10 个工具可用`。

### 4.3 备选方案（不改宿主）

若不便改天枢安装目录，可绕开坏掉的 npx，把条目改为直接命令：

```jsonc
"tianshu-mcp": {
  "command": "node",
  "args": ["<全局或 npx 缓存中的>/tianshu-mcp/dist/index.js"]
}
```

例如全局安装后：`npm i -g tianshu-mcp@0.1.10`，条目写 `{"command":"tianshu-mcp"}`（全局 bin）或
`{"command":"node","args":["<npm 全局根>/node_modules/tianshu-mcp/dist/index.js"]}`。
宿主在任何一种入口下本 server 都能正常握手（见 §2、§3）。

> 注意：`4.2` 的改动位于天枢安装目录内，**天枢下次升级可能覆盖/复原**；升级后若复发，按 §4.1 重新定位或改用 §4.3。

## 5. 结论

- **stdout/stderr 契约**：报告者原始复现命令在 v0.1.10 下 stdout 只有合法 JSON-RPC 行，stderr 承载日志，退出码 0。
- **桌面宿主重连**：天枢桌面端 v3.16.1 下 `2 servers connected, 10 tools`，**无需过滤包装器**即完成握手并注册 8 个工具。
- **工具调用**：桌面会话内真实调用 `mcp__test__get_profiles` 成功（`isError:false`，返回文本 + meta 块）。
- **3.17.0 复验**：修复宿主内嵌 npm 污染后，`GET /mcp/status` 显示 tianshu-mcp `connected`、`toolCount: 8`；
  会话内以标准名 `mcp__tianshu-mcp__get_profiles` 真实调用成功（`isError:false`）。
- 报告者提出的两条建议中，本版本采用「所有日志改走 stderr」；未引入 `TIANSHU_MCP_LOG` 开关（按计划不作为修复前提）。

> 复现/验收用的临时项目、会话与宿主配置改动均为本机一次性操作，不进入仓库；生产代码与测试以本仓库提交为准。
