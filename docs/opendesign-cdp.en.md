# Open Design GUI (CDP) adapter: real-machine facts and design rationale

[中文](opendesign-cdp.md)

This document records the **real-machine findings** for the `opendesign-gui` adapter and the
constraints they impose on the implementation. The adapter turns the Open Design desktop client (the
"Let's create a prototype" AI app that generates design artifacts) into a tianshu-mcp GUI agent that can
be dispatched to, observed, and accepted.

> Evidence machine: Windows 10 Pro 19045; Open Design 0.24.1 (Electron 41.3.0, official installer);
> install directory `D:\Open Design`; captured 2026-09-25 ~ 2026-09-26.

## 1. Installation and data directories

| Fact | Value / source |
|---|---|
| Install shape | **Plain install** (not an MSIX store package), `<install dir>\Open Design.exe` |
| Install config | `<install dir>\resources\open-design-config.json` → `appVersion` / `namespace` |
| Measured values | `appVersion=0.24.1`, `namespace=release-stable-win` |
| Electron userData | `%APPDATA%\Open Design\namespaces\<namespace>\user-data` |
| App data | `%APPDATA%\Open Design\namespaces\<namespace>\data\` (`app-config.json`, `app.sqlite`) |
| Logs | `%APPDATA%\Open Design\namespaces\<namespace>\logs\{daemon,desktop,launcher,web}` |

**Nothing is hard-coded**: the install path is derived from `executableDiscovery`
(`preferredDrives:["D:"]` + `relativePaths:["Open Design/Open Design.exe"]` → registry uninstall info →
standard directories → PATH); version and namespace always come from the install config.
**When the namespace cannot be read we do not guess** (`openDesignNamespaceRoot` returns `null`),
because guessing it wrong produces a silent misjudgement ("directory bound but `app-config.json`
unreadable") instead of a loud error.

## 2. Instance takeover: single-instance lock and the truth about `--user-data-dir`

This is where Open Design differs most from ZCode / Kimi Code / Qoder, and it decides the instance strategy.

| Fact | Source (`resources/app/prebundled/packaged-main.mjs`) |
|---|---|
| A **process-level single-instance lock** exists; a second instance only hands its deeplink to the first and exits | `claimPackagedSingleInstanceLock` (:34250-34259), `createPackagedSecondInstanceHandoff` (:34260-34283) |
| The main process **forces** `app.setPath("userData", <namespaceRoot>/user-data)` | `applyPackagedElectronPathOverrides` (:34245-34248) |
| Therefore the `--user-data-dir` switch **is overridden** | same; `resolvePackagedNamespacePaths` (:32578-32598) |
| `--headless` is supported (no window; starts daemon/web sidecars; `--mcp-install codex`) | `parsePackagedHeadlessRequest` (:33471-33484), `runPackagedHeadless` (:33510+) |

### Resulting strategy (reuse → self-launch → ask the user to close)

1. **Reuse first**: an existing instance whose root process argv carries a valid debug port is taken over
   (`probeOpenDesignPort` performs product validation).
2. **Launch a managed instance**: with no instance present,
   `spawn(exe, ["--remote-debugging-port=<port>"])`.
3. **`needs_user(close_existing_instance)`**: an instance exists without a debug port → the spawned child is
   handed off by the single-instance lock and exits; the adapter **asks the user to close it manually**
   and never kills user processes.

**No "dedicated userData managed instance"**: the main process overrides that switch, so writing it into the
profile would be a false promise. The `opendesign` profile therefore leaves `gui.userDataDir` unset and
`exeArgs` only injects the debug port.

### The root-process trap (hit on the real machine, then fixed)

The product also runs its daemon and web sidecars as child processes of the same executable. On the evidence
machine their command lines look like:

```
"D:\Open Design\Open Design.exe" "D:\Open Design\resources\app\prebundled\daemon\daemon-sidecar.mjs"
"D:\Open Design\Open Design.exe" "...\@open-design\sidecar\dist\supervisor.mjs" --od-stamp-app=web
```

They have **no window and do not take part in the single-instance lock**, but they stay resident. Counting
them as "a running instance" would keep reporting `needsClose` after the user closes the UI, so a managed
instance could **never start**. `rootOpenDesignProcesses()` therefore also drops processes whose argv
contains an `.mjs` script, in addition to `--type=` / crashpad. Measured: 11 same-named processes → exactly 1
real desktop main process.

## 3. CDP endpoint

| Item | Value |
|---|---|
| Debug port base | **9889** (range 9889-9898) |
| Why not 9777 | That port is taken by **Qoder CN** (base 9777, range 9777-9796) — changed after real-machine measurement |
| Existing bases | traework 9222 / zcode 9333 / codex 9333 / kimicode 9666 / qoder 9777 |
| Product validation | `/json/version` `User-Agent` contains `electron` **and** a page target exists whose title starts with `Open Design` (or whose URL contains `open-design`) |
| Version criterion | The **product version** comes from `resources/open-design-config.json`; CDP `/json/version`'s `Browser` is the **Electron version** (`Electron/41.3.0` measured) and must **not** be used for product-version comparison |

> Version-criterion pitfall: the first implementation used CDP's `Browser` field for the version gate, which
> made every real-machine dispatch fail with `version_mismatch`. It now reads the install config, with a
> regression test in `opendesign-discovery.test.ts`.

## 4. UI structure and selector capture

Open Design is a **packaged React app** (`resources/app/prebundled/*` are minified build artifacts, no
readable source), so selectors must be captured on the real machine. Capture entry points:

```sh
npm run build
node scripts/probe-opendesign.mjs anchors --no-focus   # read-only survey; connect without focusing
node scripts/probe-opendesign.mjs all                  # install + process + cdp + appconfig + anchors
```

The probe dynamically imports build artifacts from `dist/` and is **read-only**: it never clicks, types, or
sends; a managed instance is launched only with an explicit `--launch`. `anchors` prints the match count and
first text for every candidate selector in `ANCHOR_CANDIDATES`, plus the first 1200 characters of visible page
text, so a human can converge on stable selectors and write them back to
`src/agents/opendesign/selectors.ts`.

> **Current state**: `selectors.ts` still holds empty placeholders; selector capture (plan phase P1) is not
> finished. `run.ts` therefore **hard-fails with `not_implemented`** when required selectors are missing —
> reporting success for an adapter that is not wired to the UI yet would corrupt acceptance and repair
> accounting, and is far more dangerous than a clear error.

### Known UI anchors (screenshot evidence, pending DOM confirmation)

| Control | Visual position (1366×705 viewport) | Notes |
|---|---|---|
| "Working directory" trigger | ~ (455, 297) | expands to "Select directory" / "Recently used directories" |
| "Select directory" item | ~ (455, 346) | opens the **native Windows "Select Folder"** dialog |
| Model trigger | ~ (1081, 242) | menu has "local CLI" and "API provider" groups; the latter items show a lock icon |
| Design system trigger | ~ (521, 242) | panel has a search box plus a long list (151 bundled design-system packages) |
| Design direction trigger | ~ (658, 242) | menu: Prototype / Slides / Document / Image / Website clone / HyperFrames |
| Send button | ~ (1163, 242) | round button |

## 5. Native "Select Folder" dialog

The dialog in mockup 2 is a native Windows `#32770` raised by Electron `dialog.showOpenDialog`, with a
"Folder:" edit box and "Select Folder" / "Cancel" buttons. The adapter's contract:

- **Ownership check first**: collect the managed instance's process pids and match with
  `EnumWindows` + `GetWindowThreadProcessId` (recursively checking parent processes, same approach as
  `kimicode/dialog.ts`); only operate on windows that match;
- Path entry and confirmation go through UIA / keyboard (landing with evidence in phase P2);
- Ownership unclear or dialog absent → close only the dialog we raised and switch to
  `needs_user(system_permission)`; user windows are **never** touched.

## 6. `app-config.json` corroborating fields

Measured content of `%APPDATA%\Open Design\namespaces\<namespace>\data\app-config.json` (excerpt):

```json
{
  "agentId": "amr",
  "designSystemId": "default",
  "agentModels": { "amr": { "model": "deepseek-v4.1-flash" } },
  "recentLinkedDirs": ["D:\\Trae项目\\tianshu-mcp"],
  "defaultProjectLocationId": "default"
}
```

Purpose: **corroboration and diagnostics only** (`agentModels` / `recentLinkedDirs` can corroborate "which
model was selected / which directory was bound last"). **UI read-back is the authoritative criterion**;
editing this file to bypass clicking is outside this adapter's behavioural boundary.

The probe's `appconfig` subcommand prints these fields read-only.

## 7. Where design systems and models come from

| Item | Source |
|---|---|
| Design system catalogue | `<install dir>\resources\open-design\design-systems\<slug>\manifest.json`'s `name` (e.g. `claude` → `Claude (Anthropic)`), 151 bundled packages |
| Model IDs | Model registry in the packaged artifacts; `deepseek-v4-flash` / `deepseek-v4-pro` / `claude-fable-5` confirmed present |
| Design direction | The UI offers six entries; the adapter supports **only** Prototype / Document / Website clone and rejects the rest explicitly |

Models and design systems are always **matched exactly and then read back**: a miss fails with the currently
visible candidates echoed back (see `matchMenuCandidate` in `model.ts`) and never degrades into fuzzy
matching — picking the wrong model is worse than an error.

## 8. Failure codes

| Failure code (`endReason`) | Trigger | Orchestrator action |
|---|---|---|
| `setup_failed` | Entry validation failed (invalid direction / empty task text / executable not found) | Hard failure, no acceptance |
| `version_mismatch` | Product version not in `opendesign.supportedVersions` | Hard failure echoing the measured version |
| `selector_drift` / `not_implemented` | Required selectors missing or UI driver incomplete | Hard failure listing the missing keys |
| `model_mismatch` | Target model name does not match exactly in the model menu | Hard failure echoing candidates |
| `needs_user` | Existing instance without debug port / manual action required | Task moves to `needs_user`; resume with `continue_task` |

## 9. Reproduction notes

```sh
npm run build
node scripts/probe-opendesign.mjs install      # install / version / namespace / data directories
node scripts/probe-opendesign.mjs process      # processes and root-process determination
node scripts/probe-opendesign.mjs appconfig    # app-config.json corroboration
node scripts/probe-opendesign.mjs cdp          # ports and page targets (needs an instance with a debug port)
node scripts/probe-opendesign.mjs anchors      # UI anchor survey (needs an instance with a debug port)
```

**`cdp` / `anchors` require Open Design to be running with a debug port**: close any existing window first, then
run `node scripts/probe-opendesign.mjs anchors --launch` (this opens a new window). If an existing instance is
running without a port, both the probe and the adapter report `needs_user(close_existing_instance)` truthfully.
