# Kimi Code GUI (CDP) Adapter

tianshu-mcp's fourth GUI agent adapter (`agentId=kimicode`): it drives the Kimi Code desktop app (Moonshot AI) through the full loop of "locate the installation → launch it with CDP enabled → bind the task folder (workspace) → select model and reasoning tier → force full-auto → send the task → detect completion → auto-verify → rework on failure → re-verify".

- Implementation: `src/agents/kimicode/` (`adapter.ts`, `run.ts`, `cdp.ts`, `dom.ts`, `selectors.ts`, `instance.ts`, `session.ts`, `workspace.ts`, `dialog.ts`, `model.ts`, `liveness.ts`, `recovery.ts`, `discovery.ts`)
- Profile: `kimicode` in `src/agents/builtin.ts` (`adapter: kimicode-gui`)
- Status: `ready` on Windows; `research` on macOS (native folder dialog is fail-closed)
- Real-machine smoke test: `scripts/smoke-kimicode.mjs`; read-only diagnostic probe: `scripts/probe-kimicode.mjs`
- Related: [adapter-matrix.md](adapter-matrix.md), [agent-profiles.md](agent-profiles.md), [acceptance-config.md](acceptance-config.md)

## 0. Environment facts (measured sample; nothing here is hardcoded)

| Item | Measured value |
|---|---|
| Executable (sample) | `D:\Kimi-Code\Kimi Code\Kimi Code.exe` (~225 MB; the directory contains `chrome_100_percent.pak`, `resources.pak`, `LICENSE.electron.txt`) |
| Packaging | Plain Electron install (**not MSIX**) |
| Version | `FileVersion 1.0.2` (`ProductVersion 1.0.2.0`, `CompanyName Moonshot AI`) |
| Chromium / Electron | `Chrome/150.0.7871.114` / `Electron/43.1.1` |
| CDP `User-Agent` | `… kimi-code-app/1.0.2 Chrome/150.0.7871.114 Electron/43.1.1 …` |
| Page URL prefix | `app://renderer/` |
| CDP port | default `9666` (`--remote-debugging-port=9666`; the port was listening within 8 seconds) |
| User data directory | `%APPDATA%\kimi-code-app` (holds sessions and login state; the adapter never touches it) |

`D:\Kimi-Code\...` is merely the local acceptance sample: it is discovered from "fixed-drive relative path templates plus drive preference order", and no user absolute path exists anywhere in the source.

## 1. Overview: how it differs from Codex

Kimi Code is a **plain Electron install**, so:

| Stage | Codex desktop | Kimi Code desktop |
|---|---|---|
| Launch | MSIX/AppX package; needs `IApplicationActivationManager` COM activation to forward debug arguments | **A plain `spawn` of the executable forwards `--remote-debugging-port`; no COM activation needed** |
| user-data-dir | A **dedicated** profile is mandatory, otherwise the debug port never opens | **No dedicated profile**: sessions and login state live in `%APPDATA%\kimi-code-app`, so a separate profile would lose both |
| Existing instance | Independent from the instance the user opened manually | The Electron single-instance lock applies: an existing instance without CDP cannot be attached to, so **the user must close it** (`needs_user/close_existing_instance`) |
| Renderer processes | Single window | **Two renderer processes**: the main window plus the `Kimi Browser Overlay` window (see §4) |

The transport is local CDP only (`127.0.0.1`): the main window owns the sidebar, sessions, composer and the send/stop buttons; the overlay window owns the model menu, the reasoning tiers and the execution-mode menu. Native Windows automation is used only for the native "添加工作区" (Add workspace) dialog that Kimi Code opens itself (see §11).

## 2. Installation discovery

`discoverKimicode` in `src/agents/kimicode/discovery.ts`, in order:

1. **Explicit path**: `gui.exePath` or `command` (used when it validates);
2. **Windows fixed-drive relative-path templates**: `executableDiscovery.preferredDrives` (default `["D:"]`) first, then `relativePaths` (`Kimi-Code/Kimi Code/Kimi Code.exe`, `Kimi Code/Kimi Code.exe`, `Kimi/Kimi Code/Kimi Code.exe`, `kimi-code/kimi code/kimi code.exe`); only when no configured drive matches are the machine's fixed drives enumerated (`Win32_LogicalDisk DriveType=3`);
3. **Uninstall registry**: `HKLM`/`HKCU` `Uninstall\*` entries whose `DisplayName` matches `^Kimi[ -]?Code` and that expose `InstallLocation`;
4. **Standard directories**: `{PROGRAMFILES}/Kimi Code`, `{PROGRAMFILES(X86)}/Kimi Code`, `{LOCALAPPDATA}/Programs/Kimi Code`, `{LOCALAPPDATA}/Kimi Code`, plus macOS `/Applications/Kimi Code.app/Contents/MacOS` and `~/Applications/Kimi Code.app/Contents/MacOS`;
5. **PATH**.

Validation: the executable name contains a space, so the basename is matched **exactly** (`^Kimi Code\.exe$`, never a fuzzy `contains`). A macOS hit inside an `.app` bundle is reported as source `bundle`. Possible sources: `explicit` / `fixed-drive` / `registry` / `standard` / `path` / `bundle`.

