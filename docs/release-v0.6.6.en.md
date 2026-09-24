# v0.6.6 — Dry-run mode (review before doing)

> Related issue: [#21](https://github.com/lanlan0811/tianshu-mcp/issues/21). See
> [dryRun mode](docs/dry-run.en.md).

## Background

`run_task` drives the agent straight into editing source; a misunderstanding can produce a large diff
needing rollback. Callers sometimes want "see the plan first, then decide whether to actually do it",
which was previously unsupported.

## Added

- **`run_task(dryRun=true)`**: the agent only analyses and plans, outputting the file list and approach
  **without touching source**; the acceptance engine performs **static analysis only** (do the
  referenced files exist, do the proposed edit locations really exist, any obvious logical conflicts),
  skipping typecheck / test / build / visual acceptance / `requireChanges`.
- **Plan contract**: the constraint requires the agent to write its plan to
  `<project>/.tianshu-mcp/dry-run-plan.json`:

  ```jsonc
  { "summary": "one-line plan",
    "files": [ { "path": "src/foo.ts", "action": "modify", "reason": "why",
                 "edits": [ { "line": 42, "symbol": "buildToken", "action": "how" } ] } ] }
  ```

- **A review-then-do loop**: a dry run renders the structured plan into a plan document **inside the
  project** at `.tianshu-mcp/dry-run-plan-<taskId>.md`; `meta.dryRunPlanDoc` gives the project-relative
  path, directly usable as a later real `run_task`'s `planDoc`.

## Static checks

| code | Level | Judgement |
|---|---|---|
| `path_outside_project` | error | Plan path is absolute or contains `..` |
| `path_forbidden` | error | Plan path falls under `.git/` or `node_modules/` |
| `conflicting_actions` | error | The same path is declared with contradictory actions |
| `dry_run_violation` | error | **Zero-change gate**: baseline changes remain after excluding MCP-owned artifacts |
| `file_already_exists` / `file_not_found` | warning | `create` target exists / `modify`·`delete` target missing |
| `edit_line_out_of_range` / `edit_location_missing` | warning | Line out of range / symbol not found in the file |
| `file_unreadable` | warning | The file exists but cannot be read |
| `dry_run_artifacts_only` | warning | **Only** MCP-allowed artifacts changed (not counted as source changes) |

## Key design decisions

| Decision | Rationale |
|---|---|
| The read-only constraint is injected in `makeBuildCtx()` | All five adapters append `ctx.context`, so **one change covers every adapter**; dryRun is a round-0 first dispatch, so the zcode/kimicode `initialDispatch` guard does not swallow it |
| A dedicated engine method `runDryRun()`, not a branch inside `executeVerify` | A dry run's artifact is a `DryRunReport` (different meaning from `VerifyReport`); folding it into the same return value would need a union type or a fake `VerifyReport`, polluting types and complicating round accounting |
| Consumes no acceptance round | Its report is `dry-run-report-<round>.*`, which does not match `^report-(\d+)\.(md\|json)$`, so `nextReportRound()` ignores it naturally |
| **The zero-change gate is the core evidence** | Diffs against the pre-work baseline minus MCP-owned artifacts; it **does not depend on the plan being correct** — it still works when the agent produces no plan at all |
| Verdict `needs_attention`, not `failed` | A bad plan needs a **human decision**, not automatic rework |
| Never enters the rework loop; ignores `autoVerify` | There is no "broken code" to fix in a dry run, and its semantics are "review first" rather than "verify" |
| Project-less mode rejects it explicitly | There is no file tree or baseline to analyse; silently ignoring it would mislead the caller into thinking a dry run happened |
| The plan document lives inside the project | `planDoc` can only read project files, so the task data dir would be unreachable for the agent |
| A missing plan degrades but stays visible | `planExtracted: false` + `fallbackReason`; checks degrade to the zero-change gate only, and both the report and the message say "plan extraction: failed" |

## Compatibility

- **`dryRun` is a new optional argument, off by default**: when omitted, `run_task` behaves exactly as in
  v0.6.5.
- No tool contract or breaking data-model changes; MCP annotations unchanged.

## Disclosed honestly

- **A rehearsal is still a real agent invocation**: it consumes the external agent's quota and time. What
  it saves is the cost of rolling back wrong changes, not the cost of calling the agent.
- **The agent is not guaranteed to obey the read-only constraint**: that relies on explicit task-book
  instructions plus the post-hoc gate. Violations are caught and reported honestly, but **changes that
  already happened are not rolled back** (the MCP never auto-commits, auto-stashes or auto-checks-out).
- **Static checks cannot judge whether a plan is sensible**: they only verify "the file exists, the
  location matches, no obvious contradiction" — which is exactly what the human review step is for.
- **Adapter differences around `planDoc`**: it is currently consumed only by the **Codex and Qoder CN**
  prompt builders; CLI agents and ZCode / Kimi Code / TraeWork **do not read it**. For those, the plan
  path must go into the `task` text (the file is inside the project, so they can read it). This is
  precisely why the plan document lives **inside the project** rather than the task data dir.

## Tests

- 37 new cases across 2 files:
  - `test/unit/dry-run.test.ts` (29): `parseDryRunPlan` for valid / empty files / unknown action /
    absolute paths (POSIX and Windows drive) / `..` traversal / `.git` and `node_modules` / invalid line
    numbers; a compliant rehearsal passes with no errors; the plan file and a whitelisted `planDoc` are
    not counted as changes; artifacts-only changes give a non-blocking hint; touching source yields a
    blocking `dry_run_violation`; the three degradation paths (missing plan / broken JSON / invalid shape)
    each expose their reason; a missing plan **plus** source changes is still caught by the gate;
    `create` on an existing file, `modify` on a missing file, out-of-range lines, missing symbols and
    contradictory actions each produce the right code with file/line; report markdown / jsonable
    (`kind: "dry-run"`) / plan document (including the "not yet implemented, not evidence of passing
    acceptance" statement) / the relative-path helper.
  - `test/integration/dry-run.test.ts` (8): a compliant rehearsal → `succeeded` with every `git status`
    change confined to `.tianshu-mcp/` (no source file touched); `dry-run-report-0.*` exists while
    `report-0.*` does not (**no round consumed**, artifacts separated); the read-only constraint really
    reaches the task book (asserted by reading the agent log for "must not create, modify or delete any
    source file"); a violating rehearsal → `needs_attention` + `dry_run_violation`; with the flag omitted
    the normal path runs (producing `report-0.md`); dryRun ignores `autoVerify`; project-less mode rejects
    `dryRun`; and the **review-then-do loop** — the dry run's `dryRunPlanDoc` points at a real plan
    document inside the project, and a real task dispatched with it as `planDoc` is accepted and succeeds.
  - `test/stub-agent/stub-agent.mjs` gained two playbooks: `dry-run-plan` (writes the plan, never touches
    source) and `dry-run-edit` (writes the plan and sneaks a source edit).
- Full `npm test`: **1110 passed / 12 skipped** (101 files; v0.6.5 was 1073 passed / 12 skipped, a net
  gain of 37).
- The new cases follow the CI lesson from v0.6.5: **no dependency on any locally installed GUI agent**
  (the project-less case stubs its own profile).

## Real-machine record

**To be added (post-release)**: run a real GUI task via `scripts/probe-codex.mjs` or the TraeWork probe
with `dryRun=true`, confirm the agent obeys the read-only constraint (`git status` shows no source
changes), the plan file is parsed correctly, and the plan document can be reused as a later real task's
`planDoc`; drop the output into `docs/` as an evidence file. This version gates on unit tests plus
fake-CDP/stub integration tests (issue #21's acceptance criteria allow "corresponding tests **or**
real-machine evidence" — this version takes the former, with the real-machine record filed as a
post-delivery TODO in HANDOFF.md).
