# ARCHITECTURE.md — tianshu-mcp Architecture

> Applies to version `0.5.3` (2026-09-15).
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
- Skill self-install can be disabled with `--no-skill-install` or `TIANSHU_MCP_NO_SKILL_INSTALL=1`.
- Shutdown path: `SIGINT` / `SIGTERM` / stdin EOF / stdin close → archive active tasks and terminate child processes → `exit(0)`.

### 3.2 Assembly order (`src/server.ts`)

`buildServer()` is the single assembly point, and its order carries meaning:

```text
resolveDataHome → Logger → DataHome(BUILTIN_PROFILES) → init()
  → loadConfig() → maxRunning
  → TaskStore → AgentAdapterRegistry(loadProfiles) → AcceptanceEngine
  → TaskManager(+makeBuildCtx) → manager.initialize(maxRunning)   # archive leftover active tasks
  → skill self-install (background, does not block the handshake)
  → register 11 tools → return ServerAssembly{server, manager, dataHome, store, logger, close}
```

`close()` = `manager.shutdownInterrupt()` (archive active tasks, terminate child processes) → `engine.close()` → `server.close()`.

Tool registration is **data-driven**: it walks `TOOL_DEFS`, looks up each name in `handlers`, logs an error and skips if missing, and passes along `_meta.requireApproval`, `_meta.capability`, and the MCP `annotations` (readOnly / destructive / openWorld) for the host's policy layer.

### 3.3 Data home layout

```text
<data home>/                      default ~/.tianshu-mcp
├── config.json                   server config (concurrency, timeouts, skills)
├── agent-profiles.json           user-defined / overriding agent profiles
├── projects.json                 project registry (incl. per-project verify config)
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
| `visual/<round>/<pageId>/<viewportId>/` | Visual quadruple: `actual/baseline/diff/regions.png` + `metrics.json` |
| `visual-snapshot.json` | Visual rules snapshot frozen for the task's duration |

Project-side artifacts: `<project>/.tianshu-mcp/acceptance.json` (project-level acceptance config), `<project>/tests/visual/baselines/...` (visual baselines), and for the Codex path `<project>/.zcode/plans/codex-fix-r<N>.md` (repair plan).

---

## 4. MCP tool surface and return contract

Eleven tools (`src/mcp/tools.ts`), split into read and write families:

| Tool | Capability | Approval | Purpose |
|---|---|---|---|
| `run_task` | write | yes | Dispatch work; returns a `taskId` asynchronously |
| `continue_task` | write | yes | Resume a `needs_user` task in its original session |
| `query_task` | read | no | Poll status / progress / log tail |
| `list_tasks` | read | no | Historical task list (filterable by project/status) |
| `get_task_report` | read | no | Full text of a given round's `report.md` |
| `cancel_task` | write | yes | Cancel (CLI: kill the process tree; GUI: best-effort stop click + bounded wait) |
| `verify_task` | read | no | Run one verification over a task or project path (does not modify sources) |
| `rework_task` | write | yes | Manual rework; feeds the failure summary back to the same agent |
| `get_profiles` | read | no | Agent support status and executable discovery results |
| `prepare_visual_baseline` | write | yes | Produce a baseline candidate and digest (does not adopt a baseline) |
| `approve_visual_baseline` | write | yes | After user review, check the digest and write the baseline |

**Return contract** (`src/mcp/formatter.ts`): human-readable body plus a trailing meta block the host can extract with a regex.

```text
<human-readable text>
---tianshu-mcp-meta---
{ ...MetaBlockFields: taskId, status, ok, round, changedFiles, diffstat, ... }
---tianshu-mcp-meta---
```

**Validation happens in two stages**: `server.ts` first runs `inputSchema.safeParse()` for protocol-level validation (failures return `Error: 参数不合法 — <path>: <message>`); handlers then apply semantic gates, such as the `projectPath` safety check (absolute, exists, realpath-normalized, rejecting the home directory and root-level/system directories), rejecting `mode` for anything but TraeWork, and allowing `allowCreateProject` only for ZCode.

Progress is **persisted, never pushed**: GUI adapters report on the `gui.progressIntervalMs` cadence (default 30 s), `TaskOrchestrator` writes a `note` event into `task.jsonl` and refreshes the snapshot's `progressSummary` / `lastRunSignal`, and `query_task` reads the latest snapshot plus event stream on each call. A poller therefore sees the *last persisted* progress.

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
| Terminal | No-op |

Cancellation of a GUI agent is **best-effort and honestly reported**: Codex clicks the in-UI stop button over CDP and waits for the GUI to go idle, recording `guiStop:{clicked, idle}`. When `idle=false`, the terminal message must state that the in-GUI run has not stopped. ZCode and TraeWork do not click stop; they only stop MCP-side observation and keep the instance.

Shutdown (`shutdownInterrupt()`): abort every controller → bounded 2 s wait per task → mark both `running` and `queued` as `interrupted`.

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
1. Baseline    capture or reuse a git baseline (verify_task reuses the task's stored baseline)
2. Resolve checks  priority: extraChecks > project .tianshu-mcp/acceptance.json
                            > projects.json verify > derived defaults by project type
3. Visual snapshot freeze + three-way check (before commands, after commands, after visual);
                   any change raises VISUAL_INTEGRITY
4. Git check   built-in git-diff-check (git diff --check, over baseline..HEAD and the worktree)
5. Command checks  serial or bounded-parallel (verifyConcurrency, default 2, clamped 1..4);
                   in parallel mode each writes verify-<round>.parts/NNN-<name>.log,
                   merged back into the main log afterwards
6. Visual checks   only when acceptance.json enables visual.enabled
7. Code analysis   attribute the change set against the baseline → file list / diffstat / signals
8. Change gate   a git project with zero net change fails (requireChanges defaults to true; can be disabled)
```