**No hardcoded user paths**: `preferredDrives`, `relativePaths`, `dirs` and `fileNames` are all profile data (overridable through `agent-profiles.json`), and the discovery order depends on no machine-specific directory constant.

Read-only confirmation (actual output on this machine):

```text
=== install: Kimi Code installation discovery ===
  Executable: D:\Kimi-Code\Kimi Code\Kimi Code.exe
  Source: fixed-drive
  Version: 1.0.2
```

> Note: `discoverKimicode` reads the version with a 5-second-timeout PowerShell `Get-Item … .VersionInfo.FileVersion` call. On this machine a cold PowerShell start takes 6–10 seconds, so the version is occasionally unreadable (this does not affect the discovery result). `probe-kimicode.mjs install` re-reads it with a longer timeout and labels that explicitly, for diagnosability.

## 3. Launch and CDP preconditions

- Launch arguments come from the profile: `gui.exeArgs = ["--remote-debugging-port=<port>"]` with base port `gui.cdpPort = 9666`; when `cdpPortAuto=true` the adapter walks up to `cdpPortRange=20` ports to avoid conflicts, bounded by `launchTimeoutMs=90_000`. The window uses `windowMode: "reuse"` so the user's login state is reused.
- **Reusing an existing instance**: when a debug port can be parsed from the process command line and that port passes the product check, the instance is reused; waiting for the port's pages to come up is bounded by `launchTimeoutMs`.
- **Existing instance without CDP**: `ensureKimicodeInstance` returns `{ needsClose: true }` and the task moves to `needs_user/close_existing_instance`. The adapter **never kills the user's processes**, never copies login data into an isolated directory, and never starts a dedicated profile.
- **Product check (ownership)**: `probeKimicodePort` accepts a port only if either the `/json/version` `User-Agent` contains `kimi-code-app/`, or a page whose URL starts with `app://renderer/` exists. Otherwise the port is rejected, so another Electron app (which also exposes pages and CDP) is never mistaken for this product.
- **Process filtering**: Electron renderer/GPU/utility child processes match the executable name too (of 6 processes on this machine only one is a root process, and renderer argv also carries `--remote-debugging-port`). `rootKimicodeProcesses` filters out `--type=` / `crashpad` / `plugin-host` / `cua-helper` / `utility-sub-type` before deciding whether an existing instance lacks CDP.
- **macOS**: the main process rewrites its process title after startup (so `ps` no longer shows the debug port); the adapter then re-scans the configured port range with a 10-second budget, and only reports `needsClose` when nothing is found.

Read-only confirmation (actual output, trimmed):

```text
=== process: Kimi Code processes ===
  Total: 6
  Root processes: 1
  - pid=11228 role=root cdp=9666
    command line: "D:\Kimi-Code\Kimi Code\Kimi Code.exe" --remote-debugging-port=9666
  - pid=12872 role=child (renderer/GPU/utility) cdp=9666
    command line: "…Kimi Code.exe" --type=renderer … --remote-debugging-port=9666 …
```

## 4. Two-renderer-process architecture (key section)

A single CDP port exposes three page targets (`/json` and `Target.getTargets` expose no `other` type):

| type | title | url | Role |
|---|---|---|---|
| page | **Kimi Code** | `app://renderer/` (draft page) or `app://renderer/sessions/<sessionId>` | **Main window**: sidebar, session list, composer, input box, send/stop buttons |
| page | **Kimi Browser Overlay** | `app://renderer/browser-overlay.html` | **Overlay window**: model menu, reasoning tiers, execution-mode menu |
| page | Screenshot | `app://renderer/screenshot/index.html?display=<n>` | Screenshot window; **must be excluded** |
| worker ×2 | — | — | Ignored |

Read-only confirmation (actual `probe-kimicode.mjs cdp` output, trimmed):

```text
  Browser: Chrome/150.0.7871.114
  User-Agent: … kimi-code-app/1.0.2 Chrome/150.0.7871.114 Electron/43.1.1 …
  Product marker kimi-code-app/: matched
  page targets: 3
  - [main window (title=Kimi Code)]  mainRank=0   overlayRank=100  url: app://renderer/
  - [overlay window]                 mainRank=100 overlayRank=0    url: app://renderer/browser-overlay.html
  - [screenshot window (excluded)]   mainRank=100 overlayRank=100  url: app://renderer/screenshot/index.html?display=…
  non-page targets: worker, worker
```

**Decisive fact**: after clicking `button.model-pill`, the **main window DOM gains no menu node at all** (node count stays at 391), while the overlay window's `document.visibilityState` flips from `hidden` to `visible` and its node count grows from 20 to 63 with the menu content. The corresponding app-bundle implementation is:

```js
t.browserOverlayOpenMenu({ menuId, anchor, placement, offset, width, autoWidth, initialFocus, preserveFocus, items: e.items(), footerStart })
t.browserOverlayCloseMenu(menuId)
```

