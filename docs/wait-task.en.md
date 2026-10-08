# Blocking wait primitive: `wait_task` (issue #28; merges `wait_any` as of v0.9.0)

Chinese version: wait-task.md

`run_task` is an asynchronous contract: it returns a `taskId` immediately and never blocks `tools/call`. But the intended caller — a Tianshu desktop agent session — is **turn-driven**: the agent only runs within the turn that received a user message and does nothing between turns, so it **cannot poll on its own**. In the "turn-driven caller + long task" combination the tool surface therefore missed the completion moment: previously every task completion **required a human to send a message** to trigger a check.

This capability fills that gap: `wait_task` carries the waiting with **one blocking, read-only call** (single task via `taskId`, batch via `taskIds`), returning once a task reaches a stop point — no user intervention needed.

## 1. Why it must be a blocking wait

Server-side push (`notifications/progress` etc.) cannot be relied on: the host MCP tools **return text only** (`content[].text`), call `tools/call` **synchronously per call**, and do not consume server-side push (see README "Runtime contract" C1/C2). So "waiting" can only be carried by **a single tool call** — a blocking wait is the only viable shape on the tool surface.

It **complements** the webhook notification ([issue #22](notifications.en.md)) without overlapping: the webhook receiver is an external HTTP endpoint (a human / a bot) and its result never flows back into the MCP session; `wait_task` delivers the result **back to the session that made the call**.

## 2. Stop-point definition

The "returnable point" that `wait_task` (both modes) waits for is a **stop point**:

```text
isWaitSettled(status) = isTerminal(status) || status === "needs_user"
```

- `isTerminal`: `succeeded` / `failed` / `needs_attention` / `cancelled` / `interrupted`.
- `needs_user`: **not terminal** — the task has stopped making progress and awaits a human (agent question / login / environment handling); resume it with `continue_task`.

**Why `needs_user` is also a stop point**: the moment a task truly stops making progress is the moment to wake the caller. Without waiting for it, once a task enters `needs_user` the wait would block until the timeout, and the caller would **know nothing about "the task is waiting for a person"** — yet that is exactly the status that must be relayed immediately.

## 3. Tool contracts

### `wait_task(taskId, timeoutMs?)`

Block until **a single** task reaches a stop point or the timeout elapses.

| Argument | Required | Notes |
|---|---|---|
| `taskId` | yes | The target task id |
| `timeoutMs` | no | Wait cap (ms); default `50000`, cap `600000`; values above the cap are **clamped and disclosed in the body** |

Returns: text (stop-point line / status line / next-step guidance) + a meta block, whose meta carries `waitSettled` (whether a stop point was reached) and `waitedMs` (actual wait duration).

### Batch mode: `wait_task(taskIds, timeoutMs?)`

Block until the **first task in array order** among **a group** reaches a stop point.

| Argument | Required | Notes |
|---|---|---|
| `taskIds` | yes | 1..20 task ids; all are validated up front and a **single missing id fails closed, listing the missing ids** |
| `timeoutMs` | no | Same as `wait_task` |

Returns: the snapshot of the task that reached a stop point + a meta block, and the body also lists **every task's current status**.

> It returns "the first settled in array order", not "the earliest finished": deterministic and predictable, avoiding the sorting ambiguity when `finishedAt` is missing or identical.

## 4. Timeout matrix

| Call | `timeoutMs` | Behavior |
|---|---|---|
| `wait_task` (both modes) | omitted | Uses the default `50000ms` (below the common 60 s client timeout, leaving serialization / round-trip headroom) |
| same | ≤ 600000 | Waits the given value |
| same | > 600000 | **Clamped to 600000ms** and the response body **honestly states** "clamped to the cap" |
| same | expires without a stop point | Returns the **current snapshot** + "please call this tool again to keep waiting" guidance (`waitSettled=false`) |

`timeoutMs` must be a positive integer (the schema rejects 0 / negative / non-integer).

## 5. Loop patterns

Long tasks (30–50 min) are covered by **repeated calls**: ≈50 s per round until a stop point or the user interrupts.

### 5.1 Single task (success → read report)

```text
run_task(...) → taskId
wait_task(taskId, timeoutMs=50000)
  → reached a stop point (waited 37 s): status: [PASS] succeeded
  → get_task_report(taskId)
```

### 5.2 Timeout continuation

```text
wait_task(taskId, timeoutMs=50000)
  → timed out (50 s): status: running. The task itself is unaffected;
     call wait_task again to keep waiting, or use query_task for detail.
wait_task(taskId)          # calling again continues the wait (lossless)
  → … until a stop point
```

### 5.3 needs_user loop

```text
wait_task(taskId)
  → reached a stop point (waited 12 s): status: awaiting user (resumable via continue_task).
     Call continue_task to resume, then wait_task again to keep waiting.
# The user handles it in the client (answers / logs in / closes the old instance…), then:
continue_task(taskId, message="done")
wait_task(taskId)          # keep waiting after resuming (needs_user can recur)
```

### 5.4 First of several tasks

```text
wait_task(taskIds=[tsk_a, tsk_b, tsk_c], timeoutMs=50000)   # batch mode
  → a task reached a stop point (waited 8 s): tsk_b — status: [FAIL] failed
     current status of every task: …
```

## 6. Lossless guarantee

`wait_task` (both modes) is a **pure read-only** operation (`capability: "read"`, approval-free, MCP `readOnlyHint: true`): they write no task state and touch no task body. A client truncation, a dropped connection, or a timeout — **no path affects the task's continued execution**; the worst case is that the caller calls a few more times, and `query_task` yields the latest fact after reconnecting.

Other tool calls proceed normally during the wait (SDK request handling does not block, measured):

```text
[probe] slow sent, +200ms later; fast returned in 215ms (expected ~200ms, far below 3000ms)
[probe] conclusion = requests do not block each other (concurrent handling)
```

So `cancel_task` / `query_task` / `get_profiles` are handled normally during a wait; when the connection / request is cancelled, the wait loop exits immediately via the SDK-injected `extra.signal`, leaking no background wait.

## 7. FAQ

**What happens on a timeout?**
Nothing happens to the task. The wait is read-only; a timeout returns only "current snapshot + call again". The caller can call repeatedly within the same turn (≈50 s per round; a 30–50 min task ≈ 40–60 calls).

**What if the task enters `needs_user`?**
The wait treats `needs_user` as a stop point and returns (it does not block until the timeout). After the user handles it in the client, `continue_task` resumes it and you call `wait_task` once more to keep waiting — `needs_user` can recur, which the loop pattern covers naturally.

**What if the client's single `tools/call` timeout is shorter (e.g. 30 s)?**
Set `timeoutMs` a little below it (for example 20000 ms). Even if truncated it is harmless: the caller just calls again to continue.

**Several tasks at once?**
Use batch mode (`taskIds`). It returns the first task in array order that reaches a stop point, and lists every task's current status.

**What about the original wait call after a server restart?**
The wait is **in-process**: after a restart the original wait call ends with the connection. The caller reconnects and re-checks with `query_task` — historical leftover tasks are archived as `interrupted` at startup, and a wait returns **immediately** for an already-terminal task.

## 8. Known limits

- The wait is **in-process**: after a server restart the original wait call ends with the connection (the caller re-checks with `query_task` after reconnecting).
- A single call waits at most **600 s** (a constant); longer scenarios rely on repeated calls (lossless).
- Batch mode does not know "earliest finished"; it returns the first settled task in array order.
- The default `50000ms` is a conservative value for "unknown client timeout"; if your client's single-tool timeout is shorter, adjust per §5.