**Derived default checks** (`deriveDefaultChecks`): read `package.json` scripts `typecheck / lint / test / build` and map them to `npm run <script>`; `tsconfig.json` with no scripts → `npx tsc --noEmit`; `pytest.ini` → `pytest -q`; `go.mod` → `go test ./...`; `Cargo.toml` → `cargo test`.

**Command execution**: `cross-spawn` with structured argv and `shell:false` (**commands are never shell-interpolated**, see §12), `windowsHide:true`, with a `verifyCommandTimeoutMs` deadline (default 5 minutes).

Two fail-closed protections:

1. **Zero-test protection** — a test command that exits 0 while collecting no test cases is flipped to a failure, preventing "the tests ran nothing" from going green.
2. **Zero-change protection** — a git project with no net change fails; pure analysis/Q&A tasks must explicitly set `requireChanges: false`.

### 7.1 Git baseline attribution (`src/verify/git-baseline.ts`)

**Never stash, commit, or roll back.** The flow:

1. Record `HEAD` and the tracked changes and untracked files from `git status --porcelain -uall`.
2. Hash the contents of every file that was **already dirty before work started** (files over 4 MiB are skipped; untracked files are capped at 5000, recording `untrackedHashTruncated` when exceeded).
3. At verification time, diff against `baseline.head`: `git diff --numstat <baseRef> HEAD` (in case the agent moved HEAD) merged with `git diff --numstat HEAD` (the worktree).
4. **Attribution**: files that were dirty before work started and whose current hash still matches the baseline are excluded from "this round's changes"; hash-truncated files are marked `unattributable` and excluded with an aggregate note. So `changedFiles` in the report reflects **what this round's agent actually changed**, not pre-existing dirt in the repository.

### 7.2 Report artifacts (`src/verify/report.ts`)

`report-<round>.md` structure: title and header metadata → `## Automatic command checks` (each `[PASS]/[FAIL]/[SKIP]` with exit code and output tail) → `## Code analysis` (change list / diffstat / suspicious signals and warnings) → visual evidence → human-readable conclusion. `report-<round>.json` is the machine-readable counterpart.

The suspicious-signal scan (`src/verify/signals.ts`) is **deterministic regexes** and is advisory only, never a standalone failure cause: `TODO/FIXME/HACK/XXX`, `console.*` / `debugger`, three or more consecutive full-line comments, and secret-like literals.

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
- **GUI path**: all three adapters' `buildInvocation()` throws outright and `run()` carries the entire CDP orchestration. Codex and ZCode add a **module-level serial gate** — a GUI is a single-session resource and concurrent dispatches trample each other.

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

### 8.2 Execution order for the three GUI drivers (measured; do not reorder casually)

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

### 8.3 Completion detection: run signal first, completion marker second

All three drivers share one judgment principle (implemented in each `liveness.ts`):

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

