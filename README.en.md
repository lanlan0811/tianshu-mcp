<div align="center">

<img src="./assets/tianshu-mcp-banner.svg" alt="tianshu-mcp" width="100%">

<br/>

<img src="./assets/tianshu-mcp-icon.svg" alt="tianshu-mcp icon" width="132" height="132">

# tianshu-mcp

**Tianshu × AI-Agent orchestration MCP server**

Registered by Tianshu as a standard MCP server, it dispatches external AI-Agents (Codex CLI; TraeWork/TRAE SOLO CN driven through its desktop UI over CDP) to drive the closed loop of **project development → acceptance → failure rework → re-acceptance** (horizontally extensible).

> Official Tianshu repository: [github.com/huiliyi37/Tianshu-harness](https://github.com/huiliyi37/Tianshu-harness) — a harness-engineering terminal coding-agent runtime (TUI × GUI); this MCP plugs into it as an MCP server.

<br/>

[![CI](https://github.com/lanlan0811/tianshu-mcp/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/lanlan0811/tianshu-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/tianshu-mcp.svg?color=cb3837&logo=npm)](https://www.npmjs.com/package/tianshu-mcp)
[![npm downloads](https://img.shields.io/npm/dm/tianshu-mcp.svg?color=cb3837)](https://www.npmjs.com/package/tianshu-mcp)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.x-6f42c1.svg)](https://github.com/modelcontextprotocol/sdk)

**English** · [简体中文](README.md)

</div>

---

## What this is

Tianshu plays the role of the overall commander; this MCP server is the **scheduler + execution surface + objective acceptance gate**; the external AI-Agent (Codex CLI, TraeWork GUI) is the "worker" that does the development.

- **9 MCP tools**: `run_task / continue_task / query_task / list_tasks / get_task_report / cancel_task / verify_task / rework_task / get_profiles`.
- **Async contract**: `run_task` returns a `taskId` immediately; long-running work is polled via `query_task` (never blocks `tools/call`).
- **Objective acceptance**: automated command checks (typecheck/lint/test/build — skipped when absent, plus tech-stack derivation) + programmatic code analysis (changed-file list / diffstat / suspicious signals such as TODO, debugger, secret-like patterns), all relative to a **git baseline**; never auto-commits or stashes.
- **Rework loop**: automatic rework (`autoFixRounds`) + manual `rework_task`; on verification failure a repair-plan file is generated and fed back to the agent; when rounds run out → `needs_attention` awaiting Tianshu's verdict.
- **Two execution surfaces**: `driver: "spawn"` runs an external CLI child process (Codex); `driver: "gui"` selects an explicit, isolated TraeWork or ZCode CDP adapter.
- **Scheduling discipline**: per-project serial queue + global concurrency cap (default 2, configurable).
- **No key handling**: each agent uses its own login state; this server never stores or forwards any API key.
- **Extensible**: a new agent = one profile (data) + (if needed) one adapter file — no changes to the orchestration core.

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
npm test             # 230 tests across 36 files, including ZCode unit/fake-CDP/restart/repair coverage
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
> - Once the server connects, open a new session and the 9 tools appear.

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

After opening a new session, the 9 tools such as `mcp__tianshu-mcp__run_task` appear. Rehearse with the stub agent first (no real login state), then switch to the `codex` profile for real tasks:

```text
run_task(projectPath=D:/xxx/my-app, task=「…task brief…」, agentId=codex, autoVerify=true, autoFixRounds=2)
  → taskId → poll query_task(taskId) → succeeded / failed / needs_attention → get_task_report
```

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

Questions, login, an existing non-CDP instance, or system permission pause as `needs_user`; call `continue_task(taskId, message)` to resume the recorded session. See [docs/zcode-cdp.en.md](docs/zcode-cdp.en.md).

## Tool surface (9 tools)

| Tool | Capability / approval | Purpose |
|---|---|---|
| `run_task` | write + approval | Dispatch work (optional auto-verify / auto-rework); returns `taskId` asynchronously |
| `continue_task` | write + approval | Resume the original ZCode session from `needs_user` |
| `query_task` | read | Poll status / progress / log tail |
| `list_tasks` | read | Filtered history of tasks |
| `get_task_report` | read | Full text of a verification round's report (`report.md`) |
| `cancel_task` | write + approval | Cancel a running task (kill process tree) |
| `verify_task` | read | Run one verification pass on a task/project path (no source changes) |
| `rework_task` | write + approval | Manual rework (feed the failure report back to the same agent) |
| `get_profiles` | read | Inspect agent adapters and executable discovery results |

> Every result is "human-readable text + a `---tianshu-mcp-meta---` JSON block" so the host can extract it with a regex.

## Logging & stdio contract

This server is a standard MCP **stdio server** and follows the transport contract strictly:

- **stdout carries MCP JSON-RPC messages only.** No diagnostic log is ever written to stdout — doing so corrupts the JSON-RPC stream and makes strict clients fail to handshake or call tools.
- **All log levels (DEBUG/INFO/WARN/ERROR) go to stderr** and are appended to `logs/server.log` under the data directory (UTF-8, ISO timestamp, with a level tag).
- Therefore **an `INFO`/`WARN` line on stderr does not mean the server failed**; it is normal diagnostics. Only a startup failure (`tianshu-mcp 启动失败:`) is fatal, and it exits with a non-zero code.

The data directory defaults to `~/.tianshu-mcp` (override with `TIANSHU_MCP_HOME`); the log file lives at `<data dir>/logs/server.log`.

Use `server.log` when troubleshooting connections; do not treat stderr output itself as a server fault.

## Documentation

| Doc | Content |
|---|---|
| [docs/tianshu-integration.en.md](docs/tianshu-integration.en.md) | Two config.json integration modes, UI/API steps, smoke test, FAQ |
| [docs/agent-profiles.en.md](docs/agent-profiles.en.md) | Agent profile field reference + real-machine samples |
| [docs/adapter-matrix.en.md](docs/adapter-matrix.en.md) | Agent capability research matrix (Codex/Zcode/TraeWork/extension slots) |
| [docs/traework-cdp.en.md](docs/traework-cdp.en.md) | TraeWork GUI driver (CDP): mechanism, config, mode switching, selectors, safety invariants, pitfalls, verification record |
| [docs/zcode-cdp.en.md](docs/zcode-cdp.en.md) | ZCode GUI driver: discovery, exact project/model, Full Access, pause/continue, verification and platform evidence |
| [docs/acceptance-config.en.md](docs/acceptance-config.en.md) | Project-level `.tianshu-mcp/acceptance.json` acceptance config spec |
| [docs/release-v0.1.9.en.md](docs/release-v0.1.9.en.md) | v0.1.9 release notes (TraeWork task liveness and instance retention) |
| [docs/release-v0.1.10.en.md](docs/release-v0.1.10.en.md) | v0.1.10 release notes (stdio log pollution fix: diagnostics on stderr) |
| [docs/release-v0.1.8.en.md](docs/release-v0.1.8.en.md) | v0.1.8 release notes (atomic-write concurrency fix) |
| [docs/release-v0.1.7.en.md](docs/release-v0.1.7.en.md) | v0.1.7 release notes (binding root cause: native path) |
| [docs/release-v0.1.6.en.md](docs/release-v0.1.6.en.md) | v0.1.6 release notes (project-folder binding fix) |
| [docs/release-v0.1.5.en.md](docs/release-v0.1.5.en.md) | v0.1.5 release notes (mode switching, README/icon, release artifacts) |
| [skills/tianshu-mcp/SKILL.md](skills/tianshu-mcp/SKILL.md) | Skill that teaches Tianshu how to orchestrate this MCP (with usage examples) |

> Chinese documentation: see [README.md](README.md).
> Some milestone/evidence records are **Chinese-only** (no English translation yet): [HANDOFF.md](HANDOFF.md),
> [docs/npm-publish-guide.md](docs/npm-publish-guide.md), [docs/m2-smoke-record.md](docs/m2-smoke-record.md),
> [docs/m2-rework-record.md](docs/m2-rework-record.md), [docs/host-integration-record.md](docs/host-integration-record.md),
> [docs/dod7-release-record.md](docs/dod7-release-record.md), [docs/dod8-session-record.md](docs/dod8-session-record.md),
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
  - GitHub Actions: `CI` (ubuntu/windows/macos × Node 20/22 + tarball check, **7/7 green**) and `Release` (tag-triggered) both green
  - Skill self-install verified idempotent on this machine's real `~/.rivet/skills/tianshu-mcp`
  - npm package name `tianshu-mcp` available
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

## Agent support status

| agentId | driver | status | Notes |
|---|---|---|---|
| `codex` | `spawn` | **ready** | Reuses `~/.codex` login state; `codex exec` headless; passed real M2 smoke |
| `zcode` | `zcode-gui` | **research** | CDP GUI adapter implemented; remains non-ready until both Windows and macOS hardware loops pass |
| `traework` | **`gui`** | **ready** | CDP-driven TRAE SOLO CN desktop UI; all three panel modes machine-verified |
| `stub` | `spawn` | tests only | `test/stub-agent/stub-agent.mjs` with 3 playbooks (good/fix-on-first/never) |

> Adding an agent usually needs only a profile — see [docs/agent-profiles.en.md](docs/agent-profiles.en.md) and [CONTRIBUTING.en.md](CONTRIBUTING.en.md).

## Recommended phrasing (for Tianshu)

> "In project D:\xxx, implement 『task』 with codex. First run run_task(autoVerify:true, autoFixRounds:2), then check with query_task; if the report says needs_attention, feed the failed items from get_task_report as feedback into rework_task and verify again; when everything passes, report changedFiles and diffstat."

> "In project D:\xxx, use traework with mode=Code to implement 『task』; it switches to Code mode first, then binds the project, sends the task, auto-verifies, and on failure generates a repair plan and reworks."

## Contributing

| Document | Content |
|---|---|
| [CHANGELOG.en.md](CHANGELOG.en.md) | Version history (v0.1.0 → v0.1.10) |
| [CONTRIBUTING.en.md](CONTRIBUTING.en.md) | Dev setup, conventions, commit/release flow, adding an agent |
| [SECURITY.en.md](SECURITY.en.md) | Security model (zero credentials / command whitelist / process & desktop-automation boundaries) and private reporting |
| [CODE_OF_CONDUCT.en.md](CODE_OF_CONDUCT.en.md) | Contributor Code of Conduct |
| [LICENSE](LICENSE) | Apache License 2.0 (detailed explanation below) |

- **Primary repository**: <https://github.com/lanlan0811/tianshu-mcp> (GitHub)
- **Mirror repository**: <https://gitee.com/lan0811/tianshu-mcp> (Gitee)
- **Feedback**: bugs / feature requests via the repo Issue templates; report security vulnerabilities privately per [SECURITY.en.md](SECURITY.en.md) — **do not** open a public issue.

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

Runtime dependencies are all **MIT**-licensed and compatible with Apache-2.0:

| Dependency | License | Purpose |
|---|---|---|
| [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/sdk) | MIT | MCP protocol implementation |
| [`zod`](https://github.com/colinhacks/zod) | MIT | External input validation |
| [`cross-spawn`](https://github.com/moxystudio/node-cross-spawn) | MIT | Cross-platform child processes |

Development dependencies (TypeScript, ESLint, Prettier, Vitest, Vite, tsx, etc.) follow their own open-source licenses and are not distributed with the npm package.

### Relationship to the security boundary

This MCP **never stores, reads, or forwards** any AI-Agent API key or login state (see [SECURITY.en.md](SECURITY.en.md)). The license terms do not change this design boundary.
