# tianshu-mcp v0.5.0 Release Notes

**Core theme**: a new **optional visual acceptance module** that wires screenshot comparison and static image specification checks into the existing "develop → verify → repair → re-verify" loop. Projects that do not enable the visual module behave exactly as before.

This is a **MINOR** release: new functionality and two MCP tools, with no breakage of existing tool parameters, report fields or acceptance configuration formats; legacy reports and legacy task snapshots remain readable.

## Added

### Visual acceptance module (optional, off by default)

After adding a `visual` object with `enabled: true` to a project's `.tianshu-mcp/acceptance.json`, `run_task` / `verify_task` automatically carry an independent visual dimension; with no configuration, or with an explicit `enabled: false`, the existing acceptance path is used unchanged.

- **Three mutually exclusive page sources**: `existing` (a local HTTP/HTTPS service that is not managed), `command` (a structured command and arguments that start a service, cross-platform process-tree cleanup, hidden window on Windows), `static` (temporary HTTP hosting of a project subdirectory on a system-assigned port, rejecting traversal and out-of-project symlinks).
- **Screenshots and interaction**: `viewport` / `fullPage` / `element` modes; declarative `click` / `input` / `hover` / `scroll` / `wait` steps; a fixed readiness flow (isolated context → import login state → declarative steps → font and image readiness → disable animations and transitions → apply masks → sample until two adjacent captures match). The first version does not accept arbitrary JavaScript preparation scripts.
- **Stabilization**: up to 3 samples taking two adjacent identical captures; full-page mode scrolls within bounds to trigger lazy loading; a continuously expanding page, an exceeded pixel budget, or an inability to stabilize blocks. Masks must be listed in the report; an unmatchable configured mask or a fully masked image never passes.
- **Pixel comparison**: unified PNG; a size difference fails directly without scaling or cropping; masked regions are excluded from numerator and denominator; pixelmatch antialiasing differences are excluded by default; the pass condition is `different pixels / effective pixels <= maxDiffRatio`; connected-component analysis outputs coordinates, areas and an annotated image, keeping the 100 largest regions and recording the remaining count and overall bounding box.
- **Static image specifications**: explicit file lists; validation of encoded format versus extension, existence and non-emptiness with complete decoding, EXIF-orientation-normalized dimensions, aspect ratio, byte size, optional DPI and transparency (judged by real transparent pixels). GIF/SVG/animated WebP/APNG or other unsupported formats are reported explicitly. Metadata and size limits are checked before decoding.
- **Login-state import**: test cookies and origin-grouped localStorage; the report records only whether loading succeeded and never copies state contents.
- **Network policy**: only local HTTP/HTTPS entries; external fonts, images, APIs and WebSocket origins must be explicitly allowed; validation continues after redirects; a blocked resource reports the blocker and origin instead of capturing a broken page and passing.
- **Browser lifecycle**: defaults to an explicitly installed pinned browser, while also supporting the local Chrome/Edge or a specified executable path; isolated temporary user directory and isolated acceptance instance that never connects to the daily browsing session; a missing managed browser blocks with the install command instead of silently falling back to the local browser; pages, browser, services and temporary directories created by the run are cleaned up on completion, timeout, cancellation and MCP shutdown.

### Baseline management and freezing

- **Two phases**: `prepare` produces a candidate (candidate ID, content digest, target paths, preview report, stored in the MCP data directory); `approve` verifies the candidate digest, the original baseline digest and the current configuration digest, then atomically writes the official baseline and manifest.
- **Default layout**: `<baselineRoot>/<platform>/<browserKind>/<caseId>/<viewportId>.png`, with a manifest recording the full browser version, system information, viewport, DPR, effective screenshot configuration, reference-image summary and approval information.
- **A missing baseline can only produce a candidate and never a visual pass**; automatic repair never calls the approval entry point; a modified candidate, a changed original baseline or a candidate from another project is refused; approval and task execution share a project-level lock against concurrent overwrites.
- **Rule freezing**: the visual configuration and baseline digests are saved before the agent starts and checked around every round (disabling visuals, editing rules or swapping baselines is detected and blocks); changes require a new snapshot through the dedicated `rules review` / `rules approve` flow.

### MCP, CLI and reports

- Two new MCP tools, both side-effecting `write` operations marked as requiring host approval:
  - `prepare_visual_baseline`: project path, optional check/viewport lists and reference-import mapping; returns candidate ID, digest and preview locations.
  - `approve_visual_baseline`: candidate ID, expected digest, approval note and optional blocked task ID; verifies then adopts the baseline and updates the task snapshot as needed.
- New CLI subcommand `tianshu-mcp visual`: `init`, `browser install`, `doctor`, `baseline prepare/approve`, `rules review/approve`, `artifacts clean`. The CLI branches before the MCP stdio connection, so normal MCP startup stdout keeps carrying only valid protocol messages.
- **Report extension**: `VerifyReport` gains an optional `visual` field and `files.html`; a visual result contains the check ID, page/image kind, viewport, `passed`/`failed`/`blocked`/`skipped` status, `optional`, stable reason code, description, duration, actual metrics, effective rules, browser and system environment, diff regions, masks, artifacts and auto-repairability. The new fields are omitted when visuals are disabled.
- **Offline HTML**: browsing by check and status, side-by-side baseline/actual/diff images, overlay opacity control and diff-region location; it uses only local artifacts and inline resources, escapes text correctly, does not depend on a CDN and uses SVG icons.
- Each round's artifacts live at `<MCP data directory>/tasks/<taskId>/visual/<reportRound>/`; report rounds are allocated by a unified task-level lock shared by automatic verification, manual verification and recovery, preserving all historical rounds.

