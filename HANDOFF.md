# HANDOFF.md — 项目交接说明

> **交接快照：2026-09-15 · 版本 `0.5.3`（tag `v0.5.3`，npm / GitHub / Gitee 均已发布）**
> 本文写给**接手本仓库的人**：先说清「这是什么、现在到哪一步」，再给出「怎么跑、怎么改、哪里会踩坑」。
> 工作区规则见 `AGENTS.md`（gitignore，仅本地）；安装与用法见 `README.md`，本文不重复，只做导览与状态记录。

---

## 0. 五分钟上手

| 你想做什么 | 看哪节 |
|---|---|
| 搞清这是什么、为什么这么设计 | §1 |
| 看系统分层、模块边界、运行流程与扩展点 | **[ARCHITECTURE.md](ARCHITECTURE.md)**（独立架构文档） |
| 看当前状态（版本 / 测试 / CI / agent 适配） | §2 |
| 看演进过程与踩过的坑 | §3 |
| 改 GUI adapter 前必须知道的结构 | §4 架构、§5 硬性红线 |
| 跑起来 / 日常迭代 / 诊断 | §6 |
| 出问题了怎么查 | §9 专题排障（先看 §9.0 症状索引） |
| 找某份文档 / 下一步做什么 | §11 / §12 |

**验证基线**（一条命令，期望全绿）：

```bash
git clone https://github.com/lanlan0811/tianshu-mcp.git && cd tianshu-mcp
npm ci && npm run typecheck && npm run lint && npm test && npm run build   # 期望 532 passed / 10 skipped
```

---

## 1. 这个项目是什么

`tianshu-mcp` 是一个**被天枢（Tianshu）当作标准 MCP server 接入的编排层**：天枢是总指挥，本 server 负责**调度 + 执行面 + 客观验收仪**，驱动外部 AI-Agent 完成闭环：

```text
项目开发 → 验收 → 失败返修 → 再验收
```

- **天枢官方仓库**：<https://github.com/huiliyi37/Tianshu-harness>（基于 harness 工程的终端编程智能体运行时，TUI × GUI；Apache-2.0）
- **本仓库**：`github.com/lanlan0811/tianshu-mcp`（主）｜`gitee.com/lan0811/tianshu-mcp`（镜像）
- **npm**：`tianshu-mcp`（当前发布版本 `0.5.3`）
- **工具面**：11 个 MCP 工具（`run_task / continue_task / query_task / list_tasks / get_task_report / cancel_task / verify_task / rework_task / get_profiles / prepare_visual_baseline / approve_visual_baseline`）

### 为什么是这样设计的（四个硬约束，改架构前必读）

本项目的形态由四条**实测硬约束**决定：

1. **天枢的 MCP 工具只回文本**：MCP 响应里 `content[]` 的 `text` 项被拼成字符串，`isError` 透传。因此所有结果统一为「人类可读文本 + `---tianshu-mcp-meta---` JSON 块」，不依赖 resources/prompts。
2. **天枢按次同步调用 `tools/call`**：长任务必须异步化 → `run_task` 秒回 `taskId`，用 `query_task` 轮询。
3. **TraeWork 的 agent 请求在 TTNet 层 TDE 加密**，无法在客户端外构造 → 唯一可行路径是 CDP 驱动其桌面 UI，从 DOM 提取结果。
4. **Codex 桌面端是 MSIX 商店包**：GUI 宿主无法 `CreateProcess` 直启（AppX 策略拒绝），必须经 `IApplicationActivationManager` COM 激活并注入专属 `--user-data-dir` 才能开 CDP 端口 → 见 `docs/codex-gui-cdp.md`。

---

## 2. 交接快照

| 项 | 状态 |
|---|---|
| 分支 | `master`（**只在此分支提交**，不建其他分支） |
| 版本 / 许可证 | `0.5.3` / Apache-2.0 |
| 标签 | `v0.1.0` … `v0.5.3`（均已推双仓） |
| 工作树 | 干净；`github/master` 与 `gitee/master` 均同步（发布提交见 `git log` 的 `chore(release): v0.5.3`） |
| 测试 | **532 passed / 10 skipped**（58 个测试文件：单元 37 + 集成 20 + 协议 1） |
| 门禁 | lint 0 warning、typecheck clean、build 成功且构建后无跟踪差异、`check:stdio` 6/6 场景通过、`npm pack` 内容校验与干净消费者安装通过 |
| CI | `build-test`（ubuntu/windows/macos × Node 20/22/24）+ `pack-check`，另加 `visual-browser` 真实浏览器矩阵（ubuntu/windows + macos-15-intel/macos-15 × Node 20/22/24）；随 v0.5.3 tag 全绿 |
| npm | `tianshu-mcp@0.5.3` 已发布（`latest`）；`npx -y tianshu-mcp` 即为该版本。发布步骤见 `docs/npm-publish-guide.md` |
| GitHub Release | 推送 `v*` tag 触发 `.github/workflows/release.yml`：先跑完整门禁并校验「tag 版本 === package.json 版本」，正文由 `docs/release-v<ver>.md` + `.en.md` 双语合成（缺文档即报错，不产出空壳正文），**要求同 SHA 的成功 CI**，并附 `tianshu-mcp-<ver>.tgz` |
| Gitee 发行版 | 由 `scripts/gitee-release.mjs` 用仓库 Secret `GITEE_TOKEN` 幂等补齐；**缺少凭据时工作流阻塞**（不再静默跳过、不冒充发布成功） |

### 2.1 Agent 适配现状

| agentId | driver / adapter | status | 说明 |
|---|---|---|---|
| `codex` | `gui` / `codex-gui` | **ready**（darwin 为 `research`） | Codex 桌面端 GUI（Windows：MSIX COM 激活 + CDP；macOS：spawn .app + CDP），支持 `model`/`reasoningLevel`/`planDoc`/`designSystem`；等待用户检测、取消真停、重派护栏均已真机验证（v0.3.2）；macOS 基本闭环已真机验证（2026-09-13，见 `docs/codex-gui-cdp.md`），取消/返修矩阵未齐故 darwin 保持 `research` |
| `zcode` | `gui` / `zcode-gui` | **research**（常量，非平台分支） | CDP GUI adapter，Windows 真机闭环通过；已适配 ZCode 3.11.2 模型菜单与项目绑定（v0.3.3）、项目/模型回读加固与初始化恢复（v0.3.4）；**无项目派发（`default` 工作区，`projectPath` 可选）与 `allowCreateProject` 自 v0.5.2 起支持**（issue #12，Windows 真机验收）；v0.5.3 修复实例跨 server 驻留、新建任务切页与发送失败归因三个真机缺陷。macOS 基本闭环已真机验证（`docs/zcode-cdp.md`），但无项目派发仅在 Windows 实测、取消/返修/新建项目矩阵未齐，故 `status` 保持常量 `research` |
| `traework` | `gui` / `traework-gui` | **ready** | CDP 驱动 TRAE SOLO CN 桌面 UI；三种面板模式真机验证通过。注意 `status` 为常量 `ready`，但 **macOS 分支仍 fail-closed**（可执行探测与原生对话框驱动未在 macOS 实测） |
| `codex-cli` | `spawn`（用户自建 profile，非内置） | 用户配置 | 无头路径走 `codex exec`；`model` 参数对其不生效（用 `~/.codex/config.toml`）；CLI 需 ≥0.154.0（≤0.130.0 签名证书已吊销）。`get_profiles` 自 v0.4.0 起会列出用户自定义 profile |
| `stub` | `spawn` | 仅测试 | `test/stub-agent/stub-agent.mjs` 三剧本（good/fix-on-first/never） |

---

## 3. 里程碑与实现期关键修复

### 3.1 里程碑

