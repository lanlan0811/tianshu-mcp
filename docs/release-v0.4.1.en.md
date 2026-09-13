# tianshu-mcp v0.4.1 release notes

**Documentation release**: the orchestration skill docs (`skills/tianshu-mcp/`) are aligned with the
actual v0.4.0 tool surface, and the open-source repos now credit community contributors.
**There are no code behaviour changes** — callers need no changes to upgrade.

## Added

- **Skill docs fully aligned with the v0.4.0 tool surface** (`SKILL.md` + `usage-examples.md`,
  idempotently synced into `~/.rivet/skills/tianshu-mcp/` at server startup). The skill docs had not
  kept up with the v0.3.3 → v0.4.0 changes since v0.3.2; this release closes every gap:
  - **projectPath safety gate** (introduced in v0.4.0 but undocumented in the skill): absolute path +
    existing directory + realpath canonicalization, rejection of the home directory and system/root
    directories, and the dirty-repo coexistence warning. The docs now state clearly that this is an
    **infrastructure rejection** — retry with a correct path rather than treating it as an agent failure.
  - **Hard-failure error-code reference**: meaning and handling for `setup_failed` / `project_ambiguous` /
    `project_mismatch` / `project_create_failed` / `model_unavailable` / `model_mismatch` /
    `permission_unknown` / `cdp_disconnected` / `instance_busy` / `session_lost` / `input_mismatch` /
    `send_unknown` / `idle_timeout` / `task_timeout` / `aborted`. Hard failures **never enter acceptance
    or auto-rework**, so retrying them blindly is wasted effort.
  - **All `needs_user` kinds documented**: adds `setup_recovery` (zcode initialization recovery with
    retries and budget exhausted — typically duplicate project names, inconsistent binding read-back, or
    native-panel timeouts), plus the `continue_task` restrictions (only `needs_user`; codex supports only
    `login_required`/`user_confirmation`; zcode refuses to recover when the session anchor is lost).
  - **codex-cli headless path**: how to use a user-defined `driver=spawn` profile, that `model` does not
    apply to it, and that the codex CLI must be ≥0.154.0 (≤0.130.0 has a revoked signing certificate).
  - **Status semantics**: the difference between `ready` and `research` (`research` is still executable,
    just not fully covered by the platform matrix) and the current value per platform.
  - **Acceptance behaviour change**: checks are **parallel by default (2)** since v0.4.0
    (`verifyConcurrency` 1–4), order-dependent checks must explicitly set `1`, and the `requireChanges`
    zero-change gate affects read-only/investigation tasks.
  - **usage-examples.md** adds: a `codex-cli` dispatch example, the full meta-block field table (now
    including `agentEndReason`/`lastRunSignal`/`checks`/`round`/`keptInstance`/`zcodeSessionId`/
    `modelProvider`/`permissionMode`/`progressSummary`), an error-code reference table, a project-level
    `.tianshu-mcp/acceptance.json` template (with the parallel-interference warning), a `setup_recovery`
    recovery example, and the profile whole-key override semantics.
- **Bilingual README contributor credits**: a new "Contributors" section lists, in order of first
  participation, the community members who took part through Issues and pull requests (avatar + name,
  linking to their profiles).

## Fixed

- No code fixes. This release contains no runtime behaviour changes.

## Upgrade notes

- **No migration required**: the caller API, tool parameters, meta-block fields, and acceptance-config
  format are identical to v0.4.0.
- Environments with an older installed skill will pick up the new one automatically at the next server
  start (files are only overwritten when their content hash changes; the previous copy is backed up as
  `.bak-<timestamp>`).

## Platform & verification status

- **Windows 10 x64**: local gates (`typecheck` / `lint` / `build` / `pack:check` / strict stdio) and all
  **443/443** tests are green.
- **macOS**: the **basic closed loops** for `codex` and `zcode` were machine-verified by the contributor
  on macOS arm64; **the cancel / rework / `continue_task` / new-project matrices are not covered, and
  both remain `research` on darwin**. The maintainer has no macOS device, so this is not independently
  re-verified.

## Distribution & compatibility

- A GitHub Release with tarball is published, alongside npm (`tianshu-mcp@0.4.1`, `latest`). GitHub is
  the primary repository; Gitee mirrors the code, tags and releases.
- This is a **PATCH** release: documentation and metadata only, no breaking changes.

Related docs: [project README](../README.en.md) | [CHANGELOG](../CHANGELOG.en.md) |
[SKILL.md](../skills/tianshu-mcp/SKILL.md) | [usage examples](../skills/tianshu-mcp/usage-examples.md)
