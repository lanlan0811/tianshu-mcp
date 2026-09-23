# tianshu-mcp v0.6.1 release notes

[中文](release-v0.6.1.md)

**A five-item small-fixes sweep: comment & count alignment, `capability` collapsed to three families, project registration failures no longer silent, system directories denied by subtree, and the `cmd` string form documented** ([issue #17](https://github.com/lanlan0811/tianshu-mcp/issues/17)).

No new tools, no new adapters, no data-model changes; all five items are directly provable from source and shipped as one sweep.

## ⚠ Host note (the only externally visible metadata change)

The capability of `verify_task` moves from `read` to **`execute`** (it always ran the project's configured commands and could produce build artifacts), so its MCP `readOnlyHint` changes from `true` to **`false`**:

```jsonc
// values emitted for verify_task in tools/list (v0.6.1)
{ "_meta": { "capability": "execute", "requireApproval": false },
  "annotations": { "readOnlyHint": false, "destructiveHint": false,
                   "openWorldHint": false, "idempotentHint": true } }
```

**It still needs no approval** — `requireApproval` stays `false` (R11's "verification does not modify sources" conclusion is unchanged). **If your policy layer hard-codes `readOnlyHint`** (for example treating `readOnlyHint === false` as "needs user authorisation"), switch it to key off `_meta.requireApproval`, or you will mistake the approval-free verification for an operation that needs authorisation. The policy example in `docs/tianshu-integration.md` / `.en.md` is updated ( `verify_task` is now `{ "capability": "execute" }`, no longer needing a host-side raise).

## What this release does

### 1. System directories now denied as subtrees (issue item 4)

`DANGEROUS_ROOTS` previously matched **exactly**: `c:/windows` was blocked while `c:/windows/system32` was not; `/etc` was blocked while `/etc/anything` was not. Since the worker can write the whole subtree, a root-only rule left a system-level write surface.

This release upgrades the following to **boundary-aware subtree denial** (the prefix must be followed by `/` or end-of-string):

- POSIX: `/etc`, `/usr`, `/bin`, `/sbin`, plus the macOS realpath shape `/private/etc` (on macOS `/etc` is a symlink);
- Windows: `c:/windows`, `c:/program files`, `c:/program files (x86)`.

**Deliberately kept exact-match**: `/var`, `/tmp`, `/opt`, `/library`, `/system`, `/root`, `c:/users` and the home directory — legitimate workspaces live underneath them. **The key constraint**: on macOS `os.tmpdir()` *is* `/var/folders/...`, which is where every test project and many temporary workspaces are created, so denying `/var` as a subtree would sever the test base itself.

Boundary-awareness avoids false positives: `c:/windows.old`, `/etcetera` and `/usrlocal` are **not** matched. The decision is now a platform-injectable pure function `isDangerousProjectDir(norm, platform)`, so all three platform shapes (including macOS `/private/...`) are verifiable on any OS.

### 2. `capability` collapsed to three families (issue item 2)

`ToolDef.capability` declared four values, of which `"execute"` and `"network"` were **used by no tool at all** — the dead-classification problem the issue called out.

- **`"network"` removed**: nothing is reserved before its semantics are defined (adding it back when a real network tool appears is backwards compatible).
- **`verify_task` moves from `read` to `execute`**: it runs the project's configured commands and may produce build artifacts; it never was read-only.
- The three-family semantics are documented on the type and in the `tools.ts` header: `read` (queries, `readOnlyHint: true`), `write` (side effects, all approval-gated), `execute` (runs project commands without modifying sources, still approval-free per R11).

A new **truth-table test** asserts all 11 tools × `capability` × `requireApproval` × the four MCP annotations cell by cell, and asserts the table's tool set matches the real tool surface exactly.

### 3. Project registration failures are no longer silent (issue item 3)

`run_task` discarded the `registerProject` return value (`void registered;`) and then **re-read** the same record via `projectByPath` to get `defaultAgentId`:

```ts
// old
const registered = await dataHome.registerProject(norm, agentId);
void registered;
const record = (await dataHome.projectByPath(norm)).record;
```

This release consumes the return value directly and drops the redundant re-read; a registration failure logs `WARN` and returns a **structured `isError`** without dispatching — eliminating the "task created but project unregistered" half-state (which would falsify every project-scoped query). The message carries a "registration failed, not dispatched" prefix so callers can tell it apart.

### 4. The `cmd` string-form pitfalls documented (issue item 5)

A verification `cmd` accepts both an array and a string, but the string form goes through a minimal tokenizer: it **supports no escaping**, an unclosed quote **does not error**, and a mistake **silently splits into multiple argv**. The docs only said "a plain string is also accepted and safely tokenized", without those caveats.

This release adds a measured table of four typical behaviours to `docs/acceptance-config.md` / `.en.md`, and "always prefer the array form" notes to the `schema.ts` / `store.ts` comments, `SKILL.md` and `usage-examples.md`. **The implementation is unchanged**, and five boundary cases now pin the existing tokenizer semantics so a future tokenizer edit cannot drift silently.

### 5. Counts aligned with reality (issue item 1 wrap-up)

- The "9 tools" header comments in `src/mcp/tools.ts` / `server.ts` / `handlers.ts` were already corrected to 11 in v0.5.8; this release fixes the last leftover (`test/protocol/protocol.test.ts:3`) and adds a `TOOL_DEFS` count assertion — comparing name arrays alone would not catch a registry entry with no registered tool.
- A related pathology is swept up too: `scripts/check-stdio.mjs` has had 8 scenarios since issue #16, but the `ci.yml` comment, `HANDOFF` (two places) and `CONTRIBUTING` (both languages) still said "6 scenarios"; this release syncs them to 8 (the M10 README entry and historical release notes are statements of fact at the time and are left as-is).

## Tests

- Full suite **940 passed / 12 skipped** (Windows 10 x64, Node 24.18.0; 83 files passing + 3 real-browser files skipped by design), a net **+42** over v0.6.0's 898:
  - `test/unit/project-dir-guard.test.ts` 16 → 49: new `isDangerousProjectDir` table-driven cases for all three platform shapes (including the three key counter-examples `c:/windows.old`, `/etcetera`, `/private/var/folders/...`) and a real-directory win32 subtree case;
  - `test/protocol/protocol.test.ts` 10 → 11: new capability truth table; the `verify_task` `readOnlyHint` assertion and the capability domain updated; new count assertion;
  - `test/unit/zcode-handler.test.ts` 16 → 18: registration failure does not dispatch / the return value is genuinely consumed (the latter asserts a `projectByPath` call count of 0, falsifying any remaining re-read);
  - `test/unit/core.test.ts` 5 → 7: `splitCmd` boundary semantics and array-form passthrough.
- The strict stdio gate passes **8/8** on both the dist and src entry points; `pack:check` passes (232 files).

## Docs

- Bilingual: README (`verify_task` capability row + M31 milestone), ARCHITECTURE (three-family tool table + `readOnlyHint` derivation rule + two new §15 gaps), SECURITY (§3 dangerous-directory matching semantics + §5 wording corrected), `docs/tianshu-integration` (policy example + host note), `docs/acceptance-config` (`cmd` form caveat table);
- Single-language: `SKILL.md` and `usage-examples.md` capability rows and `cmd` notes, HANDOFF (0.6.1 handover + snapshot + M31 + scenario count);
- New `docs/issue-17-small-fixes-record.md` (Windows 10 measured evidence: raw truth-table output, the three-platform subtree table, tokenizer boundary behaviour).

## Not covered

- The **UNC-shaped gap** for dangerous directories was reported through the security channel and is out of scope for this public fix;
- The **subdirectories** of `/var`, `/tmp`, `/opt`, `/library`, `/system`, `/root` and `c:/users` remain unblocked (a deliberate trade-off, see ARCHITECTURE §15);
- **Removing** the `cmd` string form needs a major/minor bump; this release only documents it and pins the semantics;
- This machine is Windows, so the macOS / Linux subtree shapes are covered by injecting `platform` into the pure function; the real-machine full regression is backed by the CI three-platform matrix.
