# HANDOFF.md — 项目交接说明

> 交接快照：**2026-09-12**（v0.3.3：ZCode 3.11.2 适配 + 验收引擎 fail-closed）。本文写给**接手本仓库的人**：先读「交接快照」了解当前状态，再按「从零搭环境」上手。
> 工作区规则见 `AGENTS.md`（gitignore 中，仅本地），安装/用法见 `README.md`，本文不重复，只做导览与状态记录。

---

## 1. 这个项目是什么

`tianshu-mcp` 是一个**被天枢（Tianshu）当作标准 MCP server 接入的编排层**：天枢是总指挥，本 server 负责**调度 + 执行面 + 客观验收仪**，驱动外部 AI-Agent 完成闭环：

```text
项目开发 → 验收 → 失败返修 → 再验收
```

- **天枢官方仓库**：<https://github.com/huiliyi37/Tianshu-harness>（基于 harness 工程的终端编程智能体运行时，TUI × GUI；Apache-2.0）
- **本仓库**：`github.com/lanlan0811/tianshu-mcp`（主）｜`gitee.com/lan0811/tianshu-mcp`（镜像）
- **npm**：`tianshu-mcp`（当前发布版本 `0.3.3`）
- **工具面**：9 个 MCP 工具（`run_task / continue_task / query_task / list_tasks / get_task_report / cancel_task / verify_task / rework_task / get_profiles`）

### 为什么是这样设计的（硬约束）

本项目的形态由四个**实测硬约束**决定，改架构前必读：

1. **天枢的 MCP 工具只回文本**：MCP 响应里 `content[]` 的 `text` 项被拼成字符串，`isError` 透传。因此所有结果统一为「人类可读文本 + `---tianshu-mcp-meta---` JSON 块」，不依赖 resources/prompts。
2. **天枢按次同步调用 `tools/call`**：长任务必须异步化 → `run_task` 秒回 `taskId`，用 `query_task` 轮询。
3. **TraeWork 的 agent 请求在 TTNet 层 TDE 加密**，无法在客户端外构造 → 唯一可行路径是 CDP 驱动其桌面 UI，从 DOM 提取结果。
4. **Codex 桌面端是 MSIX 商店包**：GUI 宿主无法 `CreateProcess` 直启（AppX 策略拒绝），必须经 `IApplicationActivationManager` COM 激活并注入专属 `--user-data-dir` 才能开 CDP 端口 → 见 `docs/codex-gui-cdp.md`。

---

## 2. 交接快照

| 项 | 状态 |
|---|---|
| 分支 | `master`（**只在此分支提交**，不建其他分支） |
| 发布提交 | `38fb47d chore(release): v0.3.3 版本号、双语 CHANGELOG 与文档更新`（tag `v0.3.3` 即此提交） |
| 版本 / 许可证 | `0.3.3` / Apache-2.0 |
| 标签 | `v0.1.0` … `v0.3.3`（均已推双仓） |
| 工作树 | 干净；`github/master` 与 `gitee/master` 均同步于 `38fb47d` |
| 测试 | **366/366 通过**（39 个测试文件：单元 24 + 集成 14 + 协议 1） |
| 门禁 | lint 0 warning、typecheck clean、build 成功、`check:stdio` 6/6 场景通过、`npm pack` 内容校验通过 |
| CI | ubuntu/windows/macos × Node 20/22/24 + pack-check = **10/10 全绿**（随 v0.3.3 tag 再次校验） |
| npm | 发布由维护者手动 `npm publish`（需 token）；详见 `docs/npm-publish-guide.md` |
| Release | 推送 `v*` tag 触发 `.github/workflows/release.yml`：正文由 `docs/release-v<ver>.md` + `.en.md` 双语合成（缺文档即报错，不产出空壳正文），`Full Changelog` 经 `git describe` 解析上一 tag，CI 链接解析同 SHA 运行，并附 `tianshu-mcp-<ver>.tgz`；Gitee 发行版由 `scripts/gitee-release.mjs` 用 `GITEE_TOKEN` 幂等补齐 |

### Agent 适配现状

| agentId | driver / adapter | status | 说明 |
|---|---|---|---|
| `codex` | `gui` / `codex-gui` | **ready**（macOS 为 `research`） | Codex 桌面端 GUI（MSIX COM 激活 + CDP），支持 `model`/`reasoningLevel`/`planDoc`/`designSystem`；等待用户检测、取消真停、重派护栏均已真机验证（v0.3.2） |
| `zcode` | `gui` / `zcode-gui` | **research** | CDP GUI adapter，Windows 真机闭环通过；已适配 ZCode 3.11.2 模型菜单与项目绑定（v0.3.3）；macOS 真机证据完成前不得改 `ready` |
| `traework` | `gui` / `traework-gui` | **ready** | CDP 驱动 TRAE SOLO CN 桌面 UI；三种面板模式真机验证通过 |
| `stub` | `spawn` | 仅测试 | `test/stub-agent/stub-agent.mjs` 三剧本（good/fix-on-first/never） |

---

## 3. 里程碑记录（简版，详见 `CHANGELOG.md`）