| 里程碑 | 主题 | 版本 | 测试 |
|---|---|---|---|
| M1 | 核心引擎 + stub-agent 全链路（状态机 / 队列 / 并发闸 / 验收引擎 / fix-loop） | — | 53 |
| M2 | 真实 Codex CLI 冒烟 + rework 闭环；修复 3 个真实缺陷 | — | — |
| M3 | TraeWork 调研 → 定论「无无头 CLI」；npm 首发；天枢宿主真实接入（DoD #6） | `0.1.1` | — |
| R1–R8 / S1–S6 | 两轮验收整改（取消 / 超时 / 基线归因 / 参数语义 / 热加载 / CI 加固） | — | 72 |
| M4 | TraeWork GUI 驱动接入（CDP）——`driver=gui` 落地，真机 e2e 通过 | — | 153 |
| M5 | 面板模式切换（Work/Code/Design）+ README 重写 / SVG 资产 | `0.1.5` | 167 |
| M6 | 项目文件夹绑定修复（footer 确认弹窗 / 检测预算 / CJK 路径 WM_SETTEXT / Code→Work 兜底） | `0.1.6` | 172 |
| M7 | 绑定**根因**修复（规范化路径被原生选择器拒绝 → `toNativeWindowsPath`）+ 写入回读 / hwnd 贯穿 / 遗留对话框清理 | `0.1.7` | 178 |
| M8 | 原子写并发缺陷修复（临时文件名唯一化 + rename 退避重试；CI windows/Node20 真根因） | `0.1.8` | 181 |
| M9 | TraeWork 任务进行中检测（权威运行信号 + 空闲计时 + CDP 断线收敛 + 异常保留实例） | `0.1.9` | 196 |
| M10 | stdio 日志污染修复（issue #1：Logger 全级别改走 stderr + 严格 stdio 门禁 + Node 24 + 安装包协议门禁） | `0.1.10` | 202 |
| M11 | ZCode GUI 统一闭环（独立 `zcode-gui` CDP adapter + 精确项目/模型/完全访问 + `needs_user`/`continue_task` + 同会话返修） | `0.2.0` | 262 |
| M12 | Codex 桌面端 GUI 适配（MSIX COM 激活 + CDP；模型 + 思考强度；项目自动登记；验收失败自动生成计划并返修）**破坏性**：`agentId=codex` 由无头 CLI 改为 GUI | `0.3.0` | 340 |
| M13 | 技能文档对齐 + 发布自动化修复（SKILL/usage-examples 重写、双语 Release 正文、Full Changelog/CI 链接、Gitee 发行版自动化） | `0.3.1` | — |
| M14 | Codex 等待用户检测 + 取消真停 GUI（issue #5/#6，详见 §9.4） | `0.3.2` | — |
| M15 | ZCode 3.11.2 适配 + 验收引擎 fail-closed（issue #4/#7，详见 §9.5） | `0.3.3` | 366 |
| M16 | ZCode 项目/模型回读加固 + 初始化共同截止时间恢复 + 无锚点会话发送确认（issue #8/#9/#10，详见 §9.6） | `0.3.4` | **407** |
| M17 | macOS 双驱动打通（codex/zcode）+ `projectPath` 安全闸门 + 验收并行与事件循环性能工程（社区 PR #11，见 §2.1 与 `docs/release-v0.4.0.md`） | `0.4.0` | **443** |
| M18 | 技能文档对齐 v0.4.0 工具面 + 双语 README 贡献者名录；无代码行为变更 | `0.4.1` | 443 |
| M19 | **可选视觉验收模块**：页面截图对比 + 静态图片规格 + 基准两阶段批准 + 规则冻结 + 离线 HTML + 两个 MCP 工具与 `visual` CLI 子命令族（详见 §9.8 与 `docs/release-v0.5.0.md`） | `0.5.0` | **486** |
| M20 | 技能/验证文档对齐代码实况 + 平台证据归档（Windows 10 矩阵 9/9、macOS 双架构 51 用例）+ 锁文件版本同步；**无运行时行为变更** | `0.5.1` | 486 |
| M21 | **ZCode 无项目派发（issue #12）**：`run_task.projectPath` 变可选、`allowCreateProject` 关闸、项目触发器就绪判据统一（详见 §9.9） | `0.5.2` | **525** |
| M22 | **ZCode 真机回访修复（issue #12 第二轮）**：GUI 实例跨 server 退出驻留、新建任务不切页导致静默空等、发送失败归因误导（详见 §9.9） | `0.5.3` | **532** |

### 3.2 实现期修复记录（都是真机/CI 逼出来的，改相关代码前先读）

| # | 里程碑 | 现象 | 根因 → 修复 | 回归 |
|---|---|---|---|---|
| 1 | — | `rework_task(feedback)` 后返修轮拿不到 feedback，卡在 `failed` | 终态快照先落盘、调用方后写 `reworkFeedback`，被上一轮收尾的 `delete` 抹掉 → 改为 `startTask` 启动时**原子取走并清空** | `test/integration/rework-feedback-race.test.ts` |
| 2 | M6 | 项目文件夹绑定卡住（实战反馈） | 三处叠加缺陷：footer 点击未确认弹窗、检测被 PowerShell 冷启动吃光预算、CJK 路径被控制台代码页破坏（详见 §9.1） | 相关集成/单元测试 |
| 3 | M7 | 上述仍未根治 | **真根因**：MCP 传 `normPath()` 规范化路径（`d:/a/b`），Windows 原生选择器不接受 → `toNativeWindowsPath()` 转 `D:\a\b`（详见 §9.1） | — |
| 4 | M8 | CI windows/Node20 偶发失败 | `writeJsonAtomic`/`writeTextAtomic` 临时文件名 `<目标>.<pid>.tmp` 并发共用 → `ENOENT`/`EPERM` → 随机后缀 + rename 退避重试 | `test/unit/atomic-write.test.ts` |
| 5 | M9 | 长思考被提前判完成 | 稳定 36 秒不再等同完成；停止按钮与 loading task tail 优先于完成标志，静态确认后等默认 10 分钟才返回 `idle`（详见 §9.2） | `test/unit/traework-liveness.test.ts` 等 |
| 6 | M10 | 严格 MCP 客户端握手/调用失败（issue #1） | 旧 `Logger` 只有 ERROR 走 stderr，INFO/WARN/DEBUG 与 JSON-RPC 共用 stdout → 全级别统一 stderr（详见 §9.3） | `test/unit/log.test.ts` + `scripts/check-stdio.mjs` |
| 7 | M14 | Codex 停在等待用户界面时死锁 `running`；`cancel_task` 只停 MCP 侧 | 停止按钮恒可见被当绝对运行信号；取消「请求即成功」→ stall 兜底转 `needs_user(user_confirmation)`、取消经 CDP 点击停止 + 有界等待、派发前 `instance_busy` 护栏（详见 §9.4） | `test/integration/codex-flow.test.ts` |
| 8 | M15 | 模型菜单/项目绑定判据漂移；验收零用例、零变更假绿 | 3.11.2 把 provider 分组改为 family；绑定入口改为 composer 复选项 → 新旧双兼容 + 直选优先 + 回读重试；验收引擎 fail-closed（详见 §9.5） | `test/unit/zcode-core.test.ts` 等 |
| 9 | M16 | #8/#9/#10：项目/模型回读误判、原生探测超时不协调、无锚点恢复丢会话与上下文 | 触发器逐级定位 + 完整路径绑定；模型解码稳定属性并排除旧值；初始化共用截止时间预算；无锚点恢复补发完整任务/上下文/引用并以标记定位会话（详见 §9.6） | `test/unit/zcode-recovery.test.ts`、`zcode-dom.test.ts`、`zcode-dialog.test.ts`、`test/integration/zcode-flow.test.ts` |
| 10 | M16 | 首次推送后 macOS CI 全红（Windows/Ubuntu 全绿） | 集成测试「添加项目首次点击被吞」未 mock `listDialogs`，触达真实 `listOwnedDialogs`；其 darwin 分支改为 fail-closed 后于无 ZCode/辅助功能授权的 runner 上抛错 → 给 `depsFor` 补 hermetic `listDialogs` 默认桩 | `test/integration/zcode-flow.test.ts` |
| 11 | M17 | Windows 上盘符根未被 `projectPath` 闸门拦截（`assertSafeProjectDir("C:/")` 不抛错） | `normPath` 剥尾斜杠：`D:\` → `d:`，与清单里的 `d:/` 永不相等（死条目）→ 改为单独判定盘符根，覆盖所有盘符 | `test/unit/project-dir-guard.test.ts` |
| 12 | M17 | `project-dir-guard` 的系统目录断言在 Windows 红 | `/etc`、`/usr` 是 POSIX 路径，Windows 命中的是「目录不存在」→ 加平台守卫，Windows 侧改验盘符根与 `C:/Windows` | `test/unit/project-dir-guard.test.ts` |
| 13 | M17 | `acceptance-parallel` 取消用例偶发（单跑绿、全量红；CI 两次重试都红） | 固定 250ms 在慢平台可能早于子进程 spawn，在途 check 被误记为 `skipped` → 等两个在途 check 真正启动（各自 touch 标识文件）后再取消 | `test/unit/acceptance-parallel.test.ts` |
| 14 | M19 | 视觉基准批准可被并发覆盖 / 候选被篡改 | 候选摘要、原基准摘要、配置摘要三向核对 + 项目级锁；候选改、原基准变、跨项目候选一律拒绝 | `test/unit/visual-baselines.test.ts` |
| 15 | M19 | 视觉阻塞任务被 `rework_task` 直接拉 agent 返修，浪费轮次 | 引入 `pendingVisualVerification`：阻塞任务恢复时**先重新验收**，通过即结束，仅真实缺陷才进返修 | `test/integration/visual-rework.test.ts` |
| 16 | M19 | 取消期间视觉操作异常被误记 `needs_attention` | 启动阶段捕获视觉完整性错误时先判 `this.aborted()`，取消路径优先落取消终态 | `test/unit/zcode-recovery.test.ts` + 视觉用例 |
| 17 | M20 | `package-lock.json` 根包版本滞后（v0.5.0 时为 `0.4.1`） | 发布时未同步锁文件 → `npm version --no-git-tag-version` 并提交锁文件 | CI「构建后无 tracked diff」+ 发布清单 |
| 18 | M21 | 无项目派发在真实 `run_task` 被 SDK 拒成 `-32602 Required at projectPath`（单元测试全绿） | handler 已支持无项目分支，但 `RunTaskParamsSchema.projectPath` 仍是必填；单测直接调 handler 绕过了 `inputSchema` → 改 `AbsPath.optional()` + 协议层回归用例 | `test/integration/task-flow.test.ts` |
| 19 | M21 | 无项目派发永久停在 `needs_user/setup_recovery` | 「新建任务」继承上次项目绑定；且项目菜单**已打开**时点击触发器被 Radix toggle 反噬 → 新增 `workOutsideProject` 选择器与 `enterDefaultWorkspace()` 显式切换，点击前先查菜单状态 | `test/unit/zcode-dom.test.ts`、`test/integration/zcode-flow.test.ts` |
| 20 | M22 | ZCode 一退出 MCP server 就被连坐杀掉，`needs_user` 提示的窗口已不存在 | `zcode`/`codex` 按平台分支 spawn（`detached: process.platform !== "win32"`），Windows 上子进程不驻留（实测存活 0） → 收敛为 `guiInstanceSpawnOptions()`，三处 GUI 实例共用；执行型子进程仍按平台分支 | `test/unit/gui-instance-spawn.test.ts` |
| 21 | M22 | 顶部「新建任务」返回 `true` 却不切页，随后空转 30 秒只报 `setup_recovery` | `conversation-new-task` 是惰性挂载图标，会话页 composer **不挂载** `composer-workspace-trigger` → 以「触发器已挂载」验证草稿真的建立，失败回退侧栏 `task-new-button`，两者都失败才 `setup_failed` | `test/integration/zcode-flow.test.ts` |
| 22 | M22 | 窗口被遮挡时的发送失败文案把用户引向按钮 | Chromium 节流（`visibilityState=hidden`）使按钮在视口内却点不到 → 识别该状态并报「窗口不在前台」+ 置于前台的操作指引；`Page.bringToFront` 实测无法恢复被遮挡的 Electron 窗口，不假装能自动恢复 | `test/integration/zcode-flow.test.ts` |

---

## 4. 架构与模块导览

> 本节是**面向交接的快速导览**（目录 + 两条执行面 + 三个 GUI driver 的执行顺序）。
> 系统分层、模块边界、状态机全貌、验收流水线、跨平台策略与扩展点的**完整架构说明见 [ARCHITECTURE.md](ARCHITECTURE.md)**（英文版 [ARCHITECTURE.en.md](ARCHITECTURE.en.md)）。

```text
src/
├── index.ts              入口（stdio；CLI 子命令在建立 stdio 连接前分流）
├── server.ts             组装：配置 / 日志 / 管理器 / 引擎 / 注册表 / 工具注册 / 技能自检安装
├── version.generated.ts  构建期由 scripts/sync-version.mjs 从 package.json 生成（勿手改）
├── config/
│   ├── schema.ts         zod 全集（工具入参、profile、projects、验收配置、TraeworkMode）
│   └── store.ts          数据目录读写 + last-known-good 热加载
├── mcp/
│   ├── tools.ts          11 个工具的元数据（capability / requireApproval）
│   ├── handlers.ts       工具实现
│   ├── context.ts        meta → TaskContext（含 resume / continue 语义）
│   └── formatter.ts      文本 + meta 块
├── tasks/                状态机、每项目串行队列、全局并发闸、事件流落盘
│   └── task.ts / task-manager.ts / task-store.ts
├── loop/
│   ├── fix-loop.ts       单任务编排（自动返修循环；含视觉冻结核对与阻塞恢复）
│   └── repair-plan.ts    验收失败时生成修复计划文件（MCP 任务目录）
├── agents/
│   ├── adapter.ts        AgentAdapter 接口（含可选 run() 执行面）
│   ├── registry.ts       按 profile.adapter/driver 构造 Cli/TraeWork/ZCode/Codex adapter
│   ├── cli.ts / spawn.ts 通用 CLI adapter / 子进程封装（windowsHide、管道、超时、kill tree）
│   ├── builtin.ts        内置 profiles（codex / zcode / traework）
│   ├── traework/         TraeWork GUI 驱动
│   │   ├── adapter.ts / run.ts / launcher.ts
│   │   ├── cdp/{client,selectors}.ts
│   │   ├── ui/{session,composer,model,reply}.ts
│   │   └── computeruse/{guard,dialog}.ts
│   ├── zcode/            ZCode GUI 驱动（v0.2.0 起）
│   │   ├── adapter.ts / run.ts / instance.ts / recovery.ts
│   │   ├── cdp.ts / dom.ts / selectors.ts / discovery.ts / dialog.ts
│   │   └── model.ts / project.ts / references.ts / liveness.ts
│   └── codex/            Codex 桌面端 GUI 驱动（v0.3.0 起）
│       ├── adapter.ts / run.ts / instance.ts / liveness.ts
│       ├── discovery.ts（Appx 查询 + 扫盘回退）/ launcher.ts（COM 激活）
│       ├── cdp.ts / selectors.ts / input.ts / model.ts / dialog.ts
│       └── project.ts（自动登记）/ registry.ts / fixplan.ts / verify.ts
├── visual/               可选视觉验收模块（v0.5.0 起；未启用时不影响既有行为）
│   ├── schema.ts / defaults.ts / config.ts / runtime.ts / errors.ts
│   ├── engine.ts / capture.ts / compare.ts / images.ts
│   ├── services.ts / budget.ts / paths.ts / lock.ts / snapshot.ts / types.ts
│   ├── baselines.ts / manage.ts / report.ts / cli.ts
│   └── （动态依赖 sharp / pixelmatch / puppeteer-core，缺失时明确阻塞而非静默降级）
├── verify/               验收引擎（命令检查 + 代码分析 + git 基线 + 报告）
│   └── acceptance.ts / runner.ts / exec.ts / signals.ts
│       code-analysis.ts / git-baseline.ts / report.ts
└── util/                 日志、路径、文件、超时、id、技能安装
    └── log.ts / path.ts / fs.ts / timeout.ts / id.ts / skill-install.ts
