# ARCHITECTURE.md — tianshu-mcp 架构说明

> 适用版本：`0.5.7`（2026-09-22）。
> 本文描述**系统结构与模块边界**，面向要改动本仓库的开发者；版本号只在发布时随提交更新，最新发布说明见 `docs/release-v<最新版本>.md`。
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
- 技能自检安装可经 `--no-skill-install` 或 `TIANSHU_MCP_NO_SKILL_INSTALL=1` 关闭；「需变更但不自动覆盖」（`autoInstall:"prompt"` 或来源不明）可经 `--approve-skill-update` 或 `TIANSHU_MCP_APPROVE_SKILL_UPDATE=1` 放行（见 §3.4）。
- 退出路径：`SIGINT` / `SIGTERM` / stdin EOF / stdin close → 归档活动任务并终止子进程 → `exit(0)`。

### 3.2 组装顺序（`src/server.ts`）

`buildServer()` 是唯一的装配点，顺序有语义：

```text
resolveDataHome → Logger → DataHome(BUILTIN_PROFILES) → init()
  → loadConfig() → maxRunning / shutdown.guiStopWaitMs
  → TaskStore → AgentAdapterRegistry(loadProfiles) → AcceptanceEngine
  → TaskManager(+makeBuildCtx) → manager.initialize({maxRunning, guiStopWaitMs})  # 归档重启遗留的 active 任务
  → 技能自检安装（后台，不阻塞握手）
  → 注册 11 个工具 → 返回 ServerAssembly{server, manager, dataHome, store, logger, close}
```

`close()` = `manager.shutdownInterrupt()`（归档活动任务 + 终止子进程）→ `engine.close()` → `server.close()`。

工具注册是**数据驱动**的：遍历 `TOOL_DEFS`，按名字在 `handlers` 里取实现，缺失即 log error 并跳过；`registerTool` 时顺带下发 `_meta.requireApproval`、`_meta.capability` 与 MCP `annotations`（readOnly / destructive / openWorld / idempotent——`idempotentHint` 只对 `run_task` / `verify_task` 为 true，语义前提是调用方传入 `idempotencyKey`，见 §5.6），供宿主策略层使用。

### 3.3 数据目录布局

