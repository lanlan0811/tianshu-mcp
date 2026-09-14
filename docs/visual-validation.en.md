# Visual acceptance validation progress

[中文](visual-validation.md)

Plan: local `.codex/plans/2026-09-14-issue-3-visual-acceptance-plan.en.md` (Chinese file of the same name), both still Git-ignored. Target v0.5.0 is released; the full Windows 10 local functional matrix and real macOS 13+ (Intel and Apple Silicon) system evidence are collected. Raw records live in [visual-validation-evidence/](visual-validation-evidence/).

## 1. Platform evidence (system / Node / browser / command / result)

### 1.1 Windows 10 x64 local

- System: Windows 10 Pro x64 (10.0.19045)
- Node: 24.18.0
- Browsers: managed Chrome 148.0.7778.97 (matches the pinned revision); local Microsoft Edge 144.0.3719.104 (isolated acceptance instance)
- Command and result:
  ```sh
  TIANSHU_VISUAL_BROWSER_TEST=1 npx vitest run \
    test/integration/visual-browser-smoke.test.ts \
    test/integration/visual-capture.test.ts \
    test/integration/visual-flow.test.ts
  ```
  → **3 files / 10 tests passed** (browser smoke 1, real capture 8, baseline approval and freezing flow 1). Raw output: [windows-10-tests.log](visual-validation-evidence/windows-10-tests.log)
