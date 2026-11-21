# v1.0.0 — First stable release

> The first stable release after parameter-surface consolidation, dependency layering, and
> observability were completed. It consolidates the four betas since `0.9.10`:
> `beta.1` parameter-surface consolidation → `beta.2` scripts and CI cleanup →
> `beta.3` docs sweep and zero-residue gate → `beta.4` startup breakdown timing.

**The only code change relative to `1.0.0-beta.4`**: automated assertions for the startup breakdown
markers (see below). Everything else is promoting the version, aligning docs, and correcting test counts.

---

## Up front: the 60-second cold-start timeout has not disappeared

This is the one claim `1.0.0` must state honestly.

On a first `npx -y tianshu-mcp` launch, npm has to download and install the whole dependency tree on
the spot. Measured (isolated cache, no global install, non-repo cwd):

| Experiment | Result |
|---|---|
| `npx -y tianshu-mcp` (cold) | **101798 ms** (server self-reported `0.9.10`, proving a registry fetch) |
| The host handshake window in the same scenario | 60000 ms ⇒ **a timeout is guaranteed** |
| The server's own startup (independent of installation) | **34 ms** |

**The slow part is installation, not server startup.** Install cost depends on the network and the
registry, which this repository does not control.

So this release **does not claim to fix the timeout**. What it delivers:

1. **Attributability** — after a timeout the log itself says which stage was slow;
2. **Measured evidence** — the inference is now a reproducible number;
3. **A user-side troubleshooting path** — three steps.

**Recommended usage**: install globally once so `npx` resolves to the installed binary and never cold-fetches.

```bash
npm install -g tianshu-mcp
```

---

## Change relative to beta.4: assertions for the breakdown markers

The startup breakdown timing added in `1.0.0-beta.4` had one gap: its only consumer was a human
(an operator reading `logs/server.log`), with **no automated assertion protecting it**. Deleting the two
markers in `src/index.ts` would leave the full test suite and `check:stdio` green.

This release adds two assertions to the strict stdio check in `scripts/check-stdio.mjs`:

- stderr must contain `启动分段：进程就绪` (the first marker, written once the logger exists);
- stderr must match the full four-stage format
  `启动分段：logger Nms（create Nms）/ buildServer Nms / connect Nms / 总计 Nms`.

**RED → GREEN was verified end to end** (this is the only code change in the release, so the full
procedure is recorded):

| Step | Action | Result |
|---|---|---|
| RED | Temporarily replace both markers with placeholders → `npm run build` → `npm run check:stdio` | **8/8 scenarios FAIL**, exit=1, reporting "stderr 缺少「启动分段：进程就绪」" |
| GREEN | Restore the markers → rebuild → `npm run check:stdio` | **8/8 scenarios PASS**, exit=0 |

That assertion can now block a silent regression of the markers.

---

## Cumulative changes (0.9.10 → 1.0.0)

### Breaking changes (introduced in beta.1 / beta.2)

- **TraeWork and Qoder CN agent support removed** (0.9.9 / 0.9.10 onward): directories, tests,
  registry wiring, fix-loop branches, and docs fully cleaned. The historical fallback where
  `driver="gui"` silently resolved to a removed adapter is gone — it now **fails closed** with a
  migration path.
- **`mode` deprecated**: passing the TraeWork-specific `mode` yields a unified migration message
  (pointing at `designDirection`) instead of being silently stripped.
- **`modelSource` deprecated**: unified rejection message.

### Added

- **Startup breakdown timing** (beta.4): there used to be no log output at all before `connect()`;
  now one line is written when the logger exists and one summary after connect completes, plus a
  `[WARN]` with attribution when the total exceeds 10s.
- **Zero-residue gate** (beta.3): `scripts/check-removed-agents.mjs`, wired into CI. `src/` / `scripts/` /
  `package.json` / CI config are **zero-tolerance** for removed agent names (comments included);
  everything else is whitelisted line by line.
- **Assertions for the breakdown markers** (this release): see above.

### Improved

- Missing visual dependencies now produce actionable errors: codes unchanged, messages carry
  copy-and-run `npm install -g tianshu-mcp [--include=optional]` and `tianshu-mcp visual browser install`.
- **The layering between visual deps and the handshake is now documented**: the handshake needs only
  `@modelcontextprotocol/sdk` + `zod` + `cross-spawn`; `puppeteer-core` / `@puppeteer/browsers` /
  `pixelmatch` / `sharp` are all dynamic imports on the visual path and never enter the handshake
  module graph.

### Rejected approach (falsified by measurement)

The original plan was to move the three visual packages from `dependencies` to `optionalDependencies`
to cut first-install cost. Measurement falsified it:

1. `npm install --omit=dev` does **not** omit optional dependencies — that group still installed
   `puppeteer-core`, `pixelmatch`, and `sharp`;
2. Only an additional `--omit=optional` brought it down to 165 packages / 77 MB, and
   **`npx` cannot inject that flag**;
3. `sharp` was **already** in `optionalDependencies`, yet its install script was still observed running.

Moving the declaration saves no seconds, so it was dropped rather than shipped as a no-op.

---

## Verification

| Gate | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| `npm run lint` (`--max-warnings 0`) | exit 0 |
| `npx vitest run` (full) | **1538 passed / 12 skipped** (1550 total, 119 files passed / 3 skipped, 122 total) |
| `npm run check:stdio` (source `dist/index.js`) | **8/8 scenarios PASS**, no non-protocol stdout |
| `npm run check:stdio` RED control | **8/8 FAIL** with the markers removed (proving the assertion actually guards) |
| `npm run check:stdio` (clean consumer dir with the tarball) | 8/8 scenarios PASS, `serverInfo.version = 1.0.0` |
| `npm run check:removed-agents` | exit 0 |
| GitHub Actions (release commit) | 22/22 jobs success |

---

## Upgrade notes

- **`latest` points at this release.** Upgrading from `0.9.10` or any beta is a semver increase, so
  automatic updates will move straight over.
- **No data-format changes**: `config.json` / `agent-profiles.json` / `projects.json` / task snapshots
  under `~/.tianshu-mcp` remain backward compatible; no migration needed.
- **Historical tasks of removed agents**: calling `manage_task(action="rework")` on a task with
  `agentId: "traework"` / `"qoder"` fails hard with `agent_unresolved` (expected fail-closed
  behaviour; it will not be silently picked up by the CLI adapter). Re-dispatch with a current agent.

---

## Known remaining issues

- **A first `npx` cold start may still exceed 60s** (depends on the network and the registry).
  A global install avoids it entirely.
- **Whether the client's 60000 ms handshake ceiling is configurable remains unverified** (the error
  string lives in the client's native binary).
- **The `package-lock.json` version lag is fixed in this release** (it had been stuck at `0.9.8`).
