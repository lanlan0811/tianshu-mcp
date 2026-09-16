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

### v0.5.1 (documentation/evidence completion, no runtime changes)

- The `Release` workflow succeeded (including the "require a successful CI for this commit" and "mirror credentials present" gates). Link: https://github.com/lanlan0811/tianshu-mcp/actions/runs/34847120767
- The `CI` workflow for the target commit `c24fc67` is fully green: all 22 jobs succeeded, including all 12 `visual-browser` jobs (6 of them macOS).
- GitHub release: `tag v0.5.1` (not a draft) with asset `tianshu-mcp-0.5.1.tgz` and a bilingual body containing the Full Changelog and npm link.
- Gitee release: `tag v0.5.1` (id 1143824) targeting `c24fc67`, with a bilingual body.
- Both repos are consistent: `github/master`, `gitee/master`, both remotes' `v0.5.1` tags and the local tag all resolve to `c24fc67`.
- npm: `tianshu-mcp@0.5.1` published to `latest` (confirmed by a direct registry query; `dist.shasum` = `529efba6…`, matching the local build); an isolated install passes all four `visual doctor` checks.
- Side fix: the `package-lock.json` root version was synced from the stale `0.4.1` to `0.5.1`.

### v0.5.4 (AI visual content validation, issue #13 phase 2)

- The `Release` workflow succeeded (including the "require a successful CI for the same SHA" and "require mirror release credentials" gates plus both GitHub and Gitee publish steps). Run: https://github.com/lanlan0811/tianshu-mcp/actions/runs/35095384929
- The `CI` for commit `ea797d1` is fully green: all 22 jobs succeeded (`build-test` × 9, `visual-browser` × 12, `pack-check` × 1), and 6 of the browser jobs cover macOS 15 (Apple Silicon arm64) and macOS 15 Intel (x64) across Node 20/22/24. Run: https://github.com/lanlan0811/tianshu-mcp/actions/runs/35094765071
- GitHub release: `tag v0.5.4` (not a draft), asset `tianshu-mcp-0.5.4.tgz`, with a bilingual body. See https://github.com/lanlan0811/tianshu-mcp/releases/tag/v0.5.4
- Gitee release: `tag v0.5.4` at commit `ea797d1` with a bilingual body (idempotently completed by `scripts/gitee-release.mjs` using the `GITEE_TOKEN` secret).
- Both remotes agree: `github/master`, `gitee/master`, the `v0.5.4` tags on both remotes, and the local tag all point at `ea797d1`.
- npm: `tianshu-mcp@0.5.4` published to `latest` (a direct registry query confirms `dist.shasum` = `eb405680…`, matching the local `npm pack`).

## 4. v0.5.4 validation record (AI content validation, issue #13 phase 2)

End-to-end evidence from the stub judge (Windows 10 x64, Node 24.18.0, 2026-09-16). The stub is
`test/fixtures/content-judge.mjs` (a cross-platform Node script whose output — pass / fail / split / invalid /
non-zero exit / sleep-timeout — is selected by an environment variable). No case depends on a real third-party
vision CLI, and none depends on a browser (the browser-gated cases are listed below).

