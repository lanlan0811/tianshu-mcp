# tianshu-mcp v0.9.0

**Release date**: 2026-10-08
**Type**: Tool-surface consolidation (**BREAKING**)
**Chinese version**: release-v0.9.0.md

---

## In one line

The 13 MCP tools are merged by domain into **8**: `cancel_task` / `continue_task` / `rework_task` →
**`manage_task`**; `list_tasks` / `get_task_report` / `get_profiles` → **`query_info`**;
`wait_any` → **`wait_task` (batch mode)**. The two visual-baseline tools **stay separate**.

---

## Migration table (check before upgrading)

| Old call | New call |
|---|---|
| `cancel_task(taskId, reason?)` | `manage_task(taskId, action="cancel", reason?)` |
| `continue_task(taskId, message)` | `manage_task(taskId, action="continue", message)` |
| `rework_task(taskId, feedback?, repairHint?)` | `manage_task(taskId, action="rework", feedback?, repairHint?)` |
| `list_tasks(projectPath?, status?, limit?)` | `query_info(type="tasks", projectPath?, status?, limit?)` |
| `get_task_report(taskId, round?)` | `query_info(type="report", taskId, round?)` |
| `get_profiles()` | `query_info(type="profiles")` |
| `wait_any(taskIds, timeoutMs?)` | `wait_task(taskIds, timeoutMs?)` |
| `wait_task(taskId, timeoutMs?)` | **unchanged** |
| `run_task` / `query_task` / `verify_task` | **unchanged** |
| `prepare_visual_baseline` / `approve_visual_baseline` | **unchanged** (not merged) |

---

## Why the visual baselines are not merged

The original plan (§4.1 merge group 4) considered folding `prepare_visual_baseline` +
`approve_visual_baseline` into one `visual_baseline` tool. **This release explicitly declines**,
for two reasons:

1. **The gain is tiny**: together these tools are about 500 characters, 4% of the surface. And they
   carry a **tamper-check gate** — `approveBaseline` throws `CANDIDATE_CHANGED` when
   `digest(content) !== args.expectedDigest` (`src/visual/baselines.ts`). Folding `prepare` /
   `approve` into one tool's `action` branches would remove the explicit position of
   `candidateId` / `expectedDigest` / `approvalNote` from the parameter surface.
2. **Risk out of proportion**: 500 characters is not worth blurring a security gate.

By the same reasoning, the three high-frequency core tools — `run_task` / `query_task` /
`verify_task` — are **untouched**.

---

## Technical note: why branch constraints had to move into the sink

All three new tools use a **plain `z.object`**, not `z.discriminatedUnion`. That is not a style
choice but a hard constraint:

**Measured** (via the official SDK's `client.listTools()`, same path as production):

| zod form | Wire `inputSchema` | Outcome |
|---|---|---|
| `z.object({...})` | 382 chars, fields intact | usable |
| `z.object({...}).refine(...)` | **33 chars → `{"type":"object","properties":{}}`** | all parameter info lost |
| `z.discriminatedUnion("action", [...])` | **33 chars → `{"type":"object","properties":{}}`** | all parameter info lost |

The host LLM would see an empty schema with no parameters. Branch constraints therefore moved into
the handler's `checkBranchFields()` whitelist:

- `action=continue` requires a non-empty `message` (was schema-level `z.string().min(1, "message 不能为空")`)
- `type=report` requires a non-empty `taskId`
- `wait_task` requires **exactly one** of `taskId` / `taskIds`
- **Out-of-branch fields fail closed**: `action=cancel` carrying `message` is explicitly rejected
  ("action=cancel does not accept: message") rather than silently ignored — consistent with the
  project's fail-closed principle throughout.

---

## One trade-off in the annotation layer

`src/server.ts` hard-coded `destructiveHint` by tool name (`cancel_task` / `rework_task` /
`approve_visual_baseline`). After the merge only `manage_task` and `approve_visual_baseline` remain.

**MCP annotations are tool-level and cannot vary per action**, so `manage_task` has only two
options:

- set `true`: `action=continue` (resuming a task; non-destructive) is also marked — **slightly broad**
- set `false`: the destructive hints for `action=cancel` / `rework` are lost — **missing safety signal**

**This release chooses `true`** (over-report rather than under-report) and states "contains
destructive actions: cancel / rework" in the tool description. `requireApproval` stays `true`, so
the actual gate is unaffected.

---

## Verification

### Tool surface (measured)

| Metric | Value |
|---|---|
| Tool count | **8** (merged from 13) |
| Cross-repo `check-schema-parity.mjs` | **MCP tool surface (frontend mirror) (8 items)** passes |
| `mcp-gui` tests | **173 passed** |

### Tests

- **New `test/integration/tool-consolidation.test.ts` (21 cases)** pinning three invariants:
  ① exactly 8 tools and all 7 old names gone; ② the three new tools expose non-empty
  `inputSchema.properties` on the wire (guarding the empty-schema trap); ③ branch constraints
  still fail closed in the sink (missing `message`, missing `taskId`, violated either/or,
  `taskIds` over 20, …).
  **RED→GREEN complete**: 11 failed / 10 passed before → 21 passed after.
- `test/protocol/protocol.test.ts`: truth table 13 → 8 rows; tool-name array, the `idempotentHint`
  negative list and the `destructiveHint` assertion synced.
- Nine existing integration test files updated to the new call shapes (`cancel-noreason` /
  `cancel-state` / `idempotency` / `query-events` / `rework-feedback-race` / `rework-repair-hint` /
  `task-flow` / `verify-params` / `wait-task`).

### Gates

```
tsc --noEmit                exit 0
eslint --max-warnings 0     all green
node mcp-gui/scripts/check-schema-parity.mjs   8 items consistent
```

---

## Sync scope (four surfaces)

Renaming tools is a cross-surface operation; this release changes **all four at once**:

| Surface | Content |
|---|---|
| **Protocol tests** | `test/protocol/protocol.test.ts` truth table and name array |
| **GUI mirror** | `mcp-gui/src/core/capabilities.ts` (8 entries), `i18n/zh-CN.ts`, `i18n/en-US.ts`, `test/capabilities.test.ts` |
| **Runtime strings** | **47** "call continue_task" style hints under `src/agents/**` → `manage_task(action="continue")` |
| **Docs & skill** | `README` bilingual tool table, `ARCHITECTURE` bilingual, `skills/tianshu-mcp/SKILL.md`, `usage-examples.md`, `docs/wait-task.md` bilingual |

---

## Upgrade notes

**An old copy of the skill file will not be replaced automatically.** `skills/tianshu-mcp/` is
idempotently synced to `~/.rivet/skills/tianshu-mcp/` at server start, with an install manifest
(version + content hash). If the manifest is in the "needs change but not auto-overwritten" state,
release it once via the `--approve-skill-update` flow in `docs/agent-profiles.md`; otherwise the
skill text inside host sessions may still point at removed tool names.

**Nothing else needs manual intervention**: runtime strings, the GUI mirror and the protocol tests
all ship with the package.
