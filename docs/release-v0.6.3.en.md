# v0.6.3 — Fine-grained event stream (long-task observability)

> Related issue: [#18](https://github.com/lanlan0811/tianshu-mcp/issues/18). See the
> [event stream doc](event-stream.en.md).

## Background

v0.5.9 already had status fields such as `needs_user` / `needsUserKind` / `agentEndReason` /
`guiStopUnconfirmed`. But for long tasks — especially GUI agents stuck on confirmation dialogs, file
pickers or authorization prompts — `query_task` could still only return `running`. Callers could not
tell "the agent is working normally" apart from "the agent is stuck waiting for a human", so they had
to either wait blindly or kill the task on timeout, wasting scheduling time and triggering
unnecessary rework rounds.

## Added

- **Fine-grained event stream**: adapters proactively report semantic events at key nodes, and
  `query_task` returns the most recent N of them.

  | Event | Emission point |
  |---|---|
  | `task_dispatched` | codex: after the send-confirmation loop passes; traework: after `typeAndSend` returns |
  | `confirmation_dialog_detected` | codex: clearing stale native dialogs (`closeDialogs > 0`), raising the native "select folder" dialog; traework: `bindProject` going through the native "select folder" dialog (including failure) |
  | `awaiting_user_authorization` | codex: `loginIndicator` visible, `needs_login`, `needs_user` verdict; traework: `ask_user` suspension |
  | `file_modification_started` | codex / traework: the **first** time the running signal (stop button) appears, once per round |
  | `rework_triggered` | engine-side: automatic rework `mode:"auto"` (with round and failed check names); manual `rework_task` `mode:"manual"` |

- **New optional `query_task` input `eventLimit`** (integer 1..50, default 10). Events are readable in
  two places: the meta block's `recentEvents` array (`ts` / `event` / `detail` / `data`) and a
  `--- 最近事件（N 条，旧 → 新）---` section in the text area.
- **New modules**:
  - `src/agents/agent-events.ts` — a zero-dependency event vocabulary (`AGENT_EVENT_NAMES` /
    `AgentEvent` / `OnAgentEvent` / `isAgentEventName` / `makeEmitter`).
  - `readTextTail(p, maxBytes)` in `src/util/fs.ts` — byte-bounded tail read that drops a leading
    partial line.
  - `TaskStore.readRecentAgentEvents(taskId, limit, maxBytes = 64KiB)` — read tail → parse JSONL →
    filter by vocabulary → take the last `limit`.

## Key design decisions

| Decision | Rationale |
|---|---|
| Events are written into the **existing** `task.jsonl`, not an in-memory ring buffer | During long GUI tasks the host may restart, and an in-memory queue would lose exactly the scene you most need; a parallel stream would create a second source of truth with no shared ordering |
| Bounded memory is handled on the **read** side (64 KiB tail window) | The real growth risk is on read; `readTextTail` decouples memory use from total file size |
| The hook lives on `AgentRunOptions.onEvent`; **the agent profile is untouched** | The issue suggested "an optional onEvent hook in the agent profile", but `agent-profiles.json` is plain JSON and cannot hold a function — forcing one in would break schema parsing and hot reload. "Optional" is expressed by `opts.onEvent?.()` + `makeEmitter` |
| Adapters report through `makeEmitter` | A no-op when no hook is provided, and it swallows reporting exceptions — a failed report **never affects the task itself** |
| Only **codex + traework** actually report in this version | Satisfies the acceptance criterion "at least one built-in GUI agent"; other adapters keep the interface and need not change a single byte |
| `file_modification_started` keeps honest wording | Adapters do not observe the filesystem directly and can only infer from the UI running signal; the detail says "files may be modified" and **does not claim they were** |

## Compatibility

- **No tool contract, data model or MCP annotation changes.**
- `recentEvents` is a new optional field: adapters that do not report (including all CLI adapters)
  return an **empty array** with no event section in the text area, and **every other field is exactly
  as in v0.6.2**.
- A manual `rework_task` now writes a typed `rework_triggered` event instead of an anonymous `note`
  (an event-stream content change that affects no tool return structure); the existing semantics and
  purpose of `note` are unchanged.

## Tests

- 36 new cases across 4 files:
  - `test/unit/agent-events.test.ts` (15): `readTextTail` boundaries (dropping a partial line when the
    tail exceeds the budget, not dropping a whole line when the cut lands on a newline, null for a
    missing file); `readRecentAgentEvents` filtering / limit / chronological order / bad-line skipping
    / tail window evicting ancient events; `makeEmitter` no-op and exception swallowing; vocabulary
    completeness.
  - `test/unit/fix-loop-events.test.ts` (4): the orchestrator persists `opts.onEvent` verbatim into
    `task.jsonl` and syncs the snapshot; the state field reflects the status at report time; a
    non-reporting adapter behaves unchanged; a persistence failure is isolated and the task still
    succeeds.
  - `test/integration/codex-flow.test.ts` (5 new): existing project emits dispatch + start-execution
    once each without duplication; new project emits residual-dialog cleanup and native folder dialog
    once each; login indicator yields only `awaiting_user_authorization` with nothing dispatched; no
    `onEvent` provided works fine; a throwing hook doesn't change the result.
  - `test/integration/traework-events.test.ts` (5): dispatch + first running-signal transition once
    each; `ask_user` → `awaiting_user_authorization`; native-dialog binding →
    `confirmation_dialog_detected` (with `{dialog, bound}`); no `onEvent` provided works fine; a
    throwing hook doesn't change the result.
  - `test/integration/query-events.test.ts` (7): a non-reporting adapter yields empty `recentEvents`
    with all other fields unchanged; after reporting, both the meta block and the text area show them;
    `eventLimit` takes the most recent N; default is 10; `eventLimit: 51` is rejected at the protocol
    layer; manual rework is `mode:"manual"`; automatic rework is `mode:"auto"` (with round and failed
    check names).
- Full `npm test`: **1002 passed / 12 skipped** (93 files; v0.6.2 was 966 passed / 12 skipped, a net
  gain of 36).
- `check:stdio`: **8/8** for both dist and src (no new tools, scenario count unchanged).

## Real-machine record

**To be added (post-release)**: run one real GUI task each via `scripts/probe-codex.mjs` /
`scripts/probe-traework.mjs`, confirm the five event kinds appear as expected in `query_task` output
(especially `confirmation_dialog_detected` / `awaiting_user_authorization` when stuck on a native
dialog), and drop the output into `docs/` as an evidence file. This version gates on unit tests plus
fake-CDP integration tests.
