# tianshu-mcp v0.8.4

**Release date**: 2026-10-07
**Type**: Tool-surface slimming (no breaking changes)
**Chinese version**: release-v0.8.4.md

---

## In one line

`run_task` / `verify_task` now declare `acceptanceOverride` in a skeleton form, taking
`tools/list` from **35,581 → 11,717 characters (−67.1%)**. Tool names, parameter sets and
validation semantics are all unchanged.

---

## Background: what actually makes up the tool surface

Measured before the change (real wire bytes via the official SDK's `client.listTools()`,
same registration path as production):

```
tool count: 13
tools/list total: 35581 chars

 13619  run_task          ← of which 12483 is the acceptanceOverride subtree
 13029  verify_task       ← of which 12196 is the acceptanceOverride subtree
   924  prepare_visual_baseline
   884  query_task
   777  approve_visual_baseline
   777  continue_task
   754  rework_task
   727  wait_task
   677  cancel_task
   652  wait_any
   576  list_tasks
   559  get_task_report
   449  get_profiles
```

**Two tools account for 74.9%; `acceptanceOverride` alone accounts for 69.4% of the whole surface.**

## Root cause

`acceptanceOverride` inlined `PartialAcceptanceConfigSchema`, which assembles to 11,005 chars:

| Component | Chars |
|---|---|
| `VisualConfigSchema` | **9,579** (87%) |
| `AcceptanceCheckSchema` | 380 |
| Remaining scalar fields | ~550 |

Under MCP, **each tool's `inputSchema` is serialised independently** and `$ref` cannot be shared
across tools — so `run_task` and `verify_task` each inlined a full copy, **24,679 chars combined**.

This also explains an easy misjudgement: **the main battlefield is not tool count**. The nine tools
involved in the then-planned "13 → 8 merge" add up to only 6,145 chars (17.3% of the surface) —
even with zero schema growth after merging, the ceiling is a fraction of this release's gain.

## Changes

### 1. Wire declaration slimmed to a skeleton

New `AcceptanceOverrideWireSchema` (`src/config/schema.ts`), used by `RunTaskWireSchema` /
`VerifyTaskWireSchema`:

| Field | Strict form | Skeleton form |
|---|---|---|
| `checks` | array of `AcceptanceCheckSchema` | **unchanged** (full validation kept) |
| `visual` | `VisualConfigSchema` (9,579 chars) | `z.record(z.unknown())` (opaque) |
| `requireChanges` | `z.boolean().optional()` | **unchanged** |
| `verifyConcurrency` | `z.number().transform(...)` | **unchanged** |

Per tool: `run_task` 14,435 → 2,503, `verify_task` 13,366 → 1,434, the other 11 unchanged.

### 2. Validation sink (paired with the slim — cannot be split)

**This is the most critical part of the release.** Measurement before the change showed that the
**wire `inputSchema` was the *only* validation layer for `acceptanceOverride`** —
`grep acceptanceOverride src/ | grep parse` returned nothing, and both handlers merely cast with
`rawArgs as XxxParams`.

Consequence: once `visual` became opaque, invalid inner fields (e.g. `visual.enabled: "yes"`) would
**pass straight through the SDK layer into the handler** — a fail-open regression.

Hence `validateAcceptanceOverride()` was added at the entry of `runTaskHandler` /
`verifyTaskHandler`, re-checking with the strict `PartialAcceptanceConfigSchema`. Measured:
invalid input is still rejected, and the error is correctly attributed to the handler sink
(message contains `acceptanceOverride 参数不合法`, not the SDK's `-32602`).

## Verification

### Size (measured)

| Metric | Before | After |
|---|---|---|
| `tools/list` total chars | 35,581 | **11,717 (−67.1%)** |
| `run_task` | 14,435 | 2,503 |
| `verify_task` | 13,366 | 1,434 |
| Tool count | 13 | **13 (unchanged)** |

### Tests (including counter-proofs)

- **Sink regression**: 4 cases target the `visual` gap that *only* the sink can catch, asserting
  error origin. **Counter-proof**: temporarily removing both sink checks turned exactly 4 cases red,
  the other 8 staying green.
- **Wire-schema contract**: asserts every tool except the by-design parameterless `get_profiles`
  exposes non-empty `inputSchema.properties` — pinning the `.refine()` / `z.discriminatedUnion`
  trap (measured to serialise as `{"type":"object","properties":{}}`, losing all parameters).
- **Compile-time parity lock**: wire and strict schemas must be mutually field-equivalent, and the
  skeleton must contain exactly four fields. Counter-proofed (stray field → TS2322); the earlier
  conditional-type-alias version **did not error at all** and was discarded.

### Gates

```
tsc --noEmit                exit 0
eslint --max-warnings 0     all green
```

## Known limitations

- **`visual` is no longer self-describing**: host LLMs see only an opaque object without inner
  field names (`viewports` / `pages` / `defaults`, …). Functionality is unaffected, but field
  details now require [docs/acceptance-config.en.md](acceptance-config.en.md). That is the direct
  price of the 67% reduction.
- **No tool merging**: this release renames no tools. The planned 13 → 8 merge was not
  implemented — it yields ~2,000–4,000 chars while touching four surfaces (protocol tests, GUI
  mirror, 44 runtime strings). Deferred until warranted.

## Upgrade notes

**No caller changes required.** Tool names, parameter names, parameter constraints and error
semantics are all preserved.

The only visible difference is that the host LLM now sees `acceptanceOverride.visual` as an opaque
object rather than an expanded field list — this affects the model's ability to infer fields on its
own, not actual argument passing or validation.
