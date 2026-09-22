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
      "adapter": "zcode-gui",        // GUI discriminator: traework-gui | zcode-gui | codex-gui | kimicode-gui | qoder-gui; missing keeps legacy TraeWork behavior
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
| `gui` | drives a desktop UI over CDP (currently `traework` / `zcode` / `codex` / `kimicode`); no child process, and `run_task` may pass `model` to pick its model |

> With `driver=gui`, `argsTemplate`/`promptMode` are unused. An explicit `adapter` isolates each GUI implementation; a legacy profile without it keeps TraeWork behavior. See [traework-cdp.en.md](traework-cdp.en.md), [zcode-cdp.en.md](zcode-cdp.en.md), [codex-gui-cdp.en.md](codex-gui-cdp.en.md), [kimi-cdp.en.md](kimi-cdp.en.md) and [qoder-cdp.en.md](qoder-cdp.en.md).

TraeWork liveness fields: `stableRounds` only confirms that the DOM is stable; `idle` is returned only after another
`idleTimeoutMs` without changes or authoritative running signals. `cdpSendTimeoutMs` bounds one CDP command, while
`progressIntervalMs` controls progress events visible through `query_task`. Idle, timeout, cancellation, and CDP loss
retain the instance and expose `agentEndReason` / `keptInstance` in metadata.

## Discovery semantics (R5)

- `dirs` supports `{LOCALAPPDATA}` `{APPDATA}` `{HOME}` `{USERPROFILE}` `{PROGRAMFILES}` `{PROGRAMFILES(X86)}` `{SYSTEMDRIVE}` and `{XDG_DATA_HOME}` placeholders. Matching is case-insensitive, while docs and built-in profiles use uppercase consistently. Unknown or unavailable placeholders remain unchanged. Empty `dirs` falls back to platform-standard locations (via PATH/OS rules, no hardcoded user names).
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

> `zcode` uses `driver=gui` + `adapter=zcode-gui`. It requires `provider/model`, confirms Full Access, and defaults to two automatic repair rounds. The Windows hardware loop is complete; the built-in profile remains `research` until the macOS hardware loop is recorded.

> `codex` uses `driver=gui` + `adapter=codex-gui` + `activation=msix-com`. Task parameters include `model` (e.g. `GPT-5.6 Sol`), `reasoningLevel` (低/中/高 or low/medium/high), `planDoc` and `designSystem`; it confirms Full Access and defaults to five automatic repair rounds. Machine-verified on Windows; the built-in macOS status is `research`. See [codex-gui-cdp.en.md](codex-gui-cdp.en.md).

> `kimicode` uses `driver=gui` + `adapter=kimicode-gui` + `activation=spawn` (a plain Electron install, measured 1.0.2). `model` is required and takes the UI model name directly (e.g. `K3`, `K2.8 Preview`, `stepfun/step-3.7-flash:free`), and `mode` is **not supported**; the CDP base port is `9666` (advancing through `cdpPortRange` when `cdpPortAuto`), `launchTimeoutMs` is 90000, and the defaults are the "fully automatic" permission mode and two automatic repair rounds. Machine-verified on Windows (success path / unregistered-workspace import + auto-acceptance / failure → rework → re-acceptance same-session loop); macOS is `research` and fail-closed. See [kimi-cdp.en.md](kimi-cdp.en.md).

> `qoder` uses `driver=gui` + `adapter=qoder-gui` (Qoder CN only). `projectPath` and a readable `planDoc` are mandatory; `modelSource` is optional (`default` / `custom`). The CDP base port is `9777` (advancing through `cdpPortRange` when `cdpPortAuto`), `launchTimeoutMs` is 90000, `stableRounds` is 2, and the default is three automatic repair rounds. Reasoning tiers are saved in Model Management as a **global preference** and read back; the permission mode is retained and "full access" is never enabled automatically. Machine-verified on Windows (default model in an existing workspace, custom model in a newly registered workspace, controlled failure → plan → same-session repair → re-acceptance); macOS is `research` and fail-closed. See [qoder-cdp.en.md](qoder-cdp.en.md).

### `reasoningLevel` domain and applicable tiers

Since v0.5.5 the `run_task.reasoningLevel` domain has grown, and v0.5.6 added the Qoder tiers:

| Values | Meaning |
|---|---|
| `low` / `medium` / `high` (aliases: `低` / `中` / `高`) | The generic three tiers, used by Codex |
| `max` / `on` / `off` | Kimi Code's UI tiers: official models use `Low` / `High` / `Max`, unofficial models only `On` / `Off` |
| `xhigh` / `极高`, `最大`, `关闭思考` | Qoder CN tier aliases (`最大` / `关闭思考` reuse `max` / `off`); only `qoder-gui` accepts the aliases, and other adapters reject them |

Per-agent applicability and semantics:

