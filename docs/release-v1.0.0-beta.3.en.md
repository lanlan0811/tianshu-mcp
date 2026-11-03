# v1.0.0-beta.3 — Full docs sweep + zero-residue gate

> **The closing release of this six-release plan**: a full docs sweep plus a **standing gate** that
> ensures the two removed agents (TraeWork / Qoder CN) can never creep back in.
>
> This is release 6 of the six-release plan "remove TraeWork and Qoder CN support".

**No behaviour change in this release.**

---

## Added: zero-residue gate

`scripts/check-removed-agents.mjs` (`npm run check:removed-agents`), wired into
`.github/workflows/ci.yml`'s `build-test` job:

| Area | Rule |
|---|---|
| `src/` / `scripts/` / `package.json` / `.github/workflows/` | **Zero tolerance**: any occurrence of `traework` or `qoder` (**comments included**) fails |
| Historical release notes / CHANGELOG / HANDOFF / migration notes / the 0.9.10 explicit acceptance test / `mcp-gui/` | **Whitelist** (named one by one, no broad prefixes) |
| Any other hit | **Fails** (must be explicitly accounted for or reworded neutrally) |

Design note: the whitelist names files **one by one** rather than using broad prefixes, and "neither
zero-tolerance nor whitelisted" fails outright — otherwise, if someone added these agents back into
an uncovered file, the gate would silently let it through. `tianshu-mcp-web/` (the website directory,
which AGENTS.md forbids modifying) and local tool directories (`.claude/` / `.rivet/`, etc.) are
explicitly skipped.

**Negative self-test**: appending a comment containing `traework` to `src/agents/cli.ts` makes the
gate exit non-zero and name that file; removing it restores a pass.

## Full docs sweep

- README (both) / ARCHITECTURE (both) / HANDOFF / CHANGELOG (both) / SKILL + usage-examples /
  `docs/adapter-matrix` (both) / `docs/agent-profiles` (both) / CONTRIBUTING / SECURITY: no
  "**current state**" text lists the two removed agents as available any more.
- **Historical sections are preserved as-is**: `docs/release-v*.md`, the per-version CHANGELOG
  entries, and HANDOFF's historical handoff snapshots — they are facts of their time, and rewriting
  them would be falsifying the record.

---

## End-to-end machine verification

| # | Scenario | Expected | Result |
|---|---|---|---|
| 1 | `query_info(type="profiles")` | lists codex / zcode / kimicode / opendesign / minimax / stub, **no** traework / qoder | ✅ |
| 2 | `run_task(agentId="traework", …)` | `agent_unresolved` hard failure, burns no acceptance rounds | ✅ |
| 3 | `run_task(agentId="qoder", …)` | same | ✅ |
| 4 | One real codex dispatch + auto-acceptance | passes (**core regression**: the shared CDP transport still works after the move) | needs real quota, see below |
| 5 | One real zcode dispatch | passes | needs real quota, see below |
| 6 | One each of kimicode / opendesign / minimax | passes | needs real quota, see below |
| 7 | Put a legacy `agentId:"qoder"` `task.json` in the data dir and `manage_task(action="rework")` it | `failed(agent_unresolved)`, not re-run | ✅ |
| 8 | Host passes `mode` / `modelSource` | the unified "deprecated" message (**not** a zod error) | ✅ |

**On 4–6**: a real dispatch requires driving the machine's desktop apps (Codex / ZCode / Kimi Code /
Open Design / MiniMax Code) and spending their quota, which the plan marks as an optional "where the
environment allows" step. What this release verified: `query_info(type="profiles")` on this machine
reports all five agents `[PASS] available` (real installs detected), and the shared CDP transport and
each agent's behaviour are covered by the full test suite.

---

## Verification

| Gate | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run lint` (`--max-warnings 0`) | 0 warnings |
| `npx vitest run test/unit test/integration test/protocol` | all green |
| `npm run build && npm run check:stdio` | stdout clean |
| `npm run check:removed-agents` | passes (0 hits in zero-tolerance zones) |
| `npm run pack:check` | manifest as expected |
