# 细粒度事件流（issue #18）

英文版：[event-stream.en.md](event-stream.en.md)

长任务（尤其是 GUI agent 卡在确认弹窗、文件选择对话框、授权提示上）下，`query_task` 原先只能返回
`running`。调用方无法区分「agent 正在正常工作」与「agent 已卡死等待人工干预」，只能盲等或超时后强行终止，
既浪费调度时间，也容易触发不必要的返修。

本能力让适配器在**关键节点主动上报语义化事件**，`query_task` 回传最近 N 条。

## 一、事件词表

| 事件 | 含义 | 何时上报 |
|---|---|---|
| `task_dispatched` | 指令已确认送达 agent | codex：发送确认循环通过后；traework：`typeAndSend` 返回后 |
| `confirmation_dialog_detected` | 检测到确认类对话框 | codex：清理残留原生弹窗、唤起原生「选择文件夹」时；traework：项目绑定经原生「选择文件夹」对话框时 |
| `awaiting_user_authorization` | 等待用户授权 / 登录 / 确认 | codex：`loginIndicator` 可见、`needs_login`、`needs_user` 判定；traework：`ask_user` 挂起 |
| `file_modification_started` | agent 开始执行 | codex / traework：运行信号（停止按钮）**首次**出现时，每轮只报一次 |
| `rework_triggered` | 验收失败后进入返修 | 引擎侧统一上报：自动返修 `mode:"auto"`，手动 `rework_task` `mode:"manual"` |

> **`file_modification_started` 是启发式推断，文案如实保留。** codex / traework 适配器**并不直接观测文件系统**，
> 只能从界面上的「运行中」信号推断执行已开始。因此其 detail 一律写「停止按钮出现，开始执行（可能开始改动文件）」——
> **不声称文件确已改动**。需要确切的文件改动证据请看验收报告的 `changedFiles` / `diffstat`。

## 二、事件存哪：同一个 `task.jsonl`

新事件与既有事件**同写一个任务事件流**（`<数据目录>/tasks/<taskId>/task.jsonl`），共用时序：

- 为什么不用内存环形缓冲：GUI 长任务中 MCP 宿主可能重启，纯内存队列会丢掉**正是最需要的那段现场**；
  另建并行流还会出现第二个事实来源、排序不统一。
- 为什么不会「内存膨胀」：膨胀风险在**读取侧**。`readRecentAgentEvents()` 只读文件的**尾部窗口**
  （默认 64 KiB，`readTextTail()` 实现），内存占用与文件总大小解耦。

既有 `note` 事件**语义不变**，仍是进度 / 审计通道（承载 `progressSummary`、`lastRunSignal` 等自由文本）。
`query_task` 的 `recentEvents` **只**过滤出上表 5 类语义事件，不会把 `note` 混进来。

## 三、`query_task` 怎么暴露

新增可选入参 `eventLimit`（整数，1..50，**缺省 10**）。返回有两处可读：

**① meta 块**（天枢可正则抽取 `---tianshu-mcp-meta---` 包裹的 JSON）：

```json
"recentEvents": [
  { "ts": "2026-09-24T11:06:26.056Z", "event": "task_dispatched", "detail": "第 0 轮指令已确认送达 Codex", "data": { "round": 0 } },
  { "ts": "2026-09-24T11:06:41.201Z", "event": "file_modification_started", "detail": "停止按钮出现，Codex 开始执行（可能开始改动文件）" }
]
```

**② 文本区**（人直接看，不必解析 meta 块）：

```
--- 最近事件（2 条，旧 → 新）---
[2026-09-24T11:06:26.056Z] task_dispatched — 第 0 轮指令已确认送达 Codex
[2026-09-24T11:06:41.201Z] file_modification_started — 停止按钮出现，Codex 开始执行（可能开始改动文件）
```

**向后兼容**：`recentEvents` 是新增的可选字段。未实现事件上报的适配器（以及所有 CLI 适配器）返回**空数组**，
文本区不出现事件段落，**其余字段与引入本能力之前完全一致**。

## 四、对适配器作者：如何让新适配器上报事件

上报是**可选能力**，实现与否由适配器自行决定：

```ts
import { makeEmitter } from "../agent-events.js";

async function runXxxTask(args: RunXxxArgs): Promise<AgentRunResult> {
  const emit = makeEmitter(args.opts.onEvent);
  // …
  await emit("task_dispatched", "指令已送达", { round: ctx.round });
  // …
}
```

要点：

1. 钩子挂在 `AgentRunOptions.onEvent`（**不是** agent profile —— `agent-profiles.json` 是纯 JSON，装不下函数，
   硬塞进去会破坏 schema 解析与热重载）。
2. **一律经 `makeEmitter` 上报**。它把「未提供钩子」变成空操作，并吞掉上报过程中的异常 ——
   事件上报属观测能力，**绝不能影响任务本体**。
3. 无需修改 `AgentProfileSchema`。「可选」由调用侧 `opts.onEvent?.(…)` 与 `makeEmitter` 共同表达，
   未实现的适配器**一个字节都不用改**。
4. 当前真正上报事件的内置适配器：**codex**、**traework**（issue #18 的验收范围）。
   zcode / kimicode / qoder 与全部 CLI 适配器保留接口、暂不上报。