```text
<数据目录>/                       默认 ~/.tianshu-mcp
├── config.json                  server 配置（并发、超时、技能开关）
├── agent-profiles.json         用户自定义/覆盖的 agent profile
├── projects.json                项目登记表（含每项目验收配置）
├── idempotency.json             幂等键映射（键→taskId/digest，TTL + 容量裁剪；issue #15）
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
| `qoder-session.json` | Qoder CN 发送检查点（**只有 qoder 有**，见 §8.2） |
| `visual/<round>/<pageId>/<viewportId>/` | 视觉四联图：`actual/baseline/diff/regions.png` + `metrics.json` |
| `visual-snapshot.json` | 任务期冻结的视觉规则快照 |

项目侧产物：`<项目>/.tianshu-mcp/acceptance.json`（项目级验收配置）、`<项目>/tests/visual/baselines/...`（视觉基准）、codex 路径的 `<项目>/.zcode/plans/codex-fix-r<N>.md`（修复计划）。

### 3.4 技能自检安装的信任与判定模型（issue #16）

模块 `src/util/skill-install.ts`；在 `buildServer()` 内**后台**执行（`void`，不阻塞握手），失败仅告警不阻断。

**源定位**：只由 `import.meta.url` 相对包自身定位（`<模块>/../../skills/tianshu-mcp`）——dev 直跑与 dist 运行相对深度一致，因此单条候选即够。**刻意不回退 `process.cwd()`**：任何基于 cwd 的内容发现都会让「在某个第三方仓库里调试起 server」变成投毒面。找不到源时跳过安装并告警。

**安装清单**：目标目录内维护 `<目标>/.tianshu-mcp-install.json`（`schema`/`name`/`packageVersion`/`contentHash`/`installedAt`/`sourceDir`，`"prompt"` 保留时另有 `pendingUpdate`）。`contentHash` 由 `hashSkillTree()` 计算，**排除清单自身**（否则写清单即自证被改动）与平台噪声（`.DS_Store`/`Thumbs.db`/`desktop.ini`/`._*`/`.git*`）；拷贝用同一排除谓词，保证「装完立即算 hash」与源 hash 严格相等（幂等的根因）。

**判定矩阵**（`decideInstall()`，纯函数，判定与 IO 分离）：

| 目标状态 | 判据 | `auto`（默认） | `"prompt"` | 追加 `--approve-skill-update` |
|---|---|---|---|---|
| 不存在 | — | 安装 | 安装 | 安装 |
| 存在，内容 == 包内 | — | 跳过（按需补写/校准清单） | 跳过 | 跳过 |
| 清单 ok，内容 == 清单记录 ≠ 包内 | 未改动的旧版包副本（可信） | **备份 + 覆盖**（warn） | 保留 + warn + 清单记 `pendingUpdate` | **备份 + 覆盖**（warn） |
| 清单 ok，内容 ≠ 清单记录 | 用户本地修改（确证） | **保留 + 强 warn** | 同左 | **同左（放行不生效）** |
| 无有效清单（缺失/损坏/非目录）且内容 ≠ 包内 | 来源不明 | **保留 + warn** | 同左 | **备份 + 覆盖**（warn） |

- `skills.autoInstall: false` 时 `server.ts` 直接短路，不调用本模块；`--no-skill-install` 与 `false` 的否决权高于放行参数。
- 覆盖**只**发生在「可信旧版」与「显式放行」两格，`--approve-skill-update` 对已确证的用户本地修改**不生效**（保护用户对技能文档的调优不被静默冲掉）。

**安装原子性**：`installFromSource()` 走「`<目标>.incoming-<ts>-<hex>` 拷贝（含写清单）→ 旧目录 `rename` 为 `<目标>.bak-<ts>` → `rename` 换入」；失败清 tmp 并回滚 bak（回滚失败仅告警，bak 仍在）。启动时另清理 mtime 早于 1 小时的 `.incoming-*` 崩溃残留。

**日志分级**：跳过/补写清单 = `INFO`；覆盖旧版、保留用户修改、来源不明、安装失败 = `WARN`。便于检索的稳定短句：`含本地修改`、`来源不明`、`未自动覆盖`。

**备份治理**：覆盖成功后按 `skills.backupKeep`（默认 3，`0` = 不清理）收敛 —— 只匹配精确模式 `<SKILL_NAME>.bak-<数字>` 的**目录**，按时间戳保留最新 N 个，删除前 `INFO` 记录，删除失败仅 `WARN`。首个安装与跳过/保留路径都不清理。

---

## 4. MCP 工具面与返回契约

11 个工具（`src/mcp/tools.ts`），按能力分为三族：`read`（读/查询，无副作用）、`write`（有副作用，全部需审批）、`execute`（执行项目侧命令但不改源码，当前仅 `verify_task`，按 R11 仍免审批）：

| 工具 | 能力 | 审批 | 作用 |
|---|---|---|---|
| `run_task` | write | 是 | 派活，异步返回 `taskId` |
| `continue_task` | write | 是 | 恢复 `needs_user` 的原会话 |
| `query_task` | read | 否 | 轮询状态 / 进度 / 日志尾 |
| `list_tasks` | read | 否 | 历史任务列表（可按项目/状态过滤） |
| `get_task_report` | read | 否 | 取某轮 `report.md` 全文 |
| `cancel_task` | write | 是 | 取消（CLI 杀进程树；GUI 尽力点停止 + 有界等待） |
| `verify_task` | **execute** | 否 | 对任务或项目路径做一次验收：会跑项目命令、可产生构建产物，但**不改源码**，故免审批 |
| `rework_task` | write | 是 | 手动返修，把失败摘要喂回同一 agent |
| `get_profiles` | read | 否 | agent 适配与可执行探测结果 |
| `prepare_visual_baseline` | write | 是 | 生成基准候选与摘要（不落正式基准） |
| `approve_visual_baseline` | write | 是 | 用户审阅后核对摘要并写入基准 |

> **`readOnlyHint` 推导规则**：`server.ts` 按 `capability === "read"` 下发 MCP `readOnlyHint`，因此 `verify_task` 的该注解为 **false**（v0.6.1 起；此前误为 true）。**`readOnlyHint` 不是审批信号**——审批与否由 `_meta.requireApproval` 单独承载，`verify_task` 该字段恒为 false。

**返回契约**（`src/mcp/formatter.ts`）：人类可读正文 + 尾随元块，便于宿主正则抽取。

```text
<人类可读文本>
---tianshu-mcp-meta---
{ ...MetaBlockFields: taskId, status, ok, round, changedFiles, diffstat, ... }
---tianshu-mcp-meta---
```

**参数校验是两段式的**：`server.ts` 先用 `inputSchema.safeParse()` 做协议级校验（失败回 `Error: 参数不合法 — <path>: <message>`）；handler 内再做语义闸门，例如 `projectPath` 安全校验（绝对路径 + 存在 + realpath 归一 + 拒绝主目录与根级/系统目录）、`mode` 仅 TraeWork 可用的拒绝、`allowCreateProject` 仅 ZCode 可用等。

进度**只落盘、不推送**：GUI adapter 按 `gui.progressIntervalMs`（默认 30s）回报进度，`TaskOrchestrator` 写成 `task.jsonl` 的 `note` 事件并刷新快照的 `progressSummary` / `lastRunSignal`；`query_task` 每次读取最新快照与事件流，因此轮询者看到的是「最后一次落盘的进度」。除自由文本进度外还有**语义化**的细粒度事件流（`onEvent`，issue #18），见 §5.7——两者同写 `task.jsonl`：`note` 承载自由文本，细粒度事件承载节点语义。

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
| 终态 | 无取消动作；若带 GUI 待确认标记（`guiResidualUnconfirmed`）则由本次调用**人工确认清除**（不改终态，见 §5.5） |

GUI agent 的取消是**尽力而为且诚实回报**，但各适配器能力不同：

| 适配器 | 取消时是否点界面停止 | 是否回传 `guiStop` |
|---|---|---|
| Codex / Kimi Code / Qoder CN | 点停止按钮 + `cancelWaitMs` 内有界等待空闲 | 是（`idle=false` 时终态必须明示未确认停止） |
| ZCode / TraeWork | **不点停止按钮**，只终止 MCP 侧观察并保留实例 | 否（终态文案按「无停止结果可确认」如实披露） |

关停路径 `shutdownInterrupt()`（issue #14）：abort 全部控制器 → **spawn 类每任务有界等待 2s；GUI 类等到共享的 `shutdown.guiStopWaitMs`（默认 15s）全局 deadline** → 把 `running` 与 `queued` 一并标 `interrupted`。GUI 任务的终态文案按 `guiStop` 如实分流（已确认停止 / 未确认停止 / 无停止结果），**绝不写只对 spawn 子进程成立的「进程已终止」**。

### 5.5 GUI 终态的事实字段与人工确认（issue #14）

| 字段 | 语义 | 写入点 |
|---|---|---|
| `TaskMeta.guiStop` | 最近一次 abort 的 GUI 侧停止结果 `{clicked, idle}`（**所有** GUI agent 都落盘） | `abortTerminal()` / 运行结果落盘 |
| `TaskMeta.interruptedCleanStop` | 本次 interrupted 是否**已确认**停止（仅 `guiStop.idle === true` 为 true） | `abortTerminal()` / `persistInterrupted()` |
| `TaskMeta.guiResidualUnconfirmed` | 重启归档的 GUI 遗留任务待人工确认残留（重启时无任何连接可确认，故无条件置 true） | `initialize()`；由 `cancel_task` 清除 |
| meta 块 `guiStopUnconfirmed` | 读侧单一判据：`guiResidualUnconfirmed===true \|\| interruptedCleanStop===false` | `metaFromTask()` |

判定矩阵（红线 8 的单一实现，`guiStopDisclosure()`）：`idle===true` → 已确认停止；`idle===false` → 点击过但未确认；**字段缺失 → 无停止结果，同样不得声称已停止**。

窗口名由 `profile.displayName` 派生（`guiAppNameOf()`，剥说明性括号与通用后缀，剥空退回原名），不再按 `agentId` 硬编码。**明确不做**：`initialize()` 不自动 CDP 重连去点停止——重启后无会话锚点、适配器对无归属证明的实例 fail-closed，自动动手风险高于收益。

### 5.6 幂等键：派单与验收的重试安全（issue #15）

`run_task`（有项目与无项目两条派发路径）与 `verify_task` 都接受可选 `idempotencyKey`，实现集中在 `src/tasks/idempotency.ts`（`IdempotencyIndex`），由 `makeHandlers()` 闭包持有——**不进 `AppContext`**，避免牵动全部构造点（含测试假上下文）。

| 决策 | 实现 |
|---|---|
| 命名空间 | `run_task` / `verify_task` 各自独立（映射键为 `scope\u0000key`） |
| 入参摘要 | `canonicalDigest()`：稳定序列化（对象键排序、`undefined` 省略）→ 同键异参 fail-closed；摘要只取「已解析入参 + 规范化路径」，不含运行期默认值与 profile 派生物 |
| 命中判定 | `lookup()`：TTL 过期即 miss 并惰性清除；`hit` / `conflict` / `miss` 三态 |
| `run_task` 命中 | 恒返回原 `taskId` 与当前 meta（含终态，只读不重派）；记录存在但任务快照不可读 → 视为未生效，重新派发 |
| `verify_task` 命中 | 已完成 → 返回既有 `reportRound`/结论/报告路径（不重跑）；执行中 → 成功结果 + `idempotencyReplay: "in_progress"`（不是 `isError`） |
| 并发 | `runExclusive()` 按 `(scope,key)` 串行化「二次判定 → 落映射 → 建任务」，并发同名请求不会各建一个任务 |
| 崩溃窗口 | 同一临界区内**先落映射、后建任务**；`TaskManager.submit()` 因此接受可选 `taskId` |
| 落盘 | `<数据目录>/idempotency.json`（原子写、TTL 与 `maxEntries` 裁剪）；损坏时告警并从任务快照重建一次（依据 `TaskMeta.idempotencyKey/Scope/Digest`） |
| 写失败 | fail-open：仍返回已派发的任务，响应与 meta 明示「无法被同键重放」 |
| 键隐私 | 键明文只落本地快照与映射文件；日志与事件流只用 `keyDigest()`（sha256 前 8 位） |

**「执行中」标记是进程内的**（`reserveInFlight` / `releaseInFlight`）：重启后未完成的验收不会被缓存（没有报告可返回，重试即重新执行，如实），也避免映射挂着 `in_progress` 而引擎已死。

**边界**：`verify_task(taskId=…)` 的键**不写入任务快照**（该字段承载任务的派单键，避免覆盖），这一种组合的重建覆盖依赖 `idempotency.json`；不给 `rework_task` / `continue_task` / `cancel_task` / 视觉基准工具加键；不做跨进程分布式幂等（与 visual lock 同一假定）。

### 5.7 细粒度事件流：长任务可观测性（issue #18）

`query_task` 原先只能返回粗粒度状态：长任务（尤其 GUI agent 卡在确认弹窗 / 文件选择对话框 / 授权提示）下，调用方无法区分「agent 正在正常工作」与「已卡死等待人工干预」。本能力让适配器在关键节点上报语义事件。

词表定义在 `src/agents/agent-events.ts`（**零依赖**，避免 `adapter.ts` / `tasks/task.ts` / `tasks/task-store.ts` 之间的循环引用）：

| 事件 | 语义 |
|---|---|
| `task_dispatched` | 指令已确认送达 agent |
| `confirmation_dialog_detected` | 检测到确认类对话框（含残留弹窗清理、原生「选择文件夹」） |
| `awaiting_user_authorization` | 等待用户授权 / 登录 / 确认 |
| `file_modification_started` | agent 开始执行（**启发式**：界面运行信号首次出现，不声称文件已改动） |
| `rework_triggered` | 验收失败后进入返修（引擎侧统一上报，`mode` 区分 auto/manual） |

| 决策 | 实现与理由 |
|---|---|
| 钩子归属 | `AgentRunOptions.onEvent`（`src/agents/adapter.ts`），**不是** agent profile——`agent-profiles.json` 是纯 JSON，装不下函数，硬塞会破坏 `AgentProfilesFileSchema` 解析与热重载。「可选」由 `opts.onEvent?.()` + `makeEmitter` 表达 |
| 存储 | 写**既有** `task.jsonl`（复用 `TaskStore.appendEvent`），**不建内存环形缓冲**：GUI 长任务中宿主可能重启，纯内存队列会丢掉最需要的现场；并行流会产生第二个事实来源与排序不一致 |
| 内存有界 | 在**读取侧**：新增 `readTextTail(p, maxBytes)`（`src/util/fs.ts`）+ `TaskStore.readRecentAgentEvents(taskId, limit, maxBytes=64KiB)`，只读尾部窗口，内存占用与文件总大小解耦。`readTextTail` 保证从完整行开始（截断点落在换行符上时不丢整行） |
| 上报健壮性 | 适配器一律经 `makeEmitter`：未提供钩子时空操作，且**吞掉上报异常**——事件上报属观测能力，绝不允许影响任务本体 |
| 暴露 | `query_task` 的 `eventLimit`（1..50，缺省 10）；`MetaBlockFields.recentEvents`（经 `metaFromTask(meta, extra)` 的 `...extra` 透传）+ 文本区「最近事件」段落。未上报的适配器返回空数组，其余字段与 v0.6.2 一致 |
| 本版范围 | 只有 **codex** 与 **traework** 真正上报（各 4 个发射点）；zcode / kimicode / qoder 与全部 CLI 适配器保留接口、暂不上报 |
| 与 `note` 的关系 | `note` 语义不变，仍是进度 / 审计通道（承载 `progressSummary` / `lastRunSignal`）；`recentEvents` 只过滤词表内 5 类，不混入 `note` |

**如实披露**：事件属观测能力而非交付保证——不保证送达，`query_task` 只反映「最后一次落盘的事件」；`file_modification_started` 是启发式推断，确切改动证据请看验收报告的 `changedFiles` / `diffstat`。详见 [事件流](docs/event-stream.md)。

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
0. 互斥键     withVisualLock(task:<taskId>) → withVisualLock(realpath(projectPath))；同任务重复验收直接拒绝
1. 基线       采集或复用 git 基线（verify_task 复用任务已存基线）
2. 解析检查项  优先级：extraChecks > 项目 .tianshu-mcp/acceptance.json
                        > projects.json 的 verify > 按项目类型推导的默认集
3. 快照冻结 #1 冻结视觉规则/基准摘要（**与 visual.enabled 无关，恒定执行**）
4. git 检查   内置 git-diff-check 最先执行（git diff --check，覆盖基线→HEAD 与工作区）
5. 命令检查   串行或受限并行（verifyConcurrency，默认 2，钳制 1..4）
               并行时各写 verify-<round>.parts/NNN-<name>.log，事后按声明顺序合并回主日志
6. 视觉检查   仅当 acceptance.json 开启 visual.enabled；命令检查之后跑（读 build 产物）
7. 代码分析   相对基线归因变更集 → 变更清单 / diffstat / 可疑标记
8. 变更闸门   git 项目「零净变更」判失败（requireChanges 默认 true，可关）→ 追加 no-changes 检查项
9. 快照核对 #2/#3 命令后与视觉后再各核对一次；摘要漂移即 VISUAL_INTEGRITY
```

