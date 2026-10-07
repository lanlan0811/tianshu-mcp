<p align="center">
  <img src="./assets/tianshu-mcp-banner.svg" alt="Tianshu Orchestration MCP tianshu-mcp" width="100%">
</p>

<h1 align="center">Tianshu Orchestration MCP tianshu-mcp</h1>

<p align="center">
  <b>Dispatch with agents, verify with evidence. · 把开发交给 AI-Agent，把验收交给运行时</b>
</p>

<p align="center">
  <a href="https://lanaiw.top"><b>Website</b></a> ·
  <a href="https://github.com/lanlan0811/tianshu-mcp"><b>GitHub</b></a> ·
  <a href="https://gitee.com/lan0811/tianshu-mcp"><b>Gitee mirror</b></a> ·
  <a href="https://github.com/huiliyi37/Tianshu-harness"><b>Tianshu Harness</b></a> ·
  English ·
  <a href="README.md">简体中文</a>
</p>

<p align="center">
  <a href="ARCHITECTURE.en.md"><b>Architecture</b></a> ·
  <a href="docs/agent-profiles.en.md"><b>Agent profiles</b></a> ·
  <a href="docs/acceptance-config.en.md"><b>Acceptance config</b></a> ·
  <a href="docs/visual-acceptance.en.md"><b>Visual acceptance</b></a> ·
  <a href="docs/event-stream.en.md"><b>Event stream</b></a> ·
  <a href="docs/gui-log-viewer.en.md"><b>Log viewer GUI</b></a> ·
  <a href="HANDOFF.md"><b>Handoff</b></a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/actions/workflow/status/lanlan0811/tianshu-mcp/ci.yml?branch=master&style=for-the-badge&logo=github&label=CI" alt="CI">
  <img src="https://img.shields.io/npm/v/tianshu-mcp?style=for-the-badge&logo=npm&logoColor=white&label=npm&color=cb3837" alt="npm version">
  <img src="https://img.shields.io/github/stars/lanlan0811/tianshu-mcp?style=for-the-badge&logo=github&label=stars&color=24292e" alt="GitHub stars">
  <img src="https://img.shields.io/badge/License-Apache%202.0-3B5BDB?style=for-the-badge&logo=apache" alt="License">
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178c6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/node-%E2%89%A520-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node">
  <img src="https://img.shields.io/badge/MCP%20SDK-1.x-6f42c1?style=for-the-badge" alt="MCP SDK">
  <img src="https://img.shields.io/badge/Tests-1383%20Passed-green?style=for-the-badge" alt="Tests">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tianshu-mcp"><img src="https://img.shields.io/npm/d18m/tianshu-mcp?style=for-the-badge&logo=npm&logoColor=white&label=mcp%20downloads&color=cb3837" alt="MCP downloads (npm)"></a>
  <a href="https://github.com/lanlan0811/tianshu-mcp/releases?q=v&expanded=true"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Flanlan0811%2Ftianshu-mcp%2Fmaster%2Fupdate%2Fstats.json&query=%24.mcpDownloads&style=for-the-badge&logo=github&logoColor=white&label=mcp%20tarball%20downloads&color=2ea44f" alt="MCP tarball downloads (GitHub releases)"></a>
  <a href="https://github.com/lanlan0811/tianshu-mcp/releases?q=gui-v&expanded=true"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Flanlan0811%2Ftianshu-mcp%2Fmaster%2Fupdate%2Fstats.json&query=%24.guiDownloads&style=for-the-badge&logo=github&logoColor=white&label=gui%20downloads&color=1f6feb" alt="Log viewer GUI downloads (GitHub releases)"></a>
</p>

---

<p align="center">
  <img src="./assets/mcp-running.png" alt="Tianshu Harness desktop orchestrating ZCode through tianshu-mcp" width="100%">
  <br>
  Tianshu Harness desktop in action — <b>Tianshu</b> calls <b>tianshu-mcp</b> over MCP to orchestrate <b>ZCode</b> through a development task: tasks dispatched and tracked on the left, tianshu-mcp tool calls and event stream in the middle (<code>mcp__tianshu-mcp__query_task</code> polling a running task), and ZCode doing the actual work on the right
</p>

### An orchestration layer and objective acceptance gate for AI agents

> **tianshu-mcp** is an orchestration layer plugged into **Tianshu** as a standard MCP server. Tianshu is the commander and the user-facing surface; this server does three jobs: **scheduling** (queues / concurrency gate / state machine / cancellation), the **execution surface** (delivering task briefs to external AI agents), and the **objective acceptance gate** (command checks, code analysis and optional visual comparison, all relative to a git baseline).
>
> The question it answers: **an agent says it is "done" — who proves it.** Delivery therefore requires runtime evidence, a failing acceptance generates a repair plan and rework, and exhausted rounds are escalated to Tianshu for a verdict.

```
Tianshu (TUI × GUI)              ← commander / user surface / verdict
              ↓  MCP over stdio (stdout carries JSON-RPC only)
        tianshu-mcp              ← scheduling · execution surface · acceptance gate
              ↓
Codex · TraeWork · ZCode · Kimi Code · Qoder CN · Open Design · MiniMax Code
              ↓ (GUI driven over CDP; CLI via child process)
        target project workspace ← git repo + tests + .tianshu-mcp/
```