→ Every menu opened through `browserOverlayOpenMenu` (model, reasoning tiers, more-models, execution mode) **can only be read and written by attaching to the overlay target**, whereas the workspace dropdown, the attachment menu and the session-header menu render **inside the main window**. Both kinds coexist.

Implementation notes:

- `kimicodeMainTargetRank`: title exactly `Kimi Code` → 0; other `app://renderer/` pages → 1; URLs containing `browser-overlay` / `screenshot` → 100.
- `kimicodeOverlayTargetRank`: only `browser-overlay` pages → 0, everything else → 100.
- `KimicodeCdpClient` holds two page clients: the main window is brought to the front right after connecting, while the overlay is connected **lazily** and re-confirmed through `location.href` (when the port has no overlay page, CDP would hand the main window to it, which must be rejected). If that confirmation fails, `overlayReady=false` and all overlay reads return empty sets, so callers fail closed instead of guessing a tier.
- **The overlay window's `visibilityState` is the only authoritative signal for "is a menu open"**: when the menu closes the overlay becomes `hidden` but its content can linger briefly, so checking DOM presence alone would misread "closed" as "open" (and with toggle semantics that click would close the menu).
- The main window URL changes between the draft page and a session page **without** changing the target id, so the WebSocket connection can be kept for the whole task.

## 5. Selector tables (verified against version 1.0.2)

The whole page contains **0** `data-testid` attributes (no testids to rely on). Class names are **semantic** (not build hashes) and stable; Vue scoped `data-v-*` attributes change between builds and **must not be relied on**. Every key can be hot-patched through `gui.selectors` (`agent-profiles.json`) using its semantic key.

### 5.1 Main window (`KIMICODE_SELECTORS`)

| Semantic key | Selector | Notes |
|---|---|---|
| `newSession` | `button.btn-new-chat` | Sidebar "New session Ctrl N"; clicking turns the URL from `/sessions/<id>` into `app://renderer/` |
| `search` | `button.search` | Sidebar search (kept for diagnostics) |
| `workspaceSectionToggle` | `button.side-section-toggle[aria-label="折叠全部工作区"]` | Collapses all workspaces |
| `workspaceMore` | `button.gh-more[aria-label="选项"]` | Per-workspace "…" menu (kept for diagnostics) |
| `workspaceAddSession` | `button.gh-add[aria-label="在此工作区新建会话"]` | New session inside a workspace group; more precise than the global entry (fallback used by draft retries) |
| `workspaceChip` | `button.ws-chip` | Workspace trigger on the draft page; **disappears from the composer after sending** |
| `workspaceChipName` | `span.ws-chip-name` | Workspace name on the trigger (a new session inherits the previous workspace) |
| `workspacePanel` | `div.ws-panel[role="menu"]` | Workspace dropdown (**rendered inside the main window**, contains "recent folders") |
| `workspaceRow` | `button.ws-row[role="menuitem"]` | Folder entry; the selected one carries class `on` |
| `workspaceName` | `span.ws-name` | Folder display name |
| `workspacePath` | `span.ws-path` | **Full absolute folder path** → the primary binding criterion |
| `chooseFolder` | `button.ws-action[role="menuitem"]` (text "选择文件夹…") | Opens the native "Add workspace" dialog; trusted clicks only |
| `sessionItem` | `div.se[data-session-id]` | **`data-session-id` is the session id** (also readable from the URL) |
| `sessionTitle` | `div.se span.t` | Session title text |
| `sessionMore` | `button.ch-act-more[aria-label="选项"]` | Session-header "…" menu (kept for diagnostics/cleanup) |
| `chatInput` | `div.ProseMirror[contenteditable="true"][aria-label="消息输入框"]` | ProseMirror rich text; must go through `Input.insertText`, never `value` |
| `attachButton` | `button.composer-attach[aria-label="添加"]` | Attachment entry (menu renders in the main window) |
| `permissionPill` | `span.perm-pill` | Execution-mode trigger (`.open` means expanded); the menu lives in the overlay |
| `modelPill` | `button.model-pill` | Model + tier trigger (`aria-haspopup=menu`); the menu lives in the overlay |
| `modelName` | `span.mp-name` | Model name on the trigger (`K3`, `stepfun/step-3.7-flash:free`) |
| `thinkSuffix` | `span.think-suffix` | Tier suffix such as ` · High` / ` · Max`; non-official models show ` · 思考` |
| `sendButton` | `button.send` | Disabled while the input is empty; while sending its class becomes `send is-starting` |
| `stopButton` | `button.stop` (aria "中断") | **Authoritative running signal**: appears while generating, gone when finished |
| `userMenu` | `button.user-menu-trigger` | Bottom-left user menu (kept for login-state diagnostics) |
| `settingsButton` | `button.side-footer-settings[aria-label="设置"]` | Settings entry (diagnostics only) |
| `gitBranch` | `button.ch-git` | Git branch chip in the session header; appears after sending |
| `openInMain` | `button.open-in-main` (aria "用 File Explorer 打开") | Session-header entry (diagnostics only) |
| `messageArea` | `div.panes` | Conversation body; used for stability checks and error text (**never use `body`**, it would mix in the sidebar) |
| `modelDialog` | `div.ui-dialog[role="dialog"]` | "Switch model" dialog (in the main window) |
| `modelDialogSearch` | `div.ui-dialog input.ui-input` | Dialog search box (placeholder "搜索模型或提供商…") |
| `modelDialogRow` | `div.ui-dialog div.model-row[role="option"]` | Candidate row; **`.is-current` marks the current model** (`.is-selected` is only a recommendation) |
| `modelDialogRowName` | `div.model-row span.model-name` | Model name (exact matching uses NFKC + collapsed whitespace) |
| `assistantCopyButton` | `button.a-cpbtn` | Assistant copy button (supporting evidence only, never a completion criterion) |
| `userCopyButton` | `button.u-copy` | User-message copy button (supporting evidence for send confirmation) |
| `errorRetryButton` | `button.ui-button--secondary` (text "继续") | Failure-state criterion (accompanied by "模型请求失败，本轮对话已中断") |
| `userGate` | **empty by default** (not built in) | Waiting-for-user detection is disabled unless `gui.selectors.userGate` is configured |