- **M1** 核心引擎 + stub-agent 全链路（8 工具、状态机、队列、验收引擎、fix-loop）— 53 测试
- **M2** 真实 Codex CLI 冒烟 + rework 闭环；修复 3 个真实缺陷
- **M3** TraeWork 调研 → 定论「无无头 CLI」；npm 首发；天枢宿主真实接入（DoD #6）
- **R1–R8 / S1–S6** 两轮验收整改（取消/超时/基线归因/参数语义/热加载/CI 加固）— 72 测试
- **M4** TraeWork GUI 驱动接入（CDP）——`driver=gui` 落地，真机 e2e 通过 — 153 测试
- **M5** 面板模式切换（Work/Code/Design）+ v0.1.5 发布 + README 重写/SVG 资产 — **167 测试**
- **M6** 项目文件夹绑定修复（footer 确认弹窗 / 检测预算 / CJK 路径 WM_SETTEXT / Code→Work 兜底）+ v0.1.6 — **172 测试**
- **M7** 绑定**根因**修复（规范化路径被选择器拒绝 → `toNativeWindowsPath`）+ 写入回读校验 / hwnd 贯穿 / 遗留对话框清理 + v0.1.7 — **178 测试**
- **M8** 原子写并发缺陷修复（临时文件名唯一化 + rename 退避重试，CI windows/Node20 真根因）+ v0.1.8 — **181 测试**
- **M9** TraeWork 任务进行中检测（权威运行信号 + 空闲计时 + CDP 断线收敛 + 异常保留实例）+ v0.1.9 — **196 测试**
- **M10** stdio 日志污染修复（issue #1：Logger 全级别改走 stderr + 严格 stdio 门禁 + Node 24 + 安装包协议门禁）+ v0.1.10 — **202 测试**
- **M11** ZCode GUI 统一闭环（独立 `zcode-gui` CDP adapter + 精确项目/模型/完全访问 + `needs_user`/`continue_task` + 同会话返修）+ v0.2.0 — **262 测试**
- **M12** Codex 桌面端 GUI 适配（MSIX COM 激活 + CDP；模型 + 思考强度滑块；项目自动登记；验收失败自动生成计划并返修）+ v0.3.0 — **340 测试**（**破坏性**：`agentId=codex` 由无头 CLI 改为 GUI）
- **M13** 技能文档对齐 + 发布自动化修复 + v0.3.1（无源码行为变更；SKILL/usage-examples 重写、双语 Release 正文、Full Changelog/CI 链接修复、Gitee 发行版自动化）
- **M14** Codex 等待用户检测 + 取消真停 GUI + v0.3.2（issue #5/#6，详见 §8.4）
- **M15** ZCode 3.11.2 适配 + 验收引擎 fail-closed + v0.3.3（issue #4/#7，详见 §8.5）— **366 测试**

### 实现期修复记录（重要）

1. **rework 反馈竞态**（`TaskManager`，负载下偶发）
   - 现象：`rework_task(feedback)` 后返修轮拿不到 feedback，卡在 `failed`。
   - 根因：终态快照先落盘，调用方立即写入 `reworkFeedback`；上一轮收尾的 `delete meta.reworkFeedback` 把它抹掉。
   - 修复：改为 `startTask` 启动时**原子取走并清空**。回归：`test/integration/rework-feedback-race.test.ts`。
2. **`projectBasename` 跨平台**：原用 `path.basename`（POSIX 不切反斜杠），Linux/macOS CI 必失败 → 改为显式按 `\` 与 `/` 切分。
3. **项目文件夹绑定卡住**（M6，实战反馈）：三处叠加缺陷 —— footer 点击未确认弹窗、检测被 PowerShell 冷启动吃光预算、CJK 路径被控制台代码页破坏。详见 §8.1。
4. **绑定仍失败的真根因**（M7）：MCP 传 `normPath()` 规范化路径（`d:/a/b`），**Windows 原生选择器不接受** → 必须 `toNativeWindowsPath()` 转 `D:\a\b`。详见 §8.1。
5. **原子写并发缺陷**（M8，CI 偶发失败真根因）：`writeJsonAtomic`/`writeTextAtomic` 临时文件名
   `<目标>.<pid>.tmp` 在并发下共用 → `ENOENT`（同进程）或 `EPERM`（Windows rename 争用）；
   已改为随机后缀 + rename 退避重试。回归：`test/unit/atomic-write.test.ts`。
6. **长思考被提前判完成**（M9）：稳定 36 秒不再等同完成；停止按钮与 loading task tail 优先于完成标志，
   静态确认后再等待默认 10 分钟才返回 `idle`。异常结束保留实例，详见 §8.2。
7. **stdio 日志污染**（M10 / v0.1.10，issue #1）：统一 `Logger` 只有 ERROR 走 `console.error`，
   INFO/WARN/DEBUG 走 `console.log`，与 MCP JSON-RPC 共用 stdout → 严格客户端握手/调用失败。
   修复：全级别统一 stderr，stdout 只承载协议消息。回归：`test/unit/log.test.ts` +
   `scripts/check-stdio.mjs`（真实进程字节流校验，6 场景），ESLint `no-console` 兜底。详见 §8.3。
8. **Codex 等待用户死锁 + 取消假停**（M14 / v0.3.2，issue #5/#6）：等待用户确认界面恒报 `running` 直到总超时；
   `cancel_task` 只停 MCP 侧等待、不停 GUI 内运行。修复：stall 兜底转 `needs_user(user_confirmation)`、
   `continue_task` 扩展支持 codex、取消经 CDP 点击停止 + 有界等待、派发前 `instance_busy` 护栏。详见 §8.4。
9. **ZCode 3.11.2 选择器漂移 + 验收假绿**（M15 / v0.3.3，issue #4/#7）：模型菜单 provider 分组漂移为 family、
   项目绑定入口/回读判据变化；测试零用例与 git 零变更曾判通过。修复：新旧布局双兼容 + 直选优先、
   composer 复选项主判据 + 回读重试、验收引擎 fail-closed（零用例判失败、`requireChanges` 默认 true）。详见 §8.5。

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
│   ├── tools.ts          9 个工具的元数据
│   ├── handlers.ts       工具实现
│   ├── context.ts        meta → TaskContext
│   └── formatter.ts      文本 + meta 块
├── tasks/                状态机、每项目串行队列、全局并发闸、事件流落盘
│   ├── task.ts / task-manager.ts / task-store.ts
├── loop/
│   ├── fix-loop.ts       单任务编排（自动返修循环）
│   └── repair-plan.ts    验收失败时生成修复计划文件
├── agents/
│   ├── adapter.ts        AgentAdapter 接口（含可选 run() 执行面）
│   ├── registry.ts       按 profile.adapter/driver 构造 Cli/TraeWork/ZCode/Codex adapter
│   ├── cli.ts            通用 CLI adapter
│   ├── spawn.ts          子进程封装（windowsHide/stdio 管道/超时/kill tree）
│   ├── builtin.ts        内置 profiles（codex/zcode/traework）
│   ├── traework/         TraeWork GUI 驱动
│   │   ├── adapter.ts / run.ts / launcher.ts
│   │   ├── cdp/{client,selectors}.ts
│   │   ├── ui/{session,composer,model,reply}.ts
│   │   └── computeruse/{guard,dialog}.ts
│   ├── zcode/            ZCode GUI 驱动（v0.2.0 起）
│   │   ├── adapter.ts / run.ts / instance.ts
│   │   ├── cdp.ts / selectors.ts / discovery.ts / dialog.ts
│   │   ├── model.ts / project.ts / references.ts / liveness.ts
│   └── codex/            Codex 桌面端 GUI 驱动（v0.3.0 起）
│       ├── adapter.ts / run.ts
│       ├── discovery.ts（Appx 查询 + 扫盘回退）/ launcher.ts（COM 激活）
│       ├── cdp.ts / selectors.ts / input.ts / model.ts
│       ├── project.ts（自动登记）/ registry.ts / instance.ts / liveness.ts
│       ├── dialog.ts / fixplan.ts / verify.ts
├── verify/               验收引擎（命令检查 + 代码分析 + git 基线 + 报告）
│   ├── acceptance.ts / runner.ts / exec.ts / signals.ts
│   ├── code-analysis.ts / git-baseline.ts / report.ts
└── util/                 日志、路径、文件、超时、id、技能安装
```

