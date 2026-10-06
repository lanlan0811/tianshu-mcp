# Tianshu-mcp Logs (GUI)

Chinese version: [gui-log-viewer.md](gui-log-viewer.md)

**Tianshu-mcp Logs** is a **read-only local desktop app** that unifies the four kinds of log output produced by the Tianshu MCP server. It does **not** require the MCP server to be running — it reads the filesystem directly.

- Code location: `mcp-gui/` (standalone project, independent version, independent CI)
- Stack: Tauri 2.x (Rust backend) + Vue 3 + Vite + TypeScript
- Relation to the MCP package: a **read-only consumer**. It does not replace `query_task` / `get_task_report` (which are machine-facing contracts) and never modifies business data.

---

## 1. Installation

Artifacts are produced by CI (the `GUI` GitHub Actions workflow):

- **Normal use**: download installers from a GitHub or Gitee **release** (tag like `gui-v0.1.0`);
- **Preview builds**: tags containing `-beta.` / `-rc.` are published in both repos as well, but carry a
  **Pre-release** flag;
- **Verifying a build**: download the `gui-*` workflow artifact from the corresponding Actions run.

| Platform | Installer | Auto-update payload |
|---|---|---|
| Windows | `.exe` (NSIS installer) | The same `.exe` is reused by the updater (with a matching `.exe.sig`; **the Tauri updater does not support MSI**, so no MSI is shipped) |
| macOS | `.dmg` | `.app.tar.gz` (**arch-qualified as `*_darwin-aarch64.app.tar.gz` / `*_darwin-x86_64.app.tar.gz`**) |