### 5.2 Overlay window (`KIMICODE_OVERLAY_SELECTORS`; keys are prefixed with `overlay.` externally)

| Semantic key | Selector | Notes |
|---|---|---|
| `overlayStage` | `main.browser-overlay-stage` | Overlay menu stage |
| `menuList` | `div.browser-overlay-list` | Menu list container |
| `menuRow` | `button.overlay-menu-row` | Generic menu row (model/permission/more-models share it; meaning depends on menu timing) |
| `menuRowTitle` | `span.overlay-menu-title` | Row title ("完全自动", "更多模型…") |
| `menuRowDescription` | `span.overlay-menu-description` | Row description (present in the execution-mode menu) |
| `modelOption` | `button.overlay-menu-row[role="menuitemradio"]` | Model candidates; **the current one carries `.is-active`** |
| `thinkingSegment` | `button.ui-seg__item[role="tab"]` | Reasoning-tier segmented control; **the current tier carries `.is-on`** |
| `moreModelsItem` | `button.overlay-menu-row[role="menuitem"]` (text "更多模型…") | Clicking hides the overlay immediately and opens the "Switch model" dialog in the main window |
| `permissionOption` | `button.overlay-menu-row[role="menuitemradio"]` | Execution-mode candidates; **the current one carries `.is-active`** |

## 6. Task folder (workspace) binding

Kimi Code organises sessions by workspace (task folder), so a task must be bound to a registered directory (**project-less mode is unsupported**: `workspaceMode=default` or an empty `projectPath` is rejected before dispatch).

- **The full path is the primary criterion**: panel entries expose an absolute path in `span.ws-path` (the native form `D:\Trae项目\tianshu-mcp`). `normalizeWorkspacePath` upper-cases the drive letter, unifies separators, trims trailing separators and compares case-insensitively on Windows before matching `projectPath`; the name (`span.ws-name`) is only a fallback.
- **Ambiguity fails closed**: zero path hits plus multiple name hits stops with `ambiguous`, and the adapter **never guesses** (guessing would dispatch the task into the wrong directory).
- **Creating the draft**: click "New session" and confirm the post-condition "`button.ws-chip` is mounted"; throttled clicks are retried in bounded cycles (alternating between the global entry and "new session in this workspace"), and a timeout fails closed without sending. "The click returned true" never equals "the draft page is active".
- **A new session inherits the previous workspace**, so the workspace must still be explicitly verified and bound after entering the draft; "we never clicked the workspace button" is not proof of being unbound.
- **Unregistered workspace**: the adapter samples the native-dialog baseline, clicks "选择文件夹…", and only touches the **newly appeared** `#32770` window owned by the target process (see §11).
- **Binding readback**: the panel is reopened and the adapter requires exactly one selected entry whose normalised full path equals `projectPath` and a non-empty `ws-chip` text; any mismatch fails closed as `readback` (the failure message carries the expected path and the actual value).
- **`ws-chip` disappears from the composer after sending**, so the binding cannot be read back afterwards; recovery rounds therefore use the session anchor (URL/sidebar id) as the re-check criterion.

## 7. Model and reasoning tier

`model` is **mandatory** (Kimi Code has no notion of a "default model", and the current UI value cannot carry task semantics; `gui.modelRequired=true`). `reasoningLevel` is optional with the value domain `低/low`, `高/high`, `max`, `on`, `off`; out-of-domain values such as `中/medium` are rejected during argument validation (`describeLevelValueError`).

