# Visual acceptance validation progress

[中文](visual-validation.md)

Plan: local `.codex/plans/2026-09-14-issue-3-visual-acceptance-plan.md`, still Git-ignored. Target v0.5.0 is not released; full acceptance is not complete.

## Executed

- 2026-09-14, Windows 10 Pro x64 (10.0.19045), Node 24.18.0, managed Chrome 148.0.7778.97: isolated browser launch, 390×844 PNG capture and full decoding passed.
- Command: `TIANSHU_VISUAL_BROWSER_TEST=1 npx vitest run test/integration/visual-browser-smoke.test.ts` (use `$env:` in PowerShell). Raw screenshot and environment evidence stay locally in Git-ignored `.tmp-check/visual-windows`.
- 34 targeted configuration/legacy acceptance tests passed; 23 visual configuration/image/real browser baseline flow tests passed.

## Remaining gates

- Full suite, complete browser interaction/network/cancellation/repair matrix, isolated tarball consumer validation.
- Actual macOS 13+ Intel and Apple Silicon OS/Node/browser evidence; full Windows 10 functional matrix.
- Three-system Node 20/22/24 CI and dedicated visual workflow results for the target commit.
- Matching GitHub/Gitee master, v0.5.0 tags, release workflow and both actual release records.

Unexecuted checks must not be reported as passing. Missing target platforms or release credentials remain blockers.
