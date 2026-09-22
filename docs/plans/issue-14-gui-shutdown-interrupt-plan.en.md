# Issue #14: truthful GUI terminal state on server exit — v0.5.9 fix plan

## 1. Objective and findings

Make `tianshu-mcp` tell the **truth** about `driver="gui"` agents on two paths — **server exit / host EOF** and **restart archiving**. A GUI agent is an external desktop application: the server owns no process for it, and after an abort the adapter can at best best-effort click the in-app stop control. Assertions such as "the process has been terminated" are only valid for `driver="spawn"` children and must never appear for GUI agents.

Reported in [#14](https://github.com/lanlan0811/tianshu-mcp/issues/14): `persistInterrupted()` in `src/tasks/task-manager.ts` writes `lastMessage = "server 退出，进程已终止"` for every active task, and `initialize()` archives restart leftovers with only "server 重启遗留（启动时归档，不续跑）。" — neither states the GUI outcome honestly nor asks for a manual check. The effect: **the orchestrator is dead, the GUI may still be editing the user's project, and nobody is watching**.

Four facts confirmed by reading the code (the entire basis of this plan):

1. `persistInterrupted()` has no `guiStop` concept and uses one message for both spawn and gui; the GUI stop wait (`gui.cancelWaitMs`, 15 s default) is far longer than its fixed 2 s budget, so a confirmed result is almost never written.
2. The interrupted branch of `abortTerminal()` in `fix-loop.ts` (the competing writer in that race) never mentions the GUI at all, and picks the window name with a hard-coded ternary that reports `zcode`/`qoder` as "Codex" — itself a distortion.
3. `fix-loop.ts` persists `runRes.guiStop` only for `qoder`; the other GUI agents lose the adapter's stop result in the shutdown race.
4. The ZCode and TraeWork adapters never click stop and never produce `guiStop` (documented in v0.5.8). "No stop result" and "confirmed idle" must be distinguished, or the fix introduces a new false claim.

Baseline: `master`, version `0.5.8`; the only uncommitted change is `.gitignore` (`.dsh/*`, not from this work).

## 2. Implementation

### 2.1 Structured fields (`src/tasks/task.ts`)

| Field | Meaning | Written by |
|---|---|---|
| `interruptedCleanStop?: boolean` | whether the in-GUI run is **confirmed** stopped for this interruption | `abortTerminal()` / `persistInterrupted()` |
| `guiResidualUnconfirmed?: boolean` | GUI `interrupted` terminal state still awaits manual confirmation (always set on restart archiving) | `initialize()`; cleared by the manual `cancel_task` confirmation |

Decision matrix (the single implementation of red line 8): `guiStop.idle === true` → confirmed stopped; `idle === false` → stop was attempted but unconfirmed; **field absent → no stop result, and a stop must not be claimed either**. `TaskMeta.guiStop` now means "the GUI-side stop result of the most recent abort" and is persisted for every agent.

### 2.2 Shared pure helpers (`src/tasks/task.ts`)

- `guiAppNameOf(displayName, agentId)` — derives the window name from the profile, stripping descriptive parentheticals and generic suffixes (`Codex (ChatGPT 桌面端 GUI)` → `Codex`) and **falling back to the original string when stripping would empty it** (no unbounded stripping; `TraeWork（测试）` is preserved). Missing `displayName` falls back to `agentId`.
- `guiStopDisclosure(stop, app)` — returns `{ clean, text }` and centralises the three honest wordings ("confirmed stopped" / "stop unconfirmed (a click was attempted)" / "no stop result to confirm"). Both the cancellation path and the interruption path use it, so the two standards cannot drift apart.

### 2.3 Bounded wait on shutdown (`src/tasks/task-manager.ts`)

- New budget `shutdown.guiStopWaitMs` (default 15000, overridable in `config.json`), injected by `initialize()`. `initialize(maxRunning | { maxRunning, guiStopWaitMs })` stays backward compatible with the historical numeric signature, so the eight existing call sites are untouched.
- `shutdownInterrupt()` computes one **global** deadline (all GUI tasks share a single budget, so exit time does not scale with task count); GUI tasks wait until that deadline while spawn tasks keep their existing 2 s budget.
- `persistInterrupted()` branches on the driver: spawn keeps "server 退出，进程已终止"; GUI writes the disclosure text and `interruptedCleanStop` from `guiStopDisclosure(meta.guiStop, app)`. If the orchestrator already settled within the budget, the method returns and keeps its more precise message.
- `initialize()` awaits each leftover archive and labels it honestly; an unreadable profile is conservatively treated as GUI (better one extra manual check than a false claim).

### 2.4 Orchestrator-side completion (`src/loop/fix-loop.ts`)

- `abortTerminal()` persists `meta.guiStop` plus `interruptedCleanStop`/`guiResidualUnconfirmed` on both branches and appends the honest disclosure text; the window name comes from `deps.dataHome.getProfile()` instead of a hard-coded agentId mapping.
- The GUI disclosure is applied only when `driver="gui"`. Spawn children are terminated by `killTree`, so applying GUI wording to them would be a new distortion.
- `runRes.guiStop` is now persisted for every agent.

### 2.5 Manual confirmation and observability (reuse existing tools, no new tool)

- For a **terminal** GUI task carrying the pending marker, `cancel_task` clears `guiResidualUnconfirmed`, sets `interruptedCleanStop = true`, appends a `gui_residual_acknowledged` event, **does not change the terminal status or errorType**, and returns `cleared: true`.
- The `query_task` / `list_tasks` meta block gains `guiStopUnconfirmed` (`guiResidualUnconfirmed === true || interruptedCleanStop === false`), giving the orchestrating agent one structured reason not to re-dispatch.
- Explicitly **not** doing: no automatic CDP reconnection inside `initialize()` to click stop. The adapters are fail-closed for instances without proof of ownership, and after a restart there is no session anchor; unattended clicking carries more risk than value. Honest labelling plus manual confirmation satisfies red line 8.

## 3. Interfaces and defaults

| Item | Change | Notes |
|---|---|---|
| `config.json` → `shutdown.guiStopWaitMs` | new, default `15000` | global upper bound for the GUI stop wait on shutdown, decoupled from `gui.cancelWaitMs` |
| `TaskMeta` | adds `interruptedCleanStop`, `guiResidualUnconfirmed` | structured terminal facts, persisted in the `task.json` snapshot |
| meta block | adds `guiStopUnconfirmed` | single read-side predicate |
| `cancel_task` | can clear the pending marker on a terminal GUI task (`cleared`) | no new tool; the tool count stays 11 |
| MCP tool parameters / state machine | unchanged | no new `TaskStatus`, `TRANSITIONS` untouched |

## 4. Tests and acceptance

- **Unit (`test/unit/gui-stop-disclosure.test.ts`, 9 new cases)**: the three-state decision and wordings, window-name derivation with the "never strip to empty" fallback, and the guarantee that no input produces "the process has been terminated".
- **Integration (`test/integration/gui-shutdown-interrupt.test.ts`, 5 new cases)**: a scripted adapter subclassing the **real** `CodexGuiAdapter` (required — a plain implementation would be replaced by `ensureAdapterFor`) covers `idle=true`, `idle=false` and no-result shutdown, restart archiving plus the `cancel_task` acknowledgement, and the fact that spawn tasks are unaffected by the GUI branching.
- **Config (`test/unit/config-hotreload.test.ts`)**: `guiStopWaitMs` default and override.
- **Existing regressions**: every test that calls `shutdownInterrupt()` / `initialize(number)` (`cancel-state`, `zcode-restart`, `zcode-flow`, `visual-rework`, …) must stay green, proving signature compatibility and no spawn wording regression.
- **Gate**: `npm run typecheck`, `npm run lint` (`--max-warnings 0`), `npm test`, `npm run build`, `npm run check:stdio` all pass; target version `0.5.9`.
- **Manual review**: run one GUI shutdown, then read `tasks/<id>/task.json` and the event stream to confirm no "process terminated" style claim and that fields and wording match the §2.1 matrix.

## 5. Documentation, commit and release

- This plan is stored as two separate files (Chinese and English) under `docs/plans/`, matching the repository convention.
- Sync: both `CHANGELOG` files (`[0.5.9]`), both `docs/release-v0.5.9` files, both `README` files (tool table, milestone, latest-release links), both `ARCHITECTURE` files (task lifecycle, agent capability table, config table), `HANDOFF`, both `docs/agent-profiles` files, both `docs/adapter-matrix` files, and the skill files `SKILL.md` and `usage-examples.md`.
- Work on `master` only, never a branch; follow the repository rules (`git add .`, Chinese commit messages), split implementation and documentation into two commits, and push to GitHub then Gitee in order.
- Tagging `v0.5.9` and triggering `release.yml` require a separate confirmation; CI/Release success will be checked then. The `tianshu-mcp-web` site directory is not touched.
