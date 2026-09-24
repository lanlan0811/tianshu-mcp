<div align="center">

<img src="./assets/tianshu-mcp-banner.svg" alt="tianshu-mcp" width="100%">

<br/>

<img src="./assets/tianshu-mcp-icon.svg" alt="tianshu-mcp icon" width="132" height="132">

# tianshu-mcp

Visual acceptance (since v0.5.0, with optional AI content validation since v0.5.4): [English guide](docs/visual-acceptance.en.md) · [Validation record](docs/visual-validation.en.md) · [Latest release notes](<docs/release-v0.5.10.en.md>) · [All versions](CHANGELOG.en.md).

**Tianshu × AI-Agent orchestration MCP server**

Registered by Tianshu as a standard MCP server, it dispatches external AI-Agents (Codex desktop, TraeWork/TRAE SOLO CN, ZCode, Kimi Code and Qoder CN, all driven through their desktop UIs over CDP) to drive the closed loop of **project development → acceptance → failure rework → re-acceptance** (horizontally extensible).

> Official Tianshu repository: [github.com/huiliyi37/Tianshu-harness](https://github.com/huiliyi37/Tianshu-harness) — a harness-engineering terminal coding-agent runtime (TUI × GUI); this MCP plugs into it as an MCP server.

<br/>

[![CI](https://github.com/lanlan0811/tianshu-mcp/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/lanlan0811/tianshu-mcp/actions/workflows/ci.yml)
[![npm version](https://badgen.net/npm/v/tianshu-mcp?icon=npm&color=cb3837&label=npm)](https://www.npmjs.com/package/tianshu-mcp)
[![npm downloads](https://badgen.net/npm/dm/tianshu-mcp?icon=npm&color=cb3837&label=downloads)](https://www.npmjs.com/package/tianshu-mcp)
[![GitHub stars](https://badgen.net/github/stars/lanlan0811/tianshu-mcp?icon=github&color=24292e&label=stars)](https://github.com/lanlan0811/tianshu-mcp)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.x-6f42c1.svg)](https://github.com/modelcontextprotocol/sdk)

**English** · [简体中文](README.md)

</div>

---

## What this is

Tianshu plays the role of the overall commander; this MCP server is the **scheduler + execution surface + objective acceptance gate**; the external AI-Agent (Codex / TraeWork / ZCode / Kimi Code / Qoder CN GUI) is the "worker" that does the development.

- **11 MCP tools**: `run_task / continue_task / query_task / list_tasks / get_task_report / cancel_task / verify_task / rework_task / get_profiles`, plus `prepare_visual_baseline / approve_visual_baseline` for visual acceptance
- **Async contract**: `run_task` returns a `taskId` immediately; long-running work is polled via `query_task` (never blocks `tools/call`).
- **Long-task observability (issue #18)**: adapters report fine-grained events at key nodes (`task_dispatched` / `confirmation_dialog_detected` / `awaiting_user_authorization` / `file_modification_started` / `rework_triggered`), and `query_task` returns the most recent N via `eventLimit` (default 10) — **so you can tell "the agent is working" apart from "stuck on a dialog waiting for a human"**. Event reporting is an optional capability: adapters that don't implement it behave unchanged. codex and traework report in this version. See [event stream](docs/event-stream.en.md).
- **Structured repair directives (issue #19)**: failed rounds parse the reasons into **directly executable actions** (`file:line / issue / action`) carried in both the repair plan and the rework message, sparing the agent the cost of locating problems in a full narrative report; when extraction is unavailable it **explicitly falls back** to the full report (never a silent gap). `rework_task` also accepts an optional `repairHint`. See [structured repair directives](docs/repair-directives.en.md).
- **Objective acceptance**: automated command checks (typecheck/lint/test/build — skipped when absent, plus tech-stack derivation) + programmatic code analysis (changed-file list / diffstat / suspicious signals such as TODO, debugger, secret-like patterns), all relative to a **git baseline**; never auto-commits or stashes. The acceptance engine is **fail-closed**: a test check fails when its output reports zero executed tests even if the exit code is 0; git projects must produce changes relative to the pre-work baseline by default (pure analysis tasks can opt out with `"requireChanges": false` in `.tianshu-mcp/acceptance.json`).
- **Acceptance parallelism**: command checks run **bounded-parallel** by default (`verifyConcurrency`, default 2, range 1–4). When checks depend on an order (a later check reading build output, `--fix`, shared cache dirs), set it to `1` for fully serial behaviour; a project can override it in `.tianshu-mcp/acceptance.json`, and the server level lives in `config.json`. Report and log formats are unchanged (results are returned in declaration order).
- **Three-level acceptance config inheritance (issue #20)**: `<data home>/acceptance.default.json` (global fallback) → `<project>/.tianshu-mcp/acceptance.json` (project override) → the `acceptanceOverride` argument of `run_task`/`verify_task` (transient task override, applying only to that task and never written to disk as config). For the same field a higher layer wins; arrays replace wholesale rather than concatenating. Inspect the final effective configuration with `tianshu-mcp config acceptance <projectPath> [--task <id>]`. See the [acceptance config spec](docs/acceptance-config.en.md).
- **Rework loop**: automatic rework (`autoFixRounds`) + manual `rework_task`; on verification failure a repair-plan file is generated and fed back to the agent; when rounds run out → `needs_attention` awaiting Tianshu's verdict.
- **Execution surfaces**: `driver: "gui"` selects an explicit, isolated Codex/TraeWork/ZCode/Kimi Code/Qoder CN CDP adapter; `driver: "spawn"` runs an external CLI child process.
- **Project-less dispatch (ZCode, issue #12)**: `run_task`'s `projectPath` may be omitted — ZCode runs the task in its `default` workspace without registering/importing a project, collecting a Git baseline, or running project acceptance (the result is marked structurally as `verificationNotApplicable: "no_project"` and `verify_task`/`get_task_report` return a not-applicable explanation). The companion `allowCreateProject: false` stops dispatch before any import side effect when the target directory is unregistered. See the [ZCode CDP adapter](docs/zcode-cdp.en.md).
- **Idempotent retries (issue #15)**: `run_task` / `verify_task` accept an optional `idempotencyKey` — a retry with the same key within the TTL (24 h default) never duplicates a dispatch (the original `taskId` and its current status are returned) or re-runs verification (a running pass answers "in progress", a finished one returns the existing report); the same key with different arguments fails closed. The mapping is persisted in `<data-dir>/idempotency.json` and survives a server restart. See the [v0.5.10 release notes](<docs/release-v0.5.10.en.md>).
- **Skill self-install (issue #16)**: on startup the **in-package** `skills/tianshu-mcp/` is synced idempotently to `~/.rivet/skills/tianshu-mcp/`. The source is located relative to the package via `import.meta.url` (no cwd content discovery); an install manifest inside the target lets it auto-upgrade **only when the copy is provably untouched**, while **detected local edits or an unknown source are kept with a warning**; overwrites go through an atomic "tmp dir → backup → swap in" path and are governed by `skills.autoInstall` (`true`/`"prompt"`/`false`) and `skills.backupKeep`. See [README §Skill self-install](#skill-self-install).
- **Scheduling discipline**: per-project serial queue + global concurrency cap (default 2, configurable); even without an idempotency key, `run_task` names the unfinished task in the same workspace so a retry is not mistaken for a fresh dispatch.
- **Optional AI content validation (v0.5.4, off by default)**: validates whether the **content** of an image or page screenshot matches an expectation you declare explicitly. Judgement is fully **delegated to a local command you supply** (the MCP reads, stores, and forwards no keys and ships no model client), it **warns only** by default and can be upgraded to failing per rule, and it debounces with majority sampling plus a task-level cache; split votes or confidence below the threshold yield `uncertain`, which never gates and never triggers rework. Configuration and the command contract are in [visual acceptance](docs/visual-acceptance.en.md).
- **No key handling**: each agent uses its own login state; this server never stores or forwards any API key. Optional AI content validation adds no credential management either — the judge command manages its own key (see [SECURITY.en.md](SECURITY.en.md)).
- **Extensible**: a new agent = one profile (data) + (if needed) one adapter file — no changes to the orchestration core.
- **Want the internals?** See [ARCHITECTURE.en.md](ARCHITECTURE.en.md) (layering, module boundaries, state machine, acceptance pipeline, extension points, known gaps).

## Quick start

### Prerequisites

| Item | Requirement |
|---|---|
| Node.js | ≥ 20 (CI covers 20 / 22 / 24) |
| Package manager | npm (the repo ships a `package-lock.json`) |
| OS | Windows / macOS / Linux (verified by the three-platform CI matrix) |
| Git | Optional; acceptance baseline analysis is more complete inside a git repository |

The data directory defaults to `~/.tianshu-mcp` and can be overridden with the `TIANSHU_MCP_HOME` environment variable; it is created automatically on first start.

### Build from source

```bash
git clone https://github.com/lanlan0811/tianshu-mcp.git
cd tianshu-mcp
npm ci
npm run build        # sync-version + tsc → dist/
npm test             # 867 passed / 12 skipped (879 tests, 85 files: unit/integration/protocol plus 3 real-browser files skipped by design)
```

### Install the npm package

```bash
npx -y tianshu-mcp            # run without installing
# or
npm install -g tianshu-mcp
```

### Add it in Tianshu (recommended)

In Tianshu go to **Settings → MCP Servers → Add** and fill in the fields below
(transport: `stdio (local process)`):

| Field | npm distribution (recommended) | Local dev |
|---|---|---|
| Server ID | `tianshu-mcp` | `tianshu-mcp` |
| Transport | `stdio (local process)` | `stdio (local process)` |
| Command | `npx` | `node` |
| Arguments (space-separated) | `-y tianshu-mcp` | `<absolute-repo-path>/dist/index.js` |

> - The server ID becomes the tool prefix: with `tianshu-mcp` the tools are `mcp__tianshu-mcp__run_task` and 8 others.
> - Arguments are space-separated, **no quotes**; for local dev replace `<absolute-repo-path>` with a real path (e.g. `D:/TraeProject/tianshu-mcp/dist/index.js`).
> - The dialog has no env-var field; to customize the data directory, use the `config.json` method below and set `TIANSHU_MCP_HOME`.
> - Once the server connects, open a new session and the 11 tools appear.

### Or edit config.json (supports env vars)

Register as a Tianshu MCP server (local dev mode):

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

After opening a new session, the 11 tools such as `mcp__tianshu-mcp__run_task` appear. Rehearse with the stub agent first (no real login state), then switch to the `codex` profile for real tasks:

```text
run_task(projectPath=D:/xxx/my-app, task=「…task brief…」, agentId=codex,
         model=「GPT-5.6 Sol」, reasoningLevel=「high」, autoVerify=true, autoFixRounds=5)
  → taskId → poll query_task(taskId) → succeeded / failed / needs_attention → get_task_report
```

> `codex` is now a **desktop GUI driver** (`driver=gui` + `activation=msix-com`): Codex ships as an MSIX
> store package whose `ChatGPT.exe` cannot be launched directly (policy denies it); it must be started via
> COM activation with a dedicated `--user-data-dir` before CDP can drive it. `planDoc` / `designSystem` are
> appended to the initial instruction. See [docs/codex-gui-cdp.en.md](docs/codex-gui-cdp.en.md) and the
> [hardware acceptance record](docs/codex-windows-smoke.en.md). Projects not yet registered on the Codex side are **registered automatically** — no manual project creation needed.
> When Codex parks on a "waiting for user confirmation" screen (plan-confirmation card, subscription checkout, etc.),
> the task turns `needs_user(user_confirmation)`; after handling it in the Codex window call `continue_task(taskId)`
> to resume observation. `cancel_task` clicks the in-app stop control over CDP and bounded-waits for the GUI to go
> idle; before dispatching, a still-running managed instance is stopped best-effort, and if it never goes idle the
> dispatch is rejected with `instance_busy`.

When driving TraeWork, `model` and `mode` are available:

```text
run_task(projectPath=D:/xxx/my-app, agentId=traework, task=「Switch to Code mode and implement the login API」,
         model=GLM-5.3, mode=Code, autoVerify=true, autoFixRounds=2)
```

> `mode` accepts `Work` / `Code` / `Design`; when omitted it is detected from the task text (e.g. "switch to Code mode"), otherwise `Work` is kept.
> TraeWork's three modes **each keep an independent project binding**, so the order is: new session → switch to target mode → bind the project inside that mode.

For ZCode, `model` must be an exact `provider/model` and `mode` is rejected:

```text
run_task(projectPath=D:/xxx/my-app, agentId=zcode, task="Implement `./plan.md`",
         model=DeepSeek/deepseek-flash, autoVerify=true)
```

Questions, login, an existing non-CDP instance, or system permission pause as `needs_user`; call `continue_task(taskId, message)` to resume the recorded session. Model selection is adapted to ZCode 3.11.2: flat models are selected directly first, with provider/family group expansion as a fallback — both new and legacy layouts are supported. See [docs/zcode-cdp.en.md](docs/zcode-cdp.en.md).

For Kimi Code, `model` is required and takes the UI model name directly, while `reasoningLevel` is validated against the tier set the UI actually renders:

```text
run_task(projectPath=D:/xxx/my-app, agentId=kimicode, task="Implement `./plan.md`",
         model=K3, reasoningLevel=high, autoVerify=true, autoFixRounds=2)
```

> Kimi Code is a plain Electron install (measured 1.0.2): injecting `--remote-debugging-port` and driving it over CDP is enough — no MSIX COM activation.
> **The model menu, thinking tiers and execution-mode menu render in a separate `Kimi Browser Overlay` renderer window**, while the workspace menu and the "switch model" dialog stay in the main window.
> A task must bind a workspace folder (**project-less dispatch is not supported**); an unregistered workspace is imported through the native "add workspace" dialog.
> `reasoningLevel`: official models use `低/low`, `高/high` and `max`; **unofficial models (e.g. `stepfun/step-3.7-flash:free`) only have `on` / `off`**.
> The domain deliberately excludes `中`/`medium`; tiers are validated against the label set the UI actually renders, and a tier the UI does not render fails loudly before sending. The `mode` parameter is not supported. See the [Kimi Code CDP adapter](docs/kimi-cdp.en.md).

For Qoder CN, an existing `projectPath` and a readable `planDoc` are mandatory:

```text
run_task(projectPath=D:/xxx/my-app, agentId=qoder, planDoc=./plans/development.md,
         modelSource=custom, model=<UI model name>, reasoningLevel=极高,
         task="Implement the project per the plan", autoVerify=true, autoFixRounds=3)
```

> **Qoder CN only** (the international edition or a similarly titled window is not a substitute). `modelSource=default|custom` disambiguates identical names across the default/custom groups;
> the thinking tier is saved in Model Management as a **global Qoder preference** (never restored afterwards) and read back by reopening the dialog, and an unsupported tier fails before sending;
> the permission mode is retained as-is. Both automatic and manual repair **write the plan first**, then send its filename, full path and complete text to the original conversation.
> macOS is `research` and dispatch is disabled. See the [Qoder CN adapter](docs/qoder-cdp.en.md).

## Tool surface (11 tools)

| Tool | Capability / approval | Purpose |
|---|---|---|
| `run_task` | write + approval | Dispatch work (optional auto-verify / auto-rework); returns `taskId` asynchronously. Optional `idempotencyKey` (a retry with the same key returns the original `taskId` instead of creating a task) and `acceptanceOverride` (transient acceptance-config override applying only to this task) |
| `continue_task` | write + approval | Resume the session behind `needs_user` (ZCode resumes the recorded session; Codex re-observes for `user_confirmation` / re-dispatches for `login_required`; Kimi Code resumes the recorded session and distinguishes question answering / re-observation / full re-dispatch) |
| `query_task` | read | Poll status / progress / log tail / recent fine-grained events. The optional `eventLimit` (1..50, default 10) controls how many `recentEvents` the meta block carries, so long tasks can be told apart as "working normally" versus "stuck on a dialog waiting for a human" |
| `list_tasks` | read | Filtered history of tasks |
| `get_task_report` | read | Full text of a verification round's report (`report.md`) |
| `cancel_task` | write + approval | Cancel a running task: CLI agents kill the process tree; GUI agents click the in-app stop control over CDP and bounded-wait (`gui.cancelWaitMs`, default 15s) for the GUI to go idle, stating so explicitly in the final message when the stop is unconfirmed. For a terminal GUI task this call doubles as the manual acknowledgement entry point — after verifying the window holds no residual run, it clears the `guiStopUnconfirmed` marker |
| `verify_task` | execute (no source changes, no approval) | Run one verification pass on a task/project path. Capability is `execute`: it runs the project's configured commands and may produce build artifacts, so MCP `readOnlyHint` is `false` — but it **does not modify sources and still needs no approval**. Optional `idempotencyKey`: a retry with the same key never re-runs (a running pass answers "in progress", a finished one returns the existing report) |
| `rework_task` | write + approval | Manual rework (feed the failure report back to the same agent). Optional `repairHint` (≤4000 chars) supplies a structured repair hint rendered as a block before `feedback` |
| `get_profiles` | read | Inspect agent adapters and executable discovery results |
| `prepare_visual_baseline` | write + approval | Capture or import reference images into a reviewable candidate with a digest |
| `approve_visual_baseline` | write + approval | Validate the reviewed digest and write the baseline and approval record |

> Every result is "human-readable text + a `---tianshu-mcp-meta---` JSON block" so the host can extract it with a regex.

> **Path safety gate** (since v0.4.0): `projectPath` is validated at submission — must be absolute, the directory must exist, and symlinks are canonicalized via realpath (the receipt notes the resolution). The home directory itself and system/root directories are rejected outright so a worker's write access can never cover a whole system subtree; dirty git repos come with an uncommitted-changes coexistence warning.

> **Idempotent retries** (since v0.5.10, issue #15): the `idempotencyKey` of `run_task` / `verify_task` makes a host timeout retry safe to repeat — the same key with the same arguments returns the original `taskId` (`run_task`, terminal tasks included) or the existing report (`verify_task`, including an "in progress" success result with `idempotencyReplay: "in_progress"`); the same key with different arguments fails with the original record id in the message. Key plaintext never enters logs or the event stream (only a digest). Boundaries: a `verify_task(taskId=…)` key is not written into the task snapshot, and "in progress" detection is process-local. See the [v0.5.10 release notes](<docs/release-v0.5.10.en.md>).

## Logging & stdio contract

This server is a standard MCP **stdio server** and follows the transport contract strictly:

- **stdout carries MCP JSON-RPC messages only.** No diagnostic log is ever written to stdout — doing so corrupts the JSON-RPC stream and makes strict clients fail to handshake or call tools.
- **All log levels (DEBUG/INFO/WARN/ERROR) go to stderr** and are appended to `logs/server.log` under the data directory (UTF-8, ISO timestamp, with a level tag).
- Therefore **an `INFO`/`WARN` line on stderr does not mean the server failed**; it is normal diagnostics. Only a startup failure (`tianshu-mcp 启动失败:`) is fatal, and it exits with a non-zero code.

The data directory defaults to `~/.tianshu-mcp` (override with `TIANSHU_MCP_HOME`); the log file lives at `<data dir>/logs/server.log`.

Use `server.log` when troubleshooting connections; do not treat stderr output itself as a server fault.

## Skill self-install

On startup, the **in-package** `skills/tianshu-mcp/` is synced idempotently to `~/.rivet/skills/tianshu-mcp/` so the host (Tianshu) picks up the orchestration skill in a new session. Three points:

- **Skill content comes from the package only**: the source directory is located relative to the module via `import.meta.url` (both source and dist runs resolve to the in-package `skills/`); content is **never** discovered from the current working directory. When no source is found, install is skipped with a warning.
- **No silent overwrite on mismatch**: an install manifest `<dest>/.tianshu-mcp-install.json` (version + content hash) is kept inside the target. Three cases follow from it — content identical → skip; a stale copy this package provably installed and left untouched → handled per `skills.autoInstall`; **manifest hash ≠ target content (i.e. you edited files) or no valid manifest (unknown source) → your version is kept and a warning is logged**, never overwritten.
- **Overwrite is atomic**: content is staged into `<dest>.incoming-*`, the old directory is backed up as `.bak-<timestamp>`, then swapped in; failures roll back, leaving no half-copied tree. After an overwrite, historical backups are pruned to `skills.backupKeep` (default 3).

```jsonc
// <data dir>/config.json
{
  "skills": {
    "autoInstall": true,   // true (default) | "prompt" | false
    "backupKeep": 3        // backups kept after an overwrite; 0 = never prune
  }
}
```

| `autoInstall` | Behaviour |
|---|---|
| `true` (default) | First install; skip when identical; a provably untouched stale copy is **backed up and upgraded automatically**; your local edits and unknown-source directories are **still kept as-is** |
| `"prompt"` | First install as usual; otherwise the same, but **no automatic overwrite when a change is needed** — only a warning plus a `pendingUpdate` note in the manifest |
| `false` | No automatic install at all |

Opt-in and opt-out (CLI flag or equivalent env var; `--no-skill-install` / `autoInstall:false` vetoes everything else):

- `--approve-skill-update` (or `TIANSHU_MCP_APPROVE_SKILL_UPDATE=1`): for this run, permit a "needs change" skill directory to be overwritten with the in-package version (after backup). **It does not apply to directories confirmed to carry your local edits** — those require renaming/deleting the directory and restarting, or merging your edits manually.
- `--no-skill-install` (or `TIANSHU_MCP_NO_SKILL_INSTALL=1`): no skill install or check for this run.

On stderr, `INFO` means skipped/installed; `WARN` means a stale copy was upgraded, your edits were kept, or an issue was detected (short markers such as `含本地修改` / `来源不明` / `未自动覆盖` are searchable). A failed install only warns — it never blocks the server.

## Documentation

| Doc | Content |
|---|---|
| [ARCHITECTURE.en.md](ARCHITECTURE.en.md) | **Architecture**: layering and module boundaries, startup assembly, data home, state machine, verify/rework pipeline, agent driver contract, GUI instance lifecycle, cross-platform strategy, safety invariants, extension points, known gaps |
| [docs/tianshu-integration.en.md](docs/tianshu-integration.en.md) | Two config.json integration modes, UI/API steps, smoke test, FAQ |
| [docs/agent-profiles.en.md](docs/agent-profiles.en.md) | Agent profile field reference + real-machine samples |
| [docs/adapter-matrix.en.md](docs/adapter-matrix.en.md) | Agent capability research matrix (Codex/Zcode/TraeWork/Kimi Code/extension slots) |
| [docs/traework-cdp.en.md](docs/traework-cdp.en.md) | TraeWork GUI driver (CDP): mechanism, config, mode switching, selectors, safety invariants, pitfalls, verification record |
| [docs/zcode-cdp.en.md](docs/zcode-cdp.en.md) | ZCode GUI driver: discovery, exact project/model, Full Access, pause/continue, verification and platform evidence |
| [docs/zcode-windows-smoke.en.md](docs/zcode-windows-smoke.en.md) | ZCode Windows hardware record for development, same-session repair, and question continuation |
| [docs/codex-gui-cdp.en.md](docs/codex-gui-cdp.en.md) | Codex desktop GUI driver: MSIX COM activation, CDP attach, selectors, run detection, verify/repair |
| [docs/kimi-cdp.en.md](docs/kimi-cdp.en.md) | Kimi Code GUI driver: two renderer processes (main window + `Kimi Browser Overlay`), full-path workspace binding with native-dialog import, three-stage model selection and thinking tiers, execution mode, run detection and troubleshooting |
| [docs/codex-windows-smoke.en.md](docs/codex-windows-smoke.en.md) | Codex Windows hardware record (incl. verify-fail → auto plan → repair-pass loop) |
| [docs/release-v0.3.4.en.md](<docs/release-v0.3.4.en.md>) | v0.3.4 release notes (ZCode project/model read-back, initialization recovery, session dispatch confirmation, issues #8/#9/#10) |
| [docs/qoder-cdp.en.md](docs/qoder-cdp.en.md) | Qoder CN GUI driver: installation discovery and instance reuse, full-path workspaces with native import, `modelSource` and global Model Management reasoning tiers, send/answer checkpoints, liveness judging and same-session repair, hardware evidence and uncovered items |
| [docs/release-v0.5.10.en.md](<docs/release-v0.5.10.en.md>) | v0.5.10 release notes (`run_task` / `verify_task` idempotency keys: TTL replay, in-progress answer, fail-closed on same key with different arguments, the persisted `idempotency.json`, and the `idempotentHint` annotation; issue #15) |
| [docs/release-v0.5.9.en.md](<docs/release-v0.5.9.en.md>) | v0.5.9 release notes (truthful GUI terminal state on server exit / restart archiving: wording branches on `guiStop`, the bounded `shutdown.guiStopWaitMs` wait, structured pending fields and the manual acknowledgement entry point; issue #14) |
| [docs/release-v0.5.8.en.md](<docs/release-v0.5.8.en.md>) | v0.5.8 release notes (the four primary documents rewritten against the code, plus the missing TraeWork probe and three probe scripts; no runtime change) |
| [docs/release-v0.5.7.en.md](<docs/release-v0.5.7.en.md>) | v0.5.7 release notes (orchestration skill docs rewritten against the code: parameter matrix, default precedence, tier correction and the qoder section; no runtime change) |
| [docs/release-v0.5.6.en.md](<docs/release-v0.5.6.en.md>) | v0.5.6 release notes (Qoder CN GUI adapter, hardware acceptance scope, macOS research boundary) |
| [docs/release-v0.5.5.en.md](<docs/release-v0.5.5.en.md>) | v0.5.5 release notes (Kimi Code GUI adapter: dual renderer processes, full-path workspace binding with native import, three-stage model selection and tier validation, run detection and recovery) |
| [docs/release-v0.5.4.en.md](<docs/release-v0.5.4.en.md>) | v0.5.4 release notes (optional AI visual content validation: user-supplied command delegation, majority-vote debouncing, warning-only by default) |
| [docs/release-v0.5.3.en.md](<docs/release-v0.5.3.en.md>) | v0.5.3 release notes (ZCode hardware-revisit fixes: instance survival across server exit, new-task page switch, send-failure attribution) |
| [docs/release-v0.5.2.en.md](<docs/release-v0.5.2.en.md>) | v0.5.2 release notes (ZCode project-less dispatch and `allowCreateProject`, issue #12) |
| [docs/release-v0.5.1.en.md](<docs/release-v0.5.1.en.md>) | v0.5.1 release notes (skill/validation docs, archived platform evidence, lockfile version sync; no runtime changes) |
| [docs/release-v0.5.0.en.md](<docs/release-v0.5.0.en.md>) | v0.5.0 release notes (optional visual acceptance: screenshots, image specs, baseline approval, offline report) |
| [docs/visual-acceptance.en.md](<docs/visual-acceptance.en.md>) | Visual acceptance primer and full configuration: three page sources, baseline candidates/approval, rule freezing, thresholds and troubleshooting, plus optional AI content validation (command contract, reason codes, debouncing, egress statement) |
| [docs/visual-validation.en.md](<docs/visual-validation.en.md>) | Visual acceptance validation progress: full Windows 10 matrix, macOS Intel/Apple Silicon platform evidence, and the v0.5.4 stub-judge end-to-end record for AI content validation |
| [docs/visual-validation-evidence/](<docs/visual-validation-evidence/>) | Raw machine-readable records for the above (environment JSON, matrix results, test output and macOS CI summaries) |
| [docs/release-v0.4.1.en.md](<docs/release-v0.4.1.en.md>) | v0.4.1 release notes (skill docs aligned with the v0.4.0 tool surface + contributor credits) |
| [docs/zcode-issue-8-10-validation.en.md](<docs/zcode-issue-8-10-validation.en.md>) | ZCode #8/#9/#10 Windows hardware record (cold import, imported-project reuse, same-task recovery) |
| [docs/release-v0.3.3.en.md](<docs/release-v0.3.3.en.md>) | v0.3.3 release notes (ZCode 3.11.2 adaptation + fail-closed acceptance engine) |
| [docs/release-v0.3.2.en.md](docs/release-v0.3.2.en.md) | v0.3.2 release notes (Codex wait-user detection + cancel truly stops the GUI) |
| [docs/release-v0.3.1.en.md](docs/release-v0.3.1.en.md) | v0.3.1 release notes (skill docs rewrite + release automation fixes) |
| [docs/release-v0.3.0.en.md](docs/release-v0.3.0.en.md) | v0.3.0 release notes (Codex desktop GUI adapter, incl. BREAKING) |
| [docs/release-v0.2.0.en.md](docs/release-v0.2.0.en.md) | v0.2.0 release notes (unified ZCode GUI loop) |
| [docs/acceptance-config.en.md](docs/acceptance-config.en.md) | Project-level `.tianshu-mcp/acceptance.json` acceptance config spec |
| [docs/release-v0.1.9.en.md](docs/release-v0.1.9.en.md) | v0.1.9 release notes (TraeWork task liveness and instance retention) |
| [docs/release-v0.1.10.en.md](docs/release-v0.1.10.en.md) | v0.1.10 release notes (stdio log pollution fix: diagnostics on stderr) |
| [docs/release-v0.1.8.en.md](docs/release-v0.1.8.en.md) | v0.1.8 release notes (atomic-write concurrency fix) |
| [docs/release-v0.1.7.en.md](docs/release-v0.1.7.en.md) | v0.1.7 release notes (binding root cause: native path) |
| [docs/release-v0.1.6.en.md](docs/release-v0.1.6.en.md) | v0.1.6 release notes (project-folder binding fix) |
| [docs/release-v0.1.5.en.md](docs/release-v0.1.5.en.md) | v0.1.5 release notes (mode switching, README/icon, release artifacts) |
| [skills/tianshu-mcp/SKILL.md](skills/tianshu-mcp/SKILL.md) | Skill that teaches Tianshu how to orchestrate this MCP (with usage examples) |

> Chinese documentation: see README.md.
> Some milestone/evidence records are **Chinese-only** (no English translation yet): [HANDOFF.md](<HANDOFF.md>),
> [docs/npm-publish-guide.md](<docs/npm-publish-guide.md>), [docs/m2-smoke-record.md](<docs/m2-smoke-record.md>),
> [docs/m2-rework-record.md](<docs/m2-rework-record.md>), [docs/host-integration-record.md](<docs/host-integration-record.md>), [docs/issue-1-host-reconnect-record.md](<docs/issue-1-host-reconnect-record.md>),
> [docs/dod7-release-record.md](<docs/dod7-release-record.md>), [docs/dod8-session-record.md](<docs/dod8-session-record.md>),
> [docs/s7-session-recheck.md](docs/s7-session-recheck.md).

## Milestone status

- **M1 — Core engine + stub-agent end-to-end** ✅
  - 8 tools, TaskManager state machine / queue / concurrency gate / cancel (kill tree) / event-stream persistence
  - Acceptance engine (git baseline & diff, default-set derivation, command runner, code analysis, report.md/json)
  - fix-loop auto rework + needs_attention; skill self-install (verified on this machine's real `~/.rivet/skills`)
  - Stub-agent 3 playbooks (good / fix-on-first / never) integration tests + protocol tests
- **M2 — Real Codex CLI smoke + rework loop** ✅ (2026-09-07)
  - Real `codex exec` completed `run_task → query_task → verify_task`
  - Real **failure → rework_task → re-verify succeeded** loop, with artifacts
  - Fixed 3 real bugs the smoke exposed (Windows npm shim / spawn log race crash / codex flag conflict) + regression tests
  - Zcode headless entry (Z1) verified: ZCode desktop ships no headless CLI → unsupported
- **R1–R8 / S1–S6 — two acceptance hardening rounds** ✅ (cancel / timeout / baseline attribution / parameter semantics / hot reload / CI hardening) — **72 tests**
- **Engineering / CI** ✅
  - GitHub Actions: `CI` (`build-test` ubuntu/windows/macos × Node 20/22/24 + `pack-check`, plus a `visual-browser` real-browser matrix ubuntu/windows/macos-15-intel/macos-15 × Node 20/22/24, all green with the v0.5.1 tag) and `Release` (tag-triggered) both green
  - Skill self-install verified idempotent on this machine's real `~/.rivet/skills/tianshu-mcp`
  - npm package name `tianshu-mcp` published continuously since v0.1.1 (currently `0.5.9`)
- **Real Tianshu host integration (DoD #6)** ✅ (2026-09-07)
  - Configured the local mode in the real `D:\Tianshu` desktop host `mcp.servers` → sidecar reported `MCP: 2 servers connected, 10 tools` (including this server's 8 tools), spawned the child process and connected over stdio
  - Exposed and fixed a skill-install source-path bug (fileURLToPath, commit 55cf2d0)
- **M3 — TraeWork research + full delivery** ✅ (2026-09-07, **npm published**)
  - T1 settled: local TRAE SOLO CN v1.107.1 verified to have **no headless programmable agent interface** (VS Code-family CLI only)
  - npm published from `tianshu-mcp@0.1.1` (`npx -y tianshu-mcp` raises and connects 8 tools)
- **M4 — TraeWork GUI driver (CDP)** ✅ (2026-09-08, see [traework-cdp.en.md](docs/traework-cdp.en.md)) — **153 tests**
  - Correction: no headless CLI exists, but `--remote-debugging-port` can drive the chat UI; `traework` is now `driver=gui` / `status=ready`
  - Capabilities: launch/reuse instance → new session → bind project folder (dropdown first, restricted computer-use native dialog as fallback) → optional model selection → read-back-verified send → poll to completion → auto-verify → repair-plan file + same-session rework on failure
  - Safety: reuse the user's instance by default, never kill a process tree, verify the command line before terminating; computer-use is limited to TraeWork's folder picker
  - Machine-verified: `run_task(agentId=traework, model=GLM-5.3, autoVerify=true)` drove TraeWork to create a file and passed acceptance
- **M5 — Mode switching + v0.1.5 release** ✅ (2026-09-08, see [release-v0.1.5.en.md](docs/release-v0.1.5.en.md)) — **167 tests**
  - `run_task` gained `mode` (Work/Code/Design), explicit parameter plus task-text fallback; all three modes **machine-verified end-to-end**
  - Key finding: the three modes keep independent project bindings → order is new session → switch mode → bind project inside that mode
  - README rewritten (bilingual + stack badges + dedicated SVG icon/banner)
- **M6 — Project-folder binding fix + v0.1.6** ✅ (2026-09-08, see [release-v0.1.6.en.md](docs/release-v0.1.6.en.md)) — **172 tests**
  - Fixed three stacked defects: footer click never verified the popup, detection budget eaten by PowerShell cold start, CJK paths destroyed by the console code page
  - Added a Work fallback for non-Work binding; machine-verified "new project absent from the dropdown + mode=Code" end-to-end
- **M7 — Binding root-cause fix + v0.1.7** ✅ (2026-09-08, see [release-v0.1.7.en.md](docs/release-v0.1.7.en.md)) — **178 tests**
  - Root cause: MCP passed a normalized path (`d:/a/b`) that the Windows native picker rejects → switched to `toNativeWindowsPath()` (`D:\a\b`)
  - Supporting fixes: `WM_GETTEXT` read-back verification after writing, hwnd threaded through the flow, stale-dialog cleanup
- **M8 — Atomic-write concurrency fix + v0.1.8** ✅ (2026-09-08, see [release-v0.1.8.en.md](docs/release-v0.1.8.en.md)) — **181 tests**
  - `writeJsonAtomic` / `writeTextAtomic` shared a temp filename under concurrency → randomized suffix + rename back-off retry (the real root cause of flaky CI windows/Node20 failures)
- **M9 — TraeWork task liveness detection + v0.1.9** ✅ (2026-09-09, see [release-v0.1.9.en.md](docs/release-v0.1.9.en.md)) — **196 tests**
  - The stop button / loading task tail became authoritative running signals that outrank the completion mark; stable rounds only start the idle timer (default 10 minutes) before returning `idle`
  - CDP disconnects reject all pending requests + a 15s per-command timeout; abnormal endings (idle/timeout/aborted/cdp_lost) keep the instance and record `agentEndReason` / `keptInstance`
- **M10 — stdio log pollution fix + v0.1.10** ✅ (2026-09-10, see [release-v0.1.10.en.md](docs/release-v0.1.10.en.md)) — **issue #1**
  - The unified logger now sends all levels to stderr, leaving stdout for MCP JSON-RPC messages only
  - Added a strict stdio smoke (real-process byte-stream validation, 6 scenarios), Node 24 CI coverage, and an installed-package protocol gate
- **M11 — ZCode GUI unified loop + v0.2.0** (2026-09-11, see [release-v0.2.0.en.md](docs/release-v0.2.0.en.md)) — **262 tests**
  - Windows hardware passed real development, same-session repair after a controlled failure, and `AskUserQuestion → continue_task`; see the [acceptance record](docs/zcode-windows-smoke.en.md)
  - macOS hardware is pending, so the built-in profile remains `research` as required by the plan
- **M12 — Codex desktop GUI adapter + v0.3.0** (2026-09-12, see [release-v0.3.0.en.md](docs/release-v0.3.0.en.md)) — **340 tests**
  - **Breaking**: `agentId=codex` moves from the `codex exec` headless CLI to the desktop GUI driver (COM activation + CDP)
  - Hardware-verified: full loop for a registered project, full loop for an unregistered project after automatic registration, and the verify-fail → generated plan → repair-pass loop
  - Real business acceptance: drove Codex to build a "Fruit Ninja" mini-game, passed acceptance, verified playable in a headless browser; [acceptance record](docs/codex-windows-smoke.en.md)
  - macOS unverified; built-in status `research`
- **M13 — Skill docs alignment + release automation fixes + v0.3.1** (2026-09-12, see [release-v0.3.1.en.md](docs/release-v0.3.1.en.md))
  - Self-installed skill docs (SKILL.md / usage-examples.md) rewritten item by item against the v0.3.0 tool surface (codex GUI params, needs_user handling, verify/list usage)
  - Bilingual release bodies, Full Changelog & CI link fixes, and automated Gitee releases
- **M14 — Codex wait-user detection + cancel truly stops the GUI + v0.3.2** (2026-09-12, fixes issues #5 / #6, see [release-v0.3.2.en.md](docs/release-v0.3.2.en.md))
  - Issue #5: Codex parked on a "waiting for user confirmation" screen no longer dead-locks in `running` — with the stop button visible and the conversation hash unchanged for `gui.stallTimeoutMs` (default 5 min), the task turns `needs_user(user_confirmation)`; added a configurable `gui.selectors.userGate` UI gate; `continue_task` now supports codex (`user_confirmation` re-observes / `login_required` re-dispatches)
  - Issue #6: `cancel_task` for GUI agents clicks the in-app stop control over CDP and bounded-waits (`gui.cancelWaitMs`, default 15s) for the GUI to go idle before recording `cancelled`; dispatch-time liveness checks reject with `instance_busy` when a managed instance is still running, preventing overlapping turns
- **M15 — ZCode 3.11.2 adaptation + fail-closed acceptance engine + v0.3.3** (2026-09-12, fixes issues #4 / #7, see [release-v0.3.3.en.md](<docs/release-v0.3.3.en.md>)) — **366 tests**
  - Issue #4: the model menu supports both `group-provider` and 3.11.2 `group-family` groups, selecting flat models directly first with group expansion as a fallback; project binding now keys on the composer's `menuitemcheckbox` with read-back checking trigger text + full path and up to two idempotent retries; stale workspace menus are dismissed before adding a project
  - Issue #7: a test check that exits 0 but reports zero executed tests fails; git projects must produce changes relative to the pre-work baseline by default (opt out with `requireChanges: false`) — zero tests and zero changes no longer pass silently
  - `{PROGRAMFILES}` placeholders normalized to uppercase and environment-variable expansion made case-insensitive
- **M16 — ZCode project/model read-back hardening + shared-deadline initialization recovery + anchorless session dispatch confirmation + v0.3.4** (2026-09-13, fixes issues #8 / #9 / #10, see [release-v0.3.4.en.md](<docs/release-v0.3.4.en.md>)) — **407 tests**
  - Issues #8 / #10: project triggers resolve tier by tier (explicit override → primary selector → exact fallback) and stop on ambiguity at the current tier; binding keys on the normalized absolute project path; stale menus are dismissed before adding a project, and native-operation timeouts reconcile side effects instead of replaying the whole import
  - Issue #9: environment recovery without a session re-sends the full original task / context / validated references, and the environment confirmation text is never sent to the model; dispatch confirmation and session identification share one bounded observation window (default 60s), preferring the task marker and falling back to a unique new-session delta, keeping a `session_lost` / `send_unknown` scene without automatic resend
  - Model read-back decodes stable attributes and excludes hidden / transparent / clipped outgoing values; initialization shares one deadline budget (120s total, 30s probe, 60s operation, 2 retries); macOS probe failures are fail-closed instead of masquerading as an empty sheet baseline
- **M17 — macOS GUI drivers for codex/zcode + projectPath safety gate + engineering performance + v0.4.0** (2026-09-13, from PR #11) — **443 tests**
  - **macOS wired up**: both `codex` (spawn .app + CDP) and `zcode` (process-title-rewrite adaptation + macOS window-form panel driving) GUI basic closed loops machine-verified (discover → bind → send → run evidence → acceptance PASS → `succeeded`); macOS stays `research` until the cancel/rework/continue_task/new-project matrix is covered
  - **codex-cli headless path**: on macOS, run `codex exec` via a `driver=spawn` user profile (⚠️ ≤0.130.0 is signed with a revoked certificate — use ≥0.154.0) — see "macOS headless path: codex-cli"
  - **projectPath safety gate**: realpath canonicalization + home/system-root rejection + dirty-repo coexistence warning — see "Path safety gate"
  - **Fixes**: `get_profiles` missing user-defined profiles; zcode macOS `needsPermission` false positives; `normalizeProjectPath` symlink ambiguity; CDP polling now reconnects across renderer replacement/transient hangs
  - **Engineering**: all `execFileSync`/`spawnSync` calls async (no more event-loop freezes during Windows polling); bounded-parallel acceptance checks (`verifyConcurrency`); test suite 267s → 51s
- **M18 — skill docs aligned with the v0.4.0 tool surface + contributor credits + v0.4.1** (2026-09-13) — **443 tests**
  - `skills/tianshu-mcp/` now covers every v0.3.3 → v0.4.0 tool-surface change: the projectPath safety gate, the hard-failure error-code reference, the `setup_recovery` wait kind, the codex-cli headless path, `ready`/`research` status semantics, default-parallel-2 acceptance and the `requireChanges` gate; usage-examples adds the error-code table, the full meta field table, a project-level acceptance-config template and a `codex-cli` example
  - Bilingual README gains a contributor credits section (avatar + name, in order of first participation)
  - **No code behaviour changes**; no migration needed
- **M19 — optional visual acceptance module + v0.5.0** (2026-09-14) — **486 tests**
  - **Page screenshot comparison**: three mutually exclusive page sources (existing service / command startup / temporary static host), three capture modes, declarative interaction steps, stabilization sampling with explicit masks, pixelmatch antialiasing exclusion and connected-region annotation; size mismatches fail directly
  - **Static image specifications**: encoded-format/extension consistency, complete decoding, EXIF-orientation-normalized dimensions, aspect ratio/byte size/DPI/real transparent pixels; unsupported formats reported explicitly
  - **Two-phase baselines and freezing**: candidate preparation → user approval; a missing baseline never passes; automatic repair may not approve; configuration and baseline digests are frozen before the agent starts and checked every round
  - **MCP/CLI**: new `prepare_visual_baseline` / `approve_visual_baseline` and the `tianshu-mcp visual` subcommand family, dispatched before the stdio connection
  - **Reports and recovery**: `VerifyReport` gains an optional `visual` section and offline HTML (status filter, opacity overlay, region location); visual blockers enter `needs_attention` and `rework_task` re-verifies first so only real defects consume repair budget
  - **Gates**: CI adds a four-system, three-Node real-browser matrix plus isolated production-package consumer acceptance; release requires a successful CI for the target commit and blocks when Gitee credentials are missing rather than claiming success
- **M20 — skill/validation docs aligned + platform evidence archived + v0.5.1** (2026-09-14) — **486 tests**
  - Skill docs aligned item by item with the code: a full 11-tool table with capability/approval columns, visual acceptance given its own section, `setup_recovery` added to the error table, and fixes to agent status semantics plus the `get_task_report`/`repair-plan` doc drift
  - Visual acceptance platform evidence archived: Windows 10 local full functional matrix **9/9** (`npm run evidence:visual:windows`), and macOS 15 hardware Intel x64 plus Apple Silicon arm64 with 10 files / 51 cases each
  - Fixed the stale `package-lock.json` root version (was `0.4.1` at v0.5.0)
  - **No runtime behaviour changes**; no migration needed
- **M21 — project-less dispatch for ZCode (issue #12) + v0.5.2** (2026-09-14) — **525 tests**
  - `run_task.projectPath` became optional: when omitted, ZCode runs the task in its `default` (no-project) workspace — no project registration/import, no Git baseline, no project snapshot, no project lock and no project acceptance; the terminal state is structured as `not_applicable: no_project` (see the [v0.5.2 release notes](<docs/release-v0.5.2.en.md>))
  - New ZCode-only optional parameter `allowCreateProject`: with `false`, an unregistered target directory stops dispatch before any import side effect and returns `project_not_registered`
  - Unified the ZCode project-trigger readiness criteria (not mounted / mounted but invisible or clipped / not unique / disabled / covered / ready) and added `gui.projectTriggerTimeoutMs` (15s default), fixing misleading error messages
  - Two defects found and fixed on hardware: `projectPath` not relaxed at the MCP schema layer, and the missing "work outside a project" switch; Windows 10 hardware acceptance evidence added
- **M22 — ZCode hardware-revisit fixes (issue #12, second round) + v0.5.3** (2026-09-15) — **532 tests**
  - Fixed ZCode / Codex desktop instances on Windows failing to **outlive the server exit**: all three GUI instances now share `guiInstanceSpawnOptions()` (unconditional `detached` + `unref`), where the previous Windows branch let the MCP server's exit kill the GUI along with it
  - Fixed the top-bar "new task" click reporting success without switching pages and then waiting silently for 30 seconds: the draft is now verified by "the project trigger is mounted", falling back to the sidebar `task-new-button`, and failing closed with `setup_failed` only when both entry points fail
  - Fixed misleading attribution when a covered window fails to send: Chromium throttling (`visibilityState=hidden`) is recognised and reported as "the window is not in the foreground" with instructions to bring it forward
  - A **PATCH** release; existing caller signatures and report formats remain **backward compatible** (see the [v0.5.3 release notes](<docs/release-v0.5.3.en.md>))
- **M23 — Visual acceptance phase 2, "AI visual content validation" (issue #13) + v0.5.4** (2026-09-16) — **644 tests**
  - **Content-check dimension**: `visual.contents[]` (image content rules) and `pages[].content` (page semantics) run in parallel with the existing pixel/spec checks and land in the unified report and offline HTML as independent `kind:"content"` results; a `pages[].pixel:false` semantic-only page is exempt from baselines
  - **Zero credential management**: the MCP reads, stores, and forwards no keys and ships no model client; judgement is fully delegated to a user-supplied command (placeholder template + JSON on the last stdout line), and the expectation travels through a temporary file to avoid command-line escaping and audit logs
  - **Debouncing and gates**: majority sampling plus a task-level input-hash cache (the key includes the command's binary identity, so upgrading your CLI invalidates it); a new `uncertain` status neither fails nor triggers rework when votes split or confidence falls below `minConfidence`; content items **warn only** by default, upgrading to failing per rule via `blocking:true`
  - **Fail-closed**: once enabled, an unresolvable command or a missing env reference yields a whole-round `configurationError` with no result rows; a single command failure produces only a blocked warning item that stays visible in the round message and in the repair plan's "warning-only items (no fix required)" section
  - **Defect fix**: the repair plan no longer lists `optional:true` failures as "must fix"
  - **CLI/diagnostics**: added `visual content probe <project> [ruleId]` and `visual content cache clear <taskId>`; `visual doctor` gained content-command resolution and budget-comparison findings
- **M24 — Kimi Code GUI adapter (fourth GUI agent) + v0.5.5** (2026-09-20) — **764 tests**
  - **Dual-renderer CDP driver**: the model / thinking-tier / execution-mode menus render in the separate `Kimi Browser Overlay` window while the workspace menu and the "switch model" dialog stay in the main window
  - **Full-path workspace binding**: an unregistered directory is imported through the native "add workspace" dialog (Win32 coordinate clicks plus `WM_SETTEXT`/`WM_GETTEXT` read-back), and same-name/different-directory cases fail closed
  - **Three-stage model selection and tier validation**: pill read-back → overlay shortcut menu → "more models…" dialog; tiers are validated against **the set the UI actually renders** (official models `低/low`, `高/high`, `max`; unofficial models only `on`/`off`), and a tier the UI does not render fails before sending
  - **Run detection and recovery**: `button.stop` / `send.is-starting` are the authoritative signals; the six `needs_user` kinds recover via `continue_task`, and an uncertain send is never repeated
  - See the [Kimi Code guide](docs/kimi-cdp.en.md) and the [v0.5.5 release notes](<docs/release-v0.5.5.en.md>)
- **M25 — Qoder CN GUI adapter (fifth GUI agent) + v0.5.6** (2026-09-22) — **826 tests**
  - **Installation discovery and instance reuse**: explicit `gui.exePath` → D-drive-first candidates → relative-path templates → standard directories, with Qoder CN identity checks; an existing instance without usable CDP is preserved in place and turned into `needs_user`, never closed or restarted
  - **Workspaces and models**: full-path binding, with unregistered directories imported through New Task → Workspace → New Workspace → Add Read/Write Folder; `modelSource=default/custom` disambiguates cross-group name clashes; the thinking tier is saved in Model Management as a **global preference** and read back by reopening it, and an unsupported tier fails before sending
  - **Send and answer checkpoints**: a checkpoint is written before sending the brief or submitting multi-question answers, and an unconfirmed receipt means observe-only, never an automatic resend; `continue_task` only reobserves for approval/login environment waits
  - **Liveness and same-session repair**: completion must belong to this turn's user message (old replies, a static screen, and disconnects never qualify); both automatic and manual repair write the plan first, then send its filename, full path, and complete text to the original conversation
  - **Platform boundary**: the Windows hardware loop passed (default/custom models, a newly registered workspace, and controlled failure → plan → same-session repair → re-acceptance); macOS is `research` and fail-closed
  - See the [Qoder CN guide](docs/qoder-cdp.en.md) and the [v0.5.6 release notes](<docs/release-v0.5.6.en.md>)
- **M26 — Orchestration skill docs rewritten against the code + v0.5.7** (2026-09-22) — **826 tests** (no runtime change)
  - **Parameter compatibility matrix**: `projectPath`/`model`/`modelSource`/`reasoningLevel`/`mode`/`planDoc`/`designSystem`/`allowCreateProject`/`continue_task` across the five built-in agents, stating plainly that a wrong parameter is rejected
  - **Default precedence**: `autoVerify` (on by default at the server level), `autoFixRounds` (codex 5 / zcode 2 / kimicode 2 / qoder 3) and `taskTimeoutMs`
  - **Kimi Code tier domain corrected** (`低/low`, `高/high`, `max`, `on`, `off` — deliberately without `中`/`medium`) and the qoder section completed (`modelSource` disambiguation, tier saved then read back, checkpoints that prevent resends, repair writing a plan before sending its full text, macOS dispatch disabled)
  - **New `needsUserKind` × agent × `continue_task` matrix** and an `agentEndReason` → terminal-state mapping, plus `project_not_registered`/`unsupported_platform`/`qoder_error` and the new meta fields
  - See the [v0.5.7 release notes](<docs/release-v0.5.7.en.md>)
- **M27 — The four primary documents rewritten against the code + packaging fix + v0.5.8** (2026-09-23) — **826 tests** (no runtime change)
  - **Item-by-item audit of the four primary documents** (bilingual README / HANDOFF / bilingual ARCHITECTURE): corrected the **acceptance stage order** (the built-in `git-diff-check` runs before the configured checks and the visual stage after them), the fact that **`visual.enabled=false` still freezes and compares snapshots**, and the **tool result contract** (the two baseline tools and every error result carry no meta block either)
  - **All five agent tables now include Qoder CN** (driver list, `endReason`, `needsUserKind`, cancellation capability, registry discovery branches, instance lifecycle), noting that Qoder CN is the only adapter able to emit all six wait kinds and that it **never emits `idle_timeout`**
  - Corrected the Kimi Code tier domain, the test baseline (826 passed / 12 skipped across 81 files) and the runtime dependency licence table (Apache-2.0 / ISC), and added a callout for **declared-but-unused profile fields**
  - **Fixed a distribution gap**: `scripts/probe-traework.mjs` was not shipped although the docs tell users to run it → added to `files`, plus the missing `probe:traework` / `probe:zcode` / `probe:codex` scripts
  - See the [v0.5.8 release notes](<docs/release-v0.5.8.en.md>)
- **M28 — Truthful GUI terminal state (server exit / restart archiving) + v0.5.9** (2026-09-23) — 9 new unit cases + 5 new integration cases (issue #14)
  - **No more false claims**: a GUI agent is an external desktop application and the server owns no process for it, so `persistInterrupted()` and `initialize()` now branch honestly on `guiStop` (confirmed / unconfirmed / no stop result) and **never** write "the process has been terminated", which only holds for spawn children
  - **Bounded wait**: the new `shutdown.guiStopWaitMs` (15 s default, one shared budget) lets the best-effort stop finish before the terminal state is written; both branches of `abortTerminal()` now persist `guiStop` plus the structured fields, and the window name is derived from `profile.displayName`
  - **Manual acknowledgement entry point**: new `TaskMeta.interruptedCleanStop` / `guiResidualUnconfirmed` and the meta-block `guiStopUnconfirmed`; calling `cancel_task` on a terminal GUI task clears the pending marker (no new tool, terminal status unchanged)
  - See the [v0.5.9 release notes](<docs/release-v0.5.9.en.md>)
- **M29 — Idempotency keys for dispatch and verification + v0.5.10** (2026-09-23) — 16 new unit cases + 8 new integration cases (issue #15)
  - **No duplicated side effects**: a same-key `run_task` retry always returns the original `taskId` and current meta (terminal tasks included — read-only, never re-dispatched); `verify_task` answers a running pass with a success result plus `idempotencyReplay: "in_progress"` and returns the existing report and round once finished, **re-running no** `build`/`e2e`/deploy check
  - **Fail-closed and honest disclosure**: the same key with different arguments errors while reporting the original record id; a failed mapping write still returns the dispatched task but states that it cannot be replayed by key; a crash between "mapping written" and "task created" is treated as not-yet-effective and re-dispatched
  - **Persistence and observability**: `<data-dir>/idempotency.json` (atomic writes + TTL/capacity pruning, effective across restarts), configurable `idempotency.ttlMs` / `maxEntries`, new meta fields `idempotencyKey`/`idempotencyReplay`/`projectActiveTask`, and an event-stream note keyed by digest only
  - **Protocol-level completion**: `tools/list` reports `idempotentHint: true` for the two tools (only meaningful when the caller supplies a key); without a key `run_task` still names the unfinished task in the same workspace
  - See the [v0.5.10 release notes](<docs/release-v0.5.10.en.md>)
- **M30 — Skill self-install hardening (source location / overwrite semantics / tri-state & backup governance) + v0.6.0** (2026-09-23) — 30 new unit cases (issue #16)
  - **Source location tightened**: the skill source is located relative to the package via `import.meta.url` only; **both `process.cwd()` candidates were removed** (content is never discovered from the current working directory, closing the "poisoned while debugging inside a third-party repo" supply-chain surface). When no source is found, the existing skip-with-warning path is kept
  - **Distinguishing a "stale package copy" from "your local edits"**: the target now carries a manifest `<dest>/.tianshu-mcp-install.json` (version + content hash, with the manifest itself and platform noise such as `.DS_Store` excluded from the hash). Auto-upgrade happens **only when the copy is provably untouched**; detected local edits or an unknown source are **kept with a loud warning** (plus two remediation paths)
  - **Tri-state and a new entry point**: `skills.autoInstall` becomes `true | "prompt" | false` (backwards compatible with the existing boolean); `--approve-skill-update` / `TIANSHU_MCP_APPROVE_SKILL_UPDATE=1` is a non-interactive approval channel (it does not apply to confirmed local edits); new `skills.backupKeep` (default 3)
  - **Atomic install and log levels**: "tmp dir → backup → swap in", with rollback on failure so no half-copied tree remains; skip = INFO, overwrite/keep/unknown-source/failure = WARN; after an overwrite, historical `.bak-<timestamp>` directories are pruned to `backupKeep`
  - **Gates**: the strict stdio check gains `skill-locally-modified` / `skill-approve-update` scenarios (6→8); Windows 10 real-machine verification R1–R7 recorded in the [issue-16 record](docs/issue-16-skill-install-hardening-record.md)
  - See the [v0.6.0 release notes](<docs/release-v0.6.0.en.md>)
- **M31 — Small-fixes sweep (comment & count alignment / capability tri-family / registration failure stops dispatch / system-directory subtree denial / splitCmd docs) + v0.6.1** (2026-09-23) — 42 new cases (issue #17)
  - **System directories now denied by subtree**: `/etc` `/usr` `/bin` `/sbin` `/private/etc` plus `c:/windows` and `c:/program files*` moved from exact-equality to **boundary-aware subtree denial** (`c:/windows.old` and `/etcetera` are not falsely matched). `/var`, `/tmp` and the home directory stay exact-match (`/var/folders/...` on macOS *is* `os.tmpdir()`, so a blanket subtree rule would sever the test base and many legitimate workspaces). The decision is a platform-injectable pure function `isDangerousProjectDir`, so all three platform shapes are verifiable on any OS
  - **`capability` collapsed to three families**: the never-used `"network"` value is removed; `verify_task` moves from `read` to **`execute`** (it runs project commands and may produce build artifacts, so it never was read-only) — so its `readOnlyHint` flips from `true` to `false`, **but it still needs no approval** (`requireApproval` stays false; the R11 conclusion is unchanged). A new **truth-table test** covers all 11 tools × capability × four annotations
  - **Project registration failure now stops dispatch**: `run_task` no longer discards the `registerProject` return value (previously `void registered;` was followed by a redundant `projectByPath` re-read); a registration failure logs WARN and returns a structured `isError`, eliminating the "task created but project unregistered" half-state
  - **`cmd` string form documented**: the bilingual docs and the schema/source comments state "prefer the array form; the string form **supports no escaping**, an unclosed quote does not error, and a typo silently splits into multiple argv". Five boundary cases pin the existing tokenizer semantics (no behaviour change)
  - **Counts and scenario numbers aligned**: the "9 tools" header comment in `protocol.test.ts` is corrected to 11 and a `TOOL_DEFS` count assertion is added; the "6 scenarios" references in `ci.yml` / `HANDOFF` / `CONTRIBUTING` (both languages) are synced to 8 (they lagged behind the two skill scenarios added in issue #16)
  - See the [v0.6.1 release notes](<docs/release-v0.6.1.en.md>); verification record in the [issue-17 record](docs/issue-17-small-fixes-record.md)
- **M32 — GUI selector version-drift fixes (codex / qoder / traework) + v0.6.2** (2026-09-23) — 26 new cases (issue #23)
  - **Codex**: the project-picker trigger copy drifts across versions (26.915 locally measured "切换项目", 26.917 "选择项目"); primary+fallback now cover both, and `boundProjectName` reads both back. A new `probe-codex.mjs audit` prints a hit table for all 20 keys — **on local 26.915 there is no drift other than this trigger**
  - **Qoder**: selectors upgraded from flat strings to a layered structure matching Codex (27 keys with `verifiedVersion`). **The hardware re-probe corrected the issue's conclusion**: on 0.3.4 the workspace menu **does render** — the real cause was **two** `[data-workspace-picker-trigger]` elements breaking the single-match click. Switching to the unique `button[aria-label^="切换或清空当前工作区"]` makes the production `bindWorkspace` pass on real 0.3.4
  - **TraeWork**: added `discovery.ts` (fixed-drive enumeration + registry + relative paths) and fixed the built-in dir (`{APPDATA}/TRAE SOLO CN` is actually the **user-data dir**, not the install location). On Windows the executable name is narrowed to `TRAE SOLO CN.exe` (the old list's `Trae CN` mismatched the unrelated TraeCode CN product); a port-not-ready path now prints diagnostics (exit code / port listeners / existing instances) — **diagnosis only, no launch-strategy change**
  - **Unified diagnostics**: new `src/agents/gui-diagnostics.ts` appends the nearest visible page candidates to selector-resolution failures across all three GUI agents
  - See the [v0.6.2 release notes](<docs/release-v0.6.2.en.md>); verification record in the [issue-23 record](docs/issue-23-selector-drift-record.md)

## Agent support status

Qoder CN uses `agentId="qoder"` and requires an existing `projectPath` plus a readable `planDoc`. Optional `modelSource="default"|"custom"` identifies the model group. Omitted model or reasoning settings retain current values. Model Management saves reasoning preferences globally; permission mode is unchanged. See the [Qoder CN guide](docs/qoder-cdp.en.md) for usage, question answers, and recovery.

| agentId | driver / adapter | status | Notes |
|---|---|---|---|
| `codex` | `gui` / `codex-gui` | **ready** (`research` on macOS) | Desktop GUI over CDP (Windows: MSIX COM activation; macOS: spawn .app binary + CDP); supports `model`/`reasoningLevel`/`planDoc`/`designSystem`; wait-user, cancel and dispatch-guard semantics machine-verified (v0.3.2); Windows machine-verified; macOS basic closed loop machine-verified (v0.4.0) — stays `research` until the cancel/rework matrix is covered |
| `zcode` | `gui` / `zcode-gui` | **research** | CDP GUI adapter with the Windows hardware loop passed; adapted to ZCode 3.11.2 model menu and project binding (v0.3.3), with hardened project/model read-back and initialization recovery (v0.3.4); supports project-less dispatch and `allowCreateProject` (v0.5.2, issue #12), and v0.5.3 fixed instance survival across server exit, new-task page switching and send-failure attribution; macOS basic closed loop machine-verified (2026-09-13, v0.4.0) — stays `research` until the cancel/rework/new-project matrix is covered |
| `traework` | `gui` / `traework-gui` | **ready** | CDP-driven TRAE SOLO CN desktop UI; all three panel modes machine-verified |
| `kimicode` | `gui` / `kimicode-gui` | **ready** (`research` on macOS) | Kimi Code desktop (Electron, measured 1.0.2); **two renderer processes** (main window + `Kimi Browser Overlay` carrying the model/tier/mode menus); workspaces bind by full path and unregistered ones are imported through the native "add workspace" dialog; supports `model`/`reasoningLevel` and rejects `mode`; Windows machine-verified for the success path, unregistered-workspace import + auto-acceptance, and the failure → rework → re-acceptance same-session loop; cancellation/question answering are covered by hermetic integration tests only, and macOS stays `research` and fail-closed |
| `qoder` | `gui` / `qoder-gui` | Windows real GUI loop passed; macOS **research** | Qoder CN only; full-path workspaces, unregistered directories imported via New Workspace + the native folder picker, default/custom models, global reasoning readback through Model Management, same-session answers and rework; Windows machine-verified for default-model development in an existing workspace, custom-model development in a newly imported workspace, and the controlled failure → plan → same-session repair → re-acceptance loop; macOS is `research` and fail-closed (dispatch disabled) |
| `stub` | `spawn` | tests only | `test/stub-agent/stub-agent.mjs` with 3 playbooks (good/fix-on-first/never) |

> Adding an agent usually needs only a profile — see [docs/agent-profiles.en.md](docs/agent-profiles.en.md) and [CONTRIBUTING.en.md](CONTRIBUTING.en.md).

## macOS headless path: codex-cli (user profile)

The built-in `codex` drives the desktop GUI; the macOS channel is now wired up (spawn .app + CDP, basic closed loop machine-verified — see "Agent support status") and stays `research` until the cancel/rework matrix is covered. If you'd rather not depend on GUI automation, **the headless Codex CLI works end-to-end on macOS** — no server changes needed: add a `driver=spawn` user profile in the data directory (these are the M2-finalized arguments used by the built-in codex before v0.3.0).

Prerequisites:

- Codex CLI (`npm i -g @openai/codex`). ⚠️ **Keep it current**: ≤0.130.0 is signed with a revoked certificate — macOS Gatekeeper SIGKILLs it at exec (`Killed: 9`); ≥0.154.0 is verified working.
- Signed in via `codex login` (reuses the `~/.codex` login state).

`~/.tianshu-mcp/agent-profiles.json`:

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
      "authNote": "Reuses ~/.codex login state; do not combine with --approve-for-me (mutually exclusive, machine-verified)",
      "executableDiscovery": {
        "dirs": ["/opt/homebrew/bin", "/usr/local/bin"],
        "fileNames": ["codex"],
        "fallbackCommand": "codex"
      }
    }
  }
}
```

Usage is identical to built-in agents:

```text
run_task(projectPath=/path/to/project, agentId=codex-cli, task="task brief", autoVerify=true, autoFixRounds=2)
```

Behavior and limits:

- `get_profiles` lists `codex-cli` and probes the `codex` executable on PATH (from the unreleased build onward; before that, user-defined profiles worked but were not displayed).
- The `model` parameter has no effect on spawn agents — the CLI uses the default model from `~/.codex/config.toml`; to pin one, append `"-m", "<model>"` to `argsTemplate`.
- Writes are confined to the project directory by the `workspace-write` sandbox; on POSIX, cancel/timeout SIGTERM→SIGKILLs the process group (the `killTree` value is ignored off Windows).
- Machine-verified: 2026-09-13 macOS arm64 closed loop (`run_task` → `codex exec` → acceptance PASS → `succeeded`).

## Recommended phrasing (for Tianshu)

> "In project D:\xxx, implement 『task』 with codex. First run run_task(autoVerify:true, autoFixRounds:2), then check with query_task; if the report says needs_attention, feed the failed items from get_task_report as feedback into rework_task and verify again; when everything passes, report changedFiles and diffstat."

> "In project D:\xxx, use traework with mode=Code to implement 『task』; it switches to Code mode first, then binds the project, sends the task, auto-verifies, and on failure generates a repair plan and reworks."

## Contributing

| Document | Content |
|---|---|
| [CHANGELOG.en.md](<CHANGELOG.en.md>) | Version history (v0.1.0 → v0.5.10) |
| [CONTRIBUTING.en.md](CONTRIBUTING.en.md) | Dev setup, conventions, commit/release flow, adding an agent |
| [SECURITY.en.md](SECURITY.en.md) | Security model (zero credentials / command whitelist / process & desktop-automation boundaries) and private reporting |
| [CODE_OF_CONDUCT.en.md](CODE_OF_CONDUCT.en.md) | Contributor Code of Conduct |
| [LICENSE](LICENSE) | Apache License 2.0 (detailed explanation below) |

- **Primary repository**: <https://github.com/lanlan0811/tianshu-mcp> (GitHub)
- **Mirror repository**: <https://gitee.com/lan0811/tianshu-mcp> (Gitee)
- **Feedback**: bugs / feature requests via the repo Issue templates; report security vulnerabilities privately per [SECURITY.en.md](SECURITY.en.md) — **do not** open a public issue.

### Contributors

Thanks to the community members below who contributed through Issues and pull requests (listed in order of first participation):

<table>
  <tr>
    <td align="center"><a href="https://github.com/liuchsong"><img src="https://github.com/liuchsong.png" width="72" height="72" alt="liuchsong" /><br /><sub>liuchsong</sub></a></td>
    <td align="center"><a href="https://github.com/a13612745638"><img src="https://github.com/a13612745638.png" width="72" height="72" alt="a13612745638" /><br /><sub>a13612745638</sub></a></td>
    <td align="center"><a href="https://github.com/king195547"><img src="https://github.com/king195547.png" width="72" height="72" alt="king195547" /><br /><sub>king195547</sub></a></td>
  </tr>
  <tr>
    <td align="center"><a href="https://github.com/zhaoxc857"><img src="https://github.com/zhaoxc857.png" width="72" height="72" alt="zhaoxc857" /><br /><sub>zhaoxc857</sub></a></td>
    <td align="center"><a href="https://github.com/jian-in"><img src="https://github.com/jian-in.png" width="72" height="72" alt="jian-in" /><br /><sub>jian-in</sub></a></td>
    <td align="center"><a href="https://github.com/huiliyi37"><img src="https://github.com/huiliyi37.png" width="72" height="72" alt="huiliyi37" /><br /><sub>huiliyi37</sub></a></td>
  </tr>
</table>

> Chinese counterparts: see [README.md](README.md). The handoff document [HANDOFF.md](HANDOFF.md) is Chinese-only.

## License

This project is released under the **Apache License 2.0**; the full legal text is in [LICENSE](LICENSE). Copyright belongs to the tianshu-mcp contributors (Copyright 2026 tianshu-mcp contributors).

### Rights granted to you

- **Commercial use**: use it in commercial products and services;
- **Modification**: modify the source freely;
- **Distribution**: redistribute the original or modified versions;
- **Private use**: use it privately inside your organization;
- **Patent use**: contributors grant you a license to any patents covered by their contributions (subject to the termination clause below).

### Obligations you must meet

1. **Keep the notices**: when distributing, include the full LICENSE text and retain its copyright, license, and disclaimer notices;
2. **Mark modifications**: if you modify files, carry a prominent "modified" notice in the changed files;
3. **Preserve NOTICE**: if the original work includes a NOTICE file, retain its contents when distributing (this project currently has **no** NOTICE file);
4. **No additional restrictions**: you may not impose further restrictions on the rights granted by this license.

### Not granted / termination

- **Trademarks**: this license does **not** grant any right to use trademarks, trade names, or service marks;
- **Patent termination**: if you institute patent litigation against this project or its contributors (including cross-claims and counter-claims), your patent grant under this license **terminates automatically**.

### Disclaimer

The software is provided **"AS IS"**, without warranties or conditions of any kind, either express or implied, including but not limited to the implied warranties of merchantability, fitness for a particular purpose, and non-infringement. In no event shall the authors or copyright holders be liable for any claim, damages, or other liability arising from, out of, or in connection with the software or the use or other dealings in the software, whether in an action of contract, tort, or otherwise.

### Third-party dependency licenses

Runtime dependencies are licensed as follows (all permissive and Apache-2.0 compatible):

| Dependency | License | Purpose |
|---|---|---|
| [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/sdk) | MIT | MCP protocol implementation |
| [`zod`](https://github.com/colinhacks/zod) | MIT | External input validation |
| [`cross-spawn`](https://github.com/moxystudio/node-cross-spawn) | MIT | Cross-platform child processes |
| [`puppeteer-core`](https://github.com/puppeteer/puppeteer) | Apache-2.0 | Drives the headless browser for visual acceptance |
| [`@puppeteer/browsers`](https://github.com/puppeteer/puppeteer) | Apache-2.0 | Installs and version-locks the managed Chrome/Edge |
| [`pixelmatch`](https://github.com/mapbox/pixelmatch) | ISC | Page-screenshot pixel comparison |
| [`sharp`](https://github.com/lovell/sharp) (optional) | Apache-2.0 | Image decoding and spec validation; the visual module blocks explicitly when it is missing |

Development dependencies (TypeScript, ESLint, Prettier, Vitest, Vite, tsx, etc.) follow their own open-source licenses and are not distributed with the npm package.

### Relationship to the security boundary

This MCP **never stores, reads, or forwards** any AI-Agent API key or login state (see [SECURITY.en.md](SECURITY.en.md)). The license terms do not change this design boundary.
