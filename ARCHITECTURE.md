# ARCHITECTURE.md — tianshu-mcp 架构说明

> 适用版本：`0.5.3`（2026-09-15）
> 本文描述**系统结构与模块边界**，面向要改动本仓库的开发者。
> 运行方式、安装步骤与用法见 [README.md](README.md)；交接状态、排障手册与踩坑记录见 [HANDOFF.md](HANDOFF.md)。
> 英文版：[ARCHITECTURE.en.md](ARCHITECTURE.en.md)。

---

## 1. 定位与系统上下文

`tianshu-mcp` 是一个**被天枢（Tianshu）当作标准 MCP server 接入的编排层**。天枢是总指挥与用户交互面，本 server 承担三件事：

1. **调度**——任务队列、并发闸、状态机、超时与取消；
2. **执行面**——把任务书送达外部 AI-Agent（Codex 桌面端 / TraeWork / ZCode / 任意 CLI）；
3. **客观验收仪**——相对 git 基线做命令检查、代码分析与（可选）视觉像素比对，产出报告。

```text
┌─────────────────────────────────────────────────────────────┐
│ 天枢（Tianshu TUI × GUI）                                     │
│   · 按次同步调用 tools/call，只消费 content[].text 与 isError  │
└───────────────────────────┬─────────────────────────────────┘
                            │ MCP over stdio（stdout 仅承载 JSON-RPC）
┌───────────────────────────▼─────────────────────────────────┐
│ tianshu-mcp（本仓库）                                         │
│   调度 ── 执行面 ── 验收仪                                    │
└──────────┬──────────────────────────────┬───────────────────┘
           │                              │
   ┌───────▼────────┐            ┌────────▼─────────┐
   │ 外部 AI-Agent   │            │ 目标项目工作区     │
   │ GUI：CDP 驱动 UI│            │  git 仓库 + 测试  │
   │ CLI：子进程      │            │  .tianshu-mcp/   │
   └────────────────┘            └──────────────────┘
```

### 1.1 四条硬约束，以及它们造成的架构后果

本项目的形态不是自由设计的结果，而是四条**实测硬约束**逼出来的。改架构前必须先读这张表：

| # | 实测约束 | 架构后果 |
|---|---|---|
| C1 | 天枢的 MCP 工具**只回文本**：`content[]` 的 `text` 被拼成字符串，`isError` 透传 | 所有结果统一为「人类可读文本 + `---tianshu-mcp-meta---` JSON 块」；不依赖 resources / prompts（`src/mcp/formatter.ts`） |
| C2 | 天枢**按次同步**调用 `tools/call` | 长任务必须异步化：`run_task` 秒回 `taskId`，用 `query_task` 轮询；无服务端推送 |
| C3 | TraeWork 的 agent 请求在 TTNet 层 TDE 加密，无法在客户端外构造 | 唯一可行路径是 **CDP 驱动桌面 UI**，从 DOM 提取结果（`src/agents/traework/`） |
| C4 | Codex 桌面端是 **MSIX 商店包**，GUI 宿主无法 `CreateProcess` 直启 | 必须经 `IApplicationActivationManager` COM 激活并注入专属 `--user-data-dir` 才能开 CDP 端口（`src/agents/codex/launcher.ts`） |

ZCode 属于同类问题：无随包 headless CLI，故同样走 CDP（M2 已实测定论）。

---

## 2. 分层架构总览

```text
┌──────────────────────────────────────────────────────────────────┐
│ L1 协议边     src/index.ts · src/server.ts · src/mcp/             │
│   入口与 CLI 分流 · 装配 · 11 工具注册 · 参数校验 · 文本+meta 格式化 │
├──────────────────────────────────────────────────────────────────┤
│ L2 任务域     src/tasks/                                           │
│   状态机 · 每项目串行队列 · 全局并发闸 · 事件流落盘 · 取消语义        │
├──────────────────────────────────────────────────────────────────┤
│ L3 编排       src/loop/                                            │
│   TaskOrchestrator：派发 → 验收 → 返修 → 再验收；轮次记账与终止判定   │
├───────────────────────────────┬──────────────────────────────────┤
│ L4a 执行面    src/agents/      │ L4b 验收面  src/verify/ src/visual/│
│   AgentAdapter 契约            │   git 基线 · 命令检查 · 代码分析    │
│   CLI spawn / GUI CDP 驱动     │   视觉像素比对 · 报告产物           │
├───────────────────────────────┴──────────────────────────────────┤
│ L5 基础       src/config/ · src/util/                              │
│   zod schema · 数据目录 · 热加载 · 原子写 · 路径归一 · 日志 · 技能自检 │
└──────────────────────────────────────────────────────────────────┘
```

依赖方向**严格单向向下**：L1 → L2 → L3 → {L4a, L4b} → L5。L4a 与 L4b 互不依赖，只在 L3 汇合；这是本项目最重要的解耦边界——**「谁来干活」与「怎么算干得好」是两件独立可替换的事**。

---

## 3. 启动装配与生命周期

### 3.1 入口分流（`src/index.ts`）

```text
node dist/index.js                → stdio MCP server
node dist/index.js visual <cmd>   → 视觉验收 CLI 子命令族
                                   （在建立 stdio 连接之前分流，不占用协议流）
```

- 数据目录由 `resolveDataHome()` 解析：环境变量 `TIANSHU_MCP_HOME` 优先，否则 `~/.tianshu-mcp`。
- 日志器初始化到 `<数据目录>/logs/`。
- 技能自检安装可经 `--no-skill-install` 或 `TIANSHU_MCP_NO_SKILL_INSTALL=1` 关闭。
- 退出路径：`SIGINT` / `SIGTERM` / stdin EOF / stdin close → 归档活动任务并终止子进程 → `exit(0)`。

### 3.2 组装顺序（`src/server.ts`）

`buildServer()` 是唯一的装配点，顺序有语义：

```text
resolveDataHome → Logger → DataHome(BUILTIN_PROFILES) → init()
  → loadConfig() → maxRunning
  → TaskStore → AgentAdapterRegistry(loadProfiles) → AcceptanceEngine
  → TaskManager(+makeBuildCtx) → manager.initialize(maxRunning)   # 归档重启遗留的 active 任务
  → 技能自检安装（后台，不阻塞握手）
  → 注册 11 个工具 → 返回 ServerAssembly{server, manager, dataHome, store, logger, close}
```

`close()` = `manager.shutdownInterrupt()`（归档活动任务 + 终止子进程）→ `engine.close()` → `server.close()`。