```

### 4.1 两条执行面（`driver`）

| driver | 执行方式 | 结果判定 |
|---|---|---|
| `spawn`（默认） | 拉起外部 CLI 子进程 | 退出码 |
| `gui` | CDP 驱动桌面 UI，**不 spawn**（Codex/ZCode 的进程启动除外——为注入调试端口而启动，但仍以 UI 信号判定） | 运行信号优先 → DOM 完成标志 → 稳定确认后的空闲计时 → stall / 任务超时 |

`TaskOrchestrator.runAgentOnce` 的分支逻辑：`adapter.run` 存在 → 调用它；否则走 `runChild`。**这是唯一需要理解的双路径接缝。**

### 4.2 三个 GUI adapter 的执行顺序（实测结论，勿随意调整）

**TraeWork**（详见 §9.1 / §9.2）：

```text
确保实例可用 → 等待 UI 就绪 → 新建会话 → 切到目标模式 → 在目标模式内绑定项目 → 切模型 → 发送 → 轮询到完成
```

> **关键事实**：TraeWork 的 Work/Code/Design **各自维护独立的项目绑定**，切换模式会把输入栏项目换成该模式上次使用的项目。
> 因此必须先切模式、再在目标模式里绑定项目；绑定后复核「模式 + 项目」双双就位，任一不符即响亮失败。

**ZCode**（详见 `docs/zcode-cdp.md` 与 §9.5 / §9.6）：

```text
发现安装 → 启动/复用 CDP 实例（共同截止时间预算） → 绑定项目（触发器逐级定位 + 完整路径判据）
  → 选模型（直选优先，provider/family 分组兜底，回读解码稳定属性） → 完全访问权限
  → 发送（按钮就绪检查 → 标记/会话差集定位） → 运行检测/提问检测 → 轮询到完成
```

> 提问、登录页、旧实例无 CDP、macOS 辅助功能权限、自动恢复未完成分别转
> `agent_question` / `login_required` / `needs_user(close_existing_instance)` / `system_permission` / `setup_recovery`，由 `continue_task` 恢复。

**Codex**（详见 `docs/codex-gui-cdp.md` 与 §9.4）：

```text
MSIX 发现（Appx 查询优先 + 扫盘回退） → COM 激活 + 专属 user-data-dir + CDP 端口 → 项目登记/绑定
  → 选模型与思考等级 → 发送（planDoc/designSystem 拼进初始指令） → 运行检测（停止按钮 + 对话哈希 stall） → 轮询到完成
```

> 停在「等待用户确认」界面（方案确认卡 / 订阅结账页）→ stall 判定转 `needs_user(user_confirmation)`；
> 用户处理完后 `continue_task` 重新观察（不重发消息）；`login_required` 则复检环境后重派任务书。

### 4.3 视觉验收的一条独立链路（v0.5.0 起）

```text
项目 .tianshu-mcp/acceptance.json 配 visual.enabled=true
  → run_task/verify_task 在命令检查之后追加视觉检查（不需要新工具）
  → 动工前冻结「视觉配置摘要 + 基准摘要」，每轮前后核对（变动即 VISUAL_INTEGRITY 阻塞）
  → 页面：三类来源（existing/command/static）+ 声明式步骤 + 稳定化采样 + 显式屏蔽 → 与已批准基准像素对比
  → 图片：显式文件清单 + 编码/尺寸/DPI/透明度规格校验
  → 缺陷按 autoFixRounds 返修；阻塞（缺基准/不可达/资源被拦/不稳定）→ needs_attention
  → rework_task 对阻塞任务先重新验收，不先启动 agent
