# HANDOFF.md — 项目交接说明

> 交接快照：**2026-09-08**（v0.1.5 已发布）。本文写给**接手本仓库的人**：先读「交接快照」了解当前状态，再按「从零搭环境」上手。
> 工作区规则见 `AGENTS.md`（gitignore 中，仅本地），安装/用法见 `README.md`，本文不重复，只做导览与状态记录。

---

## 1. 这个项目是什么

`tianshu-mcp` 是一个**被天枢（Tianshu）当作标准 MCP server 接入的编排层**：天枢是总指挥，本 server 负责**调度 + 执行面 + 客观验收仪**，驱动外部 AI-Agent 完成闭环：

```text
项目开发 → 验收 → 失败返修 → 再验收
```

- **天枢官方仓库**：<https://github.com/huiliyi37/Tianshu-harness>（基于 harness 工程的终端编程智能体运行时，TUI × GUI；Apache-2.0）
- **本仓库**：`github.com/lanlan0811/tianshu-mcp`（主）｜`gitee.com/lan0811/tianshu-mcp`（镜像）
- **npm**：`tianshu-mcp`（当前 `0.1.5`）

### 为什么是这样设计的（硬约束）

本项目的形态由三个**实测硬约束**决定，改架构前必读：

1. **天枢的 MCP 工具只回文本**：MCP 响应里 `content[]` 的 `text` 项被拼成字符串，`isError` 透传。因此所有结果统一为「人类可读文本 + `---tianshu-mcp-meta---` JSON 块」，不依赖 resources/prompts。
2. **天枢按次同步调用 `tools/call`**：长任务必须异步化 → `run_task` 秒回 `taskId`，用 `query_task` 轮询。
3. **TraeWork 的 agent 请求在 TTNet 层 TDE 加密**，无法在客户端外构造 → 唯一可行路径是 CDP 驱动其桌面 UI，从 DOM 提取结果。

---

## 2. 交接快照

| 项 | 状态 |
|---|---|
| 分支 | `master`（**只在此分支提交**，不建其他分支） |
| 最新提交 | `1732afe docs: 中英 README 与接入教程补充天枢官方仓库链接` |
| 版本 / 许可证 | `0.1.5` / Apache-2.0 |
| 标签 | `v0.1.0` … `v0.1.5`（v0.1.2+ 均已推双仓） |
| 工作树 | 干净；`github/master` 与 `gitee/master` 均同步 |
| 测试 | **167/167 通过**（25 个测试文件：单元 15 + 集成 9 + 协议 1） |
| 门禁 | lint 0 warning、typecheck clean、build 成功、`npm pack` 内容校验通过 |
| CI | `CI` workflow：ubuntu/windows/macos × Node 20/22 + tarball 检查 = **7/7 全绿** |
| npm | `tianshu-mcp@0.1.5` 已发布，`dist-tags.latest = 0.1.5` |
| Release | GitHub Release `v0.1.5` 已发布（附 tarball）；Gitee Release `v0.1.5` 已创建（附 tarball） |

### Agent 适配现状

| agentId | driver | status | 说明 |
|---|---|---|---|
| `codex` | `spawn` | **ready** | 复用 `~/.codex` 登录态；`codex exec` 无头执行；M2 真实冒烟通过 |
| `zcode` | `spawn` | **unsupported** | ZCode 桌面无随包 headless CLI（Z1 定论） |
| `traework` | **`gui`** | **ready** | CDP 驱动 TRAE SOLO CN 桌面 UI；三种面板模式真机验证通过 |
| `stub` | `spawn` | 仅测试 | `test/stub-agent/stub-agent.mjs` 三剧本（good/fix-on-first/never） |

---

## 3. 里程碑记录（简版，详见 `CHANGELOG.md`）