### 两条执行面（`driver`）

| driver | 执行方式 | 结果判定 |
|---|---|---|
| `spawn`（默认） | 拉起外部 CLI 子进程 | 退出码 |
| `gui` | CDP 驱动桌面 UI，**不 spawn**（Codex/ZCode 的进程启动除外——为注入调试端口而启动，但仍以 UI 信号判定） | 运行信号优先 → DOM 完成标志 → 稳定确认后的空闲计时 → stall/任务超时 |

`TaskOrchestrator.runAgentOnce` 的分支逻辑：`adapter.run` 存在 → 调用它；否则走 `runChild`。**这是唯一需要理解的双路径接缝。**

### 三个 GUI adapter 的执行顺序（实测结论，勿随意调整）

**TraeWork**（详见 §8.1/§8.2）：

```text
确保实例可用 → 等待 UI 就绪 → 新建会话 → 切到目标模式 → 在目标模式内绑定项目 → 切模型 → 发送 → 轮询到完成
```

> **关键事实**：TraeWork 的 Work/Code/Design **各自维护独立的项目绑定**，切换模式会把输入栏项目换成该模式上次使用的项目。
> 因此必须先切模式、再在目标模式里绑定项目；绑定后复核「模式 + 项目」双双就位，任一不符即响亮失败。

**ZCode**（详见 `docs/zcode-cdp.md` 与 §8.5）：

```text
发现安装 → 启动/复用 CDP 实例 → 绑定项目（composer 复选项为主判据，旧版侧栏兜底） → 选模型（直选优先，provider/family 分组兜底） → 完全访问权限 → 发送 → 运行检测/提问检测 → 轮询到完成
```

> 提问、登录页、旧实例无 CDP、macOS 辅助功能权限分别转 `agent_question` / `login_required` /
> `needs_user(close_existing_instance)` / `system_permission`，由 `continue_task` 恢复。

**Codex**（详见 `docs/codex-gui-cdp.md` 与 §8.4）：

```text
MSIX 发现（Appx 查询优先 + 扫盘回退） → COM 激活 + 专属 user-data-dir + CDP 端口 → 项目登记/绑定 → 选模型与思考等级 → 发送（planDoc/designSystem 拼进初始指令） → 运行检测（停止按钮 + 对话哈希 stall） → 轮询到完成
```

> 停在「等待用户确认」界面（方案确认卡/订阅结账页）→ stall 判定转 `needs_user(user_confirmation)`；
> 用户处理完后 `continue_task` 重新观察（不重发消息）；`login_required` 则复检环境后重派任务书。

---

## 5. 硬性红线（违反 = 运行时损坏或事故，改架构前必读）

1. **绝不按进程树盲杀 TraeWork**：只终止本模块创建、且命令行核对通过的 PID，且不带 `/T`。
   事故来源：验证期 `taskkill /PID <pid> /T /F` 误杀用户正在使用的实例（数据完好，已恢复）。见 `docs/traework-cdp.md §6`。