| Codex | TraeWork | ZCode |
|---|---|---|
| `reply_stable` (success) | `completion_mark` (success) | `reply_stable` (success) |
| `aborted` | `ask_user` (success, but blocked) | `aborted` |
| `task_timeout` | `aborted` | `task_timeout` |
| `idle_timeout` | `timeout` | `idle_timeout` |
| `needs_user` | `idle_no_completion` | `needs_user` |
| `setup_failed` | `setup_failed` | `setup_failed` |
| `instance_busy` | `cdp_lost` | `cdp_disconnected` |
| `project_ambiguous` | — | `project_ambiguous` |
| `project_create_failed` | — | `project_mismatch` |
| `project_mismatch` | — | `project_not_registered` |
| `model_unavailable` | — | `model_unavailable` |
| `model_mismatch` | — | `model_mismatch` |
| `permission_unknown` | — | `permission_unknown` |
| `input_mismatch` | — | `input_mismatch` |
| `send_unknown` | — | `send_unknown` |
| `cdp_disconnected` | — | `session_lost` |
| `internal` | — | `internal` |

`needsUserKind` (six values in the union; each driver produces a different subset):

| Value | Meaning | Producer |
|---|---|---|
| `agent_question` | The agent is asking the user something in the UI | ZCode |
| `user_confirmation` | Parked on a confirmation screen | Codex |
| `login_required` | Login needed | Codex, ZCode |
| `close_existing_instance` | An existing instance holds no CDP port; the user must close it | ZCode |
| `system_permission` | Missing system permission (e.g. macOS Accessibility) | ZCode |
| `setup_recovery` | Automatic recovery budget exhausted; a human must step in | ZCode |

> TraeWork produces no `needsUserKind`: its "asking the user" case ends the turn normally (`ask_user`) and releases the instance.

### 8.5 Registry and executable discovery (`src/agents/registry.ts`)

- The constructor pre-registers four `CliAdapter` bases (codex / zcode / traework / stub), then swaps in the GUI implementation based on `profile.adapter` (`codex-gui` / `zcode-gui` / `traework-gui`); it only rebuilds when the implementation class changes.
- `resolve(agentId)` branches on the profile's `status`:
  - `unsupported` → immediate failure;
  - `research` → ZCode goes through the dedicated `discoverZcode`, others through generic probing;
  - `ready` → in order: explicit absolute path → discovery-directory scan → PATH (`where` / `which`). Placeholder commands (`<...>`) are rejected.
- Directory scans look up to depth 6, skipping `node_modules` and dot-directories, and **pick the newest by mtime**.
- Profile hot reload keys off a sha256 content stamp (not mtime), so edits within the same timestamp tick are still detected.
- `get_profiles` lists the union of registered adapter keys and profile keys (custom profiles that failed to resolve still appear) and reports `[PASS]/[FAIL]` with the discovery source for each.

### 8.6 GUI instance lifecycle

| Stage | Mechanism |
|---|---|
| Launch | All three go through `guiInstanceSpawnOptions()`: **unconditional** `detached: true` + `unref()` |
| Reuse | Prefer a managed instance (Codex matches the dedicated `--user-data-dir`; ZCode scans a port range; TraeWork probes the port directly) |
| Attach | A CDP connection is only accepted after one real DOM round trip (`exists("chatInput")`) |
| Liveness | One DOM evaluation per tick, handed to the respective `judge*Poll` |
| Keeping | Codex and ZCode set `keptInstance: true` on nearly every return path and never kill the process; TraeWork releases its own instance only on a clean completion |
| Ownership checks | TraeWork verifies the command line contains the debug port and exe name before releasing, and its `taskkill` **omits `/T`**; Codex stops only managed instances |
| Orphans | ZCode meeting a live instance *without* a CDP port yields `needs_user(close_existing_instance)` for the user to handle; it never kills blindly |

