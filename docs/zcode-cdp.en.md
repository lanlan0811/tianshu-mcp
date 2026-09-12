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

Initial runs create a new session. Automatic repair, `rework_task`, and `continue_task` can only resume the recorded session. Before sending, the adapter confirms the exact project path, provider/model, and Full Access permission. ZCode defaults to automatic verification and two repair rounds unless explicitly overridden.

## `needs_user` and continuation

`needs_user` releases the project slot and global ZCode lock while persisting the task ID, original Git baseline, session route, project, model, and permission metadata. Restart does not archive this paused state.

```text
continue_task(taskId=tsk_..., message=Use PostgreSQL)
```

For `agent_question`, the message is sent only to the exactly matched original session. For closing an old instance, login, or system permission, the message is only an acknowledgement; the environment is rechecked and the text is not sent to the model. Duplicate continuation, invalid state, or lost session fails closed.

## Projects and native folder pickers

Projects are matched by normalized absolute path. Windows matching is case-insensitive and slash-insensitive; macOS retains platform semantics. Basename-only duplicates are ambiguous and never auto-selected.

When import is required, the adapter snapshots existing dialogs before clicking Choose Folder. Windows accepts only a new ZCode-owned `#32770` window and sets/reads the path through UI Automation. macOS operates only ZCode's sheet/window, passes the POSIX path through `osascript` argv, and prefers the locale-independent default-button accessibility role. Both platforms verify that the submitted picker closed; the final full path is then read back from ZCode.

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
