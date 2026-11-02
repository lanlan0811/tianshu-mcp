# v0.9.9 — TraeWork dispatch support removed (breaking change)

> **The `traework` agent's dispatch support is removed entirely: directory deleted, wiring cleaned
> up, tests rewritten, docs fully swept.**
>
> This is release 2 of the six-release plan "remove TraeWork and Qoder CN support". Release 1
> (0.9.8) had already moved the CDP transport shared by six GUI adapters out of `traework/`; this
> release actually deletes the directory.

**This is a breaking change**: a host that pinned `agentId: "traework"` in its config will fail after
upgrading (`agent_unresolved`). The other six agents and `stub` are behaviourally unchanged, and the
tool surface is still 8 tools.

---

## Breaking changes

| Change | Impact |
|---|---|
| The `traework` agent is gone | `query_info(type="profiles")` no longer lists it; `run_task(agentId="traework")` → `agent_unresolved` hard failure |
| The `driver="gui"` fallback is gone | A custom GUI profile that declares `driver="gui"` without an `adapter` now **fails at parse time** (older versions silently fell back to `traework-gui`) |
| The `mode` parameter is deprecated | Any agent passing `mode` is rejected uniformly with a pointer to `designDirection` |

### Migration

- **A host config that hard-codes `agentId: "traework"`**: switch to an agent that still exists
  (codex / zcode / kimicode / qoder / opendesign / minimax), or downgrade the MCP version.
- **A custom GUI profile missing `adapter`**: add it explicitly — one of
  `codex-gui` / `zcode-gui` / `kimicode-gui` / `qoder-gui` / `opendesign-gui` / `minimax-gui`.
  The error message already lists this set; just follow it.
- **Passing `mode`**: drop the parameter; to express a design direction use `designDirection`
  (Open Design).

---

## Details

### Removed

```text
src/agents/traework/adapter.ts          src/agents/traework/cdp/client.ts   (the 0.9.8 shell)
src/agents/traework/cdp/selectors.ts    src/agents/traework/computeruse/dialog.ts
src/agents/traework/computeruse/guard.ts src/agents/traework/discovery.ts
src/agents/traework/launcher.ts         src/agents/traework/run.ts
src/agents/traework/ui/composer.ts      src/agents/traework/ui/model.ts
src/agents/traework/ui/reply.ts         src/agents/traework/ui/session.ts
→ the whole src/agents/traework/ directory is gone
```

15 `traework-*` test cases are deleted; the "fake CDP drives the real run logic" approach from
`test/integration/traework-fake-cdp.test.ts` is preserved in `test/fake-cdp.ts` (kimicode /
opendesign still use it).

### Source wiring

| File | Change |
|---|---|
| `src/agents/builtin.ts` | Removed the whole `traework` profile block; dropped traework from the port-base comment |
| `src/agents/registry.ts` | Removed the `TraeworkGuiAdapter` / `discoverTraework` imports; dropped `traework` from the default CLI list; removed the `traework-gui` branch and the downgrade condition; added a **defensive fallback** for `driver="gui"` without `adapter` (schema already blocks it, this blocks it again) |
| `src/config/schema.ts` | Dropped `traework-gui` from the `adapter` enum; added a `superRefine` on `AgentProfileSchema` — `driver="gui"` without `adapter` fails closed, with the message listing every valid adapter |
| `src/agents/adapter.ts` / `src/tasks/task.ts` / `src/tasks/task-manager.ts` | The `mode` field comment now says "deprecated"; `mode?: TraeworkMode` is kept (see below) |
| `src/mcp/handlers.ts` | Removed the five scattered "XX does not support mode" rejections and consolidated them into **one unified deprecation message** (before any agent branch) |
| `src/mcp/tools.ts` | Dropped the TraeWork paragraph from the `run_task` description; now states that `mode` is deprecated |
| `src/server.ts` | Dropped traework from the agent list in `instructions` |
| `src/loop/fix-loop.ts` / `repair-plan.ts` / `mcp/context.ts` / `formatter.ts` | Removed TraeWork from comments |

### Why the `mode` key stays in the schema

`src/config/schema.ts` uses bare `z.object` (**strip by default, not reject**): deleting the `mode`
key outright would leave old callers seeing the parameter simply "disappear" with no explanation.
So the key stays and the handler rejects it uniformly with a readable migration message. Its type is
still `TraeworkMode` (`Work` / `Code` / `Design`) — it now only serves "read an old task snapshot +
the migration message"; renaming and removing it are left to a later release.

---

## Verification

| Gate | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run lint` (`--max-warnings 0`) | 0 warnings |
| `npx vitest run test/unit test/integration test/protocol` | **128 files passed / 3 skipped; 1611 tests passed / 12 skipped** |
| `npm run build && npm run check:stdio` | stdout clean |
| Behavioural blast radius | The existing integration cases for the other six agents (codex / zcode / kimicode / qoder / opendesign / minimax) all pass unchanged |

**Regression focus**: `test/unit/registry-driver.test.ts` (formerly `traework-driver`) adds a case
for "`driver="gui"` without `adapter` → fail closed, with the message naming every option";
`test/unit/zcode-handler.test.ts` locks "passing `mode` → the unified deprecation message and no task
submitted"; `test/fake-cdp.ts` is retained, proving the fake-CDP approach still works for kimicode /
opendesign.
