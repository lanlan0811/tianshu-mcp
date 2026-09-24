# v0.6.5 — Three-level acceptance config inheritance

> Related issue: [#20](https://github.com/lanlan0811/tianshu-mcp/issues/20). See the
> [acceptance config spec](acceptance-config.en.md).

## Background

Previously only the project-level `.tianshu-mcp/acceptance.json` could override fields such as
`requireChanges` / `verifyConcurrency`. With several similar projects (say multiple frontend repos)
mounted under one Tianshu host, creating a config file per project is costly and easy to forget.

## Added

- **Three-level inheritance chain** (low → high priority):

  | Order | Layer | Source |
  |---|---|---|
  | 1 | Global fallback | `<data home>/acceptance.default.json` (absent = empty config, no error) |
  | 2 | Project override | `<project>/.tianshu-mcp/acceptance.json` |
  | 3 | Transient task override | The `acceptanceOverride` argument of `run_task` / `verify_task` |

- **The `acceptanceOverride` argument**: same format as `acceptance.json`; it applies **only to that
  task / that verification** and is saved with the task snapshot. It is **task data, not
  configuration**: it writes no `acceptance*.json`, and affects no other task on the same project nor
  any other project. A later `rework_task` / `continue_task` on the same task reuses that snapshot, so
  the override keeps applying. Project-less mode **explicitly rejects** the argument (there is no
  project acceptance to override, and silently ignoring it would mislead the caller).
- **`tianshu-mcp config acceptance [projectPath] [--task <taskId>]`**: prints which layers exist, the
  effective `appliedOrder`, the final `effective` values and a one-line summary. Each acceptance round
  also writes a same-source summary line to `server.log`. The command returns before the MCP server is
  created and writes only human-facing stdout.
- New `src/config/acceptance-merge.ts`: a purpose-scoped merge helper (**deliberately not a
  general-purpose deep merge**).

## Fixed: the `.default()` pollution in layered parsing

`AcceptanceConfigSchema` puts `.default(true)` on `requireChanges`. Parsing a project file that only
sets `verifyConcurrency` with it materializes `requireChanges: true`, which in the three-level chain
would **in turn override the global layer's `requireChanges: false`** — silently defeating the chain.

Fix: a **default-free** `PartialAcceptanceConfigSchema` is now used for layered parsing; defaults are
applied only when the final effective value is absent. `AcceptanceConfigSchema` is kept for existing
visual/legacy callers.

## Key design decisions

| Decision | Rationale |
|---|---|
| Merge granularity = field | A field a higher layer **explicitly writes** wins outright; `undefined` means "not written by this layer" and does not participate |
| Arrays replace wholesale | If `checks` is written it replaces the whole array. Concatenating would turn "the project adds one check" into "the project can never remove a global check" — ambiguous and unpredictable |
| **`visual` replaces wholesale, not deep-merged** | Nearly every `visual` schema field carries a default, so deep merging would let a higher layer's "not written, present only as a default" fields silently clobber a lower layer's **explicit** values (the same pollution class as `requireChanges`). Doing it correctly requires merging raw JSON and validating only the result — a larger change for limited benefit, so wholesale replacement is the deliberate choice |
| Broken layer fails closed | A layer that exists but is unreadable / invalid JSON / fails validation is not skipped as empty; it pushes the round to `needs_attention` naming the layer and file. Only `ENOENT` counts as "layer absent" |
| visual comes from the merged result | `executeVerify` no longer re-reads the project file, otherwise the `visual` from override/global layers would change meaning based on whether a project file happens to exist |
| Included in idempotency digests | Both `runTaskKeyedFields()` and `verifyIdempotencyDigest()` include `acceptanceOverride` — otherwise a same-key replay would return an old task built on a **different** policy |
| One summary line per round | `resolveChecks()` emits `生效层=… checks=… requireChanges=… verifyConcurrency=…`, sharing its source with `config acceptance` |
| The debug command is not under the `visual` namespace | `acceptance.json` is the acceptance engine's config; visual acceptance merely shares the file, and nesting it under visual would mislead |

**One deliberate deviation from the issue**: the issue suggested "config merging should use a deep
merge strategy". This version implements that correctly for **scalars** (the very fields the issue
names — `requireChanges` / `verifyConcurrency`) and for arrays, but deliberately chooses **wholesale
replacement** for `visual`, for the reason in the table above. The deviation is recorded in the
CHANGELOG, in both `acceptance-config` docs, and in ARCHITECTURE §7.4, so a future maintainer can
reassess it.

## Compatibility

- **No tool contract, data model or MCP annotation changes.** `acceptanceOverride` is a new optional
  argument; `extraChecks` semantics and precedence are unchanged (still above the base set).
- **Without creating a global `acceptance.default.json`, single-project behaviour is exactly as in
  v0.6.4.**
- The existing semantics of the project-level `.tianshu-mcp/acceptance.json` are unchanged; error
  semantics remain fail-closed.

## Tests

- 36 new cases across 3 files:
  - `test/unit/acceptance-merge.test.ts` (18): scalar override / lower-layer-only fields preserved /
    `checks` wholesale replacement / `visual` wholesale replacement / `undefined` not counting as
    written / both layers empty; `resolveAcceptanceLayers` ordering and skipping absent layers;
    `summarizeResolved`; **the `.default()` pollution contrast** (the layered schema adds nothing vs the
    defaulting schema adding `true`, plus proof that "a project layer setting only verifyConcurrency
    does not override a global `requireChanges=false`"); `verifyConcurrency` clamping;
    `readAcceptanceLayer` for absent / valid / broken JSON / invalid fields / a directory read as a file.
  - `test/integration/acceptance-override.test.ts` (6): overriding `checks` flips the verdict and
    **affects only that task** (a sibling task falls back to the project config); `verify_task` also
    accepts the override and it **does not stick** (the next call without it fails again, with the round
    advancing); project-less mode rejects the argument; the global layer participates while its absence
    behaves as before; the project layer outranks the global layer; a broken global file yields
    `needs_attention` naming that layer.
  - `test/unit/config-cli.test.ts` (12): three-layer detection and `appliedOrder`; a global-only field
    not cleared by the project layer; `--task` reading the snapshot with the override on top; an absent
    task reported honestly; an explicit note when `--task` is omitted; a broken layer **visible per
    layer** while the others still parse; unknown options / extra arguments rejected; `summary`
    consistent with `effective`.
- Full `npm test`: **1073 passed / 12 skipped** (99 files; v0.6.4 was 1037 passed / 12 skipped, a net
  gain of 36).
- `check:stdio`: **8/8** for both dist and src (no new MCP tools, scenario count unchanged).
- Manual CLI smoke: `node dist/index.js config acceptance` prints the three layers and values (with no
  layers present: `ok=true`, `appliedOrder=[]`).

## Real-machine record

This issue's acceptance criteria are "the three-level chain merges correctly with unit tests", "a debug
command or log to view the final effective config", and "a missing global file does not error" — all
three are covered by the unit / integration tests and the CLI smoke above, with **no real-machine GUI
dependency**, so this version needs no real-machine record.
