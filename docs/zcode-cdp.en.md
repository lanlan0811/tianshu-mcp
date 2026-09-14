# ZCode GUI (CDP) Adapter

## Status

ZCode now has a dedicated `zcode-gui` adapter instead of a headless-CLI placeholder. It drives the Electron UI through a local CDP endpoint; native Windows/macOS automation is limited to the folder picker opened by ZCode. The built-in profile remains `research`: Windows 10 installation discovery, version reading, and protection of a running non-CDP instance are verified, while complete macOS hardware evidence is not yet recorded. It must not be marked `ready` before both platforms pass.

## Discovery order

1. `profile.command` or `profile.gui.exePath`;
2. Windows fixed drives ordered by `preferredDrives`, using `relativePaths`;
3. Windows uninstall registry install locations;
4. profile-defined standard Program Files and LocalAppData locations;
5. PATH;
6. `/Applications/ZCode.app` and `~/Applications/ZCode.app` on macOS.

`D:\Z-Code\ZCode\ZCode.exe` is a Windows acceptance sample discovered from a configurable drive preference and relative template, not a business-code constant. Run `node scripts/probe-zcode.mjs all` for read-only installation, version, process, and CDP diagnostics.

## Diagnostics and hardware smoke test

`probe-zcode.mjs` supports `install`, `process`, `cdp`, `selectors`, `ui`, `projects`, `models`, `permission`, `liveness`, and `session`. The model and permission commands briefly open their menus, read stable display names and internal IDs, then close them. The probe sends no messages and changes no account, credential, or security settings.

After explicitly agreeing to transmit the test prompt to ZCode, maintainers can run the hardware smoke script:

```powershell
npm run build
npm run smoke:zcode -- --confirm-send --model DeepSeek/deepseek-flash --project D:\repo\app --task "Inspect package.json without modifying files, then report the result"
```

`--confirm-send`, `--model`, and `--task` are all required, so omission prevents transmission. The script uses an isolated MCP data home, prints the task ID and status changes plus the evidence directory, and preserves the ZCode window.

## CDP and instance safety

- Only `127.0.0.1` is used. The page must identify as ZCode and a ZCode root process must own the debugging port.
- A valid existing CDP instance may be reused.
- A running ZCode instance without CDP produces `needs_user/close_existing_instance`; MCP never closes it or copies credentials into another profile.
- If no instance exists, a visible window is launched with a dynamically selected profile port and the existing login state.
- Login, macOS Accessibility, and an agent question produce `login_required`, `system_permission`, and `agent_question` respectively.
- Disconnects, idle timeouts, and task timeouts preserve the UI. MCP does not click Stop or claim that the process was killed.

## Usage

```text
run_task(projectPath=D:/repo/app, agentId=zcode,
  model=DeepSeek/deepseek-flash,
  task=Implement the plan in `.codex/plans/feature.md` and `./design-system`,
  autoVerify=true)
```

`model` is required and must be an exact `provider/model` value. ZCode rejects TraeWork's `mode` parameter. Path-like references in `task/context` are resolved before submission; each must exist and remain inside `projectPath`.

Initial runs create a new session. Automatic repair, `rework_task`, and existing-session answers can only resume the recorded session. Pre-send environment confirmation without an anchor continues initial dispatch. Before sending, the adapter confirms the exact project path, provider/model, and Full Access permission. ZCode defaults to automatic verification and two repair rounds unless explicitly overridden.

## `needs_user` and continuation

`needs_user` releases the project slot and global ZCode lock while persisting the task ID, original Git baseline, session route, project, model, and permission metadata. Restart does not archive this paused state.

```text
continue_task(taskId=tsk_..., message=Use PostgreSQL)
```

For `agent_question`, the message is sent only to the exactly matched original session. For closing an old instance, login, or system permission, the message is only an acknowledgement; the environment is rechecked and the text is not sent to the model. Duplicate continuation, invalid state, or lost session fails closed.

## Projects and native folder pickers

