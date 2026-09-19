# tianshu-mcp v0.5.5 Release Notes

[中文](release-v0.5.5.md)

**Theme**: **a fourth GUI agent — Kimi Code support (`agentId=kimicode`)**. This is the delivery of the fourth "training" round: the MCP server can now drive the Kimi Code desktop app through the full loop of *locate install → launch → locate/create the task folder → pick model and reasoning tier → dispatch → liveness detection → objective acceptance → failure rework → re-verify*.

This is a **PATCH** release: it adds one agent integration surface and **leaves the three existing GUI agents (TraeWork / ZCode / Codex) and all existing tool signatures unchanged**. The only consumer-visible change is one **enum extension** — `run_task.reasoningLevel` gains `max` / `on` / `off` (the original `低/中/高/low/medium/high` values are all retained).

## Why Kimi Code needs its own driver

Kimi Code (Moonshot AI, measured version 1.0.2) is a **plain Electron install**, so it does **not** need Codex's MSIX `IApplicationActivationManager` COM activation path — injecting `--remote-debugging-port` is enough to take over CDP. But it differs from the existing three agents in four material ways, which shaped this implementation:

| Difference | Measured fact | How this release handles it |
|---|---|---|
| **Two renderer processes** | The model menu, reasoning tiers and execution-mode menu are rendered by the app into a **separate `Kimi Browser Overlay` renderer** via `browserOverlayOpenMenu()`: after clicking `model-pill` the main window's DOM node count does not change and **no menu node appears at all** | The CDP client holds both the main window and the overlay page; menu open/closed is judged solely by the overlay's `visibilityState` (the DOM may briefly linger after closing) |
| **Tasks are organised as "session folders"** | Sidebar → "Sessions" → folder group (e.g. `tianshu-mcp`) → session items; a workspace trigger `button.ws-chip` sits above the input box | Binding is judged solely by the **normalised absolute path** (workspace menu rows expose the full path via `span.ws-path`); names are only auxiliary. Same name but different directory always fails closed |
| **Reasoning tiers are not three levels** | Official models use `Low / High / Max`; non-official models (e.g. kiro's `stepfun/step-3.7-flash:free`) only have `On / Off` | **No built-in model list** — the requested value is validated against the **tier set the UI actually renders**. A tier the UI does not offer fails loudly before sending; it is never silently ignored |
| **Models have a second-level entry** | The quick menu only lists official models; non-official models require "More models…" → the main-window "Switch model" dialog | Three-stage selection: pill read-back → overlay quick menu → "More models…" dialog with search and exact-match row selection |

## What's new

### Install discovery

Order: explicit `gui.exePath` / `command` → **fixed-drive relative-path templates** (`preferredDrives`, D: first by default) → uninstall registry → standard install directories → `PATH`. The candidate file name must match `Kimi Code.exe` exactly (case-insensitive), and the file version is read once found. **No user absolute path appears in code** — `D:\Kimi-Code\Kimi Code\Kimi Code.exe` is only this machine's discovery sample.

### Instance lifecycle

- An existing managed instance with a working CDP port is reused.
- An existing instance **without CDP** (Electron's single-instance lock makes a new process hand off its arguments and exit) yields `needs_user(close_existing_instance)`. The adapter **never kills the user's process**, and **never starts a dedicated `user-data-dir`** (that would lose session folders and the login state).
- Port probing performs **product verification** (UA contains `kimi-code-app/`, page URL starts with `app://renderer/`) to avoid attaching to an unrelated Electron app.

### Model and reasoning tier

```jsonc
// Official model: tiers are Low / High / Max
{ "agentId": "kimicode", "model": "K3", "reasoningLevel": "High" }

// Non-official model (usable when official quota is exhausted): only on / off
{ "agentId": "kimicode", "model": "stepfun/step-3.7-flash:free", "reasoningLevel": "on" }
```

- `model` takes the **UI model name** verbatim (`K3`, `K2.8 Preview`, `stepfun/step-3.7-flash:free`, …) and is required.
- Tier validation is driven by the **UI tier set**: an official model receiving `medium` or a non-official model receiving `high` is rejected as a parameter error before sending.
- When `reasoningLevel` is omitted: official models keep the current UI value; non-official models are forced to `on`.
- The `mode` parameter is not supported (same as ZCode / Codex); `allowCreateProject` does not apply.

### Execution mode and dispatch

- "Fully automatic" is enforced and **read back** after switching (the three options are *always ask* / *ask when needed* / *fully automatic*); failure to confirm yields a hard `permission_unknown`.
- The task brief reuses the existing assembly (task + context + verified project references + rework feedback) and the existing task-marker mechanism.
- Send confirmation **requires** the session id and the marker landing in the conversation, optionally corroborated by "input cleared / running signal present / user-message copy button". If no evidence appears within a bounded 60-second window it reports `send_unknown` and keeps the scene, **never re-sending**.

### Liveness detection

- **Authoritative running signals**: `button.stop` (`aria-label="中断"`) and the `is-starting` class on `button.send`. Measured: they appear 0.5–1.2 s after sending and disappear on completion.
- Without a running signal, the reply must stay unchanged for `stableRounds` consecutive polls **before** idle timing even starts; long thinking is never judged complete early.
- Failure states (a "Continue" button plus a "model request failed, this turn was interrupted" message) are never treated as completion.

### User intervention and recovery

| `needsUserKind` | Trigger | `continue_task` behaviour |
|---|---|---|
| `close_existing_instance` | Process exists but no valid CDP port | Re-check environment, then **re-send the full task brief** |
| `login_required` | Stuck on login/onboarding | Re-check environment, then re-send the full task brief |
| `setup_recovery` | Workspace binding failed / native dialog unavailable / budget exhausted | Re-check and continue; **never sends the task to another workspace** |
| `agent_question` | A question appeared in the UI | Writes the answer **back into the original session** (does not re-send the brief) |
| `user_confirmation` | Waiting for user confirmation (`gui.selectors.userGate` or stall detection) | **Reconnect and observe only**; the user's confirmation text is never sent to the model |
| `system_permission` | Native dialog needs accessibility permission | Re-check and continue |

If the original session cannot be located, it always fails closed as `session_lost` and **never degrades into "open the most recent session"**.

### Cancellation and timeouts

- `cancel_task` follows the Codex M14 semantics: it best-effort clicks `button.stop` and waits in a bounded window (`gui.cancelWaitMs`, 15 s by default) for the UI to go idle. When the stop **cannot be confirmed**, the terminal message says so honestly — "the task in the Kimi Code window may still be running".
- Before dispatching, if the managed instance still shows a running signal the adapter tries to stop it first; if it still is not idle it fails hard with `instance_busy`, preventing overlapping turns.
- `task_timeout` / `idle_timeout` / `cdp_timeout` / `cdp_disconnected` all keep the instance and record `agentEndReason` + `keptInstance`; nothing is closed and no "process tree terminated" is faked.

### Native "Add workspace" dialog

Unregistered workspaces are imported through the native dialog: `#32770` with title "添加工作区", edit box `AutomationId=1152` + `ClassName=Edit`, confirm button `AutomationId=1`. Key points:

- The path is written in **native form** (`D:\a\b`: upper-case drive letter, backslashes) via `WM_SETTEXT` and read back with `WM_GETTEXT`; if the read-back differs, **confirm is never clicked**.
- The path reaches the PowerShell script **only through an environment variable** — it is never interpolated into the script source (avoiding escaping problems and CJK code-page corruption).
- Only **newly appeared** windows passing the triple check (title / class / owning process) are touched; the confirm and cancel buttons **do not support UIA `InvokePattern`** and must be clicked with Win32 coordinates.
- At startup, leftover `#32770` windows owned by our process are closed (a modal dialog swallows main-window clicks).

### Diagnostic probe

```sh
npm run build
node scripts/probe-kimicode.mjs all        # read-only: install / process / cdp / workspaces / session / models / liveness / dialogs
node scripts/probe-kimicode.mjs install    # run a single one
```

Read-only by default; only an explicit `--launch` starts an instance (and prints a prominent notice). The probe has no send capability. When a UI upgrade drifts the selectors, locate the drift with it first, then hot-fix via `gui.selectors`.

## Real-machine validation (Windows 10 x64 + Kimi Code 1.0.2)

| Scenario | Result |
|---|---|
| Self-launch (no existing process) | Pass: `spawn` + port 9666, product verification hit, main window and composer ready |
| Reuse managed instance | Pass |
| Bind a registered workspace | Pass: matched by absolute path and read back via `ws-chip` |
| **Import an unregistered workspace** | Pass: all native stages (`initialize` → `find-new-dialog` → `title-ok` → `find-folder-edit` → `input-path` → `find-confirm-button` → `submit-once` → `done`), then binding read-back succeeded |
| Model and tier (non-official) | Pass: quick menu missed → automatically fell through to the "More models…" dialog, searched and selected → read-back matched; tier `On` read back |
| Model and tier (official) | Pass: `K3`'s `Low/High/Max` tiers were switched and read back on real machine (`K3 · Max` → `K3 · High`) |
| Execution mode | Pass: read back "fully automatic" |
| **Automatic acceptance** | Pass: `2/2` command checks passed (including `git-diff-check`) |
| **Failure → rework → re-verify** | Pass: round 0 failed → repair plan generated (failed item, command, exit code) → rework sent **in the same session** (identical session id) after reading back model/tier/mode → round 1 passed → `succeeded` |
| No workspace pollution | Pass: artifacts landed in a gitignored directory; `git status` showed no extra changes |

**Not covered on real hardware (stated honestly)**: cancellation (`cancel_task` clicking stop in the GUI), question answering (`agent_question`) and same-name workspace ambiguity are covered **only by hermetic integration tests**; macOS remains `research` and fails closed (executable discovery and native dialog driving have not been measured on macOS). Also, the end-to-end validation used a **non-official free model** (official-model quota ran out during validation); official-model tier switching was verified separately during reconnaissance.

## Real-machine defects found and fixed during implementation

| # | Symptom | Root cause → fix |
|---|---|---|
| 1 | The workspace dropdown would not open (click swallowed) | The client only **detected** `pageHidden` and never brought the window forward; Kimi Code usually launches in the background, Chromium throttles the page and swallows synthesised mouse events. → After connecting, actively `Page.bringToFront` + enable focus emulation and **wait for `visibilityState` to settle** (measured: it takes effect asynchronously over hundreds of ms); before each click, recover first if the page is hidden |
| 2 | A swallowed "new session" click failed closed immediately | It only clicked the global entry once and the group entry once. → Changed to a **bounded periodic retry** gated on "`ws-chip` is mounted", alternating the two entries (the same idea as `openWorkspacePanel`) |
| 3 | **"New session" always failed while sitting on a session page** (intermittent, easily misread as UI drift) | `newSession` had a broad fallback `aside.side button`: on a draft page the sidebar has few buttons (lucky 1 match) so it worked, but on a session page there are more (measured **26 matches**) → `click()`'s coordinate click requires a unique match, so it degraded to a DOM click, and that button only honours trusted clicks — both paths failed. → Narrowed the fallbacks to ones anchored on `btn-new-chat`; added `clickFirst` for keys where "any one is fine" (per-workspace new-session entries are inherently multiple); added a `kimicode-selectors` regression test that pins "narrow fallbacks" as an assertion |
| 4 | A failed draft left only "selector not mounted", impossible to localise | → Failure diagnostics now include the current page URL and whether the window is in the foreground |

## Upgrade guide

1. **No configuration changes required.** TraeWork / ZCode / Codex behave exactly as before.
2. To use Kimi Code: make sure it is installed and logged in, then pass `agentId="kimicode"` + `model` to `run_task`. For the first dispatch, **closing any manually opened Kimi Code window first is recommended** (otherwise you get `needs_user(close_existing_instance)` — this is deliberate: the adapter neither kills your process nor starts a separate profile that would lose the login state).
3. If the target directory is not registered as a workspace, it is imported through the native "Add workspace" dialog (the window must be able to be brought to the foreground).
4. If you exhaustively validate `reasoningLevel`, add the three new values `max` / `on` / `off`.
5. When official-model quota is exhausted, a non-official model works (e.g. `stepfun/step-3.7-flash:free`) — note its tiers are only `on` / `off`.

## Tests and verification

- Full suite **768 passed / 12 skipped** (74 test files; Windows 10 x64, Node 24.18.0) — roughly 120 net new cases versus v0.5.4.
- New tests: install discovery, model and tiers, workspace matching, liveness, selector-spec regression (unit); instance takeover and binding, three-stage model selection, send confirmation, needs_user/continue_task recovery, cancellation and dispatch guard, failure-rework loop (integration).
- Gates: `typecheck` / `lint` (`--max-warnings 0`) / `build` / `check:stdio` (6/6 scenarios) / `pack:check` all pass; no unexpected tracked-file changes after build.
- Known flakiness (unrelated to this release; see `HANDOFF.md` §7): `acceptance` / `baseline-predirty` / `visual-content-command` / `profile-hotreload` / `visual-baselines` / `acceptance-parallel` may occasionally fail under a **fully loaded parallel** run and all pass when run individually.
