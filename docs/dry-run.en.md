# dryRun mode (review before doing, issue #21)

Chinese version: [dry-run.md](dry-run.md)

`run_task` normally drives the agent straight into modifying source; a misunderstanding can produce a
large diff that needs rolling back. `dryRun` provides the intermediate state of "see the plan first,
then decide whether to actually do it".

```jsonc
run_task(projectPath="D:/proj", task="switch the login API to JWT", dryRun=true)
```

## 1. What happens under dryRun

| Stage | Behaviour |
|---|---|
| Dispatch | The task book is sent as usual, but a **read-only rehearsal constraint** (below) is merged into `ctx.context`, requiring the agent to only analyse and plan, never touch source, and to write its plan into a machine-readable plan file |
| Acceptance | **Static analysis only**: parse the plan file → check each referenced file exists, each proposed edit location exists, and there are no obvious logical conflicts; **skip** typecheck / test / build / visual acceptance / `requireChanges` |
| Terminal state | No blocking findings → `succeeded`; blocking findings → **`needs_attention`** (a bad plan needs a human decision; it is not a code defect that can be auto-reworked) |
| Rework | Does **not** enter the automatic rework loop |
| Rounds | Does **not** consume an acceptance round — its report is `dry-run-report-<round>.*`, which does not match `^report-(\d+)\.(md\|json)$` |

`dryRun` deliberately **ignores `autoVerify`**: its semantics are "review first", not "verify".
`dryRun` **requires `projectPath`**: project-less mode has no file tree or baseline to analyse statically,
so the argument is explicitly rejected rather than degrading into an ordinary task.

## 2. The plan file the agent must produce

The constraint requires the agent to write the plan to **`.tianshu-mcp/dry-run-plan.json`** in the project root:

```jsonc
{
  "summary": "one-line plan",
  "files": [
    {
      "path": "src/foo.ts",          // must be project-relative
      "action": "modify",            // create | modify | delete
      "reason": "why",               // optional
      "edits": [                      // optional, but if present it must match the real file
        { "line": 42, "symbol": "buildToken", "action": "issue a JWT instead" }
      ]
    }
  ]
}
```

This is a **contract**: the MCP checks it item by item, so "just writing something" shows up as warnings
or errors. Paths must be project-relative, and absolute paths, `..` traversal, `.git` and `node_modules`
are rejected.

## 3. Static checks

| finding code | Level | Judgement |
|---|---|---|
| `path_outside_project` | error | Plan path is absolute or contains `..` |
| `path_forbidden` | error | Plan path falls under `.git/` or `node_modules/` |
| `conflicting_actions` | error | The same path is declared with contradictory actions (e.g. both `delete` and `modify`) |
| `dry_run_violation` | error | **Zero-change gate**: after excluding MCP-owned artifacts, changes remain relative to the pre-work baseline |
| `file_already_exists` | warning | The `create` target already exists (confirm overwrite, or switch to `modify`) |
| `file_not_found` | warning | The `modify` / `delete` target does not exist |
| `edit_line_out_of_range` | warning | `edits[].line` exceeds the file's actual line count |
| `edit_location_missing` | warning | `edits[].symbol` is not found in the file |
| `file_unreadable` | warning | The file exists but cannot be read |
| `dry_run_artifacts_only` | warning | **Only** MCP-allowed artifacts changed (not counted as source changes, not blocking) |

**The zero-change gate is the core evidence**: it does not depend on the plan being correct — even if the
agent produces no plan at all, touching source is caught by `dry_run_violation`. This is the
machine-checkable form of the acceptance criterion "zero source changes under dryRun".

## 4. When the plan is missing: degrade, but visibly

If the agent disobeys (no plan written, non-JSON, invalid shape) it **does not silently pass**:

- `planExtracted: false` plus a `fallbackReason` stating why;
- checks degrade to the **zero-change gate only** (which is plan-independent and still effective);
- the report and the message both state "plan extraction: failed" honestly rather than pretending
  checks ran.

## 5. Artifacts and the review-then-do loop

| Artifact | Path | Notes |
|---|---|---|
| Static analysis report | `tasks/<taskId>/dry-run-report-<round>.md` / `.json` | **Separate** from regular `report-<round>.*`: the two have different meaning (static analysis vs real command acceptance). `meta.dryRunReportFiles` gives the paths; the JSON carries `kind: "dry-run"` |
| Plan document | **inside the project** at `.tianshu-mcp/dry-run-plan-<taskId>.md` | Rendered from the structured plan; `meta.dryRunPlanDoc` gives the **project-relative** path |

Two-step usage:

```jsonc
// ① review
run_task(projectPath="D:/proj", task="switch the login API to JWT", dryRun=true)
// → succeeded, meta.dryRunPlanDoc = ".tianshu-mcp/dry-run-plan-tsk_xxx.md"

// ② do: pass that path through as planDoc
run_task(projectPath="D:/proj", task="implement the plan", planDoc=".tianshu-mcp/dry-run-plan-tsk_xxx.md")
```

**Adapter differences around `planDoc` (stated honestly)**: `planDoc` is currently consumed by the
**Codex and Qoder CN** prompt builders; **CLI agents and ZCode / Kimi Code / TraeWork do not read it**.
For those agents, put the plan path **into the `task` text** (e.g. "implement per
`.tianshu-mcp/dry-run-plan-tsk_xxx.md`") — the file lives inside the project, so they can read it.
Placing the plan document **inside the project** rather than the task data dir is precisely so every
agent can reach it.

## 6. Known boundaries

- **A rehearsal is still a real agent invocation**: it consumes the external agent's quota and time. What
  it saves is the cost of rolling back wrong changes, not the cost of calling the agent.
- **The agent is not guaranteed to obey the read-only constraint**: that relies on explicit instructions in
  the task book plus the post-hoc zero-change gate. Violations are caught and reported honestly, but
  **changes that already happened are not rolled back automatically** (the MCP never auto-commits,
  auto-stashes or auto-checks-out).
- **Plan quality still depends on the agent**: the static checks can only verify "the file exists, the
  location matches, no obvious contradiction" — they cannot judge whether the plan itself is sensible.
  That is exactly what the human "review" step is for.