```

基准必须两阶段：`prepare_visual_baseline`（只生成候选）→ 用户审阅后 `approve_visual_baseline`（核对三向摘要再原子写入）。
**缺基准不得判通过，自动返修禁止调用批准入口。**

---

## 5. 硬性红线（违反 = 运行时损坏或事故）

1. **绝不按进程树盲杀 TraeWork**：只终止本模块创建、且命令行核对通过的 PID，且不带 `/T`。
   事故来源：验证期 `taskkill /PID <pid> /T /F` 误杀用户正在使用的实例（数据完好，已恢复）。见 `docs/traework-cdp.md §6`。
2. **默认复用用户实例**：`gui.windowMode="reuse"`，绝不新起第二个（Codex/ZCode 以专属 user-data-dir 启动的受管实例除外，且不触碰用户手动打开的实例）。
3. **computer-use 白名单**：仅允许 TraeWork 文件夹选择对话框（窗口标题 + 宿主进程双校验），其他窗口一律 `COMPUTER_USE_DENIED`。
4. **凭证零管理**：不读取/解密/转发任何 agent 凭证；GUI adapter 只驱动 UI。
5. **命令不拼 shell**：验收命令是结构化 argv，`shell:false`。
6. **不自动 commit/stash/回滚**：动工前采集 git 基线，报告相对基线计算。
7. **路径不硬编码**：机器路径 / 用户名 / 端口走 profile 或占位符（`{LOCALAPPDATA}`、`{PROGRAMFILES}` 等；展开大小写不敏感）。
8. **GUI 取消不得谎报**：`cancel_task` 对 GUI agent 必须尽力点击停止 + 在 `gui.cancelWaitMs` 内有界等待确认；
   未确认停止时终态必须明示「GUI 内运行未确认停止」。重派前必须确认受管实例空闲，否则以 `instance_busy` 拒绝（防 turn 交叠）。
9. **验收 fail-closed**：测试命令退出码 0 但输出显示零用例 → 判失败；git 项目默认要求相对基线产生变更
   （`requireChanges: false` 显式关闭）。不得为「让任务变绿」放松这两个门禁。
10. **路径闸门不得放宽**：`projectPath` 必须是存在的绝对目录，`realpath` 归一后落在主目录或系统/根级目录一律拒绝；盘符根由单独判定覆盖，不依赖枚举清单。
11. **视觉基准不得被自动化改写**：`approve_visual_baseline` 只能在用户明确授权后调用，且必须带 `expectedDigest` 与 `approvalNote`；
    自动返修路径禁止调用批准入口；不得修改基准/阈值/屏蔽区域或关闭规则来绕过失败（规则冻结会检出）。
12. **只在 `master` 提交，commit 用中文**；不建分支、不覆盖已有 tag。

---

## 6. 环境搭建、日常迭代与诊断探针

### 6.1 从零搭环境

```bash
git clone https://github.com/lanlan0811/tianshu-mcp.git
cd tianshu-mcp
npm ci
npm run build        # sync-version + tsc → dist/
npm test             # 542 项（532 passed / 10 skipped）
```

日常循环（改 `src/` 后）：

```bash
npm run typecheck && npm run lint && npm test && npm run build
# 通过后：git add . && git commit -m "中文说明" && git push github master && git push gitee master
```

### 6.2 本机环境事实（2026-09 探测，接手机器可能不同）

| 项 | 值 |
|---|---|
| Node | v24.18.0（`engines: >=20`，CI 覆盖 20/22/24；视觉模块要求 ≥20.3） |
| 天枢宿主 | `D:\Tianshu`（`tianshu-desktop.exe` + `rivet-runtime`） |
| Codex 桌面端（现用） | MSIX 包 `OpenAI.Codex`：`...\WindowsApps\OpenAI.Codex_<版本>_x64__<pfn>\app\ChatGPT.exe`；版本目录随更新变化 → Appx 查询优先 + 扫盘回退取最新 |
| Codex 内核 CLI（备用） | `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`；如需无头执行，另建 `driver=spawn` profile |
| TraeWork | `D:\TRAE Work CN\TRAE SOLO CN.exe`（v1.107.1）；CDP 需 `--remote-debugging-port=9222` 且窗口可见 |
| ZCode | Electron 桌面端；Windows 验收样本 `D:\Z-Code\ZCode\ZCode.exe`（由「D 盘优先 + 相对路径模板」发现，非硬编码）；CDP 需 `--remote-debugging-port`；3.11.2 语义已适配 |
| 本机浏览器 | 托管 Chrome `148.0.7778.97`（`~/.tianshu-mcp/browsers`）；本机 Microsoft Edge `144.0.3719.104` |
| 参考实现 | `D:\Trae项目\oh-dsh-trae-api`（TraeWork CDP 驱动机制的来源，含其自身 `HANDOFF.md`） |
| 数据目录 | 默认 `~/.tianshu-mcp`（env `TIANSHU_MCP_HOME` 可覆盖） |
| 技能安装 | `~/.rivet/skills/tianshu-mcp`（server 启动自检幂等安装） |

### 6.3 诊断探针与真机验证（**不入 CI**，需真实客户端在跑）

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

# 视觉验收：真实浏览器门禁用例（默认 skip，需显式开户）
TIANSHU_VISUAL_BROWSER_TEST=1 npx vitest run visual --maxWorkers=1
# 视觉验收：Windows 10 本机完整功能矩阵证据（9 项）
npm run evidence:visual:windows -- --out .tmp-check/visual-windows-matrix/evidence.json

# stdio 协议门禁（真实进程字节流校验，6 场景）
npm run check:stdio
```

### 6.4 发布流程（tag → CI → Release → npm）

```bash
# 1) 版本与文档：package.json / package-lock.json / src/version.generated.ts / CHANGELOG（中英）/ docs/release-v<ver>(.en).md / HANDOFF 快照
npm version <ver> --no-git-tag-version      # 同时更新 package.json 与 package-lock.json
npm run typecheck && npm run lint && npm test && npm run build   # 构建会同步 src/version.generated.ts，务必一并提交
git add . && git commit -m "chore(release): v<ver> ..." && git push github master && git push gitee master
# 2) 等该提交的 CI 全绿（release.yml 会复校 tag 版本 === package.json 版本，且要求同 SHA 的成功 CI）
git tag -a v<ver> -m "tianshu-mcp v<ver>" && git push github v<ver> && git push gitee v<ver>
# 3) npm（凭据在本机 ~/.npmrc；registry 已是 npmjs）
npm publish --registry=https://registry.npmjs.org --access public
```

> 坑 1：发布到 npm 后 registry 有数分钟传播延迟，`npm view` 会短暂返回旧版本或 E404，需轮询；
> 若 `npm publish` 返回 0 但查不到版本，先看 debug 日志是否 `PUT ... 202`（npm 11 异步发布流水线接受了上传），再轮询而非重发。
> 坑 2：发布说明文档若写「不发布 npm」，发布 npm 后必须同步改回，否则与实际不符（v0.3.4 发生过一次）。
> 坑 3：锁文件版本必须同步（v0.5.0 曾漏，见 §3.2 #17）。

---

## 7. 测试分层

| 层级 | 位置 | 说明 |
|---|---|---|
| 单元 | `test/unit/`（37 文件） | 纯函数与组件逻辑：traework 全套（reply / selectors / launcher / guard / driver / session / liveness / dialog / cdp-client / repair-plan）、codex-core、zcode-core / zcode-handler / zcode-dom / zcode-dialog / zcode-recovery、gui-instance-spawn、acceptance（含并行）、baseline（含归因 / 预脏）、atomic-write、log、config / profile 热加载、project-dir-guard、以及视觉模块（visual-config / images / baselines / report / runtime）等 |
| 集成 | `test/integration/`（20 文件） | stub-agent 三剧本、取消 / 超时 / 基线、traework 假 CDP（单轮 + 返修 + 绑定兜底）、codex-flow、zcode-flow / restart / rework-loop / default-workspace、rework 竞态回归、verify-params、task-flow、以及视觉（services / capture / flow / rework / browser-smoke） |
| 协议 | `test/protocol/`（1 文件） | 官方 SDK 客户端断言 11 工具面与返回格式 |
| 真机 | `scripts/probe-*.mjs` / `scripts/smoke-zcode.mjs` / `scripts/evidence-visual-windows.mjs` | **手动**，需真实客户端 / 已安装浏览器 |
| 消费者 | `scripts/check-visual-consumer.mjs` | 从生产 tarball 安装到无开发依赖目录后跑真实浏览器视觉验收与离线报告 |

**门禁纪律**（都在 CI 上翻过车）：

