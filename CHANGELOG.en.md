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

[Unreleased]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/lanlan0811/tianshu-mcp/releases/tag/v0.1.0
