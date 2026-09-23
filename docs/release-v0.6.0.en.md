# tianshu-mcp v0.6.0 release notes

[中文](release-v0.6.0.md)

**Hardening: source location, overwrite semantics, and tri-state governance for skill self-install — skill content comes from the package only, and your local edits are never silently replaced** ([issue #16](https://github.com/lanlan0811/tianshu-mcp/issues/16)).

## The problem

On startup, `src/util/skill-install.ts` syncs the in-package skill to `~/.rivet/skills/tianshu-mcp/`. It had two issues (the repro steps in the issue can be verified line by line in the source):

1. **cwd fallback source**: `resolveSkillSourceDir()`'s candidate chain contained `process.cwd()/skills/tianshu-mcp` (candidate 3 and the fallback — two places). Under a normal install a higher-priority candidate matches first, but once triggered under a non-standard layout (an incomplete dist, or running the source directly with `tsx` while cwd is outside the repo root), any `skills/tianshu-mcp/` under the current working directory gets installed into `~/.rivet/skills/` and takes effect in the next session. The classic scenario: you debug the server inside a cloned third-party repository that happens to carry that path layout (by accident or by design) — the skill content then comes from the repository author, not this package. This is a textbook supply-chain anti-pattern.
2. **Silent overwrite**: when the target exists but its directory hash differs, the old directory is `rename`d to `.bak-<timestamp>` and the target is overwritten wholesale. A user's local tuning of `~/.rivet/skills/tianshu-mcp/SKILL.md` (skills are markdown meant to be read and written by the host/user) gets silently reverted to the in-package version on the next server startup — there is a backup and a switch, but the overwrite itself gives zero notice and zero authorization.

The root cause: the target directory keeps **no record of what this package installed**, so in principle the current implementation cannot tell "this content is an old version this package installed" apart from "this content was edited by the user".

## What this release does

### 1. Source location tightened: content comes from the package only (issue problem 1)

`resolveSkillSourceDir()` now locates the source **only** relative to the package via `import.meta.url` (`<module>/../../skills/tianshu-mcp`) — a source run and a dist run have the same relative depth, so one candidate suffices. **Both `process.cwd()` references were removed** along with a loose candidate that could never match in any layout. When no source is found, the existing "skip with a warning" path is kept (the issue confirms that path behaves correctly).

`fileURLToPath` is retained (it must not be reverted to `new URL().pathname` — historically that escaped Windows Chinese/drive-letter paths and broke the check; see `docs/host-integration-record.md`).

### 2. Install manifest and three verdict classes (issue problem 2)

The target keeps a manifest at `<dest>/.tianshu-mcp-install.json`:

```jsonc
{
  "schema": 1,
  "name": "tianshu-mcp",
  "packageVersion": "0.6.0",
  "contentHash": "<sha256 hex>",   // manifest itself and platform noise excluded
  "installedAt": "2026-09-23T…Z",
  "sourceDir": "…\\node_modules\\tianshu-mcp\\skills\\tianshu-mcp"
}
```

`contentHash` is computed from content plus relative file names, **excluding the manifest itself** (otherwise writing it would prove the target changed) and platform noise (`.DS_Store`, `Thumbs.db`, `desktop.ini`, `._*`, `.git*`) — so a `.DS_Store` written by a macOS host is not misread as a local edit. Copying uses the same exclusion predicate, so "hash right after install == source hash" holds (the root of idempotency).

This yields six states:

| Target state | Verdict | Default (`auto`) behaviour |
|---|---|---|
| Absent | first install | install + write manifest |
| Content == package | in sync | skip (repair/calibrate the manifest if missing or stale; skill files untouched) |
| Manifest record == target content ≠ package | **untouched stale package copy (trusted)** | backup + overwrite (`WARN`) |
| Manifest record ≠ target content | **local edits (confirmed)** | **keep + loud warning**, with two remediation paths |
| No valid manifest and content ≠ package | **unknown source** | **keep + warn**, pointing at the approval flag |
| Target is a file / unreadable | same as "unknown source" | same as above |

Only a "trusted stale copy" is auto-overwritten under the default config; once an edit by you is detected, it is **never** silently replaced.

### 3. Tri-state switch and an approval entry point

- `skills.autoInstall`: `true` (default) | `"prompt"` | `false` (existing booleans stay valid — no migration). `"prompt"` = install as usual on first run, **but do not auto-overwrite when a change is needed** — warn and record `pendingUpdate` in the manifest. A stdio server has no synchronous interaction channel, so "prompt" effectively means "do not act automatically, leave it for confirmation".
- `--approve-skill-update` (or `TIANSHU_MCP_APPROVE_SKILL_UPDATE=1`): for this run, permit a "needs change" skill directory to be overwritten with the in-package version (after backup). **It has no effect on directories confirmed to carry local edits** — those require renaming/deleting the directory and restarting, or merging your edits manually.
- Precedence: `--no-skill-install` / `autoInstall:false` **outrank** the approval flag.
- `skills.backupKeep` (default 3, `0` = never prune): after a successful overwrite, keep the newest N `.bak-<timestamp>` directories by timestamp.

### 4. Atomic install

Now "copy into `<dest>.incoming-<ts>-<hex>` (manifest included) → back the old directory up as `<dest>.bak-<ts>` → swap in", cleaning the tmp tree and rolling the backup back on failure. Stale `.incoming-*` directories older than one hour are cleaned on startup. The old "rename the old directory away, then copy straight into the target" had a crash window that could leave a half-copied directory, which the new semantics would misread as a local edit and block upgrades on permanently — so it had to be closed too.

### 5. Log levels

Skip / manifest repair = `INFO`; stale-copy upgrade / local edits kept / unknown source / install failure = `WARN`. Stable, searchable markers: `含本地修改`, `来源不明`, `未自动覆盖`. Hashes are printed as the first 8 characters only.

## Upgrade impact (please read)

This release **does not change the skill content** (`skills/tianshu-mcp/` is untouched), so:

- **Users who never edited the skill files**: after upgrading, startup takes the "content identical → skip" path — no perceptible change beyond a manifest being written once.
- **Users who edited the skill files**: after upgrading, startup logs a `WARN` (`检出技能目录含本地修改…已保留你的版本、未做覆盖`) with two remediation paths — ① prefer the in-package version → rename or delete the directory and restart; ② keep your edits → merge them into the in-package copy and restart. **Your edits are not overwritten.**
- Upgrading from v0.5.10 or earlier with no manifest lands in "unknown source": kept with a warning by default; use `--approve-skill-update` when you are sure an overwrite is fine.

> Backup backlog pruning: `.bak-*` directories accumulated on a machine are pruned to the newest 3 by `backupKeep` on the **first overwrite** after v0.6.0. If you do not want historical backups deleted, set `skills.backupKeep` to `0` before upgrading, or archive them first.

## Gates and evidence

- 30 new unit cases (`test/unit/skill-install.test.ts`): source location (including a "decoy with the same name under cwd" regression and a source-text assertion), hash exclusions, manifest parsing, the six-state decision matrix across modes and approval, real-filesystem end-to-end (first install / idempotency / manifest self-heal / trusted overwrite / local edits kept / `prompt` hold and `pendingUpdate` / approved overwrite / failure rollback / backup pruning / non-matching entries untouched / stale tmp cleanup / log levels / missing source), and a smoke test over the real skill directory.
- `config-hotreload` gains default/override/invalid-value cases for `skills.autoInstall` (tri-state) and `skills.backupKeep`.
- The strict stdio gate gains `skill-locally-modified` / `skill-approve-update` scenarios (6→8); both the dist and src entries pass 8/8.
- **Windows 10 real-machine verification** R1–R7 all green; raw output in the [issue #16 hardening record](issue-16-skill-install-hardening-record.md).
- Full run **898 passed / 12 skipped**; typecheck, lint (`--max-warnings 0`), build, and `pack:check` all pass.

## Compatibility

- **Config**: `skills.autoInstall`'s `true`/`false` semantics are unchanged (default still `true`); the `"prompt"` value and `skills.backupKeep` are new. Existing `config.json` needs no change.
- **CLI**: only `--approve-skill-update` is added; `--no-skill-install` is unchanged.
- **Tool surface**: the 11 MCP tools and all return contracts are **unchanged**.
- **Runtime**: skill content is unchanged; the install target remains `~/.rivet/skills/tianshu-mcp` (no multi-host directories added).

Related docs: [README](../README.en.md) | [CHANGELOG](../CHANGELOG.en.md) | [ARCHITECTURE](../ARCHITECTURE.en.md) | [SECURITY](../SECURITY.en.md) | [HANDOFF](../HANDOFF.md)
