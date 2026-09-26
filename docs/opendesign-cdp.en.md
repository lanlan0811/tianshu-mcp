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

### 2.1 ⚠️ `ELECTRON_RUN_AS_NODE`: the real root cause of failed launches (measured)

`Open Design.exe` is an **Electron launcher with an embedded Node**. If the process that starts it carries
`ELECTRON_RUN_AS_NODE=1` (this machine's DSH harness injects exactly that), the launcher is forced into
**Node mode**:

```
D:\Open Design\Open Design.exe: bad option: --remote-debugging-port=9889   (exit code 9)
D:\Open Design\Open Design.exe: bad option: --headless                     (exit code 9)
```

The symptom is "no window, no new log lines, no crash dump" — **very easy to misdiagnose as a broken
installation**. Clearing the variable makes the same command work immediately:

```
DevTools listening on ws://127.0.0.1:9889/devtools/browser/63dd8142-…
```

`NODE_OPTIONS` must be cleared too: Node explicitly forbids `--remote-debugging-port` there, and a leftover
value fails with `--remote-debugging-port= is not allowed in NODE_OPTIONS`.

**Managed launches therefore sanitise the environment** (`OPEN_DESIGN_ENV_DENYLIST` +
`sanitizedSpawnEnv()`) and **do not change the command line** — it stays the profile's `exeArgs`
(`--remote-debugging-port=<port>`), which is the form the official launcher already supports.

> ⚠️ **Manual verification must clear the variable yourself**: launching via `Start-Process` or the Explorer
> shortcut from a session that carries it fails the same way — measured as **launcher exit=0 with zero
> processes left** (not `bad option`, because the arguments are fine; the launcher's internal Node-mode branch
> just returns). Both symptoms share one root cause, so do not be misled by the differing exit codes.

### 2.2 The launcher is a "detached child" shape

Measured: after accepting the debug port the launcher prints `DevTools listening on …` and then **exits with
code 0**; the real Electron main process is the detached child it spawned. Therefore:

- **Exit code 0 does not mean failure**: the announced port must be parsed from stderr
  (`devtoolsPortsFromOutput()`) and polling must continue;
- The first implementation treated exit code 0 as "ask the user to close the old instance", which on the real
  machine manifested as "it is clearly running yet it keeps asking me to close it" — fixed.
- Exit code 9 is classified as "cannot take over → `needs_user`"; any other non-zero is a genuine launch
  failure (thrown with the stderr tail).

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

> **Current state (P1)**: the **selector/DOM layer is implemented**, while `selectors.ts`'s `primary` values
> are still **empty placeholders** — the code is ready, the values await capture. `run.ts`'s **layout guard**
> therefore hard-fails with `selector_drift` before any click and lists the missing keys; once selectors are
> captured and written back the gate clears with no code change.
>
> **Selector capture is blocked by an environment limit (measured 2026-09-26)**: this DSH harness session has
> **no external network**, and Open Design performs version/telemetry/billing requests at startup
> (`releases.open-design.ai`, `amr-api.open-design.ai`, …). With those unreachable the **main thread is wedged
> during startup**: processes and window exist, `DevTools listening` has been printed, yet `/json` and
> `/json/version` **connect and then never respond** (curl connects, receives 0 bytes, times out).
> Real DOM capture therefore could not be completed in this round. Run §9 from a normal, network-capable
> terminal to capture it.

### Implemented selector/DOM layer (P1 deliverables)

| File | Contents |
|---|---|
| `selectors.ts` | 16 semantic keys (`primary` + semantic `fallbacks`), `cssCandidates`, `specArgs`, `selectorSpec`, the in-page `resolveFnSource`, the **layout guard key set** `OPEN_DESIGN_LAYOUT_GUARD_KEYS` and `missingSelectorKeys()` |
| `dom.ts` | In-page expressions: `exists` / `text` / `singlePoint` / `firstPoint` / `exactMatch` / `listLabels` / `count` / `inputValue` / `conversationText` / `triggerText` / `layoutProbe` / `dismiss` / `directionItemVisible`, marker prefix `od:` |

Design constraints (isomorphic to `kimicode/dom.ts`):
- Click expressions **return coordinates only**; `cdp.ts` dispatches the mouse events. No side effects.
- The layout guard **only covers anchors that exist in the initial page** (title / composer / triggers /
  send button / conversation). It deliberately excludes `stopButton`, menu items and the design-system search
  box, which only appear at runtime — including them would make the adapter unable to ever start.
- Fallbacks **must not be broad containers** (`button`/`div[class]`/`li`…): multiple matches break
  coordinate clicking, and the error only says "selector not mounted", which is very hard to diagnose
  (now pinned by assertions).
- Candidate matching is **exact equality**; a miss errors and echoes the visible candidates, and
  **never degrades into fuzzy matching**.

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
# ⚠️ Clear the variables that force the launcher into Node mode first (see §2.1);
# managed launches sanitise automatically, manual diagnosis must do it explicitly.
unset ELECTRON_RUN_AS_NODE; unset NODE_OPTIONS      # Windows PowerShell: Remove-Item Env:\ELECTRON_RUN_AS_NODE

node scripts/probe-opendesign.mjs install      # install / version / namespace / data directories
node scripts/probe-opendesign.mjs process      # processes and root-process determination
node scripts/probe-opendesign.mjs appconfig    # app-config.json corroboration
node scripts/probe-opendesign.mjs cdp          # ports and page targets (needs an instance with a debug port)
node scripts/probe-opendesign.mjs anchors      # UI anchor survey (needs an instance with a debug port)
```

**Full selector-capture procedure** (requires reachable external network, otherwise the main thread wedges on
startup requests):

1. Close every Open Design window (an instance without a debug port cannot be taken over);
2. `node scripts/probe-opendesign.mjs anchors --launch`: starts a managed instance and prints
   `/json/version`, the page-target topology, the match count and text for every semantic key, and the first
   1200 characters of visible page text;
3. Write the converged stable CSS back into `primary` in `src/agents/opendesign/selectors.ts`
   (or override per semantic key in `agent-profiles.json`'s `gui.selectors` — no release needed);
4. Re-run `anchors` and confirm the "layout guard" section reports **all anchors matched**;
5. Paste the evidence into the anchor table in §4.

`--no-focus` connects without bringing the window to the front (for pure DOM reads). Click diagnostics
**must** focus it — background pages are throttled by Chromium and synthetic events become unreliable.
