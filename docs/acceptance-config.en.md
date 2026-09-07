# `.tianshu-mcp/acceptance.json` Specification

Place this file at `<project>/.tianshu-mcp/acceptance.json` to define project-level acceptance checks. tianshu-mcp reads it for auto-verify (run_task) and manual `verify_task` on that project.

## Configuration precedence (high → low)

1. `extraChecks` passed to `verify_task` — **appended** after the base set (`checksMode:"replace"` swaps them in instead)
2. Project-level `<project>/.tianshu-mcp/acceptance.json`
3. Server data-dir `projects.json[pathHash].verify` (admin-curated)
4. Default set (derived from the project's detected tech stack, see below)

## File format

```jsonc
{
  // each entry = one automated command check
  "checks": [
    {
      "name": "typecheck",                 // required; shown in the report
      "cmd": ["npm", "run", "typecheck"],   // required: argv array (recommended, no shell)
      // a plain string is also accepted and safely tokenized (never executed through a shell):
      // "cmd": "npm run typecheck"
      "timeoutMs": 120000,                 // optional, per-check timeout; default = server verify timeout
      "optional": false                    // optional:true failure is a warning and does NOT fail the round verdict
    },
    { "name": "lint", "cmd": ["npm", "run", "lint"] },
    { "name": "test", "cmd": ["npm", "test"] }
  ]
}
```

## Semantics (as of R4 remediation)

- **optional:true** — a failing optional check is recorded as a warning ("optional 检查未通过") and does **not** affect the round verdict. Mandatory (default) failures make the round fail.
- **extraChecks append** — by default (`checksMode:"append"`) the project/default checks run first, then `extraChecks` are **appended**; base gates are never weakened. `checksMode:"replace"` runs only `extraChecks`.
- **Rounds are 0-based** — `report-N.*` starts at N=0; `get_task_report(round=0)` is valid; omitting `round` returns the latest.
- **Manual `verify_task(taskId)`** allocates the next free round and never overwrites an existing `report-0.*`.
- **baselineRef** — `verify_task` accepts a Git ref, or for taskId mode defaults to that task's pre-work baseline; an invalid ref returns a structured error (no silent fallback to current HEAD).

Each check runs in the project root as structured argv (`shell:false`), stdout/stderr are appended to the round's `verify-N.log` with an output tail in the report.

**Any non-optional failed check ⇒ this acceptance round fails**; skips and timeouts are flagged separately.

Built-in extra check (not configurable off): `git-diff-check` = `git diff --check` relative to the pre-work baseline; auto-skipped for non-git projects.

## Default set (when no config exists)

| Detected | Check | When absent |
|---|---|---|
| any project | `git diff --check` (built-in) | non-git: skipped + noted |
| `package.json` scripts | `npm run typecheck` / `lint` / `test` / `build` | missing script skipped + noted |
| `tsconfig.json`, no npm scripts | `npx tsc --noEmit` | — |
| `pytest.ini` | `pytest -q` | — |
| `go.mod` | `go test ./...` | — |
| `Cargo.toml` | `cargo test` | — |

## Reports

Each round writes `report-N.md` + `report-N.json` under the task dir `tasks/<taskId>/`. `report.json.checks[]` carries `{name, cmd, passed, durationMs, exitCode, outputTail, timeout, skipped, reason, optional}`. Changes/diffstat/suspicious signals live in `report.json.analysis`, all computed against the pre-work git baseline captured by run_task/rework_task.

## FAQ

- **verify can't find node/npx** — tianshu-mcp subprocesses inherit PATH with the system node dir prefixed. Check your PATH if it still fails.
- **Temporary extra verification** — `verify_task(taskId, extraChecks=[{name:"x", cmd:["…"]}])` without editing files.