工具注册是**数据驱动**的：遍历 `TOOL_DEFS`，按名字在 `handlers` 里取实现，缺失即 log error 并跳过；`registerTool` 时顺带下发 `_meta.requireApproval`、`_meta.capability` 与 MCP `annotations`（readOnly / destructive / openWorld），供宿主策略层使用。

### 3.3 数据目录布局

```text
<数据目录>/                       默认 ~/.tianshu-mcp
├── config.json                  server 配置（并发、超时、技能开关）
├── agent-profiles.json         用户自定义/覆盖的 agent profile
├── projects.json                项目登记表（含每项目验收配置）
├── logs/server.log             全级别诊断日志（与 stderr 同源）
├── browsers/                    视觉模块托管的 Chrome（managed 模式）
├── visual-candidates/<uuid>/    待批准基准候选（candidate.json + PNG + preview.html）
├── visual-locks/<sha256>.lock   视觉操作互斥锁
└── tasks/<taskId>/              单任务隔离目录（见下）
```

单任务目录（`src/tasks/task-store.ts`）：

| 文件 | 内容 |
|---|---|
| `task.jsonl` | 追加式事件流（唯一权威时间线） |
| `task.json` | 最新 `TaskMeta` 快照（原子写） |
| `baseline.json` | 动工前的 git 基线 |
| `agent-<round>.log` | agent 输出（round 从 0 起） |
| `verify-<round>.log` | 验收命令输出 |
| `report-<round>.md` / `.json` | 验收报告（`.md` 人读，`.json` 机读） |
| `report-<round>.html` | 视觉离线报告，**仅当报告含视觉结果时**生成 |
| `rework-<taskId>-r<round>.md` | 返修计划（非 codex 路径） |
| `visual/<round>/<pageId>/<viewportId>/` | 视觉四联图：`actual/baseline/diff/regions.png` + `metrics.json` |
| `visual-snapshot.json` | 任务期冻结的视觉规则快照 |

项目侧产物：`<项目>/.tianshu-mcp/acceptance.json`（项目级验收配置）、`<项目>/tests/visual/baselines/...`（视觉基准）、codex 路径的 `<项目>/.zcode/plans/codex-fix-r<N>.md`（修复计划）。

---

## 4. MCP 工具面与返回契约

11 个工具（`src/mcp/tools.ts`），按能力分为读与写两族：

| 工具 | 能力 | 审批 | 作用 |
|---|---|---|---|
| `run_task` | write | 是 | 派活，异步返回 `taskId` |
| `continue_task` | write | 是 | 恢复 `needs_user` 的原会话 |
| `query_task` | read | 否 | 轮询状态 / 进度 / 日志尾 |
| `list_tasks` | read | 否 | 历史任务列表（可按项目/状态过滤） |
| `get_task_report` | read | 否 | 取某轮 `report.md` 全文 |
| `cancel_task` | write | 是 | 取消（CLI 杀进程树；GUI 尽力点停止 + 有界等待） |
| `verify_task` | read | 否 | 对任务或项目路径做一次验收（不改源码） |
| `rework_task` | write | 是 | 手动返修，把失败摘要喂回同一 agent |
| `get_profiles` | read | 否 | agent 适配与可执行探测结果 |
| `prepare_visual_baseline` | write | 是 | 生成基准候选与摘要（不落正式基准） |
| `approve_visual_baseline` | write | 是 | 用户审阅后核对摘要并写入基准 |

**返回契约**（`src/mcp/formatter.ts`）：人类可读正文 + 尾随元块，便于宿主正则抽取。

```text
<人类可读文本>
---tianshu-mcp-meta---
{ ...MetaBlockFields: taskId, status, ok, round, changedFiles, diffstat, ... }
---tianshu-mcp-meta---
```

**参数校验是两段式的**：`server.ts` 先用 `inputSchema.safeParse()` 做协议级校验（失败回 `Error: 参数不合法 — <path>: <message>`）；handler 内再做语义闸门，例如 `projectPath` 安全校验（绝对路径 + 存在 + realpath 归一 + 拒绝主目录与根级/系统目录）、`mode` 仅 TraeWork 可用的拒绝、`allowCreateProject` 仅 ZCode 可用等。

进度**只落盘、不推送**：GUI adapter 按 `gui.progressIntervalMs`（默认 30s）回报进度，`TaskOrchestrator` 写成 `task.jsonl` 的 `note` 事件并刷新快照的 `progressSummary` / `lastRunSignal`；`query_task` 每次读取最新快照与事件流，因此轮询者看到的是「最后一次落盘的进度」。

---

## 5. 任务域：状态机、队列与持久化

### 5.1 状态机（`src/tasks/task.ts`）

```text
                        ┌──────────────────────────────┐
   run_task ──► queued ─┤──► running ──► verify_start ──┤──► succeeded
                 │      │      ▲            │          │──► failed
                 │      │      │            ▼          │──► needs_attention
                 │      │      └──── fixing ◄──────────┘
                 │      │
                 │      ├──► needs_user  ──► queued   （continue_task 恢复）
                 │      ├──► cancelled
                 │      └──► interrupted
                 └──► cancelled | interrupted
```

- **状态集**：`queued, running, verify_start, fixing, succeeded, failed, needs_attention, needs_user, cancelled, interrupted`。
- **终态**：`succeeded, failed, needs_attention, cancelled, interrupted`。
- **活动态**：`queued, running, verify_start, fixing`。
- **`needs_user` 既非活动态也非终态**——它可被 `continue_task` 恢复到 `queued`，也可被取消。这是 GUI agent 等待人工介入时的宿主可见形态。
- 转移表 `TRANSITIONS` 显式枚举合法迁移；`TaskStore.updateStatus` 额外守卫「终态只能由显式 continue/rework 重新进入」。
- `errorType`：`timeout | spawn | agent_failed | verify_failed | cancelled | interrupted | agent_unresolved | internal`。

### 5.2 持久化与崩溃恢复

双写策略，两者职责不同：

- **`task.jsonl`（权威事件流）**：追加写，事件名如 `created / queued / started / verify_start / verify_round / fix_start / succeeded / failed / needs_attention / needs_user / continued / cancel_requested / cancelled / interrupted / timeout_killed / note`。读取时跳过损坏行。
- **`task.json`（查询快照）**：原子写（临时文件 + rename），供快速读取与崩溃后重建。

并发写保护：`TaskStore` 用 `statusWriteTails` 把同一任务的写操作串成链，避免状态乱序；`waitForStatusWrite()` 是**读屏障**——保证查询/取消不会在 JSONL 事件落盘之前就观察到内存里的终态。

**崩后恢复策略是「归档而非续跑」**：`TaskManager.initialize()` 扫描遗留的活动态任务，一律标 `interrupted` + `abortSource="shutdown"`。理由：GUI 会话与子进程已随 server 退出而失联，静默续跑会产生无法归因的半成品。恢复动作必须由人显式 `rework_task` 触发。

