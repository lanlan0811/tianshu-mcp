# Visual acceptance validation progress

[中文](visual-validation.md)

Plan: local `.codex/plans/2026-09-14-issue-3-visual-acceptance-plan.en.md` (Chinese file of the same name), both still Git-ignored. The v0.5.0 code, documentation and local gates are complete; release gates and macOS hardware evidence remain.

## Executed

**Local environment**: Windows 10 Pro x64 (10.0.19045), Node 24.18.0, managed Chrome 148.0.7778.97.

- Isolated browser launch, 390×844 PNG capture and full decoding passed (`TIANSHU_VISUAL_BROWSER_TEST=1`). Raw screenshots and environment records stay locally in the Git-ignored `.tmp-check/visual-windows`.
- **Full suite: 486 passed / 8 skipped** (the 8 skipped cases are real-browser-gated and pass 8/8 when run with `TIANSHU_VISUAL_BROWSER_TEST=1`):
  - Real browser: managed browser launch and decoding, three page sources, input/click/hover/select/scroll, full-page lazy loading, Cookie/localStorage import and expiration diagnosis, external resource allow/block, screenshot difference and rule freezing.
  - Non-browser: strict visual configuration validation, image specifications and boundaries, baseline candidate/approval/tamper rejection, frozen rule snapshots, task-level round exclusivity, blocker recovery that verifies first, both repair plans carrying visual evidence, and legacy/protocol regressions.
- **Isolated production-tarball consumer acceptance passed**: `npm pack` → install into a directory without dev dependencies → approve a baseline → image specification check → detect a real pixel defect → offline HTML usable with networking off (status filter, opacity overlay, region selection). Command:
  ```sh
  TIANSHU_VISUAL_REPORT_EVIDENCE=.tmp-check/visual-evidence/report.png \
    node scripts/check-visual-consumer.mjs --package-dir <consumer>/node_modules/tianshu-mcp
  ```
- `typecheck`, `lint`, `build`, `pack:check` and the strict stdio check all pass; the build leaves no unexpected tracked changes.

## Remaining gates

- Real **macOS 13+ Intel and Apple Silicon** system/Node/browser evidence; the full Windows 10 functional matrix (port conflicts, readiness failure, cancellation cleanup, Chinese and space-containing paths, out-of-project symlinks, managed vs local browser and version mismatch).
- **CI**: the new `visual-browser` matrix (ubuntu/windows/macos-15-intel/macos-15 × Node 20/22/24) must actually run green on the target commit; locally only Windows 10 x64 with Node 24 was verified.
- **Release**: matching GitHub/Gitee `master`, v0.5.0 dual-repo tags, the release workflow result and both actual release records. The release requires a successful CI for the target commit and blocks when `GITEE_TOKEN` is missing.

Unexecuted checks must not be reported as passing. Missing target platforms or release credentials remain blockers.