- **No built-in model list**: the only source of the tier set is the **tier labels the UI actually renders**, classified by `tierSetOf`:
  - `official`: official models (Kimi subscription, e.g. `K3`, `K2.8 Preview`, `K3-256k`) → `Low / High / Max`;
  - `onoff`: non-official models (e.g. kiro's `stepfun/step-3.7-flash:free`) → `On / Off`, defaulting to `On`;
  - `unknown`: tier labels unreadable → **fail closed**, never guess from a built-in list.
- **Tier validation happens before sending**: a requested tier outside the UI set is an error (`模型 X 的思考等级仅支持 Low/High/Max，收到「中」（medium）`), and the adapter never silently keeps the current UI tier.
- **Defaults**: with `reasoningLevel` omitted, official models keep the current UI tier while non-official models are forced to `On` (no click when already `On`).
- **Three-stage selection**:
  1. Read back the full `button.model-pill` text (measured `K3 · High`; non-official models show `stepfun/step-3.7-flash:free · 思考`) — if it already matches, it is reused without extra clicks;
  2. Direct pick from the overlay shortcut menu: `overlay.modelOption` is clicked by exact visible text (multiple or zero matches click nothing and report the visible candidates), then the trigger is re-read until it converges;
  3. "More models…" dialog: click `overlay.moreModelsItem` → the "Switch model" dialog opens in the main window → type into the search box (clear with `Ctrl+A` + `Backspace` first, then `Input.insertText`, waiting for the candidate list to converge) → click the row by **exact** `span.model-name` match. When a model name containing `/` yields zero hits, the adapter retries the search with the provider prefix (before the `/`), but **identity matching always uses the full name**.
- **Prefixes are distinguished exactly**: `K3` and `K3-256k` must match as whole strings; a prefix hit would look like "K3 is already selected" and skip the switch.
- **`.is-current` is the current model inside the dialog**: `.is-selected` pointed at `K2.8 Preview` while the current model was `K3`; non-official model rows carry `is-current is-selected` together.
- **Failure classification**: when all three stages fail, the adapter closes any lingering dialog first (a leftover dialog swallows later keyboard injection) and then distinguishes `model_mismatch` (a candidate was clicked but had no effect) from `model_unavailable` (the model does not exist), including both candidate lists in the message.

## 8. Execution mode

The adapter forces the execution mode to "**完全自动**" (full auto) (`gui.permissionMode` / `defaultPermissionMode`, overridable by `resume.permissionMode` during recovery) and confirms it by readback before sending:

- When the `span.perm-pill` text already equals the target, it is reused; otherwise the overlay execution-mode menu is opened and `overlay.permissionOption` is clicked by exact visible text;
- The three tiers are `始终询问` (always ask) / `必要时询问` (ask when necessary) / `完全自动` (full auto), with `.is-active` on the current one; the trigger must read back identically, otherwise `permission_unknown` hard-fails without sending;
- Kimi Code does not support TraeWork's `mode` argument: passing it is an argument error (`gui.modeSwitch=false`).

## 9. Run detection

Detection rules (`liveness.ts`):

1. **Authoritative running signal**: `button.stop` (aria "中断") exists and is visible → `running`; it appears 0.5–1.2 s after sending and disappears when the turn finishes.
2. **Secondary running signal**: `button.send` has the `is-starting` class (measured alongside the stop button).
3. **Failure states never count as completion**: `button.ui-button--secondary` ("继续") is visible, or `div.panes` contains "模型请求失败，本轮对话已中断" / `provider.auth_error` → `failed` (terminal reason `agent_error`). Rework rounds filter stale failure text from a previous round using the pre-send baseline (the "继续" button is a strong current-failure signal and is not filtered).
4. **Only without any signal** does text stability decide: the `div.panes` text hash must be unchanged and non-empty for `stableRounds` (default 4) consecutive rounds to report `finished`; `idleTimeoutMs` (default 10 minutes) only starts once `stableRounds` is reached, and any text change resets it. **"Text static for N seconds" is never a standalone completion criterion.**
5. **Stall fallback**: a permanently visible stop button with text stalled beyond `stallTimeoutMs` (default 5 minutes) → `needs_user/user_confirmation` (recoverable with `continue_task`), breaking the "always visible → always running" deadlock.
6. **Input-clearing trap**: after clearing, ProseMirror's `innerText` length is still **1** (an empty `<p>` remains), so the empty-state check must use the NFKC-trimmed empty string, not `length === 0`.
7. `poll()` gathers the whole snapshot in a **single evaluate** (`stopVisible`, `sendStarting`, `assistantText`, `errorText`, `retryVisible`, `inputText`, `sendEnabled`, `pageHidden`, …) to reduce page round-trips during polling. Heuristic question detection is off by default (see §12).

Send confirmation: a 60-second bounded observation after clicking send requires "session id (URL) + user message landed" as mandatory anchors plus at least one of "input cleared / running signal / user-message copy button". The adapter **clicks send exactly once and never resends**; an unconfirmed send is `send_unknown`.

## 10. Window foreground and swallowed clicks (real-machine pitfall, key section)

Chromium throttles occluded/invisible pages, which **swallows synthetic mouse events**: the symptom is "clicking new session does nothing" or "the workspace trigger ignores clicks for 5 seconds", easily misdiagnosed as broken selectors.

- **`Page.bringToFront` works for Kimi Code** (unlike ZCode's Electron): `connect()` brings the window to the front immediately and enables `Emulation.setFocusEmulationEnabled`.
- **Bringing to front takes effect asynchronously (hundreds of milliseconds in practice)**: dispatching a click right after a single `Page.bringToFront` still gets swallowed. `focusMainWindow()` waits for `visibilityState` to converge (bounded by `FOCUS_SETTLE_MS = 1500 ms`) instead of sleeping a fixed duration; a failed focus call does not throw, because the correctness criterion is always the post-click readback.
- **Clicks always prefer trusted coordinate clicks** (`Input.dispatchMouseEvent`: moved + pressed + released) and fall back to DOM `element.click()` only when no unique visible target exists: `button.ws-chip` only accepts trusted clicks while `button.model-pill` accepts both, so trusted must be the primary path.
- **Bounded periodic retries**: `openWorkspacePanel`, `openOverlayMenu` and `ensureFreshDraft` all re-click every `TRIGGER_RECLICK_MS = 1500 ms` until their post-condition holds (panel open / overlay visible / `ws-chip` mounted) and **never reset the caller's deadline**; because triggers are toggles, each round checks before clicking so an already-open menu is not closed.
- When the send button cannot be clicked and `pageHidden` is true, the error message states "the Kimi Code window is not in the foreground (the page is throttled, synthetic clicks are unreliable)" instead of a generic "button not clickable".

## 11. Native "Add workspace" dialog (Windows)

Trigger path: `button.ws-chip` on the draft page → workspace panel `button.ws-action` ("选择文件夹…") → native dialog. Measured facts:

| Item | Measured value |
|---|---|
| Class | `#32770` (standard Windows dialog) |
| Title | `添加工作区` |
| Owning process | Kimi Code |
| "文件夹:" label | AutomationId `1090`, Class `Static` |
| **"Folder" edit box** | **AutomationId `1152` + Class `Edit`, ControlType is Pane (no ValuePattern)** |
| Confirm button "选择文件夹" | **AutomationId `1`**, ControlType **Pane** |
| Cancel button | AutomationId `2` |

Implementation discipline (`dialog.ts`):

- **Only newly appeared windows are touched**: `listOwnedDialogs(pids)` samples a baseline first (identity format `dialog:<hwnd>:<title>`), then only windows that are "absent from the baseline + owned by the target process + class `#32770`" are considered; more than one new window throws `AMBIGUOUS_…` instead of blindly clicking a user window. The title is diagnostic only (a mismatch is reported as `native:title-mismatch` without abandoning a real dialog).
- **Neither the confirm nor the cancel button supports UIA `InvokePattern`** (measured "unsupported pattern") → they must be clicked by coordinates from `BoundingRectangle` via `SetCursorPos` + `mouse_event`. The confirm button additionally requires "unique AutomationId=1 + enabled + rectangle centre in the lower half of the dialog" (the upper half is the list area, so a hit there means the control tree drifted).
- **The path is written with `WM_SETTEXT` and read back with `WM_GETTEXT`**: the path is converted to its native form first (upper-case drive letter + backslashes via `toNativeDialogPath`; the native picker rejects forward slashes), then read back immediately and compared through `GetFullPath`. **A readback mismatch never confirms** (up to 3 attempts).
- **The path reaches the PowerShell script only through environment variables** (`TIANSHU_KIMICODE_FOLDER` and friends); the script source contains no path literal or interpolation, so CJK text cannot be mangled by the command-line code page.
- After submitting, the dialog handle must be gone; the adapter still re-reads the full path from the UI (§6), because a successful native submit is not a successful binding.
- **macOS is fail-closed**: `selectKimicodeFolder` returns `macOS 原生文件夹选择未实现（Kimi Code macOS 适配仍为 research）` on darwin and never runs an unverified osascript flow.

Read-only confirmation: `node scripts/probe-kimicode.mjs dialogs` enumerates every `#32770` window owned by the target processes (hwnd / class / title / visibility); the dialog only exists after clicking "选择文件夹…".

## 12. `needs_user` and `continue_task`

The five pause kinds and their recovery semantics:

| `needsUserKind` | Trigger | Recovery (`continue_task`) |
|---|---|---|
| `close_existing_instance` | An existing Kimi Code instance without CDP was detected | The user closes every Kimi Code window and confirms; recovery performs an **environment re-check** and re-sends the full task (with context and verified references). **The confirmation text is never sent to the model**, and the user's processes are never killed |
| `login_required` | The main window is reachable but the composer never mounted during the observation window (usually a login/onboarding page) | The user completes login/onboarding in Kimi Code and confirms; recovery without an anchor re-sends the task, and the confirmation text is never sent to the model |
| `setup_recovery` | Workspace binding failed (draft/panel/ambiguity/click/readback) or automatic recovery did not finish | The user handles the prompted item in Kimi Code and confirms; recovery re-sends the task and states explicitly that no task will be sent to another workspace |
| `system_permission` | The native dialog needs accessibility permission (macOS branch) | Grant Accessibility permission and confirm |
| `agent_question` | Heuristic question detection fired (or the waiting-for-user UI matched when `gui.selectors.userGate` is configured) | `continue_task(taskId, message=answer)`: the answer is written **only into the precisely located original session**, and the task is not re-sent |
| `user_confirmation` | The stop button stayed visible with stalled text (`stall`), or `userGate` matched | **Reconnect and observe** (`reobserve`): the user's confirmation text is never sent to the model, the model and execution mode are not changed, and the adapter only observes the original session until a terminal state |

Two hard rules:

- **An unlocatable original session always fails closed as `session_lost`**: a recovery round needs a session anchor (`kimicodeSessionId` / `kimicodeSessionTitle`); a missing anchor, zero or multiple matches, or a URL readback mismatch after switching pages all hard-fail, and the adapter **never opens "recent sessions"**.
- A pause releases the project run slot and the global Kimi Code serial lock while preserving the task ID, Git baseline, session anchor, project path, model and execution mode; a server restart does not archive it as `interrupted`.

Heuristic question detection (`detectQuestion`) is **off by default**: it only activates when the profile explicitly configures `gui.selectors.userGate` (criteria: no running signal + empty input + changed text + trailing question mark). Kimi Code's question card selector is **not verified on a real machine** (the account quota limit made a question scenario impossible to construct), so no guessed selector is built in — a wrong one would turn normal runs into `needs_user` and then send the user's confirmation text to the model as an answer.

## 13. Cancellation and timeouts

- **Cancellation** (`cancel_task` / abort): the adapter best-effort clicks `button.stop` over CDP and waits, bounded by `gui.cancelWaitMs` (default 15 seconds), for "stop button gone and send button restored"; the outcome is reported as `guiStop { clicked, idle }`.
- **No false claims**: when `idle=false` the terminal message states "GUI run not confirmed stopped; the task inside the Kimi Code window may still be running", and without CDP it states that stopping could not be confirmed at all.
- **Cancellation, timeouts and disconnects always keep the instance** (`keptInstance: true`): windows are not closed and user processes are not killed. `task_timeout` stops the MCP wait and preserves the scene; `cdp_disconnected` preserves it for manual judgement.
- **Re-dispatch guard**: if the instance still shows a running signal before dispatch, the adapter tries to stop it first; if it is still busy the run hard-fails as `instance_busy`, preventing overlapping turns (the `reobserve` round is exempt, since a visible stop button is exactly how a paused observed turn looks).
- Every wait is clamped by the minimum of "task deadline / setup budget / stage budget" (`KimicodeBudget`), and retries never reset the budget. Cancellation and the guard use a **non-budgeted** raw CDP client, otherwise an aborted budget would prevent even a single stop click.

## 14. Real-machine verification record

Environment: Windows 10 x64, Kimi Code `1.0.2` (Chromium 150 / Electron 43.1.1), CDP port 9666.

**Verified on a real machine in this round**

| Item | Result |
|---|---|
| Installation discovery | Found `D:\Kimi-Code\Kimi Code\Kimi Code.exe`, source `fixed-drive`, version `1.0.2` |
| Launch and CDP | The port was listening within 8 seconds of `--remote-debugging-port=9666`; the product check on `/json/version` matched |
| Two renderer processes | Main window (`app://renderer/`), `Kimi Browser Overlay` and the screenshot window coexist; opening the model menu only changes the overlay's visibility |
| Workspace binding | A registered workspace was selected by full path and read back successfully; an **unregistered workspace was imported through the native "Add workspace" dialog** and then read back successfully |
| Model and tier | Official model `K3` with `High`→`Max` switched and read back; non-official `stepfun/step-3.7-flash:free` matched the measured `On/Off` tiers and the "思考" trigger suffix |
| Execution mode | "完全自动" read back successfully |
| Send and run | After sending: `button.send` → `is-starting`, `ws-chip` disappeared from the composer, `button.stop` appeared; completion was reported once the reply stabilised |
| Development and acceptance | The success path completed real file development and passed auto-verification **2/2** |
| Failure → rework loop | A controlled first-round failure was automatically reworked and re-verified **in the same session** |
| Free model usable | With the official model quota exhausted, `stepfun/step-3.7-flash:free` completed the "send → run → finish" path |

**Not covered on a real machine (must not be claimed as verified)**

| Item | Coverage |
|---|---|
| Real cancellation (`cancel_task` → `guiStop.idle`) | Hermetic integration tests only (`test/integration/kimicode-flow.test.ts`) |
| `agent_question` questions and answers | Hermetic integration tests only (a real question scenario could not be constructed) |
| Duplicate workspace names | Hermetic integration tests only |
| Full macOS flow | Not verified: the profile status is `research` and the native folder dialog is fail-closed |
| `gui.selectors.userGate` waiting-for-user UI | Selector not built in; not verified |

**Known blocker**: during this round's reconnaissance the official model quota ran out (the server returned `403 You've reached your monthly usage limit for this billing cycle.` / `provider.auth_error`, and the UI showed "模型请求失败，本轮对话已中断" with a "继续" button). This does not affect detection (that state is reported as a failure rather than a completion), but it means real development tasks on official models need a quota refresh or a switch to a free non-official model.

## 15. Known limitations and troubleshooting

**Limitations**

- macOS is `research`: discovery and CDP reuse work, but the native folder picker is not implemented (fail-closed) and the end-to-end flow is unverified.
- Project-less mode is unsupported (`projectPath` is required); TraeWork's `mode` argument is unsupported; `allowCreateProject` is ZCode-specific and is rejected for Kimi Code.
- The question (waiting-for-user) UI is unverified on a real machine, `userGate` is disabled by default, and only the stall fallback converges such turns.
- When the official model quota is exhausted, a free non-official model (e.g. `stepfun/step-3.7-flash:free`) can be used: its reasoning tiers are only `On`/`Off`, the trigger suffix reads "思考", and `reasoningLevel` accepts only `on`/`off`.
- **Session titles are polluted by the task marker (known cosmetic side effect)**: Kimi Code derives a session title from the first user message, and following the existing convention this adapter **prepends** the `【tianshu:<taskId>:r<round>:<attempt>】` marker to the task brief (the marker is a required anchor for session location and for the "never re-send" guarantee — the same mechanism ZCode/Codex use). The sidebar therefore shows titles like `【tianshu:tsk_…:r0:initial】<start of the task brief>`. This is the price paid for reliability and does not affect functionality; if you want a clean title, rename the session manually in Kimi Code (renaming changes the title, so on `session_lost` please start a new task instead).

**Troubleshooting**

| Symptom | Action |
|---|---|
| `close_existing_instance` | Save your Kimi Code work, quit every window manually, then call `continue_task` |
| Clicks do nothing / `send_unknown` | Make sure the Kimi Code window is in the foreground (background pages are throttled and swallow synthetic clicks); `pageHidden` in the `liveness` snapshot points this out directly |
| `model_unavailable` / `model_mismatch` | Inspect both candidate lists with `node scripts/probe-kimicode.mjs models` (shortcut menu and "Switch model" dialog); hot-patch `gui.selectors` when the UI drifts |
| Tier error | The tier set comes from the UI: `Low/High/Max` for official models, `On/Off` for non-official ones; `中/medium` is never valid |
| Workspace binding failure | Use the `workspaces` subcommand to check whether the panel exposes full `span.ws-path` paths; identical names in different directories must be disambiguated manually |
| Native dialog not completed | Use the `dialogs` subcommand to confirm the window shape (`#32770` + "添加工作区"); confirm/cancel do not support UIA InvokePattern and can only be clicked by coordinates |
| Login/onboarding page | Complete login inside Kimi Code, then `continue_task` |
| `session_lost` | The original session was deleted or its title was rewritten; start a new task — the adapter never opens "recent sessions" |
| `cdp_disconnected` | Preserve the scene and judge manually after confirming the instance and port ownership |

**Diagnostic probe**

```powershell
npm run build
node scripts/probe-kimicode.mjs install        # installation discovery (path / source / version)
node scripts/probe-kimicode.mjs process        # processes and --remote-debugging-port
node scripts/probe-kimicode.mjs cdp            # /json/version and page-target ownership
node scripts/probe-kimicode.mjs workspaces     # workspace panel (name + full path + selected)
node scripts/probe-kimicode.mjs session        # session id and sidebar list
node scripts/probe-kimicode.mjs models         # model / reasoning-tier / execution-mode candidates
node scripts/probe-kimicode.mjs liveness       # one running-signal snapshot
node scripts/probe-kimicode.mjs dialogs        # native "Add workspace" dialog enumeration
node scripts/probe-kimicode.mjs all            # run every read-only command above in order
```

`--port <n>` overrides the CDP port (default 9666). The probe is **read-only by default**: it starts no instance and sends no message (it has no send capability at all); only an explicit `--launch` may start Kimi Code (which opens a new window). Connecting to the main window brings Kimi Code to the foreground, which is required for read-only CDP diagnostics (background pages are throttled).

**Real-machine smoke test (actually sends a task; requires explicit confirmation)**

```powershell
npm run build
node scripts/smoke-kimicode.mjs --confirm-send --model "K3" --project D:\repo\app --task "only inspect package.json, do not modify files, and reply with the result"
```

A task is sent only when `--confirm-send`, `--model` and `--task` are all present. The script uses an isolated data directory (it never pollutes `~/.tianshu-mcp`), prints the task ID, status transitions and evidence directory, and keeps the Kimi Code window open.

**Usage example**

```text
run_task(
  projectPath=D:/repo/app,
  agentId=kimicode,
  model=K3,
  reasoningLevel=High,
  task=implement the feature described in `.tianshu-mcp/plans/feature.md`,
  autoVerify=true
)
```

- `model` is mandatory and must be the exact model name shown in the UI (e.g. `K3`, `stepfun/step-3.7-flash:free`); a missing model, an ambiguous name or an inconsistent readback after switching fails before sending.
- Every initial call creates a new session; automatic rework, `rework_task` and follow-up answers may only resume the recorded original session.
- Before sending, the workspace must be bound precisely, the model and tier read back, and "full auto" forced; any unclear state fails closed.
- `autoVerify=true` is the default, and `autoFixRounds=2` when unspecified; when verification fails, the rework plan is written to `<TIANSHU_MCP_HOME>/tasks/<taskId>/rework-<taskId>-r<round>.md` (the shared verification engine is described in [acceptance-config.md](acceptance-config.md)).
