# v1.0.0-beta.1 — Parameter-surface convergence

> **Removes the TraeWork-specific `mode` field and all its pass-through, and neutralises the
> deprecated `TraeworkMode` type — `grep -rin traework src/` is now zero.**
>
> This is release 4 of the six-release plan "remove TraeWork and Qoder CN support": the first two
> releases deleted the two agents, and this one sweeps up the parameter surface they left behind.

**No behaviour change in this release**: tool names / parameter sets / validation semantics are
unchanged. `mode` is still in `run_task`'s input schema and still rejected uniformly by the handler —
there is simply no longer any internal field carrying it.

---

## Changes

### Removed the `mode` field and its pass-through chain

| File | Change |
|---|---|
| `src/agents/adapter.ts` | Removed `TaskContext.mode` |
| `src/tasks/task.ts` | Removed `TaskMeta.mode` |
| `src/tasks/task-manager.ts` | Removed `NewTaskInput.mode` and its persistence |
| `src/mcp/formatter.ts` | Removed `MetaBlockFields.mode` and its pass-through |
| `src/mcp/context.ts` | Removed the `mode` pass-through |
| `src/mcp/handlers.ts` | Removed three `mode: args.mode` pass-throughs |

These fields had no consumer since 0.9.9 (their only consumer, TraeWork, was removed); they were
hollow shells "kept so old callers get a message". **The migration message is carried by the
handler's unified rejection**, not by these fields.

### Type neutralisation

`TraeworkModeSchema` / `TraeworkMode` → `DeprecatedPanelModeSchema` / `DeprecatedPanelMode`. The
`mode` key stays in `RunTaskParamsSchema` as an **explicit deprecation rejection** — `src/config/schema.ts`
is a bare `z.object` (unknown keys are stripped by default), so deleting the key would make the
parameter "vanish" with no explanation.

**Effect**: `grep -rin traework src/` returns zero hits (the src side of this plan's G2 goal).

---

## Verification

| Gate | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run lint` (`--max-warnings 0`) | 0 warnings |
| `npx vitest run test/unit test/integration test/protocol` | all green |
| `npm run build && npm run check:stdio` | stdout clean |
| Zero residue | `grep -rin traework src/` → 0 hits |

**Regression focus**: `test/unit/zcode-handler.test.ts` locks "passing `mode` → the unified
deprecation message and no task submitted" (proving the rejection path still works after the field
was removed); `test/unit/registry-driver.test.ts` locks the registry's driver/adapter selection and
the `driver="gui"`-without-`adapter` fail-closed behaviour.
