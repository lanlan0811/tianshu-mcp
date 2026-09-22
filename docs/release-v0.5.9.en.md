# tianshu-mcp v0.5.9 release notes

[简体中文](release-v0.5.9.md)

**Fix: on server exit and restart archiving, a GUI agent's terminal state no longer claims the stop was confirmed** ([issue #14](https://github.com/lanlan0811/tianshu-mcp/issues/14)).

## The problem

`driver="gui"` agents (codex / zcode / kimicode / qoder / traework) are **external desktop applications** and `tianshu-mcp` **owns no process** for them. After an abort the adapter can at best best-effort click the in-app stop control, and only Codex / Kimi Code / Qoder CN can do even that. The old code:

- wrote `lastMessage = "server 退出，进程已终止"` (server exited, process terminated) for **every** active task in `persistInterrupted()`;
- archived restart leftovers in `initialize()` with only "server 重启遗留（启动时归档，不续跑）。".

So the snapshot claimed the process was terminated while a task in a ZCode/Codex window **might still be running autonomously and editing the user's project**. After a restart those tasks were neither observed nor flagged for a manual check. The risk: **the orchestrator is dead, the GUI keeps editing the user's project, and nobody is watching** — terminating the external task is not the same as terminating its external effects.

## The fix

**Terminal wording branches on the driver (spawn semantics are no longer applied to GUI agents)**

| Situation | Terminal message |
|---|---|
| spawn child | `server 退出，进程已终止` (unchanged; `killTree` really does kill the tree) |
| GUI, UI confirmed idle | `server 退出；已确认 <window> 内运行停止。` |
| GUI, a stop was clicked but idle is unconfirmed | `server 退出；<window> 内运行未确认停止，窗口中的任务可能仍在继续，请人工打开 <window> 确认无残留运行。` |
| GUI, no stop result (e.g. ZCode / TraeWork have no stop capability) | `server 退出；<window> 内运行无停止结果可确认，窗口中的任务可能仍在继续，请人工打开 <window> 确认无残留运行。` |
| GUI leftover archived on restart | `server 重启遗留（启动时归档，不续跑）；<window> 内运行未确认停止，… 请人工打开 <window> 确认无残留运行。` |

**One rule only**: "confirmed stopped" may be claimed exclusively when the adapter reports `guiStop.idle === true`; `idle === false` and a missing field are both treated as unconfirmed. The cancellation path (issue #6) and the interruption path share the same `guiStopDisclosure()` helper, so the two standards cannot drift apart.

**The shutdown path now lets the best-effort stop finish before settling**

- New config `config.json` → `shutdown.guiStopWaitMs` (default `15000`, overridable): `shutdownInterrupt()` gives GUI tasks a **globally shared** wait budget (all GUI tasks share one budget, so exit time does not scale with the task count) and waits until it expires or the orchestrator settles first. Spawn tasks keep their existing 2 s budget.
- If the orchestrator settles within the budget (carrying the more precise adapter result), the manager yields and keeps that message.

**Honest restart archiving plus a manual acknowledgement path**

- `initialize()` appends a manual-check instruction when archiving GUI leftovers and sets `guiResidualUnconfirmed`.
- Structured fields: `TaskMeta.interruptedCleanStop` (whether the stop is confirmed) and `TaskMeta.guiResidualUnconfirmed` (pending confirmation after restart archiving). The `query_task` / `list_tasks` meta block gains **`guiStopUnconfirmed`**, so an orchestrator has one structured reason **not** to re-dispatch into the same project.
- Acknowledgement **adds no new tool**: after a human verifies the window holds no residual run, `cancel_task` clears the pending marker and appends a `gui_residual_acknowledged` event, **without changing the terminal status or `errorType`**.

**The window name is no longer hard-coded**: it is derived from `profile.displayName` (descriptive parentheticals and generic suffixes stripped, with a fallback to the original string when stripping would empty it; missing `displayName` falls back to `agentId`). The old mapping reported `zcode`/`qoder` as "Codex", which was itself a distortion.

## Explicitly out of scope

- **No automatic CDP reconnection inside `initialize()` to click stop.** Adapters are fail-closed for instances without proof of ownership (they would rather do nothing than kill a user's session), and after a restart there is no session anchor; unattended clicking carries more risk than value. Honest labelling plus manual confirmation closes the effect-leak gap and matches red line 8.
- No new MCP tool (the count stays 11), no change to the `TRANSITIONS` state machine, no change to the re-dispatch guard, and no change to `run_task` / `continue_task` parameters.

## Compatibility

**PATCH release**: tool parameters are unchanged; the `TaskStatus` domain is unchanged; every new field and config key is optional, and a legacy `task.json` snapshot missing them is treated as "unconfirmed" (the safe direction). The `cancel_task` behaviour on a terminal task changes from "no action" to "clear the GUI pending marker", and its returned text reflects that.

## Gate and evidence

- 9 new unit cases (`test/unit/gui-stop-disclosure.test.ts`) and 5 new integration cases (`test/integration/gui-shutdown-interrupt.test.ts`) cover the three shutdown outcomes, restart archiving plus the `cancel_task` acknowledgement, and the fact that spawn tasks are unaffected by the GUI branching.
- The integration cases inject a scripted adapter that **subclasses the real `CodexGuiAdapter`** (`AgentAdapterRegistry.ensureAdapterFor()` rebuilds any adapter that is not an instance of the real class, so a plain implementation would be silently replaced — documented in the test file).
- Typecheck, lint (`--max-warnings 0`), the full test suite, the build and the strict stdio check all pass.

Related: [project README](../README.en.md) | [CHANGELOG](../CHANGELOG.en.md) | [architecture](../ARCHITECTURE.en.md) | [handoff](../HANDOFF.md)
