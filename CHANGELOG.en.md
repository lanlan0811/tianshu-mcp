# Changelog

All notable changes to `tianshu-mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Chinese version: [CHANGELOG.md](CHANGELOG.md)

---

## [Unreleased]

### Planned

- More external AI-Agent adapters (a new agent = one profile + an optional adapter file).
- TraeWork executable discovery and native-dialog driving on macOS (currently fail-closed).
- Optional project-level skill seeding (by default nothing is written into target repos).
- macOS hardware verification for the Codex GUI adapter (built-in status remains `research`).
- Best-effort stop of a GUI-side pending session (via a temporary CDP connection) when cancelling
  a task in the `needs_user` state.

---

## [0.3.3] — 2026-09-12

Fixes issues #4 / #7 by adapting the ZCode GUI driver to the 3.11.2 model-menu and project-binding semantics, while making acceptance fail closed for zero-test and zero-change outcomes.

### Fixed

- ZCode provider selectors now support both `group-provider` and the 3.11.2 `group-family` prefix. Model selection tries the visible model first and only expands a provider/family group as a fallback; failures include visible text and `data-testid` candidates.
- New-project import dismisses the stale workspace menu before opening Add Project and uses a bounded three-round dismiss/click/verify loop, preventing the first click from being consumed as an outside click.
- Project binding prioritizes the composer menu's `menuitemcheckbox`; the legacy sidebar item remains a compatibility fallback. Display-name matching normalizes NFKC, whitespace, and case.
- Binding read-back combines the composer trigger text with the full-path fast path, rejects known unbound placeholders, and retries the idempotent bind operation for up to two rounds.
- Built-in ZCode and TraeWork discovery paths use `{PROGRAMFILES}` / `{PROGRAMFILES(X86)}`. Environment placeholders in custom profiles are expanded case-insensitively while unknown placeholders remain unchanged.
- A mandatory test check is failed when it exits with code 0 but its output reports zero executed tests.
- Git projects now require a change relative to the pre-work baseline by default. Pure question/analysis tasks can explicitly opt out with `"requireChanges": false` in `.tianshu-mcp/acceptance.json`.

### Tests

- Regression coverage now models ZCode 3.11.2 flat family layouts, legacy provider fallback, testid diagnostics, swallowed project clicks, composer binding and read-back retries, plus zero-test/zero-change acceptance gates.

---

## [0.3.2] — 2026-09-12

Fixes for issues #5 / #6: **the MCP task model was disconnected from the state of the turn inside
the Codex GUI**. The former is the completion-detection deadlock that kept reporting `running`
while Codex waited for user confirmation; the latter is `cancel_task` only aborting the MCP-side
wait loop, never stopping the in-GUI run, with a misleading description. Both share the same root
cause and are resolved together.

### Fixed

- **Waiting-for-user detection (issue #5)**:
  - `judgeCodexPoll` gains a stall fallback: while the stop button stays visible and the
    conversation hash is unchanged for `gui.stallTimeoutMs` (default 5 minutes), the task
    transitions to `needs_user` (`needsUserKind=user_confirmation`) instead of deadlocking in
    `running` until the overall timeout; the stall timer resets as soon as content changes again.
  - New configurable UI detection `gui.selectors.userGate` (e.g. the embedded-checkout page or
    approval cards): when configured and matched, transitions to `needs_user` immediately.
    Unset by default (disabled) — no unverified selectors are built in.
  - Tightened the `stopButton` selector: removed the `aria-label*="取消"` over-match (the Cancel
    button on waiting-for-user screens used to be mistaken for a running signal).
- **Recovery path (issue #5 fallout)**: `continue_task` now supports codex —
  - `user_confirmation`: after the user completes the action in the Codex window, resume by
    re-attaching as an observer of the in-GUI run (no message is sent); if the turn already
    finished before resuming, the task is still judged `succeeded` correctly;
  - `login_required`: after login, re-checks the environment and re-dispatches the task brief
    (fresh session + project binding + full initial prompt);
  - zcode recovery behaviour is unchanged; other agents are rejected explicitly.
- **Cancel actually stops the GUI (issue #6)**:
  - `cancel_task` no longer succeeds on request alone for GUI agents: it first best-effort clicks
    the in-app stop button over CDP, then waits (bounded by `gui.cancelWaitMs`, default 15s) for
    the GUI to become idle before settling `cancelled`; if the stop could not be confirmed the
    terminal message states "GUI 内运行未确认停止…" (the in-GUI run may still be going);
  - process-tree termination for CLI agents is unchanged;
  - cancelling from `needs_user` now notes that a pending session may remain in the GUI
    (no CDP connection exists at that point — documented limitation).
- **Re-dispatch anti-overlap guard (issue #6 chain risk)**: when dispatching, if the managed
  instance still has an unstopped run, MCP first tries to stop it; if it cannot, the dispatch
  fails hard with `instance_busy`, preventing old and new turns from overlapping inside the same
  app (observed in the wild when re-dispatching right after a cancel).
- The startup log no longer hardcodes the tool count as `8`; it reports the actual registry size
  (`TOOL_DEFS.length`, currently 9).

### Changed

- Tool descriptions match actual semantics: `cancel_task` distinguishes CLI (kill process tree)
  from GUI (best-effort stop click + bounded wait); `continue_task` no longer claims to be
  ZCode-only.
- `GuiProfile` gains two configurable options, `stallTimeoutMs` (default 300000) and
  `cancelWaitMs` (default 15000), both overridable via agent-profiles.json.
- Skill docs (SKILL.md §4/§5, usage-examples.md §7) document the codex `user_confirmation` /
  `login_required` recovery flows, GUI cancel semantics and the new options.

---

## [0.3.1] — 2026-09-12

Post-v0.3.0 housekeeping for docs and release automation: **no source-level behavior changes**.
The focus is a full rewrite of the self-installed skill docs plus GitHub/Gitee release-body
composition and link fixes.

### Changed

- **Skill docs (`skills/tianshu-mcp/`) fully rewritten to match the actual v0.3.0 tool surface**:
  - Corrected the `codex` description from "headless CLI" to the ChatGPT desktop GUI adapter
    (MSIX + COM activation + CDP); documents the required `model`, optional `reasoningLevel` /
    `planDoc` / `designSystem`, and that `mode` is not supported;
  - Documented the `run_task` `context` parameter and the send-time validation of path references
    inside task/context; corrected the `autoFixRounds` default precedence
    (call argument > codex 5 / zcode 2 > server default 0);
  - Added usage for `list_tasks`, `query_task(tailLines)`, `get_task_report(round)` and
    `verify_task` (`extraChecks` / `checksMode` / `baselineRef`) plus the four-level acceptance
    command precedence;
  - Documented the four `needs_user` kinds and meta fields such as `needsUserKind` /
    `pendingQuestion` / `errorType` / `reportRound` / `verificationSource`;
  - Added `continue_task` to the approval list; replaced emoji status markers with plain text
    (PASS / warning) in the usage examples.
- **Release automation fixes (exposed by the v0.3.0 tag)**:
  - The release body is now composed bilingually from `docs/release-v<version>.md` and `.en.md`,
    with in-document relative links rewritten to tag-absolute links; a missing doc fails the
    workflow loudly instead of producing a shell-only body;
  - `Full Changelog` resolves the previous tag via `git describe` into a `compare/<prev>...<tag>`
    link instead of degrading to a commits link;
  - The body's `CI` link resolves the CI run for the same SHA instead of pointing at the Release run;
  - Gitee releases are automated in `release.yml`: `scripts/gitee-release.mjs` idempotently
    creates/updates the mirrored release (requires the `GITEE_TOKEN` secret; skipped loudly when unset).
- `.gitignore` now ignores npm pack artifacts and local temporary verification directories.
- Added the missing `[0.1.10]` / `[0.2.0]` / `[0.3.0]` / `[0.3.1]` compare links at the bottom of
  this file and its Chinese counterpart.

---

## [0.3.0] — 2026-09-12

The Codex desktop app now runs through a **GUI driver**: a new `codex-gui` adapter uses MSIX COM activation
plus CDP to drive the ChatGPT desktop app through the full loop (locate install → launch GUI → bind/create
project → pick model and reasoning level → send instructions → run detection → verify → auto-repair).

### BREAKING CHANGES

- **`agentId=codex` now executes via the desktop GUI instead of the headless CLI**: a new `driver=gui` +
  `adapter=codex-gui` + `activation=msix-com`, with the previous **`codex exec` headless path removed**.
  After upgrading, `run_task(agentId="codex")` launches and drives the Codex desktop window rather than a
  headless child process. To keep headless execution, add a separate `driver=spawn` profile
  (`argsTemplate: ["exec", "<prompt:arg>", "--skip-git-repo-check", "--sandbox", "workspace-write"]`) as
  documented in `docs/agent-profiles.en.md`.
- This path requires the Codex desktop app (MSIX store package) to be installed; CLI-only environments are
  no longer directly supported.

### Added

- `codex-gui` adapter (`src/agents/codex/**`): Appx-first install discovery (scan fallback taking the newest
  version), MSIX COM activation with a dedicated `user-data-dir` and dynamic debug port, plus CDP attach and
  target convergence (excluding the overlay secondary window).
- Task parameters: `reasoningLevel` (low/medium/high, bilingual), `planDoc`, `designSystem`.
- Model and reasoning level: models are `menuitemradio` candidates while **reasoning strength is a slider**
  (0–4: 轻度/中/高/极高/极高), set precisely with arrow keys and read back for verification; level
  comparison is exact to avoid matching "高" against "极高".
- **Automatic project registration**: a target directory not yet registered on the Codex side is written
  directly into Codex project state (idempotent, backup-before-write, atomic write, only while the
  MCP-managed instance is stopped), so it takes the stable bound-project path instead of the brittle native
  folder dialog; on failure it falls back to UI creation.
- Verification and repair: reuses the existing AcceptanceEngine (defaults derived from `package.json`, with
  weak-verification labelling); on failure the MCP generates an in-project
  `.zcode/plans/codex-fix-r<N>.md` (one per round, never overwritten) and cites it in the repair instruction,
  up to 5 rounds by default (`defaultAutoFixRounds`).
- Run detection: the stop button is the authoritative running signal, and text stability counts as completion
  evidence only after it; without a running signal it fails open to `idle_timeout` while keeping the instance
  (never a false completion).
- `scripts/probe-codex.mjs` hardware diagnostic script; 67 Codex unit tests plus integration coverage of the
  verify-fail → generated plan → repair-pass loop.
- Docs: `docs/codex-gui-cdp.en.md`, `docs/codex-windows-smoke.en.md` (including the round-2 real business task
  acceptance) and their Chinese counterparts.

### Changed

- `GuiProfile` gains `activation` / `userDataDir` / `appxPackageName` / `permissionMode` / `fixPlanDir`;
  existing `spawn` profiles are unaffected.
- `ExecutableDiscovery` gains `appxPackageName` / `installRelativeExe` / `scanRoots` / `scanPattern`.

### Fixed (exposed by hardware testing)

- The model trigger mis-matched the sibling permission chip (4 chips share `aria-haspopup`; only the model chip
  lacks `aria-label`).
- Reasoning strength was clicked like a menu item and could never be set (it is actually a slider).
- Menus/popovers only open on **trusted** mouse events (DOM `.click()` is ignored).
- A transient empty model read during toolbar re-render after binding was treated as a "model mismatch".
- Model/reasoning trigger selectors now exclude the top menu bar and the mode switcher.
- Cold-start readiness budget widened to 150s (registration stops the instance first; cold start measured ~85s).
- CI: fixed a `normalizeDir` assertion that depended on the host platform, which failed on ubuntu/macos.
- Fixed integration tests polluting real Codex project state by not injecting `ensureRegistered`.

### Verification

- Windows 10 x64 hardware: full loop for a registered project, and the verify-fail → generated plan →
  repair-pass loop; an unregistered project completed the full loop after automatic registration.
- Real business task: drove Codex to build a "Fruit Ninja" mini-game in HTML+CSS+JS (`GPT-5.6 Sol` with
  reasoning strength "高"); the artifacts passed acceptance and were verified playable in a headless browser
  (score rises, lives decrement, Game Over and restart work, no JS exceptions).
- macOS unverified: the built-in Codex GUI status is `research` and is excluded from readiness.

---

## [0.2.0] — 2026-09-11

### Added

- Dedicated `zcode-gui` Electron CDP adapter with data-driven Windows/macOS discovery, dynamic ports, product/process checks, and a global serial lock.
- Exact ZCode project binding, guarded native folder pickers, `provider/model`, Full Access read-back, and idempotent sending.
- Paused `needs_user` state and approval-gated `continue_task` for original-session answers and environment rechecks after instance, login, or permission handling.
- Multi-signal liveness, progress events, UI preservation, default auto-verification, and two same-session repair rounds. Repair plans stay in MCP task storage.
- `scripts/probe-zcode.mjs`, fake-CDP/state/path/model tests, and bilingual documentation.

### Safety and compatibility

- GUI profiles support an explicit `adapter`; legacy `driver="gui"` profiles retain TraeWork behavior.
- The built-in ZCode profile remains `research` until both real platform loops pass.
- No private `app-server`, credential access, automatic user-instance termination, or fixed screen coordinates.

### Fixed and verified

- Fixed ZCode read-back for dynamic model labels, transient renderer load/reload, delayed new-session registration, and stale session-ID contamination.
- `AskUserQuestion` continuation now selects and submits an exact accessible option in the original session; zero or ambiguous matches fail closed.
- Windows 10 x64 passed three hardware loops: real file development, same-session repair after a controlled failure, and `continue_task` after a model question. macOS hardware evidence remains pending.

---

## [0.1.10] — 2026-09-10

### Fixed

- **Fixed stdio log pollution (issue #1)**: the unified logger previously sent only ERROR to
  `console.error` while INFO/WARN/DEBUG went to `console.log`, sharing stdout with MCP JSON-RPC
  messages and breaking handshakes or tool calls in strict stdio clients. All levels passing the
  threshold now go to stderr, leaving stdout for valid MCP messages only.
- Log file appending, timestamps, level tags and the `<data dir>/logs/server.log` path are unchanged;
  a startup failure is still reported on stderr.

### Added

- New `scripts/check-stdio.mjs` strict stdio smoke: a real child process validates the complete
  stdout/stderr byte stream, allowing only newline-delimited, schema-valid MCP JSON-RPC messages on
  stdout; empty lines, non-JSON lines, parser errors, or trailing fragments at exit fail the run.
  It covers six scenarios: first start, second start with matching skills, `--no-skill-install`,
  a corrupt `config.json`, logs during a stub task, and clean EOF shutdown.
- New `npm run check:stdio` and `npm run check:stdio:src` scripts.

### Tests

- New `test/unit/log.test.ts`: real-child-process checks for the four log levels' channels, default
  INFO filtering, threshold-filtered file logging, and UTF-8 content (4/6 failed before the fix; see
  `docs/m2-evidence/issue1-old-impl-log-test-failure.txt`).
- CI's three-platform matrix now includes Node 24; the build step runs the strict stdio check instead
  of an EOF-exit-only smoke.
- CI `pack-check` and Release install the freshly built tarball into a clean consumer directory, read
  the installed bin dynamically, and reuse the same strict stdio check; Release adds `lint` and the
  installed-package protocol gate, failing before a draft is created.
- ESLint enables `no-console` (allowing `error` only) for `src/**/*.ts` to prevent new direct stdout writes.

---

## [0.1.9] — 2026-09-09

### Fixed

- Fixed premature TraeWork completion while the model was still thinking but the DOM stayed unchanged for about 36 seconds.
  The stop button and loading task tail are now authoritative running signals and override completion marks; stable rounds now
  start an idle timer, which defaults to ten minutes before returning `idle`.
- Fixed permanently pending `Runtime.evaluate` calls after a CDP WebSocket disconnect. Close/error rejects all pending requests,
  each CDP command has a 15-second default timeout, and task cancellation is observed within about one second.
- Only `completion_mark` / `ask_user` release an instance launched by this module. Idle, timeout, cancellation, and CDP loss retain
  it, with `agentEndReason` / `keptInstance` exposed in task metadata.
- Fixed a shutdown race where an orchestrator still collecting its baseline could remain `queued` and be mislabeled as a user
  cancellation. User cancellation is now determined only from structured cancellation intent.

### Added

- Polling emits a progress event visible through `query_task` every 30 seconds by default.
- Added `gui.idleTimeoutMs`, `gui.cdpSendTimeoutMs`, `gui.progressIntervalMs`, and five overrideable liveness selectors.

### Testing

- Added liveness truth-table, CDP timeout/disconnect convergence, selector-expression, and fake-CDP instance-retention regressions.
- Windows/macOS/Linux × Node 20/22 and tarball gates remain covered.

---

## [0.1.8] — 2026-09-08

### Fixed

- **Atomic-write concurrency defect** (the real cause of intermittent CI failures): the temp filename in
  `writeJsonAtomic`/`writeTextAtomic` was `<target>.<pid>.tmp`, so concurrent writes to the same target in one
  process shared one temp file - the first to finish renames it away and the next throws `ENOENT`; on Windows a
  concurrent rename can also throw `EPERM`. Symptom: `rework_task` intermittently returned an `undefined` meta
  (hit on CI windows/Node 20). Fixed by a random temp suffix plus backoff-retry on transient rename errors.

### Testing

- New `test/unit/atomic-write.test.ts` (3 cases: concurrent JSON/text writes all succeed, no leftover temp files).

---

## [0.1.7] — 2026-09-08

### Fixed

- **Project-folder binding still failed** (v0.1.6 did not fully resolve it; field report: the native dialog
  appeared but the edit box was empty and confirm was clicked anyway):
  - **Root cause**: the MCP passes a `normPath()`-normalized path (lowercase drive + forward slashes, e.g.
    `d:/Trae项目/AI游戏/象棋`), which the **native Windows picker rejects** — measured: read-back matched, yet the dialog
    stayed open after confirm. Fix: convert via the new `toNativeWindowsPath()` to `D:\a\b`.
  - `WM_GETTEXT` **read-back verification** after writing; on mismatch re-locate and retry (up to 3 times);
    if it still mismatches, **never click confirm** and fail loudly.
  - The hwnd detected after the footer click is **passed into the write script**; after clicking, success
    requires that hwnd to be gone.
  - **Auto-close stale dialogs** (left over from a previous failure) before binding.
  - Confirm button now also requires its rect to be in the lower half of the dialog.
  - The dialog script's full trace (HWND/READBACK) is written to the task log.

### Testing

- Total tests **172 → 181** (unit incl. path normalization and atomic-write concurrency; integration incl. stale-dialog cleanup).
- Machine-verified: a new Chinese project `D:\Trae项目\AI游戏\象棋` (absent from the dropdown)
  passed end-to-end through the native dialog; `五子棋` and the ASCII project `ts-bind-test` regressed green.

---

## [0.1.6] — 2026-09-08

### Fixed

- **Project-folder binding got stuck / reported "waiting for native dialog timed out"** (field report; the adapter was not broken):
  - `clickDropdownFooter` used to trust `element.click()`'s return value, but the native popup may never
    appear → it now **confirms the dialog actually appeared**, otherwise it logs a dropdown DOM snapshot and fails loudly.
  - Dialog detection polled from Node every 800 ms while PowerShell cold start is ~4.5–6 s, so a 15 s budget
    allowed only ~2 probes → now it polls **inside a single PowerShell call** (400 ms interval) with a 30 s budget.
  - **CJK paths were corrupted** (measured: `D:\Trae项目\ts-bind-test` became `D:Traes-bind-test`):
    SendKeys/clipboard are mangled by the console code page → the path is now written via Win32
    **`WM_SETTEXT`**, which is fully reliable for CJK.
  - **The confirm click hit a file-list row**: `AutomationId="1"` is not unique (rows also use 0/1/2…) →
    now located by **AutomationId=1 AND ControlType=Pane**, then clicked by bounding rect.
  - PowerShell output was garbled for Chinese → the script now emits **ASCII-only** and Node maps it back
    via `localizeDialogMessage()`.

### Added

- **Non-Work binding fallback**: when binding fails in Code/Design, the driver **falls back to Work once**,
  switches back to the target mode, and re-verifies the project is still bound; only if both attempts fail
  does it report an error including the reason from each mode.
- Machine-verified: for a project **absent from the dropdown** (`D:\Trae项目\ts-bind-test`),
  `run_task(agentId=traework, mode=Code)` passed end-to-end — native dialog wrote the path → confirm clicked →
  project entered TraeWork's list (`solo-lite.local-project-folders` 22→23) → task sent → auto-verification `succeeded`.

### Changed

- `docs/traework-cdp.md` / `.en.md`: 7 new pitfall entries; added the "dropdown entries ≠ project map" fact and the fallback note.

### Testing

- Total tests **167 → 172** (new dialog message-mapping/platform-branch unit tests + Code→Work fallback integration test).

---

## [0.1.5] — 2026-09-08

### Added

- **TraeWork panel mode switching**: `run_task` gained a `mode` parameter supporting `Work` / `Code` / `Design`.
  - Resolution order: explicit `mode` parameter > task-text detection > keep `Work`.
  - Text detection handles mixed Chinese/English phrasing ("switch to Code mode", "use design mode", "工作模式", "代码模式", "设计模式", …).
  - New `gui.modeSwitch` profile switch (default `true`).
  - New pure functions `detectModeFromText` / `resolveMode` (unit-tested).
- **Dedicated SVG assets**: `assets/tianshu-mcp-icon.svg` (app icon), `assets/tianshu-mcp-banner.svg` (wide banner).
- New `scripts/probe-traework.mjs mode <Work|Code|Design>` subcommand (real-machine diagnostics/verification).
- New bilingual release notes `docs/release-v0.1.5.md` / `.en.md`.

### Changed

- **TraeWork execution order**: measurement showed the three modes **each keep an independent project binding** —
  switching modes replaces the input bar's project with whatever that mode last used.
  Order is now: ensure instance → wait for UI → new session → switch to target mode → bind project inside that mode → switch model → send.
- After binding, both mode and project are re-verified; any mismatch **fails loudly** (never silently develops in the wrong mode).
- meta block now exposes `model` / `mode` for Tianshu to read back.
- `package.json`: `license` changed from `MIT` to `Apache-2.0` (matching the repository `LICENSE` file);
  added `repository` / `homepage` / `bugs`; `files` now includes `assets`.
- README.md / README.en.md fully rewritten: stack badges, SVG banner (above the icon), language isolation
  (the Chinese README references Chinese docs only; the English README references English docs only).

### Fixed

- **Rework feedback race** (pre-existing; intermittent under load): the terminal snapshot is written first, so a caller's
  immediate `rework_task(feedback)` could be erased by the previous run's `delete meta.reworkFeedback`, leaving the rework
  round without feedback. Now the feedback is consumed and cleared atomically when `startTask` begins.
  Added regression test `test/integration/rework-feedback-race.test.ts`.
- **`projectBasename` cross-platform**: it used `path.basename` (which does not split backslashes on POSIX), failing
  Linux/macOS CI; now it splits explicitly on both `\` and `/`.

### Testing

- Total tests **153 → 167** (14 new mode-related cases).
- Real-machine end-to-end: `mode=Work` / `mode=Code` / `mode=Design` all completed
  "switch mode → bind project → send → create file → auto-verification passed".

---

## [0.1.4] — 2026-09-08

### Added

- TraeWork GUI driver over CDP: `traework` moved from `unsupported` to `driver=gui` / `status=ready`.
  - Capabilities: launch/reuse instance → new session → bind project folder (dropdown first, restricted computer-use
    native dialog as fallback) → optional model selection → read-back-verified send → poll to completion →
    auto-verify → repair-plan file + same-session rework on failure.
  - Safety: reuse the user's instance by default, never kill a process tree, verify the command line before terminating;
    computer-use is limited to TraeWork's folder picker.
- `AgentAdapter` gained an optional `run()` execution surface; the orchestrator branches on `adapter.run`
  (CLI agents still use spawn).
- Profile gained `driver` (`spawn` / `gui`) and a `gui` section; `run_task` gained a `model` parameter.
- New `src/agents/traework/**` (CDP client, selector table, launcher, session/input/model/reply modules, restricted computer-use).
- On verification failure a repair-plan file `rework-<taskId>-r<N>.md` is generated (task dir + project `.tianshu-mcp`)
  and its filename is referenced in the rework message.

### Changed

- `docs/adapter-matrix.md` T1 conclusion corrected from `unsupported` to "integrated (driver=gui)".
- formatter now passes cancel-source fields (`abortSource`, …) through to `query_task`'s meta block.

### Fixed

- Unified timeout terminal state: normal timeouts now also land `failed(timeout)` plus exactly one `timeout_killed` event, in fixed order.
- Stabilized the `shutdown` test polling.

### Testing

- Total tests **72 → 153** (new TraeWork unit/integration cases).
- Real-machine end-to-end: `run_task(agentId=traework, model=GLM-5.3, autoVerify=true)` drove TraeWork to create a file and passed acceptance.

---

## [0.1.3] — 2026-09-08

### Fixed

- **S1** No-reason cancel was mis-recorded as `interrupted`: added independent `cancelRequestedAt` / `abortSource` fields;
  cancel intent no longer depends on the optional `reason` (5 regression tests).
- **S2** Unified timeout terminal state (shared with 0.1.4).
- **S3** Tracked pre-dirty net-diff attribution: pre-existing dirty files are excluded by content hash when unchanged;
  unchanged staged/unstaged files are no longer reported as agent changes (4 regressions).
- **S4** `verify_task(taskId)` persists real-task metadata (`reportRound` / `verificationSource` /
  `latestVerificationVerdict`, keeping `agentId`); single-source MCP version (`sync-version` injection).
- **S5** `projects.json` official Zod schema + last-known-good for `config`/`profiles`/`projects` + content-sha256
  hot-reload invalidation (fixed corrupt JSON being treated as missing and reset).

### Changed

- **S6** CI/Release `npm ci` retry corrected (stop on success / 3 attempts / attempt counter);
  Vitest v3 upgrade (0 audit vulnerabilities); plain-text status markers (emoji scan test).

### Testing

- Total tests **53 → 72**.

---

## [0.1.2] — 2026-09-08

### Changed

- Build no longer ships source maps (no `.map`, tarball ≈ 69.9 KB).

### Testing

- Total tests **53**.

---

## [0.1.1] — 2026-09-07

### Added

- **Release after the R1–R5 fixes**:
  - **R1** Cancel/interrupt state persistence (`cancel_requested → cancelled`, `cancelReason`/`finishedAt`/`errorType`
    persisted, restart-recoverable, idempotent, bounded shutdown).
  - **R2** Call-level `taskTimeoutMs` precedence fix + cross-platform process-tree termination
    (POSIX process-group SIGTERM→SIGKILL, Windows `taskkill /T /F`).
  - **R3** Git baseline participates in diff (boundary at `baseline.head`; agent commits do not lose changes;
    dirty-worktree hash attribution).
  - **R4** Verification tool parameters and report-round semantics (`round=0` valid, manual verify does not overwrite
    reports, `extraChecks` append + `checksMode=replace`, `optional` does not affect verdict, `baselineRef` validated).
  - **R5** Removed hardcoded agent paths (`{LOCALAPPDATA}` placeholders + platform-standard candidates);
    mtime hot reload for `config`/`profile`/`projects`.
- **R6** Cross-platform CI matrix (Windows/macOS/Linux × Node 20/22) and Release version consistency
  (tag/input = `package.json` = tarball), plus tarball content checks.
- **R7** npm published `tianshu-mcp@0.1.1` + `npx -y` raise with 8 tools connected.
- **R8** Bilingual docs synced (including 4 English topic docs).

---

## [0.1.0] — 2026-09-07

### Added

- First usable release: **M1 core engine + stub-agent end-to-end**.
  - 8 MCP tools: `run_task` / `query_task` / `list_tasks` / `get_task_report` / `cancel_task` / `verify_task` /
    `rework_task` / `get_profiles`.
  - `TaskManager` state machine / per-project serial queue / global concurrency gate / cancel (kill tree) / event-stream persistence.
  - Acceptance engine: git baseline & diff, default check-set derivation, command runner, code analysis,
    `report.md` / `report.json`.
  - fix-loop auto rework + `needs_attention`; skill self-install.
  - Stub-agent 3 playbooks (good / fix-on-first / never) integration tests + protocol tests — **53/53 green**.

---

[Unreleased]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.3.3...HEAD
[0.3.3]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.10...v0.2.0
[0.1.10]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/lanlan0811/tianshu-mcp/releases/tag/v0.1.0