### 5.3 队列与并发

| 机制 | 规则 |
|---|---|
| 全局并发闸 | `concurrency.maxRunning`（默认 2，可被 `maxRunningOverride` 覆盖） |
| 每项目串行 | 队列按 `queueKeyOf()` 分桶：项目模式用规范化 `projectPath`，无项目模式用常量键 `__zcode_default_workspace__`（绝不用 `undefined` / `""`） |
| 调度 | `pump()`：只要 `runningCount < maxRunning`，就为每个「队首可用」的项目启动一个任务；`projectBusy()` 阻止同项目第二个任务并发 |
| 任务超时护栏 | 编排层超时之外，`startTask` 另加 `taskTimeoutMs + 15s` 的兜底计时器，防编排层自身挂死 |

### 5.4 取消语义（分状态）

| 取消时状态 | 行为 |
|---|---|
| `queued` | 直接从队列移除 → `cancelled` |
| `needs_user` | 直接 → `cancelled`；终态文案明示「GUI 内等待中的会话未被停止」（MCP 侧无 CDP 连接） |
| 活动态 | `markCancelRequested` → abort → 有界轮询等待终态（`CANCEL_SETTLE_TIMEOUT_MS = 30s`）；未确认停止时返回 `settled:false` |
| 终态 | 无动作 |

GUI agent 的取消是**尽力而为且诚实回报**：Codex 经 CDP 点击界面停止按钮并等待 GUI 空闲，结果落在 `guiStop:{clicked, idle}`；`idle=false` 时终态文案必须明示「GUI 内运行未停止」。ZCode / TraeWork 不点停止按钮，只停止 MCP 侧观察并保留实例。

关停路径 `shutdownInterrupt()`：abort 全部控制器 → 每任务有界等待 2s → 把 `running` 与 `queued` 一并标 `interrupted`。

---

## 6. 编排：自动验收与自动返修闭环

`TaskOrchestrator`（`src/loop/fix-loop.ts`）是单任务的执行主体。

```text
启动
 ├─ 采集 git 基线 + 冻结/核对视觉快照
 │    └─ 视觉错误 → needs_attention(verify_failed) + pendingVisualVerification
 ├─ 若为阻塞任务恢复：先重新验收（通过即结束，不进返修，不浪费轮次）
 └─ 返修循环（round = meta.roundsUsed，maxRounds = meta.autoFixRounds）
      ├─ status=running → buildCtx(meta, round, feedback) → 持有项目锁 → runAgentOnce
      │     runAgentOnce: adapter.run 存在 → 调用它；否则 runChild + parseExit
      ├─ agent 结果分支
      │     needs_user            → needs_user（等待 continue_task）
      │     idle/timeout/cdp 断开  → needs_attention
      │     hardFailure           → failed(spawn)      # 基础设施/认证错误，不进验收
      │     timeout / killed      → 对应终态
      ├─ 验收（runVerifyOnce）：roundsUsed = round + 1，记录报告与变更集
      └─ 终止判定
            blockingIssues        → needs_attention + pendingVisualVerification
            verdict.passed        → succeeded
            maxRounds > round     → fixing，round += 1，写修复计划，continue
            maxRounds == 0        → failed(verify_failed) + 返修提示
            轮次耗尽              → needs_attention
```

**失败信息如何回到 agent**——两条路径，按 agent 分派：

| 路径 | 产物 | 反馈内容 |
|---|---|---|
| Codex | `<项目>/.zcode/plans/codex-fix-r<N>.md` | 从报告抽取失败证据拼进修复提示 |
| 其他（含 CLI） | `<任务目录>/rework-<taskId>-r<round>.md` | 标题 + 计划路径 + `verifySummary` + 报告路径 |

**关键设计点**：`hardFailure` 与「验收失败」被严格区分。前者是环境/认证/启动问题，进验收与返修毫无意义，直接终态失败；只有 agent 真正跑完才进入验收与返修记账。

**`pendingVisualVerification` 的意义**：因缺少已批准基准或基准被改动而阻塞的任务，在 `rework_task` 恢复时**先重新验收**，通过即结束。这避免了「规则问题被当成代码问题」白烧一轮 agent。

---

## 7. 验收引擎

`AcceptanceEngine.runVerify()`（`src/verify/acceptance.ts`）串行执行以下阶段，任一致命错误即 fail-closed：

```text
1. 基线       采集或复用 git 基线（verify_task 复用任务已存基线）
2. 解析检查项  优先级：extraChecks > 项目 .tianshu-mcp/acceptance.json
                        > projects.json 的 verify > 按项目类型推导的默认集
3. 视觉快照   冻结 + 三轮核对（命令前 / 命令后 / 视觉后）；变动即 VISUAL_INTEGRITY
4. git 检查   内置 git-diff-check（git diff --check，含基线到 HEAD 与工作区）
5. 命令检查   串行或受限并行（verifyConcurrency，默认 2，钳制 1..4）
              并行时各写 verify-<round>.parts/NNN-<name>.log，事后合并回主日志
6. 视觉检查   仅当 acceptance.json 开启 visual.enabled
7. 代码分析   相对基线归因变更集 → 变更清单 / diffstat / 可疑标记
8. 变更闸门   git 项目「零净变更」判失败（requireChanges 默认 true，可关）
```

**检查项自动推导**（`deriveDefaultChecks`）：读 `package.json` 的 `typecheck / lint / test / build` 脚本 → 映射为 `npm run <script>`；有 `tsconfig.json` 无脚本 → `npx tsc --noEmit`；`pytest.ini` → `pytest -q`；`go.mod` → `go test ./...`；`Cargo.toml` → `cargo test`。

**命令执行**：`cross-spawn` + 结构化 argv + `shell:false`（**命令不拼 shell**，见 §11）；`windowsHide:true`；超时 `verifyCommandTimeoutMs`（默认 5 分钟）。

**两个 fail-closed 保护**：

1. **零用例保护**——test 类命令退出码为 0 但未收集到任何用例时，翻转为失败（防「测试什么都没跑」假绿）。
2. **零变更保护**——git 项目无净变更判失败；纯分析/问答类任务必须在 `acceptance.json` 显式设 `requireChanges: false`。

### 7.1 git 基线归因（`src/verify/git-baseline.ts`）

**绝不 stash / commit / 回滚**。流程：