Projects are matched by normalized absolute path. Windows matching is case-insensitive and slash-insensitive; macOS retains platform semantics. Basename-only duplicates are ambiguous and never auto-selected.

When import is required, the adapter snapshots existing dialogs before clicking Choose Folder. Windows accepts only a new ZCode-owned `#32770` window and sets/reads the path through UI Automation. macOS operates only ZCode's sheet/window, passes the POSIX path through `osascript` argv, and prefers the locale-independent default-button accessibility role. Both platforms verify that the submitted picker closed; the final full path is then read back from ZCode.

## Project-less dispatch (`default` workspace)

`projectPath` may be omitted (issue #12). When omitted, the task runs in ZCode's `default` workspace: no directory assigned, no project registered or imported, no Git baseline, no project snapshot freeze, no project lock, and no project acceptance.

```text
run_task(
  agentId=zcode,
  model=DeepSeek/deepseek-flash,
  task=Answer in one sentence: what is the current workspace?
)
```

Constraints:

- Project-less dispatch currently **supports ZCode only**. When `projectPath` is omitted and the resolved agent is anything else, the call fails with a parameter error before queueing; it is never silently re-routed to ZCode.
- An omitted `autoVerify` is frozen to `false` and an omitted `autoFixRounds` to `0`; an explicit `autoVerify=true` or `autoFixRounds>0` errors out before submission (there is no project directory to verify).
- An empty string, `null`, a relative path, or a non-existent directory is **not** treated as project-less mode and is still rejected as project mode.
- When the task text contains an explicit local file reference (backticked path, absolute path, `./` or `../`), submission fails before sending and asks for a `projectPath` — project-less mode never falls back to resolving references against the cwd.
- On success the terminal message states "no project acceptance performed" and the task metadata carries `verificationNotApplicable: "no_project"`. `verify_task` and `get_task_report` return a not-applicable explanation (`not_applicable: no_project`) for such tasks instead of deriving a directory from cwd.
- Project-less and project tasks share one queue but use a **distinct resource key**; the ZCode driver serialises all tasks globally, so they never race for the same GUI instance.

Before sending, the adapter confirms the session is genuinely in the unbound `default` workspace (the trigger text matches a placeholder such as "Select project" and no project path reads back). **"Not clicking the project button" is not proof** — the UI may inherit a previous binding. If another project is still bound, or the state cannot be confirmed reliably, the task pauses as `needs_user/setup_recovery` and preserves the scene instead of sending to the wrong project.

### Disabling automatic project creation (`allowCreateProject`)

ZCode-only optional boolean; it affects **project mode** only:

- omitted = when the target directory is not in ZCode's project list, import it automatically as before (native folder picker).
- `false` = when the target is unregistered, stop dispatch **before any import side effect** and return `project_not_registered` with remediation; no native folder dialog is opened and no project is added. Register the project in ZCode manually, then resubmit.
- The policy is persisted with the task metadata and never reverts to allow-create after resume.
- Other agents passing this parameter get an explicit "not supported" error rather than a silent ignore.

## Liveness, verification, and repair

Each poll samples the Stop button, loading card, active tool, last assistant hash, question UI, composer, and Send button. Any authoritative running signal keeps the task running. Progress summaries are persisted every 30 seconds.

After completion, the shared acceptance engine runs. A failed round writes one plan to `<TIANSHU_MCP_HOME>/tasks/<taskId>/rework-<taskId>-r<round>.md`; no temporary project copy is created. The repair prompt carries absolute plan and report paths and resumes the same session. Exhausted rounds end in `needs_attention`.

## Hardware evidence (2026-09-11)

| Platform | Verified | Pending |
|---|---|---|
| Windows 10 x64 | Discovery of `D:\Z-Code\ZCode\ZCode.exe`, version `3.11.2.6792`, non-CDP instance protection, CDP startup, native folder import and full-path readback, display/internal-ID readback for `DeepSeek/deepseek-flash`, Full Access readback, real file development with 2/2 acceptance, same-session repair after a controlled first-round failure, and a same-session `AskUserQuestion → needs_user → continue_task(PASS)` run with 2/2 acceptance | None; see the [Windows hardware acceptance record](zcode-windows-smoke.en.md) |
| macOS | Cross-platform implementation and CI/mock coverage | Real installation, Accessibility, and full end-to-end evidence |

The Windows loop is complete. The built-in profile must remain `research` until the macOS hardware evidence is complete.

## Project and model readback (issues #8/#10)

Project triggers resolve by profile override, stable testid, then exact localized labels. Multiple visible matches in a tier stop resolution; fallback results are not merged. Add, move and detach actions are excluded. Binding paths come from the composer or its uniquely associated project row, not arbitrary sidebar paths. A matching name never overrides a conflicting path.

Model readback decodes data-model-current-value and checks the visible model label, excluding hidden stale values and accessibility hints. Without a current attribute it uses a visible label/title, then legacy markup. Conflicting evidence, ambiguous labels or malformed encoding produce model_mismatch before submission.

## Environment confirmation without a session anchor (#9)

After closing an old instance, signing in or granting permissions, an unsent task takes a pre-send session baseline and sends its complete task, context and validated references. Confirmation text is never sent to the model. Existing-session answers and rework still select and verify the original session.

Submission and identity share one observation window of at most 60 seconds, bounded by remaining task time. Prefer the task marker, then the unique new-session delta for initial dispatch. Multiple new sessions never justify guessing the active pane. Unresolved evidence preserves the scene and reports send_unknown or session_lost without automatic resubmission.

## Staged automatic recovery (#10)

Initialization tracks connection preparation, dialog baseline, folder opening, path submission and binding confirmation. The default budget is two minutes, bounded by remaining task time. Tasks remain running with progress updates and do not consume code-repair rounds. See [agent profiles](agent-profiles.en.md#zcode-automatic-initialization-recovery).

Transient observations retry within limits after reconciling import and binding. A timed-out native submission that already bound the project continues immediately; unknown outcomes never replay clicking, typing or submission. Existing bindings do not toggle the selected checkbox. Cancellation interrupts waits and terminates this operation’s helper while preserving ZCode.

Unresolved recovery pauses as `needs_user/setup_recovery`. Complete the indicated project action in ZCode, then call `continue_task`; the acknowledgement is not sent to the model, and the original task and acceptance baseline remain intact. macOS permission errors retain `system_permission`; failed/unknown observations are never treated as an empty sheet baseline. The overall task deadline takes precedence as `task_timeout`.

Model readback supports provider/model labels split across text nodes and excludes transparent ancestors and clipped outgoing animation nodes. Residual menus are dismissed after binding so they cannot trap input focus. Dispatch waits for a unique, enabled, unobstructed send button; these checks are read-only and do not repeat submission. Windows native operations filter by process and dialog handle before querying the target accessibility tree; native phase logs use the `native:` prefix.

## Troubleshooting

- `close_existing_instance`: save your ZCode work, quit ZCode manually, then call `continue_task`.
- `model_unavailable` / `model_mismatch`: check UI drift with `node scripts/probe-zcode.mjs selectors` and the profile selector overrides.
- `project_ambiguous` / `project_mismatch`: make sure the sidebar exposes full paths and remove duplicate names that cannot be disambiguated.
- `system_permission`: grant ZCode / System Events Accessibility permission manually in macOS System Settings.
- `cdp_disconnected`: preserve the scene and confirm the instance and port ownership before deciding manually.
- `project_not_registered`: this call used `allowCreateProject=false` and the target directory is unregistered. Register the project in ZCode manually and resubmit, or drop the parameter to allow automatic import.
- Project-less mode parked at `needs_user/setup_recovery`: ZCode is still bound to another project, or the `default` workspace cannot be confirmed. Switch to an unbound new session, then call `continue_task`.
- Project-trigger failures are no longer collapsed into "timed out": the message names the actual class — "not unique (N matches)", "mounted but invisible or clipped", "covered by another element", or "the project menu did not open after the click" — and carries `selector`, match count and hit-node attributes, while diagnostics log attempt count, elapsed time and remaining budget.
