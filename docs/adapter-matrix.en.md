# Agent Capability Matrix (English summary)

Full Chinese: [adapter-matrix.md](adapter-matrix.md). We only integrate agents with an official headless CLI/API; agents without one are marked `unsupported` (no pty hacks, no default GUI automation).

## Matrix (as of 2026-09-07)

| Agent | Interface | Status | Login | Notes |
|---|---|---|---|---|
| **Codex** (OpenAI desktop) | local CLI `codex.exe` | ✅ **smoke-passed** (run_task→verify_task, see [m2-smoke-record.md](m2-smoke-record.md)) | reuses `~/.codex` | `codex exec "<prompt>" --sandbox workspace-write` (don't combine with --approve-for-me) |
| **Zcode** (ZCode desktop) | Electron app, no shipped headless CLI | ❌ **unsupported** (Z1) | machine login | packaged tools are only cua-helper/ripgrep/ugrep |
| **TraeWork / TRAE SOLO CN** | desktop IDE, no headless agent interface | ❌ **unsupported** (T1) | — | VS Code-family CLI only; `byted-solo.builtin-mcp` is a client ext |
| **stub** | local script | ✅ test-only | none | M1 integration tests |

## Extending

1. Add a profile in `agent-profiles.json` (usually zero code).
2. If custom output parsing is needed, implement `AgentAdapter` and `registry.register(id, adapter)`.
3. `get_profiles` self-checks discovery; run one stub/codex smoke.

## Research conclusions

- **Z1 (ZCode headless)**: install at `D:\Z-Code\ZCode` is a standard Electron app; no `cli.js`/headless launcher/`cli.exe`; `resources/tools/` = cua-helper, ripgrep, ugrep only; `~/.zcode/cli` is runtime session data (not an entry). → **unsupported**.
- **T1 (TraeWork)**: `D:\TRAE Work CN` = TRAE SOLO CN v1.107.1; CLI (`bin/trae-solo-cn.cmd` → `out/cli.js`) has only VS Code-family commands (`open`/`serve-web`/extension mgmt) — no `agent exec`; no codex-style binary anywhere. → **unsupported**.
- **C1 (codex exec flags)**: prompt as arg or stdin; `-C/--cd` workdir; `--sandbox workspace-write` non-interactive; `--json` JSONL events; `-o` last message; `--ephemeral`. See [m2-smoke-record.md](m2-smoke-record.md) for the finalized profile.

> Corrections: earlier versions wrongly concluded "Trae not installed" (only `%APPDATA%` checked); the real install was found under `D:\`. Zcode was earlier marked "pending product confirmation"; the real install under `D:\Z-Code` settled it as unsupported.
