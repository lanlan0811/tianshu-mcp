# v0.1.9 Release Notes

- Version: `tianshu-mcp@0.1.9`
- Date: 2026-09-09
- Chinese version: [release-v0.1.9.md](release-v0.1.9.md)

## Highlights

This release fixes premature completion and instance termination while TraeWork is still thinking for a long time. Completion
detection now follows this order:

1. the literal thinking placeholder and native `ask_user` state;
2. the stop button `.chat-input-v2-send-button-stop-icon` or in-flight task tail `.core-task-tail--loading`;
3. the "由AI生成" completion mark when no authoritative running signal exists;
4. `idle` only after stable-round confirmation followed by an unchanged, no-running-signal period of `idleTimeoutMs`.

`.thinking-stream-content` is diagnostic only and never blocks completion because old messages may retain it. Every new selector
supports profile overrides; when none match, the probe fails open to completion-mark plus idle-timer behavior.

## Connection and instance safety

- CDP WebSocket `close` / `error` rejects every pending request immediately.
- Each CDP command has a 15-second default timeout; polling races cancellation and the task deadline, observing cancellation within about one second.
- Only `completion_mark` / `ask_user` release an instance launched by this module.
- `idle_no_completion`, `timeout`, `aborted`, and `cdp_lost` retain the instance. Task metadata exposes
  `agentEndReason` and `keptInstance` for `query_task` and diagnostics.
- Polling emits progress every 30 seconds by default. A long-lived running signal produces a warning but does not change behavior.
- When shutdown overlaps baseline capture, a transient `queued` state no longer implies user cancellation; only structured
  cancellation intent does.

## New configuration

| field | default | meaning |
|---|---:|---|
| `gui.idleTimeoutMs` | `600000` | unchanged, no-running-signal period after stable-round confirmation |
| `gui.cdpSendTimeoutMs` | `15000` | maximum wait for one CDP command response |
| `gui.progressIntervalMs` | `30000` | task progress-event interval |

## Verification

- Unit coverage for running-signal priority, idle timing, timer reset, non-blocking thinking stream, and the liveness truth table.
- CDP client coverage for command timeout, rejecting all pending calls on disconnect, and probe selector expressions.
- Fake-CDP integration coverage for completion/running conflicts, idle, timeout, CDP loss, and instance retention.
- Release gate: `typecheck && lint && test && build && pack:check`; 196/196 tests across 30 files passed.
- Machine verification: live DOM probe, long task, tiny timeout, and normal short task; recorded with this delivery and in `HANDOFF.md`.

## Install

```bash
npm install -g tianshu-mcp@0.1.9
```