1. 记录 `HEAD`、`git status --porcelain -uall` 的已跟踪改动与未跟踪文件。
2. 对**动工前就已存在的脏文件**逐个算内容哈希（大文件 >4 MiB 跳过；未跟踪文件上限 5000，超出记 `untrackedHashTruncated`）。
3. 验收时按 `baseline.head` 求差：`git diff --numstat <baseRef> HEAD`（agent 若移动了 HEAD）与 `git diff --numstat HEAD`（工作区）合并。
4. **归因**：动工前就脏、且当前哈希与基线一致的文件被排除在「本轮变更」之外；哈希被截断的文件标 `unattributable` 并排除，同时给出聚合说明。这样报告里的 `changedFiles` 反映的是**本轮 agent 真实改动**，而非仓库原有脏状态。

### 7.2 报告产物（`src/verify/report.ts`）

`report-<round>.md` 结构：标题与头部元信息 → `## 自动命令检查`（每项 `[PASS]/[FAIL]/[SKIP]` + 退出码 + 输出尾部）→ `## 代码分析`（变更清单 / diffstat / 可疑标记与告警）→ 视觉证据 → 人类可读结论。`report-<round>.json` 为同源机读版本。

可疑标记扫描（`src/verify/signals.ts`）是**确定性正则**，只做提示不单独判失败：`TODO/FIXME/HACK/XXX`、`console.*` / `debugger`、连续 3 行以上整行注释、疑似密钥字面量。

---

## 8. Agent 驱动层

### 8.1 契约（`src/agents/adapter.ts`）

```ts
interface AgentAdapter {
  id: string;
  buildInvocation(ctx, resolved): SpawnInvocation;   // 必选：命令/参数/工作目录/env/prompt
  parseExit(res): AgentRunResult;                    // 必选：子进程退出 → 语义结果
  run?(ctx, resolved, opts): Promise<AgentRunResult>; // 可选：自定义执行面
}
```

**唯一的双路径接缝**：`run()` 存在时，`TaskOrchestrator` 不再 spawn 子进程，而是调用它（GUI adapter）；否则走 `runChild()`（CLI adapter）。

- **CLI 路径**（`src/agents/cli.ts` + `src/agents/spawn.ts`）：`cross-spawn` 拉起子进程，stdout/stderr 落日志，退出码判定；`promptMode` 支持 `arg` / `stdin` / `file` 三种任务书投递方式。
- **GUI 路径**：四个 adapter 的 `buildInvocation()` 直接抛错，`run()` 承担全部 CDP 编排。Codex 与 ZCode 另有一道**模块级串行门**——GUI 是单会话资源，并发派发会互相踩踏。

`AgentRunResult` 是跨层信息载体，关键字段：

| 字段 | 含义 |
|---|---|
| `ok / exitCode / timeout / killed` | 基础结局 |
| `hardFailure` | 基础设施/认证错误，**不进验收与返修** |
| `endReason` | 结构化结束原因（各 driver 取值见下） |
| `needsUserKind` | 需要人工介入的细分类型 |
| `guiStop:{clicked,idle}` | 取消时 GUI 侧是否真的停了 |
| `session / keptInstance` | 会话锚点与实例是否保留，供 `continue_task` 恢复 |
| `progressSummary` | 落盘进 `query_task` 可见的进度 |

### 8.2 四个 GUI driver 的执行顺序（实测结论，勿随意调整）

**TraeWork**（CDP 驱动 TRAE SOLO CN）：

```text
确保实例可用 → 等待 UI 就绪 → 新建会话 → 切到目标模式 → 在目标模式内绑定项目
  → 切模型 → 发送 → 轮询到完成
```

> Work / Code / Design **各自维护独立的项目绑定**，切模式会把输入栏项目换成该模式上次使用的项目。因此必须**先切模式、再在目标模式里绑定**，绑定后复核「模式 + 项目」双双就位，任一不符即响亮失败。

**ZCode**（CDP 驱动，无项目派发自 v0.5.2 起）：

```text
发现安装 → 启动/复用 CDP 实例（共同截止时间预算） → 绑定项目（触发器逐级定位 + 完整路径判据）
  → 选模型（直选优先，provider/family 分组兜底，回读解码稳定属性） → 完全访问权限
  → 发送（按钮就绪检查 → 标记/会话差集定位） → 运行检测/提问检测 → 轮询到完成
```

**Codex**（MSIX COM 激活）：

```text
MSIX 发现（Appx 查询优先 + 扫盘回退） → COM 激活 + 专属 user-data-dir + CDP 端口 → 项目登记/绑定
  → 选模型与思考等级 → 发送（planDoc/designSystem 拼进初始指令）
  → 运行检测（停止按钮 + 对话哈希 stall） → 轮询到完成
```

**Kimi Code**（CDP 驱动，**双渲染进程**）：

```text
发现安装 → 启动/复用 CDP 实例（已有非 CDP 实例 → needs_user(close_existing_instance)）
  → 连接主窗口并置前（bringToFront，等 visibilityState 收敛） → 新建草稿（以 ws-chip 挂载为准的有界重试）
  → 绑定工作区（完整路径匹配 + 回读；未登记则走原生「添加工作区」对话框）
  → 选模型（pill 回读 → overlay 快捷菜单 → 「更多模型…」对话框）
  → 思考档位（按界面实际档位集合校验） → 执行模式「完全自动」
  → 发送（标记 + 60s 有界确认） → 运行检测（stop 按钮 / send.is-starting） → 轮询到完成
```

> **模型菜单 / 思考档位 / 执行模式菜单不在主窗口**，而由应用内 `browserOverlayOpenMenu()` 渲染在独立的
> `Kimi Browser Overlay` 渲染进程；工作区菜单与「切换模型」对话框仍在主窗口。
> 因此 `src/agents/kimicode/cdp.ts` 是**双页面客户端**（main + overlay），并排除 `Screenshot` target。
> 判定「菜单是否打开」必须以 overlay 的 `visibilityState` 为准——菜单关闭后内容可能短暂残留。
> Kimi Code **不支持无项目派发**：任务必须绑定工作区文件夹，`workspaceMode=default` 或缺少 `projectPath` 时以 `setup_failed` 拒绝。

### 8.3 完成判定：运行信号优先，完成标志其次

四个 driver 共用同一条判据原则（实现分别在各自的 `liveness.ts`）：

```text
运行信号存在（停止按钮 / loading 指示 / 活跃工具调用）  → 仍在运行，一律不结束
  ↓ 运行信号消失
DOM 完成标志出现（"由AI生成" 等）                      → 判定完成
  ↓ 无完成标志
文本哈希连续 N 轮不变 + 输入框重新可用                  → 判定完成（stableRounds）
  ↓ 始终未观测到运行信号
空闲计时达 idleTimeoutMs（默认 10 分钟）               → idle_timeout（异常结束，保留实例）
```