1. `test/fake-cdp.ts` 里**助手回复必须同步追加**（`autoReplyText`），不要改回定时器——轮询间隔小 + `stableRounds` 低时定时器会与稳定兜底抢跑。
2. 集成测试必须**隔离原生对话框枚举**：`depsFor` 的默认 `listDialogs` 桩不可省，否则会触达真实 `listOwnedDialogs`，其 darwin 分支 fail-closed，在无 ZCode/辅助功能授权的 runner 上直接抛错（M16 的 macOS CI 全红即此因）。
3. 真实浏览器用例默认 `skipIf(TIANSHU_VISUAL_BROWSER_TEST !== "1")`；CI 的 `visual-browser` 作业显式开户。本机验证记得带该环境变量，否则会看到「10 skipped」。
4. **已知偶发**：`test/integration/zcode-flow.test.ts` 的「任务总时限到达时停止 MCP 等待并保留实例」在满负载并行下有时序竞态（`taskTimeoutMs: 2` 与调度竞争），单文件运行与 CI 重试通过。改相关逻辑时注意别把它当成回归。
5. **已知偶发**：`test/integration/visual-capture.test.ts` 的「loads isolated Cookie/localStorage state and diagnoses expiration」偶发 `PAGE_UNREACHABLE`（导航到 `127.0.0.1` fixture 服务超时），实测**仅个别 job 失败、同 job 内其余视觉用例全过**（v0.5.3 后的文档提交 `8bd0598` 在 `macos-15 / Node 24` 上出现过一次，重跑即绿）。判据：若失败信息是 `PAGE_UNREACHABLE` 且 `blocked.size===0`，先重跑该 job 再怀疑回归。
6. **已知偶发**：`test/unit/acceptance-parallel.test.ts` 的「慢 check 并行：墙钟 < 串行之和」断言在**全量套件满载并行**时可能偶发失败（本机 2026-09-15 一次全量运行命中：`wallMs` 未小于 `sum`），**单文件运行稳定通过**（7/7）。原因是该用例以墙钟比较证明真并行，属负载敏感的时序断言。判据：若失败的是这条断言且单独重跑该文件即绿，按偶发处理，不要当成并行调度回归。

---

## 8. 已知限制（对接手人有直接影响）

- **TraeWork 窗口必须可见**：发送依赖模拟输入；且不能有第三方工具（如截图器）抢焦点。
- **单会话串行**：TraeWork 是单会话 UI，所有任务经串行队列；同项目任务被 `projectBusy()` 串行化。
- **完成判定依赖 UI 信号**：停止按钮 / loading task tail 存在时不结束；无运行信号才接受「由AI生成」。
  `stableRounds` 只启动 `idleTimeoutMs`（默认 10 分钟）空闲计时，不再把约 36 秒静态直接当完成。
- **异常结束保留实例**：`idle_no_completion` / `timeout` / `aborted` / `cdp_lost` 均不关闭现场；
  `query_task` meta 查看 `agentEndReason` / `keptInstance`。
- **UI 升级会漂移**：三个 adapter 的选择器分别集中在
  `src/agents/traework/cdp/selectors.ts`、`src/agents/zcode/selectors.ts`、`src/agents/codex/selectors.ts`，
  均可经 profile `gui.selectors` 覆盖；先用探针诊断。
- **macOS 部分验证**：Codex 与 ZCode 的 macOS 基本闭环（发现/启动/绑定/发送/观察/验收）均已真机通过
  （2026-09-13，分别见 `docs/codex-gui-cdp.md` 与 `docs/zcode-cdp.md`），
  但取消/返修/continue_task/新建项目矩阵未覆盖，二者 darwin 仍标 `research`；
  TraeWork 的原生对话框驱动与真机闭环仍未在 macOS 实测，macOS 分支保持 fail-closed。
- **`mode` 仅 TraeWork 生效**：ZCode / Codex 会拒绝该参数（返回明确错误）。
- **无项目派发仅 ZCode 且仅 Windows 实测**：`projectPath` 可选只对 ZCode 生效；macOS 上的无项目派发尚未真机验证（v0.5.3 已修掉 Windows 侧实例驻留、切页与归因三个缺陷，但 macOS 未覆盖）。
- **ZCode 未登记项目的自动导入在 Windows 上不可用**：需先在 ZCode 中手动登记目录，或传 `allowCreateProject=false` 让它显式失败。原因与修复方向见 §9.9。
- **Windows 上 GUI 实例跨 server 驻留已修复**（v0.5.3）：三处 GUI 实例统一走 `guiInstanceSpawnOptions()`（无条件 `detached` + `unref`）；执行型子进程（`verify/runner`、`visual/services`、`agents/spawn`）语义相反，仍按平台分支。
- **`continue_task` 仅 codex/zcode**：traework 与 spawn 类 agent 会被拒绝。
- **`needs_user` 状态下取消是已知边界**：MCP 侧无 CDP 连接，GUI 内等待中的会话停不掉；终态文案会提示。
  经临时 CDP 连接尽力停止 GUI 内会话列在 `CHANGELOG.md` 的「未发布 / 计划中」。
- **视觉模块的平台证据边界**：macOS 证据来自 CI 托管真机 runner（macOS 15 / Darwin 24.6.0，Intel x64 与 Apple Silicon arm64，Node 20/22/24），
  未在维护者个人 macOS 设备复验；Windows 10 矩阵覆盖 `scripts/evidence-visual-windows.mjs` 列出的项。详见 `docs/visual-validation.md` 与 `docs/visual-validation-evidence/`。
- **验收 fail-closed 对纯分析任务的影响**：git 项目默认要求产生变更；纯问答 / 分析任务必须在
  `.tianshu-mcp/acceptance.json` 设 `"requireChanges": false`，否则验收判失败。
- **npm 上的 README 停留在发布时**：之后新增的文档只在仓库里；如需同步到 npm 需再发版本。

---

## 9. 专题排障手册

### 9.0 症状 → 小节索引

| 症状 | 去 |
|---|---|
| 项目文件夹绑定卡住 / 下拉未命中 / 路径写入被破坏 | §9.1 |
| 任务长时间不结束，或长思考被提前判完成 | §9.2 |
| 严格 MCP 客户端握手失败 / 工具调用失败 / stdout 有杂音 | §9.3 |
| Codex 卡在「等待用户确认」/ `cancel_task` 没真停 | §9.4 |
| ZCode 模型菜单选不中 / 项目绑定判据漂移 / 验收假绿 | §9.5 |
| ZCode 项目或模型回读误判 / 原生面板超时 / 恢复后丢会话与上下文 | §9.6 |
| ZCode 无项目派发报参数错误 / 卡在 `setup_recovery` / 窗口被遮挡时发送失败 | §9.9 |
| 升级 v0.4.0 后行为变了 / 验收检查互相干扰 / 符号链接路径下历史任务「消失」 | §9.7 |
| 视觉验收不通过 / 基准待批准 / 规则被冻结判 `VISUAL_INTEGRITY` / 离线报告看不开 | §9.8 |

### 9.1 TraeWork 项目文件夹绑定排障（M6 / M7 实战教训）

**事实：下拉项 ≠ 项目 map**

| 数据源 | 说明 |
|---|---|
| 下拉列表（`readProjectItems`） | 来自 TraeWork **服务端**项目列表，实测本机 11–12 项 |
| `solo-lite.local-project-folders`（state.vscdb） | 仅本地**路径回填缓存**，实测 22–23 条 |

两者不是同一份数据。**「项目已在 map 里」不代表下拉能命中**——未命中仍会走原生对话框。
（曾误判为「项目已注册所以不该走对话框」，实测证伪。）

**三处叠加缺陷（2026-09-08 修复）**

1. **footer 点击未确认弹窗**：`element.click()` 返回 true ≠ 原生弹窗出现。
   旧代码只看返回值 → 日志报「等待原生对话框超时」（下游症状）。
   **修复**：点击后调 `findFolderDialog()` 确认，未出现则记录下拉 DOM 快照并明确失败。
2. **检测预算被 PowerShell 冷启动吃光**：实测冷启动 **4.5–6.3s/次**（UIA 与 Win32 都一样），
   旧代码 Node 侧每 800ms 轮询 → 15s 只够约 2 次。
   **修复**：单次 PowerShell 调用内轮询（400ms 间隔），预算 30s；`spawnSync` → 异步 `spawn`。
3. **CJK 路径被控制台代码页破坏**：实测 `D:\Trae项目\ts-bind-test` 被写成 `D:Traes-bind-test`。
   **修复**：改用 Win32 **`WM_SETTEXT`**（句柄由 UIA 提供）写编辑框。

**★ 真根因（M7 / v0.1.7）：路径形式不对**

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

**另外两个定位陷阱（已修）**

- **确认按钮 `AutomationId="1"` 不唯一**：文件列表行也用 0/1/2…。必须用
  **AutomationId=1 且 ControlType=Pane** 组合定位（实测误点到 `.rivet` 列表项）。
- **「文件夹」编辑框**：`AutomationId=1152` 且 **ClassName=`Edit`**（它是 Pane 类型、无 ValuePattern）。

**排障顺序（下次遇到卡住先做这几步）**

1. `node scripts/probe-traework.mjs selectors` —— 确认选择器是否命中。
2. 看任务日志 `<home>/tasks/<taskId>/agent-0.log`：区分「下拉未命中」「对话框未弹出」「写入失败」「确认失败」。
3. 手工验证对话框是否开着（UIA 枚举 TraeWork 窗口的 Descendants，见 `docs/traework-cdp.md`）。
4. **不要**用 TraeWork 的 `--folder-uri` / `-a` 预注册（已证伪：只写原生 `history.recentlyOpenedPathsList`，
   Solo 下拉不读它）；**不要**直写 `state.vscdb` 的 map（renderer 有内存缓存，且 key 需后端 `createProject` 分配）。

### 9.2 TraeWork 任务进行中检测（M9 / v0.1.9）

**信号优先级与选择理由**

1. 字面「思考中」先保持 `pending`；原生 `ask_user` 仍立即结束本轮。
2. `.chat-input-v2-send-button-stop-icon`（主）与 `.core-task-tail--loading`（次）是权威运行信号：
   任一可见时，即使 DOM 已有完成标志也必须继续等待，并清零稳定轮数 / 空闲计时。
