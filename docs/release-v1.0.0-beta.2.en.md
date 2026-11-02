# v1.0.0-beta.2 — Test and script surface cleanup

> **Deletes the two removed agents' probe/smoke scripts and CDP docs, and syncs the packaging and
> CI required lists.**
>
> This is release 5 of the six-release plan "remove TraeWork and Qoder CN support".

**No behaviour change in this release.**

---

## Removed

```text
scripts/probe-traework.mjs   scripts/smoke-traework.mjs
scripts/probe-qoder.mjs      scripts/smoke-qoder.mjs
docs/traework-cdp.md         docs/traework-cdp.en.md
docs/qoder-cdp.md            docs/qoder-cdp.en.md
docs/qoder-evidence/         (directory)
```

All four scripts import deleted `dist/agents/{traework,qoder}/…` paths — long since dead code.

## Changed

| File | Change |
|---|---|
| `package.json` `files` | Dropped the 4 scripts and 4 docs above plus `docs/qoder-evidence` |
| `package.json` `scripts` | Dropped `smoke:traework` / `probe:traework` / `probe:qoder` |
| `package.json` `keywords` | Dropped `traework` |
| `.github/workflows/ci.yml` (pack-check) | Dropped the qoder entries from the required-file list — **otherwise CI goes red** |
| `.github/workflows/release.yml` (REQUIRED) | Same |
| `.github/ISSUE_TEMPLATE/*.md` | Dropped the removed agents from the target-agent options and scope |
| `mcp-gui/src-tauri/src/scanner.rs` | Swapped the test fixture's `agentId` to an agent that still exists (no functional impact) |

> **Why part of this landed early**: this cleanup belonged in this release. After 0.9.10 was pushed,
> CI's pack-check went red (the required-file list still demanded qoder artifacts that were removed
> with the agent), so the bulk (scripts / docs / lists) was pulled forward into the 0.9.10 cleanup
> commit. This release finishes the remainder (scanner fixture, etc.).

---

## Verification

| Gate | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run lint` (`--max-warnings 0`) | 0 warnings |
| `npx vitest run test/unit test/integration test/protocol` | all green |
| `npm run build && npm run check:stdio` | stdout clean |
| `npm run pack:check` | manifest as expected; zero `qoder` / `traework` residue in the tarball |
| Local CI dry-run | every entry in the `ci.yml` / `release.yml` lists passes `grep -qF` |
