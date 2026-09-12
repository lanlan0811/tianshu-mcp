# Agent Capability Matrix (English summary)

Full Chinese: [adapter-matrix.md](adapter-matrix.md). We only integrate agents with an official
headless CLI/API **or a verified programmatic GUI driver**; agents without either are marked
`unsupported` (no pty hacks). Electron GUI automation is allowed only through a product/process-verified local CDP adapter; private internal protocols remain out of scope.

## Matrix (as of 2026-09-11)

| Agent | Interface | Status | Login | Notes |
|---|---|---|---|---|
| **Codex** (OpenAI desktop) | **MSIX GUI + CDP** (`codex-gui` adapter) | ✅ **Windows machine-verified** (COM activation + CDP + key selectors + verify/repair loop, 2026-09-11; see [codex-windows-smoke.en.md](codex-windows-smoke.en.md); macOS marked research) | reuses `~/.codex` (auth.json); shared with any instance the user opened | GUI host `app\ChatGPT.exe` cannot be launched directly (policy denies); must use `IApplicationActivationManager` with a dedicated `--user-data-dir` and injected `--remote-debugging-port`; see [codex-gui-cdp.en.md](codex-gui-cdp.en.md) |
| **Zcode** (ZCode desktop) | Electron + dedicated `zcode-gui` CDP adapter | **research** (Windows 3.11.2 selectors adapted; macOS pending) | machine login | direct model selection with provider/family fallback; composer project checkbox and binding read-back; see [zcode-cdp.en.md](zcode-cdp.en.md) and [zcode-windows-smoke.en.md](zcode-windows-smoke.en.md) |
| **TraeWork / TRAE SOLO CN** | desktop IDE + **CDP GUI driver** | ✅ **integrated & machine-verified** (2026-09-08; see T1 correction and [traework-cdp.en.md](traework-cdp.en.md)) | reuses TraeWork desktop login (this MCP reads no credentials) | no headless CLI; drives the chat UI via `--remote-debugging-port`; replies extracted from the DOM |

## Extending

1. Add a profile in `agent-profiles.json` (usually zero code).
2. If custom output parsing is needed, implement `AgentAdapter` and `registry.register(id, adapter)`.
3. `get_profiles` self-checks discovery; run one stub/codex smoke.

## Research conclusions

- **Z1 (ZCode headless)**: install at `D:\Z-Code\ZCode` is a standard Electron app; no `cli.js`/headless launcher/`cli.exe`; `resources/tools/` = cua-helper, ripgrep, ugrep only; `~/.zcode/cli` is runtime session data. The headless route remains unsupported. A separate CDP GUI route is now implemented and stays `research` until Windows and macOS hardware loops pass; see [zcode-cdp.en.md](zcode-cdp.en.md).
- **T1 (TraeWork)**: `D:\TRAE Work CN` = TRAE SOLO CN v1.107.1. There is **no headless agent CLI** (only VS Code-family commands: `open`/`serve-web`/extension mgmt) — that part of the original conclusion stands. **Correction (2026-09-08)**: TraeWork supports `--remote-debugging-port`, so the GUI route is viable; a CDP driver is implemented and machine-verified (`run_task(agentId="traework")` created a file and auto-verification passed). Status is now **`ready` with `driver: "gui"`**. Details: [traework-cdp.en.md](traework-cdp.en.md).
- **C1 (codex exec flags)**: prompt as arg or stdin; `-C/--cd` workdir; `--sandbox workspace-write` non-interactive; `--json` JSONL events; `-o` last message; `--ephemeral`. See [m2-smoke-record.md](m2-smoke-record.md) for the finalized profile.
- **C2 (Codex desktop GUI, 2026-09-11)**: the desktop app is an MSIX package; `C:\Program Files\WindowsApps\...\app\ChatGPT.exe` cannot be started directly (`Access is denied`, Win32 `0x80070005`) because of the AppX execution tag, **but** `IApplicationActivationManager::ActivateApplication(AUMID, args, 0)` succeeds and forwards `args` verbatim — so `--remote-debugging-port` can be injected and CDP works. A dedicated `--user-data-dir` is mandatory (the single-instance lock is per profile; reusing the default profile means the port never opens). Verified on hardware: discovery via `Get-AppxPackage`, activation, CDP connection, and key selectors (input box, model trigger `GPT-5.6 Sol 高`, sidebar projects). Status is **`ready` with `driver: "gui"`**; this supersedes the earlier `codex exec` headless path. Details: [codex-gui-cdp.en.md](codex-gui-cdp.en.md).

> Corrections: earlier versions wrongly concluded "Trae not installed" (only `%APPDATA%` checked); the real install was found under `D:\`. Zcode was earlier marked "pending product confirmation"; the real install under `D:\Z-Code` settled it as unsupported. TraeWork was marked unsupported based on the headless-CLI test only; the CDP GUI route was later verified and integrated.