3. `.thinking-stream-content` 与工具卡片只作诊断。它们会残留在历史消息，若作为阻塞条件会永久不结束。
4. 无运行信号时才接受「由AI生成」完成标志；无完成标志则在 `stableRounds` 轮静态确认后，继续静态
   `idleTimeoutMs`（默认 600000ms）才返回 `idle_no_completion`。

所有信号通过 `selectors.ts` 的主选择器、回退与 profile 覆盖解析。若 UI 升级导致全部新选择器未命中，
探针按 `running=false` **失败开放**，退回完成标志 + 空闲计时，避免选择器漂移造成永久卡死。

**CDP 与实例保留策略**

- CDP WebSocket `close` / `error` 会拒绝全部 pending；单次 `send()` 默认 15000ms 超时。
- 轮询观测与 abort、任务 deadline 竞争，取消最多约 1 秒生效；默认每 30000ms 发一条 `note` 进度事件。
- 只有 `completion_mark` / `ask_user` 会释放本模块启动的实例。
- `idle_no_completion` / `timeout` / `aborted` / `cdp_lost` 均保留实例，结果与任务 meta 写入
  `agentEndReason` / `keptInstance`。超时文案不再错误声称「进程树已终止」。

### 9.3 stdio 日志污染修复（M10 / v0.1.10，issue #1）

**事实与根因**

- MCP stdio 规范：**stdout 只承载合法 MCP JSON-RPC 消息**，诊断日志应写 stderr。
- 旧 `src/util/log.ts` 只有 `error` 走 `console.error`，`info`/`warn`/`debug` 走 `console.log`（stdout）。
  默认 INFO 阈值下，连接提示、技能自检、任务状态等都会污染协议流，且可延续到握手之后。

**修复与门禁**

- `src/util/log.ts`：所有通过阈值的级别统一 `console.error`（stderr），日志文件追加行为不变。
- `eslint.config.js`：`src/**/*.ts` 启用 `no-console`（仅允许 `error`），阻止再次直接写 stdout。
- `scripts/check-stdio.mjs`：真实子进程捕获完整 stdout/stderr，逐行用官方 `JSONRPCMessageSchema`
  校验，空行 / 非 JSON / parser error / 退出残留片段即失败；覆盖首次启动、再次启动、`--no-skill-install`、
  损坏 `config.json`、stub 任务运行期日志、EOF 关闭 6 场景。消费者安装 tarball 后复用同一脚本。

### 9.4 Codex GUI 状态脱节与取消（M14 / v0.3.2，issue #5/#6）

**等待用户检测（issue #5）**

- **现象**：Codex 停在「等待用户确认」界面（方案确认卡 / 订阅结账页等）时，turn 是暂停而非结束，
  但停止按钮仍可见——旧判定把「停止按钮可见」当绝对运行信号 → 任务死锁在 `running` 直到 30 分钟总超时。
- **stall 兜底**：停止按钮持续可见且对话哈希 `gui.stallTimeoutMs`（默认 5 分钟）不变 → 判定等待用户，
  任务转 `needs_user(user_confirmation)` 并回传可操作的 `pendingQuestion`；对话内容恢复变化会重置计时。
- **可配置界面检测**：`gui.selectors.userGate`（如结账页 `embedded-checkout`、确认卡选择器）命中即快速转
  `needs_user`；默认未配置 = 禁用，不内置未真机验证的选择器。

**恢复通道（`continue_task` 扩展支持 codex）**

| `needsUserKind` | 恢复行为 |
|---|---|
| `user_confirmation` | 用户在 Codex 窗口处理完后恢复；MCP 仅重新接入观察 GUI 内运行（**不发送消息**）；恢复前 turn 已完成也能正确判 `succeeded` |
| `login_required` | 复检环境后重新派发任务书（新会话 + 项目绑定 + 完整初始指令） |

ZCode 原有恢复行为不变；其他 agent（含 traework）明确拒绝。

**取消真停 GUI（issue #6）**

- `cancel_task` 对 GUI agent 不再「请求即成功」：先经 CDP 尽力点击界面停止按钮，并在 `gui.cancelWaitMs`
  （默认 15 秒）内有界等待 GUI 真正空闲后落 `cancelled`；未确认停止时终态文案明示
  「GUI 内运行未确认停止，Codex 窗口中的任务可能仍在继续」。
- **重派防交叠护栏**：派发前发现受管实例上仍有未停止的运行时，先尽力停止；仍不空闲则以
  `instance_busy` 硬失败拒绝派发（取消后立刻重派曾实测踩中）。

**真机陷阱：trusted 点击 vs DOM click**

Windows + Codex 真机模拟实测：模型菜单的 `menuitemradio` 对 trusted 鼠标点击
**只收起菜单、不切换选中态** → `clickModelItem` 改为页面内 DOM `.click()`；而「项目选择触发器」相反，
**需要 trusted 点击才能展开**。两个方向相反的行为都已注明在代码与 `docs/codex-gui-cdp.md`，
后续改动选择器交互时必须真机复验。

### 9.5 ZCode 3.11.2 适配与验收 fail-closed（M15 / v0.3.3，issue #4/#7）

**ZCode 3.11.2 选择器漂移（issue #4）**

- **模型菜单**：3.11.2 把供应商分组从 `chat-model-select-group-provider:` 漂移为
  `chat-model-select-group-family:`。现两前缀均兼容；打开菜单后**直选平铺模型优先**，
  直选失败才展开 provider/family 分组重试（新旧布局都覆盖）。
- **项目绑定**：3.11.2 绑定入口在 composer 下拉，主判据为 `menuitemcheckbox`（按 NFKC / 空白 / 大小写归一化后
  的目录显示名精确唯一匹配），旧版侧栏项仅作回退；回读同时校验 composer 触发器文本与完整路径，
  过滤中英文「选择项目」占位词；绑定失败最多两轮幂等重试。
- **添加新项目**：首次 outside-click 会被吞 → 添加前先收起残留工作区菜单，再以最多三轮
  「收起—点击—验证」闭环打开「打开文件夹」。
- **诊断友好**：`model_unavailable` 与权限选择失败回传可见文本及 `data-testid` 候选，便于 CDP 定位下一次漂移。

**验收引擎 fail-closed（issue #7）**

- **零用例判失败**：测试检查进程退出码 0 但输出明确报告 0 个用例 → 改判失败（此前假绿）。
- **零变更判失败**：git 项目默认要求相对动工前基线产生变更；纯问答 / 分析任务可在
  `.tianshu-mcp/acceptance.json` 设 `"requireChanges": false` 显式关闭。

### 9.6 ZCode 项目回读、初始化恢复与会话发送确认（M16 / v0.3.4，issue #8/#9/#10）

**项目定位与绑定（#8 / #10）**

- 项目触发器按「用户覆盖 → 主选择器 → 精确备用选择器」逐级定位，本级无可见匹配才降级，本级多匹配即报歧义；移除了包含「项目／Project」的宽泛匹配。
- 绑定以**当前项目的规范化绝对路径**为唯一依据；只有能唯一关联到目标路径的项目名称才辅助判断，路径冲突时不允许同名文本覆盖。
- 添加项目前先收起残留工作区菜单；原生文件夹操作超时后先复检绑定副作用，已绑定则直接继续，不盲目重放整段导入。

**模型回读（#8）**

- 当前值优先读取并解码稳定属性（`data-model-current-value` 等）；属性缺失时读当前可见标签、对应 `title`，最后兼容旧页面。
- 供应商与模型名可能拆成多个 span：可见标签按拼接后精确比对；排除隐藏、透明、`aria-hidden` 祖先与溢出裁剪中的旧动画文本；证据冲突（`ambiguous`）时明确报错。

**初始化恢复（#10）**

- 准备、对话框基线、打开文件夹、路径提交、绑定确认划分为明确阶段；`setupRecoveryTimeoutMs`（默认 120s）为初始化到绑定完成的总预算，`dialogProbeTimeoutMs`（30s）/`dialogOperationTimeoutMs`（60s）为单次探测 / 操作上限，`setupRecoveryMaxRetries`（2）为可安全重试阶段的额外次数。所有等待取配置上限、阶段剩余预算、任务剩余时间的最小值；重试不重置预算。
- 探测超时后先复检 CDP、项目列表与绑定状态；只读瞬态故障有限重试；点击 / 输入 / 提交超时后先确认副作用，无法证明上次未生效不重复执行。
- Windows 只查询目标进程的原生对话框基线；macOS 探测失败不伪装成「没有既有面板」（fail-closed）。
- 恢复预算耗尽或权限 / 目标歧义时保留现场，转可继续的 `needs_user/setup_recovery`；任务总时限先到则按 `task_timeout` 结束。

**会话恢复与发送确认（#9）**

- 明确区分「环境恢复后首次派发」与「已有会话续答 / 返修」，不只看 `ctx.resume` 是否存在。
- 无锚点的环境恢复在发送前采集会话快照，发送**完整原任务、上下文和已验证引用**；用户的「已关闭」等确认文本不发给模型（`continue_task` 对非 `agent_question` 类型 `sendMessage=false`）。
- 已有会话续答必须定位原会话，缺失或歧义时 `session_lost` fail-closed，不打开最近会话替代。
- 发送确认与会话识别共用一次有界观察窗口（默认 60s 且受任务剩余时间约束）；窗口内仍无法定位则保留 `send_unknown` 现场，禁止自动重发。
- 发送按钮只在「唯一、启用、未被遮挡（`elementFromPoint` 命中）」时才点击；未就绪则等待，不把点击尝试当成功。

