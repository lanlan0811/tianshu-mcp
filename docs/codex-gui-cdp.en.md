# Codex Desktop GUI Driver (codex-gui-cdp.en.md)

The tianshu-mcp Codex adapter drives the OpenAI Codex desktop app (the ChatGPT desktop application) through the full loop: locate install → launch GUI → bind/create project → select model and reasoning level → send instructions → run detection → verify → repair.

- Implementation: `src/agents/codex/**`
- Plan: `.zcode/plans/codex-gui-adapter-plan.md`
- Status: verified on Windows real hardware; macOS is `research` (unverified, excluded from readiness)
- Hardware acceptance: [codex-windows-smoke.en.md](codex-windows-smoke.en.md)
- Related: [adapter-matrix.en.md](adapter-matrix.en.md), [agent-profiles.en.md](agent-profiles.en.md), [acceptance-config.md](acceptance-config.md)

---

## 1. Why COM activation instead of launching the exe

The Codex desktop app is a **Microsoft Store (MSIX/AppX) package**. Its GUI host `ChatGPT.exe` lives under the protected `C:\Program Files\WindowsApps\OpenAI.Codex_<version>_x64__2p2nqsd0c76g0\app\`.

| Channel | Measured result | Can carry debug args |
|---|---|---|
| Direct `CreateProcess` / `cmd start` / PowerShell `&` | **Fails**: `Access is denied`, Win32 `0x80070005` | No |
| `explorer.exe shell:AppsFolder\<AUMID>` | Activates an existing instance | No (unreliable args) |
| **`IApplicationActivationManager::ActivateApplication(AUMID, args, 0)`** | **Succeeds, args forwarded verbatim** | **Yes** |

Why direct launch fails: `ChatGPT.exe` grants `BUILTIN\Users` the `RX` right, but the file also carries the AppX execution tag `S-1-19-512-4096:(I)(RX,D,WDAC,WO,WA)`, which requires "activation with package identity only". A plain `CreateProcess` child has no package identity, so the policy layer rejects it (Explorer surfaces this generically as "Windows cannot access the specified device, path, or file", easily misread as a permissions or path problem).

COM activation goes through the app-model activation channel, so it has package identity and succeeds; its `arguments` parameter is forwarded **verbatim** to the process command line.

## 2. Key constraint: a dedicated user-data-dir is required

The CDP debug port only opens under a **dedicated user-data-dir**:

| Configuration | Result |
|---|---|
| Dedicated `--user-data-dir` + `--remote-debugging-port=<port>` | **Works**: port listening within 2s; `/json/version` returns `Chrome/152.x`; `/json/list` shows `app://-/index.html` |
| Default profile (the instance the user opened manually) + debug port | **Fails**: port never opens (Electron's single-instance lock is per user-data-dir; the new process forwards args then exits) |

**Conclusion: the MCP cannot attach CDP to a Codex the user opened manually; it must launch its own managed instance.**

A separate profile **loses no data**: projects, sessions and auth live in `~/.codex/` (`.codex-global-state.json`, `config.toml`, `auth.json`), shared across profiles. The managed profile directory defaults to:

- Windows: `%LOCALAPPDATA%\tianshu-mcp\codex-gui\profile`
- macOS (not enabled): `~/.tianshu-mcp/codex-gui/profile`

## 3. Install discovery

`src/agents/codex/discovery.ts`, in order:

1. **Explicit path**: `gui.exePath` or `command` (used if present).
2. **Appx query (authoritative, version-agnostic)**: `Get-AppxPackage -Name OpenAI.Codex` → `InstallLocation`;
   validate `<InstallLocation>\app\ChatGPT.exe` exists;
   `AUMID = <PackageFamilyName>!App` (measured `OpenAI.Codex_2p2nqsd0c76g0!App`).
3. **Scan fallback**: `{SYSTEMDRIVE}\Program Files\WindowsApps\OpenAI.Codex_*_x64__*/app/ChatGPT.exe`;
   when several versions coexist, take the **newest by package version** (this machine has both `26.903.8094.0` and `26.903.9818.0`).
4. macOS: `ChatGPT`/`Codex` under `dirs` (`research`).

**Nothing is hardcoded**: no version number, no absolute `WindowsApps` location, no kernel `bin\<hash>` directory. Everything is queried dynamically or glob-matched.

## 4. Launch and attach

`src/agents/codex/launcher.ts` (COM activation) + `instance.ts` (process/port/readiness):

1. **Reuse first**: enumerate root `ChatGPT.exe` processes (excluding `--type=`/`crashpad`); if an instance's `--user-data-dir` belongs to this MCP and its port really serves a Codex page → adopt it.
2. **Port avoidance**: start at `gui.cdpPort`; when `cdpPortAuto`, probe forward for a free port.
3. **COM activation**: `ActivateApplication(AUMID, "--user-data-dir=<dedicated> --remote-debugging-port=<port>", 0)`. Inline C# is injected via `Add-Type`, no third-party dependency.
4. **Wait for readiness**: poll `/json/list` until a Codex page appears (`app://` scheme or ChatGPT/Codex title), up to `gui.launchTimeoutMs` (default 60s).
5. **Target convergence**: Codex also exposes secondary windows (measured: `app://-/index.html?initialRoute=%2Favatar-overlay` and a `type=webview` pricing page); `pickCodexPage` excludes `overlay` and prefers `index.html`, so we never attach to the wrong window.

> The managed instance is **not** killed automatically; the scene is kept after a task for troubleshooting (`keptInstance: true`).

## 5. UI selectors and constraints

**Key fact**: Codex's frontend barely uses `data-testid` (only 2 on the whole page in measurement), and its class names embed build hashes (e.g. `_ComposerLayout_kbwao_2`, which changes every build). We therefore locate by `aria-label` plus visible text, with CSS structure as fallback.

| Semantic key | Primary selector | Notes |
|---|---|---|
| `chatInput` | `div.ProseMirror[contenteditable="true"]` | ProseMirror rich text; must be driven via CDP input, cannot set `value` |
| `sendButton` | `button[aria-label="发送"]` | **Conditionally rendered**: absent while the composer is empty; present means sendable |
| `stopButton` | `button[aria-label*="停止"]` | Authoritative running signal (replaces send while generating) |
| `newChat` | `button.sidebar-item` + text "新对话" | |
| `projectPickerTrigger` | `button[aria-haspopup="dialog"][aria-label^="切换项目"]` | Measured label is "切换项目：<name>"; the sidebar's "添加新项目" must be excluded |
| `sourceFolderArea` | `[role="dialog"] button[class*="drop" i]` | Click the "添加 Codex 可读取和编辑的文件夹" button; **"源文件夹" is a label and not clickable** |
| `createProjectButton` | `[role="dialog"] form button:last-of-type` | The `<h2>` title shares the text; prefer interactive elements |
| `projectItem` | `button[aria-label$="的项目操作"]` | Project name taken from the label prefix |
| `modelTrigger` | `button[aria-haspopup="menu"]`, **scoped to the composer + menubar excluded** | see below |
| `permissionTrigger` | `button[aria-label="更改权限"]` | text e.g. "完全访问" |
| `messageArea` | `[class*="MainContentSurface"]` | Text-stability fallback; **never bare `main`/`#root`** (they include nav chrome) |

**Real-hardware pitfall (fixed)**: the top menu bar (File/Edit/View/Help) also carries `aria-haspopup="menu"`; without exclusion `modelTrigger` matched the menubar. Selectors therefore support `excludes` (`[role="menubar"]`, `header`), and the CDP layer additionally picks the bottom trigger by "text looks like a model". Verified on hardware: it resolves to `GPT-5.6 Sol 高`.

Multilingual: every key ships bilingual candidates (`texts` / `ariaLabels`) plus a structural fallback; `gui.selectors` (semantic key → selector) hot-patches UI drift at runtime.

## 6. Model and reasoning level

`src/agents/codex/model.ts`. Task parameters are **two fields**:

- `model`: e.g. `GPT-5.6 Sol`
- `reasoningLevel`: `低/中/高` or `low/medium/high` (normalized internally to `low|medium|high`)

**Actual UI structure (measured on hardware; differs from the original assumption)**: after opening the model menu —

1. **Models** are `role="menuitemradio"` candidates; the current one has `aria-checked="true"`. Select by exact visible text.
2. **Reasoning strength is a slider** (`role="slider"`, `aria-valuemin=0` / `aria-valuemax=4`), **not a menu item**:
   its five stops are labelled **轻度(0) / 中(1) / 高(2) / 极高(3) / 极高(4)**.
   Drive it by focusing the slider and pressing Left/Right arrows (return to minimum first, then step up, so the result does not depend on the starting position). Hence "高" is `aria-valuenow=2`.

> An early implementation clicked the reasoning strength like a menu item, which **could never set it** (exposed by hardware testing); it now drives the slider with arrow keys. Also, level comparison must be **exact** — the UI contains both "高" and "极高", so a substring match would misread a manually-set "极高" as satisfying "高".

Read-back: while the menu is open the trigger's own text is unreadable, so read the in-menu "选择模型" item text (e.g. `GPT-5.6 Sol 高`) instead, then re-check the trigger text after closing the menu; both reads wait for UI re-render to avoid empty values. Retry ≤3 times, then abort with `model_mismatch`.

## 7. Project binding and creation

`src/agents/codex/project.ts` + `run.ts`.

- **Match rule (decision 2)**: match the target directory's **basename** against Codex's project display names, case-insensitively on Windows; multiple hits → `project_ambiguous`, never guess.
- **Existing project**: click `在 <name> 中开始新聊天` (fallback to `<name> 的项目操作`) → confirm by reading back the bottom workspace chip.
- **New project (two-tier strategy)**:
  1. **Automatic registration first** (`src/agents/codex/registry.ts`; deterministic, preferred): write the target directory into Codex's project state `~/.codex/.codex-global-state.json` under `local-projects` + `project-order`, equivalent to the user creating the project once inside Codex. Constraints: **idempotent** (no-op if already registered), **backup before writing** (`.tianshu-mcp-backup.json`, never overwriting an existing backup), **atomic write**, only these two keys are touched, and it only runs while the **MCP-managed instance is stopped** (so a running Codex cannot overwrite it); the user's own default-profile instance is never touched. On non-Windows / missing or unparseable state file → returns `skipped` and falls back to tier 2.
  2. **UI creation** (fallback, matching the screenshot flow): click the project picker → "新建项目" → click the **center blank area** of "源文件夹" (**not** "创建项目" directly) → the Windows **native** folder dialog opens → keyboard-automate the **backslash** absolute path and confirm → confirm the source folder is populated → click "创建项目".

> Automatic registration removes the "unregistered project stuck at project creation" pain: on hardware, an
> unregistered directory was registered automatically and then completed the bound path end to end
> (bind → model/level → permission → send → task done). Note registration stops the managed instance first,
> so that round is the first task and requires a cold start (about 85s on hardware; `launchTimeoutMs` was
> raised to 150s).

The native dialog is unreachable from CDP, so `src/agents/codex/dialog.ts` drives it with UIA + `SendInput`, **fail-closed**:

- Only operates on new `#32770` dialogs **absent from the baseline** (captured by `listCodexDialogs`); never touches existing user windows.
- Only accepts windows owned by a root `ChatGPT.exe` process, class `#32770`, title matching the selection family.
- **Dialog handles are found with Win32 `EnumWindows`**: measurement shows Codex's `Select Project Root` is missed by UIA top-level enumeration, while `EnumWindows` + `AutomationElement::FromHandle` finds it reliably.
- Address bar not uniquely locatable / not navigated to the target path / confirm button not ready / dialog still open after submit → abort, never guess.
- `closeStrayDialogs` clears leftover native dialogs at startup (otherwise they occlude the UI and block the next run).

**Two crucial hardware findings**:

1. **A trusted click is mandatory**: `element.click()` produces an untrusted event the app ignores, so no native picker appears. You must dispatch real mouse events via CDP `Input.dispatchMouseEvent`, and validate the hit with `elementFromPoint` ("源文件夹" is an unclickable `<label>`; the real target is the button labelled "添加 Codex 可读取和编辑的文件夹").
2. **The app window must be foreground**: the native picker only opens when the app window is active. Windows' foreground lock refuses `SetForegroundWindow` from background processes, so this adapter raises the window via **app-model activation** (COM — the same sanctioned foreground request used for launching).

> **Known limitation (stated honestly)**: the whole new-project path depends on the window being foreground. Every step was verified separately on hardware (the dialog really opens, keyboard automation submits, the create-project dialog shows the source folder), but in a **fully unattended** environment a system foreground policy that blocks raising the window can still fail with `project_create_failed`. Binding **existing projects** and the rest of the flow (including verification/repair) are unaffected and have a stable hardware loop.

## 8. Run detection

`src/agents/codex/liveness.ts` (decisions 7/8):

1. **The stop button is the authoritative running signal**: its presence means `running`; never declare completion then.
2. **Text stability counts as completion evidence only after a running signal was observed** — this avoids declaring "still generating but the DOM happens to be static" as complete when the stop-button selector drifts (the lesson from TraeWork's early misjudgement, see [traework-task-liveness-plan](../.zcode/plans/traework-task-liveness-plan.md)).
3. If a running signal is **never observed** → do not declare completion; switch to idle timing and eventually `idle_timeout`: end the round but **keep the instance** (fail-open, no worse than the status quo).
4. Total timeout `taskTimeoutMs` (default 30 min) + idle timeout `idleTimeoutMs` (default 10 min).

> The stop button is confirmed on hardware: while generating, `button[aria-label*="停止"]` appears; the measured verdict log reads `pending → running(stop_button) → finished(stop_button_gone+text_stable)`. If a future version changes the wording and the selector misses, rule 3 above (fail-open) applies and completion is never misjudged.

## 9. Verification and repair

- **Verification (decisions 9/20)**: reuses the existing `AcceptanceEngine` (`src/verify/acceptance.ts`); priority is `extraChecks` > project `.tianshu-mcp/acceptance.json` > `projects.json` records > **default set**; the default set derives `typecheck/lint/test/build` from `package.json` `scripts`. When no command is runnable it is labelled **weak verification** (`src/agents/codex/verify.ts`).
- **Repair plan (decisions 11/12)**: on verification failure the **MCP generates** the plan document, inside the **project** at `gui.fixPlanDir` (default `.zcode/plans/`), named `codex-fix-r<N>.md` (**with round number, one per round, never overwritten**). Because the filename is known before sending, it can be referenced directly in the repair instruction without reading it back from the reply.
- **Repair loop (decision 10)**: up to `autoFixRounds` rounds (Codex default **5**); each round sends a repair instruction to the **same session** (citing that md plus the raw failure output), then re-verifies. Exhausted rounds → `needs_attention`.

## 10. Task parameters

| Field | Description |
|---|---|
| `model` | Model name, e.g. `GPT-5.6 Sol` |
| `reasoningLevel` | `低/中/高` or `low/medium/high` |
| `planDoc` | Plan document path (project-relative or absolute), added to the initial instruction |
| `designSystem` | Design system directory path, added to the initial instruction |
| `autoVerify` / `autoFixRounds` | Auto verification / repair rounds (max 10, Codex default 5) |

The initial instruction reads: `根据计划文档(<planDoc>)和设计系统(<designSystem>)，进行项目开发`.
`planDoc`/`designSystem` are reference-validated first (must exist inside the project); out-of-bounds or missing values are rejected outright.

## 11. Profile configuration essentials

```jsonc
"codex": {
  "driver": "gui",
  "adapter": "codex-gui",
  "executableDiscovery": {
    "appxPackageName": "OpenAI.Codex",                 // Appx query first
    "installRelativeExe": ["app/ChatGPT.exe"],
    "scanRoots": ["{SYSTEMDRIVE}/Program Files/WindowsApps"],  // scan fallback
    "scanPattern": "OpenAI.Codex_*_x64__*/app/ChatGPT.exe"
  },
  "gui": {
    "activation": "msix-com",                          // required: COM activation
    "userDataDir": "{LOCALAPPDATA}/tianshu-mcp/codex-gui/profile",  // required: dedicated profile
    "cdpPort": 9333, "cdpPortAuto": true,
    "permissionMode": "完全访问",
    "fixPlanDir": ".zcode/plans",
    "defaultAutoFixRounds": 5,
    "launchTimeoutMs": 60000, "pollIntervalMs": 3000,
    "stableRounds": 4, "idleTimeoutMs": 600000,
    "selectors": {}                                     // hot-fix for UI drift
  }
}
```

## 12. Troubleshooting

Start with the hardware diagnostic script:

```bash
node scripts/probe-codex.mjs            # read-only: discovery + process/port status
node scripts/probe-codex.mjs --launch   # full: activate managed instance + CDP + live selectors
```

| Symptom | Likely cause | Action |
|---|---|---|
| Appx query times out/fails | PowerShell slow or execution policy limited | The script auto-falls back to scanning; confirm `Get-AppxPackage` can run |
| Activation succeeds but the port never opens | The default profile was reused (single-instance lock swallows args) | Ensure `gui.userDataDir` is a dedicated directory |
| `Access is denied` launching the exe | AppX policy forbids identity-less execution | Use COM activation (this adapter's default); do not switch to direct spawn |
| Input box not found | Still rendering / not signed in | Raise `launchTimeoutMs`; check for a login page (returns `needs_user`) |
| `model_mismatch` | Model name or level text differs | Verify `model`/`reasoningLevel`; hot-patch `gui.selectors` if needed |
| Never finishes | Stop-button selector missed | This is the fail-open path, ending in `idle_timeout`; use `--launch` to observe the real stop-button text |
| Project binding fails | Native dialog blocked / path has special characters | Inspect `[codex]` lines in `agent-N.log`; confirm keyboard-automation permissions |

## 13. Known limitations

- The macOS path is unverified (`status: research`); its code is excluded from readiness.
- **New-project creation depends on a foreground window**: the native picker only opens while the app is active. Every step was verified separately on hardware, but in a fully unattended environment where the system blocks raising the window it can return `project_create_failed`. Binding existing projects and the verification/repair loop are unaffected (stable hardware pass).
- Codex's frontend text/selectors drift across versions; mitigated by bilingual candidates, structural fallbacks and `selectors` hot-patching.
- The native folder dialog depends on UIA control structure (`AutomationId 1001/41477/1`), which system updates may change; failures are fail-closed and never misclick existing windows.
- The managed instance and any instance the user opened manually do not interfere; still, **only one managed instance should exist at a time** (the adapter has a built-in serial gate).
- This adapter supersedes the earlier `codex exec` headless CLI path (plan decision 19); headless execution would require a separate profile.
