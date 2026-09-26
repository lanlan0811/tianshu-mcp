# Tianshu-mcp Logs (GUI)

Chinese version: [gui-log-viewer.md](gui-log-viewer.md)

**Tianshu-mcp Logs** is a **read-only local desktop app** that unifies the four kinds of log output produced by the Tianshu MCP server. It does **not** require the MCP server to be running — it reads the filesystem directly.

- Code location: `mcp-gui/` (standalone project, independent version, independent CI)
- Stack: Tauri 2.x (Rust backend) + Vue 3 + Vite + TypeScript
- Relation to the MCP package: a **read-only consumer**. It does not replace `query_task` / `get_task_report` (which are machine-facing contracts) and never modifies business data.

---

## 1. Installation

Artifacts are produced by CI (the `GUI` GitHub Actions workflow):

- **Normal use**: download installers from a GitHub or Gitee **pre-release** (tag like `gui-v0.1.0-beta.1`);
- **Trying it out**: download the `gui-*` workflow artifact from the corresponding Actions run.

| Platform | Installer | Auto-update payload |
|---|---|---|
| Windows | `.exe` (NSIS installer) | `.nsis.zip` produced by NSIS (**Tauri updater does not support MSI**, so no MSI is shipped) |
| macOS | `.dmg` | `.app.tar.gz` |

> **macOS builds are not code-signed or notarized by Apple**: the first launch may require manual approval under
> System Settings → Privacy & Security. This does not affect functionality or auto-update — update integrity is
> guaranteed by minisign signature verification.

---

## 2. Data home

On startup the app resolves the default data home with **exactly the same rules as the MCP server**:

1. `TIANSHU_MCP_HOME` (used when non-empty);
2. otherwise `~/.tianshu-mcp`.

From the top bar you can:

- **switch** between multiple data homes;
- **add** a directory (validation: it must contain `logs/` or `tasks/`, otherwise it is rejected with a reason);
- **remove** an added directory.

The added directories are persisted in the **system application config directory** (e.g. `%APPDATA%` on Windows,
`Application Support` on macOS) and **never written into project directories**.

---

## 3. The four log types

| Source | Path (relative to data home) | UI tab |
|---|---|---|
| Global runtime log | `logs/server.log` | "Server log" |
| Task event stream | `tasks/<taskId>/task.jsonl` | "Event stream" |
| Raw execution logs | `tasks/<taskId>/agent-<round>.log`, `verify-<round>.log` | "Agent logs" / "Verify logs" |
| Acceptance reports | `tasks/<taskId>/report-<round>.{md,json,html}`, `dry-run-report-<round>.{md,json}` | "Reports" |

### 3.1 Task list

- Sorted by last update (newest first); filter by **project / agent / status / time range**, sort by
  updated time, created time or task ID;
- Status colors: `queued/running/verify_start/fixing` are active, the rest are terminal; rounds used and latest
  report round are shown;
- Covers both `tsk_*` (dispatched tasks) and `vfy_*` (standalone path verification records).

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

---

## 4. Global search / export / copy

### 4.1 Cross-task search

- Scope is selectable: event streams / agent logs / verify logs / reports / server log;
- Results are grouped as task → file → line with snippets; clicking jumps to the exact view and position;
- **On-demand scanning, no local full-text index**; progress feedback and **cancellable**.

### 4.2 Export

- **Single file**: export the currently viewed log/report verbatim;
- **Task bundle**: zip the whole `<taskId>/` directory, optionally **excluding heavy raw logs**
  (`agent-*.log` / `verify-*.log`); the number of excluded files is reported honestly.

### 4.3 Copy

Task ID, absolute task directory, and the full current log can be copied with one click.

---

## 5. Language and theme

- **Chinese / English** switchable, Chinese by default;
- Theme: **system / light / dark**, system by default.

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
- The update channel maps one-to-one to **pre-releases**: the GUI is a beta product end to end.

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
│   └── core/             pure logic (log parsing / event parsing / byte window / filtering / reports / sandbox)
├── fixtures/             real, sanitized log samples for mock and unit tests
├── scripts/              parity check, pubkey injection, updater manifest generation
└── src-tauri/            Rust backend (data_home / scanner / event_stream / tail / watcher / search / export / updater)
```

---

## 8. Security boundaries

- Business data is **read-only** end to end; the only writes are the app's own preferences (system config
  directory) and user-chosen export/update files;
- Every "relative to data home" path is guarded against escapes (absolute paths and `..` are rejected);
- Visual acceptance HTML is rendered in a sandbox iframe with an injected CSP and stripped `<script>` tags;
- No business secrets are read or stored; log content is never sent anywhere.

---

## 9. Known limitations

- **No Apple code signing / notarization** (macOS needs a manual first-launch approval);
- **No MSI**: Windows ships NSIS only (a hard requirement of auto-update);
- **No Linux build**;
- **No task write operations** (cancel / rework / continue stay in the MCP tools);
- **No local full-text index**: search scans on demand and may be slow on very large log directories
  (it is cancellable);
- macOS is only guaranteed to build in CI; no real-machine functional acceptance was performed there.