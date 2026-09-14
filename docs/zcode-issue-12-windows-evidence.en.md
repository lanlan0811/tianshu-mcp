# issue #12 Windows 10 hardware acceptance record (v0.5.2)

Chinese version: zcode-issue-12-windows-evidence.md

This file records real-environment acceptance for **ZCode project-less dispatch (the `default` workspace) and `allowCreateProject`**.
Evidence comes from one-off hardware scripts in this repo (driving the complete `dist/` server plus an in-memory MCP client), not from unit-test doubles.

## Environment

| Item | Value |
|---|---|
| OS | Windows 10 x64 (`10.0.19045`) |
| Node | `v24.18.0` |
| ZCode | `3.11.2.6792` (`D:\Z-Code\ZCode\ZCode.exe`) |
| tianshu-mcp | this repo's `master`, at the v0.5.2 pending-release commit |
| Driver | `dist/server.js` + `InMemoryTransport` + official SDK `Client`, isolated data home |

## Test A: project-less dispatch (`projectPath` omitted)

Call:

```text
run_task(
  agentId=zcode,
  model=DeepSeek/deepseek-flash,
  task=Answer in one sentence: what workspace (project) are you currently in? Do not read or modify any file, do not run any command.
)
```

Observations (progress trail via `query_task`):

| Observation | Result |
|---|---|
| `run_task` submission | Accepted, returns a `taskId`; message reads "project-less mode: ZCode default workspace" |
| Automatic workspace switch | Progress "ZCode 切换到 default 工作区" appears; the task is then sent normally |
| Terminal state | `succeeded`, `agentEndReason=reply_stable` |
| Task snapshot | `workspaceMode="default"`, `projectPath=""`, `displayPath=""`, `autoVerify=false`, `autoFixRounds=0`, `verificationNotApplicable="no_project"`, `boundProjectPath=""` |
| Task directory | only `agent-0.log` / `task.json` / `task.jsonl` — **no `baseline.json`, no `visual-snapshot.json`, no `report-*`** |
| Terminal message | "task finished: agent exit code 0 (project-less mode, no project acceptance performed)" |
| `verify_task(taskId)` | returns `not_applicable: no_project`, never derives a directory from cwd |
| `get_task_report(taskId)` | returns "no project acceptance report produced (not_applicable: no_project)" |
| ZCode session | real session `sess_9cbc9ba6-…`, `boundProjectPath=""` |

**ZCode project entries**: 34 before dispatch → 34 after, **0 added / 0 removed**.

## Test B: `allowCreateProject=false` with an unregistered directory

Call:

```text
run_task(
  projectPath=D:/Trae项目/tianshu-mcp/.rivet/scratch/no-create-project,
  agentId=zcode,
  model=DeepSeek/deepseek-flash,
  task=<same as above>,
  allowCreateProject=false
)
```

| Observation | Result |
|---|---|
| Terminal state | `failed`, `agentEndReason=project_not_registered` |
| Failure point | before "preparing the folder panel" — the native folder dialog was never opened |
| Message | "the target directory is not registered in ZCode's project list and this call forbids automatic project creation (allowCreateProject=false): … Register the project in ZCode manually and resubmit, or omit allowCreateProject to allow automatic import." |
| ZCode project entries | still 34, **no `no-create-project` entry** |

## Current ZCode state in this repo (side-effect disclosure)

The hardware tests switched ZCode's workspace from its previous binding `D:\Trae项目\tianshu-mcp` to "work outside a project" (`default`).
- **Project entries are unchanged** (34 → 34): nothing added, nothing removed.
- Automatic restore of the binding was not possible without touching the UI further, because ZCode's project trigger is not mounted in its current state (`projectTrigger=false`); automation stopped there rather than clicking blindly.
- To restore: open the project dropdown in ZCode's composer and re-select your project.

## Two defects found and fixed on hardware

Both were exposed **only** by real-machine runs; unit and integration tests stayed green because they bypass the MCP protocol layer and the real Radix dropdown behaviour respectively.

### Defect 1: `projectPath` was never opened up in the MCP schema

- Symptom: calling `run_task` without `projectPath` on hardware produced `MCP error -32602: Invalid arguments for tool run_task: Required at projectPath`.
- Root cause: the handler already had the project-less branch, but `RunTaskParamsSchema.projectPath` was still required, so the SDK rejected the request at the protocol layer.
- Why tests missed it: `test/unit/zcode-handler.test.ts` calls the handler directly, **bypassing** MCP `inputSchema` validation.
- Fix: `src/config/schema.ts` now uses `AbsPath.optional()`.
- Regression gate: a new protocol-level case in `test/integration/task-flow.test.ts` asserts the text contains neither `-32602` nor `Input validation error`.

### Defect 2: no "switch to the default workspace", and the menu click was undone by toggle semantics

- Symptom one: ZCode's "New task" **inherits the previous binding**, so project-less dispatch always parked at `needs_user/setup_recovery`.
- Symptom two: while diagnosing, `attemptProjectMenu` kept clicking the trigger even when the project menu was **already open**. Radix dropdowns toggle, so that click closed the menu — and because `clickProjectTriggerAndConfirm` polls until its deadline before returning, the outer retry only ever fired once → straight to `setup_failed`, misreported as "menu did not open".
- Hardware evidence: the probe dumped `{role:"menuitemcheckbox", testid:"composer-work-outside-project", checked:"true"}` — the menu was in fact open.
- Fixes:
  1. `src/agents/zcode/selectors.ts` gains `workOutsideProject` (`[data-testid="composer-work-outside-project"]`); on hardware, clicking it makes the trigger read back as the placeholder "选择项目";
  2. `src/agents/zcode/cdp.ts` gains `clickWorkOutsideProject()` (requires a unique visible match);
  3. `src/agents/zcode/run.ts` gains `enterDefaultWorkspace()`: when the project-less confirmation fails, switch explicitly then re-confirm; `confirmDefaultWorkspace` now returns immediately for "definitely bound to a project" instead of burning the deadline;
  4. `clickProjectTriggerAndConfirm()` **checks whether the menu is already open first** and treats that as opened without clicking;
  5. `attemptProjectMenu()` calls `dismissMenus()` on entry.
- Regression cases: `test/unit/zcode-dom.test.ts` "treats an already-open menu as opened without clicking the trigger" (zero mouse events); `test/integration/zcode-flow.test.ts` "auto-switch then dispatch when the old binding is inherited" and "preserve the scene without sending when the switch is unavailable".

## Not verified

- **macOS**: no macOS machine here; ZCode's `default` workspace switch, the `composer-work-outside-project` selector, and native behaviour on darwin are **unverified**.
- **Windows 11**: this run is Windows 10; the issue reporter's Windows 11 evidence was not reproduced and the two do not substitute for each other.
- `continue_task` / `rework_task` under project-less mode on hardware: covered by unit tests only (`FakeZcode`).
