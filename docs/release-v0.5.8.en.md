# tianshu-mcp v0.5.8 release notes

[简体中文](release-v0.5.8.md)

**Documentation release + packaging fix**: the four primary documents (bilingual README, HANDOFF, bilingual ARCHITECTURE) were rewritten item by item against the current code, and one **distribution gap** was closed (`scripts/probe-traework.mjs` was not shipped in the package even though the docs tell users to run it). **There is no runtime behaviour change**, so callers need no updates.

## Documentation rewritten (checked against the code)

The audit covered `src/mcp/`, `src/tasks/`, `src/loop/`, `src/agents/` (all five GUI adapters), `src/verify/`, `src/visual/`, `src/config/` and `src/util/`. These statements were **wrong** and are now corrected:

- **Acceptance stage order**: the built-in `git-diff-check` runs **before** the configured checks, and the visual stage runs **after** the command checks (pages usually need the build output first). The old text had the order reversed.
- **The real boundary of `visual.enabled=false`**: snapshot freezing and integrity checking run **unconditionally**, independent of `enabled`; `enabled` only decides whether screenshots/specs/content judgement actually run. So "visual disabled" does not mean "nothing visual happens" — that mechanism is exactly what detects someone editing the acceptance config or the baselines.
- **Tool result contract**: besides `get_task_report`, the success results of `prepare_visual_baseline` / `approve_visual_baseline` also carry **no meta block**, and neither does the **error** result of any tool. The old text claimed `get_task_report` was the only exception.
- **All five agent tables now include Qoder CN**: the README agent list, the driver list, the `endReason` table, the `needsUserKind` table, the cancellation-capability table, the registry's special discovery branches, the GUI instance lifecycle table and the unit/integration test descriptions were all corrected from "four drivers" to "five", and Qoder CN's execution order and completion criterion were added to the architecture document.
- **`endReason` / `needsUserKind` verified value by value**: Kimi Code's `system_permission` and `setup_recovery` were missing; **Qoder CN is the only adapter that can emit all six `needsUserKind` values**, and it **never emits `idle_timeout`** (a static screen without this-turn completion evidence becomes `needs_user(setup_recovery)`); Codex has **no** `close_existing_instance` path because its `ensureInstance` never returns `needsClose`; and ZCode and TraeWork **do not click any in-UI stop button and never report `guiStop`**.
- **Cancellation semantics** are now listed per adapter capability (Codex / Kimi Code / Qoder CN click stop and bounded-wait; ZCode / TraeWork only stop MCP-side observation).
- **Checkpoints and anti-resend**: `qoder-session.json` is the **only persisted checkpoint** (phases `sending` / `sent` / `completed` / `answer_sending`, with the write and read points documented); every other adapter keeps anti-resend state in memory only. The skill doc previously described checkpoints as a general mechanism.
- **Kimi Code tier domain**: the README's front-page example and milestone text were corrected from `Low`/`High`/`Max` to the values the code actually accepts — `低/low`, `高/high`, `max`, `on`, `off` (deliberately excluding `中`/`medium`).
- **Test baselines and file counts**: the README and HANDOFF figures "776 tests / 73 files" and "37 + 20 files" are corrected to **826 passed / 12 skipped (838 tests, 81 test files)**, broken down as unit 54 / integration 26 / protocol 1.
- **Runtime dependency licences**: the old text said "all runtime dependencies are MIT", but `puppeteer-core` and `@puppeteer/browsers` are Apache-2.0, `pixelmatch` is ISC and the optional `sharp` is Apache-2.0. The licence table now matches `package.json`.
- **Unused profile fields**: the architecture document gained a callout listing fields that are **declared but have no consumer today** (`gui.windowMode`, `gui.modelRequired`, and ZCode's `gui.stallTimeoutMs` / `gui.cancelWaitMs`), so a future maintainer does not assume a configured setting does something.
- **Known gaps updated**: the entry claiming the `tools.ts`/`handlers.ts`/`server.ts` comments still said "9 tools" is gone (fixed), replaced by two real debts (the execution-child spawn options are duplicated at four sites with no shared helper; the unused profile fields above).

## Packaging fix

- `scripts/probe-traework.mjs` was **not listed in `package.json`'s `files`**, while both the README and HANDOFF tell users to run the TraeWork probe — npm consumers could not get the script. It is now shipped.
- Added the `probe:traework` / `probe:zcode` / `probe:codex` npm scripts (previously only `probe:kimicode` / `probe:qoder` existed, although `scripts/probe-zcode.mjs` and `scripts/probe-codex.mjs` had long been shipped). All five probes can now be run as `npm run probe:<agent>`.

## Source comment fixes (no behaviour change)

- The "9 tools" header comments in `src/mcp/handlers.ts` and `src/server.ts` now say 11.
- The MCP server `instructions` string now mentions `kimicode` and `qoder` (it previously listed only codex/zcode/traework).
- `src/agents/gui-instance.ts` lists all five users in its header; `src/tasks/task.ts` fixes a **Kimi Code comment that was sitting on the Qoder fields** (and notes that `qoderTurnId` currently has no writer).

## Gates and evidence

- Full regression: **826 passed / 12 skipped** (Windows 10 x64, Node 24.18.0); typecheck and lint pass.
- `npm pack` (231 files) was verified to include all five probe scripts; a relative-link check covered the four primary documents plus the skill docs — **255 relative links, 0 broken**.
- This is a **PATCH** release: no runtime behaviour change, and existing caller signatures, report fields and error-code semantics stay **backward compatible**.

Related docs: [Project README](../README.en.md) | [CHANGELOG](../CHANGELOG.en.md) | [Architecture](../ARCHITECTURE.en.md) | [Handoff](../HANDOFF.md)