- **M1** 核心引擎 + stub-agent 全链路（8 工具、状态机、队列、验收引擎、fix-loop）— 53 测试
- **M2** 真实 Codex CLI 冒烟 + rework 闭环；修复 3 个真实缺陷
- **M3** TraeWork 调研 → 定论「无无头 CLI」；npm 首发；天枢宿主真实接入（DoD #6）
- **R1–R8 / S1–S6** 两轮验收整改（取消/超时/基线归因/参数语义/热加载/CI 加固）— 72 测试
- **M4** TraeWork GUI 驱动接入（CDP）——`driver=gui` 落地，真机 e2e 通过 — 153 测试
- **M5** 面板模式切换（Work/Code/Design）+ v0.1.5 发布 + README 重写/SVG 资产 — **167 测试**

### 实现期修复的两个既有缺陷（重要）

1. **rework 反馈竞态**（`TaskManager`，负载下偶发）
   - 现象：`rework_task(feedback)` 后返修轮拿不到 feedback，卡在 `failed`。
   - 根因：终态快照先落盘，调用方立即写入 `reworkFeedback`；上一轮收尾的 `delete meta.reworkFeedback` 把它抹掉。
   - 修复：改为 `startTask` 启动时**原子取走并清空**。回归：`test/integration/rework-feedback-race.test.ts`。