> **注意顺序**：内置 `git-diff-check` 在**配置的检查项之前**执行，视觉检查在**命令检查之后**执行（页面往往需要先 build）。
> 快照冻结与核对**不受 `visual.enabled` 控制**——`enabled` 只决定是否真的跑截图/规格/内容判定；也就是说，
> 「视觉未启用」并不等于「完全没有视觉相关动作」，而是「不做视觉比对，但仍会冻结并核对摘要」。
> 这样改验收配置或基准文件本身也会被检出（`VISUAL_INTEGRITY`）。

**检查项自动推导**（`deriveDefaultChecks`）：读 `package.json` 的 `typecheck / lint / test / build` 脚本 → 映射为 `npm run <script>`；有 `tsconfig.json` 无脚本 → `npx tsc --noEmit`（optional）；`pytest.ini` → `pytest -q`；`go.mod` → `go test ./...`；`Cargo.toml` → `cargo test`（后三者均 optional）。

**命令执行**：`cross-spawn` + 结构化 argv + `shell:false`（**命令不拼 shell**，见 §12）；`windowsHide:true`；超时 `verifyCommandTimeoutMs`（默认 5 分钟）。

**三个 fail-closed 保护**：

1. **零用例保护**——test 类命令退出码为 0 但未收集到任何用例时，翻转为失败（防「测试什么都没跑」假绿）。判据是 `# tests 0`、`no tests found`、`no tests ran`、`0 tests (ran|executed|found)` 等输出形态 + 检查项名/命令形态识别为测试。
2. **零变更保护**——git 项目无净变更判失败：追加一条 `no-changes` 失败项（`requireChanges: false` 显式关闭后只记说明）。纯分析/问答类任务必须显式关闭。
3. **取消即失败**——本轮任一时刻被取消时 `passed=false`，未启动的检查记 `skipped`（reason「任务取消，未执行」）。

