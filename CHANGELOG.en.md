# Changelog

All notable changes to `tianshu-mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Chinese version: [CHANGELOG.md](CHANGELOG.md)

---

## [0.1.1-beta.4] — 2026-10-06 — mcp-gui independent line

> This section records the **security-hardening release** of the GUI's independent `0.1.1` line (issue #32); **the MCP
> package is untouched**. It moves the task-id character allowlist from frontend deep-link parsing down into the
> **Rust command and module layers**, closing the path-joining in four commands. **No new features, no UI changes**:
> user-visible behaviour matches `0.1.1-beta.3`.

### Fixed

- **Escape validation for `task_id` in four Log Viewer commands (issue #32)**: `read_events` / `read_baseline` /
  `export_task_zip` joined task ids **directly** into `tasks/<id>/…` without going through the module's own escape
  guard `resolve_rel`, contradicting the `ARCHITECTURE.md` §16.10 statement that ids go through the `[A-Za-z0-9_-]`
  allowlist. The same defence line had different conventions per command, so **integrity depended on each caller
  remembering** and a newly added command would not inherit the protection. The fix is **one central choke point**:
  `data_home.rs` gains `validate_task_id` (the allowlist, matching the frontend `TASK_ID_RE` in `core/deeplink.ts` and
  §16.10) plus `task_dir` (validates, then joins `tasks/<id>`) as the single entry point from a bare task id to a path;
  the three modules switch to `task_dir` (**defence in depth**); all four commands gain a first-line check in the
  command layer (`lib.rs`) — besides the three named in the issue, **`read_report` is included too** (it used
  `resolve_rel` and did not escape, but likewise lacked the character allowlist). **An assumption disproved while
  verifying**: the existing `if !task_dir.is_dir()` check in `export_task_zip` was treated as an effective guard, but
  measurement showed `is_dir` evaluates to true with `..` in the task id, piercing the gate (**a guard existing is not
  the same as a guard working**); the allowlist now rejects the input **before any path is built**.
- **Attacked surface covered**: path traversal (`../../outside/evil` / `..` / `../..`), backslash traversal
  (`..\..\evil`, **Windows only**), absolute paths (`/etc/passwd` / `C:/Windows`), NTFS alternate data streams
  (`tsk_1:secret`), Windows-illegal characters (`tsk*1` / `tsk?1` / `tsk|1`), whitespace and dots (`tsk 1` / `tsk.1` /
  empty), and Unicode homoglyphs (fullwidth `tsk＿1` / Cyrillic `tаsk_1`) — five vectors escaped before the fix and all
  are rejected after it, with **zero false rejections of legitimate ids**. The check is **byte-by-byte** rather than a
  regex: no new `regex` dependency, and ASCII-only naturally excludes homoglyphs, Windows-illegal path characters and
  alternate data streams.

### Changed

- **`read_baseline` now returns an error instead of a default value for an illegal id**: the command **already** used
  `Err` to report a missing task id (`lib.rs`), and an illegal character is the same class of caller error that silent
  degradation would hide. A normal UI path **cannot** supply an illegal id (`selectedTaskId` comes from real directory
  names returned by `list_tasks`; deep links have their own frontend allowlist), so **user-visible behaviour is
  effectively unchanged**; every frontend consumer already catches errors (all six call sites verified — the
  `readBaseline` sites use `try/catch` + `setError`, and `exportTaskZip`'s `Err` is caught by `doExport()` in
  `WorkspacePage.vue`).

### Tests

- Frontend **169 passed** (15 files); `check:schema` (including `GUI version consistent (0.1.1-beta.4)`) / `typecheck` /
  `lint` all green.
- **This machine has no MSVC linker** (`link.exe` is shadowed by Git Bash coreutils; the Windows SDK ships no `Lib/`),
  so `cargo test` / `clippy` still go to `gui.yml`. Instead this change was verified by **really compiling and running
  the Rust code via `rustc --target wasm32-unknown-unknown`** (`std::path` is pure logic and the wasm32 target ships
  `rust-lld`, so no MSVC is needed): **46 passed / 0 failed**, with the verified function bodies **extracted from the
  on-disk source** by the harness; a **mutation test** (removing the allowlist turned 17 assertions red) proves the
  suite has discriminating power.
- **`cargo fmt --check` does work locally** (rustfmt needs no linker; only `clippy` / `test` do) — the first tag push
  failed the `Rust format / clippy / tests` step on the Windows leg because one new `assert_eq!` exceeded the 100-column
  limit; the same diff was reproducible locally with `cargo fmt --check`, and `cargo fmt` fixed it. **Lesson**: do not
  skip every Rust gate just because the linker is missing — `fmt` and `--emit=metadata` type checking are unaffected.
- New Rust unit tests: `data_home.rs` (allowlist and `task_dir` path-boundary cases), plus escape RED cases, absolute
  path rejection and legitimate-id counter-proofs in `export.rs` / `baseline.rs` / `event_stream.rs`.

### Docs

- Added `docs/release-gui-v0.1.1-beta.4.md` + `.en.md`; `ARCHITECTURE.md` / `.en.md` §16.3 records the new
  `data_home.rs` responsibility and §16.10 notes that the same allowlist is now enforced in the Rust command layer and
  does **not** rely on the frontend `TASK_ID_RE`.

---

## [0.1.1-beta.3] — 2026-10-02 — mcp-gui independent line

> This section records the **third and final pre-release batch** of the GUI's independent `0.1.1` line; **the MCP package
> is untouched**. It delivers A5 baseline drift / A6 stage gantt / A9 disk usage / A8b deep links — the first three are
> read-only enhancements, while A8b is the only item adding Tauri plugins and protocol registration (with a fallback).

### Added

- **A5 a new "Baseline" section in the workspace**: it shows `baseline.json` read-only (repository or not / HEAD / whether the tree was already dirty / pre-existing change and untracked counts / capture time / message) alongside the **latest report's** change stats (report read on demand, cached per task). A missing or broken file always renders "no saved pre-work baseline" — **no zero values are invented**. New read-only Rust command `read_baseline` (`baseline.rs`, 4 unit tests).
- **A6 a new "Stages" view for the event stream (state-transition gantt)**: `ReadEventsRequest` gains `full` (defaults to `false`, **existing behaviour unchanged**); with `full = true`, `event_stream.rs` reads everything via `tail::read_whole` while **sharing the very same parsing code** as the windowed mode, falling back to the tail window if the full read fails. A stage spans two adjacent state transitions, bars are plain divs, and the last stage is marked "running" — **no invented durations**; if the file does not start at `created` the UI says so. New pure functions in `core/timeline.ts` (`buildStages` / `totalMs` / `stageShare`).
- **A9 a new "Disk usage" section on the Insights page**: new read-only command `scan_disk_usage` (`diskscan.rs`, 4 unit tests) measures the **actual size** of `logs/` and every directory under `tasks/` (**no `tsk_`/`vfy_` prefix filter**, `stat` only, contents never read) and reports totals / `logs/` share / top-20 task sizes / the median. Every cleanup rule is **relative** (`CLEANUP_HEAVIEST_RATIO = 0.5`, `CLEANUP_MEDIAN_MULTIPLE = 2`, named constants in `core/insights.ts`) with new pure functions `medianOf` / `cleanupHints`; **hints only — there is no delete entry of any kind**.
- **A8b deep link `tianshu://task/<taskId>`**: adds `tauri-plugin-single-instance` (with its `deep-link` feature; it **must be registered first**) and `tauri-plugin-deep-link`, and declares the `tianshu` scheme in `tauri.conf.json`. Cold start (`get_current`) and hot start (`on_open_url`) both **only enqueue and emit `gui://deeplink`**, and the frontend drains the queue before routing it (**the queue is the source of truth**, so cold-start links are never lost). Parsing lives in the pure `core/deeplink.ts` (id whitelist `[A-Za-z0-9_-]`; anything with `..`/`%2e` is rejected outright). **Deep links are handled entirely in Rust, so `capabilities/default.json` does not gain `deep-link:default`.**

### Fixed

- **The command palette no longer caps task commands at 50 (fixed after `0.1.1-beta.2` shipped; delivered here)**: the old implementation **pre-generated** task commands as `slice(0, 50)`, so with more than 50 tasks the later ones were **unfindable** and the only feedback was "no matching commands" — no error, no truncation notice, **more misleading than not offering the feature**. Task commands are now produced by `buildTaskCommands`, which searches **every task live on each keystroke** (no cap; a blank query lists no tasks), and `rankCommands`'s `PALETTE_RESULT_LIMIT = 20` **limits only how many rows are shown, never the search scope**; the former `buildCommands` was split into `buildStaticCommands` (navigation + data homes) and `buildTaskCommands`. Regression cover: `test/palette.test.ts` asserts with 300 tasks that "the 300th is findable", "a blank query lists no tasks" and "the display limit only truncates the view".

### Tests

- Frontend **169 passed** (15 files; new `test/timeline.test.ts` / `test/deeplink.test.ts`, plus `medianOf` / `cleanupHints` cases in `test/insights.test.ts`), with `check:schema` / `typecheck` / `lint` / `build` all green. Rust gains unit tests in `baseline.rs` (4) / `diskscan.rs` (4) / `event_stream.rs` (one full-read case); local `cargo fmt --all --check` passes (`clippy` / `cargo test` run in `gui.yml`).
- **Simulated real-machine run (headless Edge + mock preview) passed 14/14**: an empty deep-link queue raises no error, the baseline section shows the summary and the report comparison, a task without a baseline says so honestly, the stages view renders 12 stages (the last marked "running") plus the stage total, switching back to List still lists events, the disk section shows its four readings plus the top table and cleanup hints with **no delete or cleanup button anywhere on the page**, and there is no `pageerror`.

### Docs

- Added `docs/release-gui-v0.1.1-beta.3.md` + `.en.md`; `docs/gui-log-viewer` gained §3.9 Baseline, §3.10 stages view and §3.11 deep links in both languages, §3.6 documents the disk-usage conventions, §8 the deep-link security boundary and the minimal-permission stance, and §9 the platform difference and "statistics only, never delete"; README documents this batch; ARCHITECTURE gained §16.10 "Deep link and single-instance contract" in both languages; HANDOFF's top snapshot and handoff section were updated.

---

## [0.1.1-beta.2] — 2026-10-02 — mcp-gui independent line

> This section records the two pre-release batches of the GUI's independent `0.1.1` line. **The MCP package is
> untouched** (the GUI versions independently of the package, under its own `gui-v*` tags). All three items in
> `0.1.1-beta.2` are **read-only** enhancements: structured filters, multi-task compare and a command palette.

### Added

- **A7 richer structured filtering (`0.1.1-beta.2`)**: the overview filter sheet grows from 7 to 11 conditions, adding **error type `errorType`** (options come from the **facets** of the current task set — no hard-coded enum), **dry run `dryRun`**, **reworked `reworked`** (`roundsUsed > 1`; a single round is not rework) and **visual acceptance `hasVisual`** (a `report-<round>.html` exists). Rust's `TaskFilter` (`models.rs`) plus `matches_filter` in `scanner.rs` and the frontend's `filterTasks` in `core/filter.ts` are **two copies with identical semantics**; every new Rust field is `#[serde(default)]`, so older callers that omit it keep working.
- **A4 multi-task compare (`0.1.1-beta.2`)**: a new "Compare tasks" section on the Insights page — pick **2–4** tasks on the left (going past the limit gives an **explicit notice and never replaces** an existing pick) and read a side-by-side metric matrix on the right (status / agent / project / rounds / verify time / changed lines / files changed / latest verdict / failed checks / error type / message), with the rounds and verify-time rows marking the **best value across tasks**. Reports are read **on demand** and cached per `taskId`; anything missing shows `—` (never invented).
- **A8a command palette and hotkeys (`0.1.1-beta.2`)**: `Ctrl/Cmd + K` opens the palette (**subsequence fuzzy matching**; `↑` `↓` to move, `Enter` to run, `Esc` to close; while open **no other global hotkey fires**), and `Ctrl/Cmd + R` refreshes (intercepted, so the webview never reloads; combinations with `Alt` / `Shift` are never intercepted). Commands reuse existing data and actions (jump to pages / switch data home / open a task directly, capped at 50 task commands).
- **Insights page skeleton + A1 scoreboard / A2 attribution / A3 trend (`0.1.1-beta.1`)**: a new full "Insights" page in the sidebar (the shell `view` grows to four states); a new read-only aggregation command `get_insights` (`insights.rs` + `timestamps.rs`) that only **counts and sums**, leaving rates / TopN / trend gap-filling / week bucketing to frontend pure functions; the trend supports **by day / by week** (Monday week start) and a **rework rate**.

### Tests

- **`0.1.1-beta.2`**: frontend **147 passed** (13 files; new `test/hotkeys.test.ts` / `test/palette.test.ts`, four new filter cases in `test/filter.test.ts`, and `compareTasks` / `bestOf` / `nextCompareSelection` cases in `test/insights.test.ts`), with `check:schema` / `typecheck` / `lint` / `build` all green. Rust gains the `matches_filter_supports_new_dimensions` test (local `cargo fmt --check` passes; `clippy` / `cargo test` run in `gui.yml`).
- **Simulated real-machine run (headless Edge + mock preview) passed 13/13**: all new filter controls present and "reworked = yes" actually filtering (4 → 1), `Ctrl+K` opening the palette, fuzzy-matching and jumping to the Insights page, the compare matrix headers and metric rows, the 4-task cap, and no `pageerror`.

### Docs

- Added `docs/release-gui-v0.1.1-beta.1.md` + `.en.md` and `docs/release-gui-v0.1.1-beta.2.md` + `.en.md`; `docs/gui-log-viewer` gained §3.7 Compare tasks, §3.8 Command palette and hotkeys and §3.1 filter details in both languages; README gained the "structured filters / multi-task compare / command palette" bullet; ARCHITECTURE gained §16.9 "Filter semantics and command-palette contract" in both languages; HANDOFF's top snapshot and handoff section were updated.

---

## [0.8.0] - 2026-10-06

