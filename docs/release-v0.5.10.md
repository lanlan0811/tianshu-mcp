# tianshu-mcp v0.5.10 发布说明

[English](release-v0.5.10.en.md)

**新增：`run_task` / `verify_task` 的幂等键（`idempotencyKey`）——宿主超时重试不再变成重复派单与重复验收**（[issue #15](https://github.com/lanlan0811/tianshu-mcp/issues/15)）。

## 问题

`run_task` 与 `verify_task` 都没有幂等键，而「重试」恰好发生在最需要幂等的场景（长任务、网络抖动、宿主 `tools/call` 超时）：

- `run_task` 每次调用都 `genTaskId()` 新建任务：宿主重试会对同一项目排队**两轮 agent**——重复劳动、重复消耗外部 agent 配额，而且第二轮会在第一轮的产物上继续改，验收归因随之混叠；
- `verify_task` 独立路径用 `vfy_<Date.now()>` 建记录：重试即整套验收命令重跑，`build` / `e2e` / 部署类检查的副作用被重复执行，并产生多条 `vfy_*` 记录；
- MCP 标准四注解只实现了三个（`readOnlyHint` / `destructiveHint` / `openWorldHint`），`idempotentHint` 全缺；
- 唯一的防线是技能文档里对宿主的行为约束（「同一项目勿重复派单」）——协议层没有保护，而重试往往正是宿主在不确定时的默认动作。

## 新增

### 幂等键语义

两个工具都接受可选 `idempotencyKey`（trim 后 1..128 字符、不含控制字符），**各自独立命名空间**；同一 key 的入参摘要（`digest`）参与判定，**同键异参 fail-closed**：

| 工具 | 场景 | 行为 |
|---|---|---|
| `run_task` | TTL（默认 24h）内同键同参重复提交 | **恒返回原 `taskId` 与当前 meta**，不新建任务（含终态任务，只读不重派；响应会提示改用 `rework_task` 或换新 key） |
| `run_task` | 同键但参数不同 | `Error`：`idempotencyKey '<key>' 已被任务 <taskId> 占用，但本次参数与首次提交不同` |
| `run_task` | 未传 key | 行为逐字不变；若同工作区已有未结束任务，响应点名 `projectActiveTask`（提示而非拦截） |
| `verify_task` | 同键验收**仍在执行中** | 返回**成功结果** + `idempotencyReplay: "in_progress"`（刻意不是 `isError`，避免宿主把它当失败再重试放大） |
| `verify_task` | 同键验收**已完成** | 直接返回既有报告路径与该轮 `reportRound` / 结论，**不重跑**任何检查 |
| `verify_task` | 同键但参数不同 | 与 `run_task` 同款 fail-closed 报错 |

### 落盘映射与配置

- 新数据文件 `<数据目录>/idempotency.json`：`{ version, entries: [{ scope, key, digest, taskId, kind, createdAt, reportRound?, verdict?, reportMd?, reportJson? }] }`，**原子写、惰性加载、TTL 与容量裁剪**；进程重启后仍能识别重试（跨重启重放已实测）。
- 新配置 `config.json` → `idempotency.ttlMs`（默认 `86400000` = 24h）与 `idempotency.maxEntries`（默认 `2000`，超限按 `createdAt` 逐出最旧）。
- 键**明文不入日志与事件流**：日志/事件只用 `keyDigest`（sha256 前 8 位）；键原文只落在本地任务快照与映射文件中，供审计。

### 可观测与注解

- `TaskMeta` 新增 `idempotencyKey` / `idempotencyScope` / `idempotencyDigest`（随 `task.json` 落盘；映射文件损坏时据此重建）。
- meta 块新增 `idempotencyKey`、`idempotencyReplay`（`hit` / `in_progress`）、`projectActiveTask`。
- 命中时向原任务事件流追加一条 `note`（`幂等重放：keyDigest=…（未新建任务 / 未重跑验收）`）。
- `tools/list` 的 `annotations.idempotentHint` 对 `run_task` / `verify_task` 置 `true`（其余保持 MCP 默认）。**声明幂等的前提是调用方传入 `idempotencyKey`**——工具描述、README 与技能文档三处均已写明。

### 崩溃窗口与写失败

- **先落映射、再建任务**（同一临界区内，`runExclusive` 串行化同键并发）：进程若在两者之间崩溃，重试会看到「有映射、无任务快照」并**视为未生效重新派发**——不会留下两条 agent 队列。
- 映射**写入失败 fail-open**：仍返回已派发的任务，但响应与 meta 明示「幂等记录写入失败，本任务无法被同键重放」——绝不把已经跑起来的 agent 报成派发失败。
- 映射文件**损坏**时告警并从任务快照重建一次；独立路径验收记录（`vfy_*`）的幂等键也在快照里，可一并重建。

## 明确边界

- **`verify_task(taskId=…)` 模式的幂等键不写入任务快照**：该任务的快照字段只承载它的**派单键**，避免覆盖；因此映射文件损坏时，这一种组合的键只能靠 `idempotency.json`（重建覆盖不到的只有这一种组合）。
- **「执行中」判定是进程内的**：server 重启后未完成的验收不会被缓存（没有任何报告可返回，重试即重新执行，如实）；这也避免了「映射里挂着 in_progress 但引擎已死」的假状态。
- 不给 `rework_task` / `continue_task` / `cancel_task` / 视觉基准工具加幂等键——对终态任务的重复调用本身是显式人工动作。
- 不做跨进程/多 server 共用数据目录的分布式幂等（与既有 visual lock 同一假定）；不新增任务状态、不改 `TRANSITIONS`、工具数仍为 11。

## 兼容性

**PATCH 版本**：`idempotencyKey` 是可选参数，**不传时行为逐字不变**（派发、验收、状态机、事件名一律不变）；新增配置项与 `TaskMeta` 字段全部可选，旧 `task.json` 缺字段照常工作。`verify_task` 独立路径的记录 id 由 `vfy_<时间戳>` 改为 `vfy_<时间戳>_<随机6位>`（`genVerifyId()`，同毫秒并发不再可能撞 id）。

## 门禁与证据

- 新增单元用例 16 项（`test/unit/idempotency.test.ts`）：键规范、`canonicalDigest` 稳定序列化、TTL 过期、容量逐出、跨实例恢复、损坏重建、`runExclusive` 串行化与失败不阻断、在途标记、写失败 fail-open（不依赖平台权限位）。
- 新增集成用例 8 项（`test/integration/idempotency.test.ts`）：同键重放只产生一个 `tsk_*` 目录、同键异参 fail-closed、终态照实重放、未传 key 零回归、`projectActiveTask` 提示、独立路径已完成重放不新增报告、执行中重放为成功结果、taskId 模式重放、以及**跨重启**（关停 → 同数据目录重建 server → 派单与验收同键均重放）。
- 协议用例补 `idempotentHint` 断言；配置用例补 `idempotency.ttlMs` / `maxEntries` 默认值与覆盖。
- 类型检查、lint（`--max-warnings 0`）、全量测试、构建、严格 stdio 检查（6/6 场景）、`pack:check` 全部通过。

相关文档：[项目 README](../README.md)｜[CHANGELOG](../CHANGELOG.md)｜[架构说明](../ARCHITECTURE.md)｜[交接文档](../HANDOFF.md)
