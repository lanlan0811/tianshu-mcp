# Visual acceptance validation progress

[中文](visual-validation.md)

Plan: local `.codex/plans/2026-09-14-issue-3-visual-acceptance-plan.en.md` (Chinese file of the same name), both still Git-ignored. The v0.5.0 code, documentation and local gates are complete; release gates and macOS hardware evidence remain.

## Executed

**Local environment**: Windows 10 Pro x64 (10.0.19045), Node 24.18.0, managed Chrome 148.0.7778.97.

- Isolated browser launch, 390×844 PNG capture and full decoding passed (`TIANSHU_VISUAL_BROWSER_TEST=1`). Raw screenshots and environment records stay locally in the Git-ignored `.tmp-check/visual-windows`.
- **Full suite: 486 passed / 10 skipped** (the 10 skipped cases are real-browser-gated and pass 10/10 when run with `TIANSHU_VISUAL_BROWSER_TEST=1`):
  - Real browser: managed browser launch and decoding, three page sources, input/click/hover/select/scroll, full-page lazy loading, Cookie/localStorage import and expiration diagnosis, external resource allow/block, main-document 302 redirect origin validation, CJK/space-containing project paths, screenshot difference and rule freezing.
  - Non-browser: strict visual configuration validation, image specifications and boundaries, baseline candidate/approval/tamper rejection, frozen rule snapshots, task-level round exclusivity, blocker recovery that verifies first, both repair plans carrying visual evidence, and legacy/protocol regressions.
- **Isolated production-tarball consumer acceptance passed**: `npm pack` → install into a directory without dev dependencies → approve a baseline → image specification check → detect a real pixel defect → offline HTML usable with networking off (status filter, opacity overlay, region selection). Command:
  ```sh
  TIANSHU_VISUAL_REPORT_EVIDENCE=.tmp-check/visual-evidence/report.png \
    node scripts/check-visual-consumer.mjs --package-dir <consumer>/node_modules/tianshu-mcp
  ```
- `typecheck`, `lint`, `build`, `pack:check` and the strict stdio check all pass; the build leaves no unexpected tracked changes.
- **CI on the target commit succeeded**: the `CI` workflow for `b1505f5` is fully green (`visual-browser` all four systems × Node 20/22/24 succeeded, `build-test` and `pack-check` succeeded). The earlier `df7eb18` CI failed once in `Build & Test (ubuntu-latest / Node 20)` on a `zcode-flow` task-deadline timing race unrelated to the visual module; that case passes locally and in later CI.
  - Link: https://github.com/lanlan0811/tianshu-mcp/actions/runs/34838565104
- **v0.5.0 release completed and verified**:
  - The `Release` workflow succeeded, including the "require a successful CI for this commit" and "mirror credentials present" gates and the GitHub/Gitee publish steps. Link: https://github.com/lanlan0811/tianshu-mcp/actions/runs/34839014803
  - GitHub release: `tag v0.5.0` (not a draft) with asset `tianshu-mcp-0.5.0.tgz` and a bilingual body.
  - Gitee release: `tag v0.5.0` (id 1143672) created, targeting `b1505f5`, with a bilingual body.
  - Both repos are consistent: `github/master`, `gitee/master`, both remotes' `v0.5.0` tags and the local tag all resolve to `b1505f5`.
- **npm registry is out of scope this round**: per the plan ("does not additionally add npm registry publishing"), the npm package remains at `0.4.1`.

## Remaining gates

- Real **macOS 13+ Intel and Apple Silicon** system/Node/browser evidence; the full Windows 10 functional matrix (port conflicts, readiness failure, cancellation cleanup, managed vs local browser and version mismatch). CJK/space-containing paths and external-resource redirect validation are already covered by real-browser cases; CI macOS runner results cannot substitute for a maintainer's verification record on real macOS hardware.

Unexecuted checks must not be reported as passing. Missing target-platform evidence remains a blocker.
