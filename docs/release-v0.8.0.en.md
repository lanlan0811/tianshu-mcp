# v0.8.0 — Resuming an existing session no longer rewrites user intent (issues #35 / #30)

> See [CHANGELOG](../CHANGELOG.en.md#080---2026-10-06).

## Theme: a resume round must stay faithful to the original session

Two independent reports (TraeWork #35, ZCode #30) point at the **same family of defect**:
`continue_task` / `rework_task`, when resuming an existing session, **silently rewrote** the mode or
permission the user had originally requested back to a default. Neither raised an error or changed the
UI — the user only saw a resume that "succeeded but behaved wrongly", exactly the kind of distortion
that is hardest to notice. This release corrects both into **resume semantics faithful to the original
session**: whatever was requested is what is used; defaults apply only when no record exists.

## Fix 1: TraeWork — remove the cross-mode project-binding fallback (issue #35)

When binding in a non-Work mode (Code / Design) failed, `bindProject()` would **fall back to Work
mode** to complete the binding and then switch back. Under "each mode binds independently", that
fallback is **structurally unreachable**:

| Step | Expected | Actual |
|---|---|---|
| Bind in Code mode | Code mode holds the project | Fails (the "select folder" UI is unstable outside Work mode) |
| Fall back to Work mode | Complete the binding for Code | The project is bound to **Work** mode |
| Switch back to Code | Code mode still has the project | **Project lost** (not inherited across modes) |
| Outcome | Bound | **Still failed**, and the requested mode was silently rewritten to Work |

So the fallback neither rescues the failure nor preserves intent — it **overrides the requested mode**.
This release **removes the whole fallback branch**: a non-Work bind failure returns an honest failure and
**never changes the requested mode**, leaving the decision (retry / change mode / report) to the caller.

## Fix 2: ZCode — resume rounds preserve the original session permission (issue #30)

`runZcodeTask` first derived the permission from `ctx.resume.permissionMode`:

```ts
let permission = ctx.resume?.permissionMode ?? gui.defaultPermissionMode ?? "完全访问";
```

but then **unconditionally overwrote** it before dispatch:

```ts
permission = gui.defaultPermissionMode ?? "完全访问";   // ← regardless of resume
```

That overwrite sits **outside** the `initialDispatch` block and therefore also runs on resume rounds, so:

- the session permission was silently reverted to the profile default;
- that value was then **forced onto the UI** and read back;
- the reported `session.permissionMode` was distorted as well.

The fix **removes the mutation where the state was wrongly changed**, rather than patching a consumer:

- `permission` becomes `const` (the **only** assignment site in the file, so this is self-consistent);
- the unconditional overwrite is deleted — the profile default applies **only when no record exists**;
- on a read-back mismatch the error carries the **actual target permission** (it previously always said
  "完全访问", which misled diagnosis).

## Behaviour boundaries

- Neither fix changes any success-path behaviour, and neither adds features or UI changes.
- The fallback order when no record exists is **unchanged**: `ctx.resume.permissionMode` →
  `gui.defaultPermissionMode` → `完全访问`.
- A permission read-back mismatch still **hard-fails** (`endReason: permission_unknown`); only the
  message is now accurate.

## Verification

- **TraeWork**: `vitest run traework` — 15 files / 139 tests pass; reverting `session.ts` to the review
  baseline `39a00243` makes two behaviour tests fail faithfully
  (`expected 'Work' to be 'Code'` / `expected 'Work' to be 'Design'`) — the very root cause issue #35
  described ("lands in Work mode after switching back"); they pass once the implementation is restored.
- **ZCode**: after applying PR #37, three related test files report **85 passed**; reverting only
  `src/agents/zcode/run.ts` to the baseline yields **5 failed / 3 passed** on the new cases, failing
  exactly at the layer under test — `fake.permission` expected "受限访问" but got "完全访问", the
  physical manifestation of that unconditional overwrite.
- `tsc --noEmit` / ESLint `--max-warnings 0` / `git diff --check` pass.
- Both fixes were reproduced **RED→GREEN locally**; the PR descriptions were not taken on trust.

## Known limitations

- **The ZCode side has only a fake-CDP integration test; no real-machine (actual ZCode 3.14.x)
  reproduction** — the boundary declared in PR #37, carried over here. Real-machine verification is
  still outstanding.
- **Removing the TraeWork fallback relies on the existing "binding is not inherited across modes"
  semantics**; if upstream TraeWork changes that, this needs re-evaluation (the branch existed because
  the non-Work UI was unstable — with it gone, such failures now surface **honestly** instead of being
  masked by a fallback).
- In the full `vitest run`, `test/integration/zcode-rework-loop.test.ts` has a **timing flake waiting
  for a terminal state**, reproduced on base master too and unrelated to these two fixes.
- This release contains **no mcp-gui (log viewer) changes** — the GUI follows its own `gui-v*` version
  line (currently `0.1.1-beta.4`).

## Thanks

- @jian-in: the TraeWork binding fix (PR #36) and the ZCode permission-preservation fix (PR #37).