- Full functional matrix (each item from the plan's §6 "Real browser integration" matrix):
  ```sh
  node scripts/evidence-visual-windows.mjs --out <evidence.json>
  ```
  → **9/9 passed**. Raw record: [windows-10-matrix.json](visual-validation-evidence/windows-10-matrix.json)

| Matrix item | Result | Actual evidence |
|---|---|---|
| `existing` source capture without managing the process | ✅ | capture succeeded; original listener still listening |
| Static source + managed Chrome: desktop/mobile viewports, fullPage, element | ✅ | desktop 1280×720, mobile 390×844, fullPage height 960, element 120×60; browser `Chrome/148.0.7778.97` |
| Port conflict blocks | ✅ | `PORT_CONFLICT`, no reuse |
| Conflict does not terminate another service | ✅ | original listener still bound |
| Readiness failure blocks within bounds | ✅ | `ITEM_TIMEOUT` |
| Readiness failure cleans up the child process | ✅ | child PID no longer exists |
| Local Edge runs in an isolated instance and reports its real version | ✅ | `Edg/144.0.3719.104`, matching `environmentBrowser` |
| Version mismatch is observable | ✅ | local `Edg/144.0.3719.104` vs pinned `148.0.7778.97`; managed mode enforces the pin |
| Explicit missing browser path blocks | ✅ | `BROWSER_MISSING`, no silent fallback to the local browser |

Additionally, real-browser cases cover CJK/space-containing project paths, main-document 302 redirect origin validation, Cookie/localStorage import and expiration, external resource allow/block, masks, screenshot differences and rule freezing.

### 1.2 macOS 13+ (Intel and Apple Silicon)

Executed on GitHub-hosted **macOS 15 (Darwin kernel 24.6.0)** hardware runners covering both **x64 (Intel)** and **arm64 (Apple Silicon)**:

- Target commit: `de34278` (CI run [34840415189](https://github.com/lanlan0811/tianshu-mcp/actions/runs/34840415189))
- Command: `TIANSHU_VISUAL_BROWSER_TEST=1 npx vitest run visual --maxWorkers=1`
- Browser: managed Chrome 148.0.7778.97 (explicitly installed via `visual browser install`)
- Result: both architectures **Test Files 10 passed (10) / Tests 51 passed (51)**; the production-tarball isolated consumer visual acceptance in the same job also passed (`"passed": true`). Raw record: [macos-ci-summary.txt](visual-validation-evidence/macos-ci-summary.txt)

| System (arch) | Node | Browser | Result | Raw record |
|---|---|---|---|---|
| macOS 15 (arm64 / Apple Silicon) | 20.20.2 | Chrome/148.0.7778.97 | passed | [environment.json](visual-validation-evidence/macos-15-arm64-node20.environment.json) |
| macOS 15 (arm64 / Apple Silicon) | 22.23.2 | Chrome/148.0.7778.97 | passed | [environment.json](visual-validation-evidence/macos-15-arm64-node22.environment.json) |
| macOS 15 (arm64 / Apple Silicon) | 24.20.0 | Chrome/148.0.7778.97 | passed | [environment.json](visual-validation-evidence/macos-15-arm64-node24.environment.json) |
| macOS 15 (x64 / Intel) | 20.20.2 | Chrome/148.0.7778.97 | passed | [environment.json](visual-validation-evidence/macos-15-intel-node20.environment.json) |
| macOS 15 (x64 / Intel) | 22.23.2 | Chrome/148.0.7778.97 | passed | [environment.json](visual-validation-evidence/macos-15-intel-node22.environment.json) |
| macOS 15 (x64 / Intel) | 24.19.0 | Chrome/148.0.7778.97 | passed | [environment.json](visual-validation-evidence/macos-15-intel-node24.environment.json) |

Note: these are real macOS systems and real architectures on GitHub-hosted macOS runners, not a maintainer's personal device. The evidence is preserved with the CI artifacts and can be re-downloaded from the run page above.

## 2. Local and engineering gates

- **Full suite: 486 passed / 10 skipped** (Windows 10 x64, Node 24.18.0); the 10 real-browser-gated cases pass **10/10** when run with `TIANSHU_VISUAL_BROWSER_TEST=1`.
- **Isolated production-tarball consumer acceptance passed**: `npm pack` → install into a directory without dev dependencies → approve a baseline → image specification check → detect a real pixel defect → offline HTML usable with networking off (status filter, opacity overlay, region selection).
- `typecheck`, `lint`, `build`, `pack:check` and the strict stdio check all pass; the build leaves no unexpected tracked changes.
- **CI on the target commits succeeded**: the `CI` workflow is fully green for `b1505f5`, `de34278` and the final commit `fb18249`. For `fb18249`, all 12 `visual-browser` jobs succeeded (including 6 macOS jobs: `macos-15-intel` and `macos-15` × Node 20/22/24), along with `build-test` and `pack-check`. The earlier `df7eb18` CI failed once in `Build & Test (ubuntu-latest / Node 20)` on a `zcode-flow` task-deadline timing race unrelated to the visual module. Link: https://github.com/lanlan0811/tianshu-mcp/actions/runs/34841685757

## 3. Release outcome (verified)

- The `Release` workflow succeeded, including the "require a successful CI for this commit" and "mirror credentials present" gates and the GitHub/Gitee publish steps. Link: https://github.com/lanlan0811/tianshu-mcp/actions/runs/34839014803
- GitHub release: `tag v0.5.0` (not a draft) with asset `tianshu-mcp-0.5.0.tgz` and a bilingual body.
- Gitee release: `tag v0.5.0` (id 1143672) targeting `b1505f5`, with a bilingual body.
- Both repos are consistent: `github/master`, `gitee/master`, both remotes' `v0.5.0` tags and the local tag all resolve to `b1505f5` (later `master` advanced to the record commit `de34278`).
- **npm publish (outside the plan, per explicit user instruction)**: the maintainer's npm account is logged in and owns the package; `npm publish` successfully published `tianshu-mcp@0.5.0` to `latest` (confirmed by a direct registry query; `dist.shasum` = `85c39756…`, matching the local build). A fresh `npm install tianshu-mcp@0.5.0` in an isolated directory passes all four `visual doctor` checks. Plan §7 originally stated "does not additionally add npm registry publishing"; this publish was performed on the user's explicit instruction so the README's "published continuously" statement stays consistent across versions.

## 4. Known limitations

- macOS evidence comes from CI-hosted runners and was not re-verified on a maintainer's personal macOS device.
- The Windows 10 local matrix covers the items listed by `scripts/evidence-visual-windows.mjs`; items not listed (such as real GUI desktop interaction) are outside the visual module's scope.
- The website directory `tianshu-mcp-web` is out of scope.

Unexecuted checks must not be reported as passing.