2. **默认复用用户实例**：`gui.windowMode="reuse"`，绝不新起第二个（Codex/ZCode 以专属 user-data-dir 启动的受管实例除外，且不触碰用户手动打开的实例）。
3. **computer-use 白名单**：仅允许 TraeWork 文件夹选择对话框（窗口标题 + 宿主进程双校验），其他窗口一律 `COMPUTER_USE_DENIED`。
4. **凭证零管理**：不读取/解密/转发任何 agent 凭证；GUI adapter 只驱动 UI。
5. **命令不拼 shell**：验收命令是结构化 argv，`shell:false`。
6. **不自动 commit/stash/回滚**：动工前采集 git 基线，报告相对基线计算。
7. **路径不硬编码**：机器路径/用户名/端口走 profile 或占位符（`{LOCALAPPDATA}`、`{PROGRAMFILES}` 等，展开大小写不敏感）。
8. **GUI 取消不得谎报**：`cancel_task` 对 GUI agent 必须尽力点击停止 + 在 `gui.cancelWaitMs` 内有界等待确认；
   未确认停止时终态必须明示「GUI 内运行未确认停止」。重派前必须确认受管实例空闲，否则以 `instance_busy` 拒绝（防 turn 交叠）。
9. **验收 fail-closed**：测试命令退出码 0 但输出显示零用例 → 判失败；git 项目默认要求相对基线产生变更
   （`requireChanges: false` 显式关闭）。不得为「让任务变绿」放松这两个门禁。
10. **只在 `master` 提交，commit 用中文**。

---

## 6. 从零搭环境 + 日常迭代

```bash
git clone https://github.com/lanlan0811/tianshu-mcp.git
cd tianshu-mcp
npm ci
npm run build        # sync-version + tsc → dist/
npm test             # 366 项
```

日常循环（改 `src/` 后）：

```bash
npm run typecheck && npm run lint && npm test && npm run build
# 通过后：git add . && git commit -m "中文说明" && git push github master && git push gitee master
```

### 本机环境事实（2026-09 探测，接手机器可能不同）

| 项 | 值 |
|---|---|
| Node | v24.18.0（`engines: >=20`，CI 覆盖 20/22/24） |
| 天枢宿主 | `D:\Tianshu`（`tianshu-desktop.exe` + `rivet-runtime`） |
| Codex 桌面端（现用） | MSIX 包 `OpenAI.Codex`：`...\WindowsApps\OpenAI.Codex_<版本>_x64__<pfn>\app\ChatGPT.exe`；版本目录随更新变化 → Appx 查询优先 + 扫盘回退取最新 |
| Codex 内核 CLI（备用） | `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`；如需无头执行，另建 `driver=spawn` profile |
| TraeWork | `D:\TRAE Work CN\TRAE SOLO CN.exe`（v1.107.1）；CDP 需 `--remote-debugging-port=9222` 且窗口可见 |
| ZCode | Electron 桌面端；Windows 验收样本 `D:\Z-Code\ZCode\ZCode.exe`（由「D 盘优先 + 相对路径模板」发现，非硬编码）；CDP 需 `--remote-debugging-port`；3.11.2 语义已适配 |
| 参考实现 | `D:\Trae项目\oh-dsh-trae-api`（TraeWork CDP 驱动机制的来源，含 `HANDOFF.md`） |
| 数据目录 | 默认 `~/.tianshu-mcp`（env `TIANSHU_MCP_HOME` 可覆盖） |
| 技能安装 | `~/.rivet/skills/tianshu-mcp`（server 启动自检幂等安装） |

### 诊断探针与真机验证（**不入 CI**，需真实客户端在跑）

```bash
# TraeWork：选择器 / 模式 / 绑定 / 发送
node scripts/probe-traework.mjs selectors
node scripts/probe-traework.mjs mode Code
node scripts/probe-traework.mjs project <绝对路径>
node scripts/probe-traework.mjs send "任务书"

# ZCode：只读诊断（install/process/cdp/selectors/ui/projects/models/permission/liveness/session）
node scripts/probe-zcode.mjs all

# Codex：只读诊断；--launch 才会以专属 user-data-dir 启动受管实例（不触碰用户实例）
node scripts/probe-codex.mjs
node scripts/probe-codex.mjs --launch --port 9333

# ZCode 真机冒烟（需 --confirm-send/--model/--task 三者齐全才发送；隔离数据目录）
npm run build && npm run smoke:zcode -- --confirm-send --model DeepSeek/deepseek-flash --project D:\repo\app --task "任务书"

# stdio 协议门禁（真实进程字节流校验，6 场景）
npm run check:stdio
```

---

## 7. 测试分层

| 层级 | 位置 | 说明 |
|---|---|---|
| 单元 | `test/unit/`（24 文件） | 纯函数与组件逻辑：traework 全套（reply/selectors/launcher/guard/driver/session/liveness/dialog/cdp-client/repair-plan）、codex-core、zcode-core/zcode-handler、acceptance、baseline、atomic-write、log、config/profile 热加载等 |
| 集成 | `test/integration/`（14 文件） | stub-agent 三剧本、取消/超时/基线、traework 假 CDP（单轮 + 返修 + 绑定兜底）、codex-flow、zcode-flow/restart/rework-loop、rework 竞态回归、verify-params |
| 协议 | `test/protocol/`（1 文件） | 官方 SDK 客户端断言 9 工具面与返回格式 |
| 真机 | `scripts/probe-*.mjs` / `scripts/smoke-zcode.mjs` | **手动**，需真实客户端 |

