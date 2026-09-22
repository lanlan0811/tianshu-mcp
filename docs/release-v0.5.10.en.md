# tianshu-mcp v0.5.10 Release Notes

[中文](release-v0.5.10.md)

**New: idempotency keys (`idempotencyKey`) for `run_task` / `verify_task` — a host retry no longer turns into a duplicate dispatch or a duplicate verification run** ([issue #15](https://github.com/lanlan0811/tianshu-mcp/issues/15)).

## The problem

Neither `run_task` nor `verify_task` had an idempotency key, and retries happen exactly where idempotency matters most (long tasks, network jitter, a host `tools/call` timeout):

- `run_task` created a brand-new task via `genTaskId()` on every call: a host retry queued **two agent rounds** for the same project — duplicated work, duplicated external-agent quota, with the second round editing on top of the first round's output and blurring verification attribution;
- `verify_task`'s standalone path created a `vfy_<Date.now()>` record: a retry re-ran the whole verification suite, re-executing the side effects of `build` / `e2e` / deploy checks and producing extra `vfy_*` records;
- only three of the four standard MCP annotations were implemented (`readOnlyHint` / `destructiveHint` / `openWorldHint`); `idempotentHint` was missing everywhere;
- the only defence was a behavioural rule in the skill document ("do not re-dispatch the same project") — there was no protocol-level protection, and retrying is exactly what a host does when it is unsure.

## What's new

### Idempotency semantics

Both tools accept an optional `idempotencyKey` (1..128 characters after trimming, no control characters) with **independent namespaces**; the argument digest (`digest`) participates in the decision and **same key + different arguments fails closed**:

| Tool | Case | Behaviour |
|---|---|---|
| `run_task` | Same key, same arguments, within TTL (24h default) | **Always returns the original `taskId` and its current meta**, creating nothing (terminal tasks included: read-only, never re-dispatched; the response points at `rework_task` or a new key) |
| `run_task` | Same key, different arguments | `Error`: `idempotencyKey '<key>' 已被任务 <taskId> 占用，但本次参数与首次提交不同` |
| `run_task` | No key | Behaviour is byte-for-byte unchanged; if the same workspace already has an unfinished task, the response names it in `projectActiveTask` (a hint, not a block) |
| `verify_task` | Same key, verification **still running** | Returns a **successful** result with `idempotencyReplay: "in_progress"` (deliberately not `isError`, so a host does not treat it as a failure and retry harder) |
| `verify_task` | Same key, verification **already finished** | Returns the existing report paths plus that round's `reportRound` / verdict, **re-running nothing** |
| `verify_task` | Same key, different arguments | The same fail-closed error as `run_task` |

### Persisted mapping and configuration

- New data file `<data-dir>/idempotency.json`: `{ version, entries: [{ scope, key, digest, taskId, kind, createdAt, reportRound?, verdict?, reportMd?, reportJson? }] }` — **atomic writes, lazy loading, TTL and capacity pruning**; retries are still recognised after a process restart (cross-restart replay is covered by a test).
- New `config.json` keys: `idempotency.ttlMs` (default `86400000` = 24h) and `idempotency.maxEntries` (default `2000`; when exceeded, the oldest entries by `createdAt` are evicted).
- Key **plaintext never enters logs or the event stream**: logs and events use `keyDigest` (first 8 hex chars of sha256); the raw key lives only in local task snapshots and the mapping file, for auditing.

### Observability and annotations

- `TaskMeta` gains `idempotencyKey` / `idempotencyScope` / `idempotencyDigest` (persisted in `task.json`; used to rebuild the mapping when the file is corrupt).
- The meta block gains `idempotencyKey`, `idempotencyReplay` (`hit` / `in_progress`) and `projectActiveTask`.
- On a hit, a `note` event is appended to the original task's stream (`幂等重放：keyDigest=…（未新建任务 / 未重跑验收）`).
- `tools/list` reports `annotations.idempotentHint: true` for `run_task` / `verify_task` (all other tools keep the MCP default). **Idempotency is claimed only when the caller supplies `idempotencyKey`** — stated in the tool descriptions, the README and the skill document.

### Crash window and write failures

- **The mapping is written first, the task second** (inside one critical section; same-key concurrency is serialised by `runExclusive`): if the process dies between the two, a retry sees a mapping with no task snapshot, treats it as **not yet effective and re-dispatches** — two agent queues are never left behind.
- A **failed mapping write fails open**: the already-dispatched task is still returned, while the response and meta state "the idempotency record could not be written, this task cannot be replayed by the same key" — a running agent is never reported as a failed dispatch.
- A **corrupt** mapping file is logged and rebuilt once from task snapshots; standalone verification records (`vfy_*`) carry their idempotency key in the snapshot too, so they are rebuilt as well.

## Explicit boundaries

- **`verify_task(taskId=…)` does not write its idempotency key into the task snapshot**: that snapshot field carries the task's own **dispatch key**, so it is not overwritten; consequently, if the mapping file is corrupt, this one combination relies on `idempotency.json` alone (it is the only combination not covered by the rebuild).
- **"In progress" is process-local**: an unfinished verification is not cached across a server restart (there is no report to return, so a retry simply re-runs — reported honestly); this also prevents a mapping stuck at `in_progress` while the engine is long dead.
- No idempotency keys for `rework_task` / `continue_task` / `cancel_task` / the visual baseline tools — repeating those on a terminal task is an explicit human action.
- No cross-process / multi-server distributed idempotency (the same assumption the existing visual lock makes); no new task status, no `TRANSITIONS` change, still 11 tools.

## Compatibility

**PATCH release**: `idempotencyKey` is optional and **omitting it changes nothing** (dispatch, verification, state machine and event names are all unchanged); every new config key and `TaskMeta` field is optional and old `task.json` files keep working. The standalone verification record id changes from `vfy_<timestamp>` to `vfy_<timestamp>_<6 random chars>` (`genVerifyId()`), so same-millisecond collisions are no longer possible.

## Gates and evidence

- 16 new unit cases (`test/unit/idempotency.test.ts`): key validation, `canonicalDigest` stable serialisation, TTL expiry, capacity eviction, cross-instance recovery, corrupt-file rebuild, `runExclusive` serialisation and failure isolation, in-flight markers, and fail-open on write failure (without relying on platform permission bits).
- 8 new integration cases (`test/integration/idempotency.test.ts`): same-key replay creating a single `tsk_*` directory, same-key/different-arguments fail-closed, faithful replay of terminal tasks, zero regression without a key, the `projectActiveTask` hint, finished standalone replay adding no report, in-progress replay returning a success result, `taskId`-mode replay, and **cross-restart** (close → rebuild the server on the same data dir → both dispatch and verification replay by key).
- Protocol cases gained `idempotentHint` assertions; config cases gained `idempotency.ttlMs` / `maxEntries` default and override coverage.
- Type check, lint (`--max-warnings 0`), the full test suite, the build, the strict stdio check (6/6 scenarios) and `pack:check` all pass.

Related docs: [README](../README.en.md) | [CHANGELOG](../CHANGELOG.en.md) | [ARCHITECTURE](../ARCHITECTURE.en.md) | [HANDOFF](../HANDOFF.md)
