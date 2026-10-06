<p align="center">
  <img src="./assets/tianshu-mcp-banner.svg" alt="天枢编排 MCP tianshu-mcp" width="100%">
</p>

<h1 align="center">天枢编排 MCP tianshu-mcp</h1>

<p align="center">
  <b>把开发交给 AI-Agent，把验收交给运行时 · Dispatch with agents, verify with evidence.</b>
</p>

<p align="center">
  <a href="https://lanaiw.top"><b>官网</b></a> ·
  <a href="https://github.com/lanlan0811/tianshu-mcp"><b>GitHub 主仓</b></a> ·
  <a href="https://gitee.com/lan0811/tianshu-mcp"><b>Gitee 镜像</b></a> ·
  <a href="https://github.com/huiliyi37/Tianshu-harness"><b>天枢 Tianshu</b></a> ·
  简体中文 ·
  <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="ARCHITECTURE.md"><b>架构说明</b></a> ·
  <a href="docs/agent-profiles.md"><b>Agent 配置</b></a> ·
  <a href="docs/acceptance-config.md"><b>验收配置</b></a> ·
  <a href="docs/visual-acceptance.md"><b>视觉验收</b></a> ·
  <a href="docs/event-stream.md"><b>事件流</b></a> ·
  <a href="docs/gui-log-viewer.md"><b>日志台 GUI</b></a> ·
  <a href="HANDOFF.md"><b>交接文档</b></a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/actions/workflow/status/lanlan0811/tianshu-mcp/ci.yml?branch=master&style=for-the-badge&logo=github&label=CI" alt="CI">
  <img src="https://img.shields.io/npm/v/tianshu-mcp?style=for-the-badge&logo=npm&logoColor=white&label=npm&color=cb3837" alt="npm version">
  <img src="https://img.shields.io/github/stars/lanlan0811/tianshu-mcp?style=for-the-badge&logo=github&label=stars&color=24292e" alt="GitHub stars">
  <img src="https://img.shields.io/badge/License-Apache%202.0-3B5BDB?style=for-the-badge&logo=apache" alt="License">
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178c6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/node-%E2%89%A520-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node">
  <img src="https://img.shields.io/badge/MCP%20SDK-1.x-6f42c1?style=for-the-badge" alt="MCP SDK">
  <img src="https://img.shields.io/badge/Tests-1383%20Passed-green?style=for-the-badge" alt="Tests">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tianshu-mcp"><img src="https://img.shields.io/npm/d18m/tianshu-mcp?style=for-the-badge&logo=npm&logoColor=white&label=MCP%20%E4%B8%8B%E8%BD%BD%E6%AC%A1%E6%95%B0&color=cb3837" alt="MCP 下载次数（npm）"></a>
  <a href="https://github.com/lanlan0811/tianshu-mcp/releases?q=v&expanded=true"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Flanlan0811%2Ftianshu-mcp%2Fmaster%2Fupdate%2Fstats.json&query=%24.mcpDownloads&style=for-the-badge&logo=github&logoColor=white&label=MCP%20%E5%8E%8B%E7%BC%A9%E5%8C%85%E4%B8%8B%E8%BD%BD%E6%AC%A1%E6%95%B0&color=2ea44f" alt="MCP 压缩包下载次数（GitHub 发行）"></a>
  <a href="https://github.com/lanlan0811/tianshu-mcp/releases?q=gui-v&expanded=true"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Flanlan0811%2Ftianshu-mcp%2Fmaster%2Fupdate%2Fstats.json&query=%24.guiDownloads&style=for-the-badge&logo=github&logoColor=white&label=GUI%20%E4%B8%8B%E8%BD%BD%E6%AC%A1%E6%95%B0&color=1f6feb" alt="日志台 GUI 下载次数（GitHub 发行）"></a>
</p>

---

<p align="center">
  <img src="./assets/mcp-running.png" alt="天枢 harness 桌面端通过 tianshu-mcp 调用 ZCode 完成开发" width="100%">
  <br>
  天枢 harness 桌面端实况 —— <b>天枢</b>经 MCP 调用 <b>tianshu-mcp</b> 编排 <b>ZCode</b> 完成一次开发任务：左侧派发与跟踪任务，中间是 tianshu-mcp 的工具调用与事件流（<code>mcp__tianshu-mcp__query_task</code> 轮询运行中的任务），右侧 ZCode 正在执行实际开发
</p>

### 面向 AI-Agent 的编排层与客观验收仪

> **tianshu-mcp** 是被 **天枢（Tianshu）** 当作标准 MCP server 接入的编排层。天枢是总指挥与用户交互面，本 server 承担三件事：**调度**（队列 / 并发闸 / 状态机 / 取消）、**执行面**（把任务书送达外部 AI-Agent）、**客观验收仪**（相对 git 基线做命令检查、代码分析与可选视觉比对）。
>
> 它要回答的核心问题是：**Agent 说「做完了」，谁来证明真的做完了。** 为此「完成」必须有运行时证据，验收不合格自动生成修复计划并返修，轮次耗尽则交由天枢裁决。

```
天枢 Tianshu（TUI × GUI）        ← 总指挥 / 交互面 / 裁决
              ↓  MCP over stdio（stdout 仅承载 JSON-RPC）
        tianshu-mcp              ← 调度 · 执行面 · 验收仪
              ↓
Codex · TraeWork · ZCode · Kimi Code · Qoder CN · Open Design · MiniMax Code
              ↓（GUI 经 CDP 驱动桌面 UI；CLI 走子进程）
        目标项目工作区            ← git 仓库 + 测试 + .tianshu-mcp/
```

- **13 个 MCP 工具** —— `run_task / continue_task / query_task / list_tasks / get_task_report / cancel_task / verify_task / rework_task / get_profiles / wait_task / wait_any`，外加视觉验收的 `prepare_visual_baseline / approve_visual_baseline`。
- **异步契约，长任务不卡 `tools/call`** —— `run_task` 秒回 `taskId`，用 `wait_task` 阻塞等到停点（终态或 `needs_user`）、或用 `query_task` 轮询；进度只落盘、不推送，调用方看到的始终是「最后一次落盘的事实」。
- **等待原语（issue #28）** —— `wait_task(taskId)` / `wait_any(taskIds)` 一次调用即等到任务到达**停点**（终态或 `needs_user`），专为回合驱动调用方设计：`run_task` 后在本回合内直接等结果，无需自行轮询；纯只读、超时/中断对任务本体零影响。
- **客观验收，fail-closed** —— 自动命令检查 + 程序化代码分析，全部相对动工前的 **git 基线**，**绝不自动 commit / stash / 回滚**；「测试退出码 0 但零用例」「git 项目零净变更」都判失败，杜绝假绿。
- **失败返修闭环** —— 自动返修（`autoFixRounds`）+ 手动 `rework_task`；失败原因被解析为**可直接执行的动作**随计划喂回 agent，轮次耗尽转 `needs_attention` 等天枢裁决。
- **六个 GUI 执行面（CDP）** —— 各 agent 使用隔离的 CDP 流程驱动桌面 UI，并在关键节点上报细粒度事件，`query_task` 因此能区分「agent 正在干活」与「卡在弹窗等人工介入」。
- **可扩展** —— 新 agent = 一个 profile（数据）+（如需）一个 adapter 文件，零改编排核心。