> The auto-update payload naming depends on `bundle.createUpdaterArtifacts`: this project uses the v2 native mode
> (`true`), so on Windows no extra `.nsis.zip` is produced — the NSIS installer itself is reused
> (`*-setup.exe` + `*-setup.exe.sig`); on macOS it is `.app.tar.gz` + `.sig`.
> Note that Tauri's macOS payload name carries **no arch**, so the two architectures would collide and overwrite each
> other; CI therefore **renames it per platform** before publishing to keep the names unique.
>
> The artifact base name comes from `bundle.productName`; this project deliberately uses the **space-free**
> `Tianshu-mcp-Logs` (the in-app display name stays "Tianshu-mcp 日志台 / Tianshu-mcp Logs"). GitHub **renames**
> release assets containing spaces or other non-alphanumeric characters (space → dot) while Gitee keeps them as-is,
> and that mismatch would break the download URLs inside the update manifests. CI also asserts that payload names use
> only `[A-Za-z0-9._-]` and fails otherwise.
>
> **`bundle.productName` is frozen once released — do not change it again**: the NSIS "Apps & features" uninstall
> registry key is built from it (`…\CurrentVersion\Uninstall\<productName>`). Renaming it makes the new installer stop
> recognising the previous installation — the old version is neither overwritten nor uninstalled, so it stays in the
> list while its directory and shortcuts stay on disk (exactly what happened between `0.1.0-beta.1` and `0.1.0-beta.3`).
> `mcp-gui/src-tauri/windows/installer-hooks.nsh` (wired via `bundle.windows.nsis.installerHooks`) therefore runs
> `NSIS_HOOK_PREINSTALL` before installing: if a legacy-named uninstall entry is found, its own uninstaller is run
> silently and any leftover registry keys / shortcuts are cleaned up afterwards. The hook only acts when such a legacy
> entry exists — **fresh installs and updates within the current name are unaffected** — and it **never deletes user
> data** (the NSIS uninstaller's "Delete app data" checkbox is only set in interactive mode, not in silent uninstalls).

> **macOS builds are not code-signed or notarized by Apple**: the first launch may require manual approval under
> System Settings → Privacy & Security. This does not affect functionality or auto-update — update integrity is
> guaranteed by minisign signature verification.

---

## 2. Data home

On startup the app resolves the default data home with **exactly the same rules as the MCP server**:

1. `TIANSHU_MCP_HOME` (used when non-empty);
2. otherwise `~/.tianshu-mcp`.

From the data-home block at the bottom of the sidebar you can:

- **switch** between multiple data homes;
- **add** a directory (validation: it must contain `logs/` or `tasks/`, otherwise it is rejected with a reason);
- **remove** an added directory.

The added directories are persisted in the **system application config directory** (e.g. `%APPDATA%` on Windows,
`Application Support` on macOS) and **never written into project directories**.

---

## 3. The four log types and the full-page views (insights / MCP capabilities)

| Source | Path (relative to data home) | Where in the UI |
|---|---|---|
| Global runtime log | `logs/server.log` | Workspace · server log (entered from the sidebar "Server log" item) |
| Task event stream | `tasks/<taskId>/task.jsonl` | Workspace · event stream |
| Raw execution logs | `tasks/<taskId>/agent-<round>.log`, `verify-<round>.log` | Workspace · agent logs / verify logs |
| Acceptance reports | `tasks/<taskId>/report-<round>.{md,json,html}`, `dry-run-report-<round>.{md,json}` | Workspace · reports |

### 3.1 Task overview

- **The UI is a permanent left sidebar plus four full pages**: a **task overview page**, an **insights page**, an **MCP capabilities page** and a **full-page workspace**. The sidebar runs brand → global search → main nav (Tasks / **Insights** / Server log / **MCP capabilities** / **Settings** / **Command palette**) → **data home (with refresh / add / remove on the same row)** → task section nav, while the overview runs a five-cell metrics strip (total / active / finished / succeeded / failed) → status chip row → task card grid; the **settings entry and the data home both sit in the main nav area** (the data home directly below "Settings", separated by a grouping rule), the **data-home row carries three icon buttons — refresh / add directory / remove**, **nothing permanent sits at the bottom of the sidebar**, and the brand row shows just the app name with no decorative colour square;
- Tasks are shown as **cards**: the left rail carries the status color (semantic tone via `statusTone`), the title has a `›` prefix, and each card shows the status label, `agent · taskId`, `updated · rounds [· report round]` and a dry-run tag;
- The **status chips** (all / running / succeeded / failed / needs attention / needs human) are **page-level grouping** and do not rewrite the filter conditions;
- The `[Filter]` popover carries the full set: keyword, agent, status, project, time range, **error type / dry run / reworked / visual acceptance** (from 0.1.1-beta.2), active-only, plus sorting (updated / created / task ID, ascending or descending) and "Reset filters". Error-type options come from the **facets** of the current task set (no hard-coded enum), the three boolean conditions are tri-state (all / yes / no), and their semantics map one-to-one onto task-snapshot fields (reworked = `roundsUsed > 1`, visual acceptance = a `report-<round>.html` exists);
- Covers both `tsk_*` (dispatched tasks) and `vfy_*` (standalone path verification records). Clicking a card opens that task's **full-page workspace**.

### 3.2 Event stream

- Rendered as a timeline that **separates state-transition events from fine-grained agent events**
  (`task_dispatched` / `confirmation_dialog_detected` / `awaiting_user_authorization` /
  `file_modification_started` / `rework_triggered`);
- `note` remains the **progress / audit** channel and is labelled separately;
- `file_modification_started` is a **heuristic inference** (adapters do not observe the filesystem directly), so
  its wording keeps "may have started modifying files";
- Unparsable lines are **skipped but counted**, with an explicit notice at the top — never silently dropped.

### 3.3 Raw logs

- The first screen reads only the **tail window** (64 KiB) and loads earlier chunks on demand, showing
  "loaded N / total M";
- Level filter (`DEBUG/INFO/WARN/ERROR`), keyword highlighting, line numbers and word-wrap toggles;
- **Live follow**: appended content refreshes incrementally; **scrolling up pauses follow automatically**
  (the view is never yanked back), with a one-click "Jump to latest".

### 3.4 Reports

- `report-<round>.md`: rendered Markdown;
- `report-<round>.json`: structured card (checks passed/failed/skipped, duration, exit code, output tail,
  `changedFiles`, `diffstat`, `analysis.signals`, blocking issues);
- `report-<round>.html` (visual acceptance): rendered in a **sandbox iframe** — **scripts disabled, CSP injected
  to block all external resources, no network**;
- `dry-run-report-*` and `report-*` are **shown separately** (static analysis vs real command acceptance);
- Multiple rounds can be **compared** side by side.

### 3.5 MCP capabilities view

The sidebar "**MCP capabilities**" entry opens a full page that shows the `tianshu-mcp` **tool surface**
read-only (13 tools today), grouped by the three capability families:

- **read** (queries only, no side effects, approval-free), **write** (side effects, all requiring approval),
  and **execute** (runs project-side commands without changing source, approval-free);
- Each tool shows its name, approval marker (approval / no approval) and a one-line purpose; the wait
  primitives `wait_task` / `wait_any` from issue #28 are listed here.

The source is an **embedded mirror list** inside the GUI (`mcp-gui/src/core/capabilities.ts`). It **reads no
files and connects to no MCP server** — the page has content immediately and is independent of the active data
home. The mirror is compared item by item (name + capability + requireApproval) against the truth source
`TOOL_DEFS` in `src/mcp/tools.ts` by `mcp-gui/scripts/check-schema-parity.mjs` in CI; any drift fails the build.

### 3.6 Insights page (scoreboard / attribution / trend)

The sidebar "**Insights**" entry opens a full page (from 0.1.1) that reports read-only statistics over the tasks
under `tasks/` and each task's **latest** acceptance report:

| Section | Contents |
|---|---|
| Scoreboard | Two tables — by agent and by project: tasks / success rate / avg rounds / one-pass rate / avg verify time / missing reports |
| Attribution | Top lists for four kinds (`errorType` / `failedCheck` / `blockingIssue` / `signal`) with share bars |
| Trend | By day / by week toggle; task-count bars plus success-rate and rework-rate lines (plain inline SVG, no chart library) |
| Compare | Pick 2–4 tasks to compare side by side (from 0.1.1-beta.2, see §3.7) |
| Disk usage | Total artifact footprint / `logs/` share / top-20 task sizes / "cleanup" hints (from 0.1.1-beta.3, see below) |

**Conventions for disk usage (from 0.1.1-beta.3)**:

- It measures the **actual size** of `logs/` and **every** subdirectory of `tasks/`, with **no `tsk_` / `vfy_` prefix
  filter** — disk usage must reflect real consumption, and filtering by prefix would under-report it. This is
  **deliberately different** from the task-list scan and the UI says so;
- **It only `stat`s files — contents are never read and nothing is ever deleted**; `top_tasks` holds the 20 largest task
  directories and `logs/` is reported separately;
- **Every "cleanup" rule is relative** (named constants at the top of `mcp-gui/src/core/insights.ts`): one file taking
  **> 50%** of its task, or a task at least **2x the median task size** (the median considers tasks only, never `logs/`);
- **Hints only — there is no delete entry**: neither the page nor the backend command offers any cleanup capability.

**Conventions (read before interpreting the numbers)**:

- Dates are bucketed by **UTC** (the first 10 characters of `createdAt`); **weeks start on Monday** (ISO-8601),
  and the same week spanning a month / year boundary is merged;
- **"One pass" = succeeded in exactly 1 round**; **rework rate = tasks with `roundsUsed > 1` / all tasks in the bucket**;
- **Only each task's latest report round is counted** (the snapshot's `reportRound`, else the highest
  `report-<round>.json`) — so for a task that failed and later succeeded, the earlier failure **does not** enter attribution;
