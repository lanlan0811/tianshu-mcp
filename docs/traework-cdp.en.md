# TraeWork GUI Driver via CDP

This document explains how `tianshu-mcp` drives TraeWork (TRAE SOLO CN) over the Chrome DevTools
Protocol (CDP) to close the loop: **dispatch → wait for completion → verify → rework on failure → re-verify**.
Chinese version: [traework-cdp.md](traework-cdp.md).

---

## 1. Why GUI instead of CLI/HTTP

| Route | Conclusion |
|---|---|
| Headless CLI (`trae agent exec` etc.) | **Does not exist.** TraeWork only ships VS Code-family CLI (open/serve-web/extension management) |
| Direct HTTP to the gateway | **Not viable.** LLM/agent requests are TDE-encrypted in the TTNet layer (algorithm inside `aha_net.dll`/`sscronet.dll`, Cronet OpaqueData); they cannot be constructed outside the client |
| **Driving the desktop UI over CDP** | **Viable and verified** (this document) |

CDP drives the full client chain: renderer → ai_agent → TDE → gateway, and results are extracted
from the DOM. This matches the mechanism already proven by the `oh-dsh-trae-api` project.

> Note: the earlier "TraeWork unsupported" conclusion only disproved the **headless CLI route**;
> it never tested the GUI route. This work corrects that conclusion.

---

## 2. Prerequisites

- Windows 10/11 (the mechanism is platform-agnostic, but macOS is **not yet verified** — see §7)
- TraeWork installed and **logged in**
- TraeWork started with a debug port, and the **window kept visible** (sending relies on simulated input):
  ```bat
  "D:\TRAE Work CN\TRAE SOLO CN.exe" --remote-debugging-port=9222
  ```
- No extra dependencies: the CDP client uses only Node built-ins (`http` + global `WebSocket`, Node ≥ 20)

> `tianshu-mcp` **prefers to reuse** an already-running instance with a debug port; it only launches a
> new instance when none is available. It **never terminates an instance the user started** (see §6).

---

## 3. Quick start

```jsonc
// Call via MCP (Tianshu or any MCP client)
run_task({
  "projectPath": "D:\\TraeProjects\\my-app",   // absolute path
  "agentId": "traework",
  "task": "Implement the home page per plan.md and the .design system",
  "model": "GLM-5.3",                          // optional: pick the TraeWork model
  "mode": "Code",                              // optional: Work | Code | Design
  "autoVerify": true,
  "autoFixRounds": 2,
  "taskTimeoutMs": 1800000
})
```

Execution sequence (mapping the 8 requested steps):

1. **Detect/launch** TraeWork (reuse a port-ready instance, else launch with the port)
2. **Wait for the UI** (chat input present — the CDP port can be ready before the DOM is)
3. **New session** (click "新建任务"; one clean session per task)
4. **Resolve and switch panel mode**: explicit `mode` parameter > task-text detection ("switch to Code mode", …) > keep `Work`; a failed switch fails loudly
5. **Bind the project folder inside the target mode**: click "选择文件夹（可选）" → match by project name/path in the dropdown; if not found, click the footer "选择文件夹" → drive the native Windows dialog through the restricted computer-use path; re-verify both mode and project afterwards
6. **(Optional) Switch model**: strictly verified; mismatch fails loudly instead of silently using the wrong model
7. **Type the task** (with read-back verification) → **press Enter** → poll the DOM until the completion mark appears
8. **Automatic verification**: command checks (typecheck/lint/test/build, skipped if absent) + code analysis
   (relative to the pre-work git baseline)
9. **On verification failure**: generate a repair-plan file `rework-<taskId>-r<N>.md` and reference its
   filename in the rework message within the same session
10. **Re-verify** until it passes or rounds are exhausted (`needs_attention`)

