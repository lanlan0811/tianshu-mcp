# tianshu-mcp v0.5.7 release notes

[简体中文](release-v0.5.7.md)

**Documentation release**: the orchestration skill docs (`skills/tianshu-mcp/`) were rewritten item by item against the current code. **There is no runtime behaviour change in this release**, so callers need no updates; only what Tianshu reads as skill guidance changes.

## Skill docs rewritten (`SKILL.md` + `usage-examples.md`)

Every claim was checked against `src/mcp/tools.ts`, `src/config/schema.ts`, `src/tasks/task.ts`, `src/tasks/task-manager.ts`, `src/loop/fix-loop.ts`, `src/mcp/formatter.ts`, `src/agents/builtin.ts` and the five GUI adapters:

- **Parameter compatibility matrix**: `projectPath` / `model` / `modelSource` / `reasoningLevel` / `mode` / `planDoc` / `designSystem` / `allowCreateProject` / `continue_task` across the five built-in agents, stating plainly that a wrong parameter is rejected rather than silently ignored (for example, the aliases `极高` / `最大` / `关闭思考` are accepted by qoder only).
- **Default precedence**: a new table for `autoVerify` (the server default is **on**), `autoFixRounds` (codex 5 / zcode 2 / kimicode 2 / qoder 3 / traework falling back to the server default 0) and `taskTimeoutMs`.
- **Kimi Code tier correction**: the domain is `低/low`, `高/high`, `max`, `on`, `off` — deliberately **without `中`/`medium`**. The tier set is validated against the labels the UI actually renders, an omitted tier forces `on` for unofficial models, and a tier the UI does not render fails before sending.
- **qoder section completed**: `modelSource` disambiguation, saving the tier in Model Management and reading it back by reopening, the global preference never being restored, send/answer checkpoints that prevent resends, automatic and manual repair both writing a plan and sending its full text back, and macOS dispatch being disabled; plus a multi-question JSON answer example keyed by the UI's exact question text.
- **`needsUserKind` × agent × `continue_task` matrix**: the six wait kinds across codex/zcode/kimicode/qoder, stating which are confirmation-only, which re-send the complete brief, which deliver content to the original session, and that a lost anchor always fails closed.
- **`agentEndReason` → terminal state mapping**: how `task_timeout` / `idle_timeout` / `cdp_disconnected` differ from other hard failures, plus the previously missing `project_not_registered`, `unsupported_platform` and `qoder_error` (18 concrete codes) entries.
- **Meta field table completed**: `qoderSessionId`, `actualModel`, `actualReasoningLevel`, `modelSource` and `guiStop`, noting that `reasoningLevel` is an input that is never echoed and that codex's effective tier is only visible in its panel.
- **Verification usage clarified**: the three `verify_task` modes (task re-verification only updates the verdict fields; an independent `projectPath` accepts only a git ref as `baselineRef`; manual verification allocates its own report round) and the required arguments of `prepare_visual_baseline` / `approve_visual_baseline` (a UUID candidate plus a 64-hex digest and an approval note).
- **Structure**: the main file teaches the method and decision boundaries while the sub-file only provides copy-ready shapes; duplicated and outdated paragraphs were removed.

## Distribution and activation

- The skill ships with the package (the `files` list includes `skills`) and the server idempotently syncs it into `~/.rivet/skills/tianshu-mcp/` by content hash; only changed content is overwritten and the old copy is backed up as `.bak-<timestamp>`.
- **It takes effect in a new session** — there is no hot reload, so an already-open session keeps the old text; open a new session or restart the host.
- The skill directory is Chinese-only by long-standing convention; the bilingual release notes are this file and [简体中文](release-v0.5.7.md).

## Gates and evidence

- Full regression: **826 passed / 12 skipped** (Windows 10 x64, Node 24.18.0; 78 test files passed plus 3 real-browser files skipped by design); typecheck, lint, build and the six strict stdio scenarios all pass.
- A skill-format gate (`test/unit/skill-format.test.ts`) covers the frontmatter constraints and the required structure of the sub-file.
- This is a **PATCH** release: no runtime behaviour change, and existing caller signatures, report fields and error-code semantics stay **backward compatible**.

Related docs: [Project README](../README.en.md) | [CHANGELOG](../CHANGELOG.en.md) | [Skill docs SKILL.md](../skills/tianshu-mcp/SKILL.md) | [Usage examples](../skills/tianshu-mcp/usage-examples.md)
