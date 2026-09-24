# v0.6.4 — Structured repair directives (repairDirectives)

> Related issue: [#19](https://github.com/lanlan0811/tianshu-mcp/issues/19). See
> [structured repair directives](repair-directives.en.md).

## Background

On acceptance failure a repair plan is generated and fed back to the agent, but the report is a
**full narrative** — the agent must locate the specific problem itself (which line has the type
mismatch, which file has a TODO, which file has an anomalous changed-line count). That raises its
reasoning cost and increases the chance that a misreading makes the rework fail.

## Added

- **Structured repair directives**: failure reasons parsed into directly executable actions.

  | Source | Matching | Output |
  |---|---|---|
  | `typecheck` | Failed checks whose name/argv matches `typecheck\|tsc\|--noEmit\|mypy\|pyright` | One `{file, line, issue, action}` per tsc error (both pretty `file(l,c): error TSxxxx` and plain `file:l:c - error TSxxxx`); absolute paths normalized to project-relative POSIX; duplicates collapsed |
  | `diffstat` | The report's `analysis` section | One directive each for oversized single-file changes (>500 lines) and modified lockfiles (with `file`); one each for line-level counts of TODO/FIXME, console.log/debugger and secret-like patterns (**without** `file`, since these are counts with no stable line) |

- **New optional `repairHint` on `rework_task`**: a free-form string (max 4000 chars) rendered in the
  next round's task book as a `【结构化修复提示】` block placed **before** `feedback` — precise
  locations first, the longer explanation after.

## Consumption paths (four places)

| Carrier | Content |
|---|---|
| `report-<round>.json` | The full `repairDirectives` field (**failed rounds only**; persisted so it survives restarts and is re-read by the manual-rework path) |
| `report-<round>.md` | A `## 结构化修复指令` section |
| Repair plan (`rework-*.md` / `codex-fix-r*.md`) | A `## 2.5` section inserted between section 2 and section 3 |
| Rework message | A `【结构化修复指令（摘要，最多 10 条）】` block; when extraction fails it is **not** added here |

## Key design decisions

| Decision | Rationale |
|---|---|
| Match on "check name / argv heuristics" | The repo has **no** per-verifier modules (typecheck/test/build are generic argv command checks), so no checker type exists to key off |
| **No** test-class extraction | Test-framework output has no stable file/line; parsing it anyway would produce **wrong** locations, which is worse than producing none — those always take the fallback |
| Extractors **never throw**; a single source's exception is swallowed and recorded in `fallbackReason` | One broken extractor must not strip the rework of all context |
| **Explicit fallback** when extraction fails (state the reason + tell the agent to return to the full failure output) | Makes "extraction failed" an observable fact rather than a silent empty section |
| Extract on failed rounds only | A passing round has nothing to fix; extracting there would only bloat the report |
| Persist into `report.json` | The manual-rework path (fix-loop's qoder branch) re-reads that file, and it must survive a server restart |
| Line-level signals never fake `file` | `signals.ts` only counts and has no stable file or line |
| `LOCKFILE_PATTERN` exported and shared | Analysis warnings and the extractor keep one lockfile list, preventing drift |

**Known limitation (deliberately accepted)**: `CheckResult.outputTail` is truncated to the last 4000
characters (`runner.ts`), and a large TypeScript project's total error count can far exceed that, so
**only tail errors are extractable** and the rest is covered by the fallback. Not inflating report
size for extraction is an intentional trade-off.

## Compatibility

- **No tool contract, data model or MCP annotation changes.**
- `repairDirectives` is a new optional field inside the report: existing readers may simply ignore it,
  and passing rounds do not produce it.
- When `repairHint` is omitted, `rework_task` behaves exactly as in v0.6.3.

## Tests

- 35 new cases across 3 files:
  - `test/unit/repair-directives.test.ts` (15): pretty / plain tsc parsing; mypy-style heuristic
    selection; absolute-path normalization (inside the project becomes relative, outside is kept
    as-is); duplicate collapsing; passed/skipped/non-typecheck checks excluded; the five diffstat
    directives (including untracked lockfiles); line-level signals omitting `file`; union semantics;
    test-class fallback; one throwing source swallowed while others continue; all-throwing yielding a
    `fallbackReason` that names the error.
  - `test/unit/repair-plan-directives.test.ts` (16): `renderDirectiveSection`'s two branches and the
    "no specific file" shape; `renderDirectiveLines` truncating to 10; the **position** of section 2.5
    (between sections 2 and 3) and the fallback wording in both repair-plan variants;
    `reportToJsonable` with/without the field (backward compatible: no key when absent) and the
    fallback reason persisted; `reportToMd`'s two branches; end-to-end "failed report → extract →
    plan doc" continuity.
  - `test/integration/rework-repair-hint.test.ts` (4 cases in 3 groups): `repairHint` really reaches
    the next round's task book and is placed **before** feedback (asserted by reading the task book the
    stub agent persists); omitting it leaves no such block; over 4000 chars is rejected at the
    protocol layer; the auto-generated `rework-<id>-r0.md` contains section 2.5 (either usable or an
    explicit fallback — a silent gap is not allowed) and `report-0.json` has persisted
    `repairDirectives`.
- Full `npm test`: **1037 passed / 12 skipped** (96 files; v0.6.3 was 1002 passed / 12 skipped, a net
  gain of 35).
- `check:stdio`: **8/8** for both dist and src (no new tools, scenario count unchanged).

## Real-machine record

**To be added (post-release)**: run `scripts/probe-codex.mjs` against a real project with a task that
is bound to fail typecheck, confirm section 2.5 of `rework-*.md` / `codex-fix-r*.md` gives the correct
`file:line` and action, and keep a **before/after** rework record (issue #19's acceptance criteria ask
for "at least one before/after real-machine rework record"). This version gates on unit tests plus
integration tests.