**这是踩出来的**：早期版本把「静态约 36 秒」当作完成，导致长思考被提前判完成。现在的原则是**运行信号绝对优先于完成标志**。ZCode 额外以「composer 输入框重新可用」作为权威完成判据（`inputEnabled`）。

### 8.4 `endReason` 与 `needsUserKind` 取值表

`endReason`：

| Codex | TraeWork | ZCode | Kimi Code |
|---|---|---|---|
| `reply_stable`（成功） | `completion_mark`（成功） | `reply_stable`（成功） | `reply_stable`（成功） |
| `aborted` | `ask_user`（成功但被阻塞） | `aborted` | `aborted` |
| `task_timeout` | `aborted` | `task_timeout` | `task_timeout` |
| `idle_timeout` | `timeout` | `idle_timeout` | `idle_timeout` |
| `needs_user` | `idle_no_completion` | `needs_user` | `needs_user` |
| `setup_failed` | `setup_failed` | `setup_failed` | `setup_failed` |
| `instance_busy` | `cdp_lost` | `cdp_disconnected` | `instance_busy` |
| `project_ambiguous` | — | `project_ambiguous` | — |
| `project_create_failed` | — | `project_mismatch` | — |
| `project_mismatch` | — | `project_not_registered` | — |
| `model_unavailable` | — | `model_unavailable` | `model_unavailable` |
| `model_mismatch` | — | `model_mismatch` | `model_mismatch` |
| `permission_unknown` | — | `permission_unknown` | `permission_unknown` |
| `input_mismatch` | — | `input_mismatch` | `input_mismatch` |
| `send_unknown` | — | `send_unknown` | `send_unknown` |
| `cdp_disconnected` | — | `session_lost` | `cdp_disconnected` |
| `internal` | — | `internal` | `internal` |
| — | — | — | `agent_error`（界面出现「继续」按钮或失败文案） |

> Kimi Code 以**工作区**（而非项目）组织任务，因此不产出 `project_*` 系列；绑定失败统一走
> `setup_failed` 或 `needs_user(setup_recovery / system_permission)`。

`needsUserKind`（联合类型共 6 种，各 driver 实际产出的子集不同）：

| 取值 | 含义 | 产出方 |
|---|---|---|
| `agent_question` | agent 在 UI 里向用户提问 | ZCode、Kimi Code（需配置 `gui.selectors.userGate` 才启用启发式提问检测） |
| `user_confirmation` | 停在等待用户确认的界面 | Codex、Kimi Code |
| `login_required` | 需要登录 | Codex、ZCode、Kimi Code |
| `close_existing_instance` | 已有实例未开 CDP 端口，需用户关闭 | ZCode、Kimi Code |
| `system_permission` | 系统权限不足（如 macOS 辅助功能） | ZCode、Kimi Code |
| `setup_recovery` | 自动恢复预算耗尽，需人工介入 | ZCode、Kimi Code |

> TraeWork 不产出 `needsUserKind`：它的「向用户提问」被当作正常结束（`ask_user`）并释放实例。

### 8.5 注册表与可执行探测（`src/agents/registry.ts`）

- 构造时预注册五个 `CliAdapter` 基座（codex / zcode / traework / kimicode / stub），随后按 `profile.adapter` 换装 GUI 实现（`codex-gui` / `zcode-gui` / `traework-gui` / `kimicode-gui`）；仅当实现类变化时才重建。
- `resolve(agentId)` 按 profile 的 `status` 分支：
  - `unsupported` → 直接失败；
  - `research` → ZCode 走专用 `discoverZcode`，其他走通用探测；
  - `ready` → 顺序为「显式绝对路径 → 发现目录扫描 → PATH（`where` / `which`）」；占位符命令（`<...>`）被拒绝。
- `codex-gui` 与 `kimicode-gui` 不走通用探测：分别经 `discoverCodex`（Appx 查询 + 扫盘）与 `discoverKimicode`（盘根相对路径 + 标准目录 + macOS bundle）解析可执行。
- 目录扫描按深度 6 内查找候选，跳过 `node_modules` 与点目录，**取 mtime 最新者**。
- profile 热加载靠 sha256 内容指纹（不是 mtime），因此同一时间戳内的修改也能被感知。
- `get_profiles` 列出所有已注册 adapter 键与 profile 键的并集（未解析成功的自定义 profile 也会出现），并逐条给出 `[PASS]/[FAIL]` 与探测来源。

### 8.6 GUI 实例生命周期

| 环节 | 机制 |
|---|---|
| 启动 | 四处统一走 `guiInstanceSpawnOptions()`：**无条件** `detached: true` + `unref()` |
| 复用 | 优先复用受管实例（Codex 以专属 `--user-data-dir` 判等；ZCode / Kimi Code 扫端口范围；TraeWork 直接探测端口） |
| 附着 | CDP 连接必须完成一次真实 DOM 往返（`exists("chatInput")`）才被接受 |
| 存活探测 | 每 tick 一次 DOM 求值，交给各自的 `judge*Poll` 判定 |
| 保留 | Codex / ZCode / Kimi Code 几乎在所有返回路径都置 `keptInstance: true` 且从不杀进程；TraeWork 仅在干净完成时释放自己启动的实例 |
| 归属核对 | TraeWork 释放前核对命令行含调试端口 + exe 名，且 `taskkill` **不带 `/T`**；Codex 只停受管实例 |
| 孤儿处理 | ZCode / Kimi Code 遇到「活着但没开 CDP 端口」的实例 → `needs_user(close_existing_instance)`，交由用户处理，绝不盲杀 |

> **`detached: true` 是不变量而非平台偏好**：桌面实例必须跨 MCP server 退出继续存活，才能兑现 `keptInstance` 的语义。v0.5.3 之前按平台分支（Windows 上不 detached）导致 server 一退出 GUI 就被连坐杀掉，已修复。
>
> 注意语义相反的另一族：**执行型子进程**（`agents/spawn`、`verify/runner`、`visual/services`）仍然按平台分支，因为它们必须随 server 一起收干净。

---

## 9. 视觉验收链路（v0.5.0 起，可选模块）

未启用时对既有行为零影响；启用后它是一条**独立于命令检查**的并行验收链路。

