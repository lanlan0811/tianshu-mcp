# Changelog

All notable changes to `tianshu-mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Chinese version: [CHANGELOG.md](CHANGELOG.md)

---

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