> **Why does step 4 come before binding?** Measured (2026-09-08): TraeWork's Work/Code/Design modes
> **each keep an independent project binding** — switching modes replaces the input bar's project with
> whatever that mode last used. So the mode must be switched first, then the project bound inside it.
>
> **Fallback for non-Work modes**: if binding fails in the target mode (Code/Design), the driver
> **falls back to Work once**, then switches back to the target mode and re-verifies the project is still
> bound. Only if both attempts fail does it report an error (including the reason from each mode).
>
> **Mode resolution priority**: explicit `mode` parameter > task text > `Work`.
> Text detection accepts mixed Chinese/English phrasing ("switch to Code mode", "use design mode", "工作模式", "代码模式", "设计模式", …).
>
> **The dropdown's 11 entries ≠ the 22-entry project map**: dropdown rows come from TraeWork's
> server-side project list, whereas `solo-lite.local-project-folders` is only a local path-backfill cache.
> "Present in the map" does not mean the dropdown will match; a miss still goes through the native dialog.

Real-machine probe (diagnostics; TraeWork must be running):

```bash
node scripts/probe-traework.mjs selectors          # check selector hits
node scripts/probe-traework.mjs mode Code          # switch panel mode (Work|Code|Design)
node scripts/probe-traework.mjs project <abs-path> # new session + bind project
node scripts/probe-traework.mjs send "task"        # end-to-end send and fetch reply
```

---

## 4. Configuration (`traework` section of `agent-profiles.json`)

Built-in defaults live in `src/agents/builtin.ts`; the user data directory
`~/.tianshu-mcp/agent-profiles.json` can override any key.

```jsonc
{
  "profiles": {
    "traework": {
      "displayName": "TraeWork (TRAE SOLO CN)",
      "type": "cli",
      "driver": "gui",          // spawn=child process; gui=desktop UI automation
      "status": "ready",
      "command": null,          // empty = use executableDiscovery
      "executableDiscovery": {
        "dirs": [
          "D:/TRAE Work CN",
          "{ProgramFiles}/TRAE WORK CN",
          "{LOCALAPPDATA}/Programs/TRAE WORK CN",
          "/Applications/TraeWork.app/Contents/MacOS"
        ],
        "fileNames": ["TRAE SOLO CN.exe", "TraeWork", "TraeWork CN"]
      },
      "gui": {
        "cdpPort": 9222,             // debug port
        "cdpPortAuto": true,         // auto-avoid if occupied
        "cdpPortRange": 20,          // how many ports to try
        "exePath": null,             // explicit executable (optional, wins over discovery)
        "exeArgs": ["--remote-debugging-port=<port>"],
        "windowMode": "reuse",       // reuse an existing instance; launch = always new
        "launchTimeoutMs": 60000,    // wait for CDP readiness
        "pollIntervalMs": 3000,      // reply polling interval
        "stableRounds": 12,          // no-change rounds before the idle timer starts
        "idleTimeoutMs": 600000,     // unchanged and no running signal before returning idle
        "cdpSendTimeoutMs": 15000,   // timeout for one CDP command
        "progressIntervalMs": 30000, // progress-event interval visible through query_task
        "modelSwitch": true,         // switch model when task specifies one
        "modeSwitch": true,          // switch panel mode (Work/Code/Design) when task specifies one
        "freshSession": true,        // new session per task
        "selectors": {}              // selector overrides (hot-fix for UI drift)
      }
    }
  }
}
```

### 4.1 Selector overrides

When a TraeWork UI upgrade breaks a selector, **no code change is needed** — override by key in
`gui.selectors`:

```jsonc
"selectors": {
  "chatInput": ".my-new-input-class",
  "projectButton": "[class*='newProjectButton']"
}
```

Available keys (see `src/agents/traework/cdp/selectors.ts`): `chatInput`, `newTask`, `taskListItem`,
`taskListGroupName`, `modeTab`, `modelTrigger`, `modelTriggerValue`, `modelOption`, `modelList`,
`modeSwitcher`, `projectButton`, `cascadeMenu`, `cascadeMenuItem`, `cascadeMenuItemTitle`,
`cascadeMenuItemSubtitle`, `cascadeMenuGroupHeader`, `cascadeMenuFooter`, `messageContainer`, `toolCard`,
`sendButton`, `stopButton`, `taskTail`, `taskTailLoading`, `thinkingStream`.

Each key has a primary selector plus fallback candidates tried in order.

---

## 5. Verified selectors (TraeWork 1.107.1)

