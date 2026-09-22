# issue #14：server 退出路径的 GUI 终态如实化与 v0.5.9 修复计划

## 1. 目标与分析结论

让 `tianshu-mcp` 在 **server 退出 / 宿主 EOF** 与 **重启归档** 两条路径上，对 `driver="gui"` 的 agent 说出**成立**的终态：GUI 是外部桌面应用，server 对其进程没有所有权，abort 后至多"尽力点击界面停止"，因此**不得**出现「进程已终止」这类只对 spawn 子进程成立的断言。

问题来自 [#14](https://github.com/lanlan0811/tianshu-mcp/issues/14)：`src/tasks/task-manager.ts` 的 `persistInterrupted()` 对所有活动任务统一落盘 `lastMessage = "server 退出，进程已终止"`；`initialize()` 归档重启遗留任务时只写「server 重启遗留（启动时归档，不续跑）。」，既无如实说明，也无人工检查提示。后果是**编排器已死 + GUI 可能仍在继续修改用户项目 + 无人观察**。

代码复核确认的四处事实（本计划的全部立论）：

1. `persistInterrupted()` 无 `guiStop` 概念，spawn 与 gui 同一句文案；GUI 停止等待（`gui.cancelWaitMs` 默认 15s）远长于其固定 2s 预算，几乎必然写不出确认结果。
2. `fix-loop.ts` 的 `abortTerminal()` interrupted 分支（`task-manager` 竞态中的另一写方）完全不提 GUI；窗口名用硬编码三元判断，会把 `zcode`/`qoder` 都写成 "Codex"（文案失真）。
3. `fix-loop.ts` 只对 `qoder` 把 `runRes.guiStop` 落盘，其余 GUI agent 的停止结果在 shutdown 竞态里丢失。
4. ZCode / TraeWork 适配器**不点停止、不产出 `guiStop`**（v0.5.8 已注明）；"无停止结果"与"已确认空闲"必须区分，否则是新的谎报来源。

当前基线：`master`，版本 `0.5.8`，工作区仅有一处 `.gitignore` 的未提交改动（`.dsh/*`，非本次引入）。

## 2. 实现调整

### 2.1 结构化字段（`src/tasks/task.ts`）

| 字段 | 语义 | 写入点 |
|---|---|---|
| `interruptedCleanStop?: boolean` | 本次 interrupted **是否已确认** GUI 内运行停止 | `abortTerminal()` / `persistInterrupted()` |
| `guiResidualUnconfirmed?: boolean` | GUI 任务 interrupted 终态尚待人工确认残留（重启归档无条件置 true） | `initialize()`；由 `cancel_task` 人工确认后清除 |

判定矩阵（红线 8 的单一实现）：`guiStop.idle === true` → 已确认停止；`idle === false` → 点击过但未确认；**字段缺失 → 无停止结果，同样不得声称已停止**。`TaskMeta.guiStop` 语义更新为「最近一次 abort 的 GUI 侧停止结果」，对所有 agent 落盘。

### 2.2 共享纯函数（`src/tasks/task.ts`）

- `guiAppNameOf(displayName, agentId)`：由 profile 派生窗口称呼，剥掉说明性括号段与通用后缀（`Codex (ChatGPT 桌面端 GUI)` → `Codex`），**剥空则退回原名**（不做无限剥离，`TraeWork（测试）` 保持原样）；无 `displayName` 回退 `agentId`。
- `guiStopDisclosure(stop, app)`：返回 `{ clean, text }`，集中产出「已确认停止 / 未确认停止（点击过）/ 无停止结果可确认」三种如实文案，取消路径与中断路径共用，消除两套标准漂移。

### 2.3 shutdown 有界等待（`src/tasks/task-manager.ts`）

- 新增预算 `shutdown.guiStopWaitMs`（默认 15000，`config.json` 可覆盖），由 `initialize()` 注入；`initialize(maxRunning | { maxRunning, guiStopWaitMs })` 兼容历史数字签名，既有 8 处调用零改动。
- `shutdownInterrupt()` 计算**全局** deadline（全部 GUI 任务共享一份预算，退出耗时不为任务数倍数），GUI 类任务等到该 deadline；spawn 类保持原 2s 预算不变。
- `persistInterrupted()` 按 driver 分流：spawn 维持「server 退出，进程已终止」；GUI 按 `guiStopDisclosure(meta.guiStop, app)` 落文案与 `interruptedCleanStop`。若 orchestrator 已在本预算内落终态则直接返回，保留其更精确的文案。
- `initialize()` 对遗留任务逐个 `await` 并如实标注；profile 不可读时保守按 GUI 处理（宁可多提示人工检查）。

### 2.4 编排侧补齐（`src/loop/fix-loop.ts`）

- `abortTerminal()` 两分支都落 `meta.guiStop` 与 `interruptedCleanStop`/`guiResidualUnconfirmed`，append 如实披露文本；窗口名走 `deps.dataHome.getProfile()`，不再按 agentId 硬编码。
- 仅 `driver="gui"` 才套用 GUI 披露（spawn 由 `killTree` 终止，对 spawn 套 GUI 文案本身就是新的失真）。
- `runRes.guiStop` 落盘改为对所有 agent 生效。

### 2.5 人工确认与可观测（复用现有工具，不新增工具）

- `cancel_task` 对**已终态**且带待确认标记的 GUI 任务：清除 `guiResidualUnconfirmed`、置 `interruptedCleanStop = true`、追加 `gui_residual_acknowledged` 事件，**不改终态与 errorType**，返回 `cleared: true`。
- `query_task` / `list_tasks` 的 meta 块新增 `guiStopUnconfirmed`（取 `guiResidualUnconfirmed===true || interruptedCleanStop===false`），编排方据此禁止直接重派。
- 明确**不做**：不在 `initialize()` 内自动 CDP 重连去点停止——适配器对无归属证明的实例是 fail-closed 的，重启时无会话锚点，自动动手风险高于收益；如实标记 + 人工确认即满足红线 8。

## 3. 接口与默认值

| 项 | 变化 | 说明 |
|---|---|---|
| `config.json` → `shutdown.guiStopWaitMs` | 新增，默认 `15000` | server 关闭时 GUI 停止等待的**全局**上限，与 `gui.cancelWaitMs` 解耦 |
| `TaskMeta` | 新增 `interruptedCleanStop`、`guiResidualUnconfirmed` | 结构化终态事实，随 `task.json` 快照落盘 |
| meta 块 | 新增 `guiStopUnconfirmed` | 读侧单一判据 |
| `cancel_task` | 终态 GUI 任务可清除待确认标记（`cleared`） | 不新增工具，工具数仍为 11 |
| MCP 工具参数 / 状态机 | 不变 | 不新增 `TaskStatus`，不改 `TRANSITIONS` |

## 4. 测试与验收

- **单元（`test/unit/gui-stop-disclosure.test.ts`，新增 9 例）**：三态判定与文案、窗口称呼派生与"剥空退回原名"、任何输入都不得出现「进程已终止」。
- **集成（`test/integration/gui-shutdown-interrupt.test.ts`，新增 5 例）**：以真实 `CodexGuiAdapter` 子类注入脚本 adapter（必须继承真实类，否则被 `ensureAdapterFor` 重建覆盖），覆盖 shutdown 的 `idle=true` / `idle=false` / 无结果三种结果、重启归档 + `cancel_task` 确认清除、以及 spawn 类不被 GUI 分流影响。
- **配置（`test/unit/config-hotreload.test.ts`）**：`guiStopWaitMs` 默认值与覆盖生效。
- **既有回归**：`cancel-state`、`zcode-restart`、`zcode-flow`、`visual-rework` 等使用 `shutdownInterrupt()` / `initialize(number)` 的用例必须全绿（验证签名兼容与 spawn 文案零回归）。
- **门禁**：`npm run typecheck`、`npm run lint`（`--max-warnings 0`）、`npm test`、`npm run build`、`npm run check:stdio` 全部通过；目标版本 `0.5.9`。
- **人工复核**：以 GUI 任务跑一次 shutdown，读 `tasks/<id>/task.json` 与事件流，确认无「进程已终止」式断言、字段与文案符合 §2.1 判定矩阵。

## 5. 文档、提交与发布

- 本计划以中英双语独立文档保存于 `docs/plans/`（中英分文件，符合仓库惯例）。
- 同步更新：`CHANGELOG` 双文档（`[0.5.9]`）、`docs/release-v0.5.9` 双文档、`README` 双文档（工具表 + 里程碑 + 最新发布说明链接）、`ARCHITECTURE` 双文档（任务生命周期、agent 能力表、配置表）、`HANDOFF`、`docs/agent-profiles` 双文档、`docs/adapter-matrix` 双文档、技能 `SKILL.md` 与 `usage-examples.md`。
- 仅在 `master` 开发，不使用分支；按仓库规则 `git add .` + 中文提交信息，实现与文档分两次提交，依次推送 GitHub 与 Gitee。
- `v0.5.9` 标签与 `release.yml` 触发需另行确认后执行，届时核对 CI/Release 成功；`tianshu-mcp-web` 官网目录不改动。