```text
项目 .tianshu-mcp/acceptance.json 配 visual.enabled=true
  → run_task / verify_task 在命令检查之后追加视觉检查（不需要新工具）
  → 动工前冻结「视觉配置摘要 + 基准摘要」，每轮前后核对（变动即 VISUAL_INTEGRITY 阻塞）
  → 页面：三类来源（existing / command / static）+ 声明式步骤 + 稳定化采样 + 显式屏蔽
        → 与已批准基准做像素比对（pixelmatch）
        → 若声明 pages[].content，复用同一次截图再做内容判定（pixel:false 则只做内容判定）
  → 图片：显式文件清单 + 编码/尺寸/DPI/透明度规格校验
  → 内容（v0.5.4，可选）：委托用户自备命令判定「图片/截图内容是否符合显式期望」
        → 采样多数票 + 任务级输入哈希缓存（键含命令二进制身份）
        → 默认仅告警（optional）；逐规则 blocking:true 才参与致败与返修
  → 缺陷按 autoFixRounds 返修；阻塞 → needs_attention
  → rework_task 对阻塞任务先重新验收，不先启动 agent
```

**AI 内容校验的凭证边界（v0.5.4，红线 §12）**：MCP 不读取、不存储、不转发任何密钥，也不实现模型/厂商
HTTP 客户端；判定完全委托用户显式声明的本地命令。MCP 只负责占位符展开（`<image:path>` / `<expect:file>` /
`<image:base64:file>`）、`shell:false` + 结构化 argv 的子进程执行、stdout 末行的严格 JSON 校验。外发闸门是
**契约层**强制：`allowRemote` 默认 `false`，未放行的规则使用 `<image:base64:file>` 会被 schema 直接拒绝；
命令自身是否外传图片**无法在系统层拦截**，须用户自行确认（见 `SECURITY.md`）。

**内容判定的状态语义（v0.5.4）**：`VisualResult.status` 新增 `uncertain`（票不集中或低于 `minConfidence`），
它既不匹配 `visualFailed`（只取 `failed`）也不匹配 `visualBlocked`（只取 `blocked`），因此**天然不参与 verdict**。
整轮级失败（`CONTENT_COMMAND_MISSING` / `CONTENT_ENV_MISSING`）在预检阶段（`assertContentReady` 枚举每条规则的
**有效**命令与 env）抛错、经 `acceptance.ts` 的 try/catch 升级为 `configurationError`，**不产出任何结果行**。

**基准必须两阶段**：

1. `prepare_visual_baseline` — 只生成候选（`visual-candidates/<uuid>/`，含 `candidate.json`、PNG、`preview.html`）与摘要，**不采用正式基准**。
2. `approve_visual_baseline` — 仅在用户明确审阅并授权后调用。写入前核对**三向摘要**（候选摘要 + 原基准摘要 + 配置摘要），并检查目标路径未被 gitignore、关联任务确实处于同项目 `needs_attention`，最后原子写入基准与 `manifest.json` 审批记录。

**缺基准不得判通过，自动返修禁止调用批准入口。**

工程约束（`src/visual/`）：

| 关注点 | 实现 |
|---|---|
| 浏览器 | `puppeteer-core` 无头 Chrome/Edge；`managed` 模式由 `@puppeteer/browsers` 安装到 `<数据目录>/browsers` 并锁定版本 |
| 资源限制 | 只允许本地来源 + `allowedOrigins`，其余请求直接拦截（`RESOURCE_BLOCKED`） |
| 稳定性 | 要求连续 `stabilitySamples`（默认 3）次截图字节完全一致，否则 `SCREENSHOT_UNSTABLE` |
| 预算 | `VisualBudget`：轮次截止时间 + 产物字节上限（默认 500 MiB） |
| 互斥 | `withVisualLock()`：`<数据目录>/visual-locks/<sha256(key)>.lock`，占用时返回 `VISUAL_BUSY` |
| 缺失依赖 | `sharp` / `pixelmatch` / `puppeteer-core` 缺失时**明确阻塞**，不静默降级 |
| 规则冻结 | 任务期内配置或基准被改动 → `VISUAL_INTEGRITY`，防止 agent 削弱验收规则 |
| 内容判定（v0.5.4） | `src/visual/content*.ts`：命令解析（`where`/`which`）、占位符展开、`runChild` 语义的子进程执行、stdout 末行严格 JSON；纯函数 `tallyContentVotes` 多数票与置信度闸门；任务级缓存含 `commandPath`/`commandDigest` 使自备 CLI 升级即失效 |
| 语义-only 页面（v0.5.4） | `pages[].pixel:false` 跳过基准要求与像素比对（必须有 `content`）；`prepareBaseline` 显式跳过、不纳入候选；`captureVisualSnapshot` 对其基线**显式记 null**（不读可能残留的无关文件，避免冻结摘要误漂移） |
| 告警隔离（v0.5.4） | `blocking:false` → `optional:true`，不进 `visualBlocked`/`visualFailed`，不触发返修；返修计划列「仅告警项（不必修复）」，并修掉「optional 失败列入必须修复」的既有缺陷 |

CLI 子命令族（`node dist/index.js visual ...`）：`init`（写入禁用的模板配置）、`doctor`（含内容命令解析与预算对比两项 finding）、`browser install`、`baseline prepare|approve`、`rules review|approve`、`artifacts clean`、`content probe <project> [ruleId]`（跑真实判定但不写证据/缓存）、`content cache clear <taskId>`。

---

## 10. 配置系统与热加载

### 10.1 配置来源与优先级

| 配置 | 位置 | 说明 |
|---|---|---|
| server 配置 | `<数据目录>/config.json` | `concurrency.maxRunning`(2)、`defaultTaskTimeoutMs`(30min)、`verifyCommandTimeoutMs`(5min)、`verifyConcurrency`(2, 1..4)、`skills.autoInstall`(true) |
| agent profile | `<数据目录>/agent-profiles.json` | 按 key **整键覆盖**内置 profile |
| 项目登记 | `<数据目录>/projects.json` | 含每项目 `verify[]` 验收记录 |
| 项目验收 | `<项目>/.tianshu-mcp/acceptance.json` | `checks[]`、`visual`、`requireChanges`(true)、`verifyConcurrency` |

任务超时的解析链：调用参数 `taskTimeoutMs` > profile `timeoutMs` > `defaultTaskTimeoutMs` > 30 分钟，在提交时冻结。

### 10.2 热加载与 last-known-good

- 每次 `loadConfig()` / `loadProfiles()` / `loadProjects()` 都比较 **sha256 内容指纹**，变了才重读（因此不依赖 mtime，同秒修改也能感知）。
- **last-known-good 策略**：JSON 解析失败或 zod 校验失败时，**保留上一份有效配置**而不是清空；首次加载就失败才回落到 schema 默认值。这保证了「配置写坏不会让正在运行的服务失去配置」。
- 写入路径（`saveConfig` / `registerProject` / `updateProjectVerify`）一律原子写 + 刷新指纹。

### 10.3 Agent profile 字段分组（`src/config/schema.ts`）

