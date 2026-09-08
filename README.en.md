<div align="center">

<img src="./assets/tianshu-mcp-banner.svg" alt="tianshu-mcp" width="100%">

<br/>

<img src="./assets/tianshu-mcp-icon.svg" alt="tianshu-mcp icon" width="132" height="132">

# tianshu-mcp

**Tianshu × AI-Agent orchestration MCP server**

Registered by Tianshu as a standard MCP server, it dispatches external AI-Agents (Codex CLI; TraeWork/TRAE SOLO CN driven through its desktop UI over CDP) to drive the closed loop of **project development → acceptance → failure rework → re-acceptance** (horizontally extensible).

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

- **8 MCP tools**: `run_task / query_task / list_tasks / get_task_report / cancel_task / verify_task / rework_task / get_profiles`.
- **Async contract**: `run_task` returns a `taskId` immediately; long-running work is polled via `query_task` (never blocks `tools/call`).
- **Objective acceptance**: automated command checks (typecheck/lint/test/build — skipped when absent, plus tech-stack derivation) + programmatic code analysis (changed-file list / diffstat / suspicious signals such as TODO, debugger, secret-like patterns), all relative to a **git baseline**; never auto-commits or stashes.
- **Rework loop**: automatic rework (`autoFixRounds`) + manual `rework_task`; on verification failure a repair-plan file is generated and fed back to the agent; when rounds run out → `needs_attention` awaiting Tianshu's verdict.
- **Two execution surfaces**: `driver: "spawn"` runs an external CLI child process (Codex); `driver: "gui"` drives a desktop UI (TraeWork over CDP, with an optional `model` and `mode` — Work/Code/Design).
- **Scheduling discipline**: per-project serial queue + global concurrency cap (default 2, configurable).
- **No key handling**: each agent uses its own login state; this server never stores or forwards any API key.
- **Extensible**: a new agent = one profile (data) + (if needed) one adapter file — no changes to the orchestration core.

## Quick start

```bash
npm install
npm run build        # → dist/
npm test             # 167 tests: unit + stub-agent 3-playbook integration + protocol + TraeWork fake-CDP + cancel/timeout/baseline/params/config regression
```

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

After opening a new session, the 8 tools such as `mcp__tianshu-mcp__run_task` appear. Rehearse with the stub agent first (no real login state), then switch to the `codex` profile for real tasks:

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

## Documentation

| Doc | Content |
|---|---|
| [docs/tianshu-integration.en.md](docs/tianshu-integration.en.md) | Two config.json integration modes, UI/API steps, smoke test, FAQ |
| [docs/agent-profiles.en.md](docs/agent-profiles.en.md) | Agent profile field reference + real-machine samples |
| [docs/adapter-matrix.en.md](docs/adapter-matrix.en.md) | Agent capability research matrix (Codex/Zcode/TraeWork/extension slots) |
| [docs/traework-cdp.en.md](docs/traework-cdp.en.md) | TraeWork GUI driver (CDP): mechanism, config, mode switching, selectors, safety invariants, pitfalls, verification record |
| [docs/acceptance-config.en.md](docs/acceptance-config.en.md) | Project-level `.tianshu-mcp/acceptance.json` acceptance config spec |
| [docs/release-v0.1.5.en.md](docs/release-v0.1.5.en.md) | v0.1.5 release notes (mode switching, README/icon, release artifacts) |

> Chinese documentation: see [README.md](README.md).

## Milestone status

- **M1 — Core engine + stub-agent end-to-end** ✅
  - 8 tools, TaskManager state machine / queue / concurrency gate / cancel (kill tree) / event-stream persistence
  - Acceptance engine (git baseline & diff, default-set derivation, command runner, code analysis, report.md/json)
  - fix-loop auto rework + needs_attention; skill self-install
  - Stub-agent 3 playbooks (good / fix-on-first / never) integration tests + protocol tests — **72/72 green** (incl. R1–R5/S1–S6 cancel/timeout/baseline/params/config regressions)
- **M2 — Real Codex CLI smoke + rework loop** ✅ (2026-09-07)
  - Real `codex exec` completed `run_task → query_task → verify_task`
  - Real **failure → rework_task → re-verify succeeded** loop, with artifacts
  - Fixed 3 real bugs the smoke exposed (Windows npm shim / spawn log race crash / codex flag conflict) + regression tests
  - Zcode headless entry (Z1) verified: ZCode desktop ships no headless CLI → unsupported
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
- **M4 — TraeWork GUI driver (CDP)** ✅ (2026-09-08, see [traework-cdp.en.md](docs/traework-cdp.en.md))
  - Correction: no headless CLI exists, but `--remote-debugging-port` can drive the chat UI; `traework` is now `driver=gui` / `status=ready`
  - Capabilities: launch/reuse instance → new session → bind project folder (dropdown first, restricted computer-use native dialog as fallback) → optional model selection → read-back-verified send → poll to completion → auto-verify → repair-plan file + same-session rework on failure
  - Safety: reuse the user's instance by default, never kill a process tree, verify the command line before terminating; computer-use is limited to TraeWork's folder picker
  - Machine-verified: `run_task(agentId=traework, model=GLM-5.3, autoVerify=true)` drove TraeWork to create a file and passed acceptance
- **M5 — Mode switching + v0.1.5 release** ✅ (2026-09-08, see [release-v0.1.5.en.md](docs/release-v0.1.5.en.md))
  - `run_task` gained `mode` (Work/Code/Design), explicit parameter plus task-text fallback; all three modes **machine-verified end-to-end**
  - Key finding: the three modes keep independent project bindings → order is new session → switch mode → bind project inside that mode
  - README rewritten (bilingual + stack badges + dedicated SVG icon/banner); tests 153 → **167**

## Recommended phrasing (for Tianshu)

> "In project D:\xxx, implement 『task』 with codex. First run run_task(autoVerify:true, autoFixRounds:2), then check with query_task; if the report says needs_attention, feed the failed items from get_task_report as feedback into rework_task and verify again; when everything passes, report changedFiles and diffstat."

> "In project D:\xxx, use traework with mode=Code to implement 『task』; it switches to Code mode first, then binds the project, sends the task, auto-verifies, and on failure generates a repair plan and reworks."

## License

[Apache-2.0](LICENSE)