假 CDP 桩在 `test/fake-cdp.ts`：**助手回复必须同步追加**（`autoReplyText`），不要改回定时器——轮询间隔小 + `stableRounds` 低时定时器会与稳定兜底抢跑（已在 CI 上翻车过一次）。ZCode 3.11.2 语义的假桩与回归用例见 `test/integration/zcode-flow.test.ts` / `test/unit/zcode-core.test.ts`（v0.3.3 同步）。

---

## 8. 已知限制（对接手人有直接影响）

- **TraeWork 窗口必须可见**：发送依赖模拟输入。
- **单会话串行**：TraeWork 是单会话 UI，所有任务经串行队列。
- **完成判定依赖 UI 信号**：停止按钮 / loading task tail 存在时不结束；无运行信号才接受「由AI生成」。
  `stableRounds` 只启动 `idleTimeoutMs`（默认 10 分钟）空闲计时，不再把约 36 秒静态直接当完成。
- **异常结束保留实例**：`idle_no_completion` / `timeout` / `aborted` / `cdp_lost` 均不关闭现场；
  `query_task` meta 查看 `agentEndReason` / `keptInstance`。
- **UI 升级会漂移**：三个 adapter 的选择器分别集中在
  `src/agents/traework/cdp/selectors.ts`、`src/agents/zcode/selectors.ts`、`src/agents/codex/selectors.ts`，
  均可经 profile `gui.selectors` 覆盖；用探针诊断。
- **macOS 未验证**：TraeWork 的原生对话框驱动（AppleScript 路线）、ZCode 真机闭环、Codex GUI 的就绪判定均未在
  macOS 实测；当前 macOS 分支 fail-closed（codex 内置 profile 在 darwin 上即为 `research`）。
- **`mode` 仅 TraeWork 生效**：ZCode/Codex 会拒绝该参数（返回明确错误）。
- **needs_user 状态下取消是已知边界**：MCP 侧无 CDP 连接，GUI 内等待中的会话停不掉；终态文案会提示。
  经临时 CDP 连接尽力停止 GUI 内会话列在「未发布/计划中」。
- **验收 fail-closed 对纯分析任务的影响**：git 项目默认要求产生变更；纯问答/分析任务必须在
  `.tianshu-mcp/acceptance.json` 设 `"requireChanges": false`，否则验收判失败。
- **原生对话框链路依赖桌面状态**：TraeWork 窗口必须可见，且不能有第三方工具（如 Snipaste 截图器）抢焦点。
- **npm 上的 README 停留在发布时**：之后新增的文档只在仓库里；如需同步到 npm 需再发版本。

---

## 8.1 TraeWork 项目文件夹绑定排障（M6/M7 实战教训）

### 事实：下拉项 ≠ 项目 map

| 数据源 | 说明 |
|---|---|
| 下拉列表（`readProjectItems`） | 来自 TraeWork **服务端**项目列表，实测本机 11–12 项 |
| `solo-lite.local-project-folders`（state.vscdb） | 仅本地**路径回填缓存**，实测 22–23 条 |

两者不是同一份数据。**「项目已在 map 里」不代表下拉能命中**——未命中仍会走原生对话框。
（曾误判为「项目已注册所以不该走对话框」，实测证伪。）

### 三处叠加缺陷（2026-09-08 修复）

1. **footer 点击未确认弹窗**：`element.click()` 返回 true ≠ 原生弹窗出现。
   旧代码只看返回值 → 日志报「等待原生对话框超时」（下游症状）。
   **修复**：点击后调 `findFolderDialog()` 确认，未出现则记录下拉 DOM 快照并明确失败。
2. **检测预算被 PowerShell 冷启动吃光**：实测冷启动 **4.5–6.3s/次**（UIA 与 Win32 都一样），
   旧代码 Node 侧每 800ms 轮询 → 15s 只够约 2 次。
   **修复**：单次 PowerShell 调用内轮询（400ms 间隔），预算 30s；`spawnSync` → 异步 `spawn`。
3. **CJK 路径被控制台代码页破坏**：实测 `D:\Trae项目	s-bind-test` 被写成 `D:Traes-bind-test`。
   **修复**：改用 Win32 **`WM_SETTEXT`**（句柄由 UIA 提供）写编辑框。

### ★ 真根因（M7 / v0.1.7）：路径形式不对

MCP 内部传给对话框的是 `normPath()` **规范化路径**（小写盘符 + 正斜杠，如 `d:/Trae项目/AI游戏/象棋`），
而 **Windows 原生文件夹选择器不接受该形式**。实测对照（同一对话框、同一台机器）：

| 写入 | 回读 | 点确认后 |
|---|---|---|
| `d:/Trae项目/AI游戏/象棋` | `d:/Trae项目/AI游戏/象棋` | **对话框不关闭**（路径被拒） |
| `D:\Trae项目\AI游戏\象棋` | `D:\Trae项目\AI游戏\象棋` | **对话框关闭，绑定成功** |

**注意**：回读校验会「通过」，因为写进去的确实是那个字符串——所以**光有回读校验不够**，
必须先把路径转成原生形式（`toNativeWindowsPath()`：正斜杠→反斜杠 + 盘符大写）。

配套修复：写入后 `WM_GETTEXT` 回读 + 重试（最多 3 次，失败不点确认）、
hwnd 贯穿传递（只操作探测到的那个窗口）、下拉未命中时先清理遗留对话框、
确认按钮要求矩形在对话框下半部。

### 另外两个定位陷阱（已修）

- **确认按钮 `AutomationId="1"` 不唯一**：文件列表行也用 0/1/2…。必须用
  **AutomationId=1 且 ControlType=Pane** 组合定位（实测误点到 `.rivet` 列表项）。
