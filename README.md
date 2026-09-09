<div align="center">

<img src="./assets/tianshu-mcp-banner.svg" alt="tianshu-mcp" width="100%">

<br/>

<img src="./assets/tianshu-mcp-icon.svg" alt="tianshu-mcp 图标" width="132" height="132">

# tianshu-mcp

**天枢 × AI-Agent 编排 MCP server**

由天枢（Tianshu）当作标准 MCP server 接入，调度外部 AI-Agent（Codex CLI；TraeWork/TRAE SOLO CN 经 CDP 驱动桌面 UI）完成 **项目开发 → 验收 → 失败返修 → 再验收** 的闭环（架构可横向扩展）。

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

天枢的角色是总指挥；本 MCP server 是**调度层 + 执行面 + 客观验收仪**；外部 AI-Agent（Codex CLI、TraeWork GUI）是执行开发的「工人」。

- **8 个 MCP 工具**：`run_task / query_task / list_tasks / get_task_report / cancel_task / verify_task / rework_task / get_profiles`。
- **异步契约**：`run_task` 秒回 `taskId`，长任务用 `query_task` 轮询（长任务不卡 `tools/call`）。
- **客观验收**：自动命令检查（typecheck/lint/test/build，缺则跳过 + 技术栈推导）+ 程序化代码分析（变更清单/diffstat/TODO·debugger·密钥形态等可疑标记），全部相对 **git 基线**，不自动 commit/stash。
- **失败返修闭环**：自动返修（`autoFixRounds`）+ 手动 `rework_task`；验收失败时自动生成修复计划文件并回填给 agent；轮次用尽 → `needs_attention` 等天枢裁决。
- **两种执行面**：`driver: "spawn"` 走外部 CLI 子进程（Codex）；`driver: "gui"` 走桌面 UI 自动化（TraeWork 经 CDP 驱动，可选 `model` 指定模型、`mode` 指定 Work/Code/Design 面板模式）。
- **调度纪律**：每项目串行队列 + 全局并发上限（默认 2，可配）。
- **不碰密钥**：各 agent 用自己的登录态；本 server 不保存/转发任何 API key。
- **可扩展**：新 agent = 一个 profile（数据）+（如需）一个 adapter 文件，零改编排核心。

## 快速开始

### 前置条件

| 项 | 要求 |
|---|---|
| Node.js | ≥ 20（CI 覆盖 20 / 22） |
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
npm test             # 196 项测试：30 个文件（单元 19 + 集成 10 + 协议 1）
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

> - 服务器 ID 即工具前缀：填 `tianshu-mcp` 后工具名为 `mcp__tianshu-mcp__run_task` 等 8 个。
> - 参数按空格分隔填写，**不要加引号**；本地开发模式请把 `<仓库绝对路径>` 换成真实绝对路径（如 `D:/Trae项目/tianshu-mcp/dist/index.js`）。
> - 界面未提供环境变量输入框；如需自定义数据目录，改用下面的 `config.json` 方式设置 `TIANSHU_MCP_HOME`。
> - 添加后连接成功即完成；新开会话即可看到 8 个工具。

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

新开会话后，工具面出现 `mcp__tianshu-mcp__run_task` 等 8 个工具。用 stub 预演（不碰真实登录态）→ 切 codex 跑真实任务：

```text
run_task(projectPath=D:/xxx/my-app, task=「…任务书…」, agentId=codex, autoVerify=true, autoFixRounds=2)
  → taskId → query_task(taskId) 轮询 → succeeded / failed / needs_attention → get_task_report 读报告
```

驱动 TraeWork 时可用 `model` 与 `mode`：

```text
run_task(projectPath=D:/xxx/my-app, agentId=traework, task=「切换到 Code 模式，实现登录接口」,
         model=GLM-5.3, mode=Code, autoVerify=true, autoFixRounds=2)
```

> `mode` 支持 `Work` / `Code` / `Design`；不传时从任务书文本识别（如「切换到 Code 模式」），识别不到则保持 `Work`。
> TraeWork 的三种模式**各自维护独立的项目绑定**，因此实现顺序为「新建会话 → 切到目标模式 → 在目标模式内绑定项目」。

## 工具面（8 个）

| 工具 | 能力 / 审批 | 作用 |
|---|---|---|
| `run_task` | write + 审批 | 派活（可带自动验收/自动返修），异步返回 `taskId` |
| `query_task` | read | 轮询状态 / 进度 / 日志尾 |
| `list_tasks` | read | 历史任务过滤列表 |
| `get_task_report` | read | 某轮验收报告全文（`report.md`） |
| `cancel_task` | write + 审批 | 取消运行中任务（kill 进程树） |
| `verify_task` | read | 对任务/项目路径做一次验收（不改源码） |
| `rework_task` | write + 审批 | 手动返修（把失败报告喂回同一 agent） |
| `get_profiles` | read | 查看 agent 适配与可执行探测结果 |

