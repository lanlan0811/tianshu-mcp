# Agent Profiles & Dynamic Discovery (English summary)

Full Chinese spec: [agent-profiles.md](agent-profiles.md). External AI-Agents plug in via **profiles** — declarative data in `~/.tianshu-mcp/agent-profiles.json` (env `TIANSHU_MCP_HOME` overrides). Adding an agent = one profile (no code change) unless custom output parsing is needed.

## Merge order

built-in (`src/agents/builtin.ts`) → user `agent-profiles.json` overrides by `id`.

## Fields

```jsonc
{
  "profiles": {
    "<agentId>": {
      "displayName": "…",
      "type": "cli",                 // only cli today
      "driver": "spawn",             // spawn = external child process (default); gui = desktop UI automation
      "status": "ready",             // ready | research | unsupported
      "command": null,               // absolute path; null + discovery = auto-probe
      "argsTemplate": ["exec", "<prompt:arg>"],
      "promptMode": "arg",           // arg | stdin | file
      "cwd": "task",                 // task = project dir, home = os home
      "env": {},
      "timeoutMs": 1800000,
      "killTree": "taskkill",        // legacy; platform is decided by code
      "executableDiscovery": {
        "dirs": ["{LOCALAPPDATA}/OpenAI/Codex/bin"],   // env placeholders, no hardcoded users
        "fileNames": ["codex.exe", "codex"],
        "fallbackCommand": "codex"
      },
      "gui": {                       // only for driver="gui" (e.g. traework)
        "cdpPort": 9222, "cdpPortAuto": true, "cdpPortRange": 20,
        "exeArgs": ["--remote-debugging-port=<port>"], "windowMode": "reuse",
        "launchTimeoutMs": 60000, "pollIntervalMs": 3000, "stableRounds": 12,
        "modelSwitch": true, "freshSession": true, "selectors": {}
      }
    }
  }
}
```

## driver (execution surface)

| value | meaning |
|---|---|
| `spawn` (default) | launches an external CLI child process (`argsTemplate` + `promptMode`); success is decided by exit code |
| `gui` | drives a desktop UI over CDP (currently only `traework`); no child process, and `run_task` may pass `model` to pick its model |

> With `driver=gui`, `argsTemplate`/`promptMode` are unused. See [traework-cdp.en.md](traework-cdp.en.md) for the `gui` section and its safety invariants.

## Discovery semantics (R5)

- `dirs` supports `{LOCALAPPDATA}` `{APPDATA}` `{HOME}` `{USERPROFILE}` `{PROGRAMFILES}` placeholders; empty `dirs` falls back to platform-standard locations (via PATH/OS rules, no hardcoded user names).
- Scanning only happens when `fileNames` is non-empty (avoids misclassifying arbitrary files).
- Resolution order: explicit existing `command` → discovery dirs (newest mtime) → PATH fallback → failure message.

## Prompt mode

| mode | how prompt is passed |
|---|---|
| `arg` | inlined into `argsTemplate` replacing `<prompt:arg>` |
| `stdin` | written to stdin |
| `file` | prompt file written, `<prompt:file>` points to it |

## Config hot reload (R5)

`config.json`, `agent-profiles.json`, `projects.json` caches are invalidated by file mtime+size on each read; registry resolve cache is keyed to the profile object identity, so edits apply without a restart. Parse failures keep the last valid config and log a warning.

## Status semantics

`ready` = command/discovery usable; `research` = probe attempted, placeholder if not found; `unsupported` = explicitly not drivable (e.g. ZCode).

> `traework` moved from `unsupported` to `ready` + `driver=gui` on 2026-09-08 (CDP-driven desktop UI; see [traework-cdp.en.md](traework-cdp.en.md)).

## Real-machine sample

```jsonc
{
  "profiles": {
    "codex": {
      "displayName": "Codex (desktop CLI)",
      "type": "cli", "status": "ready", "promptMode": "arg", "cwd": "task",
      "command": "C:/Users/<you>/AppData/Local/OpenAI/Codex/bin/<hash>/codex.exe",
      "argsTemplate": ["exec", "<prompt:arg>", "--skip-git-repo-check", "--sandbox", "workspace-write"],
      "timeoutMs": 1800000, "killTree": "taskkill",
      "executableDiscovery": {
        "dirs": ["{LOCALAPPDATA}/OpenAI/Codex/bin"],
        "fileNames": ["codex.exe", "codex"], "fallbackCommand": "codex"
      }
    }
  }
}
```