| agent | Applicable tiers | Behaviour |
|---|---|---|
| `codex` | `low` / `medium` / `high` | When omitted, the Codex panel's current level is kept |
| `kimicode` | official models `low` / `high` / `max`; unofficial models `on` / `off` | The tier set comes from **the tier labels the UI actually renders** (no built-in model list). When omitted, official tiers keep the UI's current value and unofficial tiers force `on`. Requesting a tier the UI does not render fails loudly with `model_mismatch` **before sending** and is never silently kept |
| `qoder` | 低 / 中 / 高 / 极高 (`xhigh`) / 最大 (`max`) / 关闭思考 (`off`) | The available set comes from **the options the selected model actually renders in Model Management**. An unsupported tier fails **before sending**; silent downgrades are forbidden. When omitted, the UI's current value is kept and reported; after saving, the dialog is reopened for readback, and the change persists as a global preference |
| `traework` / `zcode` / spawn agents | not applicable | Ignored, or rejected per that adapter's semantics |

## Real-machine sample

### Codex desktop (GUI driver, Windows-verified 2026-09-11)

```jsonc
{
  "profiles": {
    "codex": {
      "displayName": "Codex (ChatGPT desktop GUI)",
      "type": "cli",
      "driver": "gui",
      "adapter": "codex-gui",
      "status": "ready",
      "command": null, "argsTemplate": [], "promptMode": "arg", "cwd": "task",
      "timeoutMs": 1800000, "killTree": "taskkill",
      "authNote": "reuses ~/.codex (shared with any instance the user opened; the managed instance uses a dedicated user-data-dir)",
      "executableDiscovery": {
        // Appx query first (version-agnostic); scan fallback. No version numbers / absolute paths.
        "appxPackageName": "OpenAI.Codex",
        "installRelativeExe": ["app/ChatGPT.exe"],
        "scanRoots": ["{SYSTEMDRIVE}/Program Files/WindowsApps"],
        "scanPattern": "OpenAI.Codex_*_x64__*/app/ChatGPT.exe"
      },
      "gui": {
        "activation": "msix-com",
        "userDataDir": "{LOCALAPPDATA}/tianshu-mcp/codex-gui/profile",
        "appxPackageName": "OpenAI.Codex",
        "cdpPort": 9333, "cdpPortAuto": true,
        "permissionMode": "完全访问",
        "fixPlanDir": ".zcode/plans",
        "defaultAutoFixRounds": 5,
        "launchTimeoutMs": 60000, "pollIntervalMs": 3000,
        "stableRounds": 4, "idleTimeoutMs": 600000,
        "selectors": {}
      }
    }
  }
}
```

> **Essential**: `activation: "msix-com"` and `userDataDir` are both mandatory — the GUI host `ChatGPT.exe` cannot be launched directly (policy denies), and reusing the default profile means the debug port never opens. Details: [codex-gui-cdp.en.md](codex-gui-cdp.en.md).

### Kimi Code (GUI driver, Windows-verified 2026-09-20)

```jsonc
// ~/.tianshu-mcp/agent-profiles.json (Windows sample; these are the built-in defaults)
{
  "profiles": {
    "kimicode": {
      "displayName": "Kimi Code (Kimi Code desktop)",
      "type": "cli",
      "driver": "gui",
      "adapter": "kimicode-gui",
      "status": "ready",                 // "research" on darwin (fail-closed)
      "command": null,
      "argsTemplate": [], "promptMode": "arg", "cwd": "task",
      "timeoutMs": 1800000, "killTree": "taskkill",
      "authNote": "reuses the local Kimi Code login; an existing instance without CDP must be closed by the user first",
      "executableDiscovery": {
        "dirs": [
          "{PROGRAMFILES}/Kimi Code",
          "{PROGRAMFILES(X86)}/Kimi Code",
          "{LOCALAPPDATA}/Programs/Kimi Code",
          "{LOCALAPPDATA}/Kimi Code",
          "/Applications/Kimi Code.app/Contents/MacOS",
          "{HOME}/Applications/Kimi Code.app/Contents/MacOS"
        ],
        "fileNames": ["Kimi Code.exe", "Kimi Code"],
        "preferredDrives": ["D:"],
        "relativePaths": [
          "Kimi-Code/Kimi Code/Kimi Code.exe",
          "Kimi Code/Kimi Code.exe",
          "Kimi/Kimi Code/Kimi Code.exe",
          "kimi-code/kimi code/kimi code.exe"
        ]
      },
      "gui": {
        "cdpPort": 9666,                 // CDP base port; falls through cdpPortRange when taken
        "cdpPortAuto": true,
        "cdpPortRange": 20,
        "exeArgs": ["--remote-debugging-port=<port>"],
        "windowMode": "reuse",
        "launchTimeoutMs": 90000,        // cold-start first frame + render is measurably slow; widened to 90 s
        "pollIntervalMs": 3000,
        "stableRounds": 4,
        "idleTimeoutMs": 600000,
        "stallTimeoutMs": 300000,
        "cancelWaitMs": 15000,
        "cdpSendTimeoutMs": 15000,
        "progressIntervalMs": 30000,
        "modelSwitch": true,
        "modeSwitch": false,             // the mode parameter is not supported
        "freshSession": true,
        "modelRequired": true,
        "activation": "spawn",           // plain Electron install: launch directly (no MSIX COM)
        "permissionMode": "完全自动",
        "defaultPermissionMode": "完全自动",
        "defaultAutoFixRounds": 2,
        "workspaceTriggerTimeoutMs": 15000, // optional: cap for waiting on ws-chip mounting (draft-page criterion)
        "selectors": {}
      }
    }
  }
}
```

