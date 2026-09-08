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

天枢的角色是总指挥；本 MCP server 是**调度 + 执行面 + 客观验收仪**；外部 AI-Agent（Codex CLI、TraeWork GUI）是执行开发的"工人"。

- **8 个 MCP 工具**：`run_task / query_task / list_tasks / get_task_report / cancel_task / verify_task / rework_task / get_profiles`。
- **异步契约**：`run_task` 秒回 `taskId`，长任务用 `query_task` 轮询（长任务不卡 `tools/call`）。
- **客观验收**：自动命令检查（typecheck/lint/test/build，缺则跳过 + 技术栈推导）+ 程序化代码分析（变更清单/diffstat/TODO·debugger·密钥形态等可疑标记），全部相对 **git 基线**，不自动 commit/stash。
- **失败返修闭环**：自动返修（`autoFixRounds`）+ 手动 `rework_task`；验收失败时自动生成修复计划文件并回填给 agent；轮次用尽 → `needs_attention` 等天枢裁决。
- **两种执行面**：`driver: "spawn"` 走外部 CLI 子进程（Codex）；`driver: "gui"` 走桌面 UI 自动化（TraeWork 经 CDP 驱动，可选 `model` 指定模型、`mode` 指定 Work/Code/Design 面板模式）。
- **调度纪律**：每项目串行队列 + 全局并发上限（默认 2，可配）。
- **不碰密钥**：各 agent 用自己的登录态；本 server 不保存/转发任何 API key。
- **可扩展**：新 agent = 一个 profile（数据）+（如需）一个 adapter 文件，零改编排核心。

## 快速开始