| 组 | 字段 |
|---|---|
| 身份与形态 | `id`、`displayName`、`type`、`driver`(spawn\|gui)、`adapter`(traework-gui\|zcode-gui\|codex-gui\|kimicode-gui)、`status`(ready\|research\|unsupported) |
| CLI 执行 | `command`、`argsTemplate`、`promptMode`(arg\|stdin\|file)、`cwd`(task\|home)、`env`、`timeoutMs`、`killTree` |
| 可执行探测 | `executableDiscovery`：`dirs`、`fileNames`、`fallbackCommand`、`preferredDrives`、`appxPackageName`、`scanRoots`… |
| GUI 编排 | `gui`：`cdpPort`(9222)、`cdpPortRange`、`exePath`、`windowMode`、`launchTimeoutMs`(60s)、`pollIntervalMs`(3s)、`stableRounds`(12)、`idleTimeoutMs`(10min)、`stallTimeoutMs`(300s)、`cancelWaitMs`(15s)、`cdpSendTimeoutMs`(15s)、`progressIntervalMs`(30s)、`projectTriggerTimeoutMs`(15s)、`workspaceTriggerTimeoutMs`(15s，Kimi Code 草稿页判据)、`selectors`、`defaultPermissionMode`、`defaultAutoFixRounds`、`activation`(spawn\|msix-com)、`userDataDir`、`fixPlanDir`… |

`gui.selectors` 是**不改代码适配 UI 升级**的主要手段：客户端改版导致选择器失效时，先用 `scripts/probe-*.mjs` 诊断，再经 profile 覆盖。

---

## 11. 跨平台策略

目标：**Windows 与 macOS 双系统兼容，且不硬编码机器路径**。

| 关注点 | 做法 |
|---|---|
| 路径占位符 | `{LOCALAPPDATA}`、`{APPDATA}`、`{PROGRAMFILES}`、`{PROGRAMFILES(X86)}`、`{SYSTEMDRIVE}`、`{HOME}`、`{USERPROFILE}`、`{XDG_DATA_HOME}` 由 `expandEnvPath()` 展开（大小写不敏感）；未设置的目录回落到平台默认发现目录 |
| 路径归一 | `normPath()`：绝对化 + POSIX 分隔符 + 盘符小写 + 去尾斜杠；项目目录额外经 `realpath` 归一（消掉 `/tmp → /private/tmp` 一类陷阱） |
| 进程树终止（执行型） | Windows：`taskkill /pid <pid> /T /F`；POSIX：进程组 SIGTERM → 800ms 后 SIGKILL |
| 进程枚举 | Windows：PowerShell `Get-CimInstance Win32_Process`；POSIX：`ps -axo pid=,command=` |
| 可执行查找 | Windows：`where`；POSIX：`which` |
| 原生对话框自动化 | Windows：PowerShell + UIA；macOS：`osascript` / System Events（ZCode 已实现双分支；Codex 与 TraeWork 的原生对话框**仅 Windows 实现，macOS fail-closed**） |
| 驱动器枚举 | 不硬编码盘符，经 WMI 查询固定盘 |
| 版本号 / AUMID | 一律动态发现，不写死 |

平台差异集中收敛在 profile 与少数 `platform` 判定点，而不是散落在业务逻辑里。

---

## 12. 安全边界与硬性红线

违反任一条即造成运行时损坏或事故：

1. **绝不按进程树盲杀 TraeWork**：只终止本模块创建、且命令行核对通过的 PID，且不带 `/T`。（历史事故：验证期 `taskkill /PID <pid> /T /F` 误杀用户正在使用的实例。）
2. **默认复用用户实例**：`gui.windowMode = "reuse"`，绝不新起第二个；受管实例（Codex / ZCode 以专属 `user-data-dir` 启动）也不触碰用户手动打开的实例。
3. **computer-use 白名单**：仅允许 TraeWork 文件夹选择对话框（窗口标题 + 宿主进程双校验），其他窗口一律 `COMPUTER_USE_DENIED`。
4. **凭证零管理**：不读取 / 解密 / 转发任何 agent 凭证；GUI adapter 只驱动 UI。**AI 内容校验（v0.5.4）同样适用**：不实现模型/厂商 HTTP 客户端、不读密钥，判定委托用户自备命令；外发闸门只在契约层强制（未放行 `allowRemote` 时 schema 拒绝 `<image:base64:file>`），**无法在系统层阻止用户命令外传图片**，此边界必须如实告知（见 `SECURITY.md`）。
5. **命令不拼 shell**：验收命令是结构化 argv，`shell:false`。
6. **不自动 commit / stash / 回滚**：动工前采集 git 基线，报告相对基线计算。
7. **路径不硬编码**：机器路径 / 用户名 / 端口走 profile 或占位符。
8. **stdout 只承载 JSON-RPC**：所有诊断日志走 stderr（并同源追加到 `logs/server.log`）。任何写入 stdout 的杂音都会破坏 MCP 流，导致严格客户端握手失败。

**路径安全闸门**：`projectPath` 提交时校验——必须绝对路径、目录必须存在、符号链接经 realpath 归一（回执明示解析来源）；**主目录本身与系统/根级目录直接拒绝**，防止 worker 的写权限覆盖整棵系统子树。

---

## 13. 扩展点

### 13.1 新增一个 CLI agent（最常见）

通常**只需加一个 profile**，无需改代码：在 `<数据目录>/agent-profiles.json` 写 `driver: "spawn"` 的 profile（`command`、`argsTemplate`、`promptMode`、`timeoutMs`、`executableDiscovery`），即可被 `run_task(agentId=...)` 使用并被 `get_profiles` 列出。参考 [docs/agent-profiles.md](docs/agent-profiles.md) 与 README 的 `codex-cli` 示例。

### 13.2 新增一个 GUI agent

需要新写一个 adapter 目录，实现 `AgentAdapter` 并把 `run()` 作为执行面，通常包含：

| 职责 | 建议模块 |
|---|---|
| 适配器与串行门 | `adapter.ts` |
| 可执行发现 | `discovery.ts` |
| 实例启停与复用 | `instance.ts` / `launcher.ts` |
| CDP 客户端与选择器 | `cdp.ts` / `selectors.ts` |
| 项目与模型选择 | `project.ts` / `model.ts` |
| 完成判定 | `liveness.ts` |
| 编排 | `run.ts` |
| 注册 | `agents/registry.ts` 增加 `profile.adapter` 分支；`agents/builtin.ts` 增默认 profile |

### 13.3 其他扩展面

