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

[Unreleased]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.9...HEAD
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