> 返回统一为「人类可读文本 + `---tianshu-mcp-meta---` JSON 块」，便于宿主正则抽取。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/tianshu-integration.md](docs/tianshu-integration.md) | 天枢 config.json 两种接入模式、UI/API 操作、冒烟步骤、FAQ |
| [docs/agent-profiles.md](docs/agent-profiles.md) | agent profiles 字段说明 + 真实机器样例（codex M2 定稿） |
| [docs/adapter-matrix.md](docs/adapter-matrix.md) | 各 Agent 能力调研矩阵（Codex/Zcode/TraeWork/扩展位） |
| [docs/traework-cdp.md](docs/traework-cdp.md) | TraeWork GUI 驱动（CDP）：原理、配置、模式切换、选择器、安全红线、踩坑记录、验证记录 |
| [docs/acceptance-config.md](docs/acceptance-config.md) | 项目级 `.tianshu-mcp/acceptance.json` 验收配置规范 |
| [docs/release-v0.1.9.md](docs/release-v0.1.9.md) | v0.1.9 发布说明（TraeWork 任务进行中检测与实例保留） |
| [docs/release-v0.1.8.md](docs/release-v0.1.8.md) | v0.1.8 发布说明（原子写并发缺陷修复） |
| [docs/release-v0.1.7.md](docs/release-v0.1.7.md) | v0.1.7 发布说明（绑定根因：原生路径） |
| [docs/release-v0.1.6.md](docs/release-v0.1.6.md) | v0.1.6 发布说明（项目文件夹绑定修复） |
| [docs/release-v0.1.5.md](docs/release-v0.1.5.md) | v0.1.5 发布说明（模式切换、README/图标、发布产物） |
| [docs/npm-publish-guide.md](docs/npm-publish-guide.md) | npm 发布步骤与凭证说明 |
| [docs/m2-smoke-record.md](docs/m2-smoke-record.md) | M2 真实 codex 冒烟记录（run_task→verify_task 通过 + 缺陷修复） |
| [docs/m2-rework-record.md](docs/m2-rework-record.md) | M2 codex rework 闭环记录（失败→rework_task→再验收，含物证） |
| [docs/host-integration-record.md](docs/host-integration-record.md) | 天枢宿主真实接入实测（DoD #6：2 servers / 10 tools） |
| [docs/dod7-release-record.md](docs/dod7-release-record.md) | DoD #7：npm 发布 tianshu-mcp@0.1.1 + npx 拉起连通记录 |
| [docs/dod8-session-record.md](docs/dod8-session-record.md) | DoD #8：真实天枢会话实测（技能加载 + 工具面 + 全闭环） |
| [docs/s7-session-recheck.md](docs/s7-session-recheck.md) | S7 二次整改真实会话复测记录 |
| [skills/tianshu-mcp/SKILL.md](skills/tianshu-mcp/SKILL.md) | 教天枢编排本 MCP 的技能（含使用示例） |

> 英文文档见 [README.en.md](README.en.md)；完整文档地图与状态快照见 [HANDOFF.md](HANDOFF.md)。

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
  - GitHub Actions：`CI`（ubuntu/windows/macos × Node 20/22 + tarball 检查，**7/7 全绿**）与 `Release`（tag 触发）均绿
  - 技能自检安装已在本机真实 `~/.rivet/skills/tianshu-mcp` 验证生效且幂等
  - npm 包名 `tianshu-mcp` 可用
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

## Agent 适配现状

| agentId | driver | status | 说明 |
|---|---|---|---|
| `codex` | `spawn` | **ready** | 复用 `~/.codex` 登录态；`codex exec` 无头执行；M2 真实冒烟通过 |
| `zcode` | `spawn` | **unsupported** | ZCode 桌面无随包 headless CLI（Z1 定论） |
| `traework` | **`gui`** | **ready** | CDP 驱动 TRAE SOLO CN 桌面 UI；三种面板模式真机验证通过 |
| `stub` | `spawn` | 仅测试 | `test/stub-agent/stub-agent.mjs` 三剧本（good/fix-on-first/never） |

> 新增 agent 通常只需加一个 profile，详见 [docs/agent-profiles.md](docs/agent-profiles.md) 与 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 推荐用法（给天枢的提示语）

> "在项目 D:\xxx 用 codex 实现『任务』。先跑 run_task(autoVerify:true, autoFixRounds:2)，完成后用 query_task 看结果；若报告显示 needs_attention，把 get_task_report 的失败项摘要作为 feedback 调 rework_task 再验一轮；全部通过后向我汇报 changedFiles 与 diffstat。"

> "在项目 D:\xxx 用 traework、mode=Code 实现『任务』；它会先切到 Code 模式再绑定项目，然后发任务、自动验收，失败自动生成修复计划并返修。"

## 开源协作

| 文档 | 内容 |
|---|---|
| [HANDOFF.md](HANDOFF.md) | 项目交接文档：当前状态快照、架构导览、硬性红线、已知限制、接手建议 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更日志（v0.1.0 → v0.1.9） |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发环境、工程规范、提交与发布流程、如何新增 agent |
| [SECURITY.md](SECURITY.md) | 安全模型（凭证零管理/命令白名单/进程与桌面自动化边界）与私密报告渠道 |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | 贡献者行为准则 |
| [LICENSE](LICENSE) | Apache License 2.0（详细说明见下节） |

- **主仓库**：<https://github.com/lanlan0811/tianshu-mcp>（GitHub）
- **镜像仓库**：<https://gitee.com/lan0811/tianshu-mcp>（Gitee）
- **问题反馈**：Bug / 功能请求走仓库 Issue 模板；安全漏洞请按 [SECURITY.md](SECURITY.md) 私密报告，**不要**开公开 Issue。

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
