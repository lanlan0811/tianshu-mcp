# Fine-grained event stream (issue #18)

Chinese version: [event-stream.md](event-stream.md)

For long tasks — especially GUI agents stuck on confirmation dialogs, file pickers or authorization
prompts — `query_task` used to return only `running`. Callers could not tell "the agent is working
normally" apart from "the agent is stuck waiting for a human", so they had to either wait blindly or
kill the task on timeout, wasting scheduling time and triggering unnecessary rework rounds.

This capability lets adapters **proactively report semantic events** at key nodes; `query_task`
returns the most recent N of them.

## 1. Event vocabulary

| Event | Meaning | Emitted when |
|---|---|---|
| `task_dispatched` | Instruction confirmed delivered to the agent | codex: after the send-confirmation loop passes; traework: after `typeAndSend` returns |
| `confirmation_dialog_detected` | A confirmation dialog was detected | codex: clearing stale native dialogs, or raising the native "select folder" dialog; traework: project binding went through the native "select folder" dialog |
| `awaiting_user_authorization` | Waiting for the user to authorize / log in / confirm | codex: `loginIndicator` visible, `needs_login`, `needs_user` verdict; traework: `ask_user` suspension |
| `file_modification_started` | The agent started executing | codex / traework: the **first** time the running signal (stop button) appears; reported once per round |
| `rework_triggered` | Entering rework after acceptance failed | Emitted engine-side: automatic rework `mode:"auto"`, manual `rework_task` `mode:"manual"` |

> **`file_modification_started` is a heuristic and its wording says so.** The codex / traework
> adapters do **not** observe the filesystem directly; they can only infer that execution started
> from the UI's "running" signal. Its detail therefore always reads "stop button appeared, execution
> started (files may be modified)" — it **does not claim files were actually changed**. For hard
> evidence of file changes, read `changedFiles` / `diffstat` from the acceptance report.

## 2. Where events live: the same `task.jsonl`

New events are written into the **same task event stream** as existing events
(`<data home>/tasks/<taskId>/task.jsonl`), sharing one timeline:

- Why not an in-memory ring buffer: during long GUI tasks the MCP host may restart, and a purely
  in-memory queue would lose **exactly the scene you most need**. A second parallel stream would also
  create a second source of truth with no shared ordering.
- Why it can't grow memory without bound: the risk is on the **read** side. `readRecentAgentEvents()`
  reads only a **tail window** of the file (64 KiB by default, via `readTextTail()`), so memory use is
  decoupled from total file size.

The existing `note` event is **unchanged** in semantics — it remains the progress / audit channel
(carrying free text such as `progressSummary` / `lastRunSignal`). `recentEvents` in `query_task`
**only** filters the five semantic kinds above and never mixes `note` in.

## 3. How `query_task` exposes it

New optional input `eventLimit` (integer, 1..50, **default 10**). The result is readable in two places:

**① The meta block** (a Tianshu host can regex out the JSON wrapped in `---tianshu-mcp-meta---`):

```json
"recentEvents": [
  { "ts": "2026-09-24T11:06:26.056Z", "event": "task_dispatched", "detail": "第 0 轮指令已确认送达 Codex", "data": { "round": 0 } },
  { "ts": "2026-09-24T11:06:41.201Z", "event": "file_modification_started", "detail": "停止按钮出现，Codex 开始执行（可能开始改动文件）" }
]
```

**② The text area** (for humans, no meta parsing needed):

```
--- 最近事件（2 条，旧 → 新）---
[2026-09-24T11:06:26.056Z] task_dispatched — 第 0 轮指令已确认送达 Codex
[2026-09-24T11:06:41.201Z] file_modification_started — 停止按钮出现，Codex 开始执行（可能开始改动文件）
```

**Backward compatible**: `recentEvents` is a new optional field. Adapters that do not implement event
reporting (and all CLI adapters) return an **empty array**, no event section appears in the text area,
and **every other field is exactly as it was before this capability existed**.

## 4. For adapter authors: how to report events from a new adapter

Reporting is an **optional capability**; whether to implement it is the adapter's own decision:

```ts
import { makeEmitter } from "../agent-events.js";

async function runXxxTask(args: RunXxxArgs): Promise<AgentRunResult> {
  const emit = makeEmitter(args.opts.onEvent);
  // …
  await emit("task_dispatched", "instruction delivered", { round: ctx.round });
  // …
}
```

Key points:

1. The hook lives on `AgentRunOptions.onEvent` (**not** the agent profile — `agent-profiles.json` is
   plain JSON and cannot hold a function; forcing one in would break schema parsing and hot reload).
2. **Always report through `makeEmitter`.** It turns "no hook provided" into a no-op and swallows
   exceptions raised while reporting — event reporting is an observability concern and **must never
   affect the task itself**.
3. No change to `AgentProfileSchema` is needed. "Optional" is expressed by `opts.onEvent?.(…)` on the
   calling side together with `makeEmitter`; adapters that don't implement it **need not change a
   single byte**.
4. Built-in adapters that actually report events today: **codex** and **traework** (the scope of
   issue #18). zcode / kimicode / qoder and all CLI adapters keep the interface but do not report yet.