> **`detached: true` is an invariant, not a platform preference**: the desktop instance must outlive the MCP server to honor the `keptInstance` contract. Before v0.5.3 the spawn was platform-branched (not detached on Windows), so the GUI was killed along with the server on exit; that is fixed.
>
> Note the opposite semantics for **execution child processes** (`agents/spawn`, `verify/runner`, `visual/services`): these stay platform-branched, because they must be reaped together with the server.

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
| Server config | `<data home>/config.json` | `concurrency.maxRunning` (2), `defaultTaskTimeoutMs` (30 min), `verifyCommandTimeoutMs` (5 min), `verifyConcurrency` (2, 1..4), `skills.autoInstall` (true) |
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
| Identity and shape | `id`, `displayName`, `type`, `driver` (spawn\|gui), `adapter` (traework-gui\|zcode-gui\|codex-gui), `status` (ready\|research\|unsupported) |
| CLI execution | `command`, `argsTemplate`, `promptMode` (arg\|stdin\|file), `cwd` (task\|home), `env`, `timeoutMs`, `killTree` |
| Executable discovery | `executableDiscovery`: `dirs`, `fileNames`, `fallbackCommand`, `preferredDrives`, `appxPackageName`, `scanRoots`, and more |
| GUI orchestration | `gui`: `cdpPort` (9222), `cdpPortRange`, `exePath`, `windowMode`, `launchTimeoutMs` (60 s), `pollIntervalMs` (3 s), `stableRounds` (12), `idleTimeoutMs` (10 min), `stallTimeoutMs` (300 s), `cancelWaitMs` (15 s), `cdpSendTimeoutMs` (15 s), `progressIntervalMs` (30 s), `selectors`, `defaultPermissionMode`, `defaultAutoFixRounds`, `activation` (spawn\|msix-com), `userDataDir`, `fixPlanDir`, and more |

`gui.selectors` is the primary way to **adapt to client UI upgrades without touching code**: when a client release breaks selectors, diagnose with `scripts/probe-*.mjs` first, then override through the profile.

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
| Unit | `test/unit/` | Pure functions and component logic: reply / selectors / launcher / liveness / recovery for all three drivers, the acceptance engine (including parallelism), baseline attribution, atomic writes, hot reload, the path gate, the visual module |
| Integration | `test/integration/` | The three stub-agent scripts, cancel / timeout / baseline, fake-CDP TraeWork / Codex / ZCode end-to-end and rework loops, race regressions, visual services / capture / flow |
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

1. **UI signals are the only reliable completion criterion** — all three GUI drivers depend on DOM structure and visible signals. Client upgrades can drift selectors; fix in `selectors.ts` or via a profile override, and real-hardware re-verification is not optional.
2. **A session waiting in the GUI cannot be stopped while the task is `needs_user`** — the MCP side holds no CDP connection. Terminal messages state this honestly. Stopping via a temporary CDP connection is listed under "planned" in `CHANGELOG.md`.
3. **Single-session serialization** — a GUI is a single-session resource, same-project tasks serialize behind `projectBusy()`, and global concurrency is capped by `maxRunning`. This is a design constraint, not a defect.
4. **macOS verification matrix is incomplete** — Codex and ZCode have real-hardware macOS happy paths, but cancel / rework / `continue_task` / new-project matrices are uncovered, so both stay `research` on darwin; TraeWork's macOS branch fails closed.
5. **No-project dispatch is ZCode-only and Windows-verified only**; ZCode's auto-import of unregistered projects is unavailable on Windows (register the directory manually first, or pass `allowCreateProject=false` to fail explicitly).
6. **Visual module platform-evidence boundary** — macOS evidence comes from CI-hosted runners and has not been re-confirmed on the maintainer's own macOS device.
7. **Acceptance fail-closed affects pure analysis tasks** — a git project requires changes by default, so pure Q&A/analysis tasks must explicitly set `requireChanges: false`.
8. **Tool counts in doc comments are stale** — the header comments in `src/mcp/tools.ts`, `src/mcp/handlers.ts`, and `src/server.ts` still say "9 tools" while `TOOL_DEFS` actually has 11 entries. A comment-level staleness with no runtime effect; worth correcting in passing later.

---

## 16. Further reading

| Topic | Document |
|---|---|
| Install, Tianshu integration, tool usage | [README.md](README.md) / [README.en.md](README.en.md) |
| Handover status, troubleshooting, lessons learned | [HANDOFF.md](HANDOFF.md) |
| TraeWork GUI driver details | [docs/traework-cdp.md](docs/traework-cdp.md) |
| Codex desktop GUI driver details | [docs/codex-gui-cdp.md](docs/codex-gui-cdp.md) |
| ZCode GUI driver details | [docs/zcode-cdp.md](docs/zcode-cdp.md) |
| Full agent profile field reference | [docs/agent-profiles.md](docs/agent-profiles.md) |
| Per-agent capability research matrix | [docs/adapter-matrix.md](docs/adapter-matrix.md) |
| Project-level acceptance config spec | [docs/acceptance-config.md](docs/acceptance-config.md) |
| Visual acceptance config and troubleshooting | [docs/visual-acceptance.md](docs/visual-acceptance.md) |
| Development environment and commit conventions | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Security model | [SECURITY.md](SECURITY.md) |
