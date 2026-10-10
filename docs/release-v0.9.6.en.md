# v0.9.6 — MiniMax Code Real-Machine Fix Release

> **Fixes two real-machine defects in MiniMax Code plus one false-pass risk in the
> acceptance layer**: ① selecting an already-listed project always failed (drive-letter
> normalization order); ② submenu tier/window switching read back too early (fixed sleep),
> measured **1/8 success**; ③ in a non-git repo the `requireChanges` zero-change gate was
> **silently skipped** while verification still reported PASS.

**No breaking changes. Tool surface unchanged (still 8 tools). No caller changes needed.**

---

## Background

A second round of real-machine smoke testing on MiniMax Code (3.1.0.170) using models
`M2.7` / `M3.1-Flash-Preview`, with the workspace being a **non-git** plain directory.
All 6 new-task rounds ended `succeeded`, but the process surfaced three defects — two in
the adapter layer, one in the shared acceptance layer.

---

## Defect ①: Selecting an already-listed project always failed (normalization order)

`projectPointExpression` normalized paths in-page like this:

```js
const norm = s => (s || '').replace(/[\/]+$/, '')
  .replace(/^([a-z]):/, (m, d) => d.toUpperCase() + ':')   // uppercase drive letter first
  .toLocaleLowerCase();                                     // then lowercased — cancels it
```

The drive-letter uppercasing was **always cancelled** by the following lowercase (dead
code). The Node side `normalizeProjectPath` does the opposite order: **lowercase first,
then restore the drive letter**. The two sides yielded `d:\...` vs `D:\...` for the same
directory — **never equal** → `hit.length !== 1` → expression returned `null` →
`clickProjectByPath` returned `clicked:false` → reported "project row matched but the click
did not take effect" (`setup_failed`).

**Trigger**: the project is **already in the sidebar**. The first round used the
"create project" modal path and never hit this; that success put the project into the
sidebar, so **the second round exposed it**.

Real machine: expression returned `null` before the fix, `{x:119.5, y:308}` after.

---

## Defect ②: Submenu switch read back too early (fixed sleep)

`pickOption` waited a fixed `sleep(350)` after clicking, then read back once and threw
"context window switch read-back mismatch: expected 1M, got 512K" → hard `model_mismatch`.

Real machine **quantified reproduction: 1/8 success**, and continuous observation within
the same round proved **the click did take effect**:

```
+350ms  → 512K   ← old code failed here
+1550ms → 1M     ← it had already switched; it was just slow
```

Changed to **bounded polling until convergence** (return as soon as the target value is
observed, fail only on timeout). Real-machine re-verification **6/6**, with measured
convergence times of 234–599ms — exactly the range the fixed 350ms wait could not cover.

---

## Defect ③: `requireChanges` silently degraded in a non-git repo

With `--auto-verify`, `requireChanges` defaults to `true`, yet the report said:

```
[INFO] requireChanges=true, but the project is not a git repo; zero-change gate skipped.
[INFO] Project is not a git repo; change list/diffstat analysis skipped.
Verdict: [PASS]
```

while the same report showed `changedFiles: []` and `diffstat: +0 -0`. **Users believed
they had zero-change protection, but in a non-git workspace it was silently dropped** —
if the agent produced nothing, verification would still report PASS.

**Judgment behaviour is unchanged** (no baseline can be computed outside git, so not
blocking is intentional and locked by existing tests). This release only changes
**visibility**: the same fact is dual-written so `warnings` carries it into `[WARN]`
and the report summary.

| | Before | After |
|---|---|---|
| Summary | "...diffstat +0 -0." | "...diffstat +0 -0; **1 warning**." |
| Report body | only an `[INFO]` line | adds `[WARN] ...this workspace has no automatic protection for "did the task produce anything": please confirm artifacts manually, or put the project under git.` |

---

## Additional hardening

The `hoverModel` failure site previously left only `hoverModel elapsed=9630ms`, making it
impossible to distinguish "menu never opened" / "a different window opened" / "submenu
rendered but belongs to another model" / "submenu container is empty". Added
`menuDiagnosticsExpression` + `cdp.menuDiagnostics()`, and on failure the diagnostics are
**logged before throwing**. Real machine verified: `targetMenuCount=0` before hover, `=1`
after.

---

## New script

`scripts/smoke-minimax.mjs` — MiniMax previously had only the read-only
`probe-minimax.mjs`, no smoke script. The new script drives the full
`run_task → query_task → manage_task` loop through the real MCP tool surface, and adds
`--context-window` over the kimi version (MiniMax's submenu has a second dimension).

---

## Verification

| Item | Result |
|---|---|
| New tests | 4 files, 14 cases (project-point 4 / submenu-settle 4 / menu-diagnostics 5 / acceptance +1) |
| RED→GREEN→disproof | all three defects went red first, then green; reverting the fix turns them red again |
| Real machine (M2.7) | 6 new-task rounds all green; 4 Markdown artifacts all met spec (2 paragraphs per section) |
| Real machine (M3.1-Flash-Preview) | after fixes, 3 + 5 consecutive green rounds; SVG 2160–3800 B, 128×128, valid XML |
| Regression | minimax unit 136 passed; affected acceptance 45 passed; typecheck green; lint green |

---

## Known unreproduced (recorded honestly)

`openModelMenu` and `hoverModel` each timed out once (across 11 smoke rounds). Standalone
probes — including CPU load, back-to-back runs, and replaying the full preceding sequence —
**could not reproduce it**. **Root cause not identified, not fixed**; this release only adds
diagnostics to the failure site so a future reproduction can be localized.

---

## Upgrade

```bash
npm i -g tianshu-mcp@0.9.6
```

Or configure your MCP client with `npx -y tianshu-mcp@0.9.6`.

**No caller changes needed** — the tool surface and parameter contracts are unchanged.
