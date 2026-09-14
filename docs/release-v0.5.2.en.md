# tianshu-mcp v0.5.2 release notes

**Headline theme**: **project-less dispatch for ZCode (issue #12)**. `run_task`'s `projectPath` becomes optional — when omitted, ZCode runs the task in its `default` (project-less) workspace: no project registered or imported, no Git baseline, no project snapshot freeze, no project lock, no project acceptance. The companion `allowCreateProject` can forbid automatic import when the target directory is unregistered. This release also unifies the ZCode project-trigger readiness criteria, fixes a misleading error message, and adds Windows 10 hardware acceptance evidence.

This is a **MINOR** release: it adds the optional `allowCreateProject` parameter and relaxes the `projectPath` requirement. Tool signatures, meta-block fields, report formats, and acceptance configuration remain **backward compatible**; existing callers need no changes.

## Added

### Project-less dispatch for ZCode (issue #12)

```text
run_task(
  agentId=zcode,
  model=DeepSeek/deepseek-flash,
  task=State the current workspace in one sentence; do not read or write any file
)
```

- **ZCode only.** If `projectPath` is omitted and the resolved agent is anything else, the call fails with a parameter error before queueing; an empty string / `null` / relative path / non-existent directory is **not** project-less mode and is still rejected as project mode.
- Acceptance and repair are forced off: `autoVerify` is frozen to `false` and `autoFixRounds` to `0`; enabling them explicitly errors out before submission.
- When the task text contains an explicit local file reference (backticked path / absolute path / `./` / `../`), submission fails before sending and asks for a `projectPath` — project-less mode never falls back to resolving references against the cwd.
- On success the terminal message states "no project acceptance performed" and the metadata carries `verificationNotApplicable: "no_project"`; `verify_task` / `get_task_report` return `not_applicable: no_project` for such tasks instead of deriving a directory from cwd.
- Before sending, the adapter must confirm the session is genuinely in the unbound `default` workspace; when it detects an inherited binding it **opens the project menu and selects "work outside a project"**, then confirms by read-back (hardware observation: after the switch the trigger reads back as the placeholder "选择项目").

### `allowCreateProject` (ZCode-only, optional boolean)

- Omitted = keeps the existing "auto-import when the target is unregistered" behaviour.
- `false` = when the target directory is unregistered, stop dispatch **before any import side effect** and return a recognisable `project_not_registered` with remediation: no native folder dialog is opened and no project is added. Register the project in ZCode manually, then resubmit.
- Other agents passing this parameter get an explicit "not supported" error rather than a silent ignore.

### Windows 10 hardware acceptance record

[`docs/zcode-issue-12-windows-evidence.en.md`](zcode-issue-12-windows-evidence.en.md) (Chinese version alongside): the complete evidence chain for project-less dispatch and `allowCreateProject=false` on ZCode `3.11.2.6792`, including the before/after comparison "ZCode project entries **34 → 34**, 0 added / 0 removed", plus the two defects this round exposed and fixed on hardware.

## Fixed

- **`projectPath` was never opened up in the MCP schema (found on hardware)**: the handler already had the project-less branch, but `RunTaskParamsSchema.projectPath` was still required, so a real `run_task` was rejected by the SDK with `-32602 Required at projectPath`. Unit tests call the handler directly and therefore bypass `inputSchema`, which is why a green suite missed it. Changed to `AbsPath.optional()`, plus a protocol-level regression case in `test/integration/task-flow.test.ts`.
- **No "work outside a project" switch, and the menu click was undone by toggle semantics (found on hardware)**: ZCode's "New task" inherits the previous binding, so project-less dispatch parked at `needs_user/setup_recovery` forever; meanwhile `clickProjectTriggerAndConfirm` kept clicking the trigger even when the project menu was **already open**, closing the Radix dropdown and then polling until its deadline, misreported as "the project menu did not open". Added the `workOutsideProject` selector and `enterDefaultWorkspace()` for an explicit switch, made the click check the menu state first, and made `confirmDefaultWorkspace` return immediately for "definitely bound to a project".
- **Divergent project-trigger readiness criteria (issue #12 §5)**: waiting used `exists` (element width/height only) while clicking went through `pick` (exactly one unclipped visible node in the winning tier), so an `exists=true` / `click=false` window existed. Waiting and clicking now share one **structured probe** distinguishing not-mounted / mounted-but-invisible-or-clipped / ambiguous / disabled / covered / ready, plus a post-click condition: the project menu must actually open.
- **Error message contradicting behaviour**: "waiting for the project trigger timed out" is no longer used for early exits (multiple matches, disabled) or a menu that never opened; failure text carries `selector`, match count and minimal hit-node attributes, while diagnostics log attempt count, elapsed time and remaining budget.
- **Centralised timeout**: new `gui.projectTriggerTimeoutMs` (default 15s) replaces the two hard-coded `15_000` literals; "wait → one sidebar fallback → wait" shares a single deadline, and retries do not reset the budget.

## Hardware verification (Windows 10 x64)

| Scenario | Result |
|---|---|
| Project-less dispatch | `succeeded` / `reply_stable`; snapshot `workspaceMode=default`, `projectPath=""`, `verificationNotApplicable=no_project`; task directory holds only `agent-0.log` / `task.json` / `task.jsonl` (**no baseline / snapshot / report**) |
| `verify_task` / `get_task_report` | both return `not_applicable: no_project` |
| ZCode project entries | 34 → 34, 0 added / 0 removed |
| `allowCreateProject=false` + unregistered directory | `failed` / `project_not_registered`, folder panel never opened, no project entry added |

Environment: Windows 10 x64 (`10.0.19045`), Node `v24.18.0`, ZCode `3.11.2.6792`, `model=DeepSeek/deepseek-flash`.

> **Side-effect disclosure**: the hardware tests switched this repo's ZCode workspace from its previous binding `D:\Trae项目\tianshu-mcp` to "work outside a project", with **zero change to project entries**. Automatic restore of the binding was not possible because the project trigger is not mounted in that state; re-select your project from the dropdown in ZCode's composer if needed.

## Testing and verification

- Full suite: **525 passed / 10 skipped** (54 files passed / 3 skipped, Windows 10 x64 / Node 24), a net **+39** cases over v0.5.1.
- `typecheck` / `lint` (`--max-warnings 0`) / `build` / `pack:check` (192 files) all pass; `check:stdio` **6/6 scenarios PASS** (11 tools, `version=0.5.2`).
- Clean-consumer install: `npm install <tgz>` in an empty directory succeeds; `dist/index.js` starts, completes the 11-tool handshake, and shuts down cleanly on stdin EOF.

## Distribution and compatibility

- GitHub is the primary repository; Gitee mirrors code, tags, and releases; npm publishes `tianshu-mcp@0.5.2` (`latest`).
- **No breaking changes**: existing callers need no changes. A `run_task` call that omits `projectPath` changes from "parameter validation failure" to "real project-less dispatch" — an intentional behaviour change in this release.
- **Not verified**: project-less dispatch and its selectors on macOS (no macOS machine here); `continue_task` / `rework_task` for project-less tasks on hardware (covered by unit tests only).

Related docs: [ZCode CDP adapter](zcode-cdp.en.md) | [Windows 10 hardware record](zcode-issue-12-windows-evidence.en.md) | [README](../README.en.md) | [CHANGELOG](../CHANGELOG.en.md)