- **「文件夹」编辑框**：`AutomationId=1152` 且 **ClassName=`Edit`**（它是 Pane 类型、无 ValuePattern）。

### 排障顺序（下次遇到卡住先做这几步）

1. `node scripts/probe-traework.mjs selectors` —— 确认选择器是否命中。
2. 看任务日志 `<home>/tasks/<taskId>/agent-0.log`：区分「下拉未命中」「对话框未弹出」「写入失败」「确认失败」。
3. 手工验证对话框是否开着：
   ```bash
   powershell -NoProfile -Command "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes; \$r=[System.Windows.Automation.AutomationElement]::RootElement; \$c=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Window); foreach(\$w in \$r.FindAll([System.Windows.Automation.TreeScope]::Children,\$c)){ if(\$w.Current.Name -match 'TraeWork'){ foreach(\$d in \$w.FindAll([System.Windows.Automation.TreeScope]::Descendants,\$c)){ Write-Output \$d.Current.Name } } }"
   ```
4. **不要**用 TraeWork 的 `--folder-uri` / `-a` 预注册（已证伪：只写原生 `history.recentlyOpenedPathsList`，
   Solo 下拉不读它）；**不要**直写 `state.vscdb` 的 map（renderer 有内存缓存，且 key 需后端 `createProject` 分配）。

---

## 8.2 TraeWork 任务进行中检测（M9 / v0.1.9）

### 信号优先级与选择理由

1. 字面「思考中」先保持 `pending`；原生 `ask_user` 仍立即结束本轮。
2. `.chat-input-v2-send-button-stop-icon`（主）与 `.core-task-tail--loading`（次）是权威运行信号：
   任一可见时，即使 DOM 已有完成标志也必须继续等待，并清零稳定轮数/空闲计时。
3. `.thinking-stream-content` 与工具卡片只作诊断。它们会残留在历史消息，若作为阻塞条件会永久不结束。
4. 无运行信号时才接受「由AI生成」完成标志；无完成标志则在 `stableRounds` 轮静态确认后，继续静态
   `idleTimeoutMs`（默认 600000ms）才返回 `idle_no_completion`。

所有信号通过 `selectors.ts` 的主选择器、回退与 profile 覆盖解析。若 UI 升级导致全部新选择器未命中，
探针按 `running=false` **失败开放**，退回完成标志 + 空闲计时，避免选择器漂移造成永久卡死。

### CDP 与实例保留策略

- CDP WebSocket `close` / `error` 会拒绝全部 pending；单次 `send()` 默认 15000ms 超时。
- 轮询观测与 abort、任务 deadline 竞争，取消最多约 1 秒生效；默认每 30000ms 发一条 `note` 进度事件。
- 只有 `completion_mark` / `ask_user` 会释放本模块启动的实例。
- `idle_no_completion` / `timeout` / `aborted` / `cdp_lost` 均保留实例，结果与任务 meta 写入
  `agentEndReason` / `keptInstance`。超时文案不再错误声称「进程树已终止」。

---

## 8.3 stdio 日志污染修复（M10 / v0.1.10，issue #1）

### 事实与根因

- MCP stdio 规范：**stdout 只承载合法 MCP JSON-RPC 消息**，诊断日志应写 stderr。
- 旧 `src/util/log.ts` 只有 `error` 走 `console.error`，`info`/`warn`/`debug` 走 `console.log`（stdout）。
  默认 INFO 阈值下，连接提示、技能自检、任务状态等都会污染协议流，且可延续到握手之后。
- 复现（旧实现，`node --import tsx src/index.ts`，隔离 HOME）：6 个场景全部在 stdout 出现
  `[INFO] …` 非协议行；证据见 `docs/m2-evidence/issue1-old-impl-stdio-check-failure.txt`。

### 修复与门禁

- `src/util/log.ts`：所有通过阈值的级别统一 `console.error`（stderr），日志文件追加行为不变。
- `eslint.config.js`：`src/**/*.ts` 启用 `no-console`（仅允许 `error`），阻止再次直接写 stdout。
- `scripts/check-stdio.mjs`：真实子进程捕获完整 stdout/stderr，逐行用官方 `JSONRPCMessageSchema`
  校验，空行/非 JSON/parser error/退出残留片段即失败；覆盖首次启动、再次启动、`--no-skill-install`、
  损坏 `config.json`、stub 任务运行期日志、EOF 关闭 6 场景。消费者安装 tarball 后复用同一脚本。
- 回归：`test/unit/log.test.ts` 以子进程探针断言四级通道、默认 INFO 过滤、文件阈值与 UTF-8。

### 宿主复验物证

| 项 | 结果 |
|---|---|
| 修复后 | 源码入口与 `dist` 入口 `check:stdio` 均 **6/6 通过**，stdout 非协议行 0 |
| 桌面宿主重连 | 天枢桌面端 v3.16.1：`2 servers connected, 10 tools`（本 server 8 个），无过滤包装器；会话内真实调用 `get_profiles` 成功。详见 `docs/issue-1-host-reconnect-record.md` |
| 3.17.0 复验 | 宿主升级后 UI 显示 0/2；根因是天枢内嵌 npm 的 `minipass` 旧副本污染（与本 server 无关）。移开陈旧嵌套目录后 `GET /mcp/status` 显示 tianshu-mcp `connected`，会话内 `mcp__tianshu-mcp__get_profiles` 调用成功 |

---

## 8.4 Codex GUI 状态脱节与取消（M14 / v0.3.2，issue #5/#6）