### 7.1 git 基线归因（`src/verify/git-baseline.ts`）

**绝不 stash / commit / 回滚**。流程：

1. 记录 `HEAD`、`git status --porcelain -uall` 的已跟踪改动与未跟踪文件。
2. 对**动工前就已存在的脏文件**逐个算内容哈希（大文件 >4 MiB 跳过；未跟踪文件上限 5000，超出记 `untrackedHashTruncated`）。
3. 验收时按 `baseline.head` 求差：`git diff --numstat <baseRef> HEAD`（agent 若移动了 HEAD）与 `git diff --numstat HEAD`（工作区）合并。
4. **归因**：动工前就脏、且当前哈希与基线一致的文件被排除在「本轮变更」之外；哈希被截断的文件标 `unattributable` 并排除，同时给出聚合说明。这样报告里的 `changedFiles` 反映的是**本轮 agent 真实改动**，而非仓库原有脏状态。

### 7.2 报告产物（`src/verify/report.ts`）

`report-<round>.md` 结构：标题与头部元信息 → `## 自动命令检查`（每项 `[PASS]/[FAIL]/[SKIP]` + 退出码 + 输出尾部）→ `## 代码分析`（变更清单 / diffstat / 可疑标记与告警）→ `## 结构化修复指令` → 视觉证据 → 人类可读结论。`report-<round>.json` 为同源机读版本（含 `repairDirectives` 字段）。

可疑标记扫描（`src/verify/signals.ts`）是**确定性正则**，只做提示不单独判失败：`TODO/FIXME/HACK/XXX`、`console.*` / `debugger`、连续 3 行以上整行注释、疑似密钥字面量。

### 7.3 结构化修复指令（`src/verify/directives.ts`，issue #19）

返修报告是整篇叙述，agent 要自己定位「哪一行类型不匹配、哪个文件有 TODO」，推理开销高且易理解偏差。本模块把失败原因解析为**可直接执行的动作** `{file?, line?, issue, action, source}`。

| 决策 | 实现与理由 |
|---|---|
| 匹配方式 | 仓库内**没有** per-verifier 模块（typecheck/test/build 都是通用 argv 命令检查），因此 source 按「检查项 name / argv 启发式」+ 报告内结构化数据匹配 |
| 内置来源 | `typecheck`（解析失败类型检查项 `outputTail` 的 pretty / plain 两式 TS 报错，绝对路径归一化为项目相对 posix 路径，同处报错去重）；`diffstat`（超大单文件改动、被改动的锁文件、TODO / 调试输出 / 疑似密钥的行级计数） |
| **不**做 test 类提取 | 测试框架输出没有稳定的文件/行号，强行解析会产出**错误**定位，比不给更糟 —— 这类一律走回退 |
| 绝不抛错 | 单个 source 异常被吞掉并记入 `fallbackReason`，其余 source 继续工作 |
| 显式回退 | `fallbackReason` 非空 ⇒ 渲染方（两块返修计划、返修消息）必须写明「不可用」并要求 agent 回到完整失败输出，**不允许静默留空** |
| 失败轮次才提取 | 通过的轮次没有要修的东西，提取只会徒增报告体积 |
| 持久化 | 落 `report-<round>.json`：手动返修路径会重读该文件，且需跨 server 重启存活 |
| 行级信号不伪造文件 | `signals.ts` 只做计数、无稳定文件与行号，故对应指令**省略** `file` 字段 |

**已知限制**：`CheckResult.outputTail` 被截断到最后 4000 字符（`runner.ts`），大型项目的类型错误总量可能远超此数，**只能提取到尾部错误**，其余靠回退兜底 —— 这是有意接受的取舍（不为提取放大报告体积）。详见 [结构化修复指令](docs/repair-directives.md)。

### 7.4 验收配置三级继承（`src/config/acceptance-merge.ts`，issue #20）

