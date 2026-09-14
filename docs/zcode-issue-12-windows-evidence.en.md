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

## Second visit (after v0.5.2, 2026-09-15)

After v0.5.2 shipped, project-less dispatch was revisited 6 times on hardware, to check whether the bounded
trigger-click retry is sufficient and to re-verify the fixes added since. The environment is unchanged
(Windows 10 x64, Node `v24.18.0`, ZCode `3.11.2.6792`), as is the driving method (`dist/server.js` +
`InMemoryTransport` + the official SDK client, isolated data directory).

### Results of the 6 runs

| # | Starting UI state | Terminal state | On-site conclusion |
|---|---|---|---|
| 1 | freshly spawned instance, draft page | `failed/send_unknown` | message never submitted (input not cleared, no run signal, no new session); `用户消息=true` was a false signal |
| 2 | reused instance parked on an **existing conversation** | `needs_user/setup_recovery` | within 30s: `dismissMenus`×50 / `clickProjectTriggerAndConfirm`×49 / `workspaceBinding`×49 and `clickWorkOutsideProject` **0 times** — the trigger never became ready |
| 3 | draft page (switched manually via the sidebar button) | `succeeded/reply_stable` | full submission timeline captured (below) |
| 4 | conversation page + **minimised** window | `failed/internal` | the fix is live on hardware (fallback logged, below); the send button never became clickable within 10s |
| 5 | draft page + visible window | `succeeded/reply_stable` | zero warnings: `已确认 default 工作区` → model/permission read-back → finished |
| 6 | **minimised** window (`iconic=True`, `visibility=hidden`) | `succeeded/reply_stable` | progress reported `运行证据=stop_button` |

### Defect: the top "new task" button returns success without switching pages

Reproduction criteria on hardware (read-only probe, parked on an existing conversation):

- the page shows `rows=2` and `[data-testid="composer-workspace-trigger"]` has **0 mounted nodes**; the composer
  actually mounts `v4-composer-input`, `chat-attachment-button`, `chat-mode-select-trigger`, `v4-model-config`,
  `chat-context-usage-trigger`, `chat-model-select-trigger`, `chat-thought-level-select-trigger`, `v4-composer-send`;
- clicking `conversation-new-task` returns `true` while the page **does not change at all** (rows stay 2, the
  trigger stays unmounted);
- switching to the sidebar `[data-testid="task-new-button"]` yields `rows=0`, 1 mounted trigger and the
  placeholder read-back "选择项目" within 2 seconds.

Hardware evidence after the fix (agent log of run 4, verbatim):

```text
[warn] [zcode] 顶部新建任务按钮未建立草稿（clicked=true）；回退侧栏新建任务按钮
[info] [zcode] 已通过侧栏新建任务按钮进入新草稿
[info] [zcode] 已确认 default 工作区（无项目模式），跳过项目绑定与导入
```

In the same run, the step that failed in run 2 (30 seconds of dead waiting → `needs_user`) no longer occurs.

### Three shapes of the send stage

| Shape | Symptom | Attribution |
|---|---|---|
| run 1 | `sendMessage` returns in 111ms, then 60 seconds with no run signal | undetermined (below) |
| run 4 | `sendMessage` cannot find a clickable point within 10s and throws | minimised window throttles the page, `elementFromPoint` hits a non-button node |
| run 6 | same minimised window, **send succeeds** | so "minimised window implies failure" does not hold |

Submission timeline of run 3 (independent read-only probe, 3-second granularity):

```text
17:14:57  inputLen=93  inputHead="【tianshu:tsk_20260915011"  sendDisabled=false
17:15:03  inputLen=0   sendDisabled=true                    <- input cleared = submitted
17:15:09  rows=0→2  sessionNodes=10→11                      <- new session created, reply appeared
```

Reproducing the same path in isolation on an existing instance (`Input.insertText` + `sendMessage()` clicking
`v4-composer-send`) also submits successfully (input cleared, `assistantRows` 0→1, session nodes 8→10). Both the
"`insertText` is ineffective" and "`clickAt` is ineffective" hypotheses are therefore falsified; `sendButton` is
`disabled=true` with an empty input and flips to `false` after text is injected, so the editor state does receive
the text.

### Not reproduced / not verified this round

- **The true cause of run 1's `send_unknown` is undetermined**: the same path submits successfully in isolation and
  run 6 succeeded even with a minimised window, so the window state cannot explain that failure. Its
  `用户消息=true` is a **false signal** — the `messageList` fallback selector is `main`, and `mainContainsComposer`
  was measured `true`, with the `v4-timeline` container text containing composer control text such as
  "选择项目 / 完全访问 / DeepSeek/deepseek-flash"; as long as the task marker remains in the input box,
  `conversationText()` contains the marker. That false signal masked the real state — the message stuck in the
  composer (`seenStateChange=false` is the truthful signal). **Not fixed this round.**
- **The throttling diagnostic for `sendMessage` was never reached on hardware**: covered by unit tests only
  (a page with `visibilityState=hidden` is attributed to "the window is not in the foreground"). Run 4 used a
  build without that diagnostic and run 6 succeeded despite being minimised.
- **`Page.bringToFront` cannot restore an occluded Electron window** (measured on hardware: the call returns ok
  while `visibilityState` stays `hidden`), so the state can only be diagnosed and handed to the user; restoring
  requires `ShowWindow(SW_RESTORE)` + `SetForegroundWindow` (used repeatedly this round, after which
  `visibility=visible` and `hasFocus=true`).
- **macOS / Windows 11 remain unverified** (consistent with the "Not verified" section above).

### Side-effect disclosure (this round)

- While reproducing the send path, a probe called `sendMessage()` directly and really submitted one probe message
  ("请只回复一个字：好") into ZCode's `default` workspace, so the ZCode session count grew by one; each of the 6
  visits created its own session.
- Project entry counts were not measured (no before/after comparison this round), but all 6 runs were project-less
  and involved no project registration or import.
- During run 4 the ZCode window was minimised; it was restored to the foreground with `ShowWindow(SW_RESTORE)`
  after the visit.