| Key | Selector | Notes |
|---|---|---|
| chatInput | `.chat-input-v2-input-box-editable` | Chat input (contenteditable) |
| newTask | `.task-list-new-task-item` | "新建任务" button |
| taskListItem | `.taskText` | Session title; note `.task-list-new-task-item` is a *button* (new task/marketplace), **not** a session row |
| taskListGroupName | `.task-list-group-name` | Project group name in the task list (= project folder name) |
| modeTab | `[class*="mode-switcher-btn"] [class*="tab"]` | Work/Code/Design segments |
| projectButton | `[class*="projectButtonPlaceholder"]` | Unbound state ("选择文件夹（可选）"); once bound the class disappears and the text becomes the project name |
| cascadeMenu | `[class*="cascadeMenu"]` | Project-folder dropdown overlay |
| cascadeMenuItem | `[class*="cascadeMenuItemWithSubtitle"]` | Dropdown row; inner `cascadeMenuItemInner/Title/Subtitle` also match the prefix selector |
| cascadeMenuItemTitle / Subtitle | `[class*="cascadeMenuItemTitle"]` / `[class*="cascadeMenuItemSubtitle"]` | Project name / project path |
| cascadeMenuFooter | `[class*="cascadeFooterButton"]` | Footer "选择文件夹" button |
| modelTrigger / modelTriggerValue | `.core-model-select-trigger` / `-value` | Model dropdown |
| modelOption / modelList | `.core-model-select-model-item` / `-list` | Model items (virtual scroll) |
| messageContainer | `.message-list-cache-container` | Message container (appears after sending) |
| toolCard | `.core-toolcall-base-card,…` | Trae native tool cards |
| sendButton | `.chat-input-v2-send-button` | Send-button container |
| stopButton | `.chat-input-v2-send-button-stop-icon` | **Authoritative primary running signal**: stop state while generating |
| taskTail | `.core-task-tail` | Task-tail container |
| taskTailLoading | `.core-task-tail--loading` | **Authoritative secondary running signal**: in-flight bridge request |
| thinkingStream | `.thinking-stream-content` | Diagnostic only; historical nodes may remain and never block completion |

---

## 6. Safety invariants (important)

These constraints come from a **real incident**: while validating, `taskkill /PID <pid> /T /F` killed the
user's own running TraeWork instance (data intact, restarted). They are now hard rules:

1. **Reuse by default**: `windowMode="reuse"` — reuse a ready instance, never start a second one.
2. **Never kill a process tree**: `releaseInstance` only terminates PIDs **this module created**, and
   **without `/T`**.
