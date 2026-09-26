# ARCHITECTURE.md — tianshu-mcp Architecture

> Applies to version `0.5.7` (2026-09-22).
> This document describes the **system structure and module boundaries** for developers who will modify this repository; the version marker is only bumped on release commits, and the latest release notes live in `docs/release-v<latest>.md`.
> This document describes the **system structure and module boundaries** for developers who will modify this repository.
> For installation, usage, and host integration see [README.en.md](README.en.md); for handover status, troubleshooting, and lessons learned see [HANDOFF.md](HANDOFF.md).
> Chinese version: [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 1. Positioning and system context

`tianshu-mcp` is an **orchestration layer that Tianshu consumes as a standard MCP server**. Tianshu is the commander and the user-facing surface; this server owns three things:

1. **Scheduling** — task queue, concurrency gate, state machine, timeouts, cancellation.
2. **Execution surface** — delivering the task brief to an external AI agent (Codex desktop, TraeWork, ZCode, or any CLI).
3. **Objective acceptance** — verifying against a git baseline with command checks, code analysis, and optional visual pixel comparison, then producing a report.

```text
┌─────────────────────────────────────────────────────────────┐
│ Tianshu (TUI × GUI)                                          │
│   · Calls tools/call synchronously, one call at a time,      │
│     consuming only content[].text and isError                │
└───────────────────────────┬─────────────────────────────────┘
                            │ MCP over stdio (stdout carries JSON-RPC only)
┌───────────────────────────▼─────────────────────────────────┐
│ tianshu-mcp (this repository)                                │
│   scheduling ── execution surface ── acceptance instrument   │
└──────────┬──────────────────────────────┬───────────────────┘
           │                              │
   ┌───────▼────────┐            ┌────────▼─────────┐
   │ External agent  │            │ Target workspace │
   │ GUI: drive UI   │            │ git repo + tests │
   │      over CDP   │            │ .tianshu-mcp/    │
   │ CLI: subprocess │            └──────────────────┘
   └────────────────┘
```

### 1.1 Four hard constraints and the architecture they forced

This project's shape is not a free design choice — it was forced by four **measured constraints**. Read this table before changing the architecture:

| # | Measured constraint | Architectural consequence |
|---|---|---|
| C1 | Tianshu's MCP tool call **returns text only**: `content[]` `text` items are concatenated and `isError` passes through | Every result is "human-readable text + a `---tianshu-mcp-meta---` JSON block"; no resources or prompts (`src/mcp/formatter.ts`) |
| C2 | Tianshu calls `tools/call` **synchronously, per call** | Long tasks must be async: `run_task` returns a `taskId` immediately and `query_task` polls. There is no server push |
| C3 | TraeWork agent requests are TDE-encrypted at the TTNet layer and cannot be constructed outside the client | The only viable path is **driving the desktop UI over CDP** and extracting results from the DOM (`src/agents/traework/`) |
| C4 | The Codex desktop app is an **MSIX store package**; a GUI host cannot `CreateProcess` it directly | It must be activated through `IApplicationActivationManager` COM with an injected dedicated `--user-data-dir` before a CDP port opens (`src/agents/codex/launcher.ts`) |

ZCode falls into the same class: it ships no headless CLI, so it is also CDP-driven (settled by measurement in M2).

---

## 2. Layered architecture

```text
┌──────────────────────────────────────────────────────────────────┐
│ L1 Protocol edge   src/index.ts · src/server.ts · src/mcp/        │
│   entry & CLI dispatch · assembly · 11 tool registrations          │
│   parameter validation · text+meta formatting                      │
├──────────────────────────────────────────────────────────────────┤
│ L2 Task domain     src/tasks/                                      │
│   state machine · per-project serial queue · global concurrency    │
│   gate · event-stream persistence · cancellation semantics         │
├──────────────────────────────────────────────────────────────────┤
│ L3 Orchestration   src/loop/                                       │
│   TaskOrchestrator: dispatch → verify → rework → re-verify;        │
│   round accounting and termination decisions                       │
├───────────────────────────────┬──────────────────────────────────┤
│ L4a Execution   src/agents/   │ L4b Acceptance  src/verify/      │
│   AgentAdapter contract       │                 src/visual/      │
│   CLI spawn / GUI CDP         │   git baseline · command checks  │
│                               │   code analysis · visual diff    │
│                               │   report artifacts               │
├───────────────────────────────┴──────────────────────────────────┤
│ L5 Foundation   src/config/ · src/util/                            │
│   zod schema · data home · hot reload · atomic writes · path       │
│   normalization · logging · skill self-install                     │
└──────────────────────────────────────────────────────────────────┘
```

Dependencies point **strictly downward**: L1 → L2 → L3 → {L4a, L4b} → L5. L4a and L4b do not depend on each other and meet only at L3. That is the most important decoupling boundary in the project: **"who does the work" and "how we judge the work" are two independently replaceable concerns**.

---

## 3. Startup assembly and lifecycle

### 3.1 Entry dispatch (`src/index.ts`)

```text
node dist/index.js                → stdio MCP server
node dist/index.js visual <cmd>   → visual acceptance CLI subcommands
                                    (dispatched before any stdio connection,
                                     so it never occupies the protocol stream)
```

- The data home is resolved by `resolveDataHome()`: env `TIANSHU_MCP_HOME` wins, otherwise `~/.tianshu-mcp`.
- The logger initializes to `<data home>/logs/`.
- Skill self-install can be disabled with `--no-skill-install` or `TIANSHU_MCP_NO_SKILL_INSTALL=1`; a "needs change but not auto-overwritable" directory (`autoInstall:"prompt"` or unknown source) can be approved with `--approve-skill-update` or `TIANSHU_MCP_APPROVE_SKILL_UPDATE=1` (see §3.4).
- Shutdown path: `SIGINT` / `SIGTERM` / stdin EOF / stdin close → archive active tasks and terminate child processes → `exit(0)`.

### 3.2 Assembly order (`src/server.ts`)

`buildServer()` is the single assembly point, and its order carries meaning:

```text
resolveDataHome → Logger → DataHome(BUILTIN_PROFILES) → init()
  → loadConfig() → maxRunning
  → TaskStore → AgentAdapterRegistry(loadProfiles) → AcceptanceEngine
  → TaskManager(+makeBuildCtx) → manager.initialize({maxRunning, guiStopWaitMs})   # archive leftover active tasks
  → skill self-install (background, does not block the handshake)
  → register 11 tools → return ServerAssembly{server, manager, dataHome, store, logger, close}
```

`close()` = `manager.shutdownInterrupt()` (archive active tasks, terminate child processes) → `engine.close()` → `server.close()`.

Tool registration is **data-driven**: it walks `TOOL_DEFS`, looks up each name in `handlers`, logs an error and skips if missing, and passes along `_meta.requireApproval`, `_meta.capability`, and the MCP `annotations` (readOnly / destructive / openWorld / idempotent — `idempotentHint` is true only for `run_task` / `verify_task`, and only means anything when the caller supplies `idempotencyKey`; see §5.6) for the host's policy layer.

### 3.3 Data home layout

```text
<data home>/                      default ~/.tianshu-mcp
├── config.json                   server config (concurrency, timeouts, skills)
├── agent-profiles.json           user-defined / overriding agent profiles
├── projects.json                 project registry (incl. per-project verify config)
├── idempotency.json              idempotency mapping (key→taskId/digest, TTL + capacity pruning; issue #15)
├── logs/server.log               all-level diagnostic log (same source as stderr)
├── browsers/                     managed Chrome for the visual module
├── visual-candidates/<uuid>/     pending baseline candidates (candidate.json + PNGs + preview.html)
├── visual-locks/<sha256>.lock    mutual exclusion for visual operations
└── tasks/<taskId>/               per-task isolated directory (below)
```

Per-task directory (`src/tasks/task-store.ts`):

| File | Contents |
|---|---|
| `task.jsonl` | Append-only event stream (the authoritative timeline) |
| `task.json` | Latest `TaskMeta` snapshot (atomic write) |
| `baseline.json` | Git baseline captured before work started |
| `agent-<round>.log` | Agent output (round is 0-based) |
| `verify-<round>.log` | Verification command output |
| `report-<round>.md` / `.json` | Acceptance report (`.md` for humans, `.json` for machines) |
| `report-<round>.html` | Offline visual report, **only when the report contains visual results** |
| `rework-<taskId>-r<round>.md` | Repair plan (non-Codex path) |
| `qoder-session.json` | Qoder CN send checkpoint (**Qoder only**, see §8.2) |
| `visual/<round>/<pageId>/<viewportId>/` | Visual quadruple: `actual/baseline/diff/regions.png` + `metrics.json` |
| `visual-snapshot.json` | Visual rules snapshot frozen for the task's duration |

Project-side artifacts: `<project>/.tianshu-mcp/acceptance.json` (project-level acceptance config), `<project>/tests/visual/baselines/...` (visual baselines), and for the Codex path `<project>/.zcode/plans/codex-fix-r<N>.md` (repair plan).

### 3.4 Trust and decision model of skill self-install (issue #16)

Module `src/util/skill-install.ts`, run **in the background** inside `buildServer()` (`void`, never blocking the handshake); failures only warn and never block the server.

**Source location**: resolved relative to the package via `import.meta.url` only (`<module>/../../skills/tianshu-mcp`) — a source run and a dist run have the same relative depth, so one candidate suffices. It **deliberately does not fall back to `process.cwd()`**: any cwd-based content discovery turns "debugging the server inside some third-party repository" into a poisoning surface. When no source is found, install is skipped with a warning.

**Install manifest**: kept inside the target at `<dest>/.tianshu-mcp-install.json` (`schema`/`name`/`packageVersion`/`contentHash`/`installedAt`/`sourceDir`, plus `pendingUpdate` when a `"prompt"` hold is recorded). `contentHash` comes from `hashSkillTree()`, which **excludes the manifest itself** (otherwise writing the manifest would prove the target changed) and platform noise (`.DS_Store`/`Thumbs.db`/`desktop.ini`/`._*`/`.git*`). Copying uses the same exclusion predicate, so "hash right after install" equals the source hash exactly (the root of idempotency).

**Decision matrix** (`decideInstall()`, a pure function separating decision from IO):

| Target state | Criterion | `auto` (default) | `"prompt"` | plus `--approve-skill-update` |
|---|---|---|---|---|
| Absent | — | install | install | install |
| Present, content == package | — | skip (repair/calibrate manifest if needed) | skip | skip |
| Manifest ok, content == manifest record ≠ package | untouched stale package copy (trusted) | **backup + overwrite** (warn) | keep + warn + `pendingUpdate` in manifest | **backup + overwrite** (warn) |
| Manifest ok, content ≠ manifest record | local edits (confirmed) | **keep + loud warn** | same | **same (approval has no effect)** |
| No valid manifest (missing/corrupt/not a dir) and content ≠ package | unknown source | **keep + warn** | same | **backup + overwrite** (warn) |

- With `skills.autoInstall: false`, `server.ts` short-circuits and never calls this module; `--no-skill-install` and `false` outrank the approval flag.
- An overwrite happens **only** in the "trusted stale copy" and "explicitly approved" cells; `--approve-skill-update` has **no effect** on confirmed local edits (your skill-document tuning is never silently clobbered).

**Atomic install**: `installFromSource()` follows "copy into `<dest>.incoming-<ts>-<hex>` (manifest included) → rename the old directory to `<dest>.bak-<ts>` → rename into place"; on failure it removes the tmp tree and rolls the backup back (a failed rollback only warns and the backup remains). Stale `.incoming-*` directories older than one hour are cleaned on startup.

**Log levels**: skip / manifest repair = `INFO`; stale-copy upgrade, local edits kept, unknown source, install failure = `WARN`. Searchable stable markers: `含本地修改`, `来源不明`, `未自动覆盖`.

**Backup governance**: after a successful overwrite, `skills.backupKeep` (default 3, `0` = never prune) prunes — matching only directories named exactly `<SKILL_NAME>.bak-<digits>`, keeping the newest N by timestamp and logging deletions at `INFO`; a failed delete only warns. The first-install and skip/keep paths never prune.

---

## 4. MCP tool surface and return contract

Eleven tools (`src/mcp/tools.ts`), split into three families: `read` (queries, no side effects), `write` (side effects, all require approval), and `execute` (runs project-side commands without modifying sources; currently only `verify_task`, still approval-free per R11):

| Tool | Capability | Approval | Purpose |
|---|---|---|---|
| `run_task` | write | yes | Dispatch work; returns a `taskId` asynchronously |
| `continue_task` | write | yes | Resume a `needs_user` task in its original session |
| `query_task` | read | no | Poll status / progress / log tail |
| `list_tasks` | read | no | Historical task list (filterable by project/status) |
| `get_task_report` | read | no | Full text of a given round's `report.md` |
| `cancel_task` | write | yes | Cancel (CLI: kill the process tree; GUI: best-effort stop click + bounded wait) |
| `verify_task` | **execute** | no | Run one verification over a task or project path: it runs project commands and may produce build artifacts, but **does not modify sources**, hence approval-free |
| `rework_task` | write | yes | Manual rework; feeds the failure summary back to the same agent |
| `get_profiles` | read | no | Agent support status and executable discovery results |
| `prepare_visual_baseline` | write | yes | Produce a baseline candidate and digest (does not adopt a baseline) |
| `approve_visual_baseline` | write | yes | After user review, check the digest and write the baseline |

> **`readOnlyHint` derivation**: `server.ts` emits MCP `readOnlyHint` from `capability === "read"`, so `verify_task` reports **false** for it (as of v0.6.1; it was wrongly `true` before). **`readOnlyHint` is not an approval signal** — approval is carried separately by `_meta.requireApproval`, which stays `false` for `verify_task`.

**Return contract** (`src/mcp/formatter.ts`): human-readable body plus a trailing meta block the host can extract with a regex.

```text
<human-readable text>
---tianshu-mcp-meta---
{ ...MetaBlockFields: taskId, status, ok, round, changedFiles, diffstat, ... }
---tianshu-mcp-meta---
```

**Validation happens in two stages**: `server.ts` first runs `inputSchema.safeParse()` for protocol-level validation (failures return `Error: 参数不合法 — <path>: <message>`); handlers then apply semantic gates, such as the `projectPath` safety check (absolute, exists, realpath-normalized, rejecting the home directory and root-level/system directories), rejecting `mode` for anything but TraeWork, and allowing `allowCreateProject` only for ZCode.

Progress is **persisted, never pushed**: GUI adapters report on the `gui.progressIntervalMs` cadence (default 30 s), `TaskOrchestrator` writes a `note` event into `task.jsonl` and refreshes the snapshot's `progressSummary` / `lastRunSignal`, and `query_task` reads the latest snapshot plus event stream on each call. A poller therefore sees the *last persisted* progress. Besides that free-text progress there is a **semantic** fine-grained event stream (`onEvent`, issue #18), see §5.8 — both are written into the same `task.jsonl`: `note` carries free text, fine-grained events carry node semantics.

---

## 5. Task domain: state machine, queue, persistence

### 5.1 State machine (`src/tasks/task.ts`)

```text
                        ┌──────────────────────────────┐
   run_task ──► queued ─┤──► running ──► verify_start ──┤──► succeeded
                 │      │      ▲            │          │──► failed
                 │      │      │            ▼          │──► needs_attention
                 │      │      └──── fixing ◄──────────┘
                 │      │
                 │      ├──► needs_user  ──► queued   (resumed by continue_task)
                 │      ├──► cancelled
                 │      └──► interrupted
                 └──► cancelled | interrupted
```

- **Statuses**: `queued, running, verify_start, fixing, succeeded, failed, needs_attention, needs_user, cancelled, interrupted`.
- **Terminal**: `succeeded, failed, needs_attention, cancelled, interrupted`.
- **Active**: `queued, running, verify_start, fixing`.
- **`needs_user` is neither active nor terminal** — it can be resumed to `queued` by `continue_task`, or cancelled. This is the host-visible form of a GUI agent waiting for a human.
- `TRANSITIONS` enumerates legal moves explicitly; `TaskStore.updateStatus` additionally guards that "a terminal state can only be re-entered by an explicit continue/rework".
- `errorType`: `timeout | spawn | agent_failed | verify_failed | cancelled | interrupted | agent_unresolved | internal`.

### 5.2 Persistence and crash recovery

Two writes with different jobs:

- **`task.jsonl` (authoritative event stream)**: append-only, with events such as `created / queued / started / verify_start / verify_round / fix_start / succeeded / failed / needs_attention / needs_user / continued / cancel_requested / cancelled / interrupted / timeout_killed / note`. Corrupt lines are skipped on read.
- **`task.json` (query snapshot)**: atomic write (temp file + rename) for fast reads and reconstruction after a crash.

Concurrent-write protection: `TaskStore` chains writes for the same task through `statusWriteTails` to prevent reordering, and `waitForStatusWrite()` is a **read barrier** ensuring a query or cancel never observes an in-memory terminal state before the JSONL event is flushed.

**Crash recovery archives rather than resumes.** `TaskManager.initialize()` scans leftover active tasks and marks them all `interrupted` with `abortSource="shutdown"`. Rationale: GUI sessions and child processes are gone once the server exits, so silently resuming would produce un-attributable half-finished work. Recovery must be an explicit human `rework_task`.

### 5.3 Queue and concurrency

| Mechanism | Rule |
|---|---|
| Global concurrency gate | `concurrency.maxRunning` (default 2, overridable by `maxRunningOverride`) |
| Per-project serialization | Queues are bucketed by `queueKeyOf()`: the normalized `projectPath` in project mode, and the constant key `__zcode_default_workspace__` in no-project mode (never `undefined` / `""`) |
| Scheduling | `pump()`: while `runningCount < maxRunning`, start one task for each project whose queue head is eligible; `projectBusy()` blocks a second concurrent task for the same project |
| Task timeout guard | Beyond the orchestrator's own deadline, `startTask` arms an extra `taskTimeoutMs + 15s` timer in case the orchestrator itself hangs |

### 5.4 Cancellation semantics (by state)

| State at cancel time | Behavior |
|---|---|
| `queued` | Removed from the queue → `cancelled` |
| `needs_user` | Directly → `cancelled`; the terminal message states plainly that the GUI-side waiting session was not stopped (the MCP side holds no CDP connection) |
| Active | `markCancelRequested` → abort → bounded poll for a terminal state (`CANCEL_SETTLE_TIMEOUT_MS = 30s`); returns `settled:false` when the stop is unconfirmed |
| Terminal | No cancellation action; if the task carries the GUI pending marker (`guiResidualUnconfirmed`) this call performs the **manual acknowledgement** instead (terminal status unchanged, see §5.5) |

Cancellation of a GUI agent is **best-effort and honestly reported**, but the adapters differ in what they can do:

| Adapter | Clicks the in-UI stop button on cancel? | Reports `guiStop`? |
|---|---|---|
| Codex / Kimi Code / Qoder CN | Yes — clicks stop over CDP and bounded-waits (`cancelWaitMs`) for the GUI to go idle | Yes (when `idle=false` the terminal message must admit the stop is unconfirmed) |
| ZCode / TraeWork | **No** — only stops MCP-side observation and keeps the instance | No (the terminal message states "no stop result to confirm") |

Shutdown (`shutdownInterrupt()`, issue #14): abort every controller → **spawn tasks keep their bounded 2 s wait per task, while GUI tasks wait until the shared `shutdown.guiStopWaitMs` (15 s by default) global deadline** → mark both `running` and `queued` as `interrupted`. A GUI task's terminal message branches honestly on `guiStop` (confirmed / unconfirmed / no stop result) and **never** claims "the process has been terminated", which only holds for spawn children.

### 5.5 GUI terminal-state facts and manual acknowledgement (issue #14)

| Field | Meaning | Written by |
|---|---|---|
| `TaskMeta.guiStop` | the GUI-side stop result `{clicked, idle}` of the most recent abort (persisted for **every** GUI agent) | `abortTerminal()` / run-result capture |
| `TaskMeta.interruptedCleanStop` | whether this interruption is **confirmed** stopped (true only when `guiStop.idle === true`) | `abortTerminal()` / `persistInterrupted()` |
| `TaskMeta.guiResidualUnconfirmed` | a GUI leftover archived on restart awaits manual confirmation (no connection exists at restart, so it is always set) | `initialize()`; cleared by `cancel_task` |
| meta block `guiStopUnconfirmed` | the single read-side predicate: `guiResidualUnconfirmed===true \|\| interruptedCleanStop===false` | `metaFromTask()` |

Decision matrix (the single implementation of red line 8, `guiStopDisclosure()`): `idle===true` → confirmed stopped; `idle===false` → a stop was attempted but is unconfirmed; **field absent → no stop result, and a stop must not be claimed either**.

The window name is derived from `profile.displayName` (`guiAppNameOf()`, stripping descriptive parentheticals and generic suffixes, falling back to the original string when stripping would empty it) instead of hard-coding `agentId`. **Explicitly not done**: `initialize()` never reconnects over CDP to click stop — there is no session anchor after a restart and the adapters are fail-closed for instances without proof of ownership, so unattended clicking carries more risk than value.

### 5.6 Idempotency keys: retry-safe dispatch and verification (issue #15)

`run_task` (both the project and project-less dispatch paths) and `verify_task` accept an optional `idempotencyKey`. The implementation lives in `src/tasks/idempotency.ts` (`IdempotencyIndex`) and is held by a closure inside `makeHandlers()` — it is **not** added to `AppContext`, so no construction site (including test fakes) has to change.

| Decision | Implementation |
|---|---|
| Namespaces | `run_task` / `verify_task` are independent (map key is `scope\u0000key`) |
| Argument digest | `canonicalDigest()`: stable serialisation (sorted object keys, `undefined` dropped) → same key with different arguments fails closed; the digest covers only the parsed arguments plus the normalised path, never runtime defaults or profile-derived values |
| Hit decision | `lookup()` returns `hit` / `conflict` / `miss`; an entry past its TTL is a miss and is pruned lazily |
| `run_task` hit | Always returns the original `taskId` and its current meta (terminal tasks included — read-only, never re-dispatched); a record whose task snapshot is unreadable counts as not-yet-effective and is re-dispatched |
| `verify_task` hit | Finished → returns the recorded `reportRound` / verdict / report paths (nothing re-runs); running → a success result with `idempotencyReplay: "in_progress"` (never `isError`) |
| Concurrency | `runExclusive()` serialises "re-check → write mapping → create task" per `(scope,key)`, so concurrent same-key calls never each create a task |
| Crash window | The mapping is written **before** the task is created inside the same critical section, which is why `TaskManager.submit()` accepts an optional `taskId` |
| Persistence | `<data home>/idempotency.json` (atomic writes, TTL and `maxEntries` pruning); a corrupt file is logged and rebuilt once from task snapshots via `TaskMeta.idempotencyKey/Scope/Digest` |
| Write failure | Fail-open: the dispatched task is still returned, and the response and meta state that it cannot be replayed by key |
| Key privacy | The raw key lives only in local snapshots and the mapping file; logs and event streams use `keyDigest()` (first 8 hex chars of sha256) |

**The "in progress" marker is process-local** (`reserveInFlight` / `releaseInFlight`): an unfinished verification is not cached across a restart (there is no report to return, so a retry honestly re-runs), which also prevents a mapping stuck at `in_progress` while the engine is long dead.

**Boundaries**: a `verify_task(taskId=…)` key is **not** written into the task snapshot (that field carries the task's dispatch key, so it is never overwritten), and rebuild coverage for that one combination relies on `idempotency.json`; no keys for `rework_task` / `continue_task` / `cancel_task` / the visual baseline tools; no cross-process distributed idempotency (the same assumption the visual lock makes).

### 5.7 Terminal-state notifications: webhook hook (issue #22)

For long tasks the caller previously had to babysit the UI. This capability asynchronously POSTs a JSON
body to a configured URL on state transitions.

| Decision | Implementation and rationale |
|---|---|
| The hook point is `TaskStore.updateStatus()` | It is the **single choke point** for state transitions. `TaskOrchestrator.finish()` only covers orchestrator-driven ends — `cancel()`'s queued branch, `initialize()`'s restart archiving, and `shutdownInterrupt()` / `persistInterrupted()` all bypass it |
| Config lives in the global `config.json` (`notifications.webhook`) | Notification routing is a host/transport concern, not project acceptance policy; and `updateStatus` only has the data home, taskId and logger, so it cannot cheaply read project config on every transition |
| "Exactly once" dedupes on `taskId + status + finishedAt` | `prev !== status` **cannot** be the gate: several paths (cancel's queued branch, `shutdownInterrupt`) **write `meta.status` directly first** and only then call `updateStatus`, at which point `prev` already equals the target state. `finishedAt` is refreshed by `updateStatus` on a terminal write and cleared by `rework`/`continueTask`, so repeated writes for one episode are suppressed while a **new episode after rework notifies again for the same status** |
| Sending happens **after** `appendEvent` + `writeSnapshot` | Persist the local fact first, then notify outward |
| `notify()` returns void (fire-and-forget) | Sending and retries run entirely in the background; a slow or dead endpoint **does not block the status-write chain**, and any exception only logs a `warn` |
| Only **true terminal states** are subscribed by default | `needs_attention` (terminal) → `needs_human`; `needs_user` (**non-terminal**, restorable via continue, possibly re-entered later) is a separate class that is off by default — merging them would defeat "only push true terminal states by default" |
| Global `fetch` + `AbortSignal.timeout` + `redirect:"manual"` | The same convention as `src/visual/services.ts`, built into Node ≥ 20, no new dependency |
| Optional HMAC-SHA256 signature | Signs the **raw request body string** (`X-Tianshu-Signature: sha256=<hex>`); a receiver can recompute it with the same secret |
| The notifier is an **optional** third constructor argument of `TaskStore` | Many tests construct `new TaskStore(home, logger)` directly, so backward compatibility is required |

**Disclosed honestly**: best-effort delivery, **not guaranteed** — failures only log; delivery can still
repeat across a server restart or a receiver retry (receivers should be idempotent); the body contains
`projectPath` and local absolute paths to report files, so confirm the receiver is trusted before
forwarding to a public service. See [task notifications](docs/notifications.en.md).

### 5.8 Fine-grained event stream: long-task observability (issue #18)

`query_task` used to return only coarse status: for long tasks — especially GUI agents stuck on confirmation dialogs, file pickers or authorization prompts — callers could not tell "the agent is working normally" apart from "it is stuck waiting for a human". This capability lets adapters report semantic events at key nodes.

The vocabulary lives in `src/agents/agent-events.ts` (**zero dependencies**, to avoid a cycle between `adapter.ts` / `tasks/task.ts` / `tasks/task-store.ts`):

| Event | Meaning |
|---|---|
| `task_dispatched` | Instruction confirmed delivered to the agent |
| `confirmation_dialog_detected` | A confirmation dialog was detected (including stale-dialog cleanup and the native "select folder" dialog) |
| `awaiting_user_authorization` | Waiting for the user to authorize / log in / confirm |
| `file_modification_started` | The agent started executing (**heuristic**: the first UI running signal; does not claim files were changed) |
| `rework_triggered` | Entering rework after acceptance failed (emitted engine-side; `mode` distinguishes auto/manual) |

| Decision | Implementation and rationale |
|---|---|
| Hook location | `AgentRunOptions.onEvent` (`src/agents/adapter.ts`), **not** the agent profile — `agent-profiles.json` is plain JSON and cannot hold a function; forcing one in would break `AgentProfilesFileSchema` parsing and hot reload. "Optional" is expressed by `opts.onEvent?.()` + `makeEmitter` |
| Storage | Written into the **existing** `task.jsonl` (reusing `TaskStore.appendEvent`), **not** an in-memory ring buffer: during long GUI tasks the host may restart and a purely in-memory queue would lose exactly the scene you most need; a parallel stream would create a second source of truth with no shared ordering |
| Bounded memory | Handled on the **read** side: new `readTextTail(p, maxBytes)` (`src/util/fs.ts`) + `TaskStore.readRecentAgentEvents(taskId, limit, maxBytes=64KiB)` read only a tail window, so memory use is decoupled from total file size. `readTextTail` guarantees the result starts at a whole line (it does not drop a whole line when the cut lands on a newline) |
| Reporting robustness | Adapters always report through `makeEmitter`: a no-op when no hook is provided, and it **swallows reporting exceptions** — event reporting is an observability concern and must never affect the task itself |
| Exposure | `query_task`'s `eventLimit` (1..50, default 10); `MetaBlockFields.recentEvents` (passed through `metaFromTask(meta, extra)`'s `...extra`) plus a "recent events" section in the text area. Non-reporting adapters return an empty array and every other field matches v0.6.2 |
| Scope in this version | Only **codex** and **traework** actually report (four emission points each); zcode / kimicode / qoder and all CLI adapters keep the interface but do not report yet |
| Relationship to `note` | `note` is unchanged and remains the progress / audit channel (carrying `progressSummary` / `lastRunSignal`); `recentEvents` filters only the five vocabulary kinds and never mixes `note` in |

**Disclosed honestly**: events are an observability capability, not a delivery guarantee — delivery is not guaranteed, and `query_task` reflects only the last persisted event; `file_modification_started` is a heuristic, so read `changedFiles` / `diffstat` from the acceptance report for hard evidence of changes. See [event stream](docs/event-stream.en.md).

---

## 6. Orchestration: the automatic verify-and-rework loop

`TaskOrchestrator` (`src/loop/fix-loop.ts`) is the per-task execution body.

```text
Start
 ├─ Capture the git baseline + freeze/check the visual snapshot
 │    └─ visual error → needs_attention(verify_failed) + pendingVisualVerification
 ├─ If resuming a blocked task: re-verify first (pass ends it, no rework, no wasted round)
 └─ Rework loop (round = meta.roundsUsed, maxRounds = meta.autoFixRounds)
      ├─ status=running → buildCtx(meta, round, feedback) → hold project lock → runAgentOnce
      │     runAgentOnce: adapter.run exists → call it; otherwise runChild + parseExit
      ├─ Branch on the agent result
      │     needs_user            → needs_user (awaits continue_task)
      │     idle/timeout/cdp loss → needs_attention
      │     hardFailure           → failed(spawn)      # infra/auth error, skips verify and rework
      │     timeout / killed      → corresponding terminal state
      ├─ Verify (runVerifyOnce): roundsUsed = round + 1, record report and change set
      └─ Termination decision
            blockingIssues        → needs_attention + pendingVisualVerification
            verdict.passed        → succeeded
            maxRounds > round     → fixing, round += 1, write repair plan, continue
            maxRounds == 0        → failed(verify_failed) + rework hint
            rounds exhausted      → needs_attention
```

**How failure information returns to the agent** — two paths, chosen by agent:

| Path | Artifact | Feedback content |
|---|---|---|
| Codex | `<project>/.zcode/plans/codex-fix-r<N>.md` | Failure evidence extracted from the report, embedded in the fix prompt |
| Others (incl. CLI) | `<task dir>/rework-<taskId>-r<round>.md` | Heading + plan path + `verifySummary` + report path |

**Key design point**: `hardFailure` and "verification failure" are strictly distinguished. The former means environment, auth, or startup problems, for which verification and rework are pointless — the task goes straight to a failed terminal state. Only a genuinely finished agent run enters verification and round accounting.

**Why `pendingVisualVerification` exists**: a task blocked by a missing approved baseline or a mutated baseline must **re-verify first** when resumed by `rework_task`; passing ends it. This avoids burning an agent round on what is actually a rules problem, not a code problem.

---

## 7. The acceptance engine

`AcceptanceEngine.runVerify()` (`src/verify/acceptance.ts`) runs the following stages in order, failing closed on any fatal error:

```text
0. Mutex       withVisualLock(task:<taskId>) then withVisualLock(realpath(projectPath));
               a concurrent verification of the same task is rejected outright
1. Baseline    capture or reuse a git baseline (verify_task reuses the task's stored baseline)
2. Resolve checks  priority: extraChecks > project .tianshu-mcp/acceptance.json
                            > projects.json verify > derived defaults by project type
3. Snapshot freeze #1  freeze the visual rule/baseline digests (**unconditional — independent of visual.enabled**)
4. Git check   built-in git-diff-check runs FIRST (git diff --check, over baseline..HEAD and the worktree)
5. Command checks  serial or bounded-parallel (verifyConcurrency, default 2, clamped 1..4);
                   in parallel mode each writes verify-<round>.parts/NNN-<name>.log,
                   merged back into the main log in declaration order afterwards
6. Visual checks   only when acceptance.json enables visual.enabled, and AFTER the command checks
                   (pages often need the build output first)
7. Code analysis   attribute the change set against the baseline → file list / diffstat / signals
8. Change gate   a git project with zero net change fails → an extra failing `no-changes` check item
9. Snapshot checks #2/#3  once after the commands and once after the visual stage; drift → VISUAL_INTEGRITY
```

> **Order matters**: the built-in `git-diff-check` runs **before** the configured checks, and the visual stage runs **after** the command checks.
> The snapshot freeze and integrity checks are **not** gated by `visual.enabled` — `enabled` only decides whether screenshots/specs/content
> judgement actually run. So "visual disabled" does not mean "nothing visual happens": digests are still frozen and compared, which is what
> detects edits to the acceptance config or the baselines themselves (`VISUAL_INTEGRITY`).

**Derived default checks** (`deriveDefaultChecks`): read `package.json` scripts `typecheck / lint / test / build` and map them to `npm run <script>`; `tsconfig.json` with no scripts → `npx tsc --noEmit` (optional); `pytest.ini` → `pytest -q`; `go.mod` → `go test ./...`; `Cargo.toml` → `cargo test` (the last three are optional).

**Command execution**: `cross-spawn` with structured argv and `shell:false` (**commands are never shell-interpolated**, see §12), `windowsHide:true`, with a `verifyCommandTimeoutMs` deadline (default 5 minutes).

Three fail-closed protections:

1. **Zero-test protection** — a test command that exits 0 while collecting no test cases is flipped to a failure, preventing "the tests ran nothing" from going green. Detection combines output shapes (`# tests 0`, `no tests found`, `no tests ran`, `0 tests (ran|executed|found)`) with name/command recognition of test checks.
2. **Zero-change protection** — a git project with no net change fails through an appended `no-changes` check item; `requireChanges: false` downgrades it to a note. Pure analysis/Q&A tasks must disable it explicitly.
3. **Cancellation fails the round** — any abort during the round sets `passed=false`; checks that never started are recorded as `skipped` ("任务取消，未执行").

### 7.1 Git baseline attribution (`src/verify/git-baseline.ts`)

**Never stash, commit, or roll back.** The flow:

1. Record `HEAD` and the tracked changes and untracked files from `git status --porcelain -uall`.
2. Hash the contents of every file that was **already dirty before work started** (files over 4 MiB are skipped; untracked files are capped at 5000, recording `untrackedHashTruncated` when exceeded).
3. At verification time, diff against `baseline.head`: `git diff --numstat <baseRef> HEAD` (in case the agent moved HEAD) merged with `git diff --numstat HEAD` (the worktree).
4. **Attribution**: files that were dirty before work started and whose current hash still matches the baseline are excluded from "this round's changes"; hash-truncated files are marked `unattributable` and excluded with an aggregate note. So `changedFiles` in the report reflects **what this round's agent actually changed**, not pre-existing dirt in the repository.

### 7.2 Report artifacts (`src/verify/report.ts`)

`report-<round>.md` structure: title and header metadata → `## Automatic command checks` (each `[PASS]/[FAIL]/[SKIP]` with exit code and output tail) → `## Code analysis` (change list / diffstat / suspicious signals and warnings) → `## Structured repair directives` → visual evidence → human-readable conclusion. `report-<round>.json` is the machine-readable counterpart (including the `repairDirectives` field).

The suspicious-signal scan (`src/verify/signals.ts`) is **deterministic regexes** and is advisory only, never a standalone failure cause: `TODO/FIXME/HACK/XXX`, `console.*` / `debugger`, three or more consecutive full-line comments, and secret-like literals.

### 7.3 Structured repair directives (`src/verify/directives.ts`, issue #19)

A repair report is a full narrative, so the agent has to locate by itself "which line has the type mismatch, which file has a TODO" — high reasoning cost and easy to misread. This module parses failure reasons into **directly executable actions** `{file?, line?, issue, action, source}`.

| Decision | Implementation and rationale |
|---|---|
| Matching | The repo has **no** per-verifier modules (typecheck/test/build are all generic argv command checks), so sources match on "check name / argv heuristics" plus structured data inside the report |
| Built-in sources | `typecheck` (parses pretty / plain TS errors out of failed typecheck checks' `outputTail`; absolute paths normalized to project-relative POSIX; duplicates collapsed) and `diffstat` (oversized single-file changes, modified lockfiles, and line-level counts for TODO / debug output / secret-like patterns) |
| **No** test-class extraction | Test-framework output has no stable file/line; parsing it anyway would produce **wrong** locations, which is worse than producing none — those always take the fallback path |
| Never throws | A single source's exception is swallowed and recorded in `fallbackReason` while the other sources keep working |
| Explicit fallback | A non-empty `fallbackReason` means renderers (both repair-plan variants and the rework message) must state "unavailable" and tell the agent to return to the full failure output — a **silent gap is not allowed** |
| Failed rounds only | A passing round has nothing to fix; extracting there would only bloat the report |
| Persistence | Written into `report-<round>.json`: the manual-rework path re-reads this file, and it must survive a server restart |
| Line-level signals never fake a file | `signals.ts` only counts and has no stable file or line, so those directives **omit** `file` |

**Known limitation**: `CheckResult.outputTail` is truncated to the last 4000 characters (`runner.ts`), and a large project's total error count can far exceed that, so **only tail errors are extractable** — the rest is covered by the fallback. This trade-off is accepted deliberately (report size is not inflated for extraction). See [structured repair directives](docs/repair-directives.en.md).

### 7.4 Three-level acceptance config inheritance (`src/config/acceptance-merge.ts`, issue #20)

With several similar projects mounted under one Tianshu host, creating a `.tianshu-mcp/acceptance.json` per project is costly and easy to forget. Hence an inheritance chain (low → high priority): `<data home>/acceptance.default.json` → `<project>/.tianshu-mcp/acceptance.json` → the `acceptanceOverride` argument of `run_task`/`verify_task`. The resolution point remains `resolveChecks()`.

| Decision | Implementation and rationale |
|---|---|
| **Layer schemas carry no defaults** | New `PartialAcceptanceConfigSchema` (every field optional, **no `.default()`**). This is the hazard fixed in this version: parsing a project file that only sets `verifyConcurrency` with the `.default(true)`-bearing `AcceptanceConfigSchema` materializes `requireChanges: true`, which would **in turn override the global layer's `false`**. Defaults are applied by consumers only when the final effective value is absent |
| Merge granularity = field | A field a higher layer **explicitly writes** wins outright; `undefined` means "not written by this layer" and does not participate |
| Arrays replace wholesale | If `checks` is written it replaces the whole array. Concatenating would turn "the project adds one check" into "the project can never remove a global check" |
| **`visual` replaces wholesale, never deep-merged** | Nearly every `VisualConfigSchema` field carries a default, so with deep merging a lower layer's **explicit** value would be silently clobbered by a higher layer's "not written, present only as a default" field (the same `.default()` pollution class as `requireChanges`). Doing it correctly requires merging raw JSON and validating only the result — a larger change for limited benefit, so wholesale replacement is the deliberate choice |
| Broken layer fails closed | A layer that exists but is unreadable / invalid JSON / fails validation is not skipped as empty; it pushes the round to `needs_attention` naming the layer and file (`readAcceptanceLayer`, matching existing project-level semantics). Only `ENOENT` counts as "layer absent" |
| visual comes from the merged result | `executeVerify` no longer re-reads the project file (otherwise the visual from override/global layers would change meaning based on whether a project file happens to exist) |
| Task override stored on `TaskMeta` | It is **task snapshot data**, not configuration: it writes no `acceptance*.json` and affects no other task or project; rework/continue reuse the same snapshot, so it keeps applying |
| Included in idempotency digests | Both `runTaskKeyedFields()` and `verifyIdempotencyDigest()` include `acceptanceOverride` — otherwise a same-key replay would return an old task built on a **different** policy |
| One summary line per round | `resolveChecks()` emits `生效层=… checks=… requireChanges=… verifyConcurrency=…`, sharing its source with the `config acceptance` command so troubleshooting needs no extra tooling |

**Debug command**: `tianshu-mcp config acceptance [projectPath] [--task <taskId>]` (`src/config/cli.ts`, dispatched by `src/index.ts` before the server is created). It is not nested under the `visual` namespace — `acceptance.json` is the acceptance engine's config and merely shares a file with visual acceptance. See the [acceptance config spec](docs/acceptance-config.en.md).

### 7.5 dryRun mode (`src/verify/dry-run.ts`, issue #21)

`run_task` normally drives the agent straight into editing source, and a misunderstanding can produce a
large diff needing rollback. `dryRun` provides the intermediate "see the plan, then decide" state.

| Decision | Implementation and rationale |
|---|---|
| Where the read-only constraint is injected | `makeBuildCtx()` (`src/mcp/context.ts`) merges `DRY_RUN_CONSTRAINT` into `ctx.context`. **One change covers all five adapters** (they all append `ctx.context`), and since dryRun is a round-0 first dispatch, the zcode/kimicode guard that only appends context on `initialDispatch` does not swallow it |
| A dedicated engine method rather than a branch in `executeVerify` | `AcceptanceEngine.runDryRun()` returns a `DryRunReport` (different meaning from `VerifyReport`). Folding it into the same return value would require a union type or a fake `VerifyReport`, polluting the types and complicating round accounting |
| Consumes no acceptance round | Its report is `dry-run-report-<round>.*`, which does not match `^report-(\d+)\.(md\|json)$`, so `nextReportRound()`'s scan ignores it naturally |
| **The zero-change gate is the core evidence** | `analyzeChanges()` diffs against the pre-work baseline; if changes remain after excluding MCP-owned artifacts (the plan file and any `planDoc` named in the task book) → `dry_run_violation` (error). It **does not depend on the plan being correct**: it still works when the agent produces no plan at all |
| Missing plan degrades but stays visible | `planExtracted: false` plus a `fallbackReason` stating why, with checks degrading to the zero-change gate only; both the report and the message state "plan extraction: failed" honestly |
| Verdict is `needs_attention`, not `failed` | A bad plan needs a **human decision**; it is not a code defect that can be auto-reworked |
| Never enters the rework loop | Same reason: there is no "broken code" to fix in a dry run |
| Ignores `autoVerify` | dryRun's semantics are "review first", not "verify" |
| Requires `projectPath` | Project-less mode has no file tree or baseline to analyse statically; `runTaskWithoutProject` rejects it explicitly rather than degrading into an ordinary task |
| The plan document lives **inside the project** | `.tianshu-mcp/dry-run-plan-<taskId>.md`: `planDoc` can only read project files, so putting it in the task data dir would make it unreachable for the agent. `meta.dryRunPlanDoc` reports the **project-relative** path |

**Disclosed honestly**: a rehearsal is still a real agent invocation (consuming quota and time); the
read-only constraint relies on task-book instructions plus the post-hoc gate, so **violations are caught
and reported honestly but changes that already happened are not rolled back** (the MCP never auto-commits,
auto-stashes or auto-checks-out); the static checks can only verify "the file exists, the location matches,
no obvious contradiction" and **cannot judge whether the plan itself is sensible** — which is exactly what
the human review step is for. Also note `planDoc` is currently consumed only by **Codex and Qoder CN**;
CLI agents and ZCode/Kimi Code/TraeWork do not read it, so for those the plan path must go into the `task`
text. See [dryRun mode](docs/dry-run.en.md).

---

## 8. The agent driver layer

### 8.1 The contract (`src/agents/adapter.ts`)

```ts
interface AgentAdapter {
  id: string;
  buildInvocation(ctx, resolved): SpawnInvocation;    // required: command/args/cwd/env/prompt
  parseExit(res): AgentRunResult;                     // required: child exit → semantic result
  run?(ctx, resolved, opts): Promise<AgentRunResult>; // optional: custom execution surface
}
```

**The one two-path seam**: when `run()` exists, `TaskOrchestrator` does not spawn a child process but calls it (GUI adapters); otherwise it goes through `runChild()` (CLI adapters).

- **CLI path** (`src/agents/cli.ts` + `src/agents/spawn.ts`): `cross-spawn` launches a child process, stdout/stderr go to the log, and the exit code decides the outcome. `promptMode` supports `arg` / `stdin` / `file` for brief delivery.
- **GUI path**: all five adapters' `buildInvocation()` throws outright and `run()` carries the entire CDP orchestration. **Four of them (Codex / ZCode / Kimi Code / Qoder CN) add a module-level serial gate** where tasks of the same adapter queue up and a cancelled waiter returns `aborted` without overtaking the current holder; TraeWork has no serial gate and relies on the per-project serial queue plus the global concurrency gate instead.

`AgentRunResult` is the cross-layer information carrier; the key fields:

| Field | Meaning |
|---|---|
| `ok / exitCode / timeout / killed` | Basic outcome |
| `hardFailure` | Infra/auth error that **skips verification and rework** |
| `endReason` | Structured end cause (values per driver below) |
| `needsUserKind` | The specific kind of human intervention needed |
| `guiStop:{clicked,idle}` | Whether the GUI side actually stopped on cancel |
| `session / keptInstance` | Session anchor and whether the instance was kept, for `continue_task` |
| `progressSummary` | Progress persisted for `query_task` to observe |

### 8.2 Execution order for the six GUI drivers (measured; do not reorder casually)

**TraeWork** (CDP-driven TRAE SOLO CN):

```text
Ensure instance → wait for UI ready → new conversation → switch to target mode
  → bind the project within that mode → switch model → send → poll to completion
```

> Work / Code / Design **each keep their own project binding**, and switching modes swaps the composer's project back to whatever that mode last used. So you must **switch mode first, then bind within the target mode**, and afterwards re-check that both mode and project landed — fail loudly if either is wrong.

**ZCode** (CDP-driven; no-project dispatch since v0.5.2):

```text
Discover install → launch/reuse CDP instance (shared deadline budget) → bind project
  (staged trigger location + full-path criterion) → pick model (direct selection first,
  provider/family grouping as fallback, decode stable attributes on read-back)
  → full-access permission → send (button readiness check → marker/session diff location)
  → run detection / question detection → poll to completion
```

**Codex** (MSIX COM activation):

```text
MSIX discovery (Appx query first + disk scan fallback) → COM activation with a dedicated
  user-data-dir and CDP port → project registration/binding → pick model and reasoning level
  → send (planDoc/designSystem folded into the initial instruction)
  → run detection (stop button + conversation-hash stall) → poll to completion
```

**Kimi Code** (CDP-driven, **two renderer processes**):

```text
Discover install → launch/reuse CDP instance (an existing non-CDP instance → needs_user(close_existing_instance))
  → connect the main window and bring it to front (bringToFront, wait for visibilityState to settle)
  → new draft (bounded retry keyed on ws-chip mounting)
  → bind workspace (full-path match + read-back; unregistered goes through the native "add workspace" dialog)
  → pick model (pill read-back → overlay shortcut menu → "more models…" dialog)
  → thinking tier (validated against the tier set the UI actually renders) → execution mode "fully automatic"
  → send (marker + bounded 60s confirmation) → run detection (stop button / send.is-starting) → poll to completion
```

> **The model menu, thinking tiers and execution-mode menu are not in the main window** — the app's
> `browserOverlayOpenMenu()` renders them into a separate `Kimi Browser Overlay` renderer process, while the
> workspace menu and the "switch model" dialog stay in the main window.
> `src/agents/kimicode/cdp.ts` is therefore a **two-page client** (main + overlay) and excludes the `Screenshot` target.
> "Is the menu open?" must be judged from the overlay's `visibilityState` — content may linger briefly after closing.
> Kimi Code **does not support project-less dispatch**: the task must bind a workspace folder, and `workspaceMode=default`
> or a missing `projectPath` is rejected with `setup_failed`.

**Qoder CN** (CDP-driven, ships its own send checkpoint):

```text
discover installation (explicit gui.exePath → D-drive-first candidates → relative-path templates → standard dirs;
                       non-win32 fails immediately with hardFailure(unsupported_platform))
  → launch/reuse the CDP instance (a live instance without usable CDP → needs_user(close_existing_instance); never restarted)
  → new session (or restore the original by resumeId) → bind workspace (full-path criterion; unregistered goes through "new workspace" + native picker)
  → pick model (exact match inside the default/custom group, disambiguated by modelSource) → thinking tier (saved in Model Management, re-read by reopening)
  → write checkpoint qoder-session.json BEFORE sending → marker + bounded acknowledgement → run detection (data-send-button=generating)
  → this turn's user id paired with assistant:<user id> plus data-assistant-actions → poll to completion
```

> **Completion must belong to this turn's user message**: a "done" in an older reply, a static screen, or a dropped connection never qualifies.
> Pending interactions (question/approval) outrank the stop button — judge `needs_user` first, or the task deadlocks as `running`.
> A checkpoint is written before sending or submitting answers, and **an unconfirmed acknowledgement means observe-only, never an automatic resend**;
> `continue_task` merely re-observes for approval/login waits, and only `agent_question` submits answers back to the original session
> (multi-question answers use a JSON object keyed by the UI's exact question text).
> A static screen with no this-turn completion evidence pauses as `setup_recovery` and **never enters acceptance** — Qoder emits no `idle_timeout`.
> Cancellation stops **only the bound original session** (`stopQoder` requires two consecutive non-running polls before it reports `idle`);
> when unconfirmed, the instance is kept and re-dispatch is blocked. macOS is `research` and dispatch is disabled.

**Open Design** (CDP-driven, **artifact signal**; in development: P0/P1 plus the P2/P5/P6 decision layer delivered, UI wiring awaits selector capture):

```text
launch/reuse the CDP instance after environment sanitisation (drop ELECTRON_RUN_AS_NODE etc.;
  a live instance without CDP → needs_user(close_existing_instance))
  → close this instance's stray #32770 windows (a modal swallows the main window's synthetic clicks)
  → version gate (install config appVersion)
  → bind the working directory (skip when already bound; expand → Select directory → native "Select Folder" via two routes → **read-back verification**)
  → pick model (exact match + echo candidates) → pick design system (search filter + read-back) → pick design direction (Prototype/Document/Website clone only)
  → type the task → send → three-signal run detection (stop button + conversation-text hash + **artifact mtime/size fingerprint**) → poll to completion
  → visual acceptance (the page source is **derived as a suggestion** by visual.ts; acceptance.json is never modified automatically)
  → on failure write .opendesign/plans/opendesign-fix-r<N>.md at the project root → send the plan name in the same session → re-accept
```

> **Two real-machine traps (both fixed; do not regress)**:
> 1. `Open Design.exe` is an Electron launcher with embedded Node. If the caller carries `ELECTRON_RUN_AS_NODE=1`,
>    the launcher is put into Node mode and **rejects `--remote-debugging-port`** (`bad option:`), showing
>    "no window, no log lines, no crash dump". Managed launches always sanitise the environment
>    (`OPEN_DESIGN_ENV_DENYLIST`) while leaving the command line unchanged.
> 2. The launcher uses a "**detached child**" shape: after accepting the port it prints `DevTools listening on …`
>    and **exits 0 by itself**; the real Electron main process is the detached child it spawned.
>    **Exit code 0 never means failure** — the announced port must be parsed from stderr and polling must continue.
>
> **It is the only driver with an "artifact signal"**: Open Design writes files continuously while not refreshing the
> conversation for long stretches, so text-only judging would call that normal work "idle and finished". The quiet
> criterion therefore requires **both text and artifacts to be stable**.
> **Binding success means a matching read-back** (not "the native dialog closed"); while selectors are uncaptured,
> dispatching **hard-fails with `selector_drift`** listing the missing keys and never clicks blindly.
> The version gate compares `appVersion` from `<install dir>/resources/open-design-config.json` (the **Electron**
> version reported by CDP is not a product version). See [opendesign-cdp.en.md](docs/opendesign-cdp.en.md).

### 8.3 Completion detection: run signal first, completion marker second

All six drivers share one judgment principle (implemented in each `liveness.ts`):

```text
A run signal exists (stop button / loading indicator / active tool call) → still running, never end
  ↓ run signal gone
A DOM completion marker appears ("由AI生成" and friends)               → completed
  ↓ no completion marker
Text hash unchanged for N consecutive rounds + composer re-enabled     → completed (stableRounds)
  ↓ never observed a run signal
Idle for idleTimeoutMs (default 10 min)                               → idle_timeout
                                                                        (abnormal end, instance kept)
```

**This was learned the hard way.** An earlier version treated "static for about 36 seconds" as completion, which prematurely completed long thinking phases. The rule now is that **the run signal absolutely outranks the completion marker**. ZCode additionally treats "the composer input is enabled again" as the authoritative completion criterion (`inputEnabled`).

### 8.4 `endReason` and `needsUserKind` value tables

`endReason`:

| Codex | TraeWork | ZCode | Kimi Code | Qoder CN |
|---|---|---|---|---|
| `reply_stable` (success) | `completion_mark` (success) | `reply_stable` (success) | `reply_stable` (success) | `completion_mark` (success) |
| `aborted` | `ask_user` (success, but blocked) | `aborted` | `aborted` | `aborted` |
| `task_timeout` | `timeout` | `task_timeout` | `task_timeout` | `task_timeout` |
| `idle_timeout` | `idle_no_completion` | `idle_timeout` | `idle_timeout` | **never emitted** (static screen without this-turn evidence → `setup_recovery`) |
| `needs_user` | `setup_failed` | `needs_user` | `needs_user` | `needs_user` (`pause()` reuses the kind as the endReason) |
| `setup_failed` | `cdp_lost` | `setup_failed` | `setup_failed` | `unsupported_platform` (non-Windows) |
| `instance_busy` | — | `cdp_disconnected` | `instance_busy` | `qoder_error` (runtime error; the text carries the specific cause) |
| `project_ambiguous` | — | `project_ambiguous` | — | — |
| `project_create_failed` | — | `project_mismatch` | — | — |
| `project_mismatch` | — | `project_not_registered` | — | — |
| `model_unavailable` | — | `model_unavailable` | `model_unavailable` | — |
| `model_mismatch` | — | `model_mismatch` | `model_mismatch` | — |
| `permission_unknown` | — | `permission_unknown` | `permission_unknown` | — |
| `input_mismatch` | — | `input_mismatch` | `input_mismatch` | — |
| `send_unknown` | — | `send_unknown` | `send_unknown` | — |
| `cdp_disconnected` | — | `session_lost` | `cdp_disconnected` | — |
| `internal` | — | `internal` | `internal` | — |
| — | — | — | `agent_error` (the UI shows a "continue" button or a failure message) | — |

> Kimi Code organises tasks by **workspace** rather than project, so it never produces the `project_*` family;
> binding failures surface as `setup_failed` or `needs_user(setup_recovery / system_permission)`.
> Qoder CN puts the concrete cause in the `error` text (`qoder_model_ambiguous` / `qoder_workspace_mismatch` /
> `qoder_question_*` / `qoder_session_lost` and friends) while `endReason` stays `qoder_error`.

**Open Design** (in development: UI wiring is incomplete, so only the values below are produced today; `reply_stable` / `idle_timeout` and friends follow once wired):

| `endReason` | Trigger |
|---|---|
| `selector_drift` | Required selectors are uncaptured, or page anchors miss — hard failure **before any coordinate click**, listing the missing keys |
| `version_mismatch` | The install config's `appVersion` is not in `opendesign.supportedVersions` |
| `setup_failed` | Entry validation failed (invalid design direction / empty task text / executable not found / launch failure) |
| `not_implemented` | The gates passed but the UI driver is not wired yet (current stage) |
| `needs_user` | A live instance without a debug port (`close_existing_instance`) |
| `aborted` | Cancelled (`cancel_task` / server exit) |

`needsUserKind` (six values in the union; each driver produces a different subset):

| Value | Meaning | Producer |
|---|---|---|
| `agent_question` | The agent is asking the user something in the UI | ZCode, Kimi Code (heuristic question detection only when `gui.selectors.userGate` is configured), Qoder CN (dedicated answer controls) |
| `user_confirmation` | Parked on a confirmation screen | Codex, Kimi Code, Qoder CN |
| `login_required` | Login needed | Codex, ZCode, Kimi Code, Qoder CN |
| `close_existing_instance` | An existing instance holds no CDP port; the user must close it | ZCode, Kimi Code, Qoder CN, **Open Design** (**not Codex**: its `ensureInstance` declares `needsClose` but never returns true) |
| `system_permission` | Missing system permission (e.g. macOS Accessibility) | ZCode, Kimi Code |
| `setup_recovery` | Automatic recovery budget exhausted / send result unknown; a human must step in | ZCode, Kimi Code, Qoder CN |

> **Qoder CN is the only adapter that can emit all six kinds** (`pause(kind, …)` uses the kind as the endReason too).
> **Open Design currently emits only `close_existing_instance`** (later it will add `system_permission` for an ambiguous
> native "Select Folder" dialog).
> TraeWork produces no `needsUserKind` at all: its "asking the user" case ends the turn normally (`ask_user`) and releases the instance,
> and it **never reads `ctx.resume`** — so `continue_task` is meaningless for it.

### 8.5 Registry and executable discovery (`src/agents/registry.ts`)

- The constructor pre-registers seven `CliAdapter` bases (codex / zcode / traework / kimicode / qoder / opendesign / stub), then swaps in the GUI implementation based on `profile.adapter` (`codex-gui` / `zcode-gui` / `traework-gui` / `kimicode-gui` / `qoder-gui` / `opendesign-gui`); it only rebuilds when the implementation class changes.
- `resolve(agentId)` branches on the profile's `status`:
  - `unsupported` → immediate failure;
  - `research` → ZCode goes through the dedicated `discoverZcode`, others through generic probing;
  - `ready` → in order: explicit absolute path → discovery-directory scan → PATH (`where` / `which`). Placeholder commands (`<...>`) are rejected.
- `codex-gui`, `kimicode-gui`, `qoder-gui` and `traework-gui` skip generic probing: they resolve their executable through `discoverCodex` (Appx query + disk scan), `discoverKimicode` (drive-root relative paths + standard directories + macOS bundle), `discoverQoder` and `discoverTraework` respectively. **`qoder-gui` and `traework-gui` additionally require `process.platform === "win32"`** — on any other platform `resolve` returns `ok:false` even when an installation was found, so they can never be dispatched on macOS. All four `discovery.ts` modules share one order skeleton: explicit path → fixed-drive relative paths (`preferredDrives` first) → registry `InstallLocation` → shortcut (qoder/traework) → standard dirs (incl. macOS bundle) → PATH.
- `profile.adapter` explicitly outranks `driver`: `driver:"spawn"` + `adapter:"codex-gui"` still installs the GUI implementation. `ensureAdapterFor` rebuilds only when the implementation class changes, so an ad-hoc swap does not disturb a running task.
- Selector overrides: TraeWork / ZCode / Codex / Kimi Code / **Qoder CN** all use **override → primary → fallback chain** (Kimi Code namespaces overlay keys as `overlay.<key>`). As of v0.6.2 Qoder CN was upgraded from a single-value override to a layered structure matching Codex (`QoderSelectorSpec`: `primary/fallbacks/texts/ariaLabels/ariaPatterns/verifiedVersion`); `QoderCdpClient.selector()` still returns the string primary to keep existing semantics, and adds `candidates()/existsKey()/clickKey()` that probe candidates in order before clicking.
- Selector-drift diagnostics (v0.6.2, issue #23): `src/agents/gui-diagnostics.ts` provides `visibleLabelsExpr()` (a page expression that collects visible candidate aria-labels / short texts) and `withDiagnostics()` (idempotently appends "页面可见候选=[…]"). codex / qoder / traework all attach this on selector-resolution failure so drift can be located in one step; each agent's `selectors.ts` records the tested version via `verifiedVersion`.
- Directory scans look up to depth 6, skipping `node_modules` and dot-directories, and **pick the newest by mtime**.
- Profile hot reload keys off a sha256 content stamp (not mtime), so edits within the same timestamp tick are still detected.
- `get_profiles` lists the union of registered adapter keys and profile keys (custom profiles that failed to resolve still appear) and reports `[PASS]/[FAIL]` with the discovery source for each.

### 8.6 GUI instance lifecycle

| Stage | Mechanism |
|---|---|
| Launch | All five go through `guiInstanceSpawnOptions()`: **unconditional** `detached: true` + `unref()` (`stdio:"ignore"`) |
| Reuse | Prefer a managed instance (Codex matches the dedicated `--user-data-dir`; ZCode / Kimi Code / Qoder CN scan a port range; TraeWork probes the port directly). **Qoder CN spawns only when no root process exists, and reuses the existing CDP port when the launcher forwards an exit** |
| Attach | A CDP connection is only accepted after one real DOM round trip (`exists("chatInput")`) |
| Liveness | One DOM evaluation per tick, handed to the respective `judge*Poll` |
| Keeping | Codex / ZCode / Kimi Code / Qoder CN set `keptInstance: true` on nearly every return path and never kill the process; TraeWork releases its own instance only on a clean completion (`completion_mark` / `ask_user`), and only then reports `keptInstance:false` |
| Ownership checks | TraeWork **re-reads the live command line** before releasing and requires both the recorded `--remote-debugging-port=<port>` and the exe basename; if it cannot read or match them it gives up (avoiding a wrong kill), and its `taskkill` **omits `/T`**. Codex stops only managed instances |
| Orphans | ZCode / Kimi Code / Qoder CN meeting a live instance *without* a CDP port yield `needs_user(close_existing_instance)` for the user to handle; they never kill blindly. (Codex declares `needsClose` in its instance contract but never returns true, so it has no such path) |

> **`detached: true` is an invariant, not a platform preference**: the desktop instance must outlive the MCP server to honor the `keptInstance` contract. Before v0.5.3 the spawn was platform-branched (not detached on Windows), so the GUI was killed along with the server on exit; that is fixed.
>
> Note the opposite semantics for **execution child processes** (`agents/spawn`, `verify/runner`, `visual/services`, `visual/content-command`): these stay platform-branched (`detached: process.platform !== "win32"`), because they must be reaped together with the server. That family has **no shared helper** — the same spawn-option literal is written out at four call sites; unifying it is known debt (see §15).

---

## 9. The visual acceptance path (optional module, since v0.5.0)

When disabled it has zero effect on existing behavior; when enabled it is an acceptance path **independent of command checks**.

```text
Project .tianshu-mcp/acceptance.json sets visual.enabled=true
  → run_task / verify_task append visual checks after command checks (no new tool needed)
  → before work starts, freeze "visual config digest + baseline digest" and re-check each round
    (any change raises VISUAL_INTEGRITY, a blocker)
  → Pages: three source kinds (existing / command / static) + declarative steps + stabilization
        sampling + explicit masking → pixel comparison against the approved baseline (pixelmatch)
        → if pages[].content is declared, reuse the same screenshot for a content judgement
          (pixel:false does content judgement only)
  → Images: explicit file list + encoding/size/DPI/transparency spec validation
  → Content (v0.5.4, optional): judgement of "does the image/screenshot content match the declared
        expectation" delegated to a user-supplied command
        → majority sampling + task-level input-hash cache (key includes the command binary identity)
        → warning-only by default (optional); a per-rule blocking:true joins failure and rework
  → Defects rework per autoFixRounds; blockers → needs_attention
  → rework_task re-verifies a blocked task first instead of starting the agent
```

**Credential boundary of AI content validation (v0.5.4, red line §12)**: the MCP reads, stores, and forwards no
keys and ships no model/vendor HTTP client; judgement is fully delegated to a command the user declares. The MCP
only expands placeholders (`<image:path>` / `<expect:file>` / `<image:base64:file>`), spawns the child with
`shell:false` and structured argv, and strictly validates the JSON on the last stdout line. The egress gate is
**contract-level**: `allowRemote` defaults to `false`, and a rule without the opt-in using `<image:base64:file>`
is rejected by the schema outright; whether a command actually sends the image out **cannot be blocked at the
system level** and the user must confirm it (see `SECURITY.en.md`).

**Status semantics of content judgement (v0.5.4)**: `VisualResult.status` gains `uncertain` (split votes or
confidence below `minConfidence`), which matches neither `visualFailed` (only `failed`) nor `visualBlocked` (only
`blocked`) and therefore **never affects the verdict**. Whole-round failures (`CONTENT_COMMAND_MISSING` /
`CONTENT_ENV_MISSING`) are raised during the pre-check (`assertContentReady`, which enumerates each rule's
**effective** command and env) and escalate through the `acceptance.ts` try/catch into a `configurationError`,
producing **no result rows at all**.

**Baselines are strictly two-phase**:

1. `prepare_visual_baseline` — produces only a candidate (`visual-candidates/<uuid>/` with `candidate.json`, PNGs, `preview.html`) plus a digest; it **does not adopt a baseline**.
2. `approve_visual_baseline` — called only after explicit user review and authorization. Before writing it checks a **three-way digest** (candidate + previous baseline + config) plus that the target path is not gitignored and that the associated task really is `needs_attention` in the same project, then atomically writes the baseline and a `manifest.json` approval record.

**A missing baseline must never pass, and automatic rework is forbidden from calling the approval entry point.**

Engineering constraints (`src/visual/`):

| Concern | Implementation |
|---|---|
| Browser | `puppeteer-core` headless Chrome/Edge; in `managed` mode `@puppeteer/browsers` installs a pinned revision under `<data home>/browsers` |
| Resource limits | Only local origins plus `allowedOrigins` are allowed; everything else is intercepted (`RESOURCE_BLOCKED`) |
| Stability | Requires `stabilitySamples` (default 3) byte-identical screenshots in a row; otherwise `SCREENSHOT_UNSTABLE` |
| Budget | `VisualBudget`: per-round deadline plus an artifact byte ceiling (default 500 MiB) |
| Mutual exclusion | `withVisualLock()`: `<data home>/visual-locks/<sha256(key)>.lock`, returning `VISUAL_BUSY` when held |
| Missing dependencies | `sharp` / `pixelmatch` / `puppeteer-core` missing **blocks explicitly** rather than degrading silently |
| Rule freezing | Config or baseline changed during a task → `VISUAL_INTEGRITY`, so an agent cannot weaken the acceptance rules |
| Content judgement (v0.5.4) | `src/visual/content*.ts`: command resolution (`where`/`which`), placeholder expansion, `runChild`-semantics subprocess execution, strict JSON on the last stdout line; the pure `tallyContentVotes` handles the majority vote and confidence gate; the task-level cache carries `commandPath`/`commandDigest` so upgrading your CLI invalidates it |
| Semantic-only pages (v0.5.4) | `pages[].pixel:false` skips the baseline requirement and pixel comparison (requires `content`); `prepareBaseline` skips them explicitly and never offers them as candidates; `captureVisualSnapshot` **records null** for their baselines (reading no stray files, so the frozen digest cannot drift) |
| Warning isolation (v0.5.4) | `blocking:false` → `optional:true`, staying out of `visualBlocked`/`visualFailed` and never triggering rework; the repair plan lists "warning-only items (no fix required)" and the pre-existing defect of listing `optional` failures as "must fix" is fixed |

CLI subcommands (`node dist/index.js visual ...`): `init` (writes a disabled template config), `doctor` (now with content-command resolution and budget-comparison findings), `browser install`, `baseline prepare|approve`, `rules review|approve`, `artifacts clean`, `content probe <project> [ruleId]` (runs a real judgement without writing evidence or cache), `content cache clear <taskId>`.

---

## 10. Configuration system and hot reload

### 10.1 Sources and precedence

| Config | Location | Notes |
|---|---|---|
| Server config | `<data home>/config.json` | `concurrency.maxRunning` (2), `defaultTaskTimeoutMs` (30 min), `verifyCommandTimeoutMs` (5 min), `verifyConcurrency` (2, 1..4), `shutdown.guiStopWaitMs` (15 s, global upper bound for the GUI stop wait on shutdown), `idempotency.ttlMs` (24 h), `idempotency.maxEntries` (2000), `skills.autoInstall` (true \| "prompt" \| false), `skills.backupKeep` (3, 0..50, 0 = never prune) |
| Idempotency mapping | `<data home>/idempotency.json` | key→taskId/digest mapping (not a hand-written config file; atomic writes, lazy loading, TTL and capacity pruning — see §5.6) |
| Agent profiles | `<data home>/agent-profiles.json` | **Whole-key override** of built-in profiles |
| Project registry | `<data home>/projects.json` | Includes each project's `verify[]` records |
| Project acceptance | `<project>/.tianshu-mcp/acceptance.json` | `checks[]`, `visual`, `requireChanges` (true), `verifyConcurrency` |

Task timeout resolution: call argument `taskTimeoutMs` > profile `timeoutMs` > `defaultTaskTimeoutMs` > 30 minutes, frozen at submit time.

### 10.2 Hot reload and last-known-good

- Every `loadConfig()` / `loadProfiles()` / `loadProjects()` compares a **sha256 content stamp** and re-reads only on change, so it does not depend on mtime and catches same-second edits.
- **Last-known-good policy**: when JSON parsing or zod validation fails, the server **keeps the previous valid config** rather than clearing it; only a first-ever load failure falls back to schema defaults. A corrupted config file therefore cannot strip configuration from a running service.
- Write paths (`saveConfig` / `registerProject` / `updateProjectVerify`) always write atomically and refresh the stamp.

### 10.3 Agent profile field groups (`src/config/schema.ts`)

| Group | Fields |
|---|---|
| Identity and shape | `id`, `displayName`, `type`, `driver` (spawn\|gui), `adapter` (traework-gui\|zcode-gui\|codex-gui\|kimicode-gui), `status` (ready\|research\|unsupported) |
| CLI execution | `command`, `argsTemplate`, `promptMode` (arg\|stdin\|file), `cwd` (task\|home), `env`, `timeoutMs`, `killTree` |
| Executable discovery | `executableDiscovery`: `dirs`, `fileNames`, `fallbackCommand`, `preferredDrives`, `appxPackageName`, `scanRoots`, and more |
| GUI orchestration | `gui`: `cdpPort` (9222), `cdpPortRange`, `exePath`, `windowMode`, `launchTimeoutMs` (60 s), `pollIntervalMs` (3 s), `stableRounds` (12), `idleTimeoutMs` (10 min), `stallTimeoutMs` (300 s), `cancelWaitMs` (15 s), `cdpSendTimeoutMs` (15 s), `progressIntervalMs` (30 s), `projectTriggerTimeoutMs` (15 s), `workspaceTriggerTimeoutMs` (15 s, Kimi Code draft-page criterion), `selectors`, `defaultPermissionMode`, `defaultAutoFixRounds`, `activation` (spawn\|msix-com), `userDataDir`, `fixPlanDir`, and more |

`gui.selectors` is the primary way to **adapt to client UI upgrades without touching code**: when a client release breaks selectors, diagnose with `scripts/probe-*.mjs` first, then override through the profile.

> **Declared but currently unused fields** (check before assuming a setting does something): `gui.windowMode` (schema default plus comments only),
> `gui.modelRequired` (whether a model is mandatory is decided unconditionally by each `parse*Model`), and ZCode's `gui.stallTimeoutMs` /
> `gui.cancelWaitMs` (copied into locals and never read — ZCode has no stall path and never clicks stop). `gui.activation` is consumed by Codex only.

---

## 11. Cross-platform strategy

Goal: **Windows and macOS both work, with no hard-coded machine paths.**

| Concern | Approach |
|---|---|
| Path placeholders | `{LOCALAPPDATA}`, `{APPDATA}`, `{PROGRAMFILES}`, `{PROGRAMFILES(X86)}`, `{SYSTEMDRIVE}`, `{HOME}`, `{USERPROFILE}`, `{XDG_DATA_HOME}` expand via `expandEnvPath()` (case-insensitive); unset directories fall back to platform default discovery dirs |
| Path normalization | `normPath()`: absolutize + POSIX separators + lowercase drive letter + strip trailing slashes; project directories additionally go through `realpath` (eliminating `/tmp → /private/tmp`-class traps) |
| Process-tree termination (execution) | Windows: `taskkill /pid <pid> /T /F`; POSIX: process-group SIGTERM, then SIGKILL after 800 ms |
| Process enumeration | Windows: PowerShell `Get-CimInstance Win32_Process`; POSIX: `ps -axo pid=,command=` |
| Executable lookup | Windows: `where`; POSIX: `which` |
| Native dialog automation | Windows: PowerShell + UIA; macOS: `osascript` / System Events (ZCode has both branches; Codex and TraeWork native dialogs are **Windows-only and fail closed on macOS**) |
| Drive enumeration | No hard-coded drive letters; fixed drives come from a WMI query |
| Versions / AUMID | Always discovered dynamically, never hard-coded |

Platform differences are concentrated in profiles and a handful of `platform` decision points rather than scattered through business logic.

---

## 12. Security boundary and hard red lines

Violating any of these causes runtime corruption or an incident:

1. **Never blind-kill TraeWork's process tree**: only terminate PIDs this module created and whose command line it verified, and never with `/T`. (Past incident: a verification-time `taskkill /PID <pid> /T /F` killed an instance the user was actively using.)
2. **Reuse the user's instance by default**: `gui.windowMode = "reuse"`, never start a second one; managed instances (Codex / ZCode launched with a dedicated `user-data-dir`) likewise never touch an instance the user opened manually.
3. **computer-use allowlist**: only the TraeWork folder-selection dialog (window title and host process both verified); anything else is `COMPUTER_USE_DENIED`.
4. **Zero credential handling**: never read, decrypt, or forward any agent credential; GUI adapters only drive the UI. **AI content validation (v0.5.4) is bound by the same rule**: no model/vendor HTTP client and no key reads — judgement is delegated to a user-supplied command, and the egress gate is contract-level only (the schema rejects `<image:base64:file>` without an `allowRemote` opt-in). The MCP **cannot block a user command from sending images out at the system level**, and that boundary must be stated plainly (see `SECURITY.en.md`).
5. **Never build commands through a shell**: verification commands are structured argv with `shell:false`.
6. **Never auto commit / stash / roll back**: capture a git baseline before work and compute reports relative to it.
7. **No hard-coded paths**: machine paths, user names, and ports come from profiles or placeholders.
8. **stdout carries JSON-RPC only**: all diagnostic logs go to stderr (and append to the same `logs/server.log`). Any noise on stdout breaks the MCP stream and fails the handshake with strict clients.
9. **Skill content comes from the package only**: the skill to be installed is located relative to the package via `import.meta.url`; **there is no cwd-based content discovery**, and a target whose content cannot be proven untouched is never overwritten silently (see §3.4).

**Path safety gate**: `projectPath` is validated at submit time — it must be absolute, the directory must exist, symlinks are realpath-normalized (the receipt states the resolved source), and **the home directory itself and system/root-level directories are rejected outright**, preventing a worker's write permissions from covering an entire system subtree.

---

## 13. Extension points

### 13.1 Adding a CLI agent (the common case)

Usually this **only needs a profile**, no code change: write a `driver: "spawn"` profile in `<data home>/agent-profiles.json` (`command`, `argsTemplate`, `promptMode`, `timeoutMs`, `executableDiscovery`) and it becomes usable via `run_task(agentId=...)` and visible in `get_profiles`. See [docs/agent-profiles.md](docs/agent-profiles.md) and the `codex-cli` example in the README.

### 13.2 Adding a GUI agent

This requires a new adapter directory implementing `AgentAdapter` with `run()` as the execution surface, typically containing:

| Responsibility | Suggested module |
|---|---|
| Adapter and serial gate | `adapter.ts` |
| Executable discovery | `discovery.ts` |
| Instance start/stop and reuse | `instance.ts` / `launcher.ts` |
| CDP client and selectors | `cdp.ts` / `selectors.ts` |
| Project and model selection | `project.ts` / `model.ts` |
| Completion detection | `liveness.ts` |
| Orchestration | `run.ts` |
| Registration | add a `profile.adapter` branch in `agents/registry.ts` and a default profile in `agents/builtin.ts` |

### 13.3 Other extension surfaces

| To extend | Landing spot |
|---|---|
| Add an MCP tool | Add metadata in `src/mcp/tools.ts` + implementation in `src/mcp/handlers.ts` + an input schema in `src/config/schema.ts` |
| Add an acceptance check source | The `resolveChecks()` precedence chain in `src/verify/acceptance.ts` |
| Project-level acceptance rules | The project's `.tianshu-mcp/acceptance.json` (no code change) |
| A selector drifting with a client upgrade | Profile `gui.selectors` override (no code change) |
| A new visual case type | `src/visual/schema.ts` + job construction in `engine.ts` |

---

## 14. Testing and delivery pipeline

### 14.1 Test layers

| Layer | Location | Coverage |
|---|---|---|
| Unit | `test/unit/` | Pure functions and component logic: reply / selectors / launcher / liveness / recovery for all five drivers, the acceptance engine (including parallelism), baseline attribution, atomic writes, hot reload, the path gate, the visual module |
| Integration | `test/integration/` | The three stub-agent scripts, cancel / timeout / baseline, fake-CDP TraeWork / Codex / ZCode / Kimi Code end-to-end and rework loops, race regressions, visual services / capture / flow |
| Protocol | `test/protocol/` | An official SDK client asserting the 11-tool surface and return format |
| Real-hardware (manual) | `scripts/probe-*.mjs`, `scripts/smoke-zcode.mjs`, `scripts/evidence-visual-windows.mjs` | Require a real client or an installed browser |
| Consumer | `scripts/check-visual-consumer.mjs` | Installs the production tarball into a directory with no dev dependencies and runs real-browser visual acceptance plus the offline report |

### 14.2 Gate discipline (all learned from CI failures)

1. Assistant replies in `test/fake-cdp.ts` must be **appended synchronously**; do not revert to a timer — with a short poll interval and a low `stableRounds`, a timer races the stability fallback.
2. Integration tests must **isolate native dialog enumeration**: the default `listDialogs` stub in `depsFor` is not optional, or tests reach the real `listOwnedDialogs`, whose darwin branch fails closed and throws on runners without the required authorization.
3. Real-browser cases default to `skipIf(TIANSHU_VISUAL_BROWSER_TEST !== "1")`; CI's `visual-browser` job opts in explicitly.

### 14.3 CI and release

| Workflow | Trigger | Contents |
|---|---|---|
| `ci.yml` | Push / PR to master and main | `build-test` (ubuntu / windows / macos × Node 20/22/24), `pack-check`, `visual-browser` (ubuntu / windows / macos-15-intel / macos-15 × Node 20/22/24, real browser) |
| `release.yml` | Push of a `v*` tag | Full gate → verify tag version === `package.json` version → require a successful CI run for the same SHA → bilingual body (`docs/release-v<ver>.md` + `.en.md`; **a missing document fails the run**) → publish the GitHub Release with the tgz attached → idempotently create the Gitee release via `scripts/gitee-release.mjs` |

Three places must agree on the version: `package.json`, `package-lock.json`, and `src/version.generated.ts` (the last is generated from `package.json` by `scripts/sync-version.mjs` before every build — **do not edit it by hand**).

---

## 15. Known gaps and technical debt

Ordered by impact on a successor:

1. **UI signals are the only reliable completion criterion** — all five GUI drivers depend on DOM structure and visible signals. Client upgrades can drift selectors; fix in `selectors.ts` or via a profile override, and real-hardware re-verification is not optional.
2. **A session waiting in the GUI cannot be stopped while the task is `needs_user`** — the MCP side holds no CDP connection. Terminal messages state this honestly. Stopping via a temporary CDP connection is listed under "planned" in `CHANGELOG.md`.
3. **Single-session serialization** — a GUI is a single-session resource, same-project tasks serialize behind `projectBusy()`, and global concurrency is capped by `maxRunning`. This is a design constraint, not a defect.
4. **macOS verification matrix is incomplete** — Codex and ZCode have real-hardware macOS happy paths, but cancel / rework / `continue_task` / new-project matrices are uncovered, so both stay `research` on darwin; TraeWork's and Kimi Code's macOS branches fail closed, and Kimi Code stays `research` on darwin too.
5. **No-project dispatch is ZCode-only and Windows-verified only**; ZCode's auto-import of unregistered projects is unavailable on Windows (register the directory manually first, or pass `allowCreateProject=false` to fail explicitly). **Kimi Code does not support project-less dispatch at all** (it must bind a workspace).
6. **Kimi Code cancellation / question answering / same-name workspace ambiguity are covered by hermetic integration tests only** (no hardware stop click, no real question card triggered).
7. **Visual module platform-evidence boundary** — macOS evidence comes from CI-hosted runners and has not been re-confirmed on the maintainer's own macOS device.
8. **Acceptance fail-closed affects pure analysis tasks** — a git project requires changes by default, so pure Q&A/analysis tasks must explicitly set `requireChanges: false`.
9. **Execution children have no shared spawn-option helper** — `agents/spawn`, `verify/runner`, `visual/services` and `visual/content-command` each inline the same platform branch (`detached: process.platform !== "win32"`). Same semantics, four copies; an edit can easily miss one.
10. **Some profile fields are declared but unused** — `gui.windowMode`, `gui.modelRequired`, and ZCode's `gui.stallTimeoutMs` / `gui.cancelWaitMs` (see the note in §10.3).
11. **No automatic GUI stop on restart** — `initialize()` only labels GUI leftovers honestly and sets `guiResidualUnconfirmed`; it never reconnects over CDP to click stop, because there is no session anchor after a restart and the adapters are fail-closed for instances without proof of ownership. Confirmation is manual, through `cancel_task` (§5.5).
12. **Subtree denial for dangerous directories has residual edges** — `/etc` `/usr` `/bin` `/sbin` `/private/etc` plus `c:/windows` and `c:/program files*` are denied as subtrees (v0.6.1), but `/var`, `/tmp`, `/opt`, `/library`, `/system`, `/root` and `c:/users` still only block the **exact root**; their subdirectories remain usable as workspaces. That is a deliberate trade-off: on macOS `os.tmpdir()` *is* `/var/folders/...`, so a blanket subtree rule would sever the test base and many legitimate workspaces (see the `DANGEROUS_SUBTREES` comment in `src/util/path.ts`). UNC-shaped gaps were reported through the security channel and are out of scope for this repository's public fixes.
13. **`capability` is consumed on the Tianshu host side** — this repository only guarantees that the emitted `_meta.capability` and MCP `annotations` are self-consistent (the truth table is pinned by `test/protocol/protocol.test.ts`). Since v0.6.1 `verify_task` is `execute` with `readOnlyHint: false`; host policies that hard-code that annotation need to relax accordingly (`requireApproval` is unchanged, so the approval experience does not regress).

---

## 16. Further reading

| Topic | Document |
|---|---|
| Install, Tianshu integration, tool usage | [README.md](README.md) / [README.en.md](README.en.md) |
| Handover status, troubleshooting, lessons learned | [HANDOFF.md](HANDOFF.md) |
| TraeWork GUI driver details | [docs/traework-cdp.md](docs/traework-cdp.md) |
| Codex desktop GUI driver details | [docs/codex-gui-cdp.md](docs/codex-gui-cdp.md) |
| ZCode GUI driver details | [docs/zcode-cdp.md](docs/zcode-cdp.md) |
| Kimi Code GUI driver details | [docs/kimi-cdp.md](docs/kimi-cdp.md) |
| Qoder CN GUI driver details | [docs/qoder-cdp.md](docs/qoder-cdp.md) |
| Full agent profile field reference | [docs/agent-profiles.md](docs/agent-profiles.md) |
| Per-agent capability research matrix | [docs/adapter-matrix.md](docs/adapter-matrix.md) |
| Project-level acceptance config spec | [docs/acceptance-config.md](docs/acceptance-config.md) |
| Visual acceptance config and troubleshooting | [docs/visual-acceptance.md](docs/visual-acceptance.md) |
| Development environment and commit conventions | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Security model | [SECURITY.md](SECURITY.md) |