- **Average verify time** counts only rounds whose start / end times both parse (unparsable reports stay out of the
  denominator — no invented times);
- **A zero denominator shows `—`**, never 0%;
- **Read-only**: no business data is written and there is **no delete / cleanup** entry; unparsable reports are shown
  honestly as "N unparsable".

Data access: the Tauri command `get_insights` (`mcp-gui/src-tauri/src/insights.rs` + `timestamps.rs`) scans once and
only does **counting and summing**; rates / TopN / trend gap-filling / week bucketing live in the frontend pure
functions in `mcp-gui/src/core/insights.ts` (unit-tested). The page loads once when opened, has a Refresh button and
reloads when the data home changes — **no live watching**.

### 3.7 Compare tasks (from 0.1.1-beta.2)

The fourth section of the Insights page, "**Compare tasks**": pick tasks on the left (reusing the task list plus
keyword filtering, limited to **4**, with an explicit notice and **no silent replacement** of existing picks) and read
a **side-by-side metric matrix** on the right (columns are tasks, rows are metrics): status / agent / project / rounds
used / verify time / changed lines (+ / -) / files changed / latest verdict / failed checks / error type / message.
The rounds and verify-time rows mark the **best value across tasks**.

- **Reports are read on demand**: only when a task is picked does the app read its latest `report-<round>.json`
  (preferring the snapshot's `reportRound`), cached per `taskId`; switching the data home clears both selection and cache.
- **Anything missing shows `—`**: without a report the verdict and diff stats stay empty, and verify time falls back to
  the task snapshot's `createdAt → finishedAt`, staying blank if neither parses — **no invented times, no invented winners**.
- **Read-only**: it only reads `task.json` / `report-*.json` and writes no business data.

### 3.8 Command palette and hotkeys (from 0.1.1-beta.2)

| Shortcut | Behaviour |
|---|---|
| `Ctrl/Cmd + K` | Open / close the command palette (the sidebar also has a permanent entry) |
| `Esc` | Close the palette |
| `Ctrl/Cmd + R` | Refresh the task list (intercepted, so the webview never reloads) |

Typing performs **subsequence fuzzy matching** (skipping characters is fine, but order must match); `↑` `↓` move and
`Enter` runs. While the palette is open **no other global hotkey fires**, and combinations with `Alt` / `Shift` are never
intercepted. Every command reuses existing data and actions: Tasks / Insights / Server log / MCP capabilities,
cross-task global search, open Settings, switch data home (the active one is labelled), open a task directly.
**The palette adds no write operations.**

**Task commands are searched live as you type, with no cap** (`buildTaskCommands` walks every task on each keystroke; a
blank query lists only navigation and data homes instead of flooding the list with tasks). The result list's
`PALETTE_RESULT_LIMIT = 20` **limits only how many rows are shown, never the search scope** — type a little more to
converge on the target task.
> Version note: `0.1.1-beta.2` still pre-generated the first 50 tasks; **live search takes effect from `0.1.1-beta.3`**.

### 3.9 Baseline section (from 0.1.1-beta.3)

The fifth workspace section, "**Baseline**", shows the `baseline.json` captured when the task was dispatched (read-only):

- repository or not / HEAD (short hash) / whether the tree was already dirty / pre-existing change and untracked counts /
  capture time / the baseline message;
- **compared against the latest report**: the report's actual changes (file count, `+N / -M`) sit next to the baseline's
  pre-existing changes so out-of-scope edits are easy to spot;
- the report is **read on demand** (the snapshot's `reportRound`, else the highest `report-<r>.json`) and cached per task;
- **no baseline means saying so**: a missing or broken file always renders "this task has no saved pre-work baseline" —
  **no zero values are invented**.

### 3.10 Event-stream stages view (from 0.1.1-beta.3)

The event-stream toolbar gains a **List / Stages** segmented control:

| View | Data source | Notes |
|---|---|---|
| List | **Tail window** (64 KiB by default, load earlier blocks) | behaves exactly as before (friendly to huge files) |
| Stages | **Full** `task.jsonl` (`full = true`, read once on demand) | state-transition gantt, bar widths proportional to each stage's share (plain divs) |

- A stage spans **two adjacent state transitions** (`created → started → verify_start → fix_start → … → succeeded/failed`);
- The last stage has no end time and is marked **"running" with a hatched bar** — **no invented durations**;
- If even the full read does not start at `created` (truncated file), the UI **says so** instead of showing an
  incomplete timeline silently;
- Bad lines are counted separately per view and reported at the top (List and Stages never mix counts).

### 3.11 Deep link `tianshu://task/<taskId>` (from 0.1.1-beta.3)

- **Both cold and hot start work**: the URL is queued on the Rust side, which emits a `gui://deeplink` signal; the
  frontend **drains the queue** and routes it (on cold start the event fires before the frontend listener exists, so
  **the queue is the source of truth** and no link is lost);
- **Single instance**: a second launch does not open a second window — it **reveals the existing window** and hands the
  URL to the first instance;
- **Protocol registration** happens at startup and **a failed registration never blocks startup** (macOS returns
  `UnsupportedPlatform`, which is expected);
- Only `tianshu://task/<id>` is accepted, and the id must match `[A-Za-z0-9_-]` (a deep link is external input and the id
  ends up in a file path); anything containing `..` / `%2e` is **rejected outright** (URL normalisation erases `..`, so
  after normalisation there is no way to tell what the original was); **malformed percent-encoding** (e.g. `%zz`, `%80`)
  is likewise treated as unrecognised and reported honestly — a failed decode returns "unrecognised" and is **never
  rethrown** (throwing would break the deep-link subscription that follows, see issue #33); unrecognised links produce an
  **honest UI notice**;
- **Platform differences**: Windows / Linux register a system protocol handler (cold start works); on macOS the plugin
  reports system-level registration as unsupported, so **the hot path is authoritative** — the difference is documented
  rather than glossed over.

---

## 4. Global search / export / copy

### 4.1 Cross-task search

- **It lives in the sidebar**: focusing the sidebar search box returns to the overview page and switches into **search mode** (the body becomes the result list); the `[Tasks]` button returns to the card grid;
- Scope is selectable: event streams / agent logs / verify logs / reports / server log (plus a case-sensitivity toggle);
- Results are grouped as task → file → line with snippets; clicking jumps to the exact view and position (and into that task's **workspace**);
- **On-demand scanning, no local full-text index**; progress feedback and **cancellable**.

### 4.2 Export

- **Single file**: export the currently viewed log/report verbatim (the `⇩ Export` button on the workspace breadcrumb);
- **Task bundle**: zip the whole `<taskId>/` directory, optionally **excluding heavy raw logs**
  (`agent-*.log` / `verify-*.log`); the number of excluded files is reported honestly. That toggle sits in the expanded **task summary bar**.

### 4.3 Copy

Task ID (breadcrumb), absolute task directory (expanded summary bar), and the full current log (log toolbar) can each be copied with one click.

---

## 5. Language and theme

- **Chinese / English** switchable, Chinese by default;
- Theme: **system / light / dark**, system by default (**dark is the design baseline**).

### 5.1 Design system and layout

- **An in-house design system, "Obsidian Terminal" — no UI component library, CSS framework, or animation library.** The **single source of truth** for colors, fonts, spacing, radii, motion, and layout constants is `mcp-gui/src/styles.css` (`src/theme/index.ts` only writes the mode to `<html data-theme="light|dark">`).
- **The layout paradigm is "a permanent left sidebar plus a two-state content area"**: the sidebar (brand · global search · main nav (Tasks / Server log / Settings) · **data home (with refresh / add / remove)** · task section nav) is always present, while the content area switches between the **task overview page** (metrics strip · status chips · task card grid · search mode) ↔ the **full-page workspace** (breadcrumb · task summary bar · content), with `server.log` as the workspace's second form. **The task section nav shares that one sidebar — there is no second left column; no permanent task rail, no permanent detail column, no horizontal tab row.** **Both the settings entry and the data home live in the main nav area** (the data home directly below "Settings"), the **data-home row carries the refresh / add / remove icon buttons**, and **nothing permanent sits at the bottom of the sidebar**. **Refresh is a global action** placed in the data-home row, so it is available in both content states.
- **The settings panel is a centred modal** (not a right-hand drawer): it floats out from the centre of the window with margins on all sides and a 4px radius, scrolling internally when it exceeds the height cap; clicking the empty overlay closes it.
- **Color**: dark by default (obsidian `#0B0D0C` canvas with a fluorescent-green `#3DFFA0` accent) and a light "paper terminal" rebuilt in the same language. The **accent is reserved for selection, primary actions, focus, and the breadcrumb back affordance**; status positions use semantic tones only (success / failure / caution / needs-human / terminated) — told apart by position and shape, not hue.
- **Typography**: **system fonts only**, monospace-led (Windows `Cascadia Mono`, macOS `SF Mono`, CJK fallback `PingFang SC` / `Microsoft YaHei UI`). **No font is downloaded or linked**, so the app is fully usable offline.
- **Icons**: all inline SVG (**no emoji**), inheriting the text color.
- **Visual signature**: a 1px fluorescent rule along the left edge of the sidebar and along the top of the breadcrumb bar (the metrics strip on the overview page); a 3px accent rail marking the current sidebar item; a 3px status rail plus a `›` prefix on task cards; **bracketed status labels** (`[OK] 已成功`); panel radius 4px, tag and input radius 3px; a faint dot grid on the dark canvas and a faint grid on the light one.
- **Readout consistency**: counters, timestamps, line numbers, byte counts, rounds, and exit codes all use tabular figures (`tabular-nums`) so values do not jitter as they change.
- **Accessibility**: every interactive element is reachable by `Tab` with a visible focus ring (task cards and nav items are native buttons, operable with `Enter` / `Space`); icon buttons carry `aria-label`; the system "reduce motion" setting is honoured.

### 5.2 System tray and close behaviour

- **An always-present system tray icon** (Windows notification area / macOS menu bar) that **reuses the app icon** — no extra asset is introduced.
- **Right-clicking the tray icon** opens a two-item menu: **Show Logs** / **Exit Logs**. The labels **follow the UI language** (switching between Chinese and English in Settings takes effect immediately, **no restart needed**). **Left-clicking** the tray icon shows and focuses the window (it does not open the menu).
- **Closing the window defaults to minimizing to the tray**: clicking the window's X only tucks the window into the tray; **the app keeps running** (log following and other capabilities are unaffected). You can bring it back or quit from the tray menu.
- Settings offers a **"Close window"** choice (default: "Minimize to tray"):
  - `Minimize to tray` — the X hides the window into the tray and the app keeps running;
  - `Exit app` — the X quits for good and the tray icon disappears with it.
- `Exit Logs` in the tray menu and `Exit app` in Settings **both quit completely** (nothing lingers in the background).
- macOS extras: after the window is tucked into the tray, clicking the **Dock icon** shows it again.

### 5.3 Update log panel

- **Silent startup check**: the app checks for updates once at startup (without blocking the first paint). When a
  new version is found **and that version has not been ignored**, the "Update log" window pops up automatically.
  The check runs asynchronously after the UI is mounted, and a failure **never disturbs** log reading;
- **Window size**: implemented from the maintainer's annotation (≈1070×750 in the default 1440×900 window) as a
  centered overlay of `min(1070px, 92vw)` × `min(750px, 88vh)`;
- **Three actions**:
  - `Download and install` — updates directly through the source chosen for this run (Windows launches the
    installer; macOS needs an app restart);
  - `Ignore this version` — suppresses the **automatic** prompt only: that version stops popping up, but a manual
    "Check for updates" **still shows it**. The record is persisted in app preferences, and **a higher version
    re-prompts**;
  - `Later` — just closes the window; the next launch prompts again;
- **Source disclosed honestly**: every check probes Gitee / GitHub concurrently and picks by reachability and
  latency; the window states which source will be used along with the probe result (reachable latency in ms, or
  unreachable), and shows a degradation notice when neither is reachable;
- **Release notes**: the window body is the release note for that version (the bilingual body composed from
  `docs/release-gui-v<version>.md` + `.en.md`, rendered as Markdown with inline HTML disabled), so you can read
  what changed **before** updating;
- **Manual entry stays**: "Check for updates" in the settings panel opens the same window — manual results are
  **always shown**, unaffected by "ignore".

---

## 6. Dual-source auto-update (Gitee / GitHub)

### 6.1 How the update source is chosen

The source is chosen by **actual probing**, never by system region/timezone (region is unreliable behind a VPN):

1. On update check, both manifest endpoints are probed concurrently and ranked by reachability + latency;
2. Probe results are cached with a TTL so startup is not slowed down;
3. If both are unreachable, the app falls back to the **last known good source**, or GitHub when there is no
   history, and clearly reports the degraded state;
4. The settings panel offers a three-state switch: **Auto / Force Gitee / Force GitHub** (default Auto).

| Source | Manifest endpoint |
|---|---|
| GitHub | `https://raw.githubusercontent.com/lanlan0811/tianshu-mcp/master/update/gui/latest.json` |
| Gitee | `https://gitee.com/lan0811/tianshu-mcp/raw/master/update/gui/latest-gitee.json` |

Typical behaviour: mainland-China networks hit **Gitee**; overseas networks (including Hong Kong and Taiwan,
China) hit **GitHub**.

### 6.2 Signatures and failure handling

- Update packages are **minisign-signed** and verified against the embedded public key;
  **a failed signature is always rejected** (the baseline against tampering on the Gitee side);
- Any failure during check / download / install **never affects log viewing**, and a "Manual download" entry is
  provided;
  - "Manual download" **follows the update source actually used**: Gitee when Gitee wins, GitHub when GitHub wins
    (unknown sources fall back to GitHub) — consistent with the "Source" shown in the panel, so **users on
    mainland-China networks are never sent back to GitHub**;
  - That entry opens in the **system default browser** (it is not an in-window navigation — Tauri's webview intercepts
    new-window requests, so the app ships an external-open capability constrained by an allow-list covering **only the
    `github.com` and `gitee.com` domains**); a failed open only surfaces an error in the UI and never blocks log viewing.
- Update channel: stable and preview builds **share a single manifest** (`update/gui/latest.json` and
  `latest-gitee.json`) and are compared by semantic version (`0.1.1-beta.1 > 0.1.0`), so the two lines
  interoperate and the upgrade path never forks. Whether a release page carries the Pre-release flag is decided by
  the tag shape (a tag containing `-beta.` / `-rc.` is a preview).

### 6.3 When no update public key is configured

If CI has no `UPDATER_PUBKEY`, the installer keeps the placeholder key and the app explicitly reports
"auto-update unavailable" in the settings panel. The installer itself still works — only auto-update is off;
manual reinstall is enough.

---

## 7. Local development and building

### 7.1 Frontend-only preview (recommended)

The frontend can be developed fully offline **without a Rust toolchain**:

```bash
cd mcp-gui
npm install
npm run dev          # Vite dev server (port 1420)
```

> **If port 1420 is already in use**: a `predev` guard (`scripts/dev-port-guard.mjs`) runs before `dev` and
> prints the current holder plus the command to free it (Windows `netstat -ano | findstr :1420` +
> `taskkill /PID <PID> /T /F`; macOS/Linux `lsof -ti :1420 | xargs kill`) instead of throwing a bare
> EADDRINUSE stack trace. The port is **pinned on purpose** — Tauri's `devUrl` is hard-wired to
> `http://localhost:1420`, and silently switching ports would leave the shell unable to connect. For
> frontend-only previews you can temporarily move it: `npm run dev -- --port 1421`.

When not running inside the desktop shell, `src/api/` automatically switches to a **mock data backend** backed by
`mcp-gui/fixtures/` (real, sanitized log samples), so filtering, search, report rendering, language and theme can
all be exercised without the backend.

Frontend gates:

```bash
cd mcp-gui
npm run typecheck    # vue-tsc --noEmit
npm run lint         # eslint . --max-warnings 0
npm run test         # vitest run
npm run check:schema # TS truth ↔ frontend mirror ↔ Rust mirror parity
```

### 7.2 Rust / Tauri work happens in CI only

Per the hard constraint in issue #25, **the development machine never runs Rust-side builds or checks**
(`cargo fmt` / `clippy` / `tauri build` all run in the `GUI` workflow). This avoids "green locally, red in CI".

CI performs, in order:

1. frontend `typecheck` / `lint` / `test`;
2. icon generation from `assets/tianshu-mcp-icon.svg` via `tauri icon` (the repo keeps only the SVG source);
3. optional public-key injection from `TIANSHU_UPDATER_PUBKEY`;
4. `cargo fmt --check` / `cargo clippy -- -D warnings` / `cargo test`;
5. `tauri build` (NSIS on Windows; dmg + `.app.tar.gz` on macOS).

Therefore:

- `mcp-gui/src-tauri/icons/` and `Cargo.lock` are **not committed** (generated by CI);
- to package locally, reuse the CI artifacts or install a Rust toolchain and run `npx tauri build`
  (not part of this project's acceptance).

**Verified status (2026-09-27)**: the `GUI` workflow now runs end to end — `schema-parity` ✅, and
`cargo fmt --check` / `clippy -- -D warnings` / `cargo test` are green on all three platforms; **all three
(`windows-x86_64` / `darwin-x86_64` / `darwin-aarch64`) succeeded**, each building and uploading its artifacts.
When no signing key is configured, the workflow automatically degrades to
`--config '{"bundle":{"createUpdaterArtifacts":false}}'`: **installers are still produced, auto-update is unavailable**
(the settings panel states this explicitly).

**Manual trigger (`Run workflow` on the Actions page)**: it **always builds** the full three-platform matrix,
regardless of what your latest commits touched — useful to run a build or verify Secrets without changing any files.
Only push and PR go through change filtering (build happens when `mcp-gui/**`, either vocabulary truth source, or
`gui.yml` itself changed), so docs-only commits do not occupy three runners.

### 7.3 Layout

```text
mcp-gui/
├── src/                  Vue 3 frontend (views / components / stores / i18n / theme)
│   ├── api/              the single data exit (Tauri invoke wrapper + swappable mock)
│   └── core/             pure logic (log parsing / event parsing / byte window / filtering / reports / sandbox / insights / stage splitting / deep-link parsing)
├── fixtures/             real, sanitized log samples for mock and unit tests
├── scripts/              parity check, pubkey injection, updater manifest generation
└── src-tauri/            Rust backend (data_home / scanner / event_stream / tail / baseline / diskscan / watcher / search / export / updater)
```

---

## 8. Security boundaries

- Business data is **read-only** end to end; the only writes are the app's own preferences (system config
  directory) and user-chosen export/update files;
- Every "relative to data home" path is guarded against escapes (absolute paths and `..` are rejected);
- Visual acceptance HTML is rendered in a sandbox iframe with an injected CSP and stripped `<script>` tags;
- **Deep links are external input**: only `tianshu://task/<id>` is accepted, and the id must pass an `[A-Za-z0-9_-]`
  whitelist before it is put into a path; anything containing `..` / `%2e` is rejected outright;
- **No extra permissions**: deep links are handled entirely in Rust and the frontend never calls the
  `@tauri-apps/plugin-deep-link` JS API, so `capabilities/default.json` **does not gain `deep-link:default`** (the
  webview receives no additional plugin capability);
- No business secrets are read or stored; log content is never sent anywhere.

---

## 9. Known limitations

- **No Apple code signing / notarization** (macOS needs a manual first-launch approval);
- **No MSI**: Windows ships NSIS only (a hard requirement of auto-update);
- **No Linux build**;
- **No task write operations** (cancel / rework / continue stay in the MCP tools); **disk usage is statistics only**
  (there is no cleanup entry of any kind);
- **No local full-text index**: search scans on demand and may be slow on very large log directories
  (it is cancellable);
- **The browser mock preview has no native runtime**, so the tray icon, tray menu, and close-to-tray
  behaviour **can only be verified in the desktop app** (the preview mode can still verify the setting
  itself and its persistence); likewise **deep links and single-instance behaviour are desktop-only** (the preview
  honestly returns an empty queue);
- **System-level deep-link registration on macOS** is reported as unsupported by the plugin, so the cold-start path is
  validated on Windows / Linux;
- macOS is only guaranteed to build in CI; no real-machine functional acceptance was performed there.