3. **Verify command line before terminating**: the observed command line must contain both the
   `--remote-debugging-port=<port>` we injected and the executable name; otherwise **abort and warn**
   (a leftover window is far safer than killing the user's session).
4. **Native paths**: paths passed to GUI processes always use native Windows form; POSIX paths are forbidden.
5. **computer-use whitelist**: the built-in desktop automation is allowed **only** for TraeWork's folder
   picker (window title matching `Select Project Folder` etc. + host process `TRAE SOLO CN.exe`).
   Anything else (browser, terminal, editor, system dialogs) is refused with `COMPUTER_USE_DENIED`.
   See `src/agents/traework/computeruse/guard.ts`.
6. **Zero credential access**: this MCP never reads, decrypts, or forwards any TraeWork login state;
   CDP only drives the UI.

---

## 7. Known limitations

- **Window must stay visible**: sending relies on simulated input; a minimized/hidden window may fail.
- **Single-session serialization**: TraeWork is a single-session UI; all tasks go through a serial queue,
  on top of the existing "per-project serial + global concurrency gate".
- **Completion still depends on UI signals, but a short static period is no longer completion**: a visible stop button or
  loading task tail always keeps polling. Without a running signal, the DOM completion mark ("由AI生成") is accepted.
  `gui.stableRounds` only starts an idle timer; another `gui.idleTimeoutMs` (ten minutes by default) returns `idle` and
  retains the instance. If all liveness selectors drift, behavior fails open to the completion mark plus idle timer.
- **Abnormal endings retain the scene**: timeout, idle, cancellation, and CDP loss do not close the instance.
  `query_task` metadata exposes `agentEndReason` / `keptInstance`; only `completion_mark` and `ask_user` release a newly launched instance.
- **Model switching depends on the dropdown**: if the target is absent (locked entitlement/name mismatch),
  the task fails loudly rather than silently using the wrong model.
- **UI upgrades drift**: selectors are centralized in `selectors.ts` and overridable via profile;
  `scripts/probe-traework.mjs` helps diagnose.
- **macOS unverified**: the CDP mechanism is platform-agnostic, but executable discovery and the native
  dialog driver (AppleScript route) have not been tested on macOS. The macOS native-dialog path is
  **fail-closed** (explicit error, telling the user to open the project once in TraeWork).
- **Pseudo-streaming**: the DOM is rebuilt block-wise, so incremental deltas are unsafe; the full text is
  retrieved at completion.

---

## 8. Pitfall log (measured)

| Symptom | Root cause | Fix |
|---|---|---|
| Project button not found | It only exists in **Work mode** | `ensureMode("Work")` first |
| Dropdown matched "新建任务" | `.task-list-new-task-item` shares a name prefix with session rows | Session rows use `.taskText` |
| Dropdown rows empty/garbled | `cascadeMenuItemInner/Title/Subtitle` also match the prefix selector | Primary selector requires `WithSubtitle`; title/subtitle read separately |
| Input box stayed empty | `insertText` occasionally dropped | Read-back check, retry once |
| Path became `D:TraeProjects<TAB>s-e2e-smoke` | JS template literal interpreted `\t` as a tab | Pass the path via **environment variable** into PowerShell |
| Native dialog unclickable | Third-party tool (Snipaste) stole foreground focus; SendKeys/click landed elsewhere | `AttachThreadInput + BringWindowToTop + SetForegroundWindow` to force foreground |
| Native dialog not detected | It is a **descendant** window of TraeWork; `TreeScope.Children` misses it | Use `TreeScope.Descendants` |
| Confirm button not found | This Win32 picker is DirectUI; the confirm control is a Pane (no InvokePattern) | Use its bounding rect and `mouse_event` click |
| New instance: no elements found | CDP port ready before DOM rendered | `waitForUi()` waits for the chat input (up to 60 s) |
| Bound project still re-selected | The placeholder class disappears once bound | `readBoundProject()` reads the input-bar text and reuses it |
| Killed the user's TraeWork | `taskkill /T` killed the process tree, hitting the user instance | See §6: reuse-first + command-line check + no `/T` |
| **Clicked "选择文件夹" but got "waiting for native dialog timed out"** | `element.click()` returned true yet the native popup never appeared; old code trusted the click result | After clicking, **confirm the dialog actually appeared** (`findFolderDialog()`); otherwise log a dropdown DOM snapshot and fail loudly |
| **Dialog detection "timed out" although the dialog was open** | PowerShell cold start is ~4.5–6 s; old code polled from Node every 800 ms, so a 15 s budget allowed only ~2 probes | Poll **inside a single PowerShell call** (400 ms interval) and raise the budget to 30 s |
| **CJK path became `D:Traes-bind-test`** | SendKeys/clipboard are mangled by the console code page (CJK and backslashes dropped) | Write the path via Win32 **`WM_SETTEXT`** (handle from UIA) — fully reliable for CJK |
| **Confirm button not clickable / clicked a file row** | `AutomationId="1"` is not unique — list rows also use 0/1/2…; the confirm control is a Pane with no InvokePattern | Locate by **AutomationId=1 AND ControlType=Pane**, then click its bounding rect |
| **PowerShell output garbled for Chinese** | Console code page is not UTF-8 | Emit **ASCII-only** from the script and map back to Chinese via `localizeDialogMessage()` |
| **Binding fails with `mode=Code`** | The "select folder" path is unreliable outside Work mode | `bindProject` **falls back to Work once**, then switches back to the target mode |
| **Path written into the edit box, but confirm does not close the dialog** | The MCP passes a `normPath()`-normalized path (`d:/a/b` - lowercase drive, forward slashes), which the **native picker rejects** | Convert via `toNativeWindowsPath()` to `D:\a\b`; verify with `WM_GETTEXT` read-back and never click confirm on mismatch |
| **A stale dialog from a previous failure gets written to** | `findFolderDialog()` returns true on *any* matching window | `closeStaleFolderDialogs()` runs before binding; the detected hwnd is passed into the write script so only that window is touched |
| **Long thinking was declared complete after ~36 seconds** | The old stability fallback treated an unchanged DOM as completion and only checked the literal thinking placeholder | Stop button/task-tail loading now win; stable rounds start a ten-minute idle timer |
| **Polling hung forever after TraeWork closed** | WebSocket loss never rejected pending calls and `send()` had no timeout | `onclose`/`onerror` reject all pending calls; commands default to a 15-second timeout |
| **MCP timeout closed an instance that was still working** | `finally` always released instances launched by this module | Release only on real completion/ask_user; retain on idle, timeout, cancellation, and CDP loss with structured metadata |

---

## 9. Implementation layout

```
src/agents/traework/
├── adapter.ts            AgentAdapter implementation (run execution surface)
├── run.ts                Single-round orchestration (detect→session→project→model→send→poll)
├── launcher.ts           Port detection/avoidance, reuse decision, launch, safe release
├── cdp/
│   ├── client.ts         CDP connection and DOM/input ops (Node built-ins, no third-party deps)
│   └── selectors.ts      Selector table (primary + fallbacks + profile overrides)
├── ui/
│   ├── session.ts        New session, mode switch, project folder binding
│   ├── composer.ts       Task input, read-back verification, send
│   ├── model.ts          Model dropdown collection and strict switching
│   └── reply.ts          Reply extraction and completion detection (pure functions, fully unit-tested)
└── computeruse/
    ├── guard.ts          Whitelist guard (TraeWork folder picker only)
    └── dialog.ts         Native dialog driver (Windows UI Automation)
```

---

## 10. Verification record (2026-09-08)

| Item | Result |
|---|---|
| CDP connection | ✅ `--remote-debugging-port=9222` connected; page target is `solo-lite.html` |
| Selector hits | ✅ chat input / new task / task list / mode / model dropdown / project button / dropdown rows / footer all hit |
| Project binding | ✅ When not in the dropdown, the native dialog registered `D:\Trae项目\ts-e2e-smoke` (`state.vscdb` entries 18→19) |
| Model switch | ✅ Switched to `GLM-5.3` with strict verification |
| **End-to-end** | ✅ `run_task(agentId=traework, model=GLM-5.3, autoVerify=true)` drove TraeWork to create `result.txt`; auto-verification passed (`succeeded`, changedFiles `result.txt`) |
| Unit/integration | ✅ 153/153 passed (81 new, including the rework loop and race regression) |
| lint / typecheck / build | ✅ all clean |
| **CI (GitHub Actions)** | ✅ **7/7 green** — ubuntu/macos/windows × Node 20/22 + npm tarball check (run 34222781967, commit `e8c59cc`) |

### 10.1 Two pre-existing defects fixed during implementation

1. **Rework feedback race (pre-existing; intermittent under load, hit on CI Windows/Node 22)**
   - Symptom: after `rework_task(feedback)`, the rework round received no feedback and stayed `failed`.
   - Root cause: the terminal snapshot is written first, so the caller can immediately set
     `reworkFeedback`; the *previous* run's post-processing then did `delete meta.reworkFeedback`,
     erasing the freshly written feedback.
   - Fix: consume and clear the feedback atomically when `startTask` begins; no longer delete in post-processing.
   - Regression: `test/integration/rework-feedback-race.test.ts` (three consecutive failure→immediate-rework rounds).
2. **`projectBasename` cross-platform (failed on Linux/macOS CI)**
   - Symptom: on Linux/macOS, `path.basename("D:\\a\\b")` returns the whole string (POSIX does not treat `\` as a separator).
   - Fix: split explicitly on both `\` and `/`.

> Real-machine tests require a running TraeWork and are **not part of CI** (see the test layering in
> `docs/acceptance-config.md`).