一个天枢宿主下挂载多个同类项目时，逐项目建 `.tianshu-mcp/acceptance.json` 成本高、易遗漏。故引入继承链（优先级低 → 高）：`<数据目录>/acceptance.default.json` → `<project>/.tianshu-mcp/acceptance.json` → `run_task`/`verify_task` 的 `acceptanceOverride` 参数。解析点仍是 `resolveChecks()`。

| 决策 | 实现与理由 |
|---|---|
| **分层 schema 不带默认值** | 新增 `PartialAcceptanceConfigSchema`（所有字段可选、**无 `.default()`**）。这是本版要修的隐患：用带 `.default(true)` 的 `AcceptanceConfigSchema` 解析「只写了 verifyConcurrency」的项目文件会 materialize 出 `requireChanges: true`，**反过来覆盖全局层的 `false`**。默认值只在最终生效值缺省时由消费方兜底 |
| 合并粒度 = 字段 | 高优先级层**显式书写**的字段整体取胜；`undefined` 视为「本层未书写」，不参与覆盖 |
| 数组整体覆盖 | `checks` 写了就整段替换。拼接会让「项目追加一项检查」变成「项目无法移除全局检查」 |
| **`visual` 整体覆盖、不深合并** | `VisualConfigSchema` 几乎每个字段都带默认值：深合并时低优先级层的**显式**取值会被高优先级层「未书写、仅因默认值而出现」的字段静默覆盖（与 `requireChanges` 同类的 `.default()` 污染）。要做对必须改成「在原始 JSON 上合并、只对结果校验一次」，改动面大而收益有限，故明确选择整体覆盖 |
| 坏层 fail-closed | 某层「存在但读不了 / JSON 坏 / 字段不合法」不被当空配置跳过，而是进 `needs_attention` 并指明层与文件（`readAcceptanceLayer`，与项目级既有语义一致）；仅 `ENOENT` 才算「该层不存在」 |
| visual 取自合并结果 | `executeVerify` 不再二次读项目文件（否则 override/全局层的 visual 会随项目文件是否存在而改变语义） |
| 任务级覆盖落 `TaskMeta` | 属**任务快照数据**而非配置：不写任何 `acceptance*.json`、不影响其他任务/项目；rework/continue 沿用同一快照故继续生效 |
| 计入幂等入参摘要 | `runTaskKeyedFields()` / `verifyIdempotencyDigest()` 均纳入 `acceptanceOverride` —— 否则同键重放会返回一个「策略不同」的旧任务 |
| 每轮一行摘要 | `resolveChecks()` 输出 `生效层=… checks=… requireChanges=… verifyConcurrency=…`，日志与 `config acceptance` 命令同源，排障无需额外工具 |

**调试命令**：`tianshu-mcp config acceptance [projectPath] [--task <taskId>]`（`src/config/cli.ts`，`src/index.ts` 在创建 server 前分发）。不挂在 `visual` 命名空间下 —— `acceptance.json` 是验收引擎的配置，视觉验收只是共用一个文件。详见 [验收配置规范](docs/acceptance-config.md)。

### 7.5 dryRun 干跑模式（`src/verify/dry-run.ts`，issue #21）

`run_task` 默认直接驱动 agent 改源码，理解偏差可能产生大量需回滚的改动。`dryRun` 提供「先看方案再决定是否真干」的中间态。

| 决策 | 实现与理由 |
|---|---|
| 只读约束的注入点 | `makeBuildCtx()`（`src/mcp/context.ts`）把 `DRY_RUN_CONSTRAINT` 并入 `ctx.context`。**一次改动覆盖全部 5 个适配器**（它们都拼 `ctx.context`），且 dryRun 是 round 0 首次派发，zcode/kimicode 仅在 `initialDispatch` 附加 context 的守卫不会吞掉它 |
| 独立引擎方法而非在 `executeVerify` 分支 | `AcceptanceEngine.runDryRun()` 返回 `DryRunReport`（与 `VerifyReport` 口径不同）。并进同一条返回值就得引入联合类型或伪造一个 `VerifyReport`，既污染类型也让轮次账目变复杂 |
| 不消耗验收轮次 | 报告落 `dry-run-report-<round>.*`，文件名不匹配 `^report-(\d+)\.(md\|json)$`，故 `nextReportRound()` 的扫描天然忽略它 |
| **零改动门禁是核心证据** | `analyzeChanges()` 相对动工前基线求差，排除 MCP 自有产物（计划文件、任务书点名的 planDoc）后仍有变更 → `dry_run_violation`（error）。**不依赖计划写对**：agent 完全不产出计划时这条仍然有效 |
| 计划缺失时降级但可见 | `planExtracted: false` + `fallbackReason` 写明原因，检查降级为仅零改动门禁；报告与文案都如实标注「计划提取: 失败」 |
| 判定为 `needs_attention` 而非 `failed` | 方案有问题属**人工裁决**，不是可以自动返修的代码缺陷 |
| 不进入返修循环 | 同上：dryRun 没有「失败的代码」可修 |
| 忽略 `autoVerify` | dryRun 的语义是「先审」而不是「验收」 |
| 需要 `projectPath` | 无项目模式没有可静态分析的文件树与基线，`runTasksWithoutProject` 显式拒绝而不是退化成普通任务 |
| 方案文档落在**项目内** | `.tianshu-mcp/dry-run-plan-<taskId>.md`：`planDoc` 只能读项目文件，放任务数据目录会让 agent 够不到。`meta.dryRunPlanDoc` 报**项目相对路径** |

**如实披露**：预演仍是一次真实的 agent 调用（消耗额度与时间）；只读约束靠任务书指令 + 事后门禁，**违反会被拦下并如实报告，但已发生的改动不会自动回滚**（MCP 从不自动 commit/stash/checkout）；静态检查只能验证「文件存在、位置对得上、无明显矛盾」，**无法判断方案本身是否合理** —— 那正是「先审」要人工做的事。另：`planDoc` 目前只由 **Codex 与 Qoder CN** 消费，CLI 类与 ZCode/Kimi Code/TraeWork 不读取，对这些 agent 需把方案路径写进 `task` 文本。详见 [dryRun 干跑模式](docs/dry-run.md)。

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
- **GUI 路径**：五个 adapter 的 `buildInvocation()` 直接抛错，`run()` 承担全部 CDP 编排。Codex / ZCode / Kimi Code / Qoder CN **四个 adapter 各带一道模块级串行门**（同一适配器的任务排队；排队中被取消者直接返回 `aborted` 而不越位）；TraeWork 没有串行门，它依赖「每项目串行队列 + 全局并发闸」这一层。

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