2. **`projectBasename` 跨平台**：原用 `path.basename`（POSIX 不切反斜杠），Linux/macOS CI 必失败 → 改为显式按 `\` 与 `/` 切分。

---

## 4. 架构与模块导览

```text
src/
├── index.ts              入口（stdio）
├── server.ts             组装：配置/日志/管理器/引擎/注册表/工具注册/技能自检安装
├── config/
│   ├── schema.ts         zod 全集（工具入参、profile、projects、验收配置、TraeworkMode）
│   └── store.ts          数据目录读写 + last-known-good 热加载
├── mcp/
│   ├── tools.ts          8 个工具的元数据（name/description/inputSchema/capability/approval）
│   ├── handlers.ts       工具实现
│   ├── context.ts        meta → TaskContext
│   └── formatter.ts      文本 + meta 块
├── tasks/                状态机、每项目串行队列、全局并发闸、事件流落盘
├── loop/
│   ├── fix-loop.ts       单任务编排（自动返修循环）
│   └── repair-plan.ts    验收失败时生成修复计划文件
├── agents/
│   ├── adapter.ts        AgentAdapter 接口（含可选 run() 执行面）
│   ├── registry.ts       按 profile.driver 构造 adapter（spawn→CliAdapter，gui→TraeworkGuiAdapter）
│   ├── cli.ts            通用 CLI adapter
│   ├── spawn.ts          子进程封装（windowsHide/stdio 管道/超时/kill tree）
│   ├── builtin.ts        内置 profiles（codex/zcode/traework）
│   └── traework/         GUI 驱动
│       ├── adapter.ts / run.ts / launcher.ts
│       ├── cdp/{client,selectors}.ts
│       ├── ui/{session,composer,model,reply}.ts
│       └── computeruse/{guard,dialog}.ts
├── verify/               验收引擎（命令检查 + 代码分析 + git 基线 + 报告）
└── util/                 日志、路径、文件、超时、技能安装
```

### 两条执行面（`driver`）

| driver | 执行方式 | 结果判定 |
|---|---|---|
| `spawn`（默认） | 拉起外部 CLI 子进程 | 退出码 |
| `gui` | CDP 驱动桌面 UI，**不 spawn** | DOM 完成标志 + 稳定兜底 + 超时 |

`TaskOrchestrator.runAgentOnce` 的分支逻辑：`adapter.run` 存在 → 调用它；否则走 `runChild`。**这是唯一需要理解的双路径接缝。**

### TraeWork 执行顺序（实测结论，勿随意调整）

```text
确保实例可用 → 等待 UI 就绪 → 新建会话 → 切到目标模式 → 在目标模式内绑定项目 → 切模型 → 发送 → 轮询到完成
```

> **关键事实**：TraeWork 的 Work/Code/Design **各自维护独立的项目绑定**，切换模式会把输入栏项目换成该模式上次使用的项目。
> 因此必须先切模式、再在目标模式里绑定项目；绑定后复核「模式 + 项目」双双就位，任一不符即响亮失败。

---

## 5. 硬性红线（违反 = 运行时损坏或事故，改架构前必读）

1. **绝不按进程树盲杀 TraeWork**：只终止本模块创建、且命令行核对通过的 PID，且不带 `/T`。
   事故来源：验证期 `taskkill /PID <pid> /T /F` 误杀用户正在使用的实例（数据完好，已恢复）。见 `docs/traework-cdp.md §6`。
2. **默认复用用户实例**：`gui.windowMode="reuse"`，绝不新起第二个。
3. **computer-use 白名单**：仅允许 TraeWork 文件夹选择对话框（窗口标题 + 宿主进程双校验），其他窗口一律 `COMPUTER_USE_DENIED`。
4. **凭证零管理**：不读取/解密/转发任何 agent 凭证；TraeWork 只驱动 UI。
5. **命令不拼 shell**：验收命令是结构化 argv，`shell:false`。
6. **不自动 commit/stash/回滚**：动工前采集 git 基线，报告相对基线计算。
7. **路径不硬编码**：机器路径/用户名/端口走 profile 或占位符（`{LOCALAPPDATA}` 等）。
8. **只在 `master` 提交，commit 用中文**。

---

## 6. 从零搭环境 + 日常迭代

```bash
git clone https://github.com/lanlan0811/tianshu-mcp.git
cd tianshu-mcp
npm ci
npm run build        # sync-version + tsc → dist/
npm test             # 167 项
```

日常循环（改 `src/` 后）：

```bash
npm run typecheck && npm run lint && npm test && npm run build
# 通过后：git add . && git commit -m "中文说明" && git push github master && git push gitee master
```

### 本机环境事实（2026-09-08 探测，接手机器可能不同）

| 项 | 值 |
|---|---|
| Node | v24.18.0（`engines: >=20`，CI 覆盖 20/22） |
| 天枢宿主 | `D:\Tianshu`（`tianshu-desktop.exe` + `rivet-runtime`） |
| Codex CLI | `C:\Users\Lenovo\AppData\Local\OpenAI\Codex\bin\<hash>\codex.exe`（哈希目录随更新变化 → 用 `executableDiscovery`） |
| TraeWork | `D:\TRAE Work CN\TRAE SOLO CN.exe`（v1.107.1）；CDP 需 `--remote-debugging-port=9222` 且窗口可见 |
| 参考实现 | `D:\Trae项目\oh-dsh-trae-api`（TraeWork CDP 驱动机制的来源，含 `HANDOFF.md`） |
| 数据目录 | 默认 `~/.tianshu-mcp`（env `TIANSHU_MCP_HOME` 可覆盖） |
| 技能安装 | `~/.rivet/skills/tianshu-mcp`（server 启动自检幂等安装） |

### 真机验证（**不入 CI**，需真实客户端在跑）

```bash
node scripts/probe-traework.mjs selectors          # 选择器命中检查
node scripts/probe-traework.mjs mode Code          # 切面板模式
node scripts/probe-traework.mjs project <绝对路径>  # 新建会话 + 绑定项目
node scripts/probe-traework.mjs send "任务书"       # 端到端发一条并取回复
```

---

## 7. 测试分层

| 层级 | 位置 | 说明 |
|---|---|---|
| 单元 | `test/unit/` | 纯函数与组件逻辑（含 traework reply/selectors/launcher/guard/repair-plan/driver/session） |
| 集成 | `test/integration/` | stub-agent 三剧本、取消/超时/基线、TraeWork 假 CDP（单轮 + 返修闭环）、rework 竞态回归 |
| 协议 | `test/protocol/` | 官方 SDK 客户端断言 8 工具面与返回格式 |
| 真机 | `scripts/probe-traework.mjs` | **手动**，需真实 TraeWork |

假 CDP 桩在 `test/fake-cdp.ts`：**助手回复必须同步追加**（`autoReplyText`），不要改回定时器——轮询间隔小 + `stableRounds` 低时定时器会与稳定兜底抢跑（已在 CI 上翻车过一次）。

---

## 8. 已知限制（对接手人有直接影响）

- **TraeWork 窗口必须可见**：发送依赖模拟输入。
- **单会话串行**：TraeWork 是单会话 UI，所有任务经串行队列。
- **完成判定是启发式**：DOM 完成标志「由AI生成」为主 + 稳定兜底（默认约 36s）+ 任务级超时；可调 `gui.stableRounds`。
- **UI 升级会漂移**：选择器集中在 `src/agents/traework/cdp/selectors.ts`，可经 profile `gui.selectors` 覆盖；用探针诊断。
- **macOS 未验证**：CDP 机制平台无关，但可执行探测与原生对话框驱动（AppleScript 路线）未实测；当前 macOS 分支 fail-closed。
- **`mode` 仅 GUI 类 agent 生效**：CLI 类（codex）忽略该参数。
- **npm 上的 README 停留在 0.1.5 发布时**：之后新增的文档（开源协作入口、天枢官方仓库链接）只在仓库里；如需同步到 npm 需再发版本。

---

## 9. 凭证与安全红线

- 仓库内**不含任何 token**；`~/.npmrc`、`~/.git-credentials`、`GITEE_ACCESS_TOKEN` 均为本机凭证，勿入库。
- `.gitignore` 隔离：`AGENTS.md`、`.zcode/*`、`.codex/*`、`.rivet/*`、`analysis-tools/*`、`/.tianshu-mcp/*`、`node_modules/*`、`dist/*`。
- 发布需要：npm `_authToken`（账号 `lotteai`）、GitHub token（`~/.git-credentials`）、`GITEE_ACCESS_TOKEN`。
- 安全模型与私密报告渠道见 `SECURITY.md`。

---

## 10. 文档地图

| 文档 | 内容 |
|---|---|
| `README.md` / `README.en.md` | 项目总览、快速开始（含天枢界面配置）、文档索引 |
| `CHANGELOG.md` / `.en.md` | 版本历史 v0.1.0 → v0.1.5 |
| `CONTRIBUTING.md` / `.en.md` | 开发环境、门禁、规范、提交/发布流程、如何新增 agent |
| `SECURITY.md` / `.en.md` | 安全模型与漏洞报告 |
| `CODE_OF_CONDUCT.md` / `.en.md` | 行为准则 |
| `docs/tianshu-integration.md` / `.en.md` | 接入配置、冒烟步骤、FAQ |
| `docs/traework-cdp.md` / `.en.md` | TraeWork GUI 驱动原理、选择器、安全红线、踩坑记录 |
| `docs/agent-profiles.md` / `.en.md` | profile 字段说明（含 `driver`/`gui`） |
| `docs/adapter-matrix.md` / `.en.md` | 各 agent 能力调研矩阵 |
| `docs/acceptance-config.md` / `.en.md` | 项目级验收配置规范 |
| `docs/release-v0.1.5.md` / `.en.md` | v0.1.5 发布说明与产物记录 |
| `docs/npm-publish-guide.md` | npm 发布步骤与凭证 |
| `docs/m2-*.md`、`docs/host-integration-record.md`、`docs/dod7/dod8-*` | 历史里程碑物证（中文，无英文版） |
| `skills/tianshu-mcp/SKILL.md` | 教天枢编排本 MCP 的技能（随包分发、启动自检安装） |

> **本地 only（gitignore，不在仓库）**：`.zcode/plans/tianshu-mcp-development-plan.md`（总开发计划）、
> `.zcode/plans/traework-gui-adapter-plan.md`（TraeWork GUI 计划，M1–M5 已完成）、`.codex/review/`（验收报告）。

---

## 11. 接手人下一步建议

1. 先跑 `npm ci && npm run typecheck && npm run lint && npm test && npm run build`，确认基线绿。
2. 读 `README.md` + `docs/traework-cdp.md §6/§8`（安全红线与踩坑），再动 TraeWork 相关代码。
3. 若 TraeWork 升级导致选择器失效：用 `scripts/probe-traework.mjs selectors` 诊断，优先用 profile `gui.selectors` 覆盖，不改代码。
4. 新增 agent：优先只加 profile（见 `docs/agent-profiles.md`）；需要特殊输出解析再写 adapter。
5. 发版前务必确认 `src/version.generated.ts` 与 `package.json` 同步提交（CI 有「构建后无 tracked diff」门禁）。