### 9.7 v0.4.0 行为变更与排障（验收并行 / 路径闸门 / macOS 无头路径）

> v0.4.0 有三条**会改变既有行为**的变动。升级后遇到「和以前不一样」，先查这里。

**① 验收命令默认并行（`verifyConcurrency`）**

- 新增配置项 `verifyConcurrency`（范围 1–4），**默认值由串行变为 2**；项目级 `.tianshu-mcp/acceptance.json` 可覆盖，server 级在 `config.json`。
- 检查项之间有顺序依赖时（后续检查读取 build 产物、带 `--fix`、共享缓存目录）**必须显式设 1**，完全退化为串行。
- 报告与日志格式不变：结果按**声明顺序**返回；每条 check 写独立 part 日志，结束后按声明顺序拼回 `verify-<round>.log`。
- 取消信号可中断在途 check（记 `aborted`）与未启动 check（记 `skipped`）。

**② 项目身份改为 `realpath` 归一（`projectPath` 安全闸门）**

- `projectPath` 提交即校验：绝对路径 + 存在目录 + `realpath` 消除符号链接；回执明示解析来源。
- 拒绝**用户主目录本身**与**系统/根级目录**；盘符根（`C:\`、`D:\` 等）由**单独判定**覆盖——`normPath` 会把 `D:\` 归一为 `d:`（尾斜杠被剥掉），所以不能靠枚举清单。
- **副作用**：符号链接入口（macOS `/tmp` → `/private/tmp`）下，同一目录可能与既有 `projects.json` 记录、历史任务目录不再匹配——按规范化后的**真实路径**查找；`list_tasks` 过滤已同步用同一归一。
- git 仓库有未提交变更时，回执附带共处警示（多会话场景）。

**③ macOS 无头路径（可选，不改代码）**

- 内置 `codex` 仍走 GUI 驱动；不想依赖 GUI 自动化时，在数据目录 `agent-profiles.json` 加一个 `driver=spawn` 的 `codex-cli` profile 走 `codex exec`。
- ⚠️ codex CLI 需保持 **≥0.154.0**：≤0.130.0 的签名证书已被吊销，macOS Gatekeeper 会直接 SIGKILL。

### 9.8 视觉验收排障（M19 / v0.5.0）

> 视觉模块默认关闭（`visual.enabled` 默认 `false`），未启用时既有行为完全不变。

| 症状 | 处置 |
|---|---|
| 任务进 `needs_attention` 且报告 `BASELINE_APPROVAL_REQUIRED` | 缺已批准基准。正常流程：`prepare_visual_baseline` 出候选 → 用户看 preview → `approve_visual_baseline` 带 `expectedDigest` + `approvalNote` 批准。**缺基准不得判通过** |
| 报告 `VISUAL_INTEGRITY` | 视觉配置或已批准基准在动工前后被改（或基准内容与 manifest 摘要不符）。不要手动改基准/阈值/屏蔽绕过；要变更走 `tianshu-mcp visual rules review/approve` 重建任务快照 |
| 报告 `RESOURCE_BLOCKED` | 外部字体/图片/接口/WebSocket 来源未放行。在配置 `allowedOrigins` 里精确加入 origin（无路径、无凭据）；重定向后仍会校验 |
| 报告 `SCREENSHOT_UNSTABLE` | 页面持续变化。用 `maskSelectors` 显式屏蔽动态区域；整页持续扩张属阻塞，应补就绪条件而非放大 `maxDiffRatio` |
| 报告 `MASK_NOT_FOUND` / `MASK_ALL_PIXELS` | 配置的屏蔽选择器定位不到，或屏蔽覆盖全部像素。前者是配置错误（避免不知情地失去屏蔽），后者拒绝通过 |
| 报告 `PIXEL_DIFFERENCE` | 真实布局差异。属可返修缺陷，按 `autoFixRounds` 返修；报告含检查 ID、路由、视口、指标、差异区域与证据路径 |
| 报告 `DIMENSION_MISMATCH` | 基准与实际尺寸不同。**直接失败、不缩放**；新视口/新环境应重新准备并批准基准 |
| 报告 `IMAGE_DEPENDENCY_MISSING` / `BROWSER_MISSING` | 可选依赖或托管浏览器未装。`npm install --include=optional` / `tianshu-mcp visual browser install`；不会静默改用本机浏览器 |
| 离线 HTML 图片打不开 | HTML 只引用同轮产物目录内的相对路径；确认未被 `visual artifacts clean` 清理（清理后报告会标 `cleanedAt`，历史证据不再展示图片） |
| 想清掉某任务的视觉产物 | `tianshu-mcp visual artifacts clean <taskId>` 先预览，`--apply` 才删除；只删该任务的视觉目录，保留报告与清理标记，不删正式基准 |

**自检命令**：`tianshu-mcp visual doctor <project>`（检查运行时、图像依赖、配置、浏览器四项）。

### 9.9 ZCode 无项目派发与真机回访（M21 / M22，issue #12）

> v0.5.2 引入无项目派发，v0.5.3 修掉真机回访暴露的三个缺陷。改 ZCode adapter 前先读本节与 `docs/zcode-cdp.md`。

**无项目派发（v0.5.2）**

- `run_task` 省略 `projectPath` 时，ZCode 在其 `default`（无项目）工作区承接任务：不分配目录、不登记/导入项目、不采集 Git 基线、不冻结项目快照、不进入项目锁与项目验收。
- **只支持 ZCode**；解析出的目标是其他 agent 时，在排队前返回参数错误。空串 / `null` / 相对路径 / 不存在的目录**不视为**无项目模式，仍按有项目模式拒绝。
- 无项目模式强制关闭验收与返修（`autoVerify=false`、`autoFixRounds=0`），显式开启会在提交前报错；任务书含明确本地文件引用（反引号路径 / 绝对路径 / `./` / `../`）时发送前报错，要求提供 `projectPath`。
- 终态元数据以 `verificationNotApplicable: "no_project"` 标注；`verify_task` / `get_task_report` 对该类任务返回 `not_applicable: no_project`，不从 cwd 推导目录。
- `allowCreateProject=false` 时，目标目录未登记会在**任何导入副作用之前**停止派发并返回 `project_not_registered`。

**真机排障三条（v0.5.3 修复，均有回归用例）**

1. **`-32602 Required at projectPath`**：handler 已支持无项目分支，但 MCP schema 仍必填 → 真实调用被 SDK 拒。已改 `AbsPath.optional()`，并补**协议层**回归（单测直接调 handler 会绕过 `inputSchema`，查不出这类问题）。
2. **停在已有会话时永久 `setup_recovery`**（实测空转 30 秒）：ZCode「新建任务」继承上次项目绑定；且项目菜单**已打开**时点击触发器会被 Radix toggle 关掉菜单。修复要点：新增 `workOutsideProject` 选择器与 `enterDefaultWorkspace()` 显式切换、点击前先查菜单状态、`confirmDefaultWorkspace` 对「明确绑定着项目」立即返回。`projectTriggerTimeoutMs`（默认 15s）统一替换原先写死的两处超时，「等待 → 回退侧栏 → 再等待」共享同一截止时间，重试不重置预算。
3. **界面停了但报告说按钮被遮挡**：窗口最小化/完全遮挡时 Chromium 节流页面（`visibilityState=hidden`），按钮在视口内却点不到。现在会报「窗口不在前台」；`Page.bringToFront` 实测**无法**恢复被遮挡的 Electron 窗口，故不假装自动恢复——请手工把窗口置于前台。

**真机坑：顶部「新建任务」是惰性挂载图标（v0.5.3 修复）**

| 事实 | 说明 |
|---|---|
| 点击返回 `true` ≠ 切页 | 停在已有会话时，顶部 `conversation-new-task` 点击派发成功但页面不变（实测 rows 仍为 2） |
| 会话页 composer 不挂载项目触发器 | `composer-workspace-trigger` 挂载数为 0，导致后续绑定等待空转到 deadline |
| 侧栏 `task-new-button` 可靠 | Windows 3.11.2 实测 2 秒内进入草稿（rows=0、触发器挂载数 1、文本为占位词「选择项目」） |
| 判据 | 新建任务后以「项目触发器已挂载」验证草稿**真的**建立；两个入口都失败才 `setup_failed` fail-closed |

**Windows 上未登记项目的自动导入仍不可用（已知限制）**

原生面板脚本靠 `SetForegroundWindow` 抢前台来激活地址栏，而后台 MCP server 的子进程会被 Windows 拒绝，地址栏 Edit 永不出现，脚本空转到 setup 预算耗尽（实测 56s）；且 PowerShell 的 stdout 在管道里被缓冲、进程被 kill 后缓冲丢失，日志里连一条 `native:` 阶段都看不到。**临时对策**：先在 ZCode 中手动把目标目录加入项目列表（或用 `allowCreateProject=false` 让它显式失败）。修复方向是脚本内改用 `AttachThreadInput` 抢前台，或改走 ZCode 受支持的登记入口。

完整真机证据见 `docs/zcode-issue-12-windows-evidence.md` / `.en.md`（含 v0.5.2 首轮与「第二轮回访」两节）。

---

## 10. 凭证与安全红线

- 仓库内**不含任何 token**；`~/.npmrc`、`~/.git-credentials`、`GITEE_TOKEN` 均为本机 / 仓库 Secret 凭证，勿入库。
- `.gitignore` 隔离：`AGENTS.md`、`.zcode/*`、`.codex/*`、`.rivet/*`、`tianshu-mcp-web/`（整目录，含内嵌 git 仓库）、
  `analysis-tools/*`、`/.tianshu-mcp/*`、`node_modules/*`、`dist/*`、`*.tgz`、`.tmp-check/`、`docs/zcode-issue-8-10-evidence/`。
- 发布需要：npm `_authToken`（账号 `lotteai`）、GitHub token（`~/.git-credentials`）、`GITEE_TOKEN`（GitHub 仓库 Secret，Gitee 发行版自动化用）。
- 安全模型与私密报告渠道见 `SECURITY.md`。

---

## 11. 文档地图

| 文档 | 内容 |
|---|---|
| `README.md` / `README.en.md` | 项目总览、快速开始（含天枢界面配置）、文档索引、里程碑 |
| `ARCHITECTURE.md` / `.en.md` | **架构说明**：分层模型（L1 协议边 → L5 基础）、模块边界与依赖方向、启动装配与数据目录布局、MCP 返回契约、任务状态机与持久化、编排与验收流水线、Agent 驱动层契约与 `endReason`/`needsUserKind` 取值表、GUI 实例生命周期、视觉链路、配置热加载、跨平台策略、安全红线、扩展点、测试与发布流水线、已知缺口 |
| `CHANGELOG.md` / `.en.md` | 版本历史 v0.1.0 → v0.5.3（含比较链接） |
| `CONTRIBUTING.md` / `.en.md` | 开发环境、门禁、规范、提交 / 发布流程、如何新增 agent |
| `SECURITY.md` / `.en.md` | 安全模型与漏洞报告 |
| `CODE_OF_CONDUCT.md` / `.en.md` | 行为准则 |
| `docs/tianshu-integration.md` / `.en.md` | 接入配置、冒烟步骤、FAQ |
| `docs/traework-cdp.md` / `.en.md` | TraeWork GUI 驱动原理、选择器、安全红线、踩坑记录 |
| `docs/zcode-cdp.md` / `.en.md` | ZCode GUI adapter、暂停继续、返修闭环与双平台真机证据状态 |
| `docs/codex-gui-cdp.md` / `.en.md` | Codex 桌面端 GUI 驱动：MSIX COM 激活、CDP 接管、选择器、运行检测、验收返修 |
| `docs/codex-windows-smoke.md` / `.en.md` | Codex Windows 真机验收记录（含失败→计划→返修闭环） |
| `docs/zcode-windows-smoke.md` / `.en.md` | ZCode Windows 真机开发、同会话返修与提问续跑验收记录 |
| `docs/zcode-issue-8-10-validation.md` / `.en.md` | ZCode #8/#9/#10 Windows 真机验收记录 |
| `docs/agent-profiles.md` / `.en.md` | profile 字段说明（含 `driver`/`gui`/`stallTimeoutMs`/`cancelWaitMs`/`setupRecovery*`） |
| `docs/adapter-matrix.md` / `.en.md` | 各 agent 能力调研矩阵 |
| `docs/acceptance-config.md` / `.en.md` | 项目级验收配置规范（含 `requireChanges`） |
| `docs/visual-acceptance.md` / `.en.md` | 视觉验收入门与完整配置：三种页面来源、基准候选/批准、规则冻结、阈值解释与排查表 |
| `docs/visual-validation.md` / `.en.md` | 视觉验收验证进度：完整平台证据表（系统 / Node / 浏览器 / 命令 / 结果） |
| `docs/visual-validation-evidence/` | 上述验证的原始机器可读记录（Windows 矩阵 JSON、macOS `environment.json`、CI 摘要） |
| `docs/zcode-issue-12-windows-evidence.md` / `.en.md` | ZCode 无项目派发与 `allowCreateProject` 的 Windows 10 真机验收记录（含 v0.5.2 首轮与「第二轮回访」） |
| `docs/release-v0.5.3.md` / `.en.md` | v0.5.3 发布说明（ZCode 真机回访修复：实例跨 server 驻留、新建任务切页、发送失败归因） |
| `docs/release-v0.5.2.md` / `.en.md` | v0.5.2 发布说明（ZCode 无项目派发与 `allowCreateProject`，issue #12） |
| `docs/release-v0.5.1.md` / `.en.md` | v0.5.1 发布说明（文档/证据补齐 + 锁文件修复，无运行时变更） |
| `docs/release-v0.5.0.md` / `.en.md` | v0.5.0 发布说明（可选视觉验收模块） |
| `docs/release-v0.4.1.md` / `.en.md`、`docs/release-v0.4.0.md` / `.en.md` 等 | 历史版本发布说明（按需查 `docs/release-v*.md`） |
| `docs/issue-1-host-reconnect-record.md` | issue #1 桌面宿主重连验收（v3.16.1：10 tools + 真实工具调用） |
| `docs/npm-publish-guide.md` | npm 发布步骤与凭证；另含 Gitee 发行版手动补建 |
| `docs/m2-*.md`、`docs/host-integration-record.md`、`docs/dod7-release-record.md`、`docs/dod8-session-record.md`、`docs/s7-session-recheck.md` | 历史里程碑物证（中文，无英文版） |
| `skills/tianshu-mcp/SKILL.md` + `skills/tianshu-mcp/usage-examples.md` | 教天枢编排本 MCP 的技能与使用示例（随包分发、启动自检安装） |

> **本地 only（gitignore，不在仓库）**：`.zcode/plans/*`（开发计划，含视觉验收计划）、`.codex/review/*`（验收报告）、
> `docs/zcode-issue-8-10-evidence/`、`docs/m2-evidence/`、`docs/dod8-evidence/`（脱敏后的真机物证副本）、`.tmp-check/*`（临时证据）。

---

## 12. 接手人下一步建议

1. 先跑 `npm ci && npm run typecheck && npm run lint && npm test && npm run build`，确认基线绿（532 passed / 10 skipped）。
2. 动代码前先读 [ARCHITECTURE.md](ARCHITECTURE.md) 建立整体心智模型（分层、依赖方向、唯一双路径接缝 `adapter.run`、状态机与验收流水线）；再按专题读本文章节：
   动 GUI adapter 相关代码前，先读对应文档与本文章节：
   TraeWork → `docs/traework-cdp.md` + §9.1 / §9.2；ZCode → `docs/zcode-cdp.md` + §9.5 / §9.6 / §9.9；Codex → `docs/codex-gui-cdp.md` + §9.4。
   项目文件夹绑定出问题时，先看 §9.1 的排障顺序（下拉项 ≠ 项目 map、三处已修缺陷、两个定位陷阱）。
3. **改任何选择器交互必须真机复验**：trusted 点击与 DOM click 的取舍因控件而异（§9.4 的模型菜单 vs 项目触发器就是反例）。
4. 若客户端 UI 升级导致选择器失效：用 `scripts/probe-*.mjs` 诊断，优先用 profile `gui.selectors` 覆盖，不改代码。
5. 动视觉模块前先读 `docs/visual-acceptance.md` 与 §9.8：基准必须走「候选 → 用户批准」，规则冻结会拦截绕过；`TIANSHU_VISUAL_BROWSER_TEST=1` 才跑真实浏览器用例。
6. Codex 与 ZCode 的 macOS 基本闭环均已真机验证；取消/返修/continue_task/新建项目矩阵未补齐前
   不得把 darwin 从 `research` 改为 `ready`；TraeWork 的 macOS 分支仍是 fail-closed。
7. 新增 agent：优先只加 profile（见 `docs/agent-profiles.md`）；需要特殊输出解析再写 adapter。
8. 发版前务必确认 `src/version.generated.ts`、`package.json` **与 `package-lock.json`** 三者版本一致并同步提交
   （CI 有「构建后无 tracked diff」门禁；v0.5.0 曾漏掉锁文件）。推 `v*` tag 即触发 Release
   （双语正文取 `docs/release-v<ver>.md` + `.en.md`，**缺文档会直接失败**；且要求同 SHA 的成功 CI）。完整步骤见 §6.4。
9. 未发布计划（见 `CHANGELOG.md` 的「未发布」节）：**视觉验收第二阶段——AI 视觉内容校验（issue #13，前身 issue #3 的「可选扩展」）**、
   更多 agent 适配、TraeWork / ZCode / Codex 的 macOS 验证矩阵、
   项目级技能播种、`needs_user` 状态取消时经临时 CDP 连接尽力停止 GUI 内等待中的会话、
   ZCode 无项目派发的 macOS 真机验证、ZCode 未登记项目自动导入在 Windows 上的修复（§9.9）。
   注：issue #3 第一阶段（像素级对比 + 图片规格 + 报告 + 返修闭环 + 基准批准/冻结）已随 v0.5.0 完成，issue #3 已关闭；
   issue #12（无项目派发 + `allowCreateProject`）已随 v0.5.2 完成，其真机回访修复随 v0.5.3 完成。