### 8.2 五个 GUI driver 的执行顺序（实测结论，勿随意调整）

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

**Qoder CN**（CDP 驱动，自带发送检查点）：

```text
发现安装（显式 gui.exePath → D 盘优先候选 → 相对路径模板 → 标准目录；非 win32 直接 hardFailure(unsupported_platform)）
  → 启动/复用 CDP 实例（已有实例无可用 CDP → needs_user(close_existing_instance)，保留现场不重启）
  → 新建会话（或按 resumeId 恢复原会话） → 绑定工作区（完整路径判据；未登记走「新建工作区」原生导入）
  → 选模型（默认/自定义分组精确匹配 + modelSource 消歧） → 思考等级（模型管理保存后重开回读）
  → 发送前落检查点 qoder-session.json → 标记 + 有界确认 → 运行检测（data-send-button=generating）
  → 本轮 user id ↔ assistant:<user id> 配对且出现 data-assistant-actions → 轮询到完成
```

> **完成判定必须绑定本轮用户消息**：历史回复里的「完成」、界面静止、连接断开都不算；
> 提问/审批等等待项优先于停止按钮，先判 `needs_user`，避免死锁成 `running`。
> 发送与答题提交前先写检查点，**未确认回执时只观察、绝不自动重发**；`continue_task` 对审批/登录等
> 环境等待只恢复观察，仅 `agent_question` 把答案写回原会话（多题使用「完整问题文字 → 答案」的 JSON 对象）。
> 界面静止但没有本轮完成证据 → `pause("setup_recovery")`，**不进入验收**，也不产出 `idle_timeout`。
> 取消只停**已绑定的原会话**（`stopQoder` 连续两次观测到非运行才认 `idle`），未确认时保留实例并阻止重派。
> macOS 为 `research` 且禁止派发。

### 8.3 完成判定：运行信号优先，完成标志其次

五个 driver 共用同一条判据原则（实现分别在各自的 `liveness.ts`）：

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

`endReason`（每个 agent 实际产出的取值，按适配器代码归纳）：

| Codex | TraeWork | ZCode | Kimi Code | Qoder CN |
|---|---|---|---|---|
| `reply_stable`（成功） | `completion_mark`（成功） | `reply_stable`（成功） | `reply_stable`（成功） | `completion_mark`（成功） |
| `aborted` | `ask_user`（成功但被阻塞） | `aborted` | `aborted` | `aborted` |
| `task_timeout` | `timeout` | `task_timeout` | `task_timeout` | `task_timeout` |
| `idle_timeout` | `idle_no_completion` | `idle_timeout` | `idle_timeout` | **不产出**（静止但无完成证据 → `setup_recovery`） |
| `needs_user` | `setup_failed` | `needs_user` | `needs_user` | `needs_user`（`pause()` 以 kind 同时充当 endReason） |
| `setup_failed` | `cdp_lost` | `setup_failed` | `setup_failed` | `unsupported_platform`（非 Windows） |
| `instance_busy` | — | `cdp_disconnected` | `instance_busy` | `qoder_error`（运行期错误，原文带具体原因） |
| `project_ambiguous` | — | `project_ambiguous` | — | — |
| `project_create_failed` | — | `project_mismatch` | — | — |
| `project_mismatch` | — | `project_not_registered` | — | — |
| `model_unavailable` | — | `model_unavailable` | `model_unavailable` | — |
| `model_mismatch` | — | `model_mismatch` | `model_mismatch` | — |
| `permission_unknown` | — | `permission_unknown` | `permission_unknown` | — |
| `input_mismatch` | — | `input_mismatch` | `input_mismatch` | — |
| `send_unknown` | — | `send_unknown` | `send_unknown` | — |
| `cdp_disconnected` | — | `session_lost` | `cdp_disconnected` | — |
| `internal` | — | `internal` | `internal` | — |
| — | — | — | `agent_error`（界面出现「继续」按钮或失败文案） | — |

> Kimi Code 以**工作区**（而非项目）组织任务，因此不产出 `project_*` 系列；绑定失败统一走
> `setup_failed` 或 `needs_user(setup_recovery / system_permission)`。
> Qoder CN 把具体失败原因写在 `error` 文本里（`qoder_model_ambiguous` / `qoder_workspace_mismatch` /
> `qoder_question_*` / `qoder_session_lost` 等），`endReason` 统一为 `qoder_error`。

`needsUserKind`（联合类型共 6 种，各 driver 实际产出的子集不同）：

| 取值 | 含义 | 产出方 |
|---|---|---|
| `agent_question` | agent 在 UI 里向用户提问 | ZCode、Kimi Code（需配置 `gui.selectors.userGate` 才启用启发式提问检测）、Qoder CN（专用答题控件） |
| `user_confirmation` | 停在等待用户确认的界面 | Codex、Kimi Code、Qoder CN |
| `login_required` | 需要登录 | Codex、ZCode、Kimi Code、Qoder CN |
| `close_existing_instance` | 已有实例未开 CDP 端口，需用户关闭 | ZCode、Kimi Code、Qoder CN（**Codex 不产出**：其 `ensureInstance` 声明了 `needsClose` 却从不返回 true） |
| `system_permission` | 系统权限不足（如 macOS 辅助功能） | ZCode、Kimi Code |
| `setup_recovery` | 自动恢复预算耗尽 / 发送结果不确定，需人工介入 | ZCode、Kimi Code、Qoder CN |

> **Qoder CN 是唯一能产出全部 6 种 kind 的适配器**（`pause(kind, …)` 把 kind 同时当作 `endReason`）。
> TraeWork 不产出 `needsUserKind`：它的「向用户提问」被当作正常结束（`ask_user`）并释放实例，且**完全不读 `ctx.resume`**——所以 `continue_task` 对它无意义。

### 8.5 注册表与可执行探测（`src/agents/registry.ts`）

- 构造时预注册六个 `CliAdapter` 基座（codex / zcode / traework / kimicode / qoder / stub），随后按 `profile.adapter` 换装 GUI 实现（`codex-gui` / `zcode-gui` / `traework-gui` / `kimicode-gui` / `qoder-gui`）；仅当实现类变化时才重建。
- `resolve(agentId)` 按 profile 的 `status` 分支：
  - `unsupported` → 直接失败；
  - `research` → ZCode 走专用 `discoverZcode`，其他走通用探测；
  - `ready` → 顺序为「显式绝对路径 → 发现目录扫描 → PATH（`where` / `which`）」；占位符命令（`<...>`）被拒绝。
