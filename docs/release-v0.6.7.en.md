# v0.6.7 — Terminal-state webhook notifications

> Related issue: [#22](https://github.com/lanlan0811/tianshu-mcp/issues/22). See
> [task notifications](notifications.en.md).

## Background

For long tasks the caller previously had to keep polling `query_task` from the Tianshu UI. Nothing was
pushed when a task completed, failed or entered `needs_attention`, making babysitting expensive.

## Added

- **`notifications.webhook` (global `config.json`)**:

  ```jsonc
  { "notifications": { "webhook": {
      "enabled": true, "url": "https://example.com/hook",
      "timeoutMs": 5000, "maxRetries": 2, "backoffMs": 500,
      "secret": "your-signing-key",
      "events": ["done", "failed", "needs_human"] } } }
  ```

- **An asynchronous POST on terminal transitions**: the body carries `taskId` / `event` / `status` / `ts` /
  `finishedAt` / `agentId` / `projectPath` / `round` / `reportRound` / `message` / `reportMd` /
  `reportJson`; headers include `X-Tianshu-Event` and, when `secret` is set,
  `X-Tianshu-Signature: sha256=<hex>`.
- **`src/tasks/notifier.ts`**: `TaskNotifier` and `statusToEvent()`.

## Event classes and the default subscription

| Event | Task status | Subscribed by default |
|---|---|---|
| `done` | `succeeded` | ✅ |
| `failed` | `failed` | ✅ |
| `needs_human` | `needs_attention` (terminal) | ✅ |
| `needs_user` | `needs_user` (**non-terminal**, restorable via continue, possibly re-entered) | ❌ opt in |
| `cancelled` | `cancelled` / `interrupted` | ❌ opt in |

`needs_user` and `needs_attention` are deliberately separate: the former is non-terminal and can fire
repeatedly within one long task, so enabling it by default would be noise.

## Key design decisions

| Decision | Rationale |
|---|---|
| The hook point is `TaskStore.updateStatus()` | The **single choke point** for state transitions. `TaskOrchestrator.finish()` only covers orchestrator-driven ends — `cancel()`'s queued branch, `initialize()`'s restart archiving, and `shutdownInterrupt()` / `persistInterrupted()` all bypass it |
| Config lives in the global `config.json` | Notification routing is a host/transport concern, not project acceptance policy; and `updateStatus` only has the data home, taskId and logger, so it cannot cheaply read project config on every transition |
| Dedup key `taskId + status + finishedAt` | `prev !== status` **cannot** be used: several paths **write `meta.status` directly first** and only then call `updateStatus`, at which point `prev` already equals the target state. `finishedAt` is refreshed by `updateStatus` on a terminal write and cleared by `rework`/`continueTask` — so repeated writes for one episode are suppressed while a new episode after rework notifies again |
| Sending happens after `appendEvent` + `writeSnapshot` | Persist the local fact first, then notify outward |
| `notify()` is fire-and-forget, returning void | Sending and retries run entirely in the background; a slow or dead endpoint **does not block the status-write chain** |
| Global `fetch` + `AbortSignal.timeout` + `redirect:"manual"` | The same convention as `src/visual/services.ts`, built into Node ≥ 20, no new dependency |
| The notifier is an **optional** third `TaskStore` argument | Many tests construct `new TaskStore(home, logger)` directly, so backward compatibility is required |

## Compatibility

- **Off by default**: unset or `enabled:false` sends **no requests at all**, behaving exactly as v0.6.6.
- **No tool contract, data model or MCP annotation changes**; only a new **optional** config section.

## Disclosed honestly

- **Best-effort, not guaranteed**: a failed send (network error / timeout / non-2xx) is retried
  `maxRetries` times and then only logged as one `warn` — it **never changes a task's terminal state and
  never blocks a call**.
- **The boundary of "exactly once"**: the MCP dedupes on the key above **in-process**; delivery can still
  repeat across a server restart or a receiver retry, so receivers should be idempotent.
- **The body contains local paths**: it includes `projectPath` and absolute paths to acceptance report
  files; confirm the receiver is trusted before forwarding to a public service.
- **`enabled=true` without `url` is rejected by the schema** (no silent "enabled but never sends"
  confusion); `config.json` follows last-known-good, so a broken file only warns and keeps the previous
  valid config.
- **Feishu/DingTalk need their own adaptation**: their custom bots expect their own message envelopes,
  which differ from this MCP's body; the docs give two approaches ("self-hosted forwarding service" and
  "gateway rewriting") plus sample signature-verification code.

## Tests

- 29 new cases across 2 files plus test infrastructure:
  - `test/unit/notifier.test.ts` (20): `statusToEvent`'s six-status mapping and the absence of events for
    intermediate states; config defaults (only true terminal states subscribed, `needs_user` excluded) and
    "enabled without url is rejected"; the four zero-request cases (unconfigured / `enabled:false` / event
    not subscribed / `needs_user` not explicitly subscribed); the body and event header on a successful
    send; HMAC signing when `secret` is set (recomputable with the same secret) and no signature header
    otherwise; exactly-once behaviour (repeated `notify` with the same key sends once, a changed
    `finishedAt` sends again, different statuses for one task each send once); failure isolation
    (permanent 500 retries up to the cap and stops, fail-then-succeed delivers on the retry, an
    unreachable port only warns, a config-read error only warns).
  - `test/integration/webhook-notify.test.ts` (9): through the real MCP layer — a successful task sends
    exactly one POST (`done` with a correct body), a failing task sends `failed`, and a `needs_attention`
    task (via the dry-run violation path) sends `needs_human`; three zero-request cases (unconfigured /
    `enabled:false` / subscribed only to `failed`); with a permanent 500 the **task still succeeds to its
    terminal state** with exactly `1 + maxRetries` attempts; an unreachable port still reaches the terminal
    state; a broken webhook section falls back to last-known-good with the task unaffected.
  - `test/test-utils.ts` gained `startMockWebhook()` (real `node:http`, recording body / headers /
    **the status it returned**), `closedPortUrl()` (a guaranteed-unreachable local port) and
    `waitForCondition()`.
- Full `npm test`: **1139 passed / 12 skipped** (103 files; v0.6.6 was 1110 passed / 12 skipped, a net gain
  of 29).
- The new cases follow the v0.6.5 CI lesson: **no dependency on any locally installed GUI agent**, and no
  external network (the mock listens on a random 127.0.0.1 port only).

## Real-machine record

This issue's acceptance criteria are "a `notificationWebhook` config option, off by default", "POST on
state transitions with tests", "a failed send does not affect the state machine, only logs", and "docs
describing the body format and receiver guidance" — all four are covered by the unit / integration tests
and the docs above, with **no real-machine GUI dependency** (notification triggering depends only on state
transitions, which the stub agent drives end-to-end), so this version needs no real-machine record.