### 等待用户检测（issue #5）

- **现象**：Codex 停在「等待用户确认」界面（方案确认卡/订阅结账页等）时，turn 是暂停而非结束，
  但停止按钮仍可见——旧判定把「停止按钮可见」当绝对运行信号 → 任务死锁在 `running` 直到 30 分钟总超时。
- **stall 兜底**：停止按钮持续可见且对话哈希 `gui.stallTimeoutMs`（默认 5 分钟）不变 → 判定等待用户，
  任务转 `needs_user(user_confirmation)` 并回传可操作的 `pendingQuestion`；对话内容恢复变化会重置计时。
- **可配置界面检测**：`gui.selectors.userGate`（如结账页 `embedded-checkout`、确认卡选择器）命中即快速转
  `needs_user`；默认未配置 = 禁用，不内置未真机验证的选择器。
- **选择器收紧**：`stopButton` 移除 `aria-label*="取消"` 过匹配（等待用户界面的「取消」按钮曾被误判为运行信号）。

### 恢复通道（`continue_task` 扩展支持 codex）

| `needsUserKind` | 恢复行为 |
|---|---|
| `user_confirmation` | 用户在 Codex 窗口处理完后恢复；MCP 仅重新接入观察 GUI 内运行（**不发送消息**）；恢复前 turn 已完成也能正确判 `succeeded` |
| `login_required` | 复检环境后重新派发任务书（新会话 + 项目绑定 + 完整初始指令） |

ZCode 原有恢复行为不变；其他 agent 明确拒绝。

### 取消真停 GUI（issue #6）

- `cancel_task` 对 GUI agent 不再「请求即成功」：先经 CDP 尽力点击界面停止按钮，并在 `gui.cancelWaitMs`
  （默认 15 秒）内有界等待 GUI 真正空闲后落 `cancelled`；未确认停止时终态文案明示
  「GUI 内运行未确认停止，Codex 窗口中的任务可能仍在继续」。
- **重派防交叠护栏**：派发前发现受管实例上仍有未停止的运行时，先尽力停止；仍不空闲则以
  `instance_busy` 硬失败拒绝派发（取消后立刻重派曾实测踩中）。

### 真机陷阱：trusted 点击 vs DOM click

Windows + Codex 26.903.9818.0 真机模拟实测：模型菜单的 `menuitemradio` 对 trusted 鼠标点击
**只收起菜单、不切换选中态** → `clickModelItem` 改为页面内 DOM `.click()`；而「项目选择触发器」相反，
**需要 trusted 点击才能展开**。两个方向相反的行为都已注明在代码与 `docs/codex-gui-cdp.md`，
后续改动选择器交互时必须真机复验。

---

## 8.5 ZCode 3.11.2 适配与验收 fail-closed（M15 / v0.3.3，issue #4/#7）

### ZCode 3.11.2 选择器漂移（issue #4）

- **模型菜单**：3.11.2 把供应商分组从 `chat-model-select-group-provider:` 漂移为
  `chat-model-select-group-family:`。现两前缀均兼容；打开菜单后**直选平铺模型优先**，
  直选失败才展开 provider/family 分组重试（新旧布局都覆盖）。
- **项目绑定**：3.11.2 绑定入口在 composer 下拉，主判据为 `menuitemcheckbox`（按 NFKC/空白/大小写归一化后
  的目录显示名精确唯一匹配），旧版侧栏项仅作回退；回读同时校验 composer 触发器文本与完整路径，
  过滤中英文「选择项目」占位词；绑定失败最多两轮幂等重试。
- **添加新项目**：首次 outside-click 会被吞 → 添加前先收起残留工作区菜单，再以最多三轮
  「收起—点击—验证」闭环打开「打开文件夹」。
- **诊断友好**：`model_unavailable` 与权限选择失败回传可见文本及 `data-testid` 候选，便于 CDP 定位下一次漂移。

### 发现路径与占位符

- ZCode/TraeWork 内置发现目录统一为 `{PROGRAMFILES}` / `{PROGRAMFILES(X86)}`（全大写）；
  自定义 profile 的环境占位符按**大小写不敏感**展开，未知占位符保留原样。

### 验收引擎 fail-closed（issue #7）

- **零用例判失败**：测试检查进程退出码 0 但输出明确报告 0 个用例 → 改判失败（此前假绿）。
- **零变更判失败**：git 项目默认要求相对动工前基线产生变更；纯问答/分析任务可在
  `.tianshu-mcp/acceptance.json` 设 `"requireChanges": false` 显式关闭。
- 回归覆盖：family 平铺模型、旧版分组兜底、testid 诊断、项目点击被吞、composer 绑定与回读重试、
  零用例/零变更门禁（`test/unit/zcode-core.test.ts`、`test/integration/zcode-flow.test.ts` 等）。

---

## 9. 凭证与安全红线

- 仓库内**不含任何 token**；`~/.npmrc`、`~/.git-credentials`、`GITEE_ACCESS_TOKEN` 均为本机凭证，勿入库。
- `.gitignore` 隔离：`AGENTS.md`、`.zcode/*`、`.codex/*`、`.rivet/*`、`tianshu-mcp-web/`（整目录，含内嵌 git 仓库）、
  `analysis-tools/*`、`/.tianshu-mcp/*`、`node_modules/*`、`dist/*`、`*.tgz`、`.tmp-check/`。