- 特殊探测分支：`codex-gui` 走 `discoverCodex`（Appx 查询 + 扫盘），`kimicode-gui` 走 `discoverKimicode`（盘根相对路径 + 标准目录 + macOS bundle），`qoder-gui` 走 `discoverQoder`，`traework-gui` 走 `discoverTraework`（二者均**额外要求 `process.platform === "win32"`**——非 Windows 直接 `ok:false`，即使探测到安装也不允许派发）。四个 `discovery.ts` 共用同一顺序骨架：显式路径 → 固定盘相对路径（`preferredDrives` 优先）→ 注册表 `InstallLocation` → 快捷键（qoder/traework）→ 标准目录（含 macOS bundle）→ PATH。
- `profile.adapter` 显式判别优先于 `driver`：`driver:"spawn"` + `adapter:"codex-gui"` 仍会换装 GUI 实现。`ensureAdapterFor` 只在**实现类变化**时重建，因此 ad hoc 换装不会打断正在运行的任务。
- 选择器覆盖机制：TraeWork / ZCode / Codex / Kimi Code / **Qoder CN** 均为「**覆盖优先 → primary → 回退链**」（Kimi Code 的 overlay 选择器用 `overlay.<key>` 命名空间）。Qoder CN 自 v0.6.2 起由单值覆盖升级为与 Codex 同构的分层结构（`QoderSelectorSpec`：`primary/fallbacks/texts/ariaLabels/ariaPatterns/verifiedVersion`），`QoderCdpClient` 的 `selector()` 仍返回字符串首选以保持既有语义，另增 `candidates()/existsKey()/clickKey()` 按候选顺序「先探测后点击」。
- 选择器漂移诊断（v0.6.2，issue #23）：`src/agents/gui-diagnostics.ts` 提供 `visibleLabelsExpr()`（页面内表达式，收集可见候选 aria-label / 短文本）与 `withDiagnostics()`（幂等追加「页面可见候选=[…]」后缀）。codex / qoder / traework 三者在选择器解析失败时统一附上该信息，便于一步定位漂移；各 agent 的 `selectors.ts` 以 `verifiedVersion` 记录实测版本。
- 目录扫描按深度 6 内查找候选，跳过 `node_modules` 与点目录，**取 mtime 最新者**。
- profile 热加载靠 sha256 内容指纹（不是 mtime），因此同一时间戳内的修改也能被感知。
- `get_profiles` 列出所有已注册 adapter 键与 profile 键的并集（未解析成功的自定义 profile 也会出现），并逐条给出 `[PASS]/[FAIL]` 与探测来源。

### 8.6 GUI 实例生命周期

| 环节 | 机制 |
|---|---|
| 启动 | 五处统一走 `guiInstanceSpawnOptions()`：**无条件** `detached: true` + `unref()`（`stdio:"ignore"`） |
| 复用 | 优先复用受管实例（Codex 以专属 `--user-data-dir` 判等；ZCode / Kimi Code / Qoder CN 扫端口范围；TraeWork 直接探测端口）。**Qoder CN 只在不存在根进程时才 spawn，并在启动器转发退出时复用既有 CDP 端口** |
| 附着 | CDP 连接必须完成一次真实 DOM 往返（`exists("chatInput")`）才被接受 |
| 存活探测 | 每 tick 一次 DOM 求值，交给各自的 `judge*Poll` 判定 |
| 保留 | Codex / ZCode / Kimi Code / Qoder CN 几乎在所有返回路径都置 `keptInstance: true` 且从不杀进程；TraeWork 仅在干净完成（`completion_mark` / `ask_user`）时释放自己启动的实例，此时才返回 `keptInstance:false` |
| 归属核对 | TraeWork 释放前**重读实时命令行**，要求同时含记录的 `--remote-debugging-port=<port>` 与 exe 名，读不到或不匹配就放弃（避免误杀），且 `taskkill` **不带 `/T`**；Codex 只停受管实例 |
| 孤儿处理 | ZCode / Kimi Code / Qoder CN 遇到「活着但没开 CDP 端口」的实例 → `needs_user(close_existing_instance)`，交由用户处理，绝不盲杀（Codex 的 `ensureInstance` 声明了 `needsClose` 但从不返回 true，故它没有这条路径） |

> **`detached: true` 是不变量而非平台偏好**：桌面实例必须跨 MCP server 退出继续存活，才能兑现 `keptInstance` 的语义。v0.5.3 之前按平台分支（Windows 上不 detached）导致 server 一退出 GUI 就被连坐杀掉，已修复。
>
> 注意语义相反的另一族：**执行型子进程**（`agents/spawn`、`verify/runner`、`visual/services`、`visual/content-command`）仍按平台分支
> （`detached: process.platform !== "win32"`），因为它们必须随 server 一起收干净。这一族**没有**共用 helper，
> 同一段 spawn 选项字面量在四个调用点各写一份——统一化是已知技术债（见 §15）。

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
| server 配置 | `<数据目录>/config.json` | `concurrency.maxRunning`(2)、`defaultTaskTimeoutMs`(30min)、`verifyCommandTimeoutMs`(5min)、`verifyConcurrency`(2, 1..4)、`shutdown.guiStopWaitMs`(15s，关停时 GUI 停止等待的全局上限)、`idempotency.ttlMs`(24h)、`idempotency.maxEntries`(2000)、`skills.autoInstall`(true \| "prompt" \| false)、`skills.backupKeep`(3, 0..50, 0=不清理) |
| 幂等映射 | `<数据目录>/idempotency.json` | 键→taskId/digest 映射（非手写配置；原子写、惰性加载、TTL 与容量裁剪，见 §4.5） |
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
| 身份与形态 | `id`、`displayName`、`type`、`driver`(spawn\|gui)、`adapter`(traework-gui\|zcode-gui\|codex-gui\|kimicode-gui\|qoder-gui)、`status`(ready\|research\|unsupported) |
| CLI 执行 | `command`、`argsTemplate`、`promptMode`(arg\|stdin\|file)、`cwd`(task\|home)、`env`、`timeoutMs`、`killTree` |
| 可执行探测 | `executableDiscovery`：`dirs`、`fileNames`、`fallbackCommand`、`preferredDrives`、`appxPackageName`、`scanRoots`… |
| GUI 编排 | `gui`：`cdpPort`(9222)、`cdpPortRange`、`exePath`、`windowMode`、`launchTimeoutMs`(60s)、`pollIntervalMs`(3s)、`stableRounds`(12)、`idleTimeoutMs`(10min)、`stallTimeoutMs`(300s)、`cancelWaitMs`(15s)、`cdpSendTimeoutMs`(15s)、`progressIntervalMs`(30s)、`projectTriggerTimeoutMs`(15s)、`workspaceTriggerTimeoutMs`(15s，Kimi Code 草稿页判据)、`selectors`、`defaultPermissionMode`、`defaultAutoFixRounds`、`activation`(spawn\|msix-com)、`userDataDir`、`fixPlanDir`… |