> **Essential**: Kimi Code is a **plain Electron install** (measured 1.0.2); injecting `--remote-debugging-port` is enough and **no** MSIX COM activation is needed.
> **Two renderer processes**: the model / thinking-tier / execution-mode menus render in the `Kimi Browser Overlay` window, while the workspace menu and the "switch model" dialog stay in the main window.
> Tasks are organised by **workspace** (task folder) and **project-less dispatch is not supported**: `projectPath` is mandatory, and an unregistered workspace is imported through the native "add workspace" dialog.
> The default permission is "fully automatic" and the default is two automatic repair rounds. Details: [kimi-cdp.en.md](kimi-cdp.en.md).

### Qoder CN (GUI driver, Windows-verified 2026-09-22)

```jsonc
// ~/.tianshu-mcp/agent-profiles.json (Windows sample; these are the built-in defaults)
{
  "profiles": {
    "qoder": {
      "displayName": "Qoder CN",
      "type": "cli",
      "driver": "gui",
      "adapter": "qoder-gui",
      "status": "ready",                 // "research" on darwin (fail-closed, dispatch disabled)
      "command": null,
      "argsTemplate": [], "promptMode": "arg", "cwd": "task",
      "authNote": "reuses the local Qoder CN login; an existing instance that cannot be connected is handled by the user and never restarted automatically",
      "executableDiscovery": {
        "preferredDrives": ["D:"],
        "relativePaths": ["Qoder CN/Qoder CN.exe", "Program Files/Qoder CN/Qoder CN.exe"],
        "fileNames": ["Qoder CN.exe"],   // ["Qoder CN"] on macOS
        "dirs": [
          "{LOCALAPPDATA}/Programs/Qoder CN",
          "{PROGRAMFILES}/Qoder CN",
          "{PROGRAMFILES(X86)}/Qoder CN"
        ]
      },
      "gui": {
        "cdpPort": 9777,                 // CDP base port; falls through cdpPortRange when taken
        "cdpPortRange": 20,
        "launchTimeoutMs": 90000,
        "cdpSendTimeoutMs": 30000,
        "stableRounds": 2,
        "defaultAutoFixRounds": 3,
        "modeSwitch": false,             // the mode parameter is not supported
        "modelRequired": false,          // model and tier may be omitted and the UI's current values are kept
        "selectors": {}
      }
    }
  }
}
```

> **Essential**: `projectPath` and `planDoc` are mandatory; `modelSource` is optional and only needed to disambiguate identical names across the default/custom groups.
> An invalid explicit `gui.exePath` fails loudly instead of silently falling back to another installation; an existing instance without usable CDP is preserved in place and turned into `needs_user` — it is never closed or restarted. An unregistered directory is imported through New Task → Workspace → New Workspace → Add Read/Write Folder.
> Thinking tiers are saved in Model Management as a **global preference** (not restored afterwards) and the permission mode is retained. Details: [qoder-cdp.en.md](qoder-cdp.en.md).

### Historical: Codex kernel CLI (`codex exec`, superseded by the GUI driver)

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

> Kept as a historical record; this path is no longer the built-in default.

## ZCode / Kimi Code automatic initialization recovery

Override these `gui` fields in the data-home `agent-profiles.json`. Older profiles inherit the defaults; other drivers do not use these recovery settings.

| Field | Default | Meaning |
|---|---:|---|
| `setupRecoveryTimeoutMs` | 120000 | Total initialization-through-binding budget in milliseconds |
| `projectTriggerTimeoutMs` | 15000 | Cap for waiting on the ZCode project trigger to become ready (also the budget for confirming the menu opens after a click) |
| `workspaceTriggerTimeoutMs` | 15000 | **Optional** (Kimi Code only): cap for waiting on the workspace trigger (`button.ws-chip`) to mount, i.e. the criterion for "the draft page really exists". ZCode does not use this field. It is deliberately optional rather than defaulted so that existing profile literals need not change |
| `dialogProbeTimeoutMs` | 30000 | One native dialog observation, milliseconds |
| `dialogOperationTimeoutMs` | 60000 | One folder operation, milliseconds |
| `setupRecoveryMaxRetries` | 2 | Additional attempts for safely retryable stages (0–10) |

Each wait uses the minimum of its configured cap, remaining setup time and remaining task time. Retries never reset the deadline. After binding, only the task deadline applies. Initialization progress uses `progressIntervalMs`.
