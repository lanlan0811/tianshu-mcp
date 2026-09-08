# v0.1.8 Release Notes

- Release date: 2026-09-08
- Version: `tianshu-mcp@0.1.8`
- License: Apache-2.0
- Chinese version: [release-v0.1.8.md](release-v0.1.8.md)

---

## Fix: atomic-write concurrency defect (the real cause of intermittent CI failures)

After v0.1.7 was pushed, CI failed on **windows / Node 20** (the other 6 matrix jobs passed). The failing
assertions were:

```
AssertionError: expected undefined to be 'queued'
  ❯ test/integration/rework-feedback-race.test.ts:58
  ❯ test/integration/task-flow.test.ts:137
```

i.e. `rework_task` intermittently returned an `undefined` meta. Since that commit only touched docs, this was a
**real defect being masked**.

### Root cause (reproduced locally)

The temp filename in `writeJsonAtomic` / `writeTextAtomic` was `<target>.<pid>.tmp`:

- **Concurrent writes to the same target in one process share one temp file** — the first to finish renames it
  away and the next throws `ENOENT` (measured: 1 failure in 5 concurrent writes);
- **On Windows, concurrent renames onto the same target can throw `EPERM`** (the target is locked by another
  rename; measured: 2 failures in 8 concurrent writes).

`rework_task` happens to write snapshots twice in a row (`rework` plus post-processing), so hitting this race
leaves the caller without a meta.

### Fix

1. **Random temp suffix**: `<target>.<pid>.<12 hex chars>.tmp`, unique per call.
2. **Backoff-retry on transient rename errors**: treat `EPERM`/`EBUSY`/`EACCES` as transient and retry up to 10
   times with 10/20/... ms backoff.

Verification: 8 concurrent writes to one target → **0 failures** (2/8 before the fix); the new regression test
passes three runs in a row.

## Change list

| Type | Content |
|---|---|
| Fixed | `src/util/fs.ts`: unique temp filenames + backoff-retry on transient rename errors |
| Added | `test/unit/atomic-write.test.ts` (3 cases: concurrent JSON/text writes succeed, no leftover temp files) |
| Tests | 178 → **181**, all green |

## Note

The v0.1.7 project-folder binding root-cause fix (`toNativeWindowsPath`) shipped in that release; this version
contains only the atomic-write fix.

## Upgrade

```bash
npm install -g tianshu-mcp@0.1.8
```
