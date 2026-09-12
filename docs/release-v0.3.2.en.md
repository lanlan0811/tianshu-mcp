# tianshu-mcp v0.3.2 Release Notes

v0.3.2 fixes issues #5 / #6: **the MCP task model was disconnected from the state of the turn inside the Codex GUI**. The former is the completion-detection deadlock that kept reporting `running` while Codex waited for user confirmation; the latter is `cancel_task` only aborting the MCP-side wait loop, never stopping the in-GUI run, with a misleading description. Both share the same root cause and are resolved together; this release also includes a model-switching fix discovered during an end-to-end simulation on real hardware.

## Waiting-for-user detection (issue #5)

When Codex parks on a "waiting for user confirmation" screen (plan approval cards, subscription checkout, etc.), the turn is paused rather than finished, yet the stop button stays visible. The old completion logic treated "stop button visible" as an absolute running signal, so the task deadlocked in `running` until the 30-minute overall timeout.

- **Stall fallback**: while the stop button stays visible and the conversation hash is unchanged for `gui.stallTimeoutMs` (default 5 minutes), the task transitions to `needs_user` (new kind `user_confirmation`) with an actionable `pendingQuestion`; the stall timer resets as soon as content changes again.
- **Configurable UI detection**: `gui.selectors.userGate` (e.g. the embedded-checkout page or approval-card selectors) transitions to `needs_user` immediately when matched. Unset by default (disabled) — no unverified selectors are built in.
- **Selector tightening**: `stopButton` no longer over-matches `aria-label*="取消"` (the Cancel button on waiting-for-user screens used to be mistaken for a running signal).

## Recovery path (issue #5 fallout)

`continue_task` now supports codex (previously restricted to zcode, leaving codex `needs_user` tasks with no recovery):

- `user_confirmation`: after the user completes the action in the Codex window, resume by re-attaching as an observer of the in-GUI run (no message is sent); if the turn already finished before resuming, the task is still judged `succeeded` correctly.
- `login_required`: after login, re-checks the environment and re-dispatches the task brief (fresh session + project binding + full initial prompt).
- zcode recovery behaviour is unchanged; other agents are rejected explicitly.

## Cancel actually stops the GUI (issue #6)

- `cancel_task` no longer succeeds on request alone for GUI agents: it first best-effort clicks the in-app stop button over CDP, then waits (bounded by `gui.cancelWaitMs`, default 15s) for the GUI to become idle before settling `cancelled`; if the stop could not be confirmed, the terminal message states that the in-GUI run may still be going.
- Process-tree termination for CLI agents is unchanged; cancelling from `needs_user` notes that a pending session may remain in the GUI (no CDP connection exists at that point — documented limitation).
- **Re-dispatch anti-overlap guard**: when dispatching, if the managed instance still has an unstopped run, MCP first tries to stop it; if it cannot, the dispatch fails hard with `instance_busy`, preventing old and new turns from overlapping inside the same app.

## Fix discovered by real-hardware simulation

During an end-to-end simulation on Windows + Codex 26.903.9818.0 (`run_task`, agent=codex), the model menu's `menuitemradio` items ignored trusted mouse clicks — the menu merely closed without switching the selection, failing the "select model & reasoning level" step (the unreadable slider was a cascade of the closed menu). `clickModelItem` now clicks via in-page DOM `.click()`, verified on real hardware; the opposite behaviour of the project-picker trigger (which requires trusted clicks to open) is documented.

## Other

- `GuiProfile` gains two overridable options, `stallTimeoutMs` (default 300000) and `cancelWaitMs` (default 15000), both configurable via agent-profiles.json.
- Tool descriptions match actual semantics (`cancel_task` distinguishes CLI/GUI; `continue_task` is no longer ZCode-only); SKILL.md §4/§5 and usage-examples.md §7 document the recovery and cancel flows.
- The startup log reports the actual registry tool count instead of a hardcoded value.

## Upgrade & compatibility

- No breaking changes: no new state-machine states; `needsUserKind` gains the `user_confirmation` value.
- See the skill docs: `needs_user` handling (§4), cancel semantics (§5), recovery/cancel examples (usage-examples.md §7).

## Verification

- All 355 unit/integration tests pass; GitHub CI matrix (ubuntu/macos/windows × Node 20/22/24) and the strict stdio gate are green.
- End-to-end simulation on Windows 11 + Codex 26.903.9818.0: dispatching Codex to build a "plain-HTML fruit-slicing game" full flow, including recovery to `succeeded` via `rework_task` after a transient CDP disconnect.