### Verdict and recovery semantics

- Unified verdict priority: user cancellation/server interruption → configuration or integrity error/required-check blocker → real defect in a required check (repair under `autoFixRounds`) → all pass.
- Unreachable pages, missing browsers, baselines awaiting approval, blocked resources and unstable screenshots are **blockers** that enter `needs_attention` with a "re-verification pending" marker; layout differences, image specification errors and locatable interaction failures are **defects** that go to repair.
- For a visually blocked task, `rework_task` **re-verifies first without starting a development agent**: a pass ends the task, continued blocking returns to `needs_attention`, and only a real defect consumes the repair budget.
- Both the generic repair plan and the Codex-specific plan include visual evidence (check ID, route/file, viewport, expected and actual metrics, diff regions and evidence paths) and state explicitly that baselines, thresholds, masks and check switches must not be modified to bypass failures.
- `artifacts clean` previews by default; `--apply` cleans only the given task's visual artifacts while retaining reports and a cleanup marker and never deletes official baselines; exceeding the artifact budget blocks instead of deleting old evidence for a pass.

### Acceptance-configuration robustness

- File absent: keep the existing default command-check derivation.
- File present but JSON/schema invalid: emit a configuration blocker instead of **silently falling back** to default checks.
- Visual enabled with `checks` omitted: keep deriving command checks; only an explicit `checks: []` disables configured command checks.
- `extraChecks` and `checksMode=replace` apply only to command checks and never override the visual gate.
- `visual` uses strict field validation, rejecting typos, duplicate IDs, invalid thresholds and conflicting options; enabling visuals with no page or image rule is a configuration error; every item is required unless explicitly marked `optional: true`.

## Compatibility and dependencies

- **Runtime**: non-visual features retain Node.js `>=20`; the visual module requires Node.js `>=20.3`.
- **Optional image dependency**: a missing `sharp` does not prevent MCP startup; using the capability blocks explicitly with `npm install --include=optional`.
- **Pinned dependencies**: `puppeteer-core@24.43.1`, `@puppeteer/browsers@2.13.2`, `sharp@0.34.5`, `pixelmatch@7.2.0`; bundled Chrome `148.0.7778.97`, with the installer reading the version from the dependency revision map rather than duplicating it in business code.
- **No automatic browser download**: neither npm install nor MCP startup downloads a browser; run `tianshu-mcp visual browser install` explicitly.
- **Platform boundaries**: Windows 10 x64; macOS 13+ (Intel and Apple Silicon); the Linux CI and Node 20/22/24 test matrix are retained.

## Tests and validation

- **Windows 10 local (10.0.19045 x64, Node 24.18.0, Chrome 148.0.7778.97)**:
  - Full suite: **486 passed / 8 skipped** (the 8 skipped ones are real-browser-gated cases, separately passing with `TIANSHU_VISUAL_BROWSER_TEST=1`: managed browser launch and full decoding, three page sources, input/click/hover/select/scroll, full-page lazy loading, Cookie/localStorage import and expiration diagnosis, external resource allow/block, screenshot difference and rule freezing).
  - Installing the production tarball into an isolated directory without dev dependencies and running the visual smoke test passes: approve baseline → image specification check → detect a real pixel defect → offline HTML usable with networking off (status filter, opacity overlay, region selection).
  - `typecheck` / `lint` / `build` / `pack:check` / strict stdio check pass.
- **CI**: a new `visual-browser` matrix (ubuntu/windows/macos-15-intel/macos-15 × Node 20/22/24) explicitly installs the pinned browser and then runs real-browser visual tests plus production-package consumer acceptance; `build-test` and `pack-check` are retained.
- **Release gates**: the release workflow requires a **successful CI** for the target commit and blocks when `GITEE_TOKEN` is missing, so skipping the mirror release or substituting the Release run cannot masquerade as a completed dual-repo release.
- **Release outcome (verified)**: CI for the target commit `b1505f5` is fully green (all four visual-matrix systems × Node 20/22/24 succeeded); the `Release` workflow succeeded, and both the GitHub release (not a draft, with the `tianshu-mcp-0.5.0.tgz` asset) and the Gitee release (id 1143672, targeting `b1505f5`) were created, with both repos' `master` and `v0.5.0` tags pointing at the same commit.
- **Platform evidence**: the full Windows 10 x64 local functional matrix (`existing` / static / command / port conflict / readiness failure / cancellation cleanup / local Edge / version mismatch / missing-browser blocker) passed 9/9; on macOS 15 hardware runners, Intel x64 and Apple Silicon arm64 (Node 20/22/24) each passed 10 visual files with 51 cases. System, Node, browser versions, commands and results are in [validation progress](visual-validation.en.md), with raw records in [visual-validation-evidence/](visual-validation-evidence/).
- **Known limitations**: macOS evidence comes from CI-hosted hardware runners and was not re-verified on a maintainer's personal macOS device; the website directory is out of scope.

## Upgrade notes

- **No migration required**: caller tool parameters, meta-block fields, existing report fields and acceptance configuration formats remain compatible; visual fields appear only when enabled.
- Existing projects are unaffected by default (`visual.enabled` defaults to `false`).
- Enabling visuals for the first time requires installing the browser explicitly and preparing and approving baselines; page checks with unapproved baselines block rather than passing falsely.
- To genuinely share a reference across machines, specify it explicitly in the check; otherwise baselines are partitioned by platform and browser kind.

Related docs: [Visual acceptance guide](visual-acceptance.en.md) | [Validation progress](visual-validation.en.md) | [Project README](../README.en.md) | [CHANGELOG](../CHANGELOG.en.md) | [Skill docs SKILL.md](../skills/tianshu-mcp/SKILL.md)
