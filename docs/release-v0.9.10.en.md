# v0.9.10 — Qoder CN dispatch support removed (breaking change)

> **The `qoder` agent's dispatch support is removed entirely: directory deleted, wiring cleaned up,
> fix-loop branches removed, tests rewritten, docs fully swept.**
>
> This is release 3 of the six-release plan "remove TraeWork and Qoder CN support". Release 2
> (0.9.9) had already removed TraeWork; this release removes the other GUI adapter that kept
> producing real-machine defects.

**This is a breaking change**: a host that pinned `agentId: "qoder"` in its config will fail after
upgrading (`agent_unresolved`). The other five agents and `stub` are behaviourally unchanged, and
the tool surface is still 8 tools.

---

## Breaking changes

| Change | Impact |
|---|---|
| The `qoder` agent is gone | `query_info(type="profiles")` no longer lists it; `run_task(agentId="qoder")` → `agent_unresolved` hard failure |
| The `modelSource` parameter is deprecated | Any agent passing `modelSource` is rejected uniformly (with a pointer to remove it) |
| Legacy `agentId:"qoder"` tasks | `rework` / `continue` land on `failed(agent_unresolved)` — **never silently re-run by a CLI adapter** |

### Migration

- **A host config that hard-codes `agentId: "qoder"`**: switch to an agent that still exists
  (codex / zcode / kimicode / opendesign / minimax), or downgrade the MCP version.
- **Passing `modelSource`**: drop the parameter (no adapter consumes it any more).

---

## Details

### Removed

```text
src/agents/qoder/adapter.ts      src/agents/qoder/cdp.ts        src/agents/qoder/dialog.ts
src/agents/qoder/discovery.ts    src/agents/qoder/instance.ts   src/agents/qoder/liveness.ts
src/agents/qoder/model.ts        src/agents/qoder/profile.ts    src/agents/qoder/questions.ts
src/agents/qoder/references.ts   src/agents/qoder/run.ts        src/agents/qoder/selectors.ts
src/agents/qoder/workspace.ts
→ the whole src/agents/qoder/ directory is gone
```

10 `qoder-*` test cases are deleted.

### Source wiring

| File | Change |
|---|---|
| `src/agents/builtin.ts` | Removed the `QODER_PROFILE` import and registry entry; dropped qoder from the port-base comment |
| `src/agents/registry.ts` | Removed the `QoderGuiAdapter` / `discoverQoder` imports; dropped `qoder` from the default CLI list; removed the `qoder-gui` adapter branch and the `discoverQoder` probe branch |
| `src/config/schema.ts` | Dropped `qoder-gui` from the `adapter` enum; updated the `superRefine` message; the `modelSource` comment now says "deprecated" |
| `src/mcp/handlers.ts` | Removed the `validateQoderReferences` / `normalizeLevel` imports; removed the `modelSource` guard and the `qoder-gui` branch; added a unified `modelSource` deprecation rejection (one on each of the with/without-project paths) |
| `src/loop/fix-loop.ts` | Removed the qoder-specific rework branches (original-report gate + full-plan injection + session persistence); **`actualModel` is now persisted unconditionally** (see below) |
| `src/tasks/task-manager.ts` | Removed the qoder rework / continue branches; dropped qoder from the continue whitelist message |
| `src/tasks/task.ts` / `src/mcp/formatter.ts` | Removed the `qoderSessionId` / `qoderTurnId` fields and pass-through |
| `src/mcp/context.ts` | Removed the `meta.agentId === "qoder"` resume-context branch |
| `src/mcp/tools.ts` / `src/server.ts` | Dropped the Qoder CN / modelSource paragraphs from descriptions and instructions |
| Others | Dropped qoder from comments in minimax / opendesign / zcode / verify |

### Pre-existing defect fixed along the way: `actualModel` persistence

`meta.actualModel = runRes.actualModel ?? ...` in `fix-loop` was inside
`if (meta.agentId === "qoder")`. But `actualModel` has **two producers**: qoder and **Open Design**
(`opendesign/run.ts`'s `result({ ..., actualModel })`). Because that assignment was gated behind the
qoder branch, **Open Design's model read-back was never persisted** — `context.ts`'s
`meta.actualModel ?? meta.model` always took the `??` right side for it.

Removing Qoder exposed this defect. This release moves the assignment **out of the qoder branch and
makes it unconditional**, so Open Design's `actualModel` is now correctly written into the task
snapshot and meta. This is a behaviour change and is logged in the release note.

### Legacy task re-runs fail closed

The registry no longer pre-registers a CLI base for qoder, so `resolve("qoder")` returns `ok:false`.
A leftover `agentId: "qoder"` task in the data directory that gets `rework` / `continue` lands on
`failed(agent_unresolved)` and is **never silently re-run by a CLI adapter** (locked by the new
`test/integration/legacy-removed-agent-rework.test.ts`).

---

## Verification

| Gate | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run lint` (`--max-warnings 0`) | 0 warnings |
| `npx vitest run test/unit test/integration test/protocol` | **all green** (see the commit) |
| `npm run build && npm run check:stdio` | stdout clean |
| Behavioural blast radius | The existing integration cases for the other five agents (codex / zcode / kimicode / opendesign / minimax) all pass unchanged |

**Regression focus**: `test/integration/legacy-removed-agent-rework.test.ts` locks "a legacy qoder
task fails closed on re-run and is not bailed out"; `test/unit/registry-driver.test.ts` locks "the
registry no longer pre-registers a qoder base".