> [!NOTE]
> 本 server 是标准 MCP **stdio server**：**stdout 只承载 MCP JSON-RPC 消息**，所有级别诊断日志（DEBUG/INFO/WARN/ERROR）写入 **stderr** 并同源追加到 `<数据目录>/logs/server.log`。因此 stderr 里出现 `INFO` / `WARN` **不代表服务器出错**。数据目录默认 `~/.tianshu-mcp`，可用环境变量 `TIANSHU_MCP_HOME` 覆盖。

## 目录

- [为什么需要编排层与验收仪](#为什么需要编排层与验收仪)
- [核心特性](#核心特性)
- [快速开始](#快速开始)
- [工具面](#工具面)
- [支持的 Agent](#支持的-agent)
- [权限与安全边界](#权限与安全边界)
- [运行时契约](#运行时契约)
- [里程碑](#里程碑)
- [日志台 GUI](#日志台-gui)
- [文档导航](#文档导航)
- [面向开发者](#面向开发者)
- [安全](#安全)
- [社区与支持](#社区与支持)

## 为什么需要编排层与验收仪

### 问题：Agent 说「做完了」，谁来证明

把开发任务交给 AI-Agent 之后，真正的困难不在「它能不能干活」，而在**怎么确认它真的干完了、干对了**：

- **自述不可信** —— agent 的「已完成」是自然语言结论，不是证据。没有独立验收时，半成品与真交付长得一模一样。
- **环境是黑盒** —— 桌面 agent 的请求在传输层加密（如 TraeWork 的 TTNet 层 TDE），无法在客户端外构造，唯一可行路径是驱动 UI 取结果。
- **宿主工具面很窄** —— 天枢的 MCP 工具**只回文本**（`content[].text` 被拼成字符串、`isError` 透传），且**按次同步**调用，长任务必须自己异步化，也不能依赖服务端推送。
- **失败后没人接手** —— 验收不通过时，如果没有人把「哪一行错了、该改什么」喂回去，agent 只会重复同一次错误。

本项目的形态不是自由设计的结果，而是这几条**实测硬约束**逼出来的：

| # | 实测约束 | 架构后果 |
|---|---|---|
| C1 | 天枢的 MCP 工具**只回文本** | 所有结果统一为「人类可读文本 + `---tianshu-mcp-meta---` JSON 块」，便于宿主正则抽取 |
| C2 | 天枢**按次同步**调用 `tools/call` | 长任务异步化：`run_task` 秒回 `taskId`，用 `query_task` 轮询 |
| C3 | 桌面 agent 请求在传输层加密，无法在客户端外构造 | 只能 **CDP 驱动桌面 UI**，从 DOM 提取结果 |
| C4 | Codex 桌面端是 **MSIX 商店包**，无法直接 `CreateProcess` | 必须经 COM 激活并注入专属 `--user-data-dir` 才能开 CDP 端口 |

### 解法：把「谁来干活」与「怎么算干得好」拆开

- **调度层**负责纪律 —— 每项目串行队列 + 全局并发闸（默认 2）、显式状态机、超时与取消语义。
- **执行面**负责投递 —— 一份 `AgentAdapter` 契约：GUI agent 走 CDP 驱动，CLI agent 走子进程；新增 agent 通常只是一个 profile。
- **验收仪**负责证据 —— 相对动工前 git 基线做命令检查、代码分析、可选视觉比对，并以 fail-closed 拦住「假绿」；报告分人读 `.md` 与机读 `.json`。
- **返修闭环**负责收敛 —— 失败轮次把原因解析成可执行动作喂回同一 agent，轮次耗尽转人工裁决。

> 两条边界是硬性的：**agent 的「完成」不是验收结论**（只有 `verdict.passed` 才算）；**环境 / 认证类错误不进验收与返修**（`hardFailure` 直接终态失败，避免把基础设施问题当成代码问题烧掉返修轮次）。

## 核心特性

- **异步派单与等待** —— `run_task` 秒回 `taskId`；`wait_task` 阻塞等到任务到达停点（终态或 `needs_user`），`wait_any` 等一组任务的先到者；需要进度细节时用 `query_task` 看状态 / 进度 / 日志尾 / 最近细粒度事件（`eventLimit`，1..50，默认 10）。详见 [等待原语](docs/wait-task.md)。
- **客观验收引擎** —— 自动命令检查（typecheck/lint/test/build，缺则跳过 + 技术栈推导）+ 程序化代码分析（变更清单 / diffstat / TODO·debugger·密钥形态等可疑标记），全部相对 **git 基线**；命令默认**有界并行**（`verifyConcurrency`，默认 2，范围 1–4，`1` 即完全串行）。
- **三项 fail-closed 保护** —— 测试退出码为 0 但零用例判失败；git 项目默认要求相对基线产生变更（纯分析任务可在 `.tianshu-mcp/acceptance.json` 设 `"requireChanges": false` 显式关闭）；本轮被取消即 `passed=false`。
- **验收配置三级继承**（issue #20）—— `<数据目录>/acceptance.default.json`（全局兜底）→ `<项目>/.tianshu-mcp/acceptance.json`（项目覆盖）→ `acceptanceOverride` 参数（任务级临时覆盖，不落盘）。用 `tianshu-mcp config acceptance <projectPath> [--task <id>]` 查看最终生效配置。详见 [验收配置规范](docs/acceptance-config.md)。
- **结构化修复指令**（issue #19）—— 失败轮次把原因解析为**可直接执行的动作**（`文件:行 / 问题 / 做什么`），随返修计划与返修消息一起喂给 agent；提取不到时**显式回退**到完整报告（不静默留空）。`rework_task` 另可选 `repairHint`。详见 [结构化修复指令](docs/repair-directives.md)。
- **dryRun 干跑模式**（issue #21）—— `run_task(dryRun=true)` 让 agent **只分析规划、输出将要修改的文件清单与方案、不动源码**；验收只做静态分析（引用文件是否存在、拟改位置是否存在、明显逻辑冲突），跳过 typecheck/test/build；方案有问题 → `needs_attention`（人工裁决），不进入自动返修、**不消耗验收轮次**。详见 [dryRun 干跑模式](docs/dry-run.md)。
- **幂等重试**（issue #15）—— `run_task` / `verify_task` 接受可选 `idempotencyKey`：同一 key 在 TTL（默认 24h）内重试**不重复派单**（恒返回原 `taskId`）或**不重跑验收**；同键异参 fail-closed 报错。映射落盘于 `<数据目录>/idempotency.json`，跨 server 重启仍生效。详见 [v0.5.10 发布说明](<docs/release-v0.5.10.md>)。
- **无项目派发**（ZCode 专用，issue #12）—— `run_task` 的 `projectPath` 可省略，任务在 ZCode 的 `default` 工作区运行，不登记 / 导入项目、不采集 Git 基线、不执行项目验收（结果以 `verificationNotApplicable: "no_project"` 结构化标注）。配套 `allowCreateProject: false` 可在目标目录未登记时于任何导入副作用之前停止派发。详见 [ZCode CDP 适配器](docs/zcode-cdp.md)。
- **细粒度事件流**（issue #18）—— 适配器在关键节点上报语义事件（`task_dispatched` / `confirmation_dialog_detected` / `awaiting_user_authorization` / `file_modification_started` / `rework_triggered`），`query_task` 经 `eventLimit` 回传最近 N 条。事件上报是**可选能力**：未实现的适配器行为不变。详见 [事件流](docs/event-stream.md)。
- **终态通知 webhook**（issue #22）—— 可选 `notifications.webhook`（全局 `config.json`）：任务完成 / 失败 / 进入 `needs_attention` 时向指定 URL **异步 POST** 一条 JSON（含 `taskId` / `event` / `status` / 时间戳 / 报告路径），可选 HMAC-SHA256 签名。**默认关闭**，发送失败只记日志、**绝不影响状态机**。详见 [任务终态通知](docs/notifications.md)。
- **视觉验收（可选模块，v0.5.0 起）** —— 页面截图对比、静态图片规格校验、基准两阶段批准与规则冻结；缺基准不得判通过，自动返修禁止调用批准入口。另有**可选 AI 内容校验**（v0.5.4，默认关闭）：判定完全**委托给你自备的本地命令**，MCP 不读取 / 不存储 / 不转发任何密钥、不内置模型客户端，默认**仅告警**。详见 [视觉验收](docs/visual-acceptance.md)。
- **技能自检安装**（issue #16）—— 启动时把**包内** `skills/tianshu-mcp/` 幂等同步到 `~/.rivet/skills/tianshu-mcp/`；仅在**可证未被改动**时自动升级，**检出本地修改或来源不明一律保留 + 告警**。详见 [运行时契约](#运行时契约)。
- **独立交付面：日志台 GUI** —— `mcp-gui/` 提供**本地只读**的桌面应用，把四类日志与任务产物统一到一个界面（Tauri 2.x + Vue 3，独立版本与 tag，不随 MCP 主包发布）；详见 [日志台 GUI](#日志台-gui)。
- **不碰密钥** —— 各 agent 使用自己的登录态，本 server 不保存 / 转发任何 API key（详见 [SECURITY.md](SECURITY.md)）。
- **想理解内部结构** —— 见 [ARCHITECTURE.md](ARCHITECTURE.md)（分层模型、模块边界、状态机、验收流水线、扩展点与已知缺口）。

## 快速开始

### 前置条件

| 项 | 要求 |
|---|---|
| Node.js | ≥ 20（CI 覆盖 20 / 22 / 24） |
| 包管理器 | npm（仓库含 `package-lock.json`） |
| 操作系统 | Windows / macOS / Linux（CI 三平台矩阵验证） |
| Git | 可选；验收的基线分析在 git 仓库内更完整 |

数据目录默认 `~/.tianshu-mcp`，可用环境变量 `TIANSHU_MCP_HOME` 覆盖；首次启动自动创建。

### 从源码构建

```bash
git clone https://github.com/lanlan0811/tianshu-mcp.git
cd tianshu-mcp
npm ci
npm run build        # sync-version + tsc → dist/
npm test             # 1383 passed / 12 skipped（1395 项，115 个测试文件）
```

### 安装 npm 包

```bash
npx -y tianshu-mcp            # 免安装直接拉起
# 或
npm install -g tianshu-mcp
```

### 在天枢里添加（推荐）

天枢「设置 → MCP 服务器 → 添加」，按下面填写即可（传输方式选 `stdio（本地进程）`）：

| 字段 | npm 分发（推荐） | 本地开发 |
|---|---|---|
| 服务器 ID | `tianshu-mcp` | `tianshu-mcp` |
| 传输方式 | `stdio（本地进程）` | `stdio（本地进程）` |
| 命令 | `npx` | `node` |
| 参数（空格分隔） | `-y tianshu-mcp` | `<仓库绝对路径>/dist/index.js` |

> - 服务器 ID 即工具前缀：填 `tianshu-mcp` 后工具名为 `mcp__tianshu-mcp__run_task` 等 13 个。
> - 参数按空格分隔填写，**不要加引号**；本地开发模式请把 `<仓库绝对路径>` 换成真实绝对路径。
> - 界面未提供环境变量输入框；如需自定义数据目录，改用下面的 `config.json` 方式设置 `TIANSHU_MCP_HOME`。
> - 添加后连接成功即完成；新开会话即可看到 13 个工具。

### 或改 config.json（可配环境变量）

```jsonc
{
  "mcp": {
    "servers": {
      "tianshu-mcp": {
        "command": "node",
        "args": ["<仓库绝对路径>/dist/index.js"],
        "env": { "TIANSHU_MCP_HOME": "<仓库绝对路径>/.tianshu-mcp" }
      }
    }
  }
}
```

新开会话后，工具面出现 `mcp__tianshu-mcp__run_task` 等 13 个工具。一次典型闭环：

```text
run_task(projectPath=D:/xxx/my-app, task="…任务书…", agentId=codex,
         model="GPT-5.6 Sol", reasoningLevel="高", autoVerify=true, autoFixRounds=5)
  → taskId → wait_task(taskId) 阻塞等到停点 → succeeded / failed / needs_attention → get_task_report 读报告
  （回合驱动调用方：wait_task 一次调用即等到停点；超时返回后再次调用本工具继续等待，或用 query_task 看进度细节）
```

### 给天枢的提示语（推荐用法）

> 「在项目 `D:\xxx` 用 codex 实现『任务』。先跑 `run_task(autoVerify:true, autoFixRounds:2)`，完成后用 `wait_task` 等到停点再看结果；若报告显示 `needs_attention`，把 `get_task_report` 的失败项摘要作为 `feedback` 调 `rework_task` 再验一轮；全部通过后向我汇报 `changedFiles` 与 `diffstat`。」

> 「在项目 `D:\xxx` 用 traework、`mode=Code` 实现『任务』；它会先切到 Code 模式再绑定项目，然后发任务、自动验收，失败自动生成修复计划并返修。」

## 工具面

13 个工具，按能力分为三族：`read`（读 / 查询，无副作用）、`write`（有副作用，全部需审批）、`execute`（执行项目侧命令但不改源码，当前仅 `verify_task`，仍免审批）。

| 工具 | 能力 / 审批 | 作用 |
|---|---|---|
| `run_task` | write + 审批 | 派活（可带自动验收 / 自动返修），异步返回 `taskId`；可选 `idempotencyKey`、`acceptanceOverride` 与 `dryRun` |
| `continue_task` | write + 审批 | 恢复 `needs_user` 的原会话（ZCode / Codex / Kimi Code / Qoder CN / MiniMax Code 各有恢复语义） |
| `query_task` | read | 轮询状态 / 进度 / 日志尾 / 最近细粒度事件（可选 `eventLimit`） |
| `list_tasks` | read | 历史任务过滤列表 |
| `get_task_report` | read | 某轮验收报告全文（`report.md`） |
| `cancel_task` | write + 审批 | 取消运行中任务：CLI agent kill 进程树；GUI agent 经 CDP 尽力点停止并在 `gui.cancelWaitMs`（默认 15s）内有界等待；对已终态 GUI 任务兼任人工确认入口 |
| `verify_task` | execute（不改源码，免审批） | 对任务 / 项目路径做一次验收。会跑项目配置命令、可能产生构建产物，故 MCP `readOnlyHint` 为 `false`，但**不改源码、仍免审批**；可选 `idempotencyKey` |
| `wait_task` | read | 阻塞等待单任务到达停点（终态或 `needs_user`）或超时；`timeoutMs` 缺省 50000、上限 600000，超时返回后再调一次继续等。纯只读、无害 |
| `wait_any` | read | 阻塞等待一组任务（1..20）中数组顺序首个到达停点者；返回该任务快照 + 全部任务当前状态。校验全部 id 存在，缺一即报错 |
| `rework_task` | write + 审批 | 手动返修（把失败报告喂回同一 agent）；可选 `repairHint`（≤4000 字符） |
| `get_profiles` | read | 查看 agent 适配与可执行探测结果 |
| `prepare_visual_baseline` | write + 审批 | 截图或导入参考图，生成待审阅候选和摘要 |
| `approve_visual_baseline` | write + 审批 | 用户审阅后校验摘要并写入基准与审批记录 |

> 返回统一为「人类可读文本 + `---tianshu-mcp-meta---` JSON 块」，便于宿主正则抽取。
>
> **路径安全闸门**（v0.4.0 起）：`projectPath` 在提交时校验——必须绝对路径、目录必须存在、符号链接经 realpath 归一；主目录本身与系统 / 根级目录直接拒绝，防止 worker 写权限覆盖整棵系统子树；git 仓库有未提交变更时回执附带共处警示。

## 支持的 Agent

`driver: "gui"` 由显式 adapter 驱动桌面 UI（各自使用隔离的 CDP 流程）；`driver: "spawn"` 走外部 CLI 子进程。

| agentId | driver / adapter | status | 说明 |
|---|---|---|---|
| `codex` | `gui` / `codex-gui` | **ready**（macOS 为 `research`） | Codex 桌面端 GUI（Windows：MSIX COM 激活 + CDP；macOS：spawn .app + CDP）；支持 `model` / `reasoningLevel` / `planDoc` / `designSystem`；等待用户确认、取消与重派护栏均已真机验证 |
| `zcode` | `gui` / `zcode-gui` | **ready**（Windows 真机闭环；macOS 未验证） | CDP GUI adapter；支持无项目派发、`allowCreateProject` 与 `reasoningLevel`（档位集合**随模型变化**，越权在**发送前**报错）；**v0.7.4 适配 3.14.x 的路径契约缺席**（绑定判据改为「路径优先、无路径渠道时按显示名 + 全局同名消歧」，同名即 fail-closed）；**v0.7.6 修掉绑定死锁**（侧边栏 `workspace-item-*` 滚出视口仍被采集 → 唯一可信的菜单渠道被短路）、**运行期 CDP 断连的恢复入口**（重连观察一次、绝不重发，失败落 `needs_user(setup_recovery)`）与**两级模型菜单**（provider 分组须 hover 才渲染子项）；**v0.8.0 恢复轮保留原会话权限**（issue #30：`continue_task` / `rework_task` 不再被 profile 默认值静默覆盖） |
| `traework` | `gui` / `traework-gui` | **ready** | CDP 驱动 TRAE SOLO CN 桌面 UI；支持 `mode`（Work / Code / Design，三种模式各自维护独立项目绑定）；三种面板模式真机验证通过；**v0.8.0 移除跨模式项目绑定兜底**（issue #35：非 Work 模式绑定失败不再回落 Work 并静默改写目标模式，失败即如实返回） |
| `kimicode` | `gui` / `kimicode-gui` | **ready**（macOS 为 `research`） | Kimi Code 桌面端（Electron）；**双渲染进程**（主窗口 + `Kimi Browser Overlay` 浮层承载模型 / 档位 / 模式菜单）；工作区以完整路径绑定；支持 `model` / `reasoningLevel`，**不支持 `mode`**，且**不支持无项目派发** |
| `qoder` | `gui` / `qoder-gui` | Windows 真机闭环通过；macOS **research** | 仅 Qoder CN；必须提供已有 `projectPath` 与可读 `planDoc`；`modelSource=default\|custom` 消除同名模型歧义，思考等级经「模型管理」保存为全局偏好并回读 |
| `opendesign` | `gui` / `opendesign-gui` | **ready**（macOS 为 `research`） | Open Design 桌面端 GUI；选择器取自产品自身 Web 前端的 `data-testid` 钩子，12 步执行链全部接线，并接入验收 → 自动返修 → 再验收闭环；它是唯一带「产物信号」（文件 mtime / 大小指纹）的 driver |
| `minimax` | `gui` / `minimax-gui` | **ready**（macOS 为 `research`） | MiniMax Code 桌面端（Electron）；**双渲染进程**（主窗口 + `Model menu` 弹层）；推理等级 / 上下文窗口在**悬停模型项展开的二级子菜单**里，且**候选集合随模型变化**（无子菜单的模型请求这两项即 fail-closed）；支持 `model` / `reasoningLevel` / **`contextWindow`**（本适配器专属），**不支持 `mode`**，且**不支持无项目派发**；「新建项目」为**应用内模态框 → 原生 `Select Directory` → 模态框提交**两步 |
| `stub` | `spawn` | 仅测试 | `test/stub-agent/stub-agent.mjs` 三剧本（good / fix-on-first / never） |

> `mode` 支持 `Work` / `Code` / `Design`（仅 TraeWork），不传时从任务书文本识别。Kimi Code 的 `reasoningLevel` 按**界面实际渲染的档位集合**校验（官方模型 `低` / `高` / `max`，非官方模型仅 `on` / `off`）。MiniMax Code 的 `reasoningLevel` / `contextWindow` 同样按**界面实际候选**校验（如 `M3.1-Flash-Preview` 为 `default`/`low`/`medium`/`high`/`xhigh`/`max` 与 `512K`/`1M`，而 `M3` 无档位组、`deepseek-v4.1-flash` 无窗口组），越权或读不到即 fail-closed。新增 agent 通常只需加一个 profile，详见 [docs/agent-profiles.md](docs/agent-profiles.md) 与 [CONTRIBUTING.md](CONTRIBUTING.md)。

### macOS 无头路径：codex-cli（用户 profile）

内置 `codex` 走桌面端 GUI 驱动；若不想依赖 GUI 自动化，**codex CLI 无头模式在 macOS 全程可用**——无需改 server 代码，在数据目录加一个 `driver=spawn` 的用户 profile 即可：

```json
{
  "profiles": {
    "codex-cli": {
      "displayName": "Codex CLI (OpenAI 无头)",
      "type": "cli",
      "driver": "spawn",
      "status": "ready",
      "command": null,
      "argsTemplate": ["exec", "<prompt:arg>", "--skip-git-repo-check", "--sandbox", "workspace-write"],
      "promptMode": "arg",
      "cwd": "task",
      "env": {},
      "timeoutMs": 1800000,
      "killTree": "taskkill",
      "authNote": "复用 ~/.codex 登录态；勿与 --approve-for-me 同用（实测互斥）",
      "executableDiscovery": {
        "dirs": ["/opt/homebrew/bin", "/usr/local/bin"],
        "fileNames": ["codex"],
        "fallbackCommand": "codex"
      }
    }
  }
}
```

- 前置：`npm i -g @openai/codex`（⚠️ **请保持最新**，≤0.130.0 签名证书已被吊销，macOS Gatekeeper 会直接 `Killed: 9`）并已 `codex login`。
- 用法与内置 agent 一致：`run_task(projectPath=/path/to/项目, agentId=codex-cli, task="任务书", autoVerify=true, autoFixRounds=2)`。
- `model` 参数对 spawn agent 不生效——CLI 使用 `~/.codex/config.toml` 的默认模型；要锁模型可在 `argsTemplate` 追加 `"-m", "<模型名>"`。

## 权限与安全边界

### 能力三族

| 能力 | 含义 | 审批 | 工具 |
|---|---|---|---|
| `read` | 只读 / 查询，无副作用 | 免审批 | `query_task` / `list_tasks` / `get_task_report` / `get_profiles` / `wait_task` / `wait_any` |
| `write` | 有副作用 | 需审批 | `run_task` / `continue_task` / `cancel_task` / `rework_task` / 两个视觉基准工具 |
| `execute` | 执行项目侧命令，不改源码 | 免审批 | `verify_task` |

> `readOnlyHint` 由 `capability === "read"` 推导，因此 `verify_task` 的该注解为 **false**；它**不是审批信号**——审批与否由 `_meta.requireApproval` 单独承载。

### 硬性红线

1. **绝不按进程树盲杀 GUI 实例** —— 只终止本模块创建、且命令行核对通过的 PID。
2. **默认复用用户实例** —— 绝不新起第二个；受管实例也不触碰用户手动打开的实例。
3. **computer-use 白名单** —— 仅允许 TraeWork 文件夹选择对话框（窗口标题 + 宿主进程双校验）。
4. **凭证零管理** —— 不读取 / 解密 / 转发任何 agent 凭证；GUI adapter 只驱动 UI。
5. **命令不拼 shell** —— 验收命令是结构化 argv，`shell:false`。
6. **不自动 commit / stash / 回滚** —— 动工前采集 git 基线，报告相对基线计算。
7. **路径不硬编码** —— 机器路径 / 用户名 / 端口走 profile 或占位符。
8. **stdout 只承载 JSON-RPC** —— 所有诊断日志走 stderr（并同源追加到 `logs/server.log`）。
9. **技能内容只来自包自身** —— 待安装技能经 `import.meta.url` 相对包定位，**不从 `process.cwd()` 发现内容**。

## 运行时契约

### stdio 与日志

本 server 严格遵守 MCP stdio 传输契约：**stdout 只承载 JSON-RPC 消息**，任何诊断日志都写入 **stderr** 并同源追加到 `<数据目录>/logs/server.log`（UTF-8，ISO 时间戳，含级别标签）。排查连接问题时以 `server.log` 为准；**不要因为 stderr 有输出就判定 server 异常**。只有启动失败（`tianshu-mcp 启动失败:`）才是致命错误，并会以非 0 退出码结束。

### 数据目录

```text
<数据目录>/                       默认 ~/.tianshu-mcp（可用 TIANSHU_MCP_HOME 覆盖）
├── config.json                  server 配置（并发、超时、技能开关、通知）
├── agent-profiles.json          用户自定义 / 覆盖的 agent profile
├── projects.json                项目登记表（含每项目验收配置）
├── idempotency.json             幂等键映射（TTL + 容量裁剪）
├── logs/server.log              全级别诊断日志（与 stderr 同源）
└── tasks/<taskId>/              单任务隔离目录（事件流 / 报告 / 日志 / 视觉证据）
```

### 技能自检安装

启动时把**包内** `skills/tianshu-mcp/` 幂等同步到 `~/.rivet/skills/tianshu-mcp/`，让宿主在新会话里读到编排技能。三个要点：

- **技能内容只来自包自身** —— 源目录由 `import.meta.url` 相对定位（dev 直跑与 dist 运行都指向包内 `skills/`），**不**从当前工作目录发现内容。找不到源时跳过安装并告警。
- **不一致时不静默覆盖** —— 安装目录内维护清单 `<目标>/.tianshu-mcp-install.json`（版本 + 内容 hash），据此仅在**可证未被改动**时自动升级；**检出你改过文件或来源不明 → 默认保留你的版本并告警**。
- **覆盖是原子的** —— 先装到 `.incoming-*`，再备份旧目录为 `.bak-<时间戳>`，最后换入；失败回滚，不留半成品。

```jsonc
// <数据目录>/config.json
{
  "skills": {
    "autoInstall": true,   // true（默认）| "prompt" | false
    "backupKeep": 3        // 覆盖后保留的历史备份个数；0 = 不清理
  }
}
```

放行与关闭（命令行参数或等价环境变量；`--no-skill-install` / `autoInstall:false` 的否决权最高）：

- `--approve-skill-update`（或 `TIANSHU_MCP_APPROVE_SKILL_UPDATE=1`）：本次启动允许「需变更」的技能目录由包内版本覆盖（先备份）。**对已确证含用户本地修改的目录不生效**。
- `--no-skill-install`（或 `TIANSHU_MCP_NO_SKILL_INSTALL=1`）：本次启动不做任何技能安装与检查。

## 里程碑

| 阶段 | 版本 | 交付概要 |
|---|---|---|
| 编排骨架 | 0.1.x | 8 工具、状态机 / 队列 / 并发闸 / 取消（kill tree）、验收引擎、自动返修；TraeWork CDP 驱动接入与模式切换 |
| ZCode GUI | 0.2.0 | ZCode 统一闭环（开发 → 受控失败 → 同会话返修 → `continue_task`） |
| Codex 桌面端 | 0.3.x | Codex MSIX COM 激活 + CDP（**破坏性**：`codex` 由无头改为 GUI）；等待用户检测、取消真停 GUI、验收引擎 fail-closed |
| macOS 与闸门 | 0.4.x | macOS 双驱动（spawn .app + CDP）、`projectPath` 安全闸门、验收命令有界并行（测试套件 267s → 51s） |
| 视觉与幂等 | 0.5.x | 视觉验收（0.5.0）+ 可选 AI 内容校验（0.5.4）、ZCode 无项目派发、Kimi Code / Qoder CN 适配、幂等键（0.5.10） |
| 加固与可观测 | 0.6.x | 技能自装加固（0.6.0）、GUI 选择器漂移修复（0.6.2）、细粒度事件流、结构化修复指令、dryRun、验收配置三级继承、终态通知 |
| Open Design | 0.7.x | Open Design 桌面端适配（0.7.1）、ZCode 3.14.x 绑定契约修复（0.7.4） |
| MiniMax Code | 0.7.8 | 第七个 GUI agent 接入（0.7.8）；真机取证修正三处结构假设（二级子菜单 / 集合随模型变化 / 项目创建两步），新增 `contextWindow` 参数与只读诊断探针 |
| 恢复语义修正 | 0.8.0 | TraeWork 移除跨模式项目绑定兜底（#35：兜底结构性不可达且静默改写目标模式）；ZCode 恢复轮保留原会话权限（#30：发送前无条件覆盖默认值已移除） |
| 完成判定加固 | 0.8.1 | 四个 driver（ZCode / Kimi Code / MiniMax Code / Open Design）补上「曾观测到运行信号」门（#31：选择器漂移时不再把进行中的任务误判成功）；`fix-loop` 让这三者的异常结束真正转 `needs_attention` 而非进验收链 |
| 日志台 GUI | `gui-v*`（独立线） | `mcp-gui/` 本地只读日志台（Tauri 2.x + Vue 3），独立版本与 tag，**不随 MCP 主包发布** |

> 完整逐版记录见 [CHANGELOG.md](CHANGELOG.md)，交接状态与排障手册见 [HANDOFF.md](HANDOFF.md)，工程质量口径见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 日志台 GUI

`mcp-gui/` 是本仓库的**第二个交付面**（issue #25）：一个**本地只读**的桌面应用（Tauri 2.x + Vue 3 + Vite + TypeScript），把 MCP 落盘的日志与任务产物统一到一个界面里查看。它与 MCP server 的关系只有一条——**共享同一批落盘事实，不产生第二个事实来源**：

- **不依赖 server 在运行** —— 纯读文件系统，数据目录按与 server **完全相同的规则**解析（`TIANSHU_MCP_HOME` → `~/.tianshu-mcp`），并可在多个数据目录之间切换 / 追加 / 移除。
- **只读消费方** —— 全程不改动任何业务数据（唯一写入是应用自身偏好，落在系统应用配置目录），也不替代面向机器的 `query_task` / `get_task_report`。
- **四类日志与产物** —— 全局运行日志、任务事件流、原始执行日志、验收报告；视觉离线 HTML 在 **sandbox iframe** 中渲染（禁用脚本、阻断外部资源）。

| 数据源 | 路径（相对数据目录） | 界面位置 |
|---|---|---|
| 全局运行日志 | `logs/server.log` | 工作区 · 运行日志 |
| 任务事件流 | `tasks/<taskId>/task.jsonl` | 工作区 · 事件流 |
| 原始执行日志 | `tasks/<taskId>/agent-<轮次>.log`、`verify-<轮次>.log` | 工作区 · Agent 日志 / 验收日志 |
| 验收报告 | `tasks/<taskId>/report-<轮次>.{md,json,html}`、`dry-run-report-<轮次>.{md,json}` | 工作区 · 验收报告 |

主要能力：

- **大日志与实时跟随** —— 首屏只读尾部 64 KiB 窗口、向前按块加载并显示「已加载 N / 共 M」；文件被追加时增量刷新，**上翻自动暂停跟随**，可一键「跳到最新」。
- **洞察（效能 / 归因 / 趋势）** —— 只读聚合：按 Agent 与按项目的**效能看板**（任务数 / 成功率 / 平均轮次 / 一次通过率 / 平均验收耗时 / 报告缺失）、四类**失败归因** TOP 列表（`errorType` / 失败检查项 / 阻塞问题 / 代码信号）、按天 / 按周的**任务量与成功率、返修率趋势**（纯内联 SVG，不引图表库）。口径显式标注（UTC 日期、周一为周始、「一次通过」= 成功且仅 1 轮、只统计每个任务的**最新一轮**报告），**只读统计、不提供删除 / 清理**。
- **结构化筛选 / 多任务对比 / 命令面板** —— 概览页筛选新增**错误类型 / 干跑 / 返修 / 视觉验收**四项（口径与任务快照字段一一对应，前后端同口径）；洞察页新增「**任务对比**」子分区，勾选 **2–4 个** 任务并排看状态 / 轮次 / 验收耗时 / 改动行数 / 最新报告判定等指标（报告**按需读取**并缓存，缺失一律显示 `—`，**不编造**）；`Ctrl/Cmd + K` 打开**命令面板**（子序列模糊匹配，跳页面 / 切数据目录 / 直接打开任务），`Ctrl/Cmd + R` 刷新，**全部为只读交互**。
- **基线与复盘 / 阶段甘特 / 磁盘占用 / 深链** —— 工作区新增**「基线」**分区（动工前 `baseline.json` 摘要并与最新报告改动对照，缺失如实提示）；事件流新增**「阶段」视图**（状态跃迁甘特，按需读一次全量，最后一段标「进行中」不编造时长）；洞察页新增**「磁盘占用」**（总量 / logs 占比 / 体积 TOP 20 / **只提示不删除**的「可清理」相对判据）；支持 **`tianshu://task/<任务ID>` 深链**（冷启动 + 热启动、单实例唤出已有窗口，Rust 侧处理故不给 webview 多余权限）。
- **报告与多轮对比** —— `.md` 渲染、`.json` 结构化卡片、视觉 `.html` 沙箱预览；`dry-run-report-*` 与 `report-*` **分开展示**（静态分析 vs 真实命令验收，结论口径不同），多轮报告可并排对比。
- **界面与主题** —— 中英双语、**跟随系统 / 浅色 / 深色**三选一；自研「黑曜石终端」设计系统，**零 UI 库、零外链、零字体文件**，图标一律内联 SVG。
- **系统托盘与关闭行为** —— 常驻托盘（「显示日志台 / 退出日志台」，文案随界面语言即时切换），默认 **关闭窗口 = 缩小到托盘**，可在设置面板改为「关闭应用」。
- **更新日志窗口与双源自动更新** —— 启动静默检查更新，命中即弹「更新日志」（下载并安装 / 忽略此版本 / 稍后），正文即该版本的双语发行说明，**与发行页同源同一份**（正文缺失即拒绝发版，不产出空正文 / 单行标题）；更新源由 **Gitee / GitHub 并发实测择优**（不依赖系统区域）决定并如实展示，包体经 **minisign 验签**，**验签不通过一律拒绝安装**。

<p align="center">
  <a href="./assets/tianshu-mcp-gui-overview.png"><img src="./assets/tianshu-mcp-gui-overview.png" alt="日志台 · 任务概览页" width="32%"></a>
  <a href="./assets/tianshu-mcp-gui-event-stream.png"><img src="./assets/tianshu-mcp-gui-event-stream.png" alt="日志台 · 任务事件流工作区" width="32%"></a>
  <a href="./assets/tianshu-mcp-gui-agent-log.png"><img src="./assets/tianshu-mcp-gui-agent-log.png" alt="日志台 · Agent 原始日志工作区" width="32%"></a>
  <br>
  <b>任务概览页</b> —— 常驻左侧栏 · 五格指标仪（任务总数 / 进行中 / 已结束 / 已成功 / 已失败）· 状态圆片 · 任务卡网格
  <br>
  <b>全屏工作区 · 事件流</b> —— 行 / 时间 / 事件 / 详情四列，状态跃迁与进度记录分色标注
  <br>
  <b>全屏工作区 · Agent 日志</b> —— 级别过滤 · 行号与自动换行 · 「已加载 N / 共 M」与「跳到最新」
</p>

解耦与发布边界（改这里之前先读）：

| 边界 | 约定 |
|---|---|
| 数据 | GUI **只读**业务目录；唯一写入是应用自身偏好与用户显式选择的导出 / 更新文件 |
| 代码 | `mcp-gui/` 有自己的 `package.json` / `tsconfig` / eslint / vitest，**不参与根工程门禁** |
| 打包 | 根 `package.json` 的 `files` 白名单不含 `mcp-gui`，**不被打入 MCP 主包 npm 产物** |
| 发版 | GUI 独立版本号与独立 tag（`gui-v*`），**不随 MCP 主包发布**（`release.yml` 只认 `v*`） |
| 构建 | 本机**不执行** Rust 侧构建与检查（`cargo fmt` / `clippy` / `tauri build` 全在 `GUI` workflow），本地只做前端预览与前端门禁 |

> **双份 schema 的防漂移**：事件分类在 Rust 侧与前端各有一份镜像，真源始终是 `src/tasks/task.ts` 与 `src/agents/agent-events.ts`；`mcp-gui/scripts/check-schema-parity.mjs` 在 CI 中做三方集合比对，**任一不一致即 fail**。使用与开发说明见 [日志台文档](docs/gui-log-viewer.md)，真机记录见 [issue-25 记录](docs/issue-25-gui-real-machine-record.md)。

## 文档导航

**使用与集成**

| 文档 | 说明 |
|---|---|
| [ARCHITECTURE.md](<ARCHITECTURE.md>) | 架构说明：分层模型与模块边界、状态机、验收流水线、驱动层契约、扩展点与已知缺口 |
| [docs/core-principles.md](<docs/core-principles.md>) | 核心原理分析：四条硬约束如何逼出当前架构、核心机制逐条拆解与自洽性总结 |
| [docs/tianshu-integration.md](docs/tianshu-integration.md) | 天枢 config.json 两种接入模式、UI / API 操作、冒烟步骤、FAQ |
| [docs/agent-profiles.md](docs/agent-profiles.md) | agent profile 字段说明 + 真实机器样例 |
| [docs/adapter-matrix.md](docs/adapter-matrix.md) | 各 Agent 能力调研矩阵 |
| [docs/npm-publish-guide.md](docs/npm-publish-guide.md) | npm 发布步骤与凭证说明 |
| [skills/tianshu-mcp/SKILL.md](skills/tianshu-mcp/SKILL.md) | 教天枢编排本 MCP 的技能（含使用示例） |

**Agent 适配（CDP 驱动）**

| 文档 | 说明 |
|---|---|
| [docs/codex-gui-cdp.md](docs/codex-gui-cdp.md) | Codex 桌面端：MSIX COM 激活、CDP 接管、选择器、运行检测、验收返修 |
| [docs/traework-cdp.md](docs/traework-cdp.md) | TraeWork：原理、配置、模式切换、选择器、安全红线、踩坑记录 |
| [docs/zcode-cdp.md](docs/zcode-cdp.md) | ZCode：安装探测、精确项目 / 模型、完全访问、暂停继续、无项目派发与双平台状态 |
| [docs/kimi-cdp.md](docs/kimi-cdp.md) | Kimi Code：双渲染进程、工作区完整路径绑定与原生导入、模型三级选择与思考档位 |
| [docs/qoder-cdp.md](docs/qoder-cdp.md) | Qoder CN：安装发现与实例复用、工作区原生导入、`modelSource` 与全局思考等级、原会话返修 |
| [docs/opendesign-cdp.md](docs/opendesign-cdp.md) | Open Design：数据目录推导、sidecar 根进程判定、选择器取证表与 12 步执行链、传输层双路径、失败码表 |
| docs/minimax-cdp.md | MiniMax Code：双渲染进程、模型二级子菜单（推理等级 / 上下文窗口）与逐模型候选、完整路径项目绑定、`Select Directory` 原生对话框 |

**验收与可观测**

| 文档 | 说明 |
|---|---|
| [docs/acceptance-config.md](docs/acceptance-config.md) | 项目级与三级继承的验收配置规范 |
| [docs/repair-directives.md](docs/repair-directives.md) | 结构化修复指令：来源、回退语义与已知限制 |
| [docs/dry-run.md](docs/dry-run.md) | dryRun 干跑模式：只读约束、零改动门禁、方案文档 |
| [docs/event-stream.md](docs/event-stream.md) | 细粒度事件流：词表、落盘与读取侧有界窗口 |
| docs/notifications.md | 任务终态通知：webhook 契约、去重与签名 |
| docs/wait-task.md | 等待原语：`wait_task` / `wait_any` 契约、停点定义、超时矩阵与循环模式 |
| [docs/visual-acceptance.md](docs/visual-acceptance.md) | 视觉验收入门与完整配置（含可选 AI 内容校验） |
| [docs/visual-validation.md](docs/visual-validation.md) | 视觉验收验证进度与平台证据 |
| [docs/visual-validation-evidence/](docs/visual-validation-evidence/) | 上述验证的原始机器可读记录 |
| [docs/gui-log-viewer.md](docs/gui-log-viewer.md) | 日志台 GUI（`mcp-gui/`）：四类日志与任务产物、双源自动更新、开发与 CI 边界 |

**真机验收记录**

| 文档 | 说明 |
|---|---|
| [docs/m2-smoke-record.md](docs/m2-smoke-record.md) · [docs/m2-rework-record.md](docs/m2-rework-record.md) | M2 真实 codex 冒烟与 rework 闭环记录 |
| [docs/zcode-windows-smoke.md](docs/zcode-windows-smoke.md) · [docs/zcode-issue-8-10-validation.md](docs/zcode-issue-8-10-validation.md) · [docs/zcode-issue-12-windows-evidence.md](docs/zcode-issue-12-windows-evidence.md) | ZCode Windows 真机验收记录 |
| [docs/codex-windows-smoke.md](docs/codex-windows-smoke.md) | Codex Windows 真机验收记录（含失败 → 自动生成计划 → 返修通过） |
| [docs/host-integration-record.md](docs/host-integration-record.md) · [docs/issue-1-host-reconnect-record.md](docs/issue-1-host-reconnect-record.md) | 天枢宿主真实接入与重连验收 |
| [docs/dod7-release-record.md](docs/dod7-release-record.md) · [docs/dod8-session-record.md](docs/dod8-session-record.md) · [docs/s7-session-recheck.md](docs/s7-session-recheck.md) | npm 发布、真实会话实测与二次整改复测 |
| [docs/issue-16-skill-install-hardening-record.md](docs/issue-16-skill-install-hardening-record.md) · [docs/issue-17-small-fixes-record.md](docs/issue-17-small-fixes-record.md) · [docs/issue-23-selector-drift-record.md](docs/issue-23-selector-drift-record.md) | 技能自装加固、小项扫尾、选择器漂移记录 |
| [docs/issue-18-21-real-machine-record.md](docs/issue-18-21-real-machine-record.md) · [docs/issue-19-22-real-machine-record.md](docs/issue-19-22-real-machine-record.md) | 事件流 / 修复指令 / dryRun / 验收继承 / 通知的真机记录 |
| [docs/issue-25-gui-real-machine-record.md](docs/issue-25-gui-real-machine-record.md) · [docs/gui-0.1.0-release-record.md](docs/gui-0.1.0-release-record.md) | 日志台 GUI 真机验收与正式版发布记录 |

## 面向开发者

Node.js ≥ 20 · TypeScript 5.7 · Vitest · tsup-free（`tsc` 直出 `dist/`）+ tsx 开发。

```bash
npm ci
npm run build        # sync-version + tsc → dist/
npm test             # 全量用例
npm run typecheck    # 类型检查（tsc --noEmit）
npm run lint         # ESLint（--max-warnings 0）
npm run check:stdio  # 严格 stdio 冒烟（真实进程字节流校验）
```

- **新增 CLI agent** —— 通常只需在 `<数据目录>/agent-profiles.json` 加一个 `driver: "spawn"` 的 profile，零改代码。
- **新增 GUI agent** —— 新写一个 adapter 目录（`adapter.ts` / `discovery.ts` / `cdp.ts` / `selectors.ts` / `project.ts` / `liveness.ts` / `run.ts`），并在 `agents/registry.ts` 与 `agents/builtin.ts` 注册。
- **新增 MCP 工具** —— `src/mcp/tools.ts` 增元数据 + `src/mcp/handlers.ts` 增实现 + `src/config/schema.ts` 增入参 schema。
- **调 UI 选择器** —— profile `gui.selectors` 覆盖（客户端升级导致选择器漂移时，先用 `npm run probe:*` 诊断）。
- 版本号三处必须同步：`package.json`、`package-lock.json`、`src/version.generated.ts`（后者由 `scripts/sync-version.mjs` 在 build 前生成，**勿手改**）。

## 安全

- **路径边界强制** —— `projectPath` 经 realpath 归一；主目录与系统 / 根级目录子树拒绝；glob/grep/diff 拒绝 `..` 穿越。
- **不自动改动仓库历史** —— 动工前采集 git 基线，报告相对基线计算；MCP 从不自动 commit / stash / checkout。
- **凭证零管理** —— 不读取 / 解密 / 转发任何 agent 凭证；AI 内容校验同样不引入凭证管理——判定命令自己管密钥。
- **命令不拼 shell** —— 验收命令是结构化 argv，`shell:false`，无 shell 注入面。
- **桌面自动化边界** —— 默认复用用户实例、computer-use 白名单、归属核对后才终止进程。

安全漏洞请按 [SECURITY.md](SECURITY.md) 私密报告，**不要**开公开 Issue。

## 社区与支持

- **使用问题 / 讨论** → [GitHub Issues](https://github.com/lanlan0811/tianshu-mcp/issues)（附 `logs/server.log` 输出可加速定位）
- **主仓库** → <https://github.com/lanlan0811/tianshu-mcp>（GitHub）
- **镜像仓库** → <https://gitee.com/lan0811/tianshu-mcp>（Gitee）
- **贡献代码** → [CONTRIBUTING.md](CONTRIBUTING.md) · **安全模型** → [SECURITY.md](SECURITY.md) · **行为准则** → [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- **交接状态 / 排障手册** → [HANDOFF.md](HANDOFF.md) · **版本变更** → [CHANGELOG.md](CHANGELOG.md) · **依赖清单** → [DEPENDENCIES.md](DEPENDENCIES.md)

## 贡献者

感谢以下通过 Issue 与 PR 为本项目做出贡献的社区成员（按首次参与顺序排列）：

<table>
  <tr>
    <td align="center"><a href="https://github.com/liuchsong"><img src="https://github.com/liuchsong.png" width="50" height="50" alt="liuchsong" /><br /><sub>liuchsong</sub></a></td>
    <td align="center"><a href="https://github.com/a13612745638"><img src="https://github.com/a13612745638.png" width="50" height="50" alt="a13612745638" /><br /><sub>a13612745638</sub></a></td>
    <td align="center"><a href="https://github.com/king195547"><img src="https://github.com/king195547.png" width="50" height="50" alt="king195547" /><br /><sub>king195547</sub></a></td>
    <td align="center"><a href="https://github.com/zhaoxc857"><img src="https://github.com/zhaoxc857.png" width="50" height="50" alt="zhaoxc857" /><br /><sub>zhaoxc857</sub></a></td>
    <td align="center"><a href="https://github.com/jian-in"><img src="https://github.com/jian-in.png" width="50" height="50" alt="jian-in" /><br /><sub>jian-in</sub></a></td>
    <td align="center"><a href="https://github.com/huiliyi37"><img src="https://github.com/huiliyi37.png" width="50" height="50" alt="huiliyi37" /><br /><sub>huiliyi37</sub></a></td>
    <td align="center"><a href="https://github.com/MToF0214"><img src="https://github.com/MToF0214.png" width="50" height="50" alt="MToF0214" /><br /><sub>MToF0214</sub></a></td>
  </tr>
</table>

## Star History

<a href="https://star-history.com/#lanlan0811/tianshu-mcp&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=lanlan0811/tianshu-mcp&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=lanlan0811/tianshu-mcp&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=lanlan0811/tianshu-mcp&type=Date" width="700" />
  </picture>
</a>

## 许可证

本项目以 **Apache License 2.0** 发布，完整法律文本见 [LICENSE](LICENSE)。版权归 tianshu-mcp 贡献者所有（Copyright 2026 tianshu-mcp contributors）。简言之：你可以商业使用、修改、分发与私用，并获授贡献者专利许可；分发时须随附 LICENSE 全文并标注修改；本许可**不授予**商标使用权，对贡献者发起专利诉讼将导致专利授权自动终止；软件按「现状」提供，不附带任何担保。

### 第三方依赖许可

运行时依赖的许可如下（**完整依赖清单**——逐项版本、开发依赖、桌面端 Rust 依赖、间接依赖许可证分布与 SBOM 复现命令——见 [DEPENDENCIES.md](DEPENDENCIES.md)）：

| 依赖 | 许可 | 用途 |
|---|---|---|
| [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/sdk) | MIT | MCP 协议实现 |
| [`zod`](https://github.com/colinhacks/zod) | MIT | 外部输入校验 |
| [`cross-spawn`](https://github.com/moxystudio/node-cross-spawn) | MIT | 跨平台子进程 |
| [`puppeteer-core`](https://github.com/puppeteer/puppeteer) | Apache-2.0 | 视觉验收驱动无头浏览器 |
| [`@puppeteer/browsers`](https://github.com/puppeteer/puppeteer) | Apache-2.0 | 托管 Chrome/Edge 的安装与版本锁定 |
| [`pixelmatch`](https://github.com/mapbox/pixelmatch) | ISC | 页面截图像素比对 |
| [`sharp`](https://github.com/lovell/sharp)（optional） | Apache-2.0 | 图片解码与规格校验；缺失时视觉模块明确阻塞 |

> `sharp` 本体为 Apache-2.0，但其**可选**平台二进制（`@img/sharp-*`）声明为 **LGPL-3.0-or-later**，以未修改的预编译动态库使用——不安装 `sharp` 时依赖树中不含任何 LGPL 组件。

开发依赖（TypeScript、ESLint、Prettier、Vitest、Vite、tsx 等）各自遵循其开源许可，且不随 npm 发布产物分发。

### 与安全边界的关系

本 MCP **不保存、不读取、不转发**任何 AI-Agent 的 API key 或登录态（详见 [SECURITY.md](SECURITY.md)）。许可条款不改变这一设计边界。

---

> 英文文档见 [README.en.md](README.en.md) 与 [ARCHITECTURE.en.md](ARCHITECTURE.en.md)；完整文档地图与状态快照见 [HANDOFF.md](HANDOFF.md)。