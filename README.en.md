<div align="center">

# tianshu-mcp

**Tianshu × AI-Agent orchestration MCP server**

Registered by Tianshu as a standard MCP server, it dispatches external AI-Agent CLIs (Codex / Zcode / TraeWork — horizontally extensible) to drive the closed loop of **project development → acceptance → failure rework → re-acceptance**.

TypeScript · Node.js ≥ 20 · `@modelcontextprotocol/sdk` (stdio)

</div>

---

## What this is

Tianshu plays the role of the overall commander; this MCP server is the **scheduler + execution surface + objective acceptance gate**; the external AI-Agent CLI (e.g. Codex) is the "worker" that does the development.

- **8 MCP tools**: `run_task / query_task / list_tasks / get_task_report / cancel_task / verify_task / rework_task / get_profiles`.
- **Async contract**: `run_task` returns a `taskId` immediately; long-running work is polled via `query_task` (never blocks `tools/call`).
- **Objective acceptance**: automated command checks (typecheck/lint/test/build — skipped when absent, plus tech-stack derivation) + programmatic code analysis (changed-file list / diffstat / suspicious signals such as TODO, debugger, secret-like patterns), all relative to a **git baseline**; never auto-commits or stashes.
- **Rework loop**: automatic rework (`autoFixRounds`) + manual `rework_task`; when rounds run out → `needs_attention` awaiting Tianshu's verdict.
- **Scheduling discipline**: per-project serial queue + global concurrency cap (default 2, configurable).
- **No key handling**: each agent uses its own login state; this server never stores or forwards any API key.
- **Extensible**: a new agent = one profile (data) + (if needed) one adapter file — no changes to the orchestration core.

## Quick start

```bash
npm install
npm run build        # → dist/
npm test             # 25 tests: unit + stub-agent 3-playbook integration + protocol
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

## Documentation

| Doc | Content |
|---|---|
| [docs/tianshu-integration.md](docs/tianshu-integration.md) | Two config.json integration modes, UI/API steps, smoke test, FAQ |
| [docs/agent-profiles.md](docs/agent-profiles.md) | Agent profile field reference + real-machine samples |
| [docs/adapter-matrix.md](docs/adapter-matrix.md) | Agent capability research matrix (Codex/Zcode/TraeWork/extension slots) |
| [docs/acceptance-config.md](docs/acceptance-config.md) | Project-level `.tianshu-mcp/acceptance.json` acceptance config spec |
| [skills/tianshu-mcp/](skills/tianshu-mcp/SKILL.md) | Skill teaching Tianshu how to orchestrate this MCP (with usage examples) |

## Milestone status

- **M1 — Core engine + stub-agent end-to-end** ✅
  - 8 tools, TaskManager state machine / queue / concurrency gate / cancel (kill tree) / event-stream persistence
  - Acceptance engine (git baseline & diff, default-set derivation, command runner, code analysis, report.md/json)
  - fix-loop auto rework + needs_attention; skill self-install
  - Stub-agent 3 playbooks (good / fix-on-first / never) integration tests + protocol tests — **25/25 green**
- **M2 — Real Zcode + Codex CLI integration** 🔜 (pre-research Z1/C1 → adapters → local smoke → real Tianshu session)
- **M3 — TraeWork research + full delivery** 🔜 (adapter-matrix / docs / npm release / skill validation)

## Recommended phrasing (for Tianshu)

> "In project D:\xxx, implement 『task』 with codex. First run run_task(autoVerify:true, autoFixRounds:2), then check with query_task; if the report says needs_attention, feed the failed items from get_task_report as feedback into rework_task and verify again; when everything passes, report changedFiles and diffstat."

## License

[MIT](LICENSE)
