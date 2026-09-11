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
      "adapter": "zcode-gui",        // GUI discriminator: traework-gui | zcode-gui; missing keeps legacy TraeWork behavior
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
        "fallbackCommand": "codex",
        "preferredDrives": ["D:"],
        "relativePaths": ["Z-Code/ZCode/ZCode.exe"]
      },
      "gui": {                       // only for driver="gui" (e.g. traework)
        "cdpPort": 9222, "cdpPortAuto": true, "cdpPortRange": 20,
        "exeArgs": ["--remote-debugging-port=<port>"], "windowMode": "reuse",
        "launchTimeoutMs": 60000, "pollIntervalMs": 3000, "stableRounds": 12,
        "idleTimeoutMs": 600000, "cdpSendTimeoutMs": 15000, "progressIntervalMs": 30000,
        "modelSwitch": true, "modeSwitch": true, "freshSession": true, "selectors": {},
        "modelRequired": false, "defaultPermissionMode": "Full Access", "defaultAutoFixRounds": 2
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

> With `driver=gui`, `argsTemplate`/`promptMode` are unused. An explicit `adapter` isolates TraeWork and ZCode; a legacy profile without it keeps TraeWork behavior. See [traework-cdp.en.md](traework-cdp.en.md) and [zcode-cdp.en.md](zcode-cdp.en.md).

TraeWork liveness fields: `stableRounds` only confirms that the DOM is stable; `idle` is returned only after another
`idleTimeoutMs` without changes or authoritative running signals. `cdpSendTimeoutMs` bounds one CDP command, while
`progressIntervalMs` controls progress events visible through `query_task`. Idle, timeout, cancellation, and CDP loss
retain the instance and expose `agentEndReason` / `keptInstance` in metadata.

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

`ready` means command/discovery is usable and its release evidence is complete. `research` means an implementation exists but hardware evidence is incomplete: `run_task` is allowed when installation discovery succeeds and otherwise fails with a diagnostic. `unsupported` means explicitly not drivable.

> `traework` moved from `unsupported` to `ready` + `driver=gui` on 2026-09-08 (CDP-driven desktop UI; see [traework-cdp.en.md](traework-cdp.en.md)).

> `zcode` uses `driver=gui` + `adapter=zcode-gui`. It requires `provider/model`, confirms Full Access, and defaults to two automatic repair rounds. The built-in profile remains `research` until both Windows and macOS hardware loops are recorded.

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
