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
- **AI content validation (optional, off by default) adds no credential management either**: the MCP reads
  no keys, implements no model/vendor HTTP client, and ships no agent-CLI presets. Judgement is fully
  **delegated to a user-declared local command**, which uses its own login state or key. The MCP only
  expands a template into argv, spawns that command (`shell:false` with structured argv), and parses the
  JSON on the last stdout line.

**Where the enforcement actually stops (read this literally)**:

- Whether an image leaves the machine **depends on the behaviour of the user's own command**; the MCP
  cannot block that at the system level.
- The MCP's enforcement is **contract-level only**: `allowRemote` defaults to `false`, and a rule that has
  not explicitly opted in may **not** use the byte-egress placeholder `<image:base64:file>` in its
  `argsTemplate` (the schema rejects that configuration outright rather than warning at runtime).
- `visual doctor` lists each rule's `allowRemote` declaration for human review.
- Users must therefore confirm their command's real behaviour themselves; the MCP makes no vague promises
  about this.

### 2. Narrow command-execution surface

- Verification commands come from **whitelist-style structured config** (`name` + `cmd` as argv arrays),
  **never string-concatenated shell**, and `shell: true` is not used by default.
- Commands run inside the **target project directory** and are bounded by `verifyCommandTimeoutMs`.
- AI content validation commands are likewise spawned with `shell:false` and structured argv, bounded by
  `visual.content.timeoutMs`, and killed as a process tree. User-declared environment variables use the
  `{ childVarName: hostVarName }` reference form and block the whole round when missing; the MCP itself
  does not read the value of that variable.
- Task artifacts (logs, reports, repair plans) are written only to the task data directory and the
  project's `.tianshu-mcp/`.

### 2.1 Supply-chain boundary of skill self-install (issue #16)

- **Single content source**: the shipped skill is located **relative to the package only**
  (`skills/tianshu-mcp/` via `import.meta.url`); content is **never discovered from the current working
  directory** — closing the case where "debugging the server inside a third-party repository that happens
  to carry the same path" installs that repository's content into `~/.rivet/skills/` for the next session.
- **No silent overwrite**: the target keeps a content-hash manifest; on **local edits** (manifest record
  ≠ target content) or an **unknown source** (no valid manifest) the existing content is **kept with a
  warning** by default and never silently replaced. Automatic upgrade only happens when content is provably
  untouched, or when the user explicitly passes `--approve-skill-update` /
  `TIANSHU_MCP_APPROVE_SKILL_UPDATE=1`.
- **Reversible**: before an overwrite the old directory is backed up as `<dest>.bak-<timestamp>`, and
  retained backups are governed by `skills.backupKeep` (default 3, `0` = never prune).
- This module writes only under `~/.rivet/skills/` (`os.homedir()` resolved dynamically) and its
  backup/temporary directories; it never touches project directories and reads no credentials.

### 3. Processes and paths

- Path parameters must be absolute and exist, and are normalized.
- **Dangerous-directory gate (`assertSafeProjectDir`)** — the write-capable entry points (`run_task` / `verify_task`) refuse:
  - **System directories and their subtrees**: `/etc`, `/usr`, `/bin`, `/sbin`, `/private/etc` (the macOS realpath shape) and `c:/windows`, `c:/program files`, `c:/program files (x86)`. Matching is **boundary-aware** (the prefix must be followed by `/`), so `c:/windows.old` and `/etcetera` are not falsely matched.
  - **Exact roots only**: `/`, drive roots (`C:\`, `D:\`, …), `/var`, `/tmp`, `/opt`, the home directory, `c:/users`, and so on.
- **Why `/var` and `/tmp` block only the exact root**: legitimate workspaces live underneath them — on macOS `os.tmpdir()` *is* `/var/folders/...`, so a subtree rule there would also refuse the test base and many temporary workspaces. This is a deliberate trade-off; residual edges are recorded in [ARCHITECTURE §15](ARCHITECTURE.en.md).
- Child processes use `windowsHide` and stdio pipes; termination uses a process-tree kill
  (Windows `taskkill /T /F`, POSIX process-group SIGTERM→SIGKILL).
- **Extra constraints for the GUI driver (TraeWork)**:
  - reuse an existing user instance by default; never start a second one;
  - never blind-kill a process tree; verify command-line ownership before terminating, and abort with a
    warning if it cannot be confirmed;
  - always pass native platform paths to the GUI process.

### 4. Desktop-automation whitelist

Native automation is allowed **only** for a folder picker newly opened by TraeWork or ZCode whose owner process is verified. Anything else (browser, terminal, editor, system dialogs) is refused with
`COMPUTER_USE_DENIED`.

### 5. Permission approvals

Side-effecting write tools (`run_task` / `cancel_task` / `rework_task` / `continue_task` /
`prepare_visual_baseline` / `approve_visual_baseline`) declare `requireApproval` by default and are gated by the host (Tianshu) UI.
Read/query tools need no approval. **`verify_task` has capability `execute` (it runs project commands and may produce build
artifacts, so its MCP `readOnlyHint` is false) but is still approval-free per R11** — this project does not
require per-call authorisation merely because of the "execute" classification.

### 6. ZCode GUI boundary

- CDP only connects to `127.0.0.1`; both the ZCode page identity and owning debug-port process are checked.
- Login data, keys, and credentials are never read, copied, decrypted, or printed. The packaged private `app-server` protocol is not called.
- A running non-CDP instance only produces `needs_user` and is never closed automatically. Timeouts and disconnects preserve the window and do not click Stop.
- Folder paths are passed through environment variables or argv and are read back before confirmation.

### 7. Code protection

- A git baseline (HEAD + dirty state) is captured before work starts; verification reports compute changes
  relative to that baseline.
- This project **never** auto-commits / stashes / rolls back; the user decides based on the report.

## Dependencies and supply chain

- Minimal runtime dependencies: `@modelcontextprotocol/sdk`, `zod`, `cross-spawn`.
- `npm audit` should report no known vulnerabilities before committing; CI runs typecheck, lint, tests and
  build on Ubuntu/Windows/macOS × Node 20/22/24.
- Published artifacts pass an `npm pack` content check (must include `dist/`, skills, both READMEs,
  LICENSE, `assets/`).

## Out of scope

- The behavior and vulnerabilities of external AI-Agents (report those to their vendors).
- Sensitive `env` values a user puts into their own profile (a local, self-managed field; never written to
  task logs).
- Escalation caused by a user granting excessive system permissions.
