# tianshu-mcp v0.5.1 Release Notes

**Core theme**: **documentation and validation-evidence completion**. The orchestration skill docs are aligned with the real v0.5.0 tool surface, the Windows 10 full functional matrix and macOS dual-architecture platform evidence for visual acceptance are archived, and one stale version-metadata defect is fixed.

This is a **PATCH** release: **no runtime behaviour changes**. Tool parameters, report fields and acceptance configuration formats are identical to v0.5.0, so upgrading requires no caller changes.

## Added

- **Windows 10 full functional matrix evidence script** (`scripts/evidence-visual-windows.mjs`, `npm run evidence:visual:windows`): collects the real-browser matrix the plan requires on this machine — the `existing` / static / command page sources, blocking on port conflict without terminating another service, bounded readiness failure that cleans up the child process, desktop/mobile/full-page/element captures on managed Chrome, a local Edge isolated acceptance instance with its real version echoed, observable version mismatch, and blocking when an explicit browser path is missing. Measured **9/9 passed**.
- **Archived validation evidence** (`docs/visual-validation-evidence/`): the Windows 10 matrix JSON and test output, the macOS dual-architecture `environment.json` files (OS kernel, architecture, Node, browser version and result) and the CI summaries, all committed verbatim. The evidence ships with the package and can be checked independently.

## Fixed

- **Stale `package-lock.json` version**: at the v0.5.0 release the lockfile's root package version was still `0.4.1` while `package.json` said `0.5.0`. This release syncs both to `0.5.1`, removing the lockfile/manifest version drift.

## Docs

- **Skill docs aligned with the code** (`skills/tianshu-mcp/SKILL.md` + `usage-examples.md`): each item was checked against the `src/` tool definitions, input schemas, enums and meta construction, then corrected —
  - a full 11-tool table with capability/approval columns (the `description` previously claimed 11 tools but listed only 9);
  - visual acceptance now has its own section (blockers do not trigger agent repair, `rework_task` re-verifies first, baselines require user approval, rule freezing raises `VISUAL_INTEGRITY`, bypassing is forbidden);
  - the error table gains `setup_recovery`, and the full `errorType` value set is listed separately;
  - agent status semantics corrected (`traework` is always `ready`, `codex` is platform-dependent, `zcode` is `research`);
  - clarified that `get_task_report` returns the report verbatim with no meta block, and removed the mis-listed `reasoningLevel` from the meta table (it is an input only, never echoed);
  - the auto repair-plan location is now distinguished per agent (codex writes inside the project's `.zcode/plans/`; others write to the MCP task directory);
  - added that `continue_task` only supports codex/zcode, the actual `list_tasks` output columns, and the visual CLI commands.
- **Validation progress rewritten** (`docs/visual-validation{,.en}.md`) into full platform evidence tables (system / Node / browser version / command / result) instead of a vague list of pending gates.
- **Bilingual README and CHANGELOG** synced to v0.5.1; `HANDOFF.md` rewritten against the current code and commit history.

## Tests and validation

- Full suite: **486 passed / 10 skipped** (Windows 10 x64, Node 24); the 10 real-browser-gated cases pass **10/10** when run with `TIANSHU_VISUAL_BROWSER_TEST=1`.
- **Windows 10 x64 local matrix 9/9 passed**; on **macOS 15 hardware runners**, Intel x64 and Apple Silicon arm64 (Node 20/22/24) each passed **10 files with 51 cases**.
- `typecheck` / `lint` / `build` / `pack:check` and the strict stdio check (11 tools, 6 scenarios) all pass; the build leaves no unexpected tracked changes.
- The CI `visual-browser` matrix (ubuntu/windows/macos-15-intel/macos-15 × Node 20/22/24) is green with v0.5.0 and with this commit.

> Known flake: the `test/integration/zcode-flow.test.ts` case "task deadline stops MCP waiting and keeps the instance" has a timing race under full parallel load (`taskTimeoutMs: 2` competing with scheduling); it passes when the file runs alone and on CI retry. The case predates this release and v0.5.1 does not change its semantics.

## Distribution and compatibility

- GitHub is the primary repository; Gitee mirrors code, tags and releases; npm publishes `tianshu-mcp@0.5.1` (`latest`).
- **No breaking changes**: caller API, tool parameters, meta-block fields, report format and acceptance configuration are unchanged from v0.5.0.
- The visual module requires Node.js ≥20.3; non-visual features keep Node.js ≥20.

Related docs: [Visual acceptance guide](visual-acceptance.en.md) | [Validation progress](visual-validation.en.md) | [Project README](../README.en.md) | [CHANGELOG](../CHANGELOG.en.md) | [Handoff](../HANDOFF.md)
