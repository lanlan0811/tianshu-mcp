<div align="center">

<img src="./assets/tianshu-mcp-banner.svg" alt="tianshu-mcp" width="100%">

<br/>

<img src="./assets/tianshu-mcp-icon.svg" alt="tianshu-mcp 图标" width="132" height="132">

# tianshu-mcp

视觉验收（v0.5.0 起）：[中文指南](docs/visual-acceptance.md) · [验证记录](docs/visual-validation.md) · [最新发布说明](<docs/release-v0.5.3.md>)。

**天枢 × AI-Agent 编排 MCP server**

由天枢（Tianshu）当作标准 MCP server 接入，调度外部 AI-Agent（Codex 桌面端、TraeWork/TRAE SOLO CN、ZCode 均经 CDP 驱动桌面 UI）完成 **项目开发 → 验收 → 失败返修 → 再验收** 的闭环（架构可横向扩展）。

> 天枢官方仓库：[github.com/huiliyi37/Tianshu-harness](https://github.com/huiliyi37/Tianshu-harness) —— 基于 harness 工程的终端编程智能体运行时（TUI × GUI），本 MCP 作为其 MCP server 接入。

<br/>

[![CI](https://github.com/lanlan0811/tianshu-mcp/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/lanlan0811/tianshu-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/tianshu-mcp.svg?color=cb3837&logo=npm)](https://www.npmjs.com/package/tianshu-mcp)
[![npm downloads](https://img.shields.io/npm/dm/tianshu-mcp.svg?color=cb3837)](https://www.npmjs.com/package/tianshu-mcp)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.x-6f42c1.svg)](https://github.com/modelcontextprotocol/sdk)

[English](README.en.md) · **简体中文**

</div>

---

## 这是什么

天枢的角色是总指挥；本 MCP server 是**调度层 + 执行面 + 客观验收仪**；外部 AI-Agent（Codex / TraeWork / ZCode GUI）是执行开发的「工人」。

- **11 个 MCP 工具**：`run_task / continue_task / query_task / list_tasks / get_task_report / cancel_task / verify_task / rework_task / get_profiles`，外加视觉验收的 `prepare_visual_baseline / approve_visual_baseline`
- **异步契约**：`run_task` 秒回 `taskId`，长任务用 `query_task` 轮询（长任务不卡 `tools/call`）。
- **客观验收**：自动命令检查（typecheck/lint/test/build，缺则跳过 + 技术栈推导）+ 程序化代码分析（变更清单/diffstat/TODO·debugger·密钥形态等可疑标记），全部相对 **git 基线**，不自动 commit/stash。验收引擎 **fail-closed**：测试命令退出码为 0 但输出显示零用例时判失败；git 项目默认要求相对动工前基线产生变更（纯分析任务可在 `.tianshu-mcp/acceptance.json` 设 `"requireChanges": false` 显式关闭）。
- **验收并行度**：命令检查默认**有界并行**（`verifyConcurrency`，默认 2、范围 1–4）。检查项之间有顺序依赖时（后续检查读取 build 产物、带 `--fix`、共享缓存目录）请设 `1` 完全退化为串行；项目级 `.tianshu-mcp/acceptance.json` 可覆盖，server 级在 `config.json`。报告与日志格式不变（结果按声明顺序返回）。
- **失败返修闭环**：自动返修（`autoFixRounds`）+ 手动 `rework_task`；验收失败时自动生成修复计划文件并回填给 agent；轮次用尽 → `needs_attention` 等天枢裁决。
- **执行面**：`driver: "gui"` 由显式 adapter 驱动桌面 UI（Codex / TraeWork / ZCode 各自使用隔离的 CDP 流程）；`driver: "spawn"` 走外部 CLI 子进程。
- **无项目派发（ZCode，issue #12）**：`run_task` 的 `projectPath` 可省略——ZCode 在 `default` 工作区承接任务，不登记/导入项目、不采集 Git 基线、不执行项目验收（结果以 `verificationNotApplicable: "no_project"` 结构化标注，`verify_task`/`get_task_report` 返回不适用说明）。配套 `allowCreateProject: false` 可在目标目录未登记时于任何导入副作用之前停止派发。详见 [ZCode CDP 适配器](docs/zcode-cdp.md)。
- **调度纪律**：每项目串行队列 + 全局并发上限（默认 2，可配）。
- **不碰密钥**：各 agent 用自己的登录态；本 server 不保存/转发任何 API key。
- **可扩展**：新 agent = 一个 profile（数据）+（如需）一个 adapter 文件，零改编排核心。
- **想理解内部结构**：见 [ARCHITECTURE.md](ARCHITECTURE.md)（分层模型、模块边界、状态机、验收流水线、扩展点与已知缺口）。

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
npm test             # 496 项测试：56 个文件，含 Codex/ZCode/TraeWork 单元/假 CDP/重启/恢复/返修闭环与视觉验收
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

> - 服务器 ID 即工具前缀：填 `tianshu-mcp` 后工具名为 `mcp__tianshu-mcp__run_task` 等 11 个。
> - 参数按空格分隔填写，**不要加引号**；本地开发模式请把 `<仓库绝对路径>` 换成真实绝对路径（如 `D:/Trae项目/tianshu-mcp/dist/index.js`）。
> - 界面未提供环境变量输入框；如需自定义数据目录，改用下面的 `config.json` 方式设置 `TIANSHU_MCP_HOME`。
> - 添加后连接成功即完成；新开会话即可看到 11 个工具。

### 或改 config.json（可配环境变量）

配置为天枢 MCP server（本地开发模式）：

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

新开会话后，工具面出现 `mcp__tianshu-mcp__run_task` 等 11 个工具。用 stub 预演（不碰真实登录态）→ 切 codex 跑真实任务：

```text
run_task(projectPath=D:/xxx/my-app, task=「…任务书…」, agentId=codex,
         model=「GPT-5.6 Sol」, reasoningLevel=「高」, autoVerify=true, autoFixRounds=5)
  → taskId → query_task(taskId) 轮询 → succeeded / failed / needs_attention → get_task_report 读报告
```

> `codex` 现为**桌面端 GUI 驱动**（`driver=gui` + `activation=msix-com`）：Codex 是 MSIX 商店包，
> 其 `ChatGPT.exe` 无法直接启动（被策略拒绝），须经 COM 激活并注入专属 `--user-data-dir` 后方可
> 用 CDP 驱动。可传 `planDoc` / `designSystem` 拼进初始指令。详见 [docs/codex-gui-cdp.md](docs/codex-gui-cdp.md)
> 与 [真机验收记录](docs/codex-windows-smoke.md)。项目未在 Codex 侧登记时会**自动登记**，无需手动建项目。
> Codex 停在「等待用户确认」界面（方案确认卡/订阅结账页等）会转 `needs_user(user_confirmation)`，
> 用户在 Codex 窗口处理完后调 `continue_task(taskId)` 恢复观察；`cancel_task` 会经 CDP 点击停止并
> 有界等待 GUI 空闲，派发前若受管实例仍在运行会先尽力停止，仍不空闲则以 `instance_busy` 拒绝派发。

驱动 TraeWork 时可用 `model` 与 `mode`：

```text
run_task(projectPath=D:/xxx/my-app, agentId=traework, task=「切换到 Code 模式，实现登录接口」,
         model=GLM-5.3, mode=Code, autoVerify=true, autoFixRounds=2)
```

> `mode` 支持 `Work` / `Code` / `Design`；不传时从任务书文本识别（如「切换到 Code 模式」），识别不到则保持 `Work`。
> TraeWork 的三种模式**各自维护独立的项目绑定**，因此实现顺序为「新建会话 → 切到目标模式 → 在目标模式内绑定项目」。

驱动 ZCode 时，`model` 必须使用精确的 `供应商/模型`，且不能传 `mode`：

```text
run_task(projectPath=D:/xxx/my-app, agentId=zcode, task=「按 `./plan.md` 完成开发」,
         model=DeepSeek/deepseek-flash, autoVerify=true)
```

ZCode 提问、需要登录、旧实例无 CDP、系统权限不足，或自动恢复未完成（`needs_user/setup_recovery`）时进入 `needs_user`；处理后调用 `continue_task(taskId, message)` 恢复——确认文本不发给模型，无锚点的环境恢复会补发完整原任务、上下文与已验证引用，且不消耗返修轮数。模型选择已适配 ZCode 3.11.2：直选平铺模型优先，展开 provider/family 分组兜底，新旧布局均兼容。完整约束见 docs/zcode-cdp.md。

## 工具面（11 个）

| 工具 | 能力 / 审批 | 作用 |
|---|---|---|
| `run_task` | write + 审批 | 派活（可带自动验收/自动返修），异步返回 `taskId` |
| `continue_task` | write + 审批 | 恢复 `needs_user` 的原会话（ZCode 恢复原会话；Codex 按 `user_confirmation` 重新观察 / `login_required` 重派） |
| `query_task` | read | 轮询状态 / 进度 / 日志尾 |
| `list_tasks` | read | 历史任务过滤列表 |
| `get_task_report` | read | 某轮验收报告全文（`report.md`） |
| `cancel_task` | write + 审批 | 取消运行中任务：CLI agent kill 进程树；GUI agent 经 CDP 点击停止并在 `gui.cancelWaitMs`（默认 15s）内有界等待 GUI 空闲，未确认停止时终态明示 |
| `verify_task` | read | 对任务/项目路径做一次验收（不改源码） |
| `rework_task` | write + 审批 | 手动返修（把失败报告喂回同一 agent） |
| `get_profiles` | read | 查看 agent 适配与可执行探测结果 |
| `prepare_visual_baseline` | write + 审批 | 截图或导入参考图，生成待审阅候选和摘要 |
| `approve_visual_baseline` | write + 审批 | 用户审阅后校验摘要并写入基准与审批记录 |

> 返回统一为「人类可读文本 + `---tianshu-mcp-meta---` JSON 块」，便于宿主正则抽取。

> **路径安全闸门**（v0.4.0 起）：`projectPath` 在提交时校验——必须绝对路径、目录必须存在、符号链接经 realpath 归一（回执明示解析来源）；主目录本身与系统/根级目录直接拒绝，防止 worker 写权限覆盖整棵系统子树；git 仓库有未提交变更时回执附带共处警示。

> **无项目派发**（ZCode 专用，v0.5.2 起）：省略 `projectPath` 时任务在 ZCode 的 `default` 工作区运行，跳过项目登记、Git 基线、项目快照、项目锁与项目验收（终态标注 `not_applicable: no_project`）。`allowCreateProject=false` 可禁止自动导入未登记的项目。详见 [docs/zcode-cdp.md](docs/zcode-cdp.md#无项目default-工作区)。

## 日志与 stdio 契约

本 server 是标准 MCP **stdio server**，严格遵守传输契约：

- **stdout 只承载 MCP JSON-RPC 消息**。任何诊断日志都不会写入 stdout——否则会破坏 JSON-RPC 流，导致严格客户端握手或工具调用失败。
- **所有级别日志（DEBUG/INFO/WARN/ERROR）写入 stderr**，同时追加到数据目录下的 `logs/server.log`（UTF-8，ISO 时间戳，含级别标签）。
- 因此 **stderr 里出现 `INFO`/`WARN` 不代表服务器出错**；它是正常诊断信息。只有启动失败（`tianshu-mcp 启动失败:`）才是致命错误，并会以非 0 退出码结束。

数据目录默认 `~/.tianshu-mcp`（可用 `TIANSHU_MCP_HOME` 覆盖），日志文件位于 `<数据目录>/logs/server.log`。

排查连接问题时以 `server.log` 为准；不要因为 stderr 有输出就判定 server 异常。

## 文档

| 文档 | 内容 |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | **架构说明**：分层模型与模块边界、启动装配、数据目录、状态机、验收与返修流水线、Agent 驱动层契约、GUI 实例生命周期、跨平台策略、安全红线、扩展点、已知缺口 |
| [docs/tianshu-integration.md](docs/tianshu-integration.md) | 天枢 config.json 两种接入模式、UI/API 操作、冒烟步骤、FAQ |
| [docs/agent-profiles.md](docs/agent-profiles.md) | agent profiles 字段说明 + 真实机器样例（codex M2 定稿） |
| [docs/adapter-matrix.md](docs/adapter-matrix.md) | 各 Agent 能力调研矩阵（Codex/Zcode/TraeWork/扩展位） |
| [docs/traework-cdp.md](docs/traework-cdp.md) | TraeWork GUI 驱动（CDP）：原理、配置、模式切换、选择器、安全红线、踩坑记录、验证记录 |
| [docs/zcode-cdp.md](docs/zcode-cdp.md) | ZCode GUI 驱动：安装探测、精确项目/模型、完全访问、暂停继续、验收返修与双平台状态 |
| [docs/zcode-windows-smoke.md](docs/zcode-windows-smoke.md) | ZCode Windows 真机开发、同会话返修与提问续跑验收记录 |
| [docs/codex-gui-cdp.md](docs/codex-gui-cdp.md) | Codex 桌面端 GUI 驱动：MSIX COM 激活、CDP 接管、选择器、运行检测、验收返修 |
| [docs/codex-windows-smoke.md](docs/codex-windows-smoke.md) | Codex Windows 真机验收记录（含验收失败→自动生成计划→返修通过闭环） |
| [docs/release-v0.5.3.md](<docs/release-v0.5.3.md>) | v0.5.3 发布说明（ZCode 真机回访修复：实例跨 server 驻留、新建任务切页、发送失败归因） |
| [docs/release-v0.5.2.md](<docs/release-v0.5.2.md>) | v0.5.2 发布说明（ZCode 无项目派发与 `allowCreateProject`，issue #12） |
| [docs/release-v0.5.1.md](<docs/release-v0.5.1.md>) | v0.5.1 发布说明（技能/验证文档补齐、平台证据归档、锁文件版本同步；无运行时变更） |
| [docs/release-v0.5.0.md](<docs/release-v0.5.0.md>) | v0.5.0 发布说明（可选视觉验收模块：截图对比、图片规格、基准批准、离线报告） |
| [docs/visual-acceptance.md](<docs/visual-acceptance.md>) | 视觉验收入门与完整配置：三种页面来源、基准候选/批准、规则冻结、阈值与排查 |
| [docs/visual-validation.md](<docs/visual-validation.md>) | 视觉验收验证进度：Windows 10 完整功能矩阵与 macOS Intel/Apple Silicon 平台证据（系统/Node/浏览器/命令/结果） |
| [docs/visual-validation-evidence/](<docs/visual-validation-evidence/>) | 上述验证的原始机器可读记录（环境 JSON、矩阵结果、测试输出与 macOS CI 摘要） |
| [docs/release-v0.4.1.md](<docs/release-v0.4.1.md>) | v0.4.1 发布说明（技能文档对齐 v0.4.0 工具面 + 贡献者名录） |
| [docs/release-v0.3.4.md](<docs/release-v0.3.4.md>) | v0.3.4 发布说明（ZCode 项目/模型回读、初始化恢复与会话发送确认，issue #8/#9/#10） |
| [docs/zcode-issue-8-10-validation.md](<docs/zcode-issue-8-10-validation.md>) | ZCode #8/#9/#10 Windows 真机验收记录（冷导入、已导入复用、同任务恢复） |
| [docs/release-v0.3.3.md](<docs/release-v0.3.3.md>) | v0.3.3 发布说明（ZCode 3.11.2 适配 + 验收引擎 fail-closed） |
| [docs/release-v0.3.2.md](docs/release-v0.3.2.md) | v0.3.2 发布说明（Codex 等待用户检测 + cancel 真停 GUI） |
| [docs/release-v0.3.1.md](docs/release-v0.3.1.md) | v0.3.1 发布说明（技能文档重写 + 发布自动化修复） |
| [docs/release-v0.3.0.md](docs/release-v0.3.0.md) | v0.3.0 发布说明（Codex 桌面端 GUI 适配，含 BREAKING） |
| [docs/release-v0.2.0.md](docs/release-v0.2.0.md) | v0.2.0 发布说明（ZCode GUI 统一闭环） |
| [docs/acceptance-config.md](docs/acceptance-config.md) | 项目级 `.tianshu-mcp/acceptance.json` 验收配置规范 |
| [docs/release-v0.1.9.md](docs/release-v0.1.9.md) | v0.1.9 发布说明（TraeWork 任务进行中检测与实例保留） |
| [docs/release-v0.1.10.md](docs/release-v0.1.10.md) | v0.1.10 发布说明（修复 stdio 日志污染：诊断日志统一走 stderr） |
| [docs/release-v0.1.8.md](docs/release-v0.1.8.md) | v0.1.8 发布说明（原子写并发缺陷修复） |
| [docs/release-v0.1.7.md](docs/release-v0.1.7.md) | v0.1.7 发布说明（绑定根因：原生路径） |
| [docs/release-v0.1.6.md](docs/release-v0.1.6.md) | v0.1.6 发布说明（项目文件夹绑定修复） |
| [docs/release-v0.1.5.md](docs/release-v0.1.5.md) | v0.1.5 发布说明（模式切换、README/图标、发布产物） |
| [docs/npm-publish-guide.md](docs/npm-publish-guide.md) | npm 发布步骤与凭证说明 |
| [docs/m2-smoke-record.md](docs/m2-smoke-record.md) | M2 真实 codex 冒烟记录（run_task→verify_task 通过 + 缺陷修复） |
| [docs/m2-rework-record.md](docs/m2-rework-record.md) | M2 codex rework 闭环记录（失败→rework_task→再验收，含物证） |
| [docs/host-integration-record.md](<docs/host-integration-record.md>) | 天枢宿主真实接入实测（DoD #6：2 servers / 10 tools） |
| [docs/issue-1-host-reconnect-record.md](<docs/issue-1-host-reconnect-record.md>) | issue #1 桌面宿主重连验收（天枢 v3.16.1：10 tools + 真实工具调用） |
| [docs/dod7-release-record.md](docs/dod7-release-record.md) | DoD #7：npm 发布 tianshu-mcp@0.1.1 + npx 拉起连通记录 |
| [docs/dod8-session-record.md](docs/dod8-session-record.md) | DoD #8：真实天枢会话实测（技能加载 + 工具面 + 全闭环） |
| [docs/s7-session-recheck.md](docs/s7-session-recheck.md) | S7 二次整改真实会话复测记录 |
| [skills/tianshu-mcp/SKILL.md](skills/tianshu-mcp/SKILL.md) | 教天枢编排本 MCP 的技能（含使用示例） |

> 英文文档见 [README.en.md](README.en.md) 与 [ARCHITECTURE.en.md](ARCHITECTURE.en.md)；完整文档地图与状态快照见 [HANDOFF.md](HANDOFF.md)。

## 里程碑状态

- **M1 — 核心引擎 + stub-agent 全链路** ✅
  - 8 工具、TaskManager 状态机/队列/并发闸/cancel(kill tree)/事件流落盘
  - 验收引擎（git 基线/diff、默认集推导、命令 runner、代码分析、report.md/json）
  - fix-loop 自动返修 + needs_attention；技能自检安装（已在本机真实 `~/.rivet/skills` 验证）
  - stub-agent 三剧本（good/fix-on-first/never）集成测试 + 协议测试
- **M2 — 真实 Codex CLI 冒烟 + rework 闭环** ✅（2026-09-07）
  - 真实 `codex exec` 跑通 `run_task → query_task → verify_task`（[m2-smoke-record.md](docs/m2-smoke-record.md)）
  - 真实 **失败→rework_task→再验收 succeeded** 闭环（[m2-rework-record.md](docs/m2-rework-record.md)，物证 `docs/m2-evidence/`）
  - 修复冒烟暴露的 3 个真实缺陷（Windows npm 垫片 / spawn 日志竞态崩溃 / codex flags 互斥）并各加回归测试
  - Zcode 无头接口（Z1）实测定论：ZCode 桌面无随包 headless CLI → unsupported
- **R1–R8 / S1–S6 — 两轮验收整改** ✅（取消/超时/基线归因/参数语义/热加载/CI 加固）— **72 测试**
- **工程 / CI** ✅
  - GitHub Actions：`CI`（`build-test` ubuntu/windows/macos × Node 20/22/24 + `pack-check`，另加 `visual-browser` 真实浏览器矩阵 ubuntu/windows/macos-15-intel/macos-15 × Node 20/22/24，随 v0.5.1 tag 全绿）与 `Release`（tag 触发）均绿
  - 技能自检安装已在本机真实 `~/.rivet/skills/tianshu-mcp` 验证生效且幂等
  - npm 包名 `tianshu-mcp` 自 v0.1.1 起持续发布（当前 `0.5.3`）
- **天枢宿主真实接入（DoD #6）** ✅（2026-09-07，[host-integration-record.md](docs/host-integration-record.md)）
  - 在真实 `D:\Tianshu` 桌面宿主 `mcp.servers` 配置本地模式 → sidecar `MCP: 2 servers connected, 10 tools`（含本 server 8 工具），spawn 子进程并 stdio 连通
  - 实测暴露并修复技能安装源路径 bug（fileURLToPath，提交 55cf2d0）
- **M3 — TraeWork 调研 + 全套交付** ✅（2026-09-07，**npm 已发布**）
  - T1 定论：本机 TRAE SOLO CN v1.107.1 实测 **无无头可编程 agent 接口**（仅 VS Code 家族 CLI；见 [adapter-matrix.md](docs/adapter-matrix.md)）
  - **npm 已发布**：`tianshu-mcp@0.1.1` 起（`npx -y tianshu-mcp` 拉起 8 工具连通，见 [dod7-release-record.md](docs/dod7-release-record.md)）
- **M4 — TraeWork GUI 驱动接入（CDP）** ✅（2026-09-08，见 [traework-cdp.md](docs/traework-cdp.md)）— **153 测试**
  - 结论更正：无头 CLI 确实不存在，但 `--remote-debugging-port` 可驱动聊天 UI；`traework` 改为 `driver=gui` / `status=ready`
  - 能力：启动/复用实例 → 新建会话 → 绑定项目文件夹（下拉命中优先，未命中走受限 computer-use 原生对话框）→ 可选指定模型 → 任务书回读校验后发送 → 轮询到完成 → 自动验收 → 失败生成修复计划并同会话返修
  - 安全：默认复用用户实例、绝不按进程树强杀、终止前核对命令行；computer-use 仅允许 TraeWork 文件夹对话框
  - 真机验证：`run_task(agentId=traework, model=GLM-5.3, autoVerify=true)` 驱动 TraeWork 创建文件并验收通过
- **M5 — 模式切换 + v0.1.5 发布** ✅（2026-09-08，见 [release-v0.1.5.md](docs/release-v0.1.5.md)）— **167 测试**
  - `run_task` 新增 `mode`（Work/Code/Design），显式参数 + 任务书文本兜底；三种模式**真机端到端验证通过**
  - 实测关键点：三种模式各自维护独立项目绑定 → 顺序改为「新建会话 → 切模式 → 在目标模式绑定项目」
  - README 重写（中英双语 + 技术栈勋章 + 专属 SVG 图标/横幅）
- **M6 — 项目文件夹绑定修复 + v0.1.6** ✅（2026-09-08，见 [release-v0.1.6.md](docs/release-v0.1.6.md)）— **172 测试**
  - 修复三处叠加缺陷：footer 点击未确认弹窗、检测被 PowerShell 冷启动吃光预算、CJK 路径被控制台代码页破坏
  - 新增非 Work 模式绑定回落 Work 重试；真机验证「不在下拉的新项目 + mode=Code」全链路通过
- **M7 — 绑定根因修复 + v0.1.7** ✅（2026-09-08，见 [release-v0.1.7.md](docs/release-v0.1.7.md)）— **178 测试**
  - 真根因：MCP 传规范化路径（`d:/a/b`）被 Windows 原生选择器拒绝 → 改用 `toNativeWindowsPath()`（`D:\a\b`）
  - 配套：写入后 `WM_GETTEXT` 回读校验、hwnd 贯穿传递、遗留对话框清理
- **M8 — 原子写并发缺陷修复 + v0.1.8** ✅（2026-09-08，见 [release-v0.1.8.md](docs/release-v0.1.8.md)）— **181 测试**
  - `writeJsonAtomic` / `writeTextAtomic` 临时文件名并发共用 → 随机后缀 + rename 退避重试（CI windows/Node20 偶发失败真根因）
- **M9 — TraeWork 任务进行中检测 + v0.1.9** ✅（2026-09-09，见 [release-v0.1.9.md](docs/release-v0.1.9.md)）— **196 测试**
  - 停止按钮 / loading task tail 成为权威运行信号，优先于完成标志；稳定轮数只启动空闲计时（默认 10 分钟）才返回 `idle`
  - CDP 断线收敛全部 pending + 单次命令 15s 超时；异常结束（idle/timeout/aborted/cdp_lost）保留实例并写 `agentEndReason` / `keptInstance`
- **M10 — stdio 日志污染修复 + v0.1.10** ✅（2026-09-10，见 [release-v0.1.10.md](docs/release-v0.1.10.md)）— **issue #1**
  - 统一 Logger 所有级别改走 stderr，stdout 只承载 MCP JSON-RPC 消息
  - 新增严格 stdio 冒烟（真实进程字节流校验，6 场景）、Node 24 CI 覆盖与安装包协议门禁
- **M11 — ZCode GUI 统一闭环 + v0.2.0**（2026-09-11，见 [release-v0.2.0.md](docs/release-v0.2.0.md)）— **262 测试**
  - Windows 真机通过开发、受控失败后同会话返修、`AskUserQuestion → continue_task` 三个场景；[验收记录](docs/zcode-windows-smoke.md)
  - macOS 真机未补齐，内置 profile 依计划保持 `research`
- **M12 — Codex 桌面端 GUI 适配 + v0.3.0**（2026-09-12，见 [release-v0.3.0.md](docs/release-v0.3.0.md)）— **340 测试**
  - **破坏性**：`agentId=codex` 由 `codex exec` 无头改为桌面端 GUI 驱动（COM 激活 + CDP）
  - 真机通过：已登记项目全链路、未登记项目自动登记全链路、验收失败→自动生成计划→返修通过闭环
  - 真实业务验收：驱动 Codex 开发「切水果小游戏」并通过验收，无头浏览器实测可玩；[验收记录](docs/codex-windows-smoke.md)
  - macOS 未验证，内置状态 `research`
- **M13 — 技能文档对齐 + 发布自动化修复 + v0.3.1**（2026-09-12，见 [release-v0.3.1.md](docs/release-v0.3.1.md)）
  - 技能自检安装文档（SKILL.md / usage-examples.md）对照 v0.3.0 工具面逐项重写（codex GUI 参数、needs_user 处理、verify/list 用法）
  - Release 正文双语合成、Full Changelog 与 CI 链接修复、Gitee 发行版纳入自动化
- **M14 — Codex 等待用户检测 + 取消真停 GUI + v0.3.2**（2026-09-12，修复 issue #5 / #6，见 [release-v0.3.2.md](docs/release-v0.3.2.md)）
  - issue #5：Codex 停在「等待用户确认」界面不再死锁在 `running`——停止按钮可见且对话哈希 `gui.stallTimeoutMs`（默认 5 分钟）不变 → 转 `needs_user(user_confirmation)`；新增可配置 `gui.selectors.userGate` 界面检测；`continue_task` 扩展支持 codex（`user_confirmation` 重新观察 / `login_required` 重派）
  - issue #6：`cancel_task` 对 GUI agent 经 CDP 尽力点击停止并在 `gui.cancelWaitMs`（默认 15s）内有界等待 GUI 空闲后才落 `cancelled`；派发前检测受管实例运行态，仍运行则以 `instance_busy` 拒绝，杜绝新旧 turn 交叠
- **M15 — ZCode 3.11.2 适配 + 验收引擎 fail-closed + v0.3.3**（2026-09-12，修复 issue #4 / #7，见 [release-v0.3.3.md](<docs/release-v0.3.3.md>)）— **366 测试**
  - issue #4：模型菜单同时兼容 `group-provider` 与 3.11.2 `group-family` 分组，直选平铺模型优先、分组展开兜底；项目绑定改以 composer 复选项为主判据，回读校验触发器文本 + 完整路径，失败最多两轮幂等重试；添加项目前先收起残留菜单并重试
  - issue #7：测试检查退出码 0 但输出零用例时改判失败；git 项目默认要求相对基线产生变更（`requireChanges: false` 可显式关闭），零用例与零变更不再假绿
  - `{PROGRAMFILES}` 占位符统一大写且环境变量展开大小写不敏感
- **M16 — ZCode 项目/模型回读加固 + 初始化共同截止时间恢复 + 无锚点会话发送确认 + v0.3.4**（2026-09-13，修复 issue #8 / #9 / #10，见 [release-v0.3.4.md](<docs/release-v0.3.4.md>)）— **407 测试**
  - issue #8 / #10：项目触发器按「用户覆盖 → 主选择器 → 精确备用」逐级定位，本级歧义即停；绑定以完整规范化路径为唯一依据；添加项目前先收起残留菜单，原生操作超时后先复检副作用，不盲目重放整段导入
  - issue #9：无锚点的环境恢复补发完整原任务 / 上下文 / 已验证引用，环境确认文本不发给模型；发送确认与会话识别共用一次有界观察窗口（默认 60s），优先任务标记、其次唯一新会话差集，无法定位则保留 `session_lost` / `send_unknown` 现场且不自动重发
  - 模型回读解码稳定属性、排除隐藏 / 透明 / 裁剪旧值；初始化引入共同截止时间预算（总计 120s、探测 30s、操作 60s、重试 2 次）；macOS 探测失败 fail-closed，不再伪装成「没有既有面板」
- **M17 — macOS 双驱动打通 + projectPath 安全闸门 + 工程性能 + v0.4.0**（2026-09-13，来自 PR #11）— **443 测试**
  - **macOS 打通**：`codex`（spawn .app + CDP）与 `zcode`（进程标题改写适配 + macOS 窗口面板驱动）GUI 基本闭环均真机验证通过（发现 → 绑定 → 发送 → 运行证据 → 验收 PASS → `succeeded`）；取消/返修/continue_task/新建项目矩阵补齐前 macOS 保持 `research`
  - **codex-cli 无头路径**：macOS 经 `driver=spawn` 用户 profile 走 `codex exec`（⚠️ ≤0.130.0 签名证书已被吊销，需 ≥0.154.0）——见「macOS 无头路径：codex-cli」
  - **projectPath 安全闸门**：realpath 归一 + 主目录/系统根目录拒绝 + 脏仓共处警示——见「路径安全闸门」
  - **修复**：`get_profiles` 漏列用户自定义 profile；zcode macOS `needsPermission` 误报；`normalizeProjectPath` 符号链接歧义；CDP 轮询在 renderer 替换/瞬时无响应时重连
  - **工程**：`execFileSync`/`spawnSync` 全量异步化（消除 Windows 轮询期事件循环冻结）；验收命令有界并行（`verifyConcurrency`）；测试套件 267s → 51s
- **M18 — 技能文档对齐 v0.4.0 工具面 + 贡献者名录 + v0.4.1**（2026-09-13）— **443 测试**
  - `skills/tianshu-mcp/` 逐项补齐 v0.3.3 → v0.4.0 的工具面变化：projectPath 安全闸门、硬失败错误码速查表、`setup_recovery` 等待类型、codex-cli 无头路径、`ready`/`research` 状态语义、验收默认并行 2 与 `requireChanges` 门禁；usage-examples 新增错误码表、meta 字段全表、项目级验收配置模板与 `codex-cli` 示例
  - 双语 README 新增贡献者名录（头像 + 名字，按首次参与顺序）
  - 本版本**无代码行为变更**，升级无需迁移
- **M19 — 可选视觉验收模块 + v0.5.0**（2026-09-14）— **486 测试**
  - **页面截图对比**：三种互斥页面来源（已有服务/命令启动/临时静态托管）、三种截图模式、声明式交互步骤、稳定化采样与显式屏蔽、pixelmatch 抗锯齿排除与连通区域标注；尺寸不一致直接失败
  - **静态图片规格**：编码格式/扩展名一致性、完整解码、EXIF 方向归一宽高、宽高比/字节数/DPI/真实透明像素；不支持格式明确报告
  - **基准两阶段与冻结**：候选准备 → 用户批准写入；缺基准不得判通过；自动返修禁止批准；任务动工前冻结配置与基准摘要并每轮核对
  - **MCP/CLI**：新增 `prepare_visual_baseline` / `approve_visual_baseline` 与 `tianshu-mcp visual` 子命令族；CLI 在 stdio 连接前分流
  - **报告与恢复**：`VerifyReport` 新增可选 `visual` 与离线 HTML（状态过滤、透明叠加、区域定位）；视觉阻塞进 `needs_attention`，`rework_task` 先重新验收、仅真实缺陷才消耗返修预算
  - **门禁**：CI 新增真实浏览器四系统三 Node 矩阵与生产包独立消费者验收；release 要求目标提交存在成功 CI，缺少 Gitee 凭据时阻塞不冒充成功
- **M20 — 技能/验证文档对齐 + 平台证据归档 + v0.5.1**（2026-09-14）— **486 测试**
  - 技能文档逐项对齐代码实况：11 工具表（补能力/审批列）、视觉验收独立成节、错误码补 `setup_recovery`、修正 agent 状态语义与 `get_task_report`/`repair-plan` 的文档偏差
  - 归档视觉验收平台证据：Windows 10 本机完整功能矩阵 **9/9**（`npm run evidence:visual:windows`）、macOS 15 真机 Intel x64 与 Apple Silicon arm64 各 10 文件 51 用例
  - 修复 `package-lock.json` 根包版本滞后（v0.5.0 时为 `0.4.1`）
  - 本版本**无运行时行为变更**，升级无需迁移
- **M21 — ZCode 无项目派发（issue #12）+ v0.5.2**（2026-09-14）— **525 测试**
  - `run_task.projectPath` 变可选：省略时 ZCode 在 `default`（无项目）工作区承接任务，不登记/导入项目、不采集 Git 基线、不冻结项目快照、不进入项目锁与项目验收；终态以 `not_applicable: no_project` 结构化标注（详见 [v0.5.2 发布说明](<docs/release-v0.5.2.md>)）
  - 新增 ZCode 专用可选参数 `allowCreateProject`：`false` 时目标目录未登记即在任何导入副作用之前停止派发，返回 `project_not_registered`
  - 统一 ZCode 项目触发器就绪判据（未挂载 / 不可见或被裁剪 / 不唯一 / 禁用 / 被遮挡 / 就绪六态），新增 `gui.projectTriggerTimeoutMs`（默认 15s），修正错误信息失实
  - 真机发现并修复两个缺陷：`projectPath` 未在 MCP schema 层放开、缺少「不在项目中工作」切换；补齐 Windows 10 真机验收证据
- **M22 — ZCode 真机回访修复（issue #12 第二轮）+ v0.5.3**（2026-09-15）— **532 测试**
  - 修复 Windows 上 ZCode / Codex 桌面实例**跨 server 退出驻留**失效：三处 GUI 实例统一走 `guiInstanceSpawnOptions()`（无条件 `detached` + `unref`），此前 Windows 分支导致 MCP server 一退出 GUI 就被连坐杀掉
  - 修复顶部「新建任务」点击返回成功却不切页、随后静默空等 30 秒：改以「项目触发器已挂载」验证草稿真的建立，失败回退侧栏 `task-new-button`，两者都失败才 `setup_failed` fail-closed
  - 修复窗口被遮挡时发送失败归因误导：识别 Chromium 节流（`visibilityState=hidden`）并报「窗口不在前台」及置于前台的操作指引
  - 本版本为 **PATCH**，既有调用方签名与报告格式**保持向后兼容**（详见 [v0.5.3 发布说明](<docs/release-v0.5.3.md>)）

## Agent 适配现状

| agentId | driver / adapter | status | 说明 |
|---|---|---|---|
| `codex` | `gui` / `codex-gui` | **ready**（macOS 为 `research`） | Codex 桌面端 GUI（Windows：MSIX COM 激活 + CDP；macOS：spawn .app + CDP）；支持 `model`/`reasoningLevel`/`planDoc`/`designSystem`；等待用户确认、取消与重派护栏均已真机验证（v0.3.2）；Windows 真机已验证；macOS 基本闭环已真机验证（v0.4.0），取消/返修矩阵补齐前保持 `research` |
| `zcode` | `gui` / `zcode-gui` | **research** | CDP GUI adapter 已实现且 Windows 真机闭环通过；已适配 ZCode 3.11.2 模型菜单与项目绑定（v0.3.3），并加固项目/模型回读与初始化恢复（v0.3.4）；支持无项目派发与 `allowCreateProject`（v0.5.2，issue #12），v0.5.3 修复实例跨 server 驻留、新建任务切页与发送失败归因；macOS 基本闭环已真机验证（2026-09-13，v0.4.0），取消/返修/新建项目矩阵补齐前保持 `research` |
| `traework` | `gui` / `traework-gui` | **ready** | CDP 驱动 TRAE SOLO CN 桌面 UI；三种面板模式真机验证通过 |
| `stub` | `spawn` | 仅测试 | `test/stub-agent/stub-agent.mjs` 三剧本（good/fix-on-first/never） |

> 新增 agent 通常只需加一个 profile，详见 [docs/agent-profiles.md](docs/agent-profiles.md) 与 [CONTRIBUTING.md](CONTRIBUTING.md)。

## macOS 无头路径：codex-cli（用户 profile）

内置 `codex` 走桌面端 GUI 驱动；macOS 通道已打通（spawn .app + CDP，基本闭环已真机验证，见「Agent 适配现状」），取消/返修矩阵补齐前保持 `research`。若不想依赖 GUI 自动化，**codex CLI 无头模式在 macOS 全程可用**——无需改 server 代码，在数据目录加一个 `driver=spawn` 的用户 profile 即可（即 v0.3.0 前内置 codex 的 M2 定稿参数）。

前置条件：

- codex CLI（`npm i -g @openai/codex`）。⚠️ **请保持最新**：≤0.130.0 的签名证书已被吊销，macOS Gatekeeper 在执行时直接 SIGKILL（`Killed: 9`）；≥0.154.0 实测正常。
- 已 `codex login`（复用 `~/.codex` 登录态）。

`~/.tianshu-mcp/agent-profiles.json`：

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

用法与内置 agent 一致：

```text
run_task(projectPath=/path/to/项目, agentId=codex-cli, task="任务书", autoVerify=true, autoFixRounds=2)
```

行为与限制：

- `get_profiles` 会列出 `codex-cli` 并探测 PATH 上的 `codex` 可执行（v0.4.0 起；此前用户自定义 profile 可用但不显示）。
- `model` 参数对 spawn agent 不生效——CLI 使用 `~/.codex/config.toml` 的默认模型；要锁模型可在 `argsTemplate` 追加 `"-m", "<模型名>"`。
- 写入被 `workspace-write` 沙箱限制在项目目录内；POSIX 下取消/超时自动对进程组 SIGTERM→SIGKILL（`killTree` 值在非 Windows 平台被忽略）。
- 已实测：2026-09-13 macOS arm64 真机闭环（`run_task` → `codex exec` → 自动验收 PASS → `succeeded`）。

## 推荐用法（给天枢的提示语）

> "在项目 D:\xxx 用 codex 实现『任务』。先跑 run_task(autoVerify:true, autoFixRounds:2)，完成后用 query_task 看结果；若报告显示 needs_attention，把 get_task_report 的失败项摘要作为 feedback 调 rework_task 再验一轮；全部通过后向我汇报 changedFiles 与 diffstat。"

> "在项目 D:\xxx 用 traework、mode=Code 实现『任务』；它会先切到 Code 模式再绑定项目，然后发任务、自动验收，失败自动生成修复计划并返修。"

## 开源协作

| 文档 | 内容 |
|---|---|
| [HANDOFF.md](HANDOFF.md) | 项目交接文档：当前状态快照、架构导览、硬性红线、已知限制、接手建议 |
| [CHANGELOG.md](<CHANGELOG.md>) | 版本变更日志（v0.1.0 → v0.5.3） |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发环境、工程规范、提交与发布流程、如何新增 agent |
| [SECURITY.md](SECURITY.md) | 安全模型（凭证零管理/命令白名单/进程与桌面自动化边界）与私密报告渠道 |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | 贡献者行为准则 |
| [LICENSE](LICENSE) | Apache License 2.0（详细说明见下节） |

- **主仓库**：<https://github.com/lanlan0811/tianshu-mcp>（GitHub）
- **镜像仓库**：<https://gitee.com/lan0811/tianshu-mcp>（Gitee）
- **问题反馈**：Bug / 功能请求走仓库 Issue 模板；安全漏洞请按 [SECURITY.md](SECURITY.md) 私密报告，**不要**开公开 Issue。

### 贡献者

感谢以下通过 Issue 与 PR 为本项目做出贡献的社区成员（按首次参与顺序排列）：

<table>
  <tr>
    <td align="center"><a href="https://github.com/liuchsong"><img src="https://github.com/liuchsong.png" width="72" height="72" alt="liuchsong" /><br /><sub>liuchsong</sub></a></td>
    <td align="center"><a href="https://github.com/a13612745638"><img src="https://github.com/a13612745638.png" width="72" height="72" alt="a13612745638" /><br /><sub>a13612745638</sub></a></td>
    <td align="center"><a href="https://github.com/king195547"><img src="https://github.com/king195547.png" width="72" height="72" alt="king195547" /><br /><sub>king195547</sub></a></td>
  </tr>
  <tr>
    <td align="center"><a href="https://github.com/zhaoxc857"><img src="https://github.com/zhaoxc857.png" width="72" height="72" alt="zhaoxc857" /><br /><sub>zhaoxc857</sub></a></td>
    <td align="center"><a href="https://github.com/jian-in"><img src="https://github.com/jian-in.png" width="72" height="72" alt="jian-in" /><br /><sub>jian-in</sub></a></td>
    <td align="center"><a href="https://github.com/huiliyi37"><img src="https://github.com/huiliyi37.png" width="72" height="72" alt="huiliyi37" /><br /><sub>huiliyi37</sub></a></td>
  </tr>
</table>

> 英文版对应文档见 [README.en.md](README.en.md)。

## 许可

本项目以 **Apache License 2.0** 发布，完整法律文本见 [LICENSE](LICENSE)。版权归 tianshu-mcp 贡献者所有（Copyright 2026 tianshu-mcp contributors）。

### 授予你的权利

- **商业使用**：可在商业产品与服务中使用；
- **修改**：可自由修改源码；
- **分发**：可再分发原始或修改后的版本；
- **私用**：可在组织内部私有使用；
- **专利使用**：贡献者授予你实施其贡献所涉专利的许可（受下述终止条款约束）。

### 你必须履行的义务

1. **保留声明**：分发时须随附 LICENSE 全文，并保留其中的版权、许可与免责声明；
2. **标注修改**：若修改了文件，须在修改的文件中附带显著的「已修改」声明；
3. **保留 NOTICE**：若原作品含 NOTICE 文件，分发时须保留其内容（本项目当前**无** NOTICE 文件）；
4. **不得附加限制**：不得对本许可授予的权利附加额外限制。

### 明确不授予 / 授权终止

- **商标**：本许可**不授予**任何商标、商号或服务标记的使用权；
- **专利终止**：若你对本项目或其贡献者发起专利诉讼（包括交叉诉讼与反诉），本许可授予你的专利授权**自动终止**。

### 免责声明

软件按 **「现状」** 提供，不附带任何明示或暗示的担保，包括但不限于适销性、特定用途适用性和非侵权担保。在任何情况下，作者或版权持有人均不对因软件、软件的使用或其他交易而产生的任何索赔、损害或其他责任负责（无论是在合同诉讼、侵权诉讼还是其他诉讼中）。

### 第三方依赖许可

运行时依赖均为 **MIT** 许可，与 Apache-2.0 兼容：

| 依赖 | 许可 | 用途 |
|---|---|---|
| [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/sdk) | MIT | MCP 协议实现 |
| [`zod`](https://github.com/colinhacks/zod) | MIT | 外部输入校验 |
| [`cross-spawn`](https://github.com/moxystudio/node-cross-spawn) | MIT | 跨平台子进程 |

开发依赖（TypeScript、ESLint、Prettier、Vitest、Vite、tsx 等）各自遵循其开源许可，且不随 npm 发布产物分发。

### 与安全边界的关系

本 MCP **不保存、不读取、不转发**任何 AI-Agent 的 API key 或登录态（详见 [SECURITY.md](SECURITY.md)）。许可条款不改变这一设计边界。
