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
  // default true: fail a Git project when nothing changed from the pre-work baseline
  "requireChanges": true,
  // each entry = one automated command check
  "checks": [
    {
      "name": "typecheck",                 // required; shown in the report
      "cmd": ["npm", "run", "typecheck"],   // required: argv array (**always prefer this form**, no shell)
      // Compatibility only: a plain string is accepted and minimally tokenized (never executed
      // through a shell) — see the caveats below before using it:
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

### ⚠ Always use the array form for `cmd` (the string form's pitfalls)

**The recommended form is always the array**: `"cmd": ["npm", "run", "typecheck"]` — each element is one argv, with zero ambiguity.

The string form is kept for **backwards compatibility only**. It goes through the minimal tokenizer (`splitCmd()` in `src/config/store.ts`) which recognises only fully quoted segments and **supports no escaping**. All of the following are measured facts:

| What you write | What it parses to | Note |
|---|---|---|
| `npm run "a b"` | `["npm","run","a b"]` | Quoted segment works (the correct usage) |
| `node "a\"b"` | `["node","a\\","b\""]` | **Escaping does not work**: `\` is an ordinary character, `\"` does not escape the quote |
| `npm run "unclosed arg` | `["npm","run","\"unclosed","arg"]` | **An unclosed quote does not error**; the quote degrades to an ordinary character |
| `cmd "" x` | `["cmd","","x"]` | An empty quoted segment yields an empty argument |

**Consequence**: a path containing spaces (e.g. `C:\Program Files\...`) must be wrapped in quotes by hand, and a mistake (missing quotes, an unclosed quote, trying to use `\"`) **does not error** — it **silently splits into multiple argv**, so the command may run with wrong arguments. Whenever a path or argument may contain spaces, or needs escaping, use the array form. These semantics are pinned by the boundary cases in `test/unit/core.test.ts`.

- **Zero-test fail-closed:** a mandatory test check is failed even with exit code 0 when its output explicitly reports that no tests ran.
- **Zero-change fail-closed:** with `requireChanges:true` (the default), a Git project gets a failing `no-changes` check when tracked files, untracked files, and diffstat are all unchanged from the pre-work baseline. Pure question/analysis tasks may set `"requireChanges": false`; non-Git projects skip this gate with a report note.

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

## visual section: AI content validation fields

`visual.contents[]` (image content rules), `visual.content` (global command and budget), `pages[].content`, and
`pages[].pixel` are optional and **off by default**; they must be enabled explicitly. Judgement is delegated to a
command you supply, and the MCP reads no keys.

| Field | Default | Meaning |
|---|---|---|
| `visual.content.enabled` | `false` | Master switch; declaring any content rule while leaving it disabled is rejected by the schema (no "declared but silently skipped") |
| `visual.content.command` | none | The judge command you supply; a rule may override it with `command`; both missing is rejected |
| `visual.content.argsTemplate` | none | Argument template; the only allowed placeholders are `<image:path>`, `<expect:file>`, `<image:base64:file>` |
| `visual.content.cwd` | project root | Project-relative path |
| `visual.content.env` | `{}` | `{ childVarName: hostVarName }`; a missing host variable blocks the whole round |
| `visual.content.allowRemote` | `false` | Egress denied by default; a rule without the opt-in is rejected by the schema when it uses `<image:base64:file>` |
| `visual.content.samples` | `3` | Samples (1–9), majority vote |
| `visual.content.timeoutMs` | `90000` | Per-invocation timeout; the hard constraint `samples × timeoutMs ≤ limits.roundTimeoutMs` is enforced at configuration time |
| `visual.content.minConfidence` | omitted | Omitted turns the confidence gate off; it also does not apply when the command reports no confidence (the report says so) |
| `visual.content.cache` | `true` | Task-directory-level judgement cache |
| `visual.contents[].id` | required | Rule ID, deduplicated case-insensitively against the existing pages/images/viewports |
| `visual.contents[].files` | required | Project-relative image paths (deduplicated case-insensitively) |
| `visual.contents[].expect` | required | The expectation (1–4000 chars) |
| `visual.contents[].blocking` | `false` | `false` maps to `optional:true` (warning only); `true` joins failure and rework |
| `visual.contents[].samples` / `allowRemote` / `command` / `argsTemplate` / `cwd` / `env` | inherited | Per-rule overrides |
| `visual.pages[].pixel` | `true` | `false` means semantic-only: no pixel comparison or baseline requirement (requires `content`, and must not also declare `baseline`/`pixelThreshold`/`maxDiffRatio`) |
| `visual.pages[].content` | none | Page-level content check sharing the same screenshot; the derived id `<pageId>-content` must not collide with a declared id |

The enable gate is relaxed to "at least one of `pages` / `images` / `contents`". Reason codes, debouncing, the cost
boundary, and the egress statement are in the "AI content validation" section of
[visual acceptance](visual-acceptance.en.md).

## FAQ

- **verify can't find node/npx** — tianshu-mcp subprocesses inherit PATH with the system node dir prefixed. Check your PATH if it still fails.
- **Temporary extra verification** — `verify_task(taskId, extraChecks=[{name:"x", cmd:["…"]}])` without editing files.
