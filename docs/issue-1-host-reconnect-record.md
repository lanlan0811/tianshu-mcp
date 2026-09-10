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
- 影响与建议：若用户升级到 3.16.1 后 `npx` 形式条目全部失效，可将条目改为直接命令（`node <path>/dist/index.js`
  或全局安装后的可执行文件），必要时向天枢反馈其内嵌 npm 问题。

## 5. 结论

- **stdout/stderr 契约**：报告者原始复现命令在 v0.1.10 下 stdout 只有合法 JSON-RPC 行，stderr 承载日志，退出码 0。
- **桌面宿主重连**：天枢桌面端 v3.16.1 下 `2 servers connected, 10 tools`，**无需过滤包装器**即完成握手并注册 8 个工具。
- **工具调用**：桌面会话内真实调用 `mcp__test__get_profiles` 成功（`isError:false`，返回文本 + meta 块）。
- 报告者提出的两条建议中，本版本采用「所有日志改走 stderr」；未引入 `TIANSHU_MCP_LOG` 开关（按计划不作为修复前提）。

> 复现/验收用的临时项目、会话与宿主配置改动均为本机一次性操作，不进入仓库；生产代码与测试以本仓库提交为准。
