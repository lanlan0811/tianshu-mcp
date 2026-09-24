# v0.6.3 — 细粒度事件流（长任务可观测性）

> 关联 issue：[#18](https://github.com/lanlan0811/tianshu-mcp/issues/18)。详见 [事件流文档](event-stream.md)。

## 背景

v0.5.9 已具备 `needs_user` / `needsUserKind` / `agentEndReason` / `guiStopUnconfirmed` 等状态字段，
但在长任务场景（尤其 GUI agent 卡在确认弹窗、文件选择对话框、授权提示上）下，`query_task` 仍只能返回
`running`。调用方无法区分「agent 正在正常工作」与「agent 已卡死等待人工干预」，只能盲等或超时后强行终止，
既浪费调度时间，也容易触发不必要的返修。

## 新增

- **细粒度事件流**：适配器在关键节点主动上报语义事件，`query_task` 回传最近 N 条。

  | 事件 | 发射点 |
  |---|---|
  | `task_dispatched` | codex：发送确认循环通过后；traework：`typeAndSend` 返回后 |
  | `confirmation_dialog_detected` | codex：清理残留原生弹窗（`closeDialogs > 0`）、唤起原生「选择文件夹」；traework：`bindProject` 经原生「选择文件夹」对话框（含失败） |
  | `awaiting_user_authorization` | codex：`loginIndicator` 可见、`needs_login`、`needs_user` 判定；traework：`ask_user` 挂起 |
  | `file_modification_started` | codex / traework：运行信号（停止按钮）**首次**出现，每轮一次 |
  | `rework_triggered` | 引擎侧：自动返修 `mode:"auto"`（含轮次与失败检查项名）；手动 `rework_task` `mode:"manual"` |

- **`query_task` 新增可选入参 `eventLimit`**（整数 1..50，缺省 10）。事件有两处可读：meta 块的
  `recentEvents` 数组（含 `ts` / `event` / `detail` / `data`），以及文本区的
  `--- 最近事件（N 条，旧 → 新）---` 段落。
- **新增模块**：
  - `src/agents/agent-events.ts` —— 零依赖事件词表（`AGENT_EVENT_NAMES` / `AgentEvent` / `OnAgentEvent` /
    `isAgentEventName` / `makeEmitter`）。
  - `src/util/fs.ts` 的 `readTextTail(p, maxBytes)` —— 字节有界的尾部读取，丢弃首个残行。
  - `TaskStore.readRecentAgentEvents(taskId, limit, maxBytes = 64KiB)` —— 读尾 → 解析 JSONL →
    按词表过滤 → 取最后 `limit` 条。

## 关键设计决定

| 决定 | 理由 |
|---|---|
| 事件写入**既有** `task.jsonl`，不建内存环形缓冲 | GUI 长任务中宿主可能重启，纯内存队列会丢掉最需要的现场；并行流会产生第二个事实来源、排序不统一 |
| 内存有界靠**读取侧**（尾部 64 KiB 窗口） | 真正的膨胀风险在读取；`readTextTail` 让内存占用与文件总大小解耦 |
| 钩子挂在 `AgentRunOptions.onEvent`，**不改 agent profile** | issue 原文建议「在 agent profile 中新增 onEvent」，但 `agent-profiles.json` 是纯 JSON，装不下函数，硬塞会破坏 schema 解析与热重载。「可选」由 `opts.onEvent?.()` + `makeEmitter` 表达 |
| 适配器统一经 `makeEmitter` 上报 | 未提供钩子时空操作、吞掉上报异常 —— 上报失败**绝不影响任务本体** |
| 本版只在 **codex + traework** 真正上报 | 满足验收标准「至少一个内置 GUI agent」，其余适配器保留接口、一个字节都不用改 |
| `file_modification_started` 文案如实保留 | 适配器并不直接观测文件系统，只能从界面运行信号推断；detail 写「可能开始改动文件」，**不声称已改动** |

## 兼容性

- **无工具契约、数据模型或 MCP 注解变更**。
- `recentEvents` 为新增可选字段：未实现上报的适配器（含全部 CLI 适配器）返回**空数组**，
  文本区不出现事件段落，**其余字段与 v0.6.2 完全一致**。
- 手动 `rework_task` 写入的事件由匿名 `note` 变为类型化 `rework_triggered`（事件流内容变化，
  不影响任何工具返回结构）；`note` 的既有语义与用途不变。

## 测试

- 新增 36 个用例（4 个文件）：
  - `test/unit/agent-events.test.ts`（15）：`readTextTail` 边界（尾长超预算丢残行、截断点落在换行符上不丢整行、不存在返回 null）；`readRecentAgentEvents` 过滤 / limit / 时间正序 / 坏行跳过 / 尾部窗口挤出远古事件；`makeEmitter` 空操作与异常吞掉；词表完整性。
  - `test/unit/fix-loop-events.test.ts`（4）：编排器把 `opts.onEvent` 原样落进 `task.jsonl` 并同步快照；状态字段取上报时状态；不上报适配器行为不变；落盘异常被隔离、任务仍 `succeeded`。
  - `test/integration/codex-flow.test.ts`（新增 5）：既有项目派发 + 开始执行各一次且不重复；新建项目清理残留弹窗与原生文件夹对话框各一次；登录指示 → 仅 `awaiting_user_authorization` 且未派发；未提供 `onEvent` 正常；钩子抛错不影响结果。
  - `test/integration/traework-events.test.ts`（5）：派发 + 运行信号首次跃迁各一次；`ask_user` → `awaiting_user_authorization`；原生对话框绑定 → `confirmation_dialog_detected`（带 `{dialog, bound}`）；未提供 `onEvent` 正常；钩子抛错不影响结果。
  - `test/integration/query-events.test.ts`（7）：未上报适配器 `recentEvents` 为空且其余字段不变；上报后 meta 与文本区都能看到；`eventLimit` 取最近 N 条；缺省 10 条；`eventLimit: 51` 被协议层拒绝；手动返修 `mode:"manual"`；自动返修 `mode:"auto"`（含轮次与失败检查项名）。
- 全量 `npm test`：**1002 passed / 12 skipped**（93 文件；v0.6.2 为 966 passed / 12 skipped，净增 36）。
- `check:stdio`：dist 与 src 均 **8/8**（未新增工具，场景数不变）。

## 真机记录

**待补（交付后执行）**：用 `scripts/probe-codex.mjs` / `scripts/probe-traework.mjs` 各跑一次真实 GUI 任务，
在 `query_task` 输出中确认 5 类事件按预期出现（尤其「卡在原生弹窗」场景下的
`confirmation_dialog_detected` / `awaiting_user_authorization`），并把输出落 `docs/` 证据文件。
本版以单测 + 假 CDP 集成测试为门禁。
