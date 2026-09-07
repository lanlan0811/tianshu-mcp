# Tianshu Integration Guide

`tianshu-mcp` is a standard **MCP stdio server** (TypeScript + official `@modelcontextprotocol/sdk`). Register it in Tianshu as a normal MCP server and its 8 tools (`mcp__tianshu-mcp__*`) become available to drive external AI-Agents through the "dispatch → accept → rework → re-accept" loop.

## 0. Prereqs

- Node.js ≥ 20.
- `npm install && npm run build` → `dist/` (local mode) or publish to use npx.
- Data dir defaults to `~/.tianshu-mcp` (override `TIANSHU_MCP_HOME`).

## 1. Config (two modes in config.json `mcp.servers`)

### Mode A — local dev (recommended first)

```jsonc
{
  "mcp": {
    "enabled": true,
    "servers": {
      "tianshu-mcp": {
        "command": "node",
        "args": ["D:/path/to/tianshu-mcp/dist/index.js"],
        "env": { "TIANSHU_MCP_HOME": "D:/path/to/tianshu-mcp/.tianshu-mcp" }
      }
    }
  }
}
```

### Mode B — npm distribution

```jsonc
{ "tianshu-mcp": { "command": "npx", "args": ["-y", "tianshu-mcp"] } }
```

## 2. Optional policy override

```jsonc
"policy": { "tools": {
  "run_task":     { "capability": "write", "requireApproval": true },
  "cancel_task":  { "capability": "write", "requireApproval": true },
  "rework_task":  { "capability": "write", "requireApproval": true },
  "verify_task":  { "capability": "read" },
  "query_task":   { "capability": "read" },
  "list_tasks":   { "capability": "read" },
  "get_task_report": { "capability": "read" },
  "get_profiles": { "capability": "read" }
}}
```

## 3. Tool surface (8)

| Tool | capability/approval | Purpose |
|---|---|---|
| `run_task` | write + approval | dispatch (optional auto-verify / auto-fix), async → taskId |
| `query_task` | read | poll status / log tail |
| `list_tasks` | read | filter history |
| `get_task_report` | read | full acceptance report |
| `cancel_task` | write + approval | cancel (kill tree) |
| `verify_task` | read | one acceptance round (no source edits) |
| `rework_task` | write + approval | manual rework (feed failure back to same agent) |
| `get_profiles` | read | agent probe results |

Return format: human text + `---tianshu-mcp-meta---` JSON block.

## 4. Smoke steps

1. Add the server via settings/API and connect; `GET /mcp/status` shows connected.
2. New session → confirm 8 `mcp__tianshu-mcp__*` tools.
3. Rehearse with the stub agent, then switch to the `codex` profile.
4. Validate hot-restart / hot-inject and delete-server paths.

## 5. Async & timeouts

- All tools are async: `run_task` returns a taskId immediately; poll via `query_task` (5–10s).
- Default task timeout 30 min (`taskTimeoutMs` overrides at call level; call > profile > server default). Per-check verify timeout default 5 min.

## 6. FAQ

| Symptom | Fix |
|---|---|
| tools missing / not connected | read `<home>/logs/server.log`; check node version, dist build, config fields |
| `run_task` agent unavailable | `get_profiles`; install CLI or fix profile (docs/agent-profiles.md) |
| task stuck running | `query_task` tail, `cancel_task`, or restart server (marks interrupted) |
| skill not matched | skill auto-installs to `~/.rivet/skills/tianshu-mcp`; changes need a new session |