| Verification point | Result | Evidence |
|---|---|---|
| Sample votes and majority | pass | `visual-content-flow` / `visual-content-verdict`: 3/3, 2/3, 1/2 split, 1/1, and `samples:1` all enumerated |
| Cache hit runs zero commands | pass | `visual-content-flow` "cache makes the second round run zero judge invocations": round 2 invokes the judge 0 times and marks the result `cached:true` |
| CLI upgrade invalidates the cache | pass | `visual-content-cache`: a changed `commandDigest` misses; an uncomputable digest stores nothing |
| `uncertain` never gates or triggers rework | pass | `visual-content-flow` "uncertain verdicts never gate the round" plus `visual-content-warning` (the round message carries the uncertainty line) |
| Warnings do not gate but stay visible (P4) | pass | `visual-content-warning`: an `optional:true` + `blocked` item stays out of `blockingIssues` while the message carries "AI content warning did not pass (does not affect the conclusion): logo [CONTENT_COMMAND_FAILED]" |
| `blocking:true` fails the round | pass | `visual-content-flow` "blocking content mismatches fail the round": verdict fails and `visualFailed` matches |
| Whole-round blockers produce no result rows (P2/P3) | pass | `visual-content-blocked`: an unresolvable global command, an unresolvable **rule-level override**, and a missing env reference each yield a whole-round `configurationError` with an empty `report.visual` |
| Single-item failures stay warnings | pass | `visual-content-blocked`: non-zero exit and invalid output remain single-item results and never escalate the round |
| Repair plan isolates warnings | pass | `traework-repair-plan` + `visual-content-warning`: warnings land under "warning-only items (no fix required)" and section 2 "must fix" excludes them |
| Confidence-gate semantics | pass | `visual-content-verdict` + `visual-content-flow`: unconfigured means inactive; below threshold downgrades to uncertain; a command reporting no confidence is annotated "minConfidence did not apply" |
| Budget self-consistency hard check (P1) | pass | `visual-content-schema`: `samples:3` + `timeoutMs:120000` against the default `roundTimeoutMs:300000` is rejected; per-rule overrides that stay consistent pass |
| `pixel:false` semantic pages skip baselines (D9, real browser) | pass | `visual-flow` "semantic-only pages need no baseline and yield a content result": no baseline directory, no `BASELINE_APPROVAL_REQUIRED`, and a `login-content` result; `visual-snapshot` locks in that its frozen snapshot records null regardless of stray baseline files |
| One screenshot yields both pixel and content items (real browser) | pass | `visual-flow` "pixel pages with content produce both items from one screenshot": the baseline flow is unchanged, both items share the capture, and a new task's cache isolation reruns the judgement |
| `visual content probe` writes no evidence or cache | pass | `visual-content-probe`: neither `visual/` nor `visual-content-cache/` is created; an unknown rule id reports `CONTENT_RULE_UNKNOWN` |
| Timeout classification | pass | `visual-content-command`: a timeout yields a single blocked item with `CONTENT_TIMEOUT` (warning only, never escalating the round), and asserts the temp input files are removed |
| `visual doctor` content diagnostics | pass | `visual-runtime`: per-rule command resolution plus the `allowRemote` list; an unresolvable command fails that finding; the budget finding reports the total |

Engineering gates (local): `npm test` **647 passed / 12 skipped** (67 files; the v0.5.4 tag `ea797d1` shipped 644 — the timeout-classification and temp-input-removal contract assertions plus the doctor total-budget advisory branch were added after release); the 12 browser-gated cases run
green **12/12** under `TIANSHU_VISUAL_BROWSER_TEST=1` (visual-browser-smoke 1, visual-capture 8, visual-flow 3,
including the 2 new D9 cases); `typecheck`, `lint` (0 warnings), `build`, and `check:stdio` all pass.

**Real macOS system evidence (CI runner, collected in this phase)**: the `CI` workflow for commit `d762581` is
fully green ([run 35093217490](https://github.com/lanlan0811/tianshu-mcp/actions/runs/35093217490), all 22 jobs
succeeded); 6 of those are `visual-browser` jobs covering **macOS 15 (Apple Silicon arm64)** and **macOS 15 Intel
(x64)** across Node 20/22/24, running this phase's entire visual suite (including the new content-validation and
D9 semantic-page cases) via `npx vitest run visual --maxWorkers=1`. This is real macOS system and architecture
evidence from GitHub-hosted runners, not a maintainer's personal device.

**Not covered (stated honestly; not evidence of passing)**:

- **Not re-verified on a maintainer's personal macOS device**: the macOS evidence comes from CI-hosted runners
  (above); the GUI cancel/rework matrices are unrelated to this module.
- **No measurement against a real third-party vision CLI**: every piece of evidence comes from the in-repo stub.
  A real model/CLI's latency, output style, and confidence habits only become observable once the maintainer
  supplies a command.
- **"Images never leave the machine" is not verified**: the MCP's enforcement is contract-level only (the base64
  placeholder is rejected without an `allowRemote` opt-in); the command's own behaviour is not auditable at the
  system level. See [SECURITY.en.md](../SECURITY.en.md).

## 5. Known limitations

- macOS evidence comes from CI-hosted runners and was not re-verified on a maintainer's personal macOS device.
- The Windows 10 local matrix covers the items listed by `scripts/evidence-visual-windows.mjs`; items not listed (such as real GUI desktop interaction) are outside the visual module's scope.
- The website directory `tianshu-mcp-web` is out of scope.

Unexecuted checks must not be reported as passing.