| 想扩展 | 落点 |
|---|---|
| 新增 MCP 工具 | `src/mcp/tools.ts` 增元数据 + `src/mcp/handlers.ts` 增实现 + `src/config/schema.ts` 增入参 schema |
| 新增验收检查来源 | `src/verify/acceptance.ts` 的 `resolveChecks()` 优先级链 |
| 项目级验收规则 | 项目内 `.tianshu-mcp/acceptance.json`（无需改代码） |
| UI 选择器随客户端升级漂移 | profile `gui.selectors` 覆盖（无需改代码） |
| 新增视觉用例类型 | `src/visual/schema.ts` + `engine.ts` 任务构建 |

---

## 14. 测试与交付流水线

### 14.1 测试分层

| 层级 | 位置 | 覆盖 |
|---|---|---|
| 单元 | `test/unit/` | 纯函数与组件逻辑：四个 driver 的 reply / selectors / launcher / liveness / recovery、验收引擎（含并行）、基线归因、原子写、热加载、路径闸门、视觉模块 |
| 集成 | `test/integration/` | stub-agent 三剧本、取消 / 超时 / 基线、假 CDP 的 TraeWork / Codex / ZCode / Kimi Code 全流程与返修循环、竞态回归、视觉 services / capture / flow |
| 协议 | `test/protocol/` | 官方 SDK 客户端断言 11 工具面与返回格式 |
| 真机（手动） | `scripts/probe-*.mjs`、`scripts/smoke-zcode.mjs`、`scripts/evidence-visual-windows.mjs` | 需真实客户端 / 已安装浏览器 |
| 消费者 | `scripts/check-visual-consumer.mjs` | 从生产 tarball 装到无开发依赖目录，跑真实浏览器视觉验收与离线报告 |

### 14.2 门禁纪律（都在 CI 上翻过车）

1. `test/fake-cdp.ts` 里助手回复必须**同步追加**，不要改回定时器——轮询间隔小 + `stableRounds` 低时定时器会与稳定兜底抢跑。
2. 集成测试必须**隔离原生对话框枚举**：`depsFor` 的默认 `listDialogs` 桩不可省，否则会触达真实 `listOwnedDialogs`，其 darwin 分支 fail-closed，在无授权的 runner 上直接抛错。
3. 真实浏览器用例默认 `skipIf(TIANSHU_VISUAL_BROWSER_TEST !== "1")`；CI 的 `visual-browser` 作业显式开户。

### 14.3 CI / 发布

| 工作流 | 触发 | 内容 |
|---|---|---|
| `ci.yml` | push / PR 到 master 与 main | `build-test`（ubuntu / windows / macos × Node 20/22/24）、`pack-check`、`visual-browser`（ubuntu / windows / macos-15-intel / macos-15 × Node 20/22/24，真实浏览器） |
| `release.yml` | 推 `v*` tag | 跑完整门禁 → 校验 tag 版本 === `package.json` 版本 → 要求同 SHA 的成功 CI → 双语正文（`docs/release-v<ver>.md` + `.en.md`，**缺文档直接失败**）→ 发 GitHub Release 并附 tgz → 经 `scripts/gitee-release.mjs` 幂等补建 Gitee 发行版 |

版本号三处必须同步：`package.json`、`package-lock.json`、`src/version.generated.ts`（后者由 `scripts/sync-version.mjs` 在每次 build 前从 `package.json` 生成，**勿手改**）。

---

## 15. 已知缺口与技术债

按对接手人的影响排序：

1. **UI 信号是唯一可靠完成判据**——四个 GUI driver 都依赖 DOM 结构与可见信号。客户端升级可能使选择器漂移；先在 `selectors.ts` 或 profile 覆盖处修复，真机复验不可省。
2. **`needs_user` 状态下无法停止 GUI 内会话**——MCP 侧无 CDP 连接。终态文案会诚实提示。临时 CDP 连接停车已在 `CHANGELOG.md` 的「计划中」。
3. **单会话串行**——GUI 是单会话资源，同项目任务被 `projectBusy()` 串行化，全局并发受 `maxRunning` 限制。这是设计约束，不是缺陷。
4. **macOS 验证矩阵不完整**——Codex 与 ZCode 的 macOS 基本闭环已真机验证，但取消/返修/`continue_task`/新建项目矩阵未覆盖，故二者 darwin 仍标 `research`；TraeWork 与 Kimi Code 的 macOS 分支 fail-closed，Kimi Code 的 darwin 同为 `research`。
5. **无项目派发仅 ZCode 且仅 Windows 实测**；ZCode 未登记项目的自动导入在 Windows 上不可用（需先手动登记，或传 `allowCreateProject=false` 显式失败）。**Kimi Code 完全不支持无项目派发**（必须绑定工作区）。
6. **Kimi Code 的取消/提问续答/同名工作区歧义仅由 hermetic 集成测试覆盖**（未在真机点停、未触发真实提问卡片）。
7. **视觉模块的平台证据边界**——macOS 证据来自 CI 托管 runner，未在维护者个人 macOS 设备复验。
8. **验收 fail-closed 对纯分析任务的影响**——git 项目默认要求产生变更，纯问答/分析任务必须显式设 `requireChanges: false`。
9. **文档注释中的工具计数已过时**——`src/mcp/tools.ts`、`src/mcp/handlers.ts`、`src/server.ts` 的头部注释仍写「9 个工具」，实际 `TOOL_DEFS` 为 11 项。属注释层面的陈旧，不影响运行时行为，建议后续顺手校正。

---

## 16. 延伸阅读

| 主题 | 文档 |
|---|---|
| 安装、接入天枢、工具用法 | [README.md](README.md) / [README.en.md](README.en.md) |
| 交接状态、排障手册、踩坑记录 | [HANDOFF.md](HANDOFF.md) |
| TraeWork GUI 驱动细节 | [docs/traework-cdp.md](docs/traework-cdp.md) |
| Codex 桌面端 GUI 驱动细节 | [docs/codex-gui-cdp.md](docs/codex-gui-cdp.md) |
| ZCode GUI 驱动细节 | [docs/zcode-cdp.md](docs/zcode-cdp.md) |
| Kimi Code GUI 驱动细节 | [docs/kimi-cdp.md](docs/kimi-cdp.md) |
| agent profile 字段全解 | [docs/agent-profiles.md](docs/agent-profiles.md) |
| 各 agent 能力调研矩阵 | [docs/adapter-matrix.md](docs/adapter-matrix.md) |
| 项目级验收配置规范 | [docs/acceptance-config.md](docs/acceptance-config.md) |
| 视觉验收配置与排查 | [docs/visual-acceptance.md](docs/visual-acceptance.md) |
| 开发环境与提交规范 | [CONTRIBUTING.md](CONTRIBUTING.md) |
| 安全模型 | [SECURITY.md](SECURITY.md) |