```bash
npm install
npm run build        # → dist/
npm test             # 181 项测试：单元 + stub-agent 三剧本集成 + 协议 + TraeWork 假 CDP + 取消/超时/基线/参数/配置回归
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
| [skills/tianshu-mcp/](skills/tianshu-mcp/SKILL.md) | 教天枢编排本 MCP 的技能（含使用示例） |

> 英文文档见 [README.en.md](README.en.md)。

## 里程碑状态

- **M1 — 核心引擎 + stub-agent 全链路** ✅
  - 8 工具、TaskManager 状态机/队列/并发闸/cancel(kill tree)/事件流落盘
  - 验收引擎（git 基线/diff、默认集推导、命令 runner、代码分析、report.md/json）
  - fix-loop 自动返修 + needs_attention；技能自检安装（已在本机真实 `~/.rivet/skills` 验证）
  - stub-agent 三剧本（good/fix-on-first/never）集成测试 + 协议测试，**72/72 绿**（含 R1–R5/S1–S6 取消/超时/基线/参数/配置回归）
- **M2 — 真实 Codex CLI 冒烟 + rework 闭环** ✅（2026-09-07）
  - 真实 `codex exec` 跑通 `run_task → query_task → verify_task`（[m2-smoke-record.md](docs/m2-smoke-record.md)）
  - 真实 **失败→rework_task→再验收 succeeded** 闭环（[m2-rework-record.md](docs/m2-rework-record.md)，物证 `docs/m2-evidence/`）
  - 修复冒烟暴露的 3 个真实缺陷（Windows npm 垫片 / spawn 日志竞态崩溃 / codex flags 互斥）并各加回归测试
  - Zcode 无头接口（Z1）实测定论：ZCode 桌面无随包 headless CLI → unsupported
- **工程/CI** ✅
  - GitHub Actions：`CI`（ubuntu/windows/macos × Node 20/22 + tarball 检查，**7/7 全绿**）与 `Release`（tag 触发）均绿
  - 技能自检安装已在本机真实 `~/.rivet/skills/tianshu-mcp` 验证生效且幂等
  - npm 包名 `tianshu-mcp` 可用
- **天枢宿主真实接入（DoD #6）** ✅（2026-09-07，[host-integration-record.md](docs/host-integration-record.md)）
  - 在真实 `D:\Tianshu` 桌面宿主 `mcp.servers` 配置本地模式 → sidecar `MCP: 2 servers connected, 10 tools`（含本 server 8 工具），spawn 子进程并 stdio 连通
  - 实测暴露并修复技能安装源路径 bug（fileURLToPath，提交 55cf2d0）
- **M3 — TraeWork 调研 + 全套交付** ✅（2026-09-07，**npm 已发布**）
  - T1 定论：本机 TRAE SOLO CN v1.107.1 实测 **无无头可编程 agent 接口**（仅 VS Code 家族 CLI；见 [adapter-matrix.md](docs/adapter-matrix.md)）
  - **npm 已发布**：`tianshu-mcp@0.1.1` 起（`npx -y tianshu-mcp` 拉起 8 工具连通，见 [dod7-release-record.md](docs/dod7-release-record.md)）
- **M4 — TraeWork GUI 驱动接入（CDP）** ✅（2026-09-08，见 [traework-cdp.md](docs/traework-cdp.md)）
  - 结论更正：无头 CLI 确实不存在，但 `--remote-debugging-port` 可驱动聊天 UI；`traework` 改为 `driver=gui` / `status=ready`
  - 能力：启动/复用实例 → 新建会话 → 绑定项目文件夹（下拉命中优先，未命中走受限 computer-use 原生对话框）→ 可选指定模型 → 任务书回读校验后发送 → 轮询到完成 → 自动验收 → 失败生成修复计划并同会话返修
  - 安全：默认复用用户实例、绝不按进程树强杀、终止前核对命令行；computer-use 仅允许 TraeWork 文件夹对话框
  - 真机验证：`run_task(agentId=traework, model=GLM-5.3, autoVerify=true)` 驱动 TraeWork 创建文件并验收通过
- **M5 — 模式切换 + v0.1.5 发布** ✅（2026-09-08，见 [release-v0.1.5.md](docs/release-v0.1.5.md)）
  - `run_task` 新增 `mode`（Work/Code/Design），显式参数 + 任务书文本兜底；三种模式**真机端到端验证通过**
  - 实测关键点：三种模式各自维护独立项目绑定 → 顺序改为「新建会话 → 切模式 → 在目标模式绑定项目」
  - README 重写（中英双语 + 技术栈勋章 + 专属 SVG 图标/横幅）；测试 153 → **167**

- **M6 — 项目文件夹绑定修复 + v0.1.6** ✅（2026-09-08，见 [release-v0.1.6.md](docs/release-v0.1.6.md)）
  - 修复三处叠加缺陷：footer 点击未确认弹窗、检测被 PowerShell 冷启动吃光预算、CJK 路径被控制台代码页破坏
  - 新增非 Work 模式绑定回落 Work 重试；真机验证「不在下拉的新项目 + mode=Code」全链路通过；测试 167 → **172**

## 推荐用法（给天枢的提示语）

> "在项目 D:\xxx 用 codex 实现『任务』。先跑 run_task(autoVerify:true, autoFixRounds:2)，完成后用 query_task 看结果；若报告显示 needs_attention，把 get_task_report 的失败项摘要作为 feedback 调 rework_task 再验一轮；全部通过后向我汇报 changedFiles 与 diffstat。"

> "在项目 D:\xxx 用 traework、mode=Code 实现『任务』；它会先切到 Code 模式再绑定项目，然后发任务、自动验收，失败自动生成修复计划并返修。"

## 开源协作

| 文档 | 内容 |
|---|---|
| [HANDOFF.md](HANDOFF.md) | 项目交接文档：当前状态快照、架构导览、硬性红线、已知限制、接手建议 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更日志（v0.1.0 → v0.1.5） |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发环境、工程规范、提交与发布流程、如何新增 agent |
| [SECURITY.md](SECURITY.md) | 安全模型（凭证零管理/命令白名单/进程与桌面自动化边界）与私密报告渠道 |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | 贡献者行为准则 |
| [LICENSE](LICENSE) | Apache License 2.0 |

> 英文版对应文档见 [README.en.md](README.en.md)。

## 许可

[Apache-2.0](LICENSE)