`gui.selectors` 是**不改代码适配 UI 升级**的主要手段：客户端改版导致选择器失效时，先用 `scripts/probe-*.mjs` 诊断，再经 profile 覆盖。

> **声明了但当前无消费方**的字段（改这块代码前先确认，别以为配了就有用）：`gui.windowMode`（仅 schema 默认与注释提及）、
> `gui.modelRequired`（模型是否必填实际由各 `parse*Model` 无条件决定）；ZCode 的 `gui.stallTimeoutMs` / `gui.cancelWaitMs`
> 被拷进局部变量后从未使用（zcode 没有 stall 路径、也不点停止按钮）。`gui.activation` 只有 codex 真正消费。

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
9. **技能内容只来自包自身**：待安装技能经 `import.meta.url` 相对包定位，**不从 `process.cwd()` 发现内容**；内容无法证明未被改动的目标目录绝不静默覆盖（见 §3.4）。

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
| 单元 | `test/unit/` | 纯函数与组件逻辑：五个 driver 的 reply / selectors / launcher / liveness / recovery、验收引擎（含并行）、基线归因、原子写、热加载、路径闸门、视觉模块 |
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

1. **UI 信号是唯一可靠完成判据**——五个 GUI driver 都依赖 DOM 结构与可见信号。客户端升级可能使选择器漂移；先在 `selectors.ts` 或 profile 覆盖处修复，真机复验不可省。
2. **`needs_user` 状态下无法停止 GUI 内会话**——MCP 侧无 CDP 连接。终态文案会诚实提示。临时 CDP 连接停车已在 `CHANGELOG.md` 的「计划中」。
3. **单会话串行**——GUI 是单会话资源，同项目任务被 `projectBusy()` 串行化，全局并发受 `maxRunning` 限制。这是设计约束，不是缺陷。
4. **macOS 验证矩阵不完整**——Codex 与 ZCode 的 macOS 基本闭环已真机验证，但取消/返修/`continue_task`/新建项目矩阵未覆盖，故二者 darwin 仍标 `research`；TraeWork 与 Kimi Code 的 macOS 分支 fail-closed，Kimi Code 的 darwin 同为 `research`。
5. **无项目派发仅 ZCode 且仅 Windows 实测**；ZCode 未登记项目的自动导入在 Windows 上不可用（需先手动登记，或传 `allowCreateProject=false` 显式失败）。**Kimi Code 完全不支持无项目派发**（必须绑定工作区）。
6. **Kimi Code 的取消/提问续答/同名工作区歧义仅由 hermetic 集成测试覆盖**（未在真机点停、未触发真实提问卡片）。
7. **视觉模块的平台证据边界**——macOS 证据来自 CI 托管 runner，未在维护者个人 macOS 设备复验。
8. **验收 fail-closed 对纯分析任务的影响**——git 项目默认要求产生变更，纯问答/分析任务必须显式设 `requireChanges: false`。
9. **执行型子进程的 spawn 选项没有共用 helper**——`agents/spawn`、`verify/runner`、`visual/services`、`visual/content-command` 各自内联同一段平台分支字面量（`detached: process.platform !== "win32"`）。语义一致但四处重复，改动时容易漏改其中一处。
10. **若干 profile 字段声明了但无消费方**——`gui.windowMode`、`gui.modelRequired`，以及 ZCode 的 `gui.stallTimeoutMs` / `gui.cancelWaitMs`（详见 §10.3 的提示框）。
11. **重启不做自动 GUI 停止**——`initialize()` 归档遗留 GUI 任务只如实标注 + 置 `guiResidualUnconfirmed`，不自动 CDP 重连去点停止：重启后无会话锚点，适配器对无归属证明的实例 fail-closed，自动动手风险高于收益。确认由人工经 `cancel_task` 完成（§5.5）。
12. **危险目录的子树拒绝有边界残留**——`/etc` `/usr` `/bin` `/sbin` `/private/etc` 与 `c:/windows`、`c:/program files*` 已按子树拒绝（v0.6.1），但 `/var`、`/tmp`、`/opt`、`/library`、`/system`、`/root`、`c:/users` 仍只挡**精确相等的根**，其子目录可被当作工作区。这是有意取舍：macOS 的 `os.tmpdir()` 就是 `/var/folders/...`，一刀切会切断测试基座与大量合法工作区（详见 `src/util/path.ts` 的 `DANGEROUS_SUBTREES` 注释）。UNC 形态的缺口已在安全渠道另行报告，不在本仓公开修复范围。
13. **`capability` 的消费方在天枢宿主侧**——本仓只保证下发的 `_meta.capability` 与 MCP `annotations` 自洽（真值表由 `test/protocol/protocol.test.ts` 锁定）。`verify_task` 自 v0.6.1 起为 `execute`、`readOnlyHint: false`；宿主策略若硬编码该注解需相应放宽（`requireApproval` 不变，审批体验不倒退）。

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
| Qoder CN GUI 驱动细节 | [docs/qoder-cdp.md](docs/qoder-cdp.md) |
| agent profile 字段全解 | [docs/agent-profiles.md](docs/agent-profiles.md) |
| 各 agent 能力调研矩阵 | [docs/adapter-matrix.md](docs/adapter-matrix.md) |
| 项目级验收配置规范 | [docs/acceptance-config.md](docs/acceptance-config.md) |
| 视觉验收配置与排查 | [docs/visual-acceptance.md](docs/visual-acceptance.md) |
| 开发环境与提交规范 | [CONTRIBUTING.md](CONTRIBUTING.md) |
| 安全模型 | [SECURITY.md](SECURITY.md) |