- **13 MCP tools** — `run_task / continue_task / query_task / list_tasks / get_task_report / cancel_task / verify_task / rework_task / get_profiles / wait_task / wait_any`, plus `prepare_visual_baseline / approve_visual_baseline` for visual acceptance.
- **Async contract — long tasks never block `tools/call`** — `run_task` returns a `taskId` immediately, then `wait_task` blocks until a stop point (terminal status or `needs_user`), or `query_task` polls; progress is persisted, never pushed, so the caller always sees "the last fact written to disk".
- **Wait primitives (issue #28)** — `wait_task(taskId)` / `wait_any(taskIds)` return in a single call once a task reaches a **stop point** (terminal status or `needs_user`), designed for turn-driven callers: dispatch with `run_task` and wait for the result within the same turn, no hand-rolled polling. Read-only; timeouts or interruptions never affect the task itself.
- **Objective acceptance, fail-closed** — automated command checks plus programmatic code analysis, all relative to the **git baseline captured before work started**, and the server **never auto-commits / stashes / rolls back**. A test check that exits 0 with zero executed tests, or a git project with zero net changes, fails rather than passing green.
- **Rework loop** — automatic rework (`autoFixRounds`) plus manual `rework_task`; failure reasons are parsed into **directly executable actions** and fed back to the agent, and exhausted rounds become `needs_attention` awaiting a Tianshu verdict.
- **Six GUI execution surfaces (CDP)** — each agent uses an isolated CDP flow to drive its desktop UI and reports fine-grained events at key nodes, so `query_task` can tell "the agent is working" apart from "stuck on a dialog waiting for a human".
- **Extensible** — a new agent = one profile (data) + (if needed) one adapter file, with no changes to the orchestration core.

> [!NOTE]
> This is a standard MCP **stdio server**: **stdout carries MCP JSON-RPC messages only**, while all levels of diagnostic logging (DEBUG/INFO/WARN/ERROR) go to **stderr** and are appended to `<data-dir>/logs/server.log`. Seeing `INFO` / `WARN` on stderr therefore **does not mean the server is failing**. The data directory defaults to `~/.tianshu-mcp` and can be overridden with `TIANSHU_MCP_HOME`.

## Table of contents

- [Why an orchestration layer and acceptance gate](#why-an-orchestration-layer-and-acceptance-gate)
- [Core features](#core-features)
- [Quick start](#quick-start)
- [Tool surface](#tool-surface)
- [Supported agents](#supported-agents)
- [Permissions and safety boundaries](#permissions-and-safety-boundaries)
- [Runtime contract](#runtime-contract)
- [Milestones](#milestones)
- [Log viewer GUI](#log-viewer-gui)
- [Documentation](#documentation)
- [For developers](#for-developers)
- [Security](#security)
- [Community & support](#community--support)

## Why an orchestration layer and acceptance gate

### The problem: an agent says "done" — who proves it?

Once development work is handed to an AI agent, the hard part is not whether it *can* work — it is **how to confirm the work is actually finished and actually correct**:

- **Self-reports are not evidence** — "done" is a natural-language conclusion, not proof. Without independent acceptance, a half-finished job looks identical to a real delivery.
- **The environment is a black box** — desktop agents encrypt their requests in the transport layer (e.g. TraeWork's TTNet/TDE), so requests cannot be constructed outside the client; the only viable path is to drive the UI and read the result.
- **The host tool surface is narrow** — Tianshu's MCP tools **return text only** (`content[].text` is concatenated, `isError` passed through) and are called **synchronously per call**, so long tasks must be made async and no server-side push is available.
- **Nobody picks up after a failure** — if no one feeds back "which line is wrong, what to change", the agent simply repeats the same mistake.

The shape of this project is not a free design: it was forced by a handful of **measured hard constraints**.

| # | Measured constraint | Architectural consequence |
|---|---|---|
| C1 | Tianshu's MCP tools **return text only** | Every result is "human-readable text + a `---tianshu-mcp-meta---` JSON block", easy for the host to extract with a regex |
| C2 | Tianshu calls `tools/call` **synchronously per call** | Long tasks are async: `run_task` returns a `taskId`, `query_task` polls |
| C3 | Desktop agents encrypt requests in the transport layer | The only path is **driving the desktop UI over CDP**, reading results from the DOM |
| C4 | The Codex desktop app is an **MSIX store package** and cannot be `CreateProcess`-ed | It must be COM-activated with an injected `--user-data-dir` before a CDP port can be opened |

### The answer: separate "who does the work" from "how we judge the work"

- **Scheduling** enforces discipline — per-project serial queue plus a global concurrency gate (default 2), an explicit state machine, and defined timeout / cancellation semantics.
- **The execution surface** handles delivery — one `AgentAdapter` contract: GUI agents are driven over CDP, CLI agents run as child processes; adding an agent is usually just a profile.
- **The acceptance gate** produces evidence — command checks, code analysis and optional visual comparison relative to the pre-work git baseline, with fail-closed guards against false green; reports come as human-readable `.md` and machine-readable `.json`.
- **The rework loop** drives convergence — failed rounds turn reasons into executable actions fed back to the same agent; exhausted rounds escalate to a human verdict.

> Two boundaries are hard: **an agent's "done" is not an acceptance conclusion** (only `verdict.passed` counts), and **environment / auth errors never enter acceptance or rework** (`hardFailure` fails terminally, so infrastructure problems are not mistaken for code problems and burn rework rounds).

## Core features

- **Async dispatch and waiting** — `run_task` returns a `taskId` immediately; `wait_task` blocks until a task reaches a stop point (terminal status or `needs_user`) and `wait_any` waits for the first of a group; use `query_task` for progress detail — status / progress / log tail / recent fine-grained events (`eventLimit`, 1..50, default 10). See [wait primitives](docs/wait-task.en.md).
- **Objective acceptance engine** — automated command checks (typecheck/lint/test/build, skipped when absent, plus tech-stack derivation) plus programmatic code analysis (changed-file list / diffstat / suspicious signals such as TODO, debugger, secret-like patterns), all relative to the **git baseline**; command checks run **bounded-parallel** by default (`verifyConcurrency`, default 2, range 1–4; `1` makes them fully serial).
- **Three fail-closed guards** — a test check fails when its output reports zero executed tests even if the exit code is 0; git projects must produce changes relative to the baseline by default (pure analysis tasks opt out with `"requireChanges": false` in `.tianshu-mcp/acceptance.json`); a round cancelled at any point yields `passed=false`.
- **Three-level acceptance config inheritance** (issue #20) — `<data-dir>/acceptance.default.json` (global fallback) → `<project>/.tianshu-mcp/acceptance.json` (project override) → the `acceptanceOverride` argument (transient task override, never written to disk). Inspect the effective configuration with `tianshu-mcp config acceptance <projectPath> [--task <id>]`. See the [acceptance config spec](docs/acceptance-config.en.md).
- **Structured repair directives** (issue #19) — failed rounds parse reasons into **directly executable actions** (`file:line / issue / action`) carried in both the repair plan and the rework message; when extraction is unavailable it **explicitly falls back** to the full report rather than leaving a silent gap. `rework_task` also accepts an optional `repairHint`. See [structured repair directives](docs/repair-directives.en.md).
- **Dry-run mode** (issue #21) — `run_task(dryRun=true)` makes the agent **analyse and plan only, outputting the file list and approach without touching source**; acceptance does static analysis only (do referenced files exist, do proposed edit locations exist, any obvious logical conflicts) and skips typecheck/test/build; a bad plan yields `needs_attention` (a human decision), never enters automatic rework, and **consumes no acceptance round**. See [dryRun mode](docs/dry-run.en.md).
- **Idempotent retries** (issue #15) — `run_task` / `verify_task` accept an optional `idempotencyKey`: a retry with the same key within the TTL (24 h default) **never duplicates a dispatch** (the original `taskId` is always returned) or **re-runs verification**; the same key with different arguments fails closed. The mapping is persisted in `<data-dir>/idempotency.json` and survives a server restart. See the [v0.5.10 release notes](<docs/release-v0.5.10.en.md>).
- **Project-less dispatch** (ZCode only, issue #12) — `run_task`'s `projectPath` may be omitted: the task runs in ZCode's `default` workspace without registering/importing a project, collecting a Git baseline, or running project acceptance (marked structurally as `verificationNotApplicable: "no_project"`). The companion `allowCreateProject: false` stops dispatch before any import side effect when the target directory is unregistered. See the [ZCode CDP adapter](docs/zcode-cdp.en.md).
- **Fine-grained event stream** (issue #18) — adapters report semantic events at key nodes (`task_dispatched` / `confirmation_dialog_detected` / `awaiting_user_authorization` / `file_modification_started` / `rework_triggered`), and `query_task` returns the most recent N via `eventLimit`. Event reporting is **optional**: adapters that do not implement it behave unchanged. See the [event stream](docs/event-stream.en.md).
- **Terminal-state webhook** (issue #22) — an optional `notifications.webhook` (global `config.json`): on completion, failure or entry into `needs_attention`, an **asynchronous POST** of a JSON body (with `taskId` / `event` / `status` / timestamp / report paths) is sent to the configured URL, with optional HMAC-SHA256 signing. **Off by default**, and a failed send only logs — it **never affects the state machine**. See [task notifications](docs/notifications.en.md).
- **Visual acceptance (optional module, since v0.5.0)** — page screenshot comparison, static image spec validation, two-phase baseline approval and rule freezing; a missing baseline can never pass, and automatic rework may not call the approval entry. An **optional AI content validation** (v0.5.4, off by default) delegates judgement entirely to **a local command you supply** — the MCP reads, stores and forwards no keys and ships no model client — and it only **warns** by default. See [visual acceptance](docs/visual-acceptance.en.md).
- **Skill self-install** (issue #16) — on startup the **in-package** `skills/tianshu-mcp/` is synced idempotently to `~/.rivet/skills/tianshu-mcp/`; it auto-upgrades **only a provably untouched copy**, and **detected local edits or an unknown source are always kept with a warning**. See the [runtime contract](#runtime-contract).
- **Second delivery surface: the log viewer GUI** — `mcp-gui/` ships a **local read-only** desktop app that unifies the four log types and task artifacts in one interface (Tauri 2.x + Vue 3, with its own version and tag, not released with the MCP main package); see the [log viewer GUI](#log-viewer-gui).
- **No key handling** — each agent uses its own login state; this server never stores or forwards any API key (see [SECURITY.en.md](SECURITY.en.md)).
- **Want the internals?** — see [ARCHITECTURE.en.md](ARCHITECTURE.en.md) (layering, module boundaries, state machine, acceptance pipeline, extension points, known gaps).

## Quick start

### Prerequisites

| Item | Requirement |
|---|---|
| Node.js | ≥ 20 (CI covers 20 / 22 / 24) |
| Package manager | npm (the repo ships a `package-lock.json`) |
| OS | Windows / macOS / Linux (validated by the CI three-platform matrix) |
| Git | Optional; baseline analysis is richer inside a git repository |

The data directory defaults to `~/.tianshu-mcp` and can be overridden with `TIANSHU_MCP_HOME`; it is created automatically on first start.

### Build from source

```bash
git clone https://github.com/lanlan0811/tianshu-mcp.git
cd tianshu-mcp
npm ci
npm run build        # sync-version + tsc → dist/
npm test             # 1383 passed / 12 skipped (1395 total, 115 test files)
```

### Install from npm

```bash
npx -y tianshu-mcp            # run without installing
# or
npm install -g tianshu-mcp
```

### Add it to Tianshu (recommended)

In Tianshu, go to **Settings → MCP servers → Add** and fill in the fields below (transport: `stdio (local process)`):

| Field | npm distribution (recommended) | Local development |
|---|---|---|
| Server ID | `tianshu-mcp` | `tianshu-mcp` |
| Transport | `stdio (local process)` | `stdio (local process)` |
| Command | `npx` | `node` |
| Arguments (space-separated) | `-y tianshu-mcp` | `<absolute-repo-path>/dist/index.js` |

> - The server ID is the tool prefix: with `tianshu-mcp` the tools are `mcp__tianshu-mcp__run_task` and the other 12.
> - Arguments are space-separated with **no quotes**; in local development replace `<absolute-repo-path>` with a real absolute path.
> - The UI has no environment-variable field; to override the data directory, use the `config.json` route below to set `TIANSHU_MCP_HOME`.
> - Once the connection succeeds you are done; a new session shows all 13 tools.

### Or edit config.json (environment variables supported)

```jsonc
{
  "mcp": {
    "servers": {
      "tianshu-mcp": {
        "command": "node",
        "args": ["<absolute-repo-path>/dist/index.js"],
        "env": { "TIANSHU_MCP_HOME": "<absolute-repo-path>/.tianshu-mcp" }
      }
    }
  }
}
```

After opening a new session the tool surface exposes `mcp__tianshu-mcp__run_task` and the other 12 tools. One typical loop:

```text
run_task(projectPath=D:/xxx/my-app, task="…task brief…", agentId=codex,
         model="GPT-5.6 Sol", reasoningLevel="high", autoVerify=true, autoFixRounds=5)
  → taskId → wait_task(taskId) blocks until a stop point → succeeded / failed / needs_attention → read get_task_report
  (turn-driven callers: one wait_task call returns at the stop point; after a timeout call it again to keep waiting, or use query_task for progress detail)
```

### Prompts to give Tianshu (recommended usage)

> "In project `D:\xxx`, use codex to implement 『task』. First run `run_task(autoVerify:true, autoFixRounds:2)`, then `wait_task` until it reaches a stop point; if the report shows `needs_attention`, pass the failure summary from `get_task_report` as `feedback` to `rework_task` for another round; when everything passes, report `changedFiles` and `diffstat` back to me."

> "In project `D:\xxx`, use traework with `mode=Code` to implement 『task』; it switches to Code mode, binds the project, sends the task, verifies automatically, and on failure generates a repair plan and reworks."

## Tool surface

13 tools, split into three capability families: `read` (read/query, no side effects), `write` (side effects, all requiring approval), and `execute` (runs project-side commands without changing source; currently only `verify_task`, still approval-free).

| Tool | Capability / approval | Purpose |
|---|---|---|
| `run_task` | write + approval | Dispatch work (optionally with auto-verify / auto-rework), returning a `taskId` asynchronously; optional `idempotencyKey`, `acceptanceOverride` and `dryRun` |
| `continue_task` | write + approval | Resume a `needs_user` session (ZCode / Codex / Kimi Code / Qoder CN / MiniMax Code each have their own resume semantics) |
| `query_task` | read | Poll status / progress / log tail / recent fine-grained events (optional `eventLimit`) |
| `list_tasks` | read | Filtered list of historical tasks |
| `get_task_report` | read | Full text of one round's acceptance report (`report.md`) |
| `cancel_task` | write + approval | Cancel a running task: CLI agents kill the process tree; GUI agents best-effort click stop over CDP and wait boundedly within `gui.cancelWaitMs` (default 15s); for a terminal GUI task it doubles as the manual confirmation entry |
| `verify_task` | execute (no source changes, approval-free) | Run acceptance once against a task or a project path. It runs configured commands and may produce build artifacts, so its MCP `readOnlyHint` is `false` — but it **changes no source and still needs no approval**; optional `idempotencyKey` |
| `wait_task` | read | Block until one task reaches a stop point (terminal status or `needs_user`) or the timeout elapses; `timeoutMs` defaults to 50000, caps at 600000 — call again after a timeout to keep waiting. Read-only, harmless |
| `wait_any` | read | Block until the first of a group (1..20) reaches a stop point, in array order; returns that task's snapshot plus the current status of every task. Validates all ids exist, failing if any is missing |
| `rework_task` | write + approval | Manual rework (feeds the failure report back to the same agent); optional `repairHint` (≤4000 chars) |
| `get_profiles` | read | Show agent adapters and executable discovery results |
| `prepare_visual_baseline` | write + approval | Capture or import a reference image and produce a candidate and summary for review |
| `approve_visual_baseline` | write + approval | After review, validate the summary and write the baseline and approval record |

> Results are uniformly "human-readable text + a `---tianshu-mcp-meta---` JSON block", easy for the host to extract with a regex.
>
> **Path safety gate** (since v0.4.0): `projectPath` is validated on submit — it must be absolute, the directory must exist, and symlinks are realpath-normalised; the home directory itself and system/root directories are rejected outright, preventing a worker's write permission from covering an entire system subtree; a git repository with uncommitted changes gets a co-residence warning in the receipt.

## Supported agents

`driver: "gui"` selects an explicit adapter that drives the desktop UI (each with an isolated CDP flow); `driver: "spawn"` runs an external CLI child process.

| agentId | driver / adapter | status | Notes |
|---|---|---|---|
| `codex` | `gui` / `codex-gui` | **ready** (`research` on macOS) | Codex desktop GUI (Windows: MSIX COM activation + CDP; macOS: spawn .app + CDP); supports `model` / `reasoningLevel` / `planDoc` / `designSystem`; user-confirmation wait, cancellation and re-dispatch guards are all machine-verified |
| `zcode` | `gui` / `zcode-gui` | **ready** (closed-loop verified on real Windows; macOS unverified) | CDP GUI adapter; supports project-less dispatch, `allowCreateProject` and `reasoningLevel` (the tier set **varies per model**; out-of-range tiers fail **before sending**); **v0.7.4 adapted to the missing 3.14.x path contracts** (the binding verdict became "path first, display-name when no path is available + global name disambiguation", failing closed on duplicates); **v0.7.6 fixes the binding deadlock** (sidebar `workspace-item-*` nodes scrolled out of view were still collected, short-circuiting the only trustworthy menu channel), **adds a recovery entry point for runtime CDP disconnects** (reconnect once for observation, never resend; a failed reconnect lands on `needs_user(setup_recovery)`) and **fixes the two-level model menu** (provider groups render their submenu only on hover); **v0.8.0 keeps the original session permission on resume rounds** (issue #30: `continue_task` / `rework_task` are no longer silently overwritten by the profile default) |
| `traework` | `gui` / `traework-gui` | **ready** | CDP-driven TRAE SOLO CN desktop UI; supports `mode` (Work / Code / Design, each of the three modes maintaining its own project binding); all three modes machine-verified; **v0.8.0 removes the cross-mode project-binding fallback** (issue #35: a failed non-Work bind no longer falls back to Work and silently rewrites the target mode — it now fails honestly) |
| `kimicode` | `gui` / `kimicode-gui` | **ready** (`research` on macOS) | Kimi Code desktop (Electron); **dual renderer processes** (main window plus a `Kimi Browser Overlay` that hosts the model / reasoning / mode menus); workspaces bind by full path; supports `model` / `reasoningLevel`, **not `mode`**, and **not project-less dispatch** |
| `qoder` | `gui` / `qoder-gui` | closed-loop verified on Windows; **research** on macOS | Qoder CN only; requires an existing `projectPath` and a readable `planDoc`; `modelSource=default\|custom` disambiguates same-named models, and the reasoning level is saved as a global preference via "Model management" and read back |
| `opendesign` | `gui` / `opendesign-gui` | **ready** (`research` on macOS) | Open Design desktop GUI; selectors are taken from the product's own web-frontend `data-testid` hooks, the full 12-step execution chain is wired, and the acceptance → auto-rework → re-acceptance loop is connected; it is the only driver with an "artifact signal" (file mtime / size fingerprint) |
| `minimax` | `gui` / `minimax-gui` | **ready** (`research` on macOS) | MiniMax Code desktop (Electron); **dual renderer processes** (main window plus a `Model menu` popup); the reasoning level / context window live in a **second-level submenu that only appears on hovering a model row**, and their **candidate sets vary per model** (requesting them on a submenu-less model is fail-closed); supports `model` / `reasoningLevel` / **`contextWindow`** (this adapter only), **not `mode`**, and **not project-less dispatch**; "New project" takes **two steps: in-app modal → native `Select Directory` → modal submit** |
| `stub` | `spawn` | tests only | `test/stub-agent/stub-agent.mjs` with three scripts (good / fix-on-first / never) |

> `mode` supports `Work` / `Code` / `Design` (TraeWork only) and is inferred from the task text when omitted. Kimi Code's `reasoningLevel` is validated against the **set of levels actually rendered by the UI** (official models `low` / `high` / `max`; unofficial models only `on` / `off`). MiniMax Code's `reasoningLevel` / `contextWindow` are likewise validated against the **actual UI candidates** (e.g. `M3.1-Flash-Preview` offers `default`/`low`/`medium`/`high`/`xhigh`/`max` plus `512K`/`1M`, while `M3` has no level group and `deepseek-v4.1-flash` has no window group); an out-of-range or unreadable value is fail-closed. Adding an agent is usually just a profile — see [docs/agent-profiles.en.md](docs/agent-profiles.en.md) and [CONTRIBUTING.en.md](CONTRIBUTING.en.md).

### macOS headless path: codex-cli (user profile)

The built-in `codex` drives the desktop GUI; if you would rather not depend on GUI automation, **codex CLI headless mode works on macOS throughout** — no server code change is needed, just add a `driver=spawn` user profile to the data directory:

```json
{
  "profiles": {
    "codex-cli": {
      "displayName": "Codex CLI (OpenAI headless)",
      "type": "cli",
      "driver": "spawn",
      "status": "ready",
      "command": null,
      "argsTemplate": ["exec", "<prompt:arg>", "--skip-git-repo-check", "--sandbox", "workspace-write"],
      "promptMode": "arg",
      "cwd": "task",
      "env": {},
      "timeoutMs": 1800000,
      "killTree": "taskkill",
      "authNote": "Reuses ~/.codex login; do not combine with --approve-for-me (mutually exclusive in practice)",
      "executableDiscovery": {
        "dirs": ["/opt/homebrew/bin", "/usr/local/bin"],
        "fileNames": ["codex"],
        "fallbackCommand": "codex"
      }
    }
  }
}
```

- Prerequisites: `npm i -g @openai/codex` (⚠️ **keep it current** — the signing certificate of ≤0.130.0 has been revoked and macOS Gatekeeper kills it outright with `Killed: 9`) and a completed `codex login`.
- Usage matches built-in agents: `run_task(projectPath=/path/to/project, agentId=codex-cli, task="brief", autoVerify=true, autoFixRounds=2)`.
- `model` has no effect on spawn agents — the CLI uses the default in `~/.codex/config.toml`; to pin a model, append `"-m", "<model>"` to `argsTemplate`.

## Permissions and safety boundaries

### Three capability families

| Capability | Meaning | Approval | Tools |
|---|---|---|---|
| `read` | read/query only, no side effects | none | `query_task` / `list_tasks` / `get_task_report` / `get_profiles` / `wait_task` / `wait_any` |
| `write` | has side effects | required | `run_task` / `continue_task` / `cancel_task` / `rework_task` / the two visual baseline tools |
| `execute` | runs project-side commands, changes no source | none | `verify_task` |

> `readOnlyHint` is derived from `capability === "read"`, so `verify_task`'s annotation is **false**; it is **not an approval signal** — approval is carried separately by `_meta.requireApproval`.

### Hard red lines

1. **Never blind-kill a GUI instance by process tree** — only PIDs created by this module and verified by command line are terminated.
2. **Reuse the user's instance by default** — never start a second one; managed instances never touch an instance the user opened manually.
3. **computer-use allowlist** — only the TraeWork folder-selection dialog (window title + host process double-checked).
4. **Zero credential handling** — no agent credential is read, decrypted or forwarded; GUI adapters only drive the UI.
5. **Commands never build a shell** — acceptance commands are structured argv with `shell:false`.
6. **No automatic commit / stash / rollback** — a git baseline is captured before work starts and reports are computed relative to it.
7. **No hard-coded paths** — machine paths, usernames and ports come from profiles or placeholders.
8. **stdout carries JSON-RPC only** — all diagnostic logging goes to stderr (and, from the same source, to `logs/server.log`).
9. **Skill content comes only from the package itself** — skills to install are located relative to the package via `import.meta.url`, **never discovered from `process.cwd()`**.

## Runtime contract

### stdio and logging

This server strictly follows the MCP stdio transport contract: **stdout carries JSON-RPC messages only**, and all diagnostic logging goes to **stderr** and is appended to `<data-dir>/logs/server.log` (UTF-8, ISO timestamps, level tags). When debugging connection problems, trust `server.log`; **do not conclude the server is broken just because stderr has output**. Only a startup failure (`tianshu-mcp startup failed:`) is fatal, and it exits with a non-zero code.

### Data directory

```text
<data-dir>/                       defaults to ~/.tianshu-mcp (override with TIANSHU_MCP_HOME)
├── config.json                  server config (concurrency, timeouts, skills, notifications)
├── agent-profiles.json          user-defined / overridden agent profiles
├── projects.json                project registry (including per-project acceptance config)
├── idempotency.json             idempotency key mapping (TTL + capacity trimming)
├── logs/server.log              all-level diagnostic log (same source as stderr)
└── tasks/<taskId>/              per-task isolated directory (event stream / reports / logs / visual evidence)
```

### Skill self-install

On startup the **in-package** `skills/tianshu-mcp/` is synced idempotently to `~/.rivet/skills/tianshu-mcp/` so the host can read the orchestration skill in a new session. Three points:

- **Skill content comes only from the package itself** — the source directory is located relative to the package via `import.meta.url` (both dev runs and dist runs point at the in-package `skills/`), **never** discovered from the current working directory. When the source is missing, installation is skipped with a warning.
- **No silent overwrite when content differs** — the target holds a manifest at `<target>/.tianshu-mcp-install.json` (version + content hash), so it auto-upgrades **only a provably untouched copy**; **detected local edits or an unknown source keep your version with a warning**.
- **Overwrites are atomic** — install into `.incoming-*`, back up the old directory to `.bak-<timestamp>`, then swap in; a failure rolls back with no half-finished state.

```jsonc
// <data-dir>/config.json
{
  "skills": {
    "autoInstall": true,   // true (default) | "prompt" | false
    "backupKeep": 3        // historical backups kept after an overwrite; 0 = never clean up
  }
}
```

Allowing and disabling (a CLI flag or its equivalent environment variable; `--no-skill-install` / `autoInstall:false` always wins):

- `--approve-skill-update` (or `TIANSHU_MCP_APPROVE_SKILL_UPDATE=1`): this startup may overwrite a skill directory that "needs a change" with the in-package version (after backing it up). **It has no effect on a directory confirmed to contain local edits.**
- `--no-skill-install` (or `TIANSHU_MCP_NO_SKILL_INSTALL=1`): no skill installation or check at all during this startup.

## Milestones

| Phase | Version | Delivery summary |
|---|---|---|
| Orchestration skeleton | 0.1.x | 8 tools, state machine / queue / concurrency gate / cancellation (kill tree), acceptance engine, automatic rework; TraeWork CDP driver and mode switching |
| ZCode GUI | 0.2.0 | ZCode unified closed loop (development → controlled failure → same-session rework → `continue_task`) |
| Codex desktop | 0.3.x | Codex MSIX COM activation + CDP (**breaking**: `codex` moved from headless to GUI); user-wait detection, cancel that actually stops the GUI, acceptance engine fail-closed |
| macOS and gates | 0.4.x | macOS dual drivers (spawn .app + CDP), `projectPath` safety gate, bounded-parallel acceptance commands (test suite 267s → 51s) |
| Visual and idempotency | 0.5.x | Visual acceptance (0.5.0) + optional AI content validation (0.5.4), ZCode project-less dispatch, Kimi Code / Qoder CN adapters, idempotency keys (0.5.10) |
| Hardening and observability | 0.6.x | Skill self-install hardening (0.6.0), GUI selector drift fixes (0.6.2), fine-grained event stream, structured repair directives, dryRun, three-level acceptance config inheritance, terminal-state webhook |
| Open Design | 0.7.x | Open Design desktop adapter (0.7.1), ZCode 3.14.x binding-contract fix (0.7.4) |
| MiniMax Code | 0.7.8 | Seventh GUI agent (0.7.8); real-machine evidence corrected three structural assumptions (second-level submenu / per-model candidate sets / two-step project creation), plus the `contextWindow` parameter and a read-only diagnostic probe |
| Resume-semantics fixes | 0.8.0 | TraeWork: removed the cross-mode project-binding fallback (#35 — structurally unreachable and it silently rewrote the target mode); ZCode: resume rounds keep the original session permission (#30 — the unconditional pre-dispatch overwrite is gone) |
| Completion-verdict hardening | 0.8.1 | Four drivers (ZCode / Kimi Code / MiniMax Code / Open Design) gained the "a run signal was observed" gate (#31 — a running task is no longer misjudged as successful when selectors drift); `fix-loop` now really parks these drivers' abnormal ends as `needs_attention` instead of letting them into the acceptance chain |
| Codex model readback | 0.8.2 | Model-trigger readback now reads structure (#34 — on real hardware the button's `innerText` carries the whole reasoning-effort strip: 9 carousel layers with only the current one at `opacity:1` and the rest `display:block`; the old code took the entire string as the model name → `model_mismatch` after three rounds, blocking every Codex dispatch that specified `model`). Three-tier fallback (authoritative attributes → structural nodes → innerText), with the `matches()` predicate untouched |
| Log viewer GUI | `gui-v*` (separate line) | `mcp-gui/` local read-only log viewer (Tauri 2.x + Vue 3), independent version and tag, **not released with the MCP main package** |

> The complete per-version record is in [CHANGELOG.en.md](CHANGELOG.en.md); handoff status and the troubleshooting handbook are in [HANDOFF.md](HANDOFF.md); engineering-metric definitions are in [ARCHITECTURE.en.md](ARCHITECTURE.en.md).

## Log viewer GUI

`mcp-gui/` is this repository's **second delivery surface** (issue #25): a **local read-only** desktop app (Tauri 2.x + Vue 3 + Vite + TypeScript) that unifies the logs MCP writes to disk and the task artifacts in one interface. Its only relationship with the MCP server is that it **shares the same set of on-disk facts and creates no second source of truth**:

- **It does not need the server to be running** — it reads the filesystem directly, resolving the data directory by **exactly the same rules** as the server (`TIANSHU_MCP_HOME` → `~/.tianshu-mcp`), and can switch between, add, or remove multiple data directories.
- **A read-only consumer** — it never modifies any business data (its only writes are its own preferences, stored in the system application config directory), and it does not replace the machine-facing `query_task` / `get_task_report`.
- **Four log types and artifacts** — the global run log, the task event stream, raw execution logs and acceptance reports; the visual offline HTML is rendered inside a **sandbox iframe** (scripts disabled, external resources blocked).

| Source | Path (relative to the data directory) | Where in the UI |
|---|---|---|
| Global run log | `logs/server.log` | Workspace · run log |
| Task event stream | `tasks/<taskId>/task.jsonl` | Workspace · event stream |
| Raw execution logs | `tasks/<taskId>/agent-<round>.log`, `verify-<round>.log` | Workspace · agent log / verify log |
| Acceptance reports | `tasks/<taskId>/report-<round>.{md,json,html}`, `dry-run-report-<round>.{md,json}` | Workspace · acceptance reports |

Key capabilities:

- **Large logs and live tail** — the first paint reads only a 64 KiB tail window, loading earlier blocks on demand with a "loaded N / M" indicator; appended content refreshes incrementally, **scrolling up pauses following automatically**, and one click jumps back to the latest.
- **Insights (scoreboard / attribution / trend)** — read-only aggregation: a **scoreboard** by agent and by project (tasks / success rate / avg rounds / one-pass rate / avg verify time / missing reports), Top lists for four kinds of **failure attribution** (error type / failed check / blocking issue / code signal), and **trends by day or by week** for volume plus success and rework rates (plain inline SVG, no chart library). The conventions are stated on the page (UTC dates, Monday week start, "one pass" = succeeded in exactly 1 round, only each task's **latest** report round) and it is **read-only with no delete / cleanup**.
- **Structured filters / multi-task compare / command palette** — the overview filter gains **error type / dry run / reworked / visual acceptance** (semantics map one-to-one onto task-snapshot fields, identical in the backend and the frontend); the insights page gains a "**Compare tasks**" section that puts **2–4** tasks side by side across status / rounds / verify time / changed lines / latest verdict and more (reports are **read on demand** and cached, anything missing shows `—` and is **never invented**); `Ctrl/Cmd + K` opens the **command palette** (subsequence fuzzy matching; jump to pages, switch data home, open a task) and `Ctrl/Cmd + R` refreshes — **all read-only interactions**.
- **Baseline review / stage gantt / disk usage / deep links** — the workspace gains a **"Baseline"** section (the pre-work `baseline.json` summary next to the latest report's actual changes, with an honest notice when absent); the event stream gains a **"Stages" view** (a state-transition gantt that reads one full pass on demand, marking the last stage "running" rather than inventing a duration); the insights page gains **"Disk usage"** (totals / `logs/` share / top-20 task sizes, plus **hint-only, never-delete** relative cleanup rules); and **`tianshu://task/<taskId>` deep links** are supported (cold and hot start, single instance revealing the existing window, handled in Rust so the webview gets no extra permission).
- **Cross-task search / export** — scanned on demand (**no local full-text index**) with progress and cancellation, results grouped by "task → file → line" and clickable; single-file export and whole-task zip export (optionally excluding the bulky raw logs).
- **Reports and multi-round comparison** — `.md` rendering, `.json` structured cards and a sandboxed `.html` visual preview; `dry-run-report-*` and `report-*` are shown **separately** (static analysis vs real command acceptance, which have different verdict semantics), and multiple rounds can be compared side by side.
- **Interface and theme** — bilingual (Chinese / English) with **follow-system / light / dark** themes; a self-built "Obsidian Terminal" design system with **zero UI libraries, zero external links and zero font files**, and all icons as inline SVG.
- **System tray and close behaviour** — a resident tray ("Show log viewer" / "Quit log viewer", with labels following the UI language immediately); by default **closing the window minimizes to tray**, switchable to "quit the app" in settings.
- **Update-notes window and dual-source auto-update** — a silent update check at startup pops the "update notes" window when a new version is found (download and install / ignore this version / later), whose body is that version's bilingual release notes, **taken from the very same source as the release page** (a missing body refuses to publish — never an empty body or a one-line title); the update source is chosen by **concurrently probing Gitee / GitHub and picking the better one** (never relying on system region) and is shown truthfully, and every package is **minisign-verified** — **a failed signature is never installed**.

<p align="center">
  <a href="./assets/tianshu-mcp-gui-overview.png"><img src="./assets/tianshu-mcp-gui-overview.png" alt="Log viewer · task overview page" width="32%"></a>
  <a href="./assets/tianshu-mcp-gui-event-stream.png"><img src="./assets/tianshu-mcp-gui-event-stream.png" alt="Log viewer · task event stream workspace" width="32%"></a>
  <a href="./assets/tianshu-mcp-gui-agent-log.png"><img src="./assets/tianshu-mcp-gui-agent-log.png" alt="Log viewer · agent raw log workspace" width="32%"></a>
  <br>
  <b>Task overview page</b> — resident left rail · five-cell metrics (total / running / finished / succeeded / failed) · status chips · task card grid
  <br>
  <b>Full-screen workspace · event stream</b> — line / time / event / detail columns, with status transitions and progress records colour-coded
  <br>
  <b>Full-screen workspace · agent log</b> — level filtering · line numbers and word wrap · "loaded N / M" with "jump to latest"
</p>

Decoupling and release boundaries (read before changing anything here):

| Boundary | Convention |
|---|---|
| Data | The GUI **reads** business directories only; its only writes are its own preferences and the export / update files the user explicitly chooses |
| Code | `mcp-gui/` has its own `package.json` / `tsconfig` / eslint / vitest and **does not take part in the root project's gates** |
| Packaging | The root `package.json` `files` allowlist excludes `mcp-gui`, so it is **not shipped in the MCP main package's npm artifact** |
| Release | The GUI has its own version and its own tag (`gui-v*`) and is **not released with the MCP main package** (`release.yml` only matches `v*`) |
| Build | Rust-side builds and checks are **never run locally** (`cargo fmt` / `clippy` / `tauri build` all live in the `GUI` workflow); locally only the frontend preview and frontend gates run |

> **Schema parity across the two copies**: the event classification exists as a mirror on the Rust side and in the frontend, while the source of truth always remains `src/tasks/task.ts` and `src/agents/agent-events.ts`; `mcp-gui/scripts/check-schema-parity.mjs` compares all three sets in CI and **fails on any mismatch**. Usage and development notes are in the [log viewer docs](docs/gui-log-viewer.en.md); the real-machine record is in the [issue #25 record](docs/issue-25-gui-real-machine-record.md).

## Documentation

**Usage and integration**

| Document | Contents |
|---|---|
| [ARCHITECTURE.en.md](<ARCHITECTURE.en.md>) | Architecture: layering and module boundaries, state machine, acceptance pipeline, driver-layer contracts, extension points, known gaps |
| [docs/core-principles.en.md](<docs/core-principles.en.md>) | Core principles: how four hard constraints forced the current architecture, the core mechanisms one by one, and why they are self-consistent |
| [docs/tianshu-integration.en.md](docs/tianshu-integration.en.md) | The two Tianshu `config.json` integration modes, UI / API steps, smoke procedure, FAQ |
| [docs/agent-profiles.en.md](docs/agent-profiles.en.md) | Agent profile field reference plus real-machine samples |
| [docs/adapter-matrix.en.md](docs/adapter-matrix.en.md) | Capability research matrix for each agent |
| [docs/npm-publish-guide.md](docs/npm-publish-guide.md) | npm publish steps and credentials (Chinese) |
| [skills/tianshu-mcp/SKILL.md](skills/tianshu-mcp/SKILL.md) | The skill that teaches Tianshu to orchestrate this MCP (with examples) |

**Agent adapters (CDP-driven)**

| Document | Contents |
|---|---|
| [docs/codex-gui-cdp.en.md](docs/codex-gui-cdp.en.md) | Codex desktop: MSIX COM activation, CDP takeover, selectors, liveness, acceptance and rework |
| [docs/traework-cdp.en.md](docs/traework-cdp.en.md) | TraeWork: principles, configuration, mode switching, selectors, safety red lines, pitfalls |
| [docs/zcode-cdp.en.md](docs/zcode-cdp.en.md) | ZCode: install discovery, exact project / model, full access, pause-resume, project-less dispatch and both-platform status |
| [docs/kimi-cdp.en.md](docs/kimi-cdp.en.md) | Kimi Code: dual renderer processes, workspace full-path binding and native import, three-level model selection and reasoning levels |
| [docs/qoder-cdp.en.md](docs/qoder-cdp.en.md) | Qoder CN: install discovery and instance reuse, native workspace import, `modelSource` and global reasoning level, same-session rework |
| [docs/opendesign-cdp.en.md](docs/opendesign-cdp.en.md) | Open Design: data-directory derivation, sidecar root-process detection, selector evidence table and the 12-step chain, dual-path transport, failure codes |
| docs/minimax-cdp.en.md | MiniMax Code: dual renderer processes, the model second-level submenu (reasoning level / context window) with per-model candidates, full-path project binding, the native `Select Directory` dialog |

**Acceptance and observability**

| Document | Contents |
|---|---|
| [docs/acceptance-config.en.md](docs/acceptance-config.en.md) | Project-level and three-level inheritance acceptance config spec |
| [docs/repair-directives.en.md](docs/repair-directives.en.md) | Structured repair directives: sources, fallback semantics, known limits |
| [docs/dry-run.en.md](docs/dry-run.en.md) | dryRun mode: read-only constraint, zero-change gate, plan document |
| [docs/event-stream.en.md](docs/event-stream.en.md) | Fine-grained event stream: vocabulary, persistence, bounded read-side window |
| docs/notifications.en.md | Task terminal-state notifications: webhook contract, de-duplication, signing |
| docs/wait-task.en.md | Wait primitives: `wait_task` / `wait_any` contract, stop-point definition, timeout matrix and loop patterns |
| [docs/visual-acceptance.en.md](docs/visual-acceptance.en.md) | Visual acceptance primer and full configuration (including optional AI content validation) |
| [docs/visual-validation.en.md](docs/visual-validation.en.md) | Visual acceptance validation progress and platform evidence |
| [docs/visual-validation-evidence/](docs/visual-validation-evidence/) | Raw machine-readable records behind that validation |
| [docs/gui-log-viewer.en.md](docs/gui-log-viewer.en.md) | Log viewer GUI (`mcp-gui/`): four log types and task artifacts, dual-source auto-update, dev and CI boundaries |

**Real-machine acceptance records** (mostly Chinese-only)

| Document | Contents |
|---|---|
| [docs/m2-smoke-record.md](docs/m2-smoke-record.md) · [docs/m2-rework-record.md](docs/m2-rework-record.md) | M2 real codex smoke and rework closed loop |
| [docs/zcode-windows-smoke.en.md](docs/zcode-windows-smoke.en.md) · [docs/zcode-issue-8-10-validation.en.md](docs/zcode-issue-8-10-validation.en.md) · [docs/zcode-issue-12-windows-evidence.en.md](docs/zcode-issue-12-windows-evidence.en.md) | ZCode real-machine records on Windows |
| [docs/codex-windows-smoke.en.md](docs/codex-windows-smoke.en.md) | Codex real-machine record on Windows (including failure → generated plan → passing rework) |
| [docs/host-integration-record.md](docs/host-integration-record.md) · [docs/issue-1-host-reconnect-record.md](docs/issue-1-host-reconnect-record.md) | Real Tianshu host integration and reconnect acceptance |
| [docs/dod7-release-record.md](docs/dod7-release-record.md) · [docs/dod8-session-record.md](docs/dod8-session-record.md) · [docs/s7-session-recheck.md](docs/s7-session-recheck.md) | npm release, real session testing and second-round remediation |
| [docs/issue-16-skill-install-hardening-record.md](docs/issue-16-skill-install-hardening-record.md) · [docs/issue-17-small-fixes-record.md](docs/issue-17-small-fixes-record.md) · [docs/issue-23-selector-drift-record.md](docs/issue-23-selector-drift-record.md) | Skill self-install hardening, small-fix sweep, selector-drift records |
| [docs/issue-18-21-real-machine-record.md](docs/issue-18-21-real-machine-record.md) · [docs/issue-19-22-real-machine-record.md](docs/issue-19-22-real-machine-record.md) | Real-machine records for the event stream / repair directives / dryRun / acceptance inheritance / notifications |
| [docs/issue-25-gui-real-machine-record.md](docs/issue-25-gui-real-machine-record.md) · [docs/gui-0.1.0-release-record.md](docs/gui-0.1.0-release-record.md) | Log viewer GUI real-machine acceptance and stable release record |

## For developers

Node.js ≥ 20 · TypeScript 5.7 · Vitest · `tsc` emitting `dist/` directly + tsx for development.

```bash
npm ci
npm run build        # sync-version + tsc → dist/
npm test             # full test suite
npm run typecheck    # type checking (tsc --noEmit)
npm run lint         # ESLint (--max-warnings 0)
npm run check:stdio  # strict stdio smoke (real process byte-stream validation)
```

- **Add a CLI agent** — usually just a `driver: "spawn"` profile in `<data-dir>/agent-profiles.json`, with no code change.
- **Add a GUI agent** — write a new adapter directory (`adapter.ts` / `discovery.ts` / `cdp.ts` / `selectors.ts` / `project.ts` / `liveness.ts` / `run.ts`) and register it in `agents/registry.ts` and `agents/builtin.ts`.
- **Add an MCP tool** — add metadata in `src/mcp/tools.ts`, an implementation in `src/mcp/handlers.ts`, and an input schema in `src/config/schema.ts`.
- **Adjust UI selectors** — override via the profile's `gui.selectors` (diagnose drift first with `npm run probe:*`).
- The version number must be kept in sync in three places: `package.json`, `package-lock.json`, and `src/version.generated.ts` (the last is generated from `package.json` by `scripts/sync-version.mjs` before every build — **do not edit it by hand**).

## Security

- **Path boundary enforcement** — `projectPath` is realpath-normalised; the home directory and system/root subtrees are rejected; glob/grep/diff reject `..` traversal.
- **No automatic repository history changes** — a git baseline is captured before work starts and reports are computed relative to it; the MCP never auto-commits / stashes / checks out.
- **Zero credential handling** — no agent credential is read, decrypted or forwarded; AI content validation likewise adds no credential management — the judge command manages its own key.
- **Commands never build a shell** — acceptance commands are structured argv with `shell:false`, offering no shell-injection surface.
- **Desktop automation boundaries** — reuse the user's instance by default, computer-use allowlist, and process termination only after ownership verification.

Please report security vulnerabilities privately as described in [SECURITY.en.md](SECURITY.en.md) — **do not** open a public issue.

## Community & support

- **Questions / discussion** → [GitHub Issues](https://github.com/lanlan0811/tianshu-mcp/issues) (attaching `logs/server.log` output speeds up triage)
- **Primary repository** → <https://github.com/lanlan0811/tianshu-mcp> (GitHub)
- **Mirror repository** → <https://gitee.com/lan0811/tianshu-mcp> (Gitee)
- **Contributing** → [CONTRIBUTING.en.md](CONTRIBUTING.en.md) · **Security model** → [SECURITY.en.md](SECURITY.en.md) · **Code of conduct** → [CODE_OF_CONDUCT.en.md](CODE_OF_CONDUCT.en.md)
- **Handoff status / troubleshooting** → [HANDOFF.md](HANDOFF.md) · **Version changes** → [CHANGELOG.en.md](CHANGELOG.en.md) · **Dependency manifest** → [DEPENDENCIES.en.md](DEPENDENCIES.en.md)

## Contributors

Thanks to the community members who contributed through issues and pull requests (in order of first participation):

<table>
  <tr>
    <td align="center"><a href="https://github.com/liuchsong"><img src="https://github.com/liuchsong.png" width="50" height="50" alt="liuchsong" /><br /><sub>liuchsong</sub></a></td>
    <td align="center"><a href="https://github.com/a13612745638"><img src="https://github.com/a13612745638.png" width="50" height="50" alt="a13612745638" /><br /><sub>a13612745638</sub></a></td>
    <td align="center"><a href="https://github.com/king195547"><img src="https://github.com/king195547.png" width="50" height="50" alt="king195547" /><br /><sub>king195547</sub></a></td>
    <td align="center"><a href="https://github.com/zhaoxc857"><img src="https://github.com/zhaoxc857.png" width="50" height="50" alt="zhaoxc857" /><br /><sub>zhaoxc857</sub></a></td>
    <td align="center"><a href="https://github.com/jian-in"><img src="https://github.com/jian-in.png" width="50" height="50" alt="jian-in" /><br /><sub>jian-in</sub></a></td>
    <td align="center"><a href="https://github.com/huiliyi37"><img src="https://github.com/huiliyi37.png" width="50" height="50" alt="huiliyi37" /><br /><sub>huiliyi37</sub></a></td>
    <td align="center"><a href="https://github.com/MToF0214"><img src="https://github.com/MToF0214.png" width="50" height="50" alt="MToF0214" /><br /><sub>MToF0214</sub></a></td>
  </tr>
</table>

## Star History

<a href="https://star-history.com/#lanlan0811/tianshu-mcp&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=lanlan0811/tianshu-mcp&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=lanlan0811/tianshu-mcp&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=lanlan0811/tianshu-mcp&type=Date" width="700" />
  </picture>
</a>

## License

This project is released under the **Apache License 2.0**; the full legal text is in [LICENSE](LICENSE). Copyright 2026 tianshu-mcp contributors. In short: you may use it commercially, modify it, redistribute it and use it privately, and you receive a patent license from contributors; when distributing you must include the full LICENSE and note modifications; the license grants **no** trademark rights, and filing a patent suit against contributors terminates the patent grant automatically; the software is provided "as is" without warranty of any kind.

### Third-party dependency licenses

Runtime dependencies are licensed as follows (the **full dependency manifest** — per-package versions, development dependencies, desktop Rust dependencies, indirect license distribution and SBOM commands — is in [DEPENDENCIES.en.md](DEPENDENCIES.en.md)):

| Dependency | License | Purpose |
|---|---|---|
| [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/sdk) | MIT | MCP protocol implementation |
| [`zod`](https://github.com/colinhacks/zod) | MIT | External input validation |
| [`cross-spawn`](https://github.com/moxystudio/node-cross-spawn) | MIT | Cross-platform child processes |
| [`puppeteer-core`](https://github.com/puppeteer/puppeteer) | Apache-2.0 | Headless browser driving for visual acceptance |
| [`@puppeteer/browsers`](https://github.com/puppeteer/puppeteer) | Apache-2.0 | Installing and version-pinning managed Chrome/Edge |
| [`pixelmatch`](https://github.com/mapbox/pixelmatch) | ISC | Page screenshot pixel comparison |
| [`sharp`](https://github.com/lovell/sharp) (optional) | Apache-2.0 | Image decoding and spec validation; the visual module blocks explicitly when absent |

> `sharp` itself is Apache-2.0, but its **optional** platform binaries (`@img/sharp-*`) are declared **LGPL-3.0-or-later** and are used as unmodified prebuilt shared libraries — without `sharp` the dependency tree contains no LGPL component.

Development dependencies (TypeScript, ESLint, Prettier, Vitest, Vite, tsx, etc.) each follow their own open-source license and are not distributed with the npm package.

### Relationship to the security boundary

This MCP **stores, reads and forwards no** AI agent API key or login state (see [SECURITY.en.md](SECURITY.en.md)). The license terms do not change this design boundary.

---

> Chinese documentation: [README.md](README.md) and [ARCHITECTURE.md](ARCHITECTURE.md); the full documentation map and status snapshot are in [HANDOFF.md](HANDOFF.md).