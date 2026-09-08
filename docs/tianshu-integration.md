# 天枢接入教程（tianshu-integration.md）

本 MCP server（`tianshu-mcp`）是标准 **MCP stdio server**（TypeScript + 官方 `@modelcontextprotocol/sdk`）。天枢把它当作普通 MCP server 接入后，会话里会出现 8 个工具（`mcp__tianshu-mcp__*`），由天枢调度去驱动外部 AI-Agent 完成「派活 → 验收 → 返修 → 再验收」闭环。

> 天枢官方仓库：[github.com/huiliyi37/Tianshu-harness](https://github.com/huiliyi37/Tianshu-harness)（基于 harness 工程的终端编程智能体运行时，TUI × GUI）。

## 0. 前置

- Node.js ≥ 20（天枢会用自带的 node 执行，亦可）。
- 先 `npm install && npm run build` 生成 `dist/`（本地开发模式），或发布后走 npx。
- 数据目录默认 `~/.tianshu-mcp`（env `TIANSHU_MCP_HOME` 可覆盖）；首次启动自动创建。

## 1. 接入配置（界面添加 / config.json）

天枢的 MCP server 配置在数据目录 `config.json` 顶层 `mcp.servers`。

### 方式 0：天枢界面添加（最省事）

天枢「设置 → MCP 服务器 → 添加」，按下面填写（传输方式选 `stdio（本地进程）`）：

| 字段 | npm 分发（推荐） | 本地开发 |
|---|---|---|
| 服务器 ID | `tianshu-mcp` | `tianshu-mcp` |
| 传输方式 | `stdio（本地进程）` | `stdio（本地进程）` |
| 命令 | `npx` | `node` |
| 参数（空格分隔） | `-y tianshu-mcp` | `<仓库绝对路径>/dist/index.js` |

- 服务器 ID 决定工具前缀：填 `tianshu-mcp` → 工具名 `mcp__tianshu-mcp__run_task` 等 8 个。
- 参数按空格分隔，不要加引号；本地开发需把 `<仓库绝对路径>` 换成真实绝对路径。
- 界面没有环境变量输入框；需要自定义数据目录（`TIANSHU_MCP_HOME`）时用下面的 `config.json` 方式。

### 方式 1：config.json（可配环境变量）

#### 模式 A：本地开发（推荐先验证）

```jsonc
{
  "mcp": {
    "enabled": true,
    "servers": {
      "tianshu-mcp": {
        "command": "node",
        "args": ["D:/Trae项目/tianshu-mcp/dist/index.js"],
        "env": { "TIANSHU_MCP_HOME": "D:/Trae项目/tianshu-mcp/.tianshu-mcp" }
      }
    }
  }
}
```

### 模式 B：npm 分发

```jsonc
{
  "mcp": {
    "servers": {
      "tianshu-mcp": { "command": "npx", "args": ["-y", "tianshu-mcp"] }
    }
  }
}
```

> 天枢把 `npx` 改写成自带 node 执行内置 npx-cli；与内置 context7 等预设同构。

## 2. 可选 policy 覆盖

默认能力标注（server 内建）已在工具面声明；如天枢要求更细 policy，可在该 server 段追加：

```jsonc
"policy": {
  "tools": {
    "run_task":     { "capability": "write", "requireApproval": true },
    "cancel_task":  { "capability": "write", "requireApproval": true },
    "rework_task":  { "capability": "write", "requireApproval": true },
    "verify_task":  { "capability": "read" },
    "query_task":   { "capability": "read" },
    "list_tasks":   { "capability": "read" },
    "get_task_report": { "capability": "read" },
    "get_profiles": { "capability": "read" }
  }
}
```

> 若天枢实测要求"能跑构建命令"的工具必须具备 execute 能力，把 `verify_task` 上调为 `execute`（仍免审批）——配置调整即可，属联调确认项。

## 3. 工具面（8 个）

| 工具 | 能力/审批 | 作用 |
|---|---|---|
| `run_task` | write + 审批 | 派活（可带自动验收/自动返修），异步返回 taskId |
| `query_task` | read | 轮询状态 / 日志尾 |
| `list_tasks` | read | 历史任务过滤列表 |
| `get_task_report` | read | 某轮验收报告全文 |
| `cancel_task` | write + 审批 | 取消（kill 进程树） |
| `verify_task` | read | 对任务/项目路径做一次验收（不改源码） |
| `rework_task` | write + 审批 | 手动返修（失败报告喂回同一 agent） |
| `get_profiles` | read | 查看 agent 探测结果 |

返回统一：`人类可读文本 + ---tianshu-mcp-meta--- JSON 块`。

## 4. 操作步骤（天枢会话冒烟）

1. **设置/API 加 server**：用上面任一模式配置并连接；`GET /mcp/status` 应 connected。
2. **新开会话**，确认工具面出现 8 个 `mcp__tianshu-mcp__*` 工具。
3. **stub 预演**（不碰真实登录态）：`test/stub-agent/stub-agent.mjs` 配成 profile，跑一次 `run_task(autoVerify:true)` → query_task → succeeded。
4. **真实 agent**：切 codex profile，跑 `run_task`（见 skills/tianshu-mcp/SKILL.md 用法）。
5. **热路径验证**：热重启/热注入一次；删除 server 一次（任务应标 interrupted 且可查历史）。

## 5. 长任务与超时注意

- 天枢按次同步调用 `tools/call`；本 server **全异步**：`run_task` 秒回 taskId，长任务经 `query_task` 轮询（建议 5–10s）。
- 任务级默认超时 30 分钟（run_task 可传 `taskTimeoutMs`）；验收单条命令默认 5 分钟。
- 若联调发现 tools/call 有更短上层超时，天枢侧需接受先拿 taskId 的模式。

## 6. 常见问题

| 症状 | 处理 |
|---|---|
| 工具没出现 / server 连不上 | 看 server 日志 `<home>/logs/server.log`；确认 node 版本与 dist 构建；确认 config 字段（command 或 url 至少其一） |
| `run_task` 报 agent 不可用 | `get_profiles` 看探测结果；装 CLI 或修 profile（docs/agent-profiles.md） |
| 验收误判（找不到命令） | 验收子进程显式继承 PATH；确认项目在 git 仓库内（基线分析需要） |
| 任务卡 running | `query_task` 看日志尾；`cancel_task`；重启 server 会归档为 interrupted |
| 技能未命中 | 技能装到 `~/.rivet/skills/tianshu-mcp`（server 自检安装）；改动需新会话；见 §17 验证流程 |
