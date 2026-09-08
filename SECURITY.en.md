# Security Policy

## Supported versions

Security fixes target the latest released version only. Please upgrade before reporting.

| Version | Supported |
|---|---|
| 0.1.x (latest) | ✅ |
| Earlier versions | ❌ |

## Reporting a vulnerability

**Do not report security vulnerabilities through public issues.**

Please use GitHub's private vulnerability reporting:

1. Open <https://github.com/lanlan0811/tianshu-mcp/security/advisories/new>
2. Or use the repository's **Security → Advisories → Report a vulnerability**.

Please include as much as you can:

- affected version (`npm view tianshu-mcp version` or `package.json`);
- reproduction steps (minimal config/commands);
- impact assessment (what can be read/written, whether local access is required);
- mitigation suggestions if known.

**Expected response**: acknowledgement within 7 days, and a fix or mitigation plan within 30 days.
After a fix ships we will credit you in the release notes and [CHANGELOG.en.md](CHANGELOG.en.md)
(let us know if you prefer to stay anonymous).

## Security model (design boundaries)

Understanding these boundaries helps you judge whether a finding is intended behavior.

### 1. Zero credential management

- This MCP **never stores, reads, or forwards** any external AI-Agent API key or login state.
- Each agent uses its own login state (e.g. Codex uses `~/.codex`; TraeWork uses its desktop login state).
- The TraeWork driver only manipulates the UI over CDP and **does not touch** its credential files.

### 2. Narrow command-execution surface

- Verification commands come from **whitelist-style structured config** (`name` + `cmd` as argv arrays),
  **never string-concatenated shell**, and `shell: true` is not used by default.
- Commands run inside the **target project directory** and are bounded by `verifyCommandTimeoutMs`.
- Task artifacts (logs, reports, repair plans) are written only to the task data directory and the
  project's `.tianshu-mcp/`.

### 3. Processes and paths

- Path parameters must be absolute and exist, and are normalized.
- Child processes use `windowsHide` and stdio pipes; termination uses a process-tree kill
  (Windows `taskkill /T /F`, POSIX process-group SIGTERM→SIGKILL).
- **Extra constraints for the GUI driver (TraeWork)**:
  - reuse an existing user instance by default; never start a second one;
  - never blind-kill a process tree; verify command-line ownership before terminating, and abort with a
    warning if it cannot be confirmed;
  - always pass native platform paths to the GUI process.

### 4. Desktop-automation whitelist

The built-in computer-use is allowed **only** to drive TraeWork's folder picker (window-title match plus a
host-process whitelist). Anything else (browser, terminal, editor, system dialogs) is refused with
`COMPUTER_USE_DENIED`.

### 5. Permission approvals

Write/execute tools (`run_task` / `cancel_task` / `rework_task`) declare `requireApproval` by default and
are gated by the host (Tianshu) UI; read/query/verify tools need no approval.

### 6. Code protection

- A git baseline (HEAD + dirty state) is captured before work starts; verification reports compute changes
  relative to that baseline.
- This project **never** auto-commits / stashes / rolls back; the user decides based on the report.

## Dependencies and supply chain

- Minimal runtime dependencies: `@modelcontextprotocol/sdk`, `zod`, `cross-spawn`.
- `npm audit` should report no known vulnerabilities before committing; CI runs typecheck, lint, tests and
  build on Ubuntu/Windows/macOS × Node 20/22.
- Published artifacts pass an `npm pack` content check (must include `dist/`, skills, both READMEs,
  LICENSE, `assets/`).

## Out of scope

- The behavior and vulnerabilities of external AI-Agents (report those to their vendors).
- Sensitive `env` values a user puts into their own profile (a local, self-managed field; never written to
  task logs).
- Escalation caused by a user granting excessive system permissions.
