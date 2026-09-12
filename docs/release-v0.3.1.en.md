# tianshu-mcp v0.3.1 Release Notes

v0.3.1 is a **docs and release-automation housekeeping release**: no source-level behavior changes
and no changes to any adapter or the acceptance engine.

It covers two things:

1. **A full rewrite of the self-installed skill docs (`skills/tianshu-mcp/`)**, verified item by
   item against the actual v0.3.0 tool surface;
2. **Fixes for the release-automation issues exposed while publishing the v0.3.0 tag**, plus
   automated Gitee releases.

## Skill docs rewrite (aligned with the v0.3.0 tool surface)

The `SKILL.md` / `usage-examples.md` loaded by host agents (e.g. Tianshu) still described codex as
a headless CLI. They are now rewritten against `src/mcp/tools.ts`, `src/config/schema.ts` and
`src/agents/builtin.ts`:

- Corrected `codex`: it is the ChatGPT desktop GUI adapter (MSIX + COM activation + CDP) with a
  **required `model`** (e.g. `GPT-5.6 Sol`), optional `reasoningLevel` / `planDoc` / `designSystem`,
  and no `mode` support; the quick-start example was fixed accordingly (the old one failed outright
  with "Codex must specify a model").
- Documented the `run_task` `context` parameter (appended as context/constraints to the initial
  instruction) and the send-time validation of path references inside task/context; corrected the
  `autoFixRounds` default precedence (call argument > codex 5 / zcode 2 > server default 0).
- Added usage for `list_tasks` (previously absent from the docs), `query_task(tailLines)`,
  `get_task_report(round)`, `verify_task` (`extraChecks` / `checksMode` / `baselineRef`) and the
  four-level acceptance command precedence.
- Documented the four `needs_user` kinds and meta fields such as `needsUserKind` /
  `pendingQuestion` / `errorType` / `reportRound` / `verificationSource`, so hosts can decide
  between "answer the question" and "confirm the user handled it".
- Added `continue_task` to the approval list (write tools require approval); emoji status markers
  in examples were replaced with plain text (PASS / warning).

## Release automation fixes

- **Bilingual release bodies**: the body is composed from `docs/release-v<version>.md` and `.en.md`,
  with in-document relative links rewritten to tag-absolute links; a missing doc fails the workflow
  loudly instead of producing a shell-only body.
- **Full Changelog fix**: the previous tag is resolved via `git describe` into a
  `compare/<prev>...<tag>` link.
- **CI link fix**: the body's `CI` link resolves the CI run for the same SHA instead of pointing at
  the Release run itself.
- **Automated Gitee releases**: the end of `release.yml` idempotently creates/updates the mirrored
  Gitee release via the Gitee OpenAPI (`scripts/gitee-release.mjs`, requires the `GITEE_TOKEN`
  secret; skipped loudly when unset).
- The bilingual `CHANGELOG` files gained the missing `[0.1.10]` / `[0.2.0]` / `[0.3.0]` / `[0.3.1]`
  compare links at the bottom.

## Upgrade notes

- After `npm install -g tianshu-mcp` or `npx tianshu-mcp`, the skill docs are re-installed at
  server startup into `~/.rivet/skills/tianshu-mcp/` (the old copy is backed up as `.bak-<timestamp>`);
  they take effect in **new sessions only** — sessions already open keep the previous text.
- No config migration and no API changes; upgrading from v0.3.0 costs nothing.

## Release gates

typecheck, lint, the full test suite, build, strict stdio, npm pack contents and a clean-consumer
install must all pass; the version stays consistent across `package.json`, the lockfile, generated
files, the tag and the release.