A cumulative release of **two agent resume-semantics fixes**: TraeWork's cross-mode project-binding
fallback is removed (issue #35), and ZCode resume rounds no longer silently rewrite the session's
permission (issue #30). Neither adds features or UI changes — both correct distorted behaviour when
*resuming an existing session*, and both belong to the same family: **resuming must stay faithful to
the original session**.

### Fixed

- **TraeWork: removed the cross-mode project-binding fallback; failures keep the target mode
  (issue #35, #36)**: when binding in a non-Work mode failed, `bindProject()` would **fall back to
  Work mode** to complete the binding and then switch back. Under "each mode binds independently",
  that fallback is **structurally unreachable**: a project bound in Work mode is not inherited by
  Code / Design, so switching back loses it — the round still ends in failure, while the user's
  requested mode was **silently rewritten** to Work. The whole fallback branch is now removed; a
  non-Work bind failure returns an honest failure and **never changes the requested mode**. Before
  the fix, two behaviour tests in `test/integration/traework-bind-fallback.test.ts` failed faithfully
  (`expected 'Work' to be 'Code'` / `expected 'Work' to be 'Design'`); they pass after it.

- **ZCode: resume rounds preserve the original session permission (issue #30, #37)**: when
  `continue_task` / `rework_task` resumed an existing session, `runZcodeTask` first derived the
  permission from `ctx.resume.permissionMode` but then **unconditionally overwrote** it with
  `gui.defaultPermissionMode` before dispatch — silently reverting the session permission to the
  profile default, then forcing that value onto the UI and reading it back, so the reported
  `session.permissionMode` was distorted too. `permission` is now `const` (the only assignment site in
  the file) and falls back to the profile default **only when no record exists**; on a read-back
  mismatch the error now carries the **actual target permission** (it previously always said
  "完全访问", which misled diagnosis).

### Verification

- TraeWork: `vitest run traework` — 15 files / 139 tests pass; reverting `session.ts` reproduces the
  two failures.
- ZCode: three related test files — 85 tests pass; reverting only `src/agents/zcode/run.ts` yields
  5 failed / 3 passed on the new cases, failing exactly at the layer under test (`fake.permission`
  expected "受限访问", got "完全访问").
- `tsc --noEmit` / ESLint `--max-warnings 0` / `git diff --check` pass.
- **The ZCode side uses a fake-CDP integration test and has not been verified on a real machine**
  (the boundary declared in PR #37; carried over here).

### Known limitations

- The ZCode permission-preservation fix is covered only by fake-CDP integration tests; no real-machine
  (actual ZCode 3.14.x) reproduction.
- In the full `vitest run`, `test/integration/zcode-rework-loop.test.ts` has a **timing flake waiting
  for a terminal state**, reproduced on base master too and unrelated to these two fixes.

---

## [0.7.10] - 2026-10-06

### Fixed

- **Precise semantics for the visual content-egress gate (issue #29)**: with `allowRemote` defaulting to
  `false`, `<image:base64:file>` is rejected by the schema, while `<image:path>` / `<expect:file>` are
  unconstrained — and the docs implied the contract layer blocked *every* way of handing an image to a
  command, leading readers to believe the channels were sealed. Probes and counter-evidence show that
  **gating the path channel yields zero security**: the judgement command runs with `shell:false` inside the
  **project directory** and can already read project files itself; forcing an opt-in would also make users
  set `allowRemote` just to pass the schema, which **opens up the inline base64 channel too**. This release
  therefore does not change the gate — it states the boundary precisely and makes the channels visible.

### Changed

- **New `contentChannelUsage()` (`src/visual/schema.ts`) as the single source of channel semantics**: the
  gate check and the doctor/probe display share the same logic, so the two cannot drift apart.
- **`visual doctor` now reports each rule's actually-used placeholder channels and whether they are
  constrained** (`GATED` / `NOT gated`) — surfacing what the command really receives (absence never raises
  an alarm by itself).
- **`visual content probe` output gains `egressConstrained` / `pathChannels`** for programmatic checks.
- Wording synced across `SECURITY.md` / `SECURITY.en.md`, `docs/visual-acceptance.md` / `.en.md`, and
  `skills/tianshu-mcp/SKILL.md`: `allowRemote` constrains **only** the inline-byte shape, and the contract
  layer is **not** a complete block on image egress.
- `<expect:file>` nature clarified: it delivers a temp file holding the **expectation text** and is **not**
  an image-egress channel (the issue conflated the two).

### Verification

- 5 new channel/admission contract tests (`test/unit/visual-content-schema.test.ts`), 2 doctor
  channel-semantics tests (`test/unit/visual-runtime.test.ts`), plus the probe field assertion.
- Counter-evidence probe: the command read a project file with **zero placeholders**
  (`READ 4187 bytes with zero placeholders`), proving gating the path channel has no benefit.
- Full `npm test` **1582 passed / 12 skipped, 0 failed**; `typecheck` / `lint` / `build` / `pack:check` /
  `check:stdio` all green.

---

## [0.7.9] - 2026-10-06

### Fixed

- **Dead link to `docs/agent-profiles.md` inside the npm package**: three places in the README (including
  the top navigation "Agent Profiles" entry) point at that document, but it was missing from the
  `package.json` `files` allowlist — users installing from npm hit a 404. Both `docs/agent-profiles.md`
  and `.en.md` are now included. **This defect predates 0.7.8; it was not introduced by it.**

### Docs

- **Completed the documentation surface for the MiniMax Code adapter**: 0.7.8 shipped the full
  `src/agents/minimax/` implementation and `docs/minimax-cdp.md`, but **the other documents that describe
  agents were not synchronised** — this release fills in 4 files and 23 places:
  - `README.md` / `README.en.md` (5 each): the agent banner, the `continue_task` resume-semantics list,
    a new `minimax` row in the agent capability table, the `reasoningLevel` validation footnote, and the
    version-history table.
  - `docs/agent-profiles.md` / `.en.md` (4 each): the `adapter` enum comment, the `driver=gui` table's
    agent list (**which had also been missing qoder / opendesign**), cross-document links, and a new
    complete `minimax` profile example section.
  - `skills/tianshu-mcp/SKILL.md` (35): the header `description` and `triggers` (**without which the skill
    cannot be keyword-triggered**), the tool-surface `continue_task` support list, a new 8th column and a
    `contextWindow` row in the §3.1 parameter matrix, a new minimax subsection in §3.2, the §3.3 platform
    status, all six `needsUserKind` rows plus the anchor field in the §5 resume matrix, and minimax
    semantics for six error codes in §9.
  - `skills/tianshu-mcp/usage-examples.md` (9): a new §2.9 minimax example (including a **candidate table
    for all four measured model shapes**), renumbering of the `codex-cli` section (**fixing a duplicate
    `### 2.10` in the original**), a `contextWindow` row in the parameter-rejection table, and updates to
    the `autoFixRounds` defaults and the session-anchor field table.

  Every concrete assertion in these docs was **verified against the source** rather than recalled, and the
  behavioural differences were exercised with a real probe:
  `defaultAutoFixRounds=2` / `cdpPort=9999` / `permissionMode=始终授权` / the platform status check live in
  `src/agents/minimax/profile.ts`; `contextWindow` is minimax-only per `src/mcp/handlers.ts:476`;
  and **minimax is the only adapter that accepts `中`/`medium`** — it accepts `极高`/`最大` but
  **rejects `关闭思考`** (confirmed by probe).

### Changed

- Version `0.7.8` → `0.7.9` (`package.json` and `src/version.generated.ts`).
  This release contains **no logic changes** — documentation and the packaging allowlist only.

---

## [0.7.8] - 2026-10-06

### Added

- **Seventh GUI agent adapter: MiniMax Code (`agentId=minimax`)**. It sits alongside the existing six and covers the full loop of "locate the installation → launch it with CDP enabled → bind the project folder → select model / reasoning level / context window → send the task → detect completion → auto-verify → rework on failure → re-verify". See [MiniMax Code adapter](docs/minimax-cdp.en.md).

  **Real-machine evidence (2026-10-05, MiniMax Code 3.1.0 / Electron 42.8.0 / Chromium 148.0.7778.280) corrected three structural assumptions** that were wrong before implementation; these conclusions live in both the code comments and the docs:

  - **Reasoning level / context window live in a second-level submenu.** The product's own frontend artifacts show them as flat `role="group"` elements, but the live DOM **only renders them after hovering a model row carrying `aria-haspopup="menu"`** (`aria-expanded` flips to `true` and a second `role="menu"` appears). Selecting a model is therefore a three-step sequence: hover to expand → pick the tier/window → **finally** click the model row to commit (clicking it immediately commits and closes the menu). **The submenu container is reused**: moving straight into a row without first moving the pointer away does not fire `mouseenter`, so the DOM keeps the previously hovered model's tier set — picking from it selects another model's set. Candidate reads are therefore scoped to the owning model via `aria-label`.
  - **Tier / window sets vary per model** (measured): `M3.1-Flash-Preview` has six tiers (default/low/medium/high/xhigh/max) plus windows (512K/1M); `M3` has **no tier group** plus windows; `deepseek-v4.1-flash` has three tiers (low/high/max) and **no window group**; `M2.7-highspeed` / `M2.7` have **no submenu**. Requesting these parameters on a model without a submenu is **fail-closed** — the adapter never silently keeps the UI's current value, and refuses to guess when the tier set cannot be read.
  - **"New project" takes two steps**: clicking the sidebar's "New project" first opens an **in-app HTML modal** (`.responsive-modal-mask`); clicking "Choose folder" inside it then opens the **native `Select Directory`** dialog (title measured in English even on a Chinese UI), and after confirming the modal still needs its own "Create project" submit. Doing only one step misreads "the native dialog never appears" as a broken selector.

  Other measured facts: the `Model menu` is a **separate renderer process** (hence the adapter connects across windows); that window **stays `visible` after the menu closes** (its content is emptied), so open/closed must be judged by "is content rendered" rather than `visibilityState`; the "new task" testid sits on a `<kbd>` (the clickable element is its ancestor `button`); the send button is a `DIV` (usability comes from `aria-disabled`, there is **no `disabled` property**); the input is **tiptap ProseMirror**; and the authoritative project-binding criterion is the sidebar's `data-workspace-dir` **full absolute path**.

  **The real-machine loop passed** (sandbox `MiniMax-Test`, seeded with one deliberately failing test): dispatched `M3.1-Flash-Preview / low / 512K` → `ok=true`, `endReason=reply_stable`, with the `stop_button` run signal recorded live; the agent really edited `src/calc.mjs` and made the sandbox tests pass 4/4 (independently re-verified with `node --test` + `git diff`). Evidence: [real-machine loop transcript](docs/minimax-evidence/real-machine-e2e.txt).

- **New `contextWindow` parameter (minimax only)**: deliberately loose (UI candidates vary per model, and a hard-coded enum would reject valid values); validity is checked against the **actual UI candidates** before sending. Passing it for a non-minimax dispatch is an error.
- **New read-only diagnostic probe `scripts/probe-minimax.mjs`** (`npm run probe:minimax`): prints install discovery, processes and CDP topology, model/submenu candidates (**hover only, no clicks**), project groups, run-signal snapshot and native-dialog enumeration — it reproduces every conclusion above.

### Tests

- Added `test/unit/minimax-*` (6 files, **121 cases**): discovery order, parameter surface, tier/window set validation (all fail-closed paths covered), selector structural contracts, run judging and question detection, project path normalisation and session location.
- Included a **new class of "in-page expression sandbox executability" test**: it runs every in-page expression through `node:vm` and asserts `/is not defined/`. Bugs of the "string-assembled expression missing a helper" kind are invisible to both `tsc` and ordinary unit tests — this is the only thing that catches them early (the real machine hit this twice).
- Full suite **126 files passed / 3 skipped / 0 failed**; typecheck / lint / build / strict stdio all green.

---

## [0.7.7] - 2026-10-01

### Added

- **Blocking wait primitives `wait_task` / `wait_any` (issue #28)**. `run_task` returning a `taskId` immediately is the right adaptation to the host's constraints, but the intended caller (a Tianshu agent session) is **turn-driven** — it runs only within the turn that received a user message and does nothing between turns, so it cannot poll on its own. The task-completion moment could therefore only be caught by a human sending another message. Two **pure read-only, approval-free** tools now carry the waiting:
  - `wait_task(taskId, timeoutMs?)` — block until a single task reaches a **stop point** (terminal status or `needs_user`) or the timeout elapses;
  - `wait_any(taskIds, timeoutMs?)` — wait for the **first task in array order** among a group (1..20) to reach a stop point, returning its snapshot plus every task's current status.
  - **Stop-point definition** (single decision point `isWaitSettled`): `isTerminal(status) || status === "needs_user"`. The moment a task **stops making progress** is the moment to wake the caller — `needs_user` is not terminal but has stopped awaiting a human (it can be resumed by `continue_task` and may re-enter); without waiting for it the wait would block until the timeout and the caller would know nothing about "the task is waiting for a person".
  - **Timeout policy**: `timeoutMs` defaults to `50000ms` (below the common 60 s client tool timeout, leaving round-trip headroom) and caps at `600000ms`; values above the cap are **clamped and disclosed honestly** (never silently rewritten); a timed-out response steers the caller into a call loop (≈50 s per round; long tasks need several calls).
  - **Lossless guarantee**: the wait is **read-only** — it writes no task state and touches no task body, so a client truncation / connection drop / timeout **never affects the task's continued execution**. On request cancellation / connection close the loop exits immediately via the SDK's `extra.signal`, leaking no background wait.
  - **Tool surface 11 → 13** (`read` family +2); new bilingual [wait primitives](docs/wait-task.en.md) doc.

### Changed

- The `registerTool` callback in `src/server.ts` forwards the SDK request `extra` (including `signal`) to the handler — **used only by the wait tools**; every other handler is unchanged.
- `MetaBlockFields` gains optional `waitSettled` (whether a stop point was reached) and `waitedMs` (actual wait duration) for programmatic checks by the caller.

### Tests

- Added `test/unit/wait-task.test.ts` (8 cases: stop-point decision / state transition / timeout / `signal` abort / missing reporting / clamp disclosure) and `test/integration/wait-task.test.ts` (6 cases: real stub long-task end-to-end / short-timeout continuation / not-found error / `cancel_task` effective during a wait / `wait_any` first settled / fail-closed on a missing id).
- `test/protocol/protocol.test.ts` truth table and tool-name array synced to 13 (the count hard assertion covers it automatically).
- Full suite **1447 passed / 12 skipped** (1459 tests, 122 files).

## [0.7.6] - 2026-09-30

### Fixed

- **Three ZCode adapter defects (issue #27), reproduced and fixed on real ZCode `3.14.3.7762` (Windows)**:
  - **Split project-collection channels causing a binding deadlock**: on 3.14.3 the
    `[data-testid^="workspace-item-"]` nodes are **not gone from the DOM** — they are scrolled out of
    the viewport instead (measured on the real machine: **40 of 42 nodes invisible**). The old
    implementation collected them without any visibility filter, so the ghost entries made
    `if (!out.length)` permanently false and the only trustworthy channel (the dropdown menu) never
    ran. `matchZcodeProject` then matched a ghost item, the working auto-import branch was skipped,
    and the task died with `project_mismatch`. `projects()` now filters the legacy channel by
    visibility, **always merges both channels**, and lets same-named menu items override sidebar
    entries (only the menu's `aria-checked` is binding evidence rendered by ZCode itself).
  - **Fall back to import when clicks never land**: `clickProject` now reports a distinguishable
    reason (`trigger-unavailable` / `not-found` / `not-visible`). When the target is listed but not a
    single click ever landed, the adapter falls back to the `selectZcodeFolder` import path instead
    of declaring failure (still fail-closed when `allowCreateProject=false`).
  - **Runtime CDP disconnects no longer declare death**: a single `Runtime.evaluate` timeout or an
    endpoint hiccup does not mean CDP is dead (in the reported incident the agent kept writing
    artifacts after MCP had already failed the task). The send phase and the runtime loop now share
    one guard: the first disconnect reconnects **once, for observation only** (matching the existing
    `codex`/`qoder` pattern — **never resending the task**); a failed reconnect or a second
    disconnect lands on `needs_user(setup_recovery)` with both facts attached — whether the process
    is still alive and whether the window still shows running signals — so "still running" is never
    misread as "stopped".
  - **`reasoningLevel` implemented end to end**: the tier set **varies per model**, so it is read
    from the UI **after the model is confirmed** and validated. Out-of-range tiers and unreadable
    tier sets are rejected **before sending** (`reasoning_level_invalid`) instead of silently reusing
    the current value; omitting the tier never touches the UI. Real-machine contract:
    trigger `chat-thought-level-select-trigger` (combobox), options
    `chat-thought-level-select-item-{enabled,disabled}` (binary on/off), options mounted only while
    the menu is open.
  - **Root cause of the "two-level model menu is flaky" symptom**: model items live in the provider
    group's **second-level submenu**, which renders only on **hover** — clicking selects the group
    itself or collapses the menu. The provider group testid has also drifted to
    `chat-model-select-group-registry-provider:`. Group expansion now uses hover
    (`clickExact(..., "hover")`), and when two rounds both yield an empty candidate list the menu is
    reopened for one more round instead of declaring `model_unavailable`.
- **Permission-menu contract drift (surfaced by the real-machine run, fixed as the same class of defect)**:
  on 3.14.3 the permission items use `menuitemradio` / `menuitemcheckbox` (**not** `option`), and the
  visible name lives in the item's **direct text node**, followed by an explanatory sentence
  (e.g. "Full access — fewer confirmations."). Both mismatched the old implementation and stalled
  dispatch at `permission_unknown`. The selector now carries a role-agnostic fallback, and
  `clickExact` resolves labels from direct text nodes first.

### Real-machine verification

- `npm run probe:zcode -- dom-contracts`: `workspaceItems=42` (2 visible / 40 invisible),
  `dataProjectPath=0`; with the menu open `projects()` returns the menu items with correct checked
  state — independently reproducing both the issue's geometric premise and the fixed collection.
- `npm run probe:zcode -- models` / `permission` plus one-off probes: pinned the provider-group hover
  semantics, the permission item role/text structure, and the binary tier shape
  (`current=on`, `tiers=Off/On`).
- `npm run smoke:zcode`: end-to-end real-machine dispatch (project binding → model switch →
  permission confirm → send → poll to terminal state).

## [0.7.5] - 2026-09-29

### Fixed

- **Qoder CN 0.4.2/0.4.3 support** (PR #26, contributed by jian-in): from 0.4.2 the model menu drops
  the "default/custom" group tabs (candidates become a flat list and the model name moves to the trigger
  text); in 0.4.3 the composer picker loses its `aria-label` and the bound-workspace container loses its
  `title`. The selector candidate order now puts the stable marker `[data-workspace-picker-trigger]` before
  the broad aria heuristic (otherwise it matches the sidebar "Workspace" section header and surfaces as
  `qoder_stage_timeout: workspace-menu`); the "menu is open" check is narrowed to the search box
  `workspaceSearch` (a generic `[role=menu][data-state=open]` can be matched by an unrelated overlay and
  pass falsely); bound-workspace readback lists title-less container candidates and falls back to
  `aria-label`/text. `QoderCdpClient` gains `resolveKey()`/`textKey()` for compound queries that need the
  first matching candidate.
- **Verify engine normalises the `cwd` drive-letter case on Windows** (same PR): a project path may be
  registered with a lowercase drive letter (e.g. `e:/proj` in `projects.json`), and vite/vitest key their
  module graph by path string, so `e:\proj` and `E:\proj` count as two locations, the same module appears
  twice, and collection crashes. `runVerifyCommand` now normalises with `fs.realpathSync.native` before
  spawning (the non-native variant returns the lowercase drive letter unchanged on Windows); when the path
  cannot be resolved it falls back to the original value, so normalisation never blocks acceptance.

## [0.7.4] - 2026-09-28

### Fixed

- **Project-scoped dispatch on ZCode 3.14.x always failed with `project_mismatch` (issue #24).**
  ZCode 3.14.x removed the two DOM contracts tianshu-mcp used for **binding read-back**
  (`data-project-path` and `data-testid^="workspace-item-"`), while `pathOf()` in
  `src/agents/zcode/dom.ts:27` recognises nothing else — so `workspaceBinding().projectPath` was always
  empty and `cdp.projects()` always returned `[]`, leaving the binding criterion unsatisfiable forever.
  The failure happens **before the task brief is ever sent**, which made `autoFixRounds` inert
  (`roundsUsed` stayed 0). The fix touches four places, all stemming from that one root cause:
  - `selectors.ts:107` gains `projectMenuItem` (`[role="menuitemcheckbox"]`), and `projectItem` /
    `projectPath` are now explicitly labelled as 3.11.x contracts;
  - `workspaceBindingExpression()` in `dom.ts:38` now also returns `projectName` (the bound display name)
    and `menuChecked` (display names of menu items with `aria-checked="true"`), treating multiple checked
    items as ambiguity; it **never fabricates a path** — on 3.14.x `projectPath` stays an empty string, and
    the decision layer uses that to distinguish evidence strength;
  - `projects()` in `cdp.ts:279` falls back to harvesting the expanded menu **only when the old contracts
    yield nothing**, and it includes the checked state and excludes "work outside a project", so the
    3.11.x result is byte-for-byte unchanged;
  - `matchZcodeProject()` in `project.ts:61` gains a **display-name exact-match** branch and reports
    `matchedBy`; a new `boundProjectVerdict()` implements the layered criterion — **strict path equality
    whenever a path is available (unchanged semantics), display name when there is no path channel** —
    and requires the project list to be free of same-name ambiguity.
- **Removed a fragile timing dependency**: `ensureProjectBound()` used to accept an externally supplied
  item, which made "the menu happens to still be open" an implicit precondition. It is now an idempotent
  self-check: read the verdict first, pass immediately when already bound, and only expand the menu and
  click when it is not.
- **Better failure diagnostics**: the `project_mismatch` message now carries the trigger text, the menu
  checked state and the path read-back, so users are no longer left with a bare "read-back mismatch".
- **On-device evidence entry point**: `scripts/probe-zcode.mjs` gains a `dom-contracts` subcommand that
  reports hit counts for both legacy contracts, the trigger's full attributes, the menu item list and the
  post-fix read-back — for re-checking this contract assumption against a real ZCode build.

### Known limitation

- The ZCode 3.14.x DOM exposes a project's **display name** but not its absolute path, so the criterion is
  "display name + global same-name disambiguation": more than one same-name item yields
  `project_ambiguous` (fail-closed). Disambiguation requires the menu to be expanded (that is `projects()`'
  data source); with the menu closed only the `binding` display-name evidence is used, and a missing list
  never negates a binding. The 3.11.x path-equality chain keeps the highest priority and is unchanged.

### Tests

- **14** new cases: 4 in `test/unit/zcode-dom.test.ts` (read-back contract under the missing 3.14.x
  contracts, multi-check ambiguity, and no regression for 3.11.x), 6 in `test/unit/zcode-core.test.ts`
  (display-name matching / same-name fail-closed / layered criterion / path priority), and 4 in
  `test/integration/zcode-flow.test.ts` (already-bound dispatch without a stray click, switch-then-dispatch,
  same-name ambiguity fail-closed, and a **counter-example** where missing display-name evidence still
  fails closed with diagnostics). Full suite: **1383 passed / 12 skipped** (1395 tests, 115 files plus 3
  real-browser files skipped by design).

> **On-device verification boundary (disclosed honestly)**: this machine has **no ZCode 3.14.x**, so the fix
> was not re-verified on hardware. The root cause (missing DOM contracts) is **deterministically reproducible
> locally** against a `linkedom` fixture: the new cases were first written to show three failing assertions
> (`projectName`/`menuChecked` absent, `projects()` empty, multi-check not treated as ambiguous) and then
> driven to green. The on-device measurements reported in issue #24 (`data-project-path` 0 hits,
> `workspace-item-` 0 hits, `menuitemcheckbox` intact) were **not independently reproduced**; the fix is
> designed against those contracts. Maintainers with a 3.14.x environment should run
> `npm run probe:zcode -- dom-contracts` to confirm.

## [0.7.3] - 2026-09-28

### Fixed

- **Skill docs had drifted from the implementation** (`skills/tianshu-mcp/`):
  - `usage-examples.md` carried a **duplicate `### 2.9`** (codex-cli and the shared-conventions section
    collided) → the latter is now `### 2.10`;
  - `SKILL.md` §9 did not state that its error-code table is a subset — `endReason` is typed as an optional
    `string` (`src/agents/adapter.ts:93`) with **no enum constraint**, so an adapter can add a value without a
    type change. The doc now says so, and points readers at the adapter's `run.ts` for unknown values;
  - added three high-frequency `endReason` values that were missing from the table: `input_mismatch`
    (a leftover draft makes the task land inside stale text), `send_unknown` (delivery unconfirmable —
    **never resends**), and `reply_stable` (normal completion, not an error).

### Docs

- **Documented Open Design artifact retrieval** (a `v0.7.1` capability, previously absent from the skill):
  designs live in the product's artifact store `<dataRoot>/projects/<projectId>/<entry>`, **not** in the
  task directory; once terminal the adapter copies it into `projectPath`.
- **Documented the daemon-readiness precondition**: the product completes an auth handshake with its daemon
  before opening the folder picker (measured ~30s after launch); when unready the product **opens no dialog
  at all**.
- **Marked the `zip` export as a known limitation** (the product's main process takes over downloads,
  overriding CDP's handling; the `html` path is fully working).

> This release contains **no runtime code changes** (only `skills/` docs and the version bump), so upgrading
> from `0.7.2` changes no behaviour; it syncs docs with implementation and aligns tag / Release / npm on a
> single commit.

## [0.7.2] - 2026-09-28

### Fixed

- **Cross-platform CI failure (every ubuntu / macOS leg)** (`test/unit/opendesign-discovery.test.ts`):
  the new `DevToolsActivePort` candidate-path case injected only `APPDATA`, while production's
  `devToolsActivePortPaths` **keys the base directory off the host platform** (win32 uses `APPDATA`,
  other platforms use `HOME/Library/Application Support`) — so on ubuntu/macOS the base went down the
  `HOME` branch and the assertion could never match. This is the **third** occurrence of the same
  family (the earlier two were `discoverOpenDesign`'s candidate paths and the version read-back):
  assertions coupled to the host platform, passing on only one class of machine.
  Fix: the case now injects the platform-appropriate env and derives the matching expectation, sharing
  the production source of truth.
  Measured impact: CI #295/#296 and Release #44 all failed on this, so the **GitHub Release was never
  created** (the npm package itself is unaffected).

> Note: the `0.7.1` npm package is published and its `dist` is correct; this release only fixes the
> test's cross-platform coupling so tag / Release / npm can converge on a single commit.

## [0.7.1] - 2026-09-28

> This change moves the built-in agent `opendesign` (the Open Design desktop app, `driver=gui` /
> `adapter=opendesign-gui`) from "in development" to **fully dispatchable**: selectors are now grounded in the
> product's own artifacts, all twelve steps are wired, and the adapter is plugged into the existing
> acceptance → automatic rework → re-acceptance loop.

### Added

- **All Open Design selectors landed (evidence taken from the product's own artifacts, not eyeballed screenshots)** (`src/agents/opendesign/selectors.ts`):
  - Primary anchors come from the `data-testid` hooks used systematically by Open Design's web bundle (`resources/open-design-web-standalone/apps/web/.next/static/chunks/*.js`): `chat-composer`, `chat-send`, `chat-log`, `working-dir-trigger`, `working-dir-pick`, `composer-design-system-trigger`, `design-system-search`, `home-hero-template-trigger` (the "creation type" picker), `home-hero-input`, `home-hero-submit`, `inline-model-switcher-chip`, `model-picker-trigger`.
  - The stop button carries no testid, so it is identified by the product's own `class="composer-send stop"` plus `aria-label=<chat.stop>`.
  - Menu items are uniformly `role="option"` (their triggers are `aria-haspopup="listbox"`), matched by **normalised exact text**; a miss echoes the visible candidates and **never** falls back to fuzzy matching.
- **CDP transport `src/agents/opendesign/transport.ts` (two paths)**: on real hardware Open Design's browser-level `/json/version` responds, but `/json` and `/json/list` **connect successfully and then never answer** (target enumeration runs on the UI thread, which the product blocks during startup on its own billing/telemetry requests). The transport therefore tries HTTP `/json` first and, on timeout/failure, falls back to the browser-level WebSocket: `Target.getTargets` + `Target.attachToTarget(flatten)` yields a `sessionId` used for subsequent commands (page-level commands carry `sessionId`; `Target.*` / `Browser.*` do not). The readiness probe `probeOpenDesignPort` reuses the same target-enumeration implementation.
- **The full twelve-step execution chain** (`src/agents/opendesign/run.ts`): attach or launch the instance → connect to the main window (the input must genuinely be ready) → version gate → selector guard and layout probe → bind the working directory (expand trigger → click "choose directory" → fill the absolute path in the native dialog → **read the displayed value back**) → model (exact match plus readback, written back to `actualModel`) → design system (search filter, exact pick, readback) → design direction (prototype / document / website clone only) → type the task (trusted input plus readback containing the marker) → send (**exactly once, never resent**, bounded confirmation) → three-signal polling (stop button / conversation-text hash / artifact-file fingerprint) → terminal state.
- **Generic menu selection `menu.ts`**: the shared "trigger → expand → exact match → readback" flow used by model, design system and design direction; the `already-bound` reuse branch performs no pointless clicking, and multiple matches are refused (never guess a coordinate).
- **Input and send confirmation `send.ts`**: before sending it reads back that the input really contains this round's task marker, otherwise it does not click send; afterwards it confirms within bounds using three pieces of evidence (user message landed / running signal / input cleared) and reports only `send_unknown` when nothing is confirmed — **never resending**.
- **Per-step budget `recovery.ts`**: mirrors `kimicode/recovery.ts`; `remaining(cap)` takes the minimum of the step cap, the task deadline and the setup budget, so retries never reset the budget.
- **Acceptance → automatic rework → re-acceptance is wired** (`src/loop/fix-loop.ts`): when an opendesign verification fails, a plan is written **inside the project root** at `.opendesign/plans/opendesign-fix-r<N>.md` (Open Design can only read files inside its working-directory allowlist; writing into the task data directory produces "I told you to read the plan, you say it's unreachable"), and "failure summary + plan relative path + visual-diff evidence" is sent as an in-session rework instruction; rounds are capped by `autoFixRounds`.
- **`continue_task` / `rework_task` now support opendesign** (`src/tasks/task-manager.ts`, `src/mcp/context.ts`): `agent_question` answers are sent into the **current** conversation (the adapter confirms the conversation-page anchor before sending, otherwise `session_lost`); `user_confirmation` only reconnects to observe and **sends nothing**; environment-class recovery re-dispatches from scratch with the full task text; manual rework requires an existing verification report (otherwise sending is refused).
- **Usability close-out for the send stage and drift diagnostics** (plan §5): when the send button cannot be clicked uniquely it is **retried once** before hard-failing (the button may just have become enabled), and the input read-back is **re-read once** because a controlled editor can lag one tick behind `insertText`; the `selector_drift` diagnostic now also carries a **visible page-text snippet** (truncated to 300 chars), so "which key is missing" and "what the page actually rendered" arrive together and directly support fixing selectors.
- **The probe now uses the same transport as the adapter** (`cdp` / `anchors` in `scripts/probe-opendesign.mjs`): the previous client only used HTTP `/json` and wedges on the real machine; a probe/adapter mismatch would let real-machine capture draw a misleading conclusion ("the probe cannot read it" taken as "the adapter cannot either"). Both now go through `OpenDesignTransport` (the `/json` → browser-level WS two-path design).
- **The probe gains `--save` for real-machine evidence** (`scripts/probe-opendesign.mjs`): it writes the whole run into `docs/opendesign-evidence/` with a timestamped filename, **success or failure** — a failed capture is itself evidence. The directory ships a **bilingual README** covering the capture command, which table to fill, the naming convention, and the "hot-override first, edit source later" order. Once the real-machine unlock happens, a single command produces the evidence the plan's §3.7 requires.
- **New `endReason` values**: `version_mismatch`, `selector_drift`, `model_unavailable`, `model_mismatch`, `design_system_mismatch`, `input_mismatch`, `send_unknown`, `session_lost`, `reply_stable`, `idle_timeout`, `task_timeout`, `aborted`, `setup_failed`.
- **Artifact retrieval (`artifact.ts`, so visual acceptance actually gets something)**: Open Design's designs are **not** written into the task directory; they live in its own artifact store at `<dataRoot>/projects/<projectId>/<entry>` (`dataRoot` = `%APPDATA%\Open Design\namespaces\<namespace>\data`, `projectId` comes from the artifact URL `od://app/projects/<id>/...`, and `entry`/`status` come from `<entry>.artifact.json` in the same directory). The new `fetchArtifactFromStore()` copies it into the task directory once the task reaches a terminal state, after which `visual.ts` can derive a static entry point. **Measured on the real machine (2026-09-28)**: `onboarding-guide.html` (37,838 bytes, self-contained) landed in `D:\Trae项目\AI游戏\test\`, and visual acceptance resolved the `/onboarding-guide.html` entry. Retrieval is an **additive step**: failure is only recorded in `progressSummary` and **never changes the terminal state** (a recoverable product-side problem must not be reported as an adapter failure).
- **`visual.ts` gains a "single root-level html" fallback**: the allow-list (`index.html`/`main.html`/…) cannot recognise the names the product gives its artifacts, so "retrieval succeeded but visual acceptance still says no entry was found" happened. Now, when the allow-list matches nothing and there is **exactly one** html at the project root, it is accepted; multiple html files are still never guessed (preserving the original "don't treat arbitrary html as an entry" intent), and nested html is excluded too — those are usually examples/templates.
- **Event-stream reporting completed (aligned with the issue #18 vocabulary)** (`src/agents/opendesign/run.ts`): beyond the existing `task_dispatched` / `file_modification_started`, opendesign now reports at **every "stuck on a human" exit** — an existing instance that cannot be adopted (`close_existing_instance`), stuck on the login/onboarding page (`login_required`), a working-directory bind failure (`system_permission` / `setup_recovery`), the stop button staying lit while conversation and artifacts are fully idle (`user_confirmation`), and a setup phase that cannot self-heal: all five report `awaiting_user_authorization`. Clearing stale native dialogs and binding the working directory through the native "select folder" dialog report `confirmation_dialog_detected`. `query_task`'s `recentEvents` can therefore tell "the agent is working normally" apart from "the agent is wedged waiting for a human".
- **New `needsUserKind` values**: `login_required`, `system_permission`, `setup_recovery`, `user_confirmation` (`close_existing_instance` is unchanged).

### Fixed

- **Reading the input text returned an object instead of a string** (`src/agents/opendesign/cdp.ts`): `inputValueExpression` yields `{found,value,length}`, but it was returned as a `string`, so the pre-send readback threw on `includes` (surfacing as `setup_failed`) and mislabelled "the text never reached the editor" as an infrastructure failure.
- **Working-directory bind failures were emitted as a non-hard `setup_failed`** (`src/agents/opendesign/run.ts`): the orchestrator treats such a result as an ordinary agent failure, so the user got neither an actionable message nor a way to resume with `continue_task`. All bind failures now become `needs_user` (`system_permission` or `setup_recovery`), matching plan decision 12 ("after one retry, hand it to the user").
- **Layout guard keys tightened** (`src/agents/opendesign/selectors.ts`): the guard keeps only the four anchors that unconditionally exist on the home page (`title / composer / inputBox / sendButton`). The working-directory, model, design-system and design-direction triggers render depending on user configuration and page shape, so their absence means "that capability is unavailable" rather than "the page structure drifted"; they are now validated **within their own steps** with precise reasons (keeping them in the guard caused large-scale false blocking).
- **CI was red on every non-Windows leg** (`src/agents/opendesign/discovery.ts` + `test/unit/opendesign-discovery.test.ts`): `platform` is an injected parameter and candidate paths are already built with the target platform (win32 backslashes), but two places still compared/read in **host** form: ① the assertions built their expected value with `path.join`, so on ubuntu/macos they could never equal the win32 path the code produces; ② the version read-back loads `<install dir>/resources/open-design-config.json`, and a win32-shaped path makes `fs.readFileSync` fail with ENOENT on a POSIX host, leaving `version` permanently empty. The expectations now join with the target platform, and `discoverOpenDesign` gained a `readFile` injection point (same rationale as the existing `statFile`); the fixture injects a read mapped onto the host path, so the assertions are now **host-platform independent**. ③ A third instance of the same theme: the integration case "version not in the verified list → `version_mismatch`" hard-coded the gate table to `win32`, while the gate is keyed by **host platform** (correct production semantics: whichever OS Open Design runs on is the one whose evidence must exist), so on ubuntu/macos the gate was "unconfigured therefore permissive" and the case could never pass. It now writes the **current host platform** into the verified list, and a complementary case pins the platform semantics ("unconfigured host platform does not block") — the gate now takes effect on all three CI legs, with the platform semantics also covered by a regression.

- **Six defects surfaced and fixed by a real-machine smoke run (2026-09-27, Windows 10 + Open Design 0.24.1)** — every unit test in the plan was green, yet none of these could show up without a real window:
  1. **CDP never became reachable** (`instance.ts` / `builtin.ts`): `--remote-debugging-port=<fixed>` is bound and held by the **windowless launcher process**, so the real window process fails to bind — `/json/version` answers while `/json/list` stays `[]` (not a single page target), and the adapter times out after 90s claiming the main thread may be stuck in startup. Switched to `--remote-debugging-port=0` (each process gets its own random port) and located the window-bearing one via **`DevToolsActivePort`**; the real machine now attaches in **4 seconds**.
  2. **The readiness predicate had a stale copy in `instance.ts`**: `isProductPage` existed twice, and the `instance.ts` copy lacked the `^od://` rule while the real page is exactly `title=OpenDesign` (**no space**) + `url=od://app/` — neither rule matched, so a perfectly good CDP was judged "not ready". There is now a **single source in `cdp.ts`**, tolerating the title with or without the space.
  3. **Main-window ranking picked the same-titled helper page**: the product also opens `od://app/desktop-pet` (a desktop pet with no business controls) whose title is also `OpenDesign`, so ranking degraded to "whoever returns first". Helper pages are now ranked last, stably in both list orders.
  4. **The selector-candidate union counted fallback hits as primary hits**: `__opendesignResolve` **accumulated** hits across candidates, so on the real machine `modelTrigger`'s primary (`inline-model-switcher-chip`, a button) and fallback (`inline-model-switcher`, the wrapping div) each matched a *different* element → union 2 → "multiple matches, refusing to click", stalling the chain at "confirm model". It now **stops at the first candidate that matches** (primary first, fallback only when primary is empty).
  5. **Workspace read-back did not know the real UI shape**: after a successful bind the trigger shows only the **leaf directory name** (`test`) while the predicate demanded the full path. Added a tier: "leaf matches **and** the product's own sidecar (`app-config.recentLinkedDirs`) contains the target" — a leaf match alone is far too loose (`D:\a\test` vs `D:\b\test`), so **without the sidecar it is still rejected**.
  6. **Per-step and overall budgets were inherited from ZCode and too small in reality**: `setupRecoveryTimeoutMs` defaults to 120s, yet the real machine spends **77s on "launch + connect to main window" alone**, so binding plus three menus inevitably throws `setup_recovery` midway; the `15s+20s` bind cap gets cut into `operation_timeout`. Both are **budget shortfalls** that read as "the environment is broken". Raised to 300s and `30s+60s` respectively.

  **Hardening in the same round (only to make failures actionable — no gate was relaxed)**:
  - Native "select folder" dialog: writing `WM_SETTEXT` alone does not make the app accept the directory (on the real machine the edit box held the right path, the OK button was enabled, the dialog closed normally — and the app still kept the old directory), so Enter navigation and the official `BFFM_SETSELECTIONW` are now sent as well. **Neither made the app accept on this machine's 0.24.1, and the code says so** — the final judgment remains the workspace read-back, and a mismatch still becomes `needs_user` (resumable via `continue_task`).
  - Dialog ambiguity (several `#32770` under the same owner) now first tries to disambiguate by the `id=1152` edit control; if still ambiguous, every candidate's hwnd/title is written into the error (it used to say only "there are several", leaving nobody able to act).
  - Stage logs added across the bind flow (panel expanded / "choose directory" present / native dialog steps) so slow-environment triage no longer requires guessing.

### Tests

- **63** new cases (6 new files plus an expansion of `opendesign-discovery.test.ts`):
  - `test/unit/opendesign-discovery.test.ts` (30 → **33**): new **port-avoidance** cases — when the base port is taken the picker advances within the range and takes the first free port; when the whole range is unavailable it hard-fails and **echoes the tried range**; with auto-avoidance off it only accepts the base port (busy → hard failure echoing the port number). To make that testable, port selection was extracted into an injectable `pickOpenDesignPort` (pinning this plan §5 failure mode without occupying ports or launching processes).
  - `test/integration/opendesign-flow.test.ts` (14 → **18**): the full chain over a fake CDP (bind directory → pick model / design system / direction → send → poll to completion) plus fourteen fail-closed / boundary paths (invalid direction rejected at the entry point, no `projectPath` skipping directory binding and visual acceptance with the terminal message stating so, `user_confirmation` recovery reconnecting to observe and **sending nothing at all**, model miss echoing candidates, version mismatch, an unconfigured host platform not blocking, layout drift including the page-text snippet diagnostic, an existing instance that cannot be adopted, an unconfirmable send that is never resent, `session_lost` when the conversation page is missing during a rework round, clearing stale native dialogs, the input box missing on the login/onboarding page, the stop button staying lit while everything is idle, and a setup phase that cannot self-heal), asserting the event stream (`task_dispatched` / `file_modification_started` / `awaiting_user_authorization` / `confirmation_dialog_detected`) and that `guiStop` is reported truthfully.
  - `test/integration/opendesign-rework-loop.test.ts` (5, **Windows-only**: `resolveProfile` applies a platform gate to `opendesign-gui` and refuses dispatch on any non-win32 host — a product rule, so the orchestrator-level rework loop is only verified where dispatch is actually allowed): the plan lands in the **project root** and the rework prompt carries only a **relative path**; the plan includes the visual-diff table and the "targeted fixes only" requirement; the round cap turns into `needs_attention` with per-round plans that never overwrite history; manual rework is fail-closed without a verification report; with a report, the user's extra requirement is merged into the prompt.
  - `test/unit/opendesign-menu.test.ts` (8): the reuse branch, non-unique trigger, menu never appears, duplicate names, miss echoing candidates, clicked-but-readback-mismatch, the search-filter path, and readback polling.
  - `test/unit/opendesign-send.test.ts` (8): the confirmation truth table (clearing alone does not count as success), `input_mismatch`, the one-tick-late editor re-read, the retry when the send button is unavailable on the first attempt, permanent unavailability (two attempts including the retry), and `send_unknown` (click count stays exactly 1).
  - `test/unit/opendesign-transport.test.ts` (7): the fast / slow / both-fail target-enumeration paths, session routing (page-level commands carry `sessionId`, `Target.*` does not), and an explicit error when not connected.
  - `test/unit/opendesign-recovery.test.ts` (14): `remaining(cap)` taking the minimum of three deadlines, the setup budget no longer applying after binding, `setup_recovery` / `task_timeout` / `aborted` staying distinct, `run()` honouring its cap and aborting immediately, `setStage` writing the stage into the error, and the transient/permission error classifiers.
- Shared test harness extended (`test/fake-cdp.ts`): a new Open Design page stub (`od:*` marker dispatch, in-memory state, coordinate-click interpretation) that resolves semantic keys from the registry itself, so selector drift breaks the stub rather than letting it "pretend it still works".
- None of the cases require Open Design to be installed, and none touch the network (injection and temp directories only).

### Real-machine evidence

- Version: Open Design 0.24.1 (the `appVersion` in `resources/open-design-config.json`), namespace `release-stable-win`; Windows 10 19045.
- Newly discovered and documented: browser-level `/json/version` works while `/json` hangs → the two-path transport above.
- Still outstanding: the **actual all-anchor hit list** from `scripts/probe-opendesign.mjs` must be captured on a networked terminal where Open Design can start normally, and filled into the evidence table in `docs/opendesign-cdp.md` §4 (inside this sandbox the app's main thread stalls during startup, so real DOM collection cannot complete).

### Docs

- [docs/opendesign-cdp.md](docs/opendesign-cdp.md) / [.en.md](docs/opendesign-cdp.en.md): selector evidence sources and the evidence table, the two-path transport conclusion, and a completed failure-code table.
- ARCHITECTURE / README / agent-profiles / adapter-matrix / SKILL / usage-examples (both languages): the status moves from "in development" to "wired", and the new `endReason` / `needsUserKind` values are added.
- Versions: `package.json` and `src/version.generated.ts` are synced to `0.7.1` (per the `+0.0.1` rule); tag `v0.7.1` pushed and published to npm.

## [0.1.0] — 2026-09-29 — mcp-gui independent line

> This is the **first stable release** of the GUI's independent version line (going stable + update log panel).
> The MCP package's runtime logic (tool contracts, task model, acceptance engine and all of `src/**`) is
> **unchanged**, and the package version stays at `0.7.4`; the GUI evolves independently with its own version
> numbers and its own tags (`gui-v*`).
>
> **Three categories of change relative to `0.1.0-beta.9`**:
>
> 1. **New update log panel**: a dedicated desktop update window ("Update log") that pops up automatically when the
>    silent startup check finds a new version that has not been ignored. It offers `Download and install` /
>    `Ignore this version` / `Later`. "Ignore this version" suppresses the **automatic** prompt only (a manual
>    "Check for updates" still shows that version, a higher version re-prompts, and the record is persisted in app
>    preferences). The window states **which source will be used** (the result of concurrently probing Gitee /
>    GitHub and picking by latency, with an explicit degradation notice when neither is reachable). Its body is the
>    **bilingual release note** for that version (composed from `docs/release-gui-v<version>.md` + `.en.md`, rendered
>    as Markdown with inline HTML disabled). The window size follows the maintainer's annotation:
>    `min(1070px,92vw)` × `min(750px,88vh)`. Adds `mcp-gui/src/core/version.ts` (version comparison and ignore
>    decisions, 16 unit tests) and `mcp-gui/src/components/UpdateDialog.vue`; `Preferences` gains
>    `ignored_update_version` (with a serde default so an old preferences file is not reset wholesale).
> 2. **Release pipeline now supports stable releases**: the tag filter in `.github/workflows/gui.yml` widens from
>    `gui-v*-beta.*` to **`gui-v*`**, so stable and preview builds share one pipeline; a new step decides the
>    pre-release flag from the tag shape (only tags containing `-beta.` / `-rc.` pass `--prerelease`); a new
>    `scripts/gui-release-body.mjs` composes the bilingual release body (used via `--notes-file` on GitHub and
>    `--body-file` on Gitee, so both sides are **byte-identical in content**, and a missing doc **exits non-zero**).
> 3. **Version and wording go stable**: the GUI version is unified to `0.1.0` in all four places
>    (`package.json` / `package-lock.json` / `tauri.conf.json` / `Cargo.toml`); the UI label
>    "Beta channel (pre-release)" becomes "Stable channel / 正式版通道"; and every hard-coded "beta" wording in
>    `gitee-gui-release.mjs` and `gui.yml` is removed.
> (`0.1.0-beta.N`) and its own tag (`gui-v*`).

### Added

- **Log viewer GUI (`mcp-gui/`, Tauri 2.x + Vue 3, independent version `0.1.0-beta.1`)** (issue #25): a **fully decoupled**, read-only local desktop app (filesystem only, **no server needed**) that unifies the four log types and task artifacts in one UI.
  - **Data home**: auto-detected via `TIANSHU_MCP_HOME` → `~/.tianshu-mcp`, with manual add / remove / switch across multiple directories (an added directory must contain `logs/` or `tasks/`).
  - **Two-state UI (layout paradigm)**: a **task overview page** (top bar + four-cell metrics strip (total / active / finished / failed) + status chips + `[Filter]` popover + task card grid + search mode) and a **full-page workspace** (breadcrumb `‹ Tasks / <taskId>` + expandable task summary bar + vertical section nav + content, with `server.log` as the second form). **No permanent task rail, no permanent detail column, no horizontal tab row.**
  - **Four log types**: `server.log` (level and time-range filtering + keyword highlighting); `task.jsonl` (**separating state transitions from fine-grained agent events**; `note` stays the progress/audit channel; unparsable lines are skipped but counted); `agent-<round>.log` and `verify-<round>.log` (round switching, line numbers, word wrap); `report-<round>.{md,json,html}` and `dry-run-report-*` (Markdown rendering / structured cards / **sandbox iframe visual preview** with injected CSP and stripped `<script>` / dry-run shown separately / cross-round comparison).
  - **Large logs and live tail**: first screen reads only a 64 KiB tail window plus on-demand earlier chunks with "loaded N / total M"; `notify`-driven incremental refresh, **scrolling up pauses follow automatically**, one-click "Jump to latest".
  - **Cross-task search / export / copy**: on-demand scanning (**no local full-text index**) with progress and cancellation; single-file export plus whole-task zip (optionally excluding heavy raw logs, reporting the excluded count).
  - **Experience**: Chinese and English (Chinese by default) plus system / light / dark theme (system by default).
  - **Layout paradigm rewrite + Obsidian Terminal (independent GUI version `0.1.0-beta.3`)**: the old "top bar + three side-by-side panes + horizontal tabs" skeleton was thrown out and redrawn — **cross-task search moved onto the overview page** (a hit jumps straight into the matching workspace section), **task metadata became an expandable summary bar** (no longer its own column), and `server.log` became the **workspace's second form**. The visual language is the in-house **Obsidian Terminal**: dark by default (obsidian `#0B0D0C` with fluorescent-green `#3DFFA0`), a light counterpart rebuilt in the same language, **monospace-led**, **bracketed status labels** (`[OK] 已成功`), a 3px status rail plus a `›` prefix on task cards, a 1px fluorescent rule along the top of the top bar and breadcrumb bar, 4px hard panel radii, a faint dot grid on dark and a faint grid on light (**the blue→purple gradient and purple info tone are gone**). The accent is reserved for selection / primary actions / focus / the breadcrumb back affordance, while status positions use semantic tones only. **Functionality, the data layer, and store APIs are unchanged**; i18n gained only 4 keys (both languages). New `OverviewPage` / `WorkspacePage` / `TaskCard` / `MetricsStrip` / `TaskSummaryBar`; `TaskListPanel.vue` and `DetailPanel.vue` were deleted (no duplicated implementations, no dead code)
- **System tray + "Close window" behaviour (GUI independent version `0.1.0-beta.5`)**: adds an always-present system tray icon (reusing the app icon — **no new icon asset**). A **right-click** menu exposes `Show Logs` / `Exit Logs` whose **labels follow the UI language immediately** (no restart), and **left-click** shows and focuses the window. **Closing the window defaults to minimizing to the tray instead of quitting**; Settings gains a "Close window" choice (`Minimize to tray` by default / `Exit app`), with 4 new copy keys added to both language bundles. The tray is created on the Rust side (new `src-tauri/src/tray.rs`, enabling the existing `tauri` `tray-icon` feature — **no new dependency**, **no frontend permission**); a language change rebuilds the menu from `set_preferences` via `run_on_main_thread`; `Preferences.close_action` carries a serde default (**so an old preferences file is never reset wholesale for a missing field**); macOS additionally handles `RunEvent::Reopen` (clicking the Dock icon reveals the window); a failed tray creation does not block startup.
- **Permanent left sidebar (GUI independent version `0.1.0-beta.6`)**: carries the "top bar → sidebar" move through — the overview page's old top bar (brand / data home / global search / refresh / server log / settings) and the workspace's **vertical section nav** are merged into **one permanent left sidebar** (brand → global search → main nav (Tasks / Server log) → task section nav → data home → refresh / settings), with the content area switching between "task overview" and "full-page workspace". **A second left column no longer exists anywhere**; the breadcrumb and task summary bar stay at the top of the content area. The `server.log` form is now derived from `app.tab` (the `workspaceMode` state flag is gone), the task section nav shrinks from 5 items to 4 (the global "Server log" moves up to the main nav), and the overview's search mode is hoisted to the shell (focusing the sidebar search box enters it). Layout constants gain `--rail-w: 208px` and `--rail-glow` (the old top-bar glow rotated to vertical); `--nav-w` / `--topbar-glow` and `.topbar` / `.split` / `.sidenav` are removed. The visual signature moves from "a fluorescent rule along the top of the top bar" to "**a fluorescent rule along the left edge of the sidebar**", and the overview's metrics strip gains the content-area top rule. **Functionality, the data layer, and store APIs are unchanged**; i18n gains 2 keys (`nav.primary` / `nav.sections`, both languages)
- **Dual-source (Gitee / GitHub) auto-update**: **actual probing instead of system region** (both endpoints are probed concurrently and ranked by latency, which is correct behind a VPN) + TTL cache + a three-state switch (Auto / Force Gitee / Force GitHub) + fallback to the last known good source when both are unreachable; both manifests share the same version and signature, and `tauri-plugin-updater` **always rejects a failed signature**. Any failure only affects updating and **never blocks log viewing** (a "Manual download" entry is provided). The Windows payload is NSIS (the Tauri updater does not support MSI).
- **Standalone `GUI` workflow** (`.github/workflows/gui.yml`): a `windows-latest` / `macos-15-intel` / `macos-15` matrix; pushes to `master` only compile-verify and upload artifacts, while a `gui-v*-beta.*` tag publishes pre-releases to both hosts. `gui-v*` **does not start with `v`** and therefore **never triggers** the MCP `release.yml` (an explicit assertion covers this).
- **Three-way vocabulary parity gate**: `mcp-gui/scripts/check-schema-parity.mjs` compares the **TS truth (`src/tasks/task.ts` / `src/agents/agent-events.ts`) ↔ frontend mirror ↔ Rust mirror** and fails on any drift; the `GUI` workflow also triggers on the two truth files, so TS-side drift is caught too.
- **`scripts/gitee-gui-release.mjs`**: Gitee-side GUI pre-release + **installer attachment upload** + update-manifest writing (the existing package script creates releases and bodies but has no attachment upload).
- **External-open capability wired up (GUI independent version `0.1.0-beta.7`)**: adds the official `tauri-plugin-opener` (a new Rust dependency registered in `lib.rs` alongside dialog / updater), and the frontend reaches it **only through the `src/api` exit point** (`GuiApi.openExternal`: the Tauri implementation calls `openUrl()`, the mock implementation calls `window.open(…, "noopener,noreferrer")`); `capabilities/default.json` uses `opener:allow-open-url` **with an `allow` list** covering **only `https://github.com/**` and `https://gitee.com/**`**, granting no plugin capability wholesale.
- **Sidebar structure tweak (GUI independent version `0.1.0-beta.7`)**: the **settings (gear) entry moves from the sidebar footer into the main nav, just below "Server log"** (from an icon button to a nav item matching its neighbours, lit while the panel is open), leaving only the data home and "Refresh" at the bottom of the sidebar; the spacer element that existed only to push that button is removed too. The **decorative brand square is deleted** (`.mark` in `App.vue` and its rule in `styles.css` are removed entirely — no references remain anywhere). **No new i18n keys** (the existing `settings.title` is reused) and `src/core/**` is untouched.
- **"Succeeded" added to the metrics strip + data home moved up + settings becomes a centred modal (GUI independent version `0.1.0-beta.8`)**: (1) the overview metrics strip grows from 4 to **5 cells** (total / active / finished / **succeeded** / failed), with the succeeded reading using the semantic `tone-ok` colour and reusing the existing `status.succeeded` label (**no new copy keys**); (2) the **data home moves from the sidebar footer up into the nav, directly after "Settings"** (a `border-top` on `.rail-nav > .rail-block` groups it), leaving only "Refresh" at the bottom; (3) **Settings changes from a right-edge full-height drawer to a centred modal** (`.poverlay` becomes a centred flex overlay; `.panel` becomes a fixed-width 460px / `max-width: 92vw` / `max-height: 86vh` rounded card; `.panel-body` gains `min-height: 0` for internal scrolling; the entrance animation reuses `rise` and the old `slide-in` is deleted; overlay-click closing is unchanged). **No new i18n keys**, and `src/core/**` / `src/api/**` are untouched.
- **"Refresh" moved into the data-home row (GUI independent version `0.1.0-beta.9`)**: the orphaned refresh button at the bottom of the sidebar moves into the **"Data home" heading row** (`DataHomeBar.vue`'s `.rail-block-head`), alongside the existing "Add directory / Remove" icon buttons (order: `refresh / add / remove`); **nothing permanent remains at the bottom of the sidebar** — `.rail-foot` now renders the "local preview" notice **only under the mock runtime**, so in real builds the whole footer disappears instead of leaving an empty bordered strip, and `.rail-row` is deleted for having no remaining users. Refresh stays a **global action** (available in both content states), which is why it did not go into the content toolbar. **No new i18n keys** (the existing `common.refresh` is reused).

### Fixed

- **The update window's body was a single title line (GUI independent version `0.1.1-beta.1`, found on a real machine; manifests backfilled for that version, no version bump)**: the desktop "update notes" window renders the body from the **update manifest's `notes`** (`update.body` in `updater.rs`), but the release chain only passed the placeholder title `--notes "Tianshu-mcp 日志台 $VER"` when composing the manifest — the full bilingual body composed by `scripts/gui-release-body.mjs` was used for the GitHub / Gitee release pages (`--notes-file` / `--body-file`) yet was **never handed to the manifest builder**; the Gitee manifest reuses the same `latest.json` (`gitee-gui-release.mjs --github-manifest`), so **both** sources degraded to a one-line title. Fix: the manifest step in `gui.yml` now passes `--notes-file "${{ steps.meta.outputs.body }}"`, making the manifest `notes` and the release-page body **one and the same source**; `build-updater-manifest.mjs` gains `resolveNotes()` — `--notes-file` wins, a **read failure exits non-zero** (fail-closed, no silent degradation), and only an empty file falls back to `--notes` with a warning. The already-published `update/gui/latest.json` / `latest-gitee.json` had their `notes` backfilled with the full bilingual body (`version` / `pub_date` / `platforms` untouched); a new `test/unit/gui-updater-manifest.test.ts` (5 cases) covers the resolution.
- **Clicking "Manual download" did nothing at all (GUI independent version `0.1.0-beta.7`)**: the entry was an `<a href target="_blank">`, and **Tauri 2's webview intercepts new-window requests**; no external-open capability was wired up (no opener / shell plugin and no `on_new_window` handler), so the request was **silently dropped** — the click appeared to do nothing. It is now a `<button>` that goes through `GuiApi.openExternal` → `openUrl()` and opens in the **system default browser**; failures flow through the existing `setError` and never block log viewing.
- **"Manual download" did not jump to the matching update source (GUI independent version `0.1.0-beta.7`)**: the Rust-side fallback URL was a **single constant, `MANUAL_DOWNLOAD_URL`, always pointing at GitHub releases**, decoupled from the source actually used; with "Force Gitee" selected or Gitee winning the probe, the fallback still pointed at GitHub (which means it is still unusable on mainland-China networks). It is now split into `MANUAL_DOWNLOAD_URL_GITHUB` / `MANUAL_DOWNLOAD_URL_GITEE` and resolved by `manual_download_url_for(&chosen)` from `resolve_source()`'s result (**unknown sources always fall back to GitHub**); all four return branches of `check_update` use that function, and the frontend `mock`'s `checkUpdate(source)` mirrors the same semantics.
- **A manual `GUI` workflow run could be silently skipped**: `workflow_dispatch` carries no `github.event.before`, so the change detection degraded to `git diff HEAD~1 HEAD`; when the last two commits touched only docs, the whole three-platform matrix was **skipped** (the run reported Success while doing nothing). Now a manual run **always builds**, tags always build, and only push / PR go through diff filtering.
- **The previous version no longer disappears after an update: two entries stayed in Apps & features (independent GUI version `0.1.0-beta.4`, found during real-machine acceptance)**: Tauri's NSIS template builds the uninstall registry key directly from `bundle.productName` (`…\CurrentVersion\Uninstall\${PRODUCTNAME}`), and between `0.1.0-beta.1` and `0.1.0-beta.2` productName was changed from the space-containing `Tianshu-mcp Logs` to the space-free `Tianshu-mcp-Logs` to fix the cross-host asset-name mismatch — so the key changed too, and the new installer stopped treating the old installation as the same app. The old version (0.1.0-beta.1, installed at `D:\Tianshu-mcp Logs` on the test machine) was therefore **neither overwritten nor uninstalled**: it survived in the list while its directory and shortcuts stayed on disk (Tauri only handles `mainBinaryName` changes, never productName changes). Fix: a new `mcp-gui/src-tauri/windows/installer-hooks.nsh`, wired through `bundle.windows.nsis.installerHooks`, detects a legacy-named uninstall entry in `NSIS_HOOK_PREINSTALL` → **silently runs that entry's own uninstaller (`/S`)** → then removes any leftover registry keys and shortcuts. It only acts when a legacy entry exists, so **fresh installs and updates within the current name are unaffected**, a silent uninstall **never deletes user data**, and the old `$INSTDIR` is never deleted recursively (the old install location was user-chosen). `bundle.productName` is now treated as a **frozen contract** (see `ARCHITECTURE` §16.4).

### Tests

- `mcp-gui` adds **81 frontend cases** (8 files: log-line parsing / event parsing / bytes and windows / filtering and sorting / report summaries / i18n completeness / sandbox / mock data exit); locally `vue-tsc --noEmit` / `eslint . --max-warnings 0` / `vitest` / `vite build` are all green (Node only; per issue #25, **no Rust-side build or check runs locally**).
- **`0.1.0-beta.7` adds 1 more frontend case** (`test/mock.test.ts`: "the manual-download fallback entry follows the update source actually used" — `checkUpdate("gitee")` must return the Gitee release page), taking the count from **81 to 82**, all 8 files green; the Rust side gains the `manual_download_url_follows_source` unit test (covering the gitee / github / unknown-source branches).
- **`0.1.0-beta.7`'s CI and release both passed (2026-09-28)**: on the first push, `Rust format / clippy / tests` failed **within 1–2 seconds on all three platforms** (of that step's three commands only the fastest, `cargo fmt --check`, can fail that fast) — the root cause was the new `&chosen` argument pushing three `match` arms past the width limit (rustfmt demands the block form `Err(e) => { return ... }`), the alphabetical order of the new import items (`_GITEE` before `_GITHUB`) and one `assert_eq!` line break. Fixed by running `cargo fmt` with the local rustfmt (same version as CI stable). `GUI` run #61 is fully green (three-platform Rust gates + packaging + artifact upload), and the tag `gui-v0.1.0-beta.7` run #62 published successfully: GitHub and Gitee pre-releases are both created (8 assets on the GitHub side) and both update manifests are at `0.1.0-beta.7`. **This machine has no MSVC `link.exe`, so `cargo clippy` / `cargo test` can only run in CI.**
- **`0.1.0-beta.8` is a pure UI adjustment**: the frontend case count is unchanged (**82 passed**, 8 files, no new i18n keys) and `check:schema` / `typecheck` / `lint` / `test` / `build` are all green; the headless-Edge probe passes **12/12** (5 metrics cells with the expected order, the "succeeded" reading with `tone-ok`, the data home inside `.rail-nav` directly after "Settings", only "Refresh" at the bottom, **panel centre = window centre 720.0 at 1440×900**, no edge contact, 4px radius, centred overlay, height-capped internal scroll, no `pageerror`).
- **`0.1.0-beta.9` is a pure UI adjustment**: the frontend case count is unchanged (**82 passed**, 8 files, no new i18n keys) and `check:schema` / `typecheck` / `lint` / `test` / `build` are all green; the headless-Edge probe passes **7/7** (the data-home row's icons are `refresh / add / remove` with all three tops aligned, no refresh button left at the bottom, the mock notice still present, clicking refresh raises no error, no `pageerror`).
- MCP package full suite: **1270 passed / 12 skipped**; `typecheck` / `lint` / `build` / `check:stdio` / `pack:check` all green.
- GUI Rust gates (`cargo fmt --check` / `cargo clippy -D warnings` / `cargo test`) and the three-platform packaging run in the `GUI` workflow.
- **⚠️ A pre-existing red light unrelated to this round**: the MCP package `ci.yml` has been red since `#285` (the open-design smoke-fix commit), with `#286`–`#288` failing continuously, concentrated in the 6 `Build & Test` jobs on ubuntu / macos (windows and all `Visual browser` jobs pass); this round touched only `mcp-gui/**` and `gui.yml`, so it shares no causal link with that red light.

### Documentation

- New `docs/gui-log-viewer.md` / `.en.md` (installation, data homes, the four log types, search/export, dual-source updating and recovery, local development vs. CI build boundary) and `docs/issue-25-gui-real-machine-record.md`.
- `README` / `ARCHITECTURE` / `HANDOFF` / `CHANGELOG` updated in both languages; ARCHITECTURE gained "Section 16: the second delivery surface — log viewer GUI".
- The root `package.json` `files` allowlist now includes the two GUI docs (the npm package does **not** contain `mcp-gui/`).
- **`0.1.0-beta.7` documentation additions**: ARCHITECTURE (both languages) gains "§16.8 External-open capability and URL allow-list contract" and records the source-following fallback URL, the sidebar settings entry and the decorative-square removal in §16.3 / §16.4 / §16.6; `docs/gui-log-viewer` (both languages) documents the sidebar composition and the "Manual download" behaviour (allow-list plus system-browser opening).

---

## [0.7.0] - 2026-09-26

> **Version numbering correction**: per `AGENTS.md` (`加满0.0.10下个版本将+0.1.0` — the 10th patch increment rolls over), the increment after `0.6.9` must be `0.7.0`. Three intermediate numbers (`0.6.10`/`0.6.11`/`0.6.12`) were pushed to `master` during development but were never tagged or published to npm, so they are consolidated into this single `0.7.0` entry.

### Added

- **Open Design working-directory binding orchestration** (`src/agents/opendesign/workspace.ts`, plan phase P2 flow): skip when already bound (no pointless clicks, no touching the user's existing binding) → expand "Working directory" → click "Select directory" → native dialog → **read the UI value back to verify**; `normalizeWorkspacePath` / `workspaceMatches` (case/slash normalisation plus prefix matching for UI-truncated ellipsis values). **Success is judged by a matching read-back, not by the dialog closing** — when they disagree the result is reported truthfully as a `readback` failure and never treated as success.
- **Open Design native "Select Folder" dialog automation** (`src/agents/opendesign/dialog.ts`, the selector-independent part of plan phase P2): `toNativeDialogPath` (**absolutise** + upper-case drive + backslashes), `listOwnedDialogs` (enumerate visible `#32770` windows owned by the target process), `closeStrayDialogs` (close only stray modals of our own pids), `selectOpenDesignFolder` (**two routes**: `WM_SETTEXT` first, keyboard input as fallback; both require a **matching read-back**, and success requires the dialog to **actually close**). Safety boundary: only operate on windows that are "newly appeared + owned by the target process + class `#32770` + visible + **unique**", the baseline is sampled before clicking, multiple new dialogs abort, and paths enter the script only via environment variables.
- **Open Design run detection (three signals)** (`src/agents/opendesign/liveness.ts`, the core of plan phase P5): stop-button visibility + conversation-text hash + **artifact mtime/size fingerprint**; the pure function `judgeOpenDesignPoll` decides in the order run signal → failure state → question → needs_user (stop button lit long with everything static) → overall deadline timeout → idle_timeout → finished. **The artifact signal is this adapter's key difference**: Open Design writes files continuously while not refreshing the conversation for long stretches, and text-only judging would call that normal work "idle and finished".
- **Open Design repair/optimisation plan document** (`src/agents/opendesign/fixplan.ts`, the core of plan phase P6): written to the **project root** `.opendesign/plans/opendesign-fix-r<N>.md` (per-round, never overwritten), containing failed items, a **visual acceptance difference table** (target / viewport / verdict / diff ratio / artifact path plus per-item failure reasons), passed items, skipped items, code analysis and repair requirements; `buildOpenDesignFixPrompt` assembles a repair prompt with "what failed + the plan document's relative path + evidence".
- **Open Design visual-acceptance page-source derivation** (`src/agents/opendesign/visual.ts`, plan phase P6): `findStaticEntries` (breadth-first with a depth limit of 3, skipping noise such as `node_modules`/`.tianshu-mcp`, ordered by entry filename and depth), `hasPreviewableProject`, `suggestVisualPages` (static entry first, then project structure; when neither holds it returns `configured:false` with an actionable hint). **It only derives, never writes**: `.tianshu-mcp/acceptance.json` is never modified automatically — keeping acceptance configuration explicit is an established principle of this repository, and silently adding a config would turn the acceptance criteria into hidden state. It also never hard-codes `/index.html` when derivation fails.
- After taking over an instance, `run.ts` first **closes stray `#32770` windows owned by that instance's pids**: a modal swallows the main window's synthetic clicks, and leaving it in place makes the next round misread "clicking Select directory does nothing" as selector drift. It also records the visual page-source suggestion before the gates (diagnostic only, never blocking).

### Fixed

- **`gui.selectors` overrides are now authoritative** (`cssCandidates`): the original implementation **merged** an override with the built-in fallbacks, which contain broad semantic candidates such as `[aria-haspopup]`. Multiple page elements then matched, so the "unique match" criterion necessarily failed and a hot-fix selector **switched the feature off entirely** (symptom: `no-panel: trigger cannot be uniquely located`). An override is now the only candidate used.
- `toNativeDialogPath` handling of **relative and empty paths**: `path.win32.normalize("")` returns `"."`, and the original implementation fed `.` into the native dialog as a valid path (symptom: "confirming appears to do nothing"). Relative paths are now resolved against the current working directory, and empty/blank paths return an empty string so the caller fails closed.
- **Red CI: the Open Design discovery module's platform injection was not end-to-end** (`discoverOpenDesign` built candidate paths with the **host** `path.join` even though `platform` is an injected parameter). It happened to agree on Windows, so everything was green locally, but **every ubuntu / macos CI leg failed** (red continuously since `0.6.8`). Fix: candidate paths are now always built for the **target platform** (`const api = platform === "win32" ? path.win32 : path.posix`), plus a **host-independent** assertion (a win32 target must produce a path containing backslashes and no forward slashes).
- Several host-platform assumptions in the tests themselves were corrected too (these also failed on non-Windows CI legs): fixtures now use `path.win32.join` to match production; the `normalizeWorkspacePath` case assertion branches by platform (the implementation only lower-cases on win32); and on non-Windows the tests assert that `listOwnedDialogs` / `closeStrayDialogs` **never invoke `powershell.exe`** (CI has no PowerShell).
- **Four more assertions only held on Windows** (reproduced locally by faking `process.platform=linux`, which produced CI's exact failures):
  1. on POSIX `normalizeWorkspacePath` **preserves the input's case** (even the drive letter), while the assertion hard-coded lower case;
  2. `workspaceMatches("D:\\proj","d:/proj/")` is `false` on POSIX (case sensitivity is a **design requirement**) while the assertion hard-coded `true`;
  3. `selectOpenDesignFolder("")` reports `platform` on non-Windows because the platform branch runs **before** path validation;
  4. `openDesignNamespaceRoot` uses `HOME/Library/Application Support` off win32, while the assertion hard-coded `APPDATA`.
  Fix: assertions branch on `process.platform`, and the path-comparison case with CJK characters now asserts **verifiable invariants** instead of hand-typed literals (which risk look-alike characters).
- **`readInstallInfo` now picks its path implementation from the path's own style** (`pathApiFor`): a win32-style path on a POSIX host used to be resolved by `path.dirname` to `"."`, so the version could never be read. `discoverOpenDesign` also gained an **injectable `statFile` probe**, making the win32 branch's assertions host-independent — the key to letting CI's ubuntu/macos legs verify that branch at all.

### Tests

- **67** new cases: `opendesign-workspace.test.ts` ×14 (path comparison, skip-when-bound with zero clicks, the success path and **baseline sampling order**, the four failure paths of missing trigger / missing menu item / native failure / read-back mismatch, and empty read-back), `opendesign-liveness.test.ts` ×20, `opendesign-dialog-fixplan.test.ts` ×19, `opendesign-visual.test.ts` ×12 (static entry discovery with filename priority, depth limit and noise skipping, project-structure detection, and the truthful "cannot derive" path); `opendesign-dom.test.ts` gained an override-semantics regression; `opendesign-discovery.test.ts` gained two regressions for "candidate paths use the target platform's separator" and "the posix branch of a non-Windows target".
- **Cross-platform verification method**: fake `process.platform` as `linux` locally, then run `test/unit/opendesign` — all **131** Open Design cases pass; on real Windows all **131** pass as well.
- Full suite: **1270 passed / 12 skipped** (110 files); `typecheck`, `eslint src test scripts` and `build` all green.

### Documentation

- **ARCHITECTURE (both languages) now documents Open Design as the sixth GUI driver**:
  - §8.2's heading changes from "five GUI drivers" to "six", and a new Open Design execution order covers the twelve steps (environment sanitisation → stale-modal cleanup → version gate → directory binding → model/design-system/design-direction → input and send → three-signal polling → visual acceptance → repair and re-acceptance), spelling out the two real-machine traps (`ELECTRON_RUN_AS_NODE` and the launcher's "detached child" shape) and why it is the **only driver with an artifact signal**.
  - §8.3 changes from "five drivers" to "six"; §8.4 gains an Open Design `endReason` table (**truthfully noting that only six values are produced today**, with the rest following the wiring) and the `close_existing_instance` row in `needsUserKind` now includes Open Design with a note that it currently emits only that kind.
  - §8.5's registry bases go from six to seven (adding `opendesign` and `opendesign-gui`).

> The two items above are documentation changes; this same release also contains the cross-platform fixes in the Fixed and Tests sections below.

- **The Open Design adapter is now documented in every existing human-facing document**:
  - [docs/adapter-matrix.md](docs/adapter-matrix.md) / [.en.md](docs/adapter-matrix.en.md): the summary matrix gains an Open Design row (status stated truthfully as "in development: decision layer delivered, UI wiring awaits selector capture", covering discovery order, login and data directory, the two real-machine traps `ELECTRON_RUN_AS_NODE` and the "detached child" launcher shape, and why the port base is 9889), and the E1 event-reporting table gains a row; the English table header is also corrected from 5 columns back to the 7 columns the data rows already used (**pre-existing defect**: English rows were always 7 cells while the header was stale).
  - [docs/agent-profiles.md](docs/agent-profiles.md) / [.en.md](docs/agent-profiles.en.md): the field reference gains `adapter="opendesign-gui"` and the `opendesign` config block; a new "Open Design (in development)" sample profile documents the essentials (why `userDataDir` is unset, the version-gate criterion, and how `designDirection` differs semantically from `designSystem`).
  - [skills/tianshu-mcp/SKILL.md](skills/tianshu-mcp/SKILL.md): `description`/`triggers` now include opendesign; the parameter compatibility matrix gains a column (`designDirection` required, the meaning of `designSystem`, `mode` unsupported); §5's `close_existing_instance` and the `continue_task` support surface include opendesign; the `projectPath` cell is corrected (**project-less dispatch currently supports ZCode only**, which the cell previously left unstated).
  - [skills/tianshu-mcp/usage-examples.md](skills/tianshu-mcp/usage-examples.md): a new §2.8 opendesign example explaining that "dispatching currently hard-fails with `selector_drift`, which is fail-closed protection rather than a defect".
  - Bilingual README: the overview sentence's agent list mentions "the Open Design adapter is in development".

> The two items above are documentation changes; this same release also contains the cross-platform fixes in the Fixed and Tests sections below.

## [0.6.9] - 2026-09-26

### Added

- **Open Design adapter phase P1 (selector and in-page expression layer)**: new `src/agents/opendesign/selectors.ts` (a 16-key selector registry + the in-page `resolveFnSource` + the **layout guard key set**) and `dom.ts` (13 in-page expressions under the `od:` marker prefix: existence / text / single point / first point / exact match / candidate echo / count / input value / conversation text / trigger text / layout probe / menu dismiss / direction-item visibility). `run.ts`'s dispatch gate is upgraded from "not implemented" to a **layout guard**: when required selectors are uncaptured or page anchors miss, it hard-fails with `selector_drift` listing the missing keys and performs **no coordinate clicks**. See [Open Design GUI (CDP) adapter](docs/opendesign-cdp.en.md).

### Fixed

- **`ELECTRON_RUN_AS_NODE` made Open Design completely unable to start (real-machine root cause)**: `Open Design.exe` is an Electron launcher with embedded Node; when the caller carries `ELECTRON_RUN_AS_NODE=1` (the DSH harness injects it), the launcher is forced into Node mode and rejects `--remote-debugging-port` / `--headless` (`bad option:`, exit code 9), showing "no window, no new logs, no crash dump". Managed launches now **sanitise the environment** (new `OPEN_DESIGN_ENV_DENYLIST` + `sanitizedSpawnEnv()`, dropping `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` / `ELECTRON_ENABLE_LOGGING` / `ELECTRON_EXTRA_LAUNCH_ARGS`) while leaving the command line unchanged. With it cleared the launcher immediately prints `DevTools listening on ws://127.0.0.1:9889/…`.
- **The launcher's "detached child" shape was misjudged as failure**: after accepting the debug port the launcher prints `DevTools listening` and **exits with code 0 by itself**; the real Electron main process is the detached child it spawned. The first implementation treated exit code 0 as `needs_user(close_existing_instance)`, which on the real machine meant "it is clearly running yet it asks the user to close it". The announced port is now parsed from stderr (`devtoolsPortsFromOutput()`) and polling continues within the remaining budget; exit code 9 is treated as "cannot take over", and only other non-zero codes throw, with the stderr tail attached.
- **`resolveFnSource` only accepted array specs**: `specArgs()` emits a JSON string, which was passed to `querySelectorAll` as a CSS candidate → **always zero matches** (silent failure). Both shapes are now supported, plus an `__odSpecError` sentinel so a malformed expression reports `count=-1` instead of masquerading as "the page has no such element".

### Changed

- Managed launches now collect the **stderr tail** (new `guiInstanceDiagSpawnOptions()`, bounded 4 KB buffer). The original `guiInstanceSpawnOptions()` (all-ignored stdio) is unchanged and still serves the other GUI agents.

### Tests

- **23** new cases (`test/unit/opendesign-dom.test.ts`): registry invariants (fallbacks must not be broad containers, the layout guard excludes runtime-only keys), `missingSelectorKeys` fail-closed behaviour and override hot-fix, the `specArgs` six-tuple contract, and execution of every in-page expression against a **real linkedom DOM** (existence/visibility, single-point uniqueness, exact match with no fuzzy fallback, candidate echo, malformed-candidate tolerance, layout probe `count=0`/`-1`, exact direction-item matching, Escape dismissal).
- `opendesign-discovery.test.ts` grew to **28** cases: environment sanitisation (including "does not modify the caller's `process.env`") and debug-port announcement parsing (IPv4/localhost/IPv6, dedupe with order preserved, noise not misparsed).
- Full suite: **1202 passed / 12 skipped** (106 files); `typecheck`, `eslint src test scripts` and `build` all green.

## [0.6.8] - 2026-09-26

### Added

- **Open Design GUI adapter (phase P0: install discovery / instance takeover / CDP probing)**: a new built-in agent `opendesign` (`driver=gui`, `adapter=opendesign-gui`) brings the Open Design desktop client (Electron, measured 0.24.1) into tianshu-mcp's dispatch loop. This phase delivers install discovery, data-directory derivation, instance reuse/managed launch, and CDP product validation; **UI driving (directory binding, model/design-system/design-direction selection, input and send, run detection, visual acceptance) is left to later phases**. While the UI is not wired up, dispatching **hard-fails with `not_implemented`** listing the missing selector keys instead of pretending to succeed. See [Open Design GUI (CDP) adapter](docs/opendesign-cdp.en.md).
- **Read-only diagnostic probe `scripts/probe-opendesign.mjs`**: `install` / `process` / `cdp` / `appconfig` / `anchors` subcommands, mirroring `probe-kimicode.mjs`; read-only by default (no clicking, typing, or sending) and only starts an instance with an explicit `--launch`. Available as `npm run probe:opendesign`.

### Changed

- **New `designDirection` parameter** (`run_task`, Open Design only): supports only Prototype / Document / Website clone (`prototype` / `document` / `clone`); the UI's "Slides / Image / HyperFrames" are **rejected explicitly**, and invalid values are rejected at the **entry point** before any GUI action. It deliberately does not reuse `mode`, which is TraeWork's panel mode.
- The `designSystem` parameter now documents its Open Design meaning: here it is a **design-system name** (e.g. `Claude`) that the adapter searches for and clicks in the design-system panel.

### Real-machine evidence (Windows 10 19045 / Open Design 0.24.1)

- The product has a **process-level single-instance lock**, and its main process **forces** `app.setPath("userData", …)` — the `--user-data-dir` switch is overridden. There is therefore no "dedicated userData managed instance"; the strategy is **reuse first → managed launch → `needs_user(close_existing_instance)` asking the user to close it**, never killing user processes.
- The product also starts its daemon/web sidecars from the same executable (argv carrying a `*.mjs` script). Of 11 same-named processes measured, only 1 is the real desktop main process; root-process determination must drop the sidecars, otherwise a managed instance could **never start** once the user closes the window.
- The CDP base port was planned as 9777, but measurement showed it is **taken by Qoder CN** (range 9777-9796) → changed to **9889** (range 9889-9898).
- The version gate must compare the **product version** (`appVersion` in `<install dir>/resources/open-design-config.json`); CDP `/json/version`'s `Browser` is the **Electron version**, and misusing it blocks every dispatch (regression-tested).

### Tests

- **34** new cases across 2 files: install discovery (fixed-drive relative paths / registry fallback / explicit-path authority / version and namespace reading / dirty data not misjudged), process enumeration and root-process filtering (including the measured sidecar shape), CDP product validation (rejecting foreign Electron apps), the version gate, design-direction normalisation, and exact menu-candidate matching. Full suite: **1173 passed / 12 skipped** (105 files). The new cases **do not depend on Open Design being installed** (all use injection and temporary directories).

## [0.6.7] - 2026-09-24

### Added

- **Terminal-state webhook notifications** ([issue #22](https://github.com/lanlan0811/tianshu-mcp/issues/22)): when a task completes, fails or enters `needs_attention`, a JSON body is **asynchronously POSTed** to a configured URL, cutting the babysitting cost of long tasks. See [task notifications](docs/notifications.en.md).
- **New `notifications.webhook` in the global `config.json`**: `enabled` (default false) / `url` / `timeoutMs` / `maxRetries` / `backoffMs` / `secret` (HMAC-SHA256 signing) / `events`.
- **`src/tasks/notifier.ts`**: `TaskNotifier` (fire-and-forget, retry + backoff + timeout, warnings only on failure) and the `statusToEvent()` mapping.

### Changed

- `TaskStore`'s constructor gained an **optional** third argument, `notifier`; terminal notifications are dispatched inside `updateStatus`'s write closure **after** `appendEvent` + `writeSnapshot` succeed. Existing `new TaskStore(home, logger)` calls are entirely unaffected.
- `src/server.ts` assembles the `TaskNotifier` (reading the same `config.json` lazily, so config edits take effect while running).

### Compatibility

- **Off by default**: unset or `enabled:false` sends **no requests at all**, behaving exactly as v0.6.6.
- **No tool contract, data model or MCP annotation changes**; only a new **optional** config section.

### Notes (disclosed honestly)

- **The hook point is `TaskStore.updateStatus()`** (the single state-transition choke point), **not** `TaskOrchestrator.finish()` — the latter only covers orchestrator-driven ends, while `cancel()`'s queued branch, `initialize()`'s restart archiving, and `shutdownInterrupt()` / `persistInterrupted()` all bypass it.
- **"Exactly once" dedupes on `taskId + status + finishedAt`; `prev !== status` cannot be used**: several paths **write `meta.status` directly first** and only then call `updateStatus`, at which point `prev` already equals the target state. `finishedAt` is refreshed by `updateStatus` on a terminal write and cleared by `rework`/`continueTask`, so repeated writes for one episode are suppressed while **a new episode after rework notifies again**. Delivery can still repeat across a server restart or a receiver retry, so receivers should dedupe on the same key.
- **Only true terminal states are pushed by default**: `needs_attention` (terminal) → `needs_human`; `needs_user` (**non-terminal**, restorable via `continue_task`, possibly re-entered) is a separate class that is **off by default** — callers who want it must add it to `events` explicitly (knowing it will repeat). `cancelled` is likewise off by default.
- **Best-effort, not guaranteed**: sending is fully asynchronous, so a slow or dead endpoint **does not block the state machine**; failures (network error / timeout / non-2xx) are retried `maxRetries` times and then only logged as a single `warn` — they **never change a task's terminal state**.
- **The body contains local paths**: it includes `projectPath` and absolute paths to acceptance report files; confirm the receiver is trusted before forwarding to a public service.
- **`enabled=true` without `url` is rejected by the schema** (no silent "enabled but never sends" confusion); `config.json` follows last-known-good, so a broken file only warns and keeps the previous valid config.

## [0.6.6] - 2026-09-24

### Added

- **Dry-run mode `dryRun` for `run_task`** ([issue #21](https://github.com/lanlan0811/tianshu-mcp/issues/21)): the agent analyses and plans only — outputting the file list and approach **without touching source** — and the acceptance engine performs static analysis only (do the referenced files exist, do the proposed edit locations exist, any obvious logical conflicts), skipping typecheck/test/build. See [dryRun mode](docs/dry-run.en.md).
- **`src/verify/dry-run.ts`**: plan schema (`path` / `action` / `reason` / `edits`), the static checks, and the report / plan-document renderers.
- **A review-then-do loop**: the plan document produced by a dry run lands **inside the project** at `.tianshu-mcp/dry-run-plan-<taskId>.md`, with `meta.dryRunPlanDoc` giving the project-relative path, directly usable as a later real `run_task`'s `planDoc`.

### Changed

- **`TaskMeta` gained `dryRun` / `dryRunReportMd` / `dryRunReportJson` / `dryRunPlanMd`**; `metaFromTask` exposes `dryRun` / `dryRunReportFiles` / `dryRunPlanDoc`.
- Report artifacts are **strictly separated**: a dry run writes `dry-run-report-<round>.md` / `.json` (the JSON carries `kind: "dry-run"`) and **never touches** `report-<round>.*`, so it consumes no acceptance round and does not pollute the regular report list.

### Compatibility

- **`dryRun` is a new optional argument, off by default**: when omitted, `run_task` behaves exactly as in v0.6.5.
- No tool contract or breaking data-model changes; MCP annotations unchanged.

### Notes (disclosed honestly)

- **The verdict is `needs_attention`, not `failed`**: a bad plan needs a human decision, not automatic rework; a dry run **never enters the rework loop**, **ignores `autoVerify`** and **requires `projectPath`** (project-less mode rejects it explicitly).
- **A missing plan degrades but stays visible**: `planExtracted: false` plus a `fallbackReason` stating why, with checks degrading to the zero-change gate only; both the report and the message state "plan extraction: failed" honestly instead of passing silently.
- **The zero-change gate is the core evidence**: diffing against the pre-work baseline, changes remaining after excluding MCP-owned artifacts (the plan file and any `planDoc` named in the task book) yield `dry_run_violation` (blocking). It **does not depend on the plan being correct** — it still works when the agent produces no plan at all.
- **The agent is not guaranteed to obey the read-only constraint**: that relies on explicit task-book instructions plus the post-hoc gate. **Violations are caught and reported honestly, but changes that already happened are not rolled back** (the MCP never auto-commits, auto-stashes or auto-checks-out).
- **Static checks cannot judge whether a plan is sensible**: they only verify "the file exists, the location matches, no obvious contradiction" — which is exactly what the human review step is for.
- **Adapter differences around `planDoc`**: it is currently consumed only by the **Codex and Qoder CN** prompt builders; CLI agents and ZCode / Kimi Code / TraeWork do not read it, so for those the plan path must go into the `task` text (the file is inside the project, so they can read it). This is documented in both `docs/dry-run` files and the README.

## [0.6.5] - 2026-09-24

### Added

- **Three-level acceptance config inheritance** ([issue #20](https://github.com/lanlan0811/tianshu-mcp/issues/20)): `<data home>/acceptance.default.json` (global fallback) → `<project>/.tianshu-mcp/acceptance.json` (project override) → transient task-level override. With several similar projects under one host, the shared policy goes in the global layer instead of a file per project. See the [acceptance config spec](docs/acceptance-config.en.md).
- **New optional `acceptanceOverride` on `run_task` / `verify_task`**: a transient task-level acceptance-config override (same format as `acceptance.json`) that applies **only to that task**, is saved with the task snapshot, writes no `acceptance*.json` and affects no other task on the same project. Project-less mode explicitly rejects the argument.
- **`tianshu-mcp config acceptance [projectPath] [--task <taskId>]` debug command**: prints which layers exist, the effective order and the final values, so troubleshooting needs no guesswork. Each acceptance round also writes a same-source summary line to `server.log`.
- New `src/config/acceptance-merge.ts` (a purpose-scoped merge helper, **deliberately not a general-purpose deep merge**).

### Fixed

- **The `.default()` pollution hazard in layered parsing**: `AcceptanceConfigSchema` puts `.default(true)` on `requireChanges`, so parsing a project file that only sets `verifyConcurrency` materializes `requireChanges: true`, which in the three-level chain would **in turn override the global layer's `false`**. A default-free `PartialAcceptanceConfigSchema` is now used for layered parsing, with defaults applied only when the final value is absent.

### Changed

- `resolveChecks()` now performs the three-level merge and returns the merged `visual` too; `executeVerify` no longer re-reads the project file (otherwise the `visual` from override/global layers would change meaning based on whether a project file happens to exist).
- After the unified `LOCKFILE_PATTERN` export (v0.6.4), the bilingual `acceptance-config` precedence tables were rewritten around the three-level chain.

### Compatibility

- **No tool contract, data model or MCP annotation changes** (`acceptanceOverride` is a new optional argument; `extraChecks` semantics and precedence are unchanged and still rank above the base set).
- Without creating a global `acceptance.default.json`, single-project behaviour is exactly as in v0.6.4 (an absent global layer = empty config, no error).
- The existing semantics of the project-level `.tianshu-mcp/acceptance.json` are unchanged; error semantics remain fail-closed (only `ENOENT` counts as "layer absent").

### Notes (disclosed honestly)

- **Merge granularity is per field**: a field a higher layer explicitly writes wins outright; **arrays (`checks`) replace wholesale rather than concatenating** — concatenating would turn "the project adds one check" into "the project can never remove a global check".
- **`visual` replaces wholesale and is not deep-merged across layers**: nearly every field of the `visual` schema carries a default, so deep merging would let a higher layer's "not written, present only as a default" fields silently clobber a lower layer's **explicit** values (the same pollution class as `requireChanges`). To reuse visual config across layers, write the full `visual` block in the project layer. **This is a deliberate deviation from the issue's suggested "deep merge"**, with the reasoning recorded in `docs/acceptance-config.en.md` and ARCHITECTURE §7.4.
- **The task override is included in the idempotency argument digest**: replaying the same key with a different acceptance policy is rejected fail-closed rather than returning an old task built on a different policy.

## [0.6.4] - 2026-09-24

### Added

- **Structured repair directives `repairDirectives`** ([issue #19](https://github.com/lanlan0811/tianshu-mcp/issues/19)): failed rounds parse acceptance failure reasons into **directly executable actions** (`file? / line? / issue / action / source`) carried in both the repair plan and the rework message, sparing the agent the cost of locating "which line has the type mismatch, which file has a TODO" in a full narrative report. See [structured repair directives](docs/repair-directives.en.md).
- **Two built-in extraction sources**: `typecheck` (parses pretty / plain tsc errors out of failed typecheck checks' output tails; absolute paths normalized to project-relative POSIX; duplicates collapsed) and `diffstat` (oversized single-file changes, modified lockfiles, and line-level counts for TODO / debug output / secret-like patterns).
- **New optional `repairHint` on `rework_task`** (free-form string, max 4000 chars): the caller supplies its own structured repair hint, rendered in the next round's task book as a `【结构化修复提示】` block placed **before** `feedback`.

### Changed

- **`report-<round>.md` gained a `## Structured repair directives` section**; `report-<round>.json` gained a `repairDirectives` field (**failed rounds only**).
- **Both repair-plan variants (generic `rework-*.md` and Codex `codex-fix-r*.md`) gained a `## 2.5 Structured repair directives` section**, placed between section 2 (failures) and section 3 (passing checks).
- `LOCKFILE_PATTERN` is now exported from `code-analysis.ts` so the analysis warnings and the extractor **share one list**, preventing drift between two copies.

### Compatibility

- **No tool contract, data model or MCP annotation changes.** `repairDirectives` is a new optional field inside the report, which readers may simply ignore; when `repairHint` is omitted, `rework_task` behaves exactly as in v0.6.3.
- Extraction runs **only on failed acceptance rounds**; passing rounds do not produce the field (no report bloat).

### Notes (disclosed honestly)

- **Explicit fallback when extraction fails**: a non-empty `fallbackReason` means renderers state "unavailable, falling back to the full report" and tell the agent to return to the full failure output — a **silent gap is not allowed**. An exception from a single source is swallowed and recorded in the reason while other sources keep working — the extractors never throw.
- **No extraction for test-class failures**: test-framework output has no stable file/line; parsing it anyway would produce **wrong** locations, which is worse than producing none.
- **`diffstat`'s line-level signals never fake a location**: `signals.ts` only counts and has no stable file or line, so those directives omit the `file` field.
- **Known limitation**: `outputTail` is truncated to the last 4000 characters, so a large project only yields tail type errors and the rest is covered by the fallback — a deliberately accepted trade-off.

## [0.6.3] - 2026-09-24

### Added

- **Fine-grained event stream** ([issue #18](https://github.com/lanlan0811/tianshu-mcp/issues/18)): adapters can proactively report semantic events at key nodes, and `query_task` returns the most recent N of them, so long tasks can be told apart as "working normally" versus "stuck on a dialog waiting for a human". Five event kinds: `task_dispatched` / `confirmation_dialog_detected` / `awaiting_user_authorization` / `file_modification_started` / `rework_triggered`. See the [event stream doc](docs/event-stream.en.md).
- **New optional `query_task` input `eventLimit`** (integer 1..50, **default 10**): events appear both in the meta block's `recentEvents` array and in a "recent events" section of the text area.
- **Two built-in GUI adapters actually report events**: codex and traework (four emission points each); `rework_triggered` is emitted engine-side (automatic rework `mode:"auto"`, manual `rework_task` `mode:"manual"`).

### Changed

- **Manual `rework_task` now emits a typed `rework_triggered` event instead of an anonymous `note`** (visible in `task.jsonl`). The semantics and purpose of the existing `note` event are unchanged; `progressSummary` / `lastRunSignal` are still carried by `note`.
- **The `TaskEventName` union gained five members**, sourced from `AGENT_EVENT_NAMES` so the vocabulary cannot drift between two places.

### Compatibility

- **No tool contract, data model or MCP annotation changes.** `recentEvents` is a new optional field: adapters that do not implement event reporting (including all CLI adapters) return an empty array with no event section in the text area, and **every other field is exactly as in v0.6.2**.
- Events are written into the existing `task.jsonl` (**no parallel event file is created**); the read side only reads a 64 KiB tail window, so memory use is decoupled from total file size.

### Notes (disclosed honestly)

- **`file_modification_started` is a heuristic.** The codex / traework adapters do not observe the filesystem directly; they can only infer that execution started from the UI's "running" signal (stop button). Its detail always reads "stop button appeared, execution started (files may be modified)" and **does not claim files were actually changed**. For hard evidence of file changes, read `changedFiles` / `diffstat` from the acceptance report.
- **Event reporting is an optional capability.** The hook lives on `AgentRunOptions.onEvent`, not the agent profile (`agent-profiles.json` is plain JSON and cannot hold a function); adapters that don't implement it need not change a single byte. Adapters report through `makeEmitter` — a no-op when no hook is provided, swallowing reporting exceptions so that **a failed report never affects the task itself**.
- **Events are not delivery-guaranteed.** This is an observability capability, not a delivery guarantee; `query_task` reflects only "the last event that was persisted".

## [0.6.2] - 2026-09-23

### Fixed

- **Codex project-picker trigger copy drifts across versions** ([issue #23](https://github.com/lanlan0811/tianshu-mcp/issues/23), case 1): the trigger's `aria-label` is "选择项目：<name>" on some versions and "切换项目：<name>" on others (26.915, measured locally). `projectPickerTrigger` now covers both copies via primary/fallback/pattern (including the English `Select/Switch project`), and `boundProjectName` reads both back. **A full 20-key hardware audit was run** (`node scripts/probe-codex.mjs --launch audit`): on local 26.915 there is no drift beyond this trigger, and 9 verified keys were bumped to `verifiedVersion: 26.915.x`.
- **Qoder workspace binding failed on 0.3.4** (issue #23, case 2): a fresh hardware probe **corrected the issue's conclusion** — the 0.3.4 workspace menu **does render**; the real cause is that the page has **two** `[data-workspace-picker-trigger]` elements, and the old single-match `click()` failed as ambiguous. The workspace trigger's primary selector is now the unique `button[aria-label^="切换或清空当前工作区"]` (with `[data-workspace-picker-trigger]` demoted to a fallback); the "menu is open" check is relaxed to "search box **or** overlay". The production `bindWorkspace` now passes on real Qoder 0.3.4.
- **TraeWork install discovery failed** (issue #23, case 3): added `src/agents/traework/discovery.ts` (fixed-drive enumeration + registry `InstallLocation` + relative paths) with a dedicated `traework-gui` branch in `registry.ts`. Fixed the built-in profile — removed the wrong `{APPDATA}/TRAE SOLO CN` (measured to be the **user-data dir**: Cache/Crashpad/nested tool exes, not the install location) in favor of `{LOCALAPPDATA}/Programs/TRAE SOLO CN` etc., and added `preferredDrives`/`relativePaths`. **On Windows the executable name is narrowed to `TRAE SOLO CN.exe`** (the old list's `Trae CN` mismatched the unrelated TraeCode CN product). `waitReady` timeouts now emit on-site diagnostics (child exit code, port-listener enumeration, detection of existing instances without the debug port) — **diagnosis only: no launch-strategy change, no termination of existing instances**.

### Added

- **Unified selector diagnostics across the three GUI agents** (`src/agents/gui-diagnostics.ts`): on selector-resolution failure the nearest visible page candidates (aria-labels / short texts) are appended to the error and log, so drift can be located in one step without opening CDP by hand. Wired into codex / qoder / traework.
- **Codex full-key audit mode** `scripts/probe-codex.mjs --launch audit`: prints the primary hit count and matched labels for all 20 selector keys as a "script + evidence table" gate.
- **Qoder layered selector structure**: `src/agents/qoder/selectors.ts` upgraded from flat strings to `primary/fallbacks/texts/ariaLabels/ariaPatterns/verifiedVersion` (27 keys); `QoderCdpClient.selector()` keeps its string semantics and adds `candidates()/existsKey()/clickKey()`.
- **TraeWork selector version field unified**: `verified: boolean` → `verifiedVersion: string` (matching codex/kimicode).

### Docs

- New [issue #23 verification record](docs/issue-23-selector-drift-record.md) (20-key audit table, Qoder 0.3.4 re-probe, TraeWork discovery hardware results); release notes [v0.6.2](docs/release-v0.6.2.en.md).

## [0.6.1] - 2026-09-23

### Added

- **Dangerous-directory decision collapsed into a platform-injectable pure function** `isDangerousProjectDir(norm, platform)` (`src/util/path.ts`): exact root / drive root / system-directory subtree, so all three platform shapes are verifiable on any OS.

### Changed

- **`verify_task` capability moves from `read` to `execute`** ([issue #17](https://github.com/lanlan0811/tianshu-mcp/issues/17) item 2): it runs the project's configured commands and may produce build artifacts, so it never was read-only. **Host note**: its MCP `readOnlyHint` changes from `true` to **`false`**; `requireApproval` stays `false` (still approval-free, the R11 conclusion is unchanged) — **policy layers should key off `_meta.requireApproval`, not `readOnlyHint`**. The policy examples in `docs/tianshu-integration` (both languages) are updated.
- **The `"network"` value, used by no tool at all, is removed from the `ToolDef.capability` union**, collapsed to three families (`read` / `write` / `execute`) documented on the type and in the `tools.ts` header.

### Fixed

- **System directories are now denied as subtrees** (issue #17 item 4): `/etc`, `/usr`, `/bin`, `/sbin`, `/private/etc` plus `c:/windows`, `c:/program files`, `c:/program files (x86)` moved from exact-equality to **boundary-aware subtree denial**, closing leaks such as `c:/windows/system32` and `/etc/anything`. Boundary-awareness keeps `c:/windows.old`, `/etcetera` and `/usrlocal` from being falsely matched; `/var`, `/tmp`, `/opt`, the home directory and friends stay exact-match (on macOS `os.tmpdir()` *is* `/var/folders/...`, so a subtree rule would sever the test base and legitimate workspaces).
- **Project registration failures are no longer silent** (issue #17 item 3): `run_task` used to discard the `registerProject` return value (`void registered;`) and then re-read the same record via `projectByPath`; it now consumes the return value, drops the redundant read, and on failure logs `WARN` and returns a structured `isError` **without dispatching** (eliminating the "task created but project unregistered" half-state).
- **Count-vs-reality wrap-up** (issue #17 item 1): the leftover "9 tools" header comment in `test/protocol/protocol.test.ts` is corrected and a `TOOL_DEFS` count assertion added; the lagging "6 scenarios" references in the `ci.yml` comment, `HANDOFF` (two places) and `CONTRIBUTING` (both languages) are synced to **8** (they lagged behind the two skill scenarios added in issue #16).

### Documentation

- **The `cmd` string-form pitfalls made explicit** (issue #17 item 5, zero behaviour change): `docs/acceptance-config.md` / `.en.md` gain a measured table (no escaping, an unclosed quote does not error, an empty quote yields an empty argument), and the `schema.ts` / `store.ts` comments, `SKILL.md` and `usage-examples.md` carry an "always prefer the array form" note.
- Bilingual: README (`verify_task` capability row + M31 milestone), ARCHITECTURE (three-family tool table + `readOnlyHint` derivation rule + two new §15 gaps), SECURITY (§3 dangerous-directory matching semantics + §5 wording corrected), `docs/tianshu-integration`, `docs/acceptance-config`; single-language: HANDOFF, `SKILL.md`, `usage-examples.md`; new `docs/issue-17-small-fixes-record.md` (measured evidence).

### Tests

- Full suite **940 passed / 12 skipped** (Windows 10 x64, Node 24.18.0), a net **+42** over v0.6.0's 898: `project-dir-guard` gains `isDangerousProjectDir` table-driven cases for all three platform shapes (including the three key counter-examples `c:/windows.old`, `/etcetera`, `/private/var/folders/...`) and a win32 subtree integration case; `protocol` gains an 11-tool × capability × four-annotation **truth table** and a count assertion; `zcode-handler` gains registration-failure-does-not-dispatch and return-value-consumed cases (the latter asserts a `projectByPath` call count of 0); `core` gains `splitCmd` boundary-semantics locks.
- The strict stdio gate passes **8/8** on both the dist and src entry points; `pack:check` passes (232 files).

## [0.6.0] - 2026-09-23

### Added

- **Tri-state and approval entry point for skill self-install** ([issue #16](https://github.com/lanlan0811/tianshu-mcp/issues/16)):
  - `skills.autoInstall` is upgraded from a boolean to `true | "prompt" | false` (existing `true`/`false` stay valid, no migration needed). `"prompt"` means **install as usual on first run, but do not auto-overwrite when a change is needed** (warn and record `pendingUpdate` in the manifest) — a stdio server has no synchronous interaction channel, so "prompt" effectively means "do not act automatically, leave it for confirmation".
  - New startup flag `--approve-skill-update` (equivalent env var `TIANSHU_MCP_APPROVE_SKILL_UPDATE=1`): for this run, permit a "needs change" skill directory to be overwritten with the in-package version (after backup). **It has no effect on directories confirmed to carry local edits**; `--no-skill-install` / `autoInstall:false` outrank it.
  - New `skills.backupKeep` (default 3, range 0..50, `0` = never prune): after a successful overwrite, keep the newest N `.bak-<timestamp>` directories by timestamp and log the deletions.
- Install manifest `<dest>/.tianshu-mcp-install.json` (`schema`/`name`/`packageVersion`/`contentHash`/`installedAt`/`sourceDir`, plus `pendingUpdate` when held), which distinguishes "an untouched stale package copy" from "your local edits" — previously indistinguishable in principle.

### Fixed

- **Skill content is no longer discovered from the current working directory** (issue #16 problem 1): `resolveSkillSourceDir()` now locates the source relative to the package via `import.meta.url` only, and **both `process.cwd()` candidates were removed** along with a loose candidate that could never match; when no source is found, the existing "skip with a warning" path is kept. Previously, debugging the server inside a third-party repository that carried its own `skills/tianshu-mcp/` would install that repository's content into `~/.rivet/skills/` for the next session.
- **An overwrite no longer silently replaces your local edits** (issue #16 problem 2): when the target content differs from the manifest record (i.e. you edited it) or the source is unknown (no valid manifest), the existing content is **kept with a warning** (plus two remediation paths: rename/delete and restart, or merge manually); an overwrite happens only when the content is provably untouched or explicitly approved.
- **Install can no longer leave a half-copied tree**: it now follows an atomic "copy into `<dest>.incoming-<ts>-<hex>` (manifest included) → back the old directory up as `<dest>.bak-<ts>` → swap in" path, rolling back and cleaning the tmp tree on failure; stale `.incoming-*` directories older than one hour are cleaned on startup. The previous "rename the old directory away, then copy straight into the target" had a crash window that could leave a half-copied directory, which the new semantics would misread as local edits and block upgrades on permanently.
- **Log levels for overwrites corrected**: stale-copy upgrade / local edits kept / unknown source / install failure are now all `WARN` (previously backup and install were `INFO`, easily drowned out); skip and manifest repair stay `INFO`. Hashes are printed as the first 8 characters only, with the full value in the manifest.

### Tests

- New unit file `test/unit/skill-install.test.ts` (30 cases): three source-location checks (a "decoy with the same name under cwd does not change the source" regression plus a "the source no longer contains `process.cwd()`" textual assertion), hash exclusion rules (the manifest itself and `.DS_Store`/`Thumbs.db`/`desktop.ini`/`._*`/`.git*`), manifest parsing (missing / malformed JSON / invalid schema·name·hash → corrupt), a table-driven sweep of the 6-state decision matrix across modes and approval, real-filesystem end-to-end (first install / idempotency / manifest self-heal / trusted-stale overwrite / local edits kept with no backup / `prompt` hold and `pendingUpdate` / approved overwrite / failure rollback / backup pruning / non-matching entries untouched / stale tmp cleanup / log levels / missing source), and a smoke test using the real `skills/tianshu-mcp`.
- `test/unit/config-hotreload.test.ts` gains default/override/invalid-value last-known-good cases for `skills.autoInstall` (tri-state) and `skills.backupKeep`.
- The strict stdio gate gains two independent scenarios (6→8): `skill-locally-modified` (seed a "locally modified" directory → assert no overwrite, no backup, no install log) and `skill-approve-update` (seed an "unknown source" directory plus the flag → assert an overwrite to the in-package version, a backup created, and a manifest written); new dev-only fixture `scripts/seed-skill-state.mjs` (registered as `npm run seed:skill-state`, excluded from the npm package).
- Full run **898 passed / 12 skipped** (Windows 10 x64, Node 24.18.0), 33 more cases than v0.5.10.

### Docs

- New `docs/release-v0.6.0.md` / `.en.md` and `docs/issue-16-skill-install-hardening-record.md` (the raw Windows 10 real-machine verification R1–R7 and uncovered items).
- The bilingual README gains a "Skill self-install" section (source location, manifest and the three verdict classes, the `autoInstall` tri-state table, approval/disable flags) plus the M30 milestone; the bilingual ARCHITECTURE gains §3.4 "Trust and decision model of skill self-install" (decision matrix, atomicity, log levels, backup governance) and lists the skill boundary among the hard red lines; the bilingual SECURITY gains "Supply-chain boundary of skill self-install"; `docs/agent-profiles.md` / `.en.md` update the `skills` config notes; HANDOFF carries the new version snapshot and file table.

## [0.5.10] - 2026-09-23

### Added

- **Idempotency keys (`idempotencyKey`) for `run_task` / `verify_task`** ([issue #15](https://github.com/lanlan0811/tianshu-mcp/issues/15)): a host retry after a `tools/call` timeout no longer becomes a duplicate dispatch or a duplicate verification run.
  - `run_task`: resubmitting the same key with the same arguments within the TTL (24 h default) **always returns the original `taskId` and its current meta** (terminal tasks included — read-only, never re-dispatched); the same key with different arguments fails closed, reporting the original `taskId`.
  - `verify_task`: a same-key verification that is **still running** returns a success result with `idempotencyReplay: "in_progress"` (deliberately not `isError`, so a host does not retry harder); one that has **already finished** returns the existing report paths plus that round's `reportRound` / verdict and **re-runs nothing**.
  - The two tools use independent namespaces; keys are 1..128 characters after trimming with no control characters (protocol-level validation, rejected as `参数不合法`).
- New data file `<data-dir>/idempotency.json` (atomic writes, lazy loading, TTL + capacity pruning) so retries are still recognised after a restart; `TaskMeta` gains `idempotencyKey` / `idempotencyScope` / `idempotencyDigest` for auditing and for rebuilding the mapping when the file is corrupt.
- New `config.json` keys: `idempotency.ttlMs` (default `86400000`) and `idempotency.maxEntries` (default `2000`, oldest first by `createdAt` when exceeded).
- The meta block gains `idempotencyKey`, `idempotencyReplay` (`hit` / `in_progress`) and `projectActiveTask`; `tools/list` reports `annotations.idempotentHint: true` for the two tools (**only when the caller supplies `idempotencyKey`**, as stated in the tool descriptions and the skill document).
- **Duplicate-dispatch fallback**: even without a key, `run_task` names the unfinished task in the same workspace (active statuses plus `needs_user`) and suggests using an idempotency key or checking `query_task` first.

### Fixed

- On an idempotency hit an audit `note` is appended to the original task's event stream (`幂等重放：keyDigest=…`); the key **plaintext never enters logs or the event stream** (only the first 8 hex characters of its sha256).
- The standalone `verify_task` record id changes from `vfy_<Date.now()>` to the existing `genVerifyId()` (`vfy_<timestamp>_<6 random chars>`, previously without any caller), so same-millisecond collisions are no longer possible.
- **Crash window**: the idempotency path writes the mapping **before** creating the task inside one critical section (`runExclusive` serialises same-key concurrency); if the process dies in between, a retry sees a mapping with no task snapshot, treats it as not yet effective and re-dispatches — two agent queues are never left behind.
- **Fail-open on write failure**: a failed mapping write still returns the dispatched task and states in the response and meta that "the idempotency record could not be written, this task cannot be replayed by the same key" — a running agent is never reported as a failed dispatch.

### Tests

- New unit cases `test/unit/idempotency.test.ts` (16): key validation, `canonicalDigest` stable serialisation, TTL expiry, capacity eviction, cross-instance recovery, corrupt-file rebuild, `runExclusive` serialisation and failure isolation, in-flight markers, fail-open on write failure.
- New integration cases `test/integration/idempotency.test.ts` (8): same-key replay creating a single `tsk_*` directory, same-key/different-arguments fail-closed, faithful replay of terminal tasks, zero regression without a key, the `projectActiveTask` hint, finished standalone replay adding no report, **in-progress replay returning a success result**, `taskId`-mode replay, and **cross-restart** dispatch and verification replay.
- Protocol cases gained `idempotentHint` assertions (true for the two tools only); `config-hotreload` gained `idempotency.ttlMs` / `maxEntries` defaults and override coverage.
- Type check, lint (`--max-warnings 0`), the full test suite, the build, the strict stdio check (6/6) and `pack:check` all pass.

### Docs

- New `docs/release-v0.5.10.md` / `.en.md`; the bilingual README gained an idempotent-retry entry, tool-table and milestone updates; ARCHITECTURE gained the data file, config keys and annotation notes; `skills/tianshu-mcp/` gained the parameter quick-reference, meta fields, error codes and discipline notes; HANDOFF carries the version snapshot.

## [0.5.9] - 2026-09-23

### Fixed

- **The GUI terminal state is no longer a false claim on server exit or restart archiving** ([issue #14](https://github.com/lanlan0811/tianshu-mcp/issues/14)). A GUI agent is an external desktop application and the server **owns no process** for it: after an abort the adapter can at best best-effort click the in-app stop control. The old code wrote "server exited, process terminated" for every active task, applying a statement that only holds for spawn children to GUI agents — the orchestrator was dead, the GUI might still be editing the user's project, and nobody was watching.
  - `persistInterrupted()` now branches on the driver: spawn keeps the original wording; GUI writes the honest outcome derived from the adapter's `guiStop` — "confirmed stopped", "stop unconfirmed, the task in the … window may still be running, please open … and confirm there is no residual run", or "no stop result to confirm" (ZCode and TraeWork never click stop and never report `guiStop`).
  - `shutdownInterrupt()` gives GUI tasks a **globally shared** `guiStopWaitMs` budget (new config, default 15000, overridable in `config.json`) so the best-effort stop and bounded wait can finish before the terminal state is written; spawn tasks keep their 2 s budget. An unconfirmed outcome is stated as such.
  - `initialize()` appends "stop unconfirmed + please check manually" when archiving GUI leftovers and sets `guiResidualUnconfirmed`; an unreadable profile is conservatively treated as GUI.
  - `abortTerminal()` (the competing writer in the shutdown race) now persists `guiStop` plus the structured fields on both branches, and derives the window name from `profile.displayName` (the old hard-coded mapping reported zcode/qoder as "Codex", itself a distortion). `runRes.guiStop` is persisted for every agent instead of only qoder, which previously lost the adapter's stop result in the shutdown race.

### Added

- New structured `TaskMeta` fields `interruptedCleanStop` (whether the stop is **confirmed**) and `guiResidualUnconfirmed` (pending manual confirmation after restart archiving). The `query_task` / `list_tasks` meta block gains `guiStopUnconfirmed`, giving the orchestrator one structured reason not to re-dispatch.
- A manual acknowledgement path with **no new tool**: calling `cancel_task` on a terminal GUI task clears `guiResidualUnconfirmed` and appends a `gui_residual_acknowledged` event, **without changing the terminal status or errorType**.
- New config `config.json` → `shutdown.guiStopWaitMs` (default 15000): the global upper bound for the GUI stop wait on shutdown, decoupled from `gui.cancelWaitMs` (the cancellation path).

### Tests

- New unit cases `test/unit/gui-stop-disclosure.test.ts` (three-state disclosure, window-name derivation with the "never strip to empty" fallback, and the guarantee that no input produces "the process has been terminated").
- New integration cases `test/integration/gui-shutdown-interrupt.test.ts` (the `idle=true` / `idle=false` / no-stop-result shutdown paths, restart archiving plus the `cancel_task` acknowledgement, and spawn tasks being unaffected by the GUI branching).
- `config-hotreload` gained default and override cases for `guiStopWaitMs`; the running-cancellation case in `codex-flow` now asserts the structured fields as well.

## [0.5.8] - 2026-09-23

### Changed

- **The four primary documents were rewritten item by item against the code** (bilingual README / HANDOFF / bilingual ARCHITECTURE). The audit covered `src/mcp/`, `src/tasks/`, `src/loop/`, `src/agents/` (all five GUI adapters), `src/verify/`, `src/visual/`, `src/config/` and `src/util/`:
  - **Acceptance stage order fixed**: the built-in `git-diff-check` runs **before** the configured checks, and the visual stage runs **after** the command checks (the old text had it reversed).
  - **The real boundary of `visual.enabled=false`**: snapshot freezing and integrity checking run **unconditionally**, independent of `enabled`; `enabled` only decides whether screenshots/specs/content judgement actually run — which is exactly what detects edits to the acceptance config or baselines.
  - **Tool result contract fixed**: `prepare_visual_baseline` / `approve_visual_baseline` success results also carry no meta block, and neither does any tool's error result (the old text claimed only `get_task_report` was an exception).
  - **All five agent tables now include Qoder CN**: the agent list, driver list, `endReason` table, `needsUserKind` table, cancellation-capability table, registry special discovery branches, GUI instance lifecycle and test-layer descriptions were corrected from "four drivers" to "five", and Qoder CN's execution order and completion criterion were added to the architecture document.
  - **`endReason` / `needsUserKind` verified value by value**: added Kimi Code's `system_permission` / `setup_recovery`; noted that Qoder CN is the only adapter able to emit all six kinds and that it **never emits `idle_timeout`** (static screen without this-turn evidence → `needs_user(setup_recovery)`); noted that Codex has no `close_existing_instance` path because `needsClose` never returns true; and that ZCode and TraeWork never click a stop button and never report `guiStop`.
  - **Cancellation semantics** are now split per adapter capability; **checkpoints** now state that `qoder-session.json` is the only persisted checkpoint (with all four phases and their read/write points) while the rest keep in-memory state.
  - Corrected the **Kimi Code tier domain** (README front-page example and milestone text changed from `Low`/`High`/`Max` to `低/low`, `高/high`, `max`, `on`, `off`), the **test baseline** (776 tests/73 files → 826 passed / 12 skipped across 81 files, broken down as unit 54 / integration 26 / protocol 1) and the **runtime dependency licence table** (Apache-2.0 and ISC entries added, "all MIT" corrected).
  - The architecture document gained a callout for **declared-but-unused profile fields** (`gui.windowMode`, `gui.modelRequired`, ZCode's `gui.stallTimeoutMs` / `gui.cancelWaitMs`), and the known-gaps list now carries two real debts instead of a stale tool-count note.

### Fixed

- **Distribution gap**: `scripts/probe-traework.mjs` was not in `package.json`'s `files`, yet the docs tell users to run that probe — npm consumers could not get it. It is now shipped, and the `probe:traework` / `probe:zcode` / `probe:codex` npm scripts were added (previously only `probe:kimicode` / `probe:qoder` existed although the corresponding scripts had long been published).
- **Source comments and strings**: the "9 tools" header comments in `src/mcp/handlers.ts` and `src/server.ts` now say 11; the MCP `instructions` string mentions `kimicode` / `qoder`; `src/agents/gui-instance.ts` lists all five users; `src/tasks/task.ts` fixes a Kimi Code comment that sat on the Qoder fields and notes that `qoderTurnId` has no writer. **No runtime behaviour change.**

### Tests

- Full regression: **826 passed / 12 skipped** (Windows 10 x64, Node 24.18.0); typecheck and lint pass; `npm pack` (231 files) verified to include all five probe scripts.
- Documentation link check: the four primary documents plus the skill docs contain **255 relative links, 0 broken**.

## [0.5.7] - 2026-09-22

### Changed

- **The orchestration skill docs (`skills/tianshu-mcp/`) were rewritten item by item against the current code** (`SKILL.md` + `usage-examples.md`; the server idempotently syncs them into `~/.rivet/skills/tianshu-mcp/`). Every claim was checked against `src/mcp/tools.ts`, `src/config/schema.ts`, `src/tasks/task.ts`, `src/tasks/task-manager.ts`, `src/loop/fix-loop.ts`, `src/mcp/formatter.ts`, `src/agents/builtin.ts` and the five adapters:
  - Added a **parameter compatibility matrix** (projectPath / model / modelSource / reasoningLevel / mode / planDoc / designSystem / allowCreateProject / continue_task across five agents) that states plainly what is rejected rather than silently ignored.
  - Corrected the **Kimi Code tier domain**: it previously read `Low`/`High`/`Max`, but only `低/low`, `高/high`, `max`, `on` and `off` are accepted (deliberately no `中`/`medium`); the tier set is validated against the labels the UI actually renders, and an omitted tier forces `on` for unofficial models.
  - Corrected the **`autoVerify` default** (on by default at the server level, previously undocumented) and completed the **`autoFixRounds` defaults** (codex 5 / zcode 2 / kimicode 2 / qoder 3 / traework falls back to the server default 0) plus the full `taskTimeoutMs` precedence.
  - Added a full **qoder** section: `modelSource` disambiguation, saving and reading back the tier in Model Management, the global preference never being restored, send/answer checkpoints that never resend, automatic and manual repair both writing a plan and sending its full text back, macOS dispatch being disabled, and a multi-question JSON answer example.
  - Added a **`needsUserKind` × agent × `continue_task` behaviour matrix** (six wait kinds × four agents), which previously was scattered per agent and never stated which kinds are confirmation-only and which re-send the complete brief.
  - Added an **`agentEndReason` → terminal-state mapping** (`task_timeout` / `idle_timeout` / `cdp_disconnected` versus other hard failures landing in `needs_attention` or `failed(spawn)`), plus the missing `project_not_registered`, `unsupported_platform` and `qoder_error` (18 concrete codes) entries.
  - Completed the **meta field table** with `qoderSessionId`, `actualModel`, `actualReasoningLevel`, `modelSource` and `guiStop`, and noted that `reasoningLevel` is an input that is never echoed while codex's effective tier is only visible in its panel.
  - Clarified the three **`verify_task`** modes (task re-verification only updates the verdict fields; an independent `projectPath` accepts only a git ref as `baselineRef`; manual verification allocates a new report round) and the required arguments of `prepare_visual_baseline` / `approve_visual_baseline` (UUID plus a 64-hex digest).
  - Removed duplicated material and split responsibilities: the main file teaches the method, the sub-file gives copy-ready shapes with wording matched to the real error strings.

## [0.5.6] - 2026-09-22

### Added

- Add the Qoder CN GUI adapter: installation discovery, full-path workspace binding and import, default/custom model selection, and persisted reasoning settings verified through Model Management.
- Integrate dispatch, liveness, objective acceptance, and same-session rework. Automatic and manual rework write a plan before sending its filename, full path, and complete text.
- Report model source and actual settings; retain permission mode and disclose global reasoning preferences. Approvals require the user, questions use dedicated controls, and uncertain submissions are never repeated automatically.
- Windows default/custom model, new workspace and same-session repair acceptance passed on a real desktop. macOS remains research and dispatch is disabled. See the [Qoder guide](docs/qoder-cdp.en.md).
- Isolate unit test files to prevent discovery command mocks from contaminating Git baseline tests; exclude temporary probes from lint.

### Tests

- Full suite: **826 passed / 12 skipped** (Windows 10 x64, Node 24.18.0; 78 test files passed plus 3 real-browser files skipped by design), roughly 60 cases more than v0.5.5: discovery priority (explicit → D drive → registry/shortcuts → standard directories), wrong installation paths and identity checks, CJK/space/same-name paths, workspace import and read-back failure, cross-group model ambiguity and unsupported tiers, a save that did not persist, uncertain sends and answer submissions never resent, this-turn-bound completion judging (old replies and a static screen do not qualify), same-session repair, unconfirmed cancellation/timeout stops, and macOS branches failing closed.
- Real-browser gate cases (`TIANSHU_VISUAL_BROWSER_TEST=1`) remain 12/12 on this Windows 10 machine; `npm pack` content validation plus a clean-consumer install and strict stdio check pass locally.
- Uncovered items are stated plainly: Qoder cancellation, question answering and login/quota/network waiting classification are **covered by hermetic integration tests only**, and macOS has no real GUI validation. See [HANDOFF §9.12](HANDOFF.md).

### Planned

- The Qoder CN macOS hardware matrix (stays `research`; dispatch disabled until verified).
- Hardware verification of Qoder CN cancellation, question answering and login/quota/network waiting classification (currently covered by hermetic integration tests only).

## [0.5.5] - 2026-09-20

### Added

- **Added the Kimi Code GUI adapter (`agentId=kimicode`, the fourth GUI agent)**: the Kimi Code desktop app (Moonshot AI, measured 1.0.2) is a **plain Electron install** — injecting `--remote-debugging-port` and driving it over CDP is enough, with **no** MSIX COM activation.
  - **Two-renderer CDP driving**: the model menu, thinking tiers and execution-mode menu are rendered by the app's `browserOverlayOpenMenu()` into a separate `Kimi Browser Overlay` renderer process (measured: after clicking `model-pill` the main window's DOM node count is unchanged and no menu node appears), while the workspace menu and the "switch model" dialog stay in the main window → the client holds both pages and excludes the `Screenshot` target.
  - **Workspace binding and import**: the **normalized full path** is the sole criterion (same-name different-directory always fails closed, never guesses an entry); an unregistered workspace is imported through the native "add workspace" dialog (`#32770`; Win32 coordinate clicks plus `WM_SETTEXT`/`WM_GETTEXT`), and after binding the panel selection and the `ws-chip` text are read back.
  - **Three-stage model selection**: pill read-back → direct pick in the overlay shortcut menu → "more models…" → search and exact row pick in the main window's "switch model" dialog (the only entry for unofficial models). Thinking tiers are validated against **the tier set the UI actually renders** (official `Low/High/Max`, unofficial `On/Off`); requesting a tier the UI does not render fails loudly with `model_mismatch` before sending and is never silently kept.
  - **Execution mode is forced to "fully automatic"** and read back after switching; the `run_task.reasoningLevel` domain grows to `low/medium/high` plus `max/on/off`.
  - **Run detection**: `button.stop` (`aria-label="中断"`) and `button.send.is-starting` are the authoritative run signals; sending uses a marker plus a bounded 60s confirmation (the session id and the landed user message are required anchors) and is **never re-sent**.
  - **Six `needs_user` kinds with `continue_task` recovery**: `close_existing_instance` / `login_required` / `user_confirmation` / `agent_question` / `system_permission` / `setup_recovery`. Answering a question writes back to the recorded session (without re-sending the brief), a user confirmation only re-attaches for observation, and environment kinds re-send the full brief; when the recorded session cannot be located the run fails closed with `session_lost`.
  - **Cancellation and dispatch guard**: following the Codex M14 semantics, `cancel_task` clicks `button.stop` best-effort and bounded-waits (`gui.cancelWaitMs`) for the UI to go idle, stating plainly when the stop is unconfirmed; before dispatching, a still-running managed instance is stopped best-effort, and if it never goes idle the dispatch is rejected with `instance_busy`.
  - **Machine verification (Windows 10 x64 + Kimi Code 1.0.2)**: the success path, unregistered-workspace import with auto-acceptance, and the failure → rework → re-acceptance **same-session loop** all pass. **Cancellation, question answering and same-name workspace ambiguity are covered by hermetic integration tests only** (no hardware stop click, no real question card triggered); macOS is `research` and fail-closed (executable discovery and native-dialog driving are unmeasured on macOS).

### Planned

- More external AI-Agent adapters (a new agent = one profile + an optional adapter file).
- The Kimi Code macOS hardware matrix, plus hardware verification of cancellation / question answering / same-name ambiguity (currently covered by hermetic integration tests only).
- TraeWork executable discovery and native-dialog driving on macOS (currently fail-closed).
- Optional project-level skill seeding (by default nothing is written into target repos).
- Cancel/rework/new-project matrices for the Codex and ZCode GUI drivers on macOS (both remain `research` on darwin).
- Best-effort stop of a GUI-side pending session (via a temporary CDP connection) when cancelling
  a task in the `needs_user` state.
- Real-machine verification of project-less dispatch on macOS (this round covers Windows 10 only).
- ZCode's **automatic import of an unregistered project** cannot complete on Windows: the native-panel script relies on `SetForegroundWindow` to bring the dialog forward before activating its address bar, but a child process of a background MCP server is refused by Windows, so the address-bar Edit never appears and the script spins until its deadline (measured: 56s, then classified by `budget.check()` as an exhausted setup budget). PowerShell's stdout is also block-buffered through a pipe, so killing the process loses the buffer and not a single `native:` stage reaches the log, misdirecting diagnosis. Workaround: add the target directory to the ZCode project list manually first; the fix direction is to grab the foreground with `AttachThreadInput` inside the script, or to use a supported ZCode registration entry point.
- Cross-round verdict-flip circuit breaking for AI content validation (this round covers it with caching plus sampling; reconsider if hardware data still shows churn), cross-task cache sharing, and reference-image/design-diff comparison.

### Fixed

- **Completed the two contract-mapping assertions issue #13's plan §5 G requires (added after the v0.5.4 release)**: `CONTENT_TIMEOUT` had its classification logic implemented but tests only asserted the transport-level `outcome.timeout`, and the stub's `sleep` mode was never exercised by any case. `visual-content-command` now has an end-to-end assertion (a timeout yields a single `blocked` item with `CONTENT_TIMEOUT`, still warning-only, with temp input files removed), plus a success-path temp-input-removal assertion and a `visual doctor` assertion for the "multi-rule total budget exceeds `roundTimeoutMs` → advisory only" branch. The v0.5.4 tag (`ea797d1`) shipped 644 cases; master now has 647.

---

## [0.5.4] — 2026-09-16

**Visual acceptance phase 2: AI visual content validation (issue #13)** — alongside the existing objective pixel/spec checks, a new **optional, off-by-default** content-check dimension that validates whether the content of an image or page screenshot matches an expectation you declare explicitly. Judgement is fully delegated to a local command you supply (the MCP never reads, stores, or forwards credentials), it warns only by default, and it debounces with majority sampling plus a task-level cache. See the [v0.5.4 release notes](docs/release-v0.5.4.en.md).

### Added

- **Content-check configuration surface**: `visual.content` (global command and budget), `visual.contents[]` (image content rules), `pages[].content` (page semantics), and `pages[].pixel` (defaults to `true`; `false` means a semantic-only page that is exempt from the baseline requirement and pixel comparison but must declare `content`). Everything is off by default and requires an explicit opt-in; declaring rules without enabling them, a missing effective command/template, an unknown placeholder, a byte-egress placeholder without the `allowRemote` opt-in, `samples × timeoutMs` exceeding `limits.roundTimeoutMs`, and derived-id collisions are all rejected at the schema layer.
- **Command contract**: a placeholder template (`<image:path>` / `<expect:file>` / `<image:base64:file>`) plus strict JSON on the last stdout line (`{passed, confidence?, reason}`). The expectation travels through a temporary file, avoiding command-line escaping and length limits and keeping it out of the process command line and system audit logs; temporary files are deleted in `finally` after each sample. Per rule you may override `command`/`argsTemplate`/`cwd`/`env`/`samples`/`allowRemote`.
- **Judgement debouncing**: serial sampling within an item plus a majority vote (split votes yield `uncertain`) and an optional confidence gate (`minConfidence`); a task-level input-hash cache whose key covers the image digest, expectation, command string, the **command's absolute path and binary digest**, argument template, cwd, environment-value digest (no plaintext), `allowRemote`, `samples`, and `minConfidence`. Upgrading your CLI invalidates it automatically; when the command's identity cannot be computed reliably nothing is cached; only completed judgements are stored.
- **Results and reports**: `VisualResult.kind` gains `"content"` and `status` gains `"uncertain"`. Content items render the expectation, sample votes, reasons, provider command, and cache hit in both the Markdown report and the offline HTML, and are annotated with "minConfidence did not apply" when the command reports no confidence. The HTML status filter gains an `uncertain` option.
- **CLI and diagnostics**: `visual content probe <project> [ruleId]` (runs a real judgement for the declared rules without writing evidence or cache) and `visual content cache clear <taskId>`; `visual doctor` gains `content command` (per-rule effective resolution plus the `allowRemote` declaration list, failing that finding when a command cannot resolve) and `content budget` (`rules × samples × timeoutMs` compared against `roundTimeoutMs` with a suggestion, never editing your configuration).

### Fixed

- **The repair plan listed `optional:true` failures as "must fix"** (the pre-existing defect issue #13's acceptance criteria require fixing): `repair-plan.ts` filtered only on `skipped`, so warning-only failures were listed under section 2. It now also requires `!c.optional` and adds section 3.2 "warning-only items (no fix required)" listing optional check failures plus `optional:true`/`uncertain` visual items, and section 5 states explicitly that artifacts must not be faked and checks must not be relaxed to silence a warning.

### Security

- The "zero credential management" section of [SECURITY.md](SECURITY.md) / [SECURITY.en.md](SECURITY.en.md) now covers the content-check boundary: judgement is delegated to a command you declare and the MCP reads/stores/forwards no credentials; whether images leave the machine depends on that command; and **the MCP's enforcement is contract-level only** (the byte-egress placeholder is disabled without an `allowRemote` opt-in), so it cannot stop a command from sending data out and users must confirm their command's behaviour themselves.

### Tests

- **644 passed / 12 skipped** overall (Windows 10 x64, Node 24.18.0), 112 cases more than v0.5.3: positive/negative cases for the 10 schema checks (including the budget-consistency counterexample), an exhaustive `tallyContentVotes` suite, cache-key stability and CLI-upgrade invalidation, placeholder expansion and stdout parsing, whole-round blockers producing no result rows (one each for a global and a rule-level override command), single-item failures staying warning-only and visible, repair-plan isolation, zero-rerun cache hits, probe and cache clearing, doctor content diagnostics, verdict-attribution regressions (`uncertain` and `optional:true` never fail a round; only `blocking:true` does), and the semantic-only page recording an explicit null baseline in the frozen snapshot (unaffected by stray baseline files).
- The 12 browser-gated cases run **12/12** on Windows 10 under `TIANSHU_VISUAL_BROWSER_TEST=1`, including 2 new ones covering the `pixel:false` semantic-page exemption and "one screenshot yields both a pixel and a content item".
- Real macOS system evidence was collected by CI: the target commit's `CI` workflow is green across all 22 jobs, 6 of them `visual-browser` jobs covering macOS 15 (Apple Silicon arm64) and macOS 15 Intel (x64) across Node 20/22/24.
- What is not covered is stated plainly: no measurement against a real third-party vision CLI; and "images never leave the machine" is not verifiable at the system level. See [validation progress](docs/visual-validation.en.md).

### Compatibility

- This is a **PATCH** release: the new capability is optional and **off by default**, and existing caller signatures, report fields, and the default behaviour of `pages`/`images` stay **backward compatible**. The one thing consumer code should note is enum growth — `VisualResult.status` gains `"uncertain"` and `kind` gains `"content"` — so anything that exhaustively switches on `status` must handle it.

---

## [0.5.3] — 2026-09-15

**ZCode hardware-revisit fixes (issue #12, second round)**: three defects found on hardware are fixed — GUI instances could not outlive the server on Windows, "new task" did not switch pages and everything waited silently, and send-failure attribution was misleading. See the [v0.5.3 release notes](docs/release-v0.5.3.en.md) and the [Windows 10 acceptance record](docs/zcode-issue-12-windows-evidence.en.md).

### Fixed

- **ZCode / Codex desktop instances could not outlive the server on Windows (found on hardware)**: the `zcode` and `codex` GUI instances were spawned behind a platform branch (`detached: process.platform !== "win32"`) while `traework` already used an unconditional `detached: true`. A minimal experiment (Windows 10 / Node 24.18.0) on the same spawn shows a non-detached child's survival after the parent exits is 0 and a detached child's is 1. As a result, as soon as the MCP server (or a one-shot smoke / probe script) exited on Windows, ZCode was killed along with it and `keptInstance`'s "instance survives the server exit" was a no-op — `needs_user` told the user to "handle it in ZCode, then call continue_task" while the window was already gone. The invariant now lives in one place, `guiInstanceSpawnOptions()`, shared by all three GUI instances (`codex` even branched `unref()` by platform; that branch is gone). The execution-type children in `verify/runner`, `visual/services` and `agents/spawn` keep their platform branch because their semantics are the opposite — they must be terminable as a group.
- **"New task" reported success without switching pages, then everything waited silently (found on hardware)**: when ZCode is parked on an existing conversation, the top-bar `conversation-new-task` is a lazily mounted icon — the click is dispatched and returns `true` but the page does not switch, and a conversation page's composer does **not** mount `composer-workspace-trigger`. Both the project-less default confirmation and the project-binding wait therefore idled until their deadline and reported nothing better than `needs_user/setup_recovery` (measured: 30 seconds of dead waiting). The draft is now verified by "the project trigger is mounted" after clicking new-task; when it is not, the flow falls back to the sidebar `task-new-button` (reliable on Windows 3.11.2; that fallback previously existed only on the project branch) and only fails closed with `setup_failed` — reporting "the trigger is still not mounted" — when both entry points fail.
- **Misleading attribution for send failures (found on hardware)**: when the window is minimised or fully occluded, Chromium throttles the page (`visibilityState=hidden`) and the send button becomes unclickable even though it sits inside the viewport — `elementFromPoint` does not hit the button itself. The old message said only "the ZCode send button was not enabled or was covered within the observation window", pointing users at the button; the driver now recognises that state and reports "the ZCode window is not in the foreground" together with the instruction to bring it forward. `Page.bringToFront` was measured to be **unable** to restore an occluded Electron window, so no automatic recovery is pretended.

### Tests

- Full suite: **532 passed / 10 skipped** (Windows 10 x64, Node 24.18.0), a net gain of 7 cases over v0.5.2: falling back to the sidebar entry when no draft is established and still dispatching, failing closed without sending when neither entry point creates a draft, attributing a send failure to "window not in the foreground" when the page is throttled, keeping the original button attribution when the page is visible, plus 2 regression cases for the GUI-instance spawn invariant (unconditional detached + unref across platforms).

### Docs

- The [issue #12 Windows 10 acceptance record](docs/zcode-issue-12-windows-evidence.en.md) gains a "second visit (after v0.5.2)" section: results and on-site evidence for 6 hardware runs, the reproduction criteria for the new-task page-switch failure, evidence for each send-stage failure mode, and the facts that were **not** reproduced or **not** verified this round (including that the true cause of the first `send_unknown` is still undetermined and that the new send diagnostic was never reached on hardware).

---

## [0.5.2] — 2026-09-14

**Project-less dispatch for ZCode (issue #12)**: `run_task`'s `projectPath` is now optional, letting ZCode run tasks in its `default` workspace; the companion `allowCreateProject` can forbid automatic project import. See the [v0.5.2 release notes](docs/release-v0.5.2.en.md) and the [Windows 10 acceptance record](docs/zcode-issue-12-windows-evidence.en.md).

### Added

- **Project-less dispatch for ZCode (issue #12)**: `run_task`'s `projectPath` is now optional. When omitted, ZCode runs the task in its `default` workspace — no directory assigned, no project registered or imported, no Git baseline, no project snapshot freeze, no project lock, no project acceptance. On success the task is marked structurally as `not_applicable: no_project` and the terminal message states "no project acceptance performed". `query_task` / `list_tasks` display such tasks normally; `verify_task` / `get_task_report` return an explicit not-applicable explanation instead of deriving a directory from cwd.
- **`allowCreateProject` (ZCode-only, optional boolean)**: omitted keeps the existing "auto-import when the target is unregistered" behaviour; explicit `false` stops dispatch **before any import side effect** when the target is unregistered, returning a recognisable `project_not_registered` reason with remediation (no native folder dialog, no project added). Other agents passing this parameter get an explicit "not supported" error rather than a silent ignore.
- **Windows 10 hardware acceptance record** (`docs/zcode-issue-12-windows-evidence{,.en}.md`): complete evidence for project-less dispatch and `allowCreateProject=false` on ZCode 3.11.2.6792, including the before/after comparison "ZCode project entries 34 → 34, 0 added / 0 removed".

### Fixed

- **Divergent project-trigger readiness criteria (issue #12 §5)**: waiting used `exists` (element has width/height only) while clicking went through `pick` (exactly one unclipped visible node in the winning tier), so an `exists=true` / `click=false` window existed. Waiting and clicking now share one **structured probe** that distinguishes not-mounted / mounted-but-invisible-or-clipped / ambiguous / disabled / covered / ready, plus a post-click condition: the project menu must actually open, and `menu-not-open` is classified separately.
- **Error message contradicting behaviour**: "waiting for the project trigger timed out" is no longer used for early exits (multiple matches, disabled) or a menu that never opened; failure text carries `selector`, match count and minimal hit-node attributes, and diagnostics log attempt count, elapsed time and remaining budget.
- **Centralised timeout**: new `gui.projectTriggerTimeoutMs` (default 15s) replaces the two hard-coded `15_000` literals; the whole "wait → one sidebar fallback → wait" sequence shares a single deadline, retries do not reset the budget, and it is clamped by the setup-recovery budget and the task deadline.
- **`projectPath` was never opened up in the MCP schema (found on hardware)**: the handler already had the project-less branch, but `RunTaskParamsSchema.projectPath` was still required, so a real `run_task` was rejected by the SDK with `-32602 Required at projectPath`. Unit tests call the handler directly and therefore bypass `inputSchema`, which is why a green suite missed it. Changed to `AbsPath.optional()`, plus a protocol-level regression case in `test/integration/task-flow.test.ts` asserting neither `-32602` nor `Input validation error` appears.
- **No "work outside a project" switch, and the menu click was undone by toggle semantics (found on hardware)**: ZCode's "New task" inherits the previous binding, so project-less dispatch parked at `needs_user` forever; meanwhile `clickProjectTriggerAndConfirm` kept clicking the trigger even when the project menu was **already open**, closing the Radix dropdown and then polling until its deadline, misreported as "the project menu did not open". Added the `workOutsideProject` selector and `enterDefaultWorkspace()` for an explicit switch (confirmed by `workspaceBinding` read-back, not by click success), made the click check the menu state first, and made `confirmDefaultWorkspace` return immediately for "definitely bound to a project".

---

## [0.5.1] — 2026-09-14

Documentation and validation-evidence completion; **no runtime behaviour changes**. See the [v0.5.1 release notes](docs/release-v0.5.1.en.md) for details.

### Added

- `npm run evidence:visual:windows` (`scripts/evidence-visual-windows.mjs`): collects the full Windows 10 local functional matrix (existing/static/command sources, port conflict that blocks without terminating another service, bounded readiness failure that cleans up the child process, local Edge isolated instance and version mismatch, missing-browser blocker), 9/9 passed.
- `docs/visual-validation-evidence/`: raw machine-readable validation records (Windows 10 matrix JSON and test output, macOS dual-architecture `environment.json`, macOS CI summaries), distributed with the package.

### Fixed

- Stale `package-lock.json` root version: the lockfile still said `0.4.1` at the v0.5.0 release while `package.json` said `0.5.0`; both are now synced to `0.5.1`.

### Tests

- Two additional real-browser-gated visual cases: screenshots succeed when the project path contains CJK characters and spaces; a main-document 302 redirect to a non-allowlisted origin is blocked by policy and passes once explicitly allowed. Full suite: **486 passed / 10 skipped**.
- Collected macOS 13+ platform evidence: on macOS 15 hardware runners, Intel x64 and Apple Silicon arm64 (Node 20/22/24) each passed 10 files with 51 cases.

### Docs

- **Skill docs (`skills/tianshu-mcp/`) aligned with the code**: `SKILL.md` now lists all 11 tools with capability/approval columns (including `prepare_visual_baseline`/`approve_visual_baseline`), gives visual acceptance its own section (blockers do not trigger repair; `rework_task` re-verifies first; baseline approval and freezing), adds `setup_recovery` and the `errorType` value set to the error table, corrects agent status semantics (`traework` is always `ready`; `codex` is platform-dependent) and notes that `continue_task` only supports codex/zcode. `usage-examples.md` fixes the claim that `get_task_report` carries a meta block, removes the mis-listed `reasoningLevel` from the meta table, distinguishes the auto repair-plan location per agent (codex writes inside the project's `.zcode/plans/`; others write to the task directory), and adds the actual `list_tasks` output columns plus the visual CLI commands.
- `docs/visual-validation{,.en}.md` rewritten with full platform evidence tables (system, Node, browser version, command, result).
- Bilingual README and HANDOFF updated against the current code and commit history.

---

## [0.5.0] — 2026-09-14

Adds an **optional visual acceptance module** that wires screenshot comparison and static image specification checks into the "develop → verify → repair → re-verify" loop. Projects that do not enable visuals behave compatibly, and legacy reports and task snapshots remain readable. See the [v0.5.0 release notes](docs/release-v0.5.0.en.md) for the full description.

### Added

- **Page sources**: mutually exclusive `existing` / `command` / `static`; identical service definitions share one managed instance per round; the static host rejects traversal and out-of-project symlinks; an occupied port blocks instead of reusing or terminating another service.
- **Screenshots and interaction**: `viewport` / `fullPage` / `element` modes with declarative `click` / `input` / `hover` / `scroll` / `wait` steps; a fixed readiness flow (isolated context, login state, fonts and images, disabled animations, masks, sampling); bounded full-page scrolling to trigger lazy loading.
- **Stabilization and masks**: up to 3 samples taking two adjacent identical captures; continuously changing pages, exceeded pixel budgets and unstable captures block; an unmatchable mask selector or a fully masked image never passes.
- **Pixel comparison**: unified PNG; size mismatches fail without scaling; masked regions are excluded from numerator and denominator; pixelmatch antialiasing is excluded by default; connected-component analysis outputs coordinates, areas and an annotated image, keeping at most 100 regions while recording the remaining count and overall bounds.
- **Static image specifications**: explicit file lists; encoded-format/extension consistency, existence with complete decoding, EXIF-orientation-normalized dimensions, aspect ratio, byte size, optional DPI and real-transparent-pixel detection; unsupported formats are reported explicitly.
- **Two-phase baselines**: `prepare` produces a candidate (candidate ID, digest, target paths, preview) and `approve` verifies candidate/original-baseline/configuration digests before atomically writing the official baseline and manifest; a missing baseline can only produce a candidate and never a pass; automatic repair never calls the approval entry point.
- **Rule freezing**: visual configuration and baseline digests are saved before the agent starts and checked around each round; changes require a new snapshot through the dedicated `rules review` / `rules approve` flow.
- **MCP tools**: new `prepare_visual_baseline` and `approve_visual_baseline`, both side-effecting `write` operations requiring host approval.
- **CLI**: new `tianshu-mcp visual` subcommand (`init`, `browser install`, `doctor`, `baseline prepare/approve`, `rules review/approve`, `artifacts clean`), dispatched before the stdio connection.
- **Reports and artifacts**: `VerifyReport` gains an optional `visual` field and `files.html`; the offline HTML supports status filtering, side-by-side images, opacity overlays and region location with only local artifacts, escaped text and no CDN; each round's artifacts live at `<home>/tasks/<taskId>/visual/<round>/` with rounds allocated by a unified task-level lock.
- **Blockers and recovery**: distinguishes repairable defects, environment blockers and user cancellation; visual blockers enter `needs_attention` with a re-verification-pending marker; `rework_task` re-verifies first for visually blocked tasks and only real defects consume the repair budget; both the generic and Codex-specific repair plans include visual evidence and state that baselines, thresholds and switches must not be modified to bypass failures.
- **Configuration robustness**: an invalid acceptance configuration blocks explicitly instead of falling back silently; only an explicit `checks: []` disables command checks; `extraChecks` and `checksMode=replace` never override the visual gate; `visual` strictly validates unknown fields, duplicate IDs, empty rules and conflicting options.
- **Dependencies and runtime**: pinned `puppeteer-core@24.43.1`, `@puppeteer/browsers@2.13.2`, `sharp@0.34.5`, `pixelmatch@7.2.0`; the image library is an optional dynamic dependency whose absence does not prevent startup; browsers are installed explicitly on demand with no download during npm install or MCP startup; the visual module requires Node.js >=20.3 while non-visual features retain >=20.
- **Docs and gates**: new bilingual visual acceptance guide and validation progress; CI adds a real-browser matrix (ubuntu/windows/macos-intel/macos × Node 20/22/24) plus production-package consumer acceptance; release requires a successful CI for the target commit and blocks when mirror credentials are missing.

### Fixed

- The acceptance engine no longer silently falls back to default checks when a project configuration is invalid; it blocks explicitly with a reason.
- Manual and automatic verification share the task-level lock for report round allocation, preventing concurrency or recovery from overwriting historical evidence.
- Manual verification now lands a visually blocked task in `needs_attention` instead of misreporting `failed`.
- `rework_task` allows a visually blocked task that lacks original session location information to re-verify first instead of being rejected outright.
- The ZCode recovery budget now determines the controlling reason before aborting dependent operations, so the reason is not overwritten by downstream abort listeners.
- `TaskOrchestrator` distinguishes "cancelled" from "blocked" when a visual integrity problem appears during startup, so cancellation is no longer misrecorded as `needs_attention`.

### Tests

- Full suite: **486 passed / 8 skipped** (Windows 10 x64, Node 24.18.0), adding visual configuration, image specification, report, baseline, budget, snapshot, service, real-browser capture, flow and repair cases.
- The 8 real-browser-gated cases pass separately with `TIANSHU_VISUAL_BROWSER_TEST=1`; the production tarball visual smoke test passes in an isolated consumer.

---

## [0.4.1] — 2026-09-13

Documentation release: the orchestration skill docs are aligned with the actual v0.4.0 tool
surface, and the open-source repos now credit community contributors. No code behaviour changes.

### Docs

- **Skill docs fully aligned with the v0.4.0 tool surface** (`skills/tianshu-mcp/`, idempotently synced
  into `~/.rivet/skills/tianshu-mcp/` at server startup):
  - `SKILL.md` now documents the **projectPath safety gate** (absolute path + existing directory +
    realpath canonicalization, rejection of the home directory and system/root directories, dirty-repo
    warning), so an infrastructure rejection is not mistaken for an agent failure.
  - `SKILL.md` adds a **hard-failure error-code reference** (`setup_failed`/`project_ambiguous`/
    `project_mismatch`/`model_unavailable`/`model_mismatch`/`permission_unknown`/`cdp_disconnected`/
    `instance_busy`/`session_lost`/`input_mismatch`/`send_unknown`/`idle_timeout` and more), stating
    that hard failures never enter acceptance or auto-rework.
  - `SKILL.md` covers all `needs_user` kinds, including the new `setup_recovery` (zcode initialization
    recovery exhausted), plus `continue_task` state/type restrictions and the refusal semantics when the
    zcode session anchor is lost.
  - `SKILL.md` documents the `codex-cli` headless path (user-defined `driver=spawn` profile, `model` not
    applicable, CLI ≥0.154.0 requirement), the `ready`/`research` status semantics, **default-parallel 2**
    acceptance checks (`verifyConcurrency`), and the `requireChanges` zero-change gate.
  - `usage-examples.md` adds: a `codex-cli` dispatch example; the **full meta-block field table** (now
    including `agentEndReason`/`lastRunSignal`/`checks`/`round`/`keptInstance`/`zcodeSessionId`/
    `modelProvider`/`permissionMode`/`progressSummary`); an **error-code reference table**; a project-level
    `.tianshu-mcp/acceptance.json` template (with the parallel-interference warning and `requireChanges`
    guidance); a `setup_recovery` recovery example; and the profile whole-key override semantics.
- **Bilingual README contributor credits**: a new "Contributors" section lists, in order of first
  participation, the community members who took part through Issues and pull requests (avatar + name).

### Other

- `package.json` version bumped to `0.4.1` (`serverInfo.version` is synced automatically at build time).

---

## [0.4.0] — 2026-09-13

### Added

- `projectPath` safety gate: `run_task`/`verify_task` validate at submission (absolute path +
  existing directory + realpath symlink resolution), reject the home directory itself and
  system/root directories (including macOS `/private/*` realpath forms); the submission receipt
  notes symlink resolution; dirty git repos get an uncommitted-changes coexistence warning.
- ZCode GUI driver supports macOS: adapts to the main process rewriting its title (relaxed port
  attribution + bounded scan of the configured port range when argv hides the debug port) and
  detached+unref instance persistence; the folder-panel driver is rewritten for the macOS window
  form (NSOpenPanel as a standalone window + AX value write into the go-to field, immune to IME
  interception). Machine-verified closed loop on 2026-09-13 (macOS arm64, ZCode 3.11.2: bind →
  readback → send → run evidence → acceptance PASS → succeeded); macOS stays `research` until
  the cancel/rework/new-project matrix is covered.
- Codex GUI driver supports macOS: spawns the ChatGPT.app bundle executable directly
  (per-platform `activation` default spawn/msix-com) with detached+unref instance persistence;
  POSIX process enumeration and SIGTERM stop; default discovery dirs on darwin; project
  registration writes the shared state file (`~/.codex/.codex-global-state.json`) on darwin too;
  the observation loop reconnects CDP across transient renderer hangs / target replacement
  (only 5 consecutive failures count as disconnected). Machine-verified closed loop on
  2026-09-13 (macOS arm64: discover → register → bind → send → run evidence → acceptance PASS
  → succeeded); macOS stays `research` until the cancel/rework matrix is covered.

### Fixed

- zcode macOS new-task inert-button fallback: `conversation-new-task` can hit an inert home-screen
  icon (click does nothing); when the project trigger misses, the flow now falls back to the
  sidebar `[data-testid=task-new-button]` and retries.
- `normalizeProjectPath` resolves symlinks: macOS `/tmp`→`/private/tmp` used to fail project
  path matching and degrade into a name match, falsely reporting `project_ambiguous`;
  falls back to lexical normalization when realpath fails.
- zcode macOS panel failures no longer misreport `needsPermission`: the execFile message embeds
  the full script text (containing the `ACCESSIBILITY_PERMISSION_REQUIRED` literal), so every
  failure looked like a permission problem — the check now reads the stderr execution-error line.
- `get_profiles` now lists user-defined profiles from the data-directory `agent-profiles.json`
  (previously hidden until first resolve, even though `run_task` could already use them — inconsistent discovery feedback).
- zcode-flow test stubs now cover `listDialogs`, removing a flake where real osascript/PowerShell
  calls blew the `taskTimeoutMs` wall-clock budget under full-suite load.
- CDP `connect()` failure paths now dispose of the WebSocket themselves (no longer relying on
  callers to disconnect); the `send()` timeout timer is unref'd.
- **Drive roots were not rejected by the `projectPath` gate** (Windows): `normPath` strips the
  trailing slash (`D:\` -> `d:`), which never equals the `d:/` entries in the reject list, so the
  gate was effectively a no-op for drive roots; a dedicated drive-root check now covers every
  drive letter instead of relying on enumeration.
- `test/unit/project-dir-guard.test.ts` had a non-portable system-directory assertion: `/etc` and
  `/usr` are POSIX paths, and on Windows they hit "directory does not exist" rather than the reject
  list; the assertion is now platform-branched and verifies drive roots plus `C:/Windows` on Windows.
- `test/unit/acceptance-parallel.test.ts` cancellation case was flaky (green alone, red in a full
  run): a fixed 250ms delay can precede the child spawn on slower platforms, mislabelling an
  in-flight check as `skipped`; it now waits until both in-flight checks have really started.

### Performance

- All `execFileSync`/`spawnSync` calls across GUI instance probing, discovery and registration
  are now async; ready-wait loops reuse a per-tick process snapshot with a 1.5s TTL cache —
  eliminating event-loop freezes during Windows polling (up to 30s per call).
- Acceptance command checks run with bounded parallelism: new `verifyConcurrency` (**⚠ default
  changed from serial to 2**, range 1–4; project-level `.tianshu-mcp/acceptance.json` overrides,
  1 = fully serial — set 1 explicitly for checks that write build outputs, run with `--fix`, or
  share cache directories); logs are concatenated in declaration order with unchanged format;
  cancellation interrupts both in-flight and pending checks.
- Git baseline hashing is single-pass with bounded async concurrency (untracked cap 5000);
  code analysis reads each file at most once, sniffing only a prefix of large files.
- `get_profiles` and task snapshot reads now use `Promise.all`.
- Test suite 267s → 51s: traework UI-layer sleeps are injectable (production defaults unchanged);
  vitest split into parallel unit / serial integration projects.
- `tsconfig.build.json` no longer emits declarations — 70 `.d.ts` files dropped (140 → 71 files).

### Documentation

- README (both languages) gains "macOS headless path: codex-cli (user profile)" — including the
  revoked-certificate warning for ≤0.130.0 and a complete profile example.

---

## [0.3.4] — 2026-09-13

- Fix #8/#10 project-selector ambiguity, full-path binding false negatives and contaminated model readback.
- Fix #9 environment recovery without a session: send full task/context/references once and locate the session through its marker or unique delta.
- Add initialization recovery with shared deadlines, configurable budgets and a resumable `setup_recovery` state. Reconcile native side effects after timeouts and terminate helper processes on cancellation.
- Handle split model labels, hidden outgoing animation text, residual project menus trapping focus and send buttons that are not yet ready.
- Add real DOM and recovery/cancellation regressions. Windows hardware verifies cold first import, imported-project reuse and same-task recovery with actual artifacts and 2/2 acceptance checks.
- Published as a GitHub Release/tarball and to npm (`latest`). macOS has no real-device verification for this patch and the ZCode profile remains `research`.

See [release notes](docs/release-v0.3.4.en.md) and [validation evidence](docs/zcode-issue-8-10-validation.en.md).

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

[0.5.8]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.5.7...v0.5.8
[0.5.7]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.5.6...v0.5.7
[0.5.6]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.5.5...v0.5.6
[0.5.5]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.5.4...v0.5.5
[0.5.4]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.3.4...v0.4.0
[0.3.4]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.3.3...v0.3.4
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