- 发布需要：npm `_authToken`（账号 `lotteai`）、GitHub token（`~/.git-credentials`）、`GITEE_ACCESS_TOKEN`（仓库 Secret，Gitee 发行版自动化用）。
- 安全模型与私密报告渠道见 `SECURITY.md`。

---

## 10. 文档地图

| 文档 | 内容 |
|---|---|
| `README.md` / `README.en.md` | 项目总览、快速开始（含天枢界面配置）、文档索引 |
| `CHANGELOG.md` / `.en.md` | 版本历史 v0.1.0 → v0.3.3（含比较链接） |
| `CONTRIBUTING.md` / `.en.md` | 开发环境、门禁、规范、提交/发布流程、如何新增 agent |
| `SECURITY.md` / `.en.md` | 安全模型与漏洞报告 |
| `CODE_OF_CONDUCT.md` / `.en.md` | 行为准则 |
| `docs/tianshu-integration.md` / `.en.md` | 接入配置、冒烟步骤、FAQ |
| `docs/traework-cdp.md` / `.en.md` | TraeWork GUI 驱动原理、选择器、安全红线、踩坑记录 |
| `docs/zcode-cdp.md` / `.en.md` | ZCode GUI adapter、暂停继续、返修闭环与双平台真机证据状态 |
| `docs/codex-gui-cdp.md` / `.en.md` | Codex 桌面端 GUI 驱动：MSIX COM 激活、CDP 接管、选择器、运行检测、验收返修 |
| `docs/codex-windows-smoke.md` / `.en.md` | Codex Windows 真机验收记录（含失败→计划→返修闭环） |
| `docs/zcode-windows-smoke.md` / `.en.md` | ZCode Windows 真机开发、同会话返修与提问续跑验收记录 |
| `docs/agent-profiles.md` / `.en.md` | profile 字段说明（含 `driver`/`gui`/`stallTimeoutMs`/`cancelWaitMs`） |
| `docs/adapter-matrix.md` / `.en.md` | 各 agent 能力调研矩阵 |
| `docs/acceptance-config.md` / `.en.md` | 项目级验收配置规范（含 `requireChanges`） |
| `docs/release-v0.3.3.md` / `.en.md` | v0.3.3 发布说明（ZCode 3.11.2 适配 + 验收 fail-closed，issue #4/#7） |
| `docs/release-v0.3.2.md` / `.en.md` | v0.3.2 发布说明（等待用户检测 + 取消真停 GUI，issue #5/#6） |
| `docs/release-v0.3.1.md` / `.en.md` | v0.3.1 发布说明（技能文档重写 + 发布自动化修复） |
| `docs/release-v0.3.0.md` / `.en.md` | v0.3.0 发布说明（Codex 桌面端 GUI 适配，含 BREAKING） |
| `docs/release-v0.2.0.md` / `.en.md`、`docs/release-v0.1.5…v0.1.10.md` / `.en.md` | 历史版本发布说明 |
| `docs/issue-1-host-reconnect-record.md` | issue #1 桌面宿主重连验收（v3.16.1：10 tools + 真实工具调用） |
| `docs/npm-publish-guide.md` | npm 发布步骤与凭证 |
| `docs/m2-*.md`、`docs/host-integration-record.md`、`docs/dod7/dod8-*`、`docs/s7-session-recheck.md` | 历史里程碑物证（中文，无英文版） |
| `skills/tianshu-mcp/SKILL.md` + `skills/tianshu-mcp/usage-examples.md` | 教天枢编排本 MCP 的技能与使用示例（随包分发、启动自检安装） |

> **本地 only（gitignore，不在仓库）**：`.zcode/plans/tianshu-mcp-development-plan.md`（总开发计划）、
> `.zcode/plans/traework-gui-adapter-plan.md`（TraeWork GUI 计划，M1–M5 已完成）、`.codex/review/`（验收报告）。

---

## 11. 接手人下一步建议

1. 先跑 `npm ci && npm run typecheck && npm run lint && npm test && npm run build`，确认基线绿（366/366）。
2. 动 GUI adapter 相关代码前，先读对应文档与本文小节：
   TraeWork → `docs/traework-cdp.md` + §8.1/§8.2；ZCode → `docs/zcode-cdp.md` + §8.5；Codex → `docs/codex-gui-cdp.md` + §8.4。
   项目文件夹绑定出问题时，先看 §8.1 的排障顺序（下拉项 ≠ 项目 map、三处已修缺陷、两个定位陷阱）。
3. **改任何选择器交互必须真机复验**：trusted 点击与 DOM click 的取舍因控件而异（§8.4 的模型菜单 vs 项目触发器就是反例）。
4. 若客户端 UI 升级导致选择器失效：用 `scripts/probe-*.mjs` 诊断，优先用 profile `gui.selectors` 覆盖，不改代码。
5. ZCode 与 Codex 的 macOS 真机闭环均未完成：证据未齐前不得把内置 profile 从 `research` 改为 `ready`。
6. 新增 agent：优先只加 profile（见 `docs/agent-profiles.md`）；需要特殊输出解析再写 adapter。
7. 发版前务必确认 `src/version.generated.ts` 与 `package.json` 同步提交（CI 有「构建后无 tracked diff」门禁）；
   推 `v*` tag 即触发 Release（双语正文取 `docs/release-v<ver>.md` + `.en.md`，**缺文档会直接失败**）。
8. 未发布计划（见 `CHANGELOG.md` [未发布] 节）：更多 agent 适配、TraeWork/ZCode/Codex macOS 验证、
   项目级技能播种、`needs_user` 状态取消时经临时 CDP 连接尽力停止 GUI 内等待中的会话。
