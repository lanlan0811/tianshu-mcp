# Log Viewer 0.1.1-beta.4 — command-layer task_id escape hardening (issue #32)

> Full change log in [CHANGELOG](../CHANGELOG.en.md); feature docs in [docs/gui-log-viewer.en.md](gui-log-viewer.en.md).

This is the **security-hardening** release of the 0.1.1 line, delivering issue #32: the **task-id character
allowlist** moves from "frontend deep-link parsing only" down into the **Rust command and module layers**, closing
the path-joining in four commands. **No new features, no UI changes** — user-visible behaviour is identical to
`0.1.1-beta.3`.

---

## Fixed in this release

### Escape validation for `task_id` in four Log Viewer commands (issue #32)

**The problem**: `read_events` / `read_baseline` / `export_task_zip` joined task ids **directly** into
`tasks/<id>/…` without going through the module's own escape guard, `resolve_rel`. That **contradicted** the
`ARCHITECTURE.md` §16.10 statement ("ids go through the `[A-Za-z0-9_-]` allowlist") — the same defence line had
different conventions per command, so **integrity depended on each caller remembering**: a newly added command
would not inherit the protection.

**The fix** (one central choke point rather than patching each site):

- `data_home.rs` gains **`validate_task_id`** (the `[A-Za-z0-9_-]` allowlist, matching the frontend
  `TASK_ID_RE` in `core/deeplink.ts` and §16.10) and **`task_dir`** (validates, then joins `tasks/<id>`) as the
  **single entry point from a bare task id to a path**;
- the three modules switch to `task_dir` (**defence in depth**: the invariant still holds even if a future
  command forgets the command-layer check);
- all four commands gain a first-line check in the command layer (`lib.rs`) — besides the three named in the
  issue, **`read_report` is included too** (it used `resolve_rel` and did not escape, but likewise lacked the
  character allowlist, so it shared the same inconsistency);
- illegal ids now **fail loudly** at the command layer (diagnosable) and are reported **as missing** at the
  module layer, matching the existing tolerant convention (`present = false` for baselines, an empty window for
  events) — **nothing is invented**.

**An assumption disproved while verifying**: the existing `if !task_dir.is_dir()` check in `export_task_zip` was
treated as an effective guard — measurement showed that with `..` in the task id it **evaluates to true**, so the
gate was pierced. **A guard existing is not the same as a guard working**: the allowlist now rejects the input
**before any path is built**, with no reliance on whether a directory happens to exist.

### Attacked surface covered

| Category | Example | Before | After |
|---|---|---|---|
| Path traversal | `../../outside/evil`, `..`, `../..` | **escaped** (read/packed outside the data dir) | rejected |
| Backslash traversal (Windows) | `..\..\evil`, `..\../evil` | **escaped** (Windows only) | rejected |
| Absolute paths | `/etc/passwd`, `C:/Windows` | **escaped** | rejected |
| NTFS alternate data streams | `tsk_1:secret` | not blocked | rejected |
| Windows-illegal characters | `tsk*1`, `tsk?1`, `tsk|1` | not blocked | rejected |
| Whitespace / dots | `tsk 1`, `tsk.1`, `""` | not blocked | rejected |
| Unicode homoglyphs | fullwidth underscore `tsk＿1`, Cyrillic `tаsk_1` | not blocked | rejected |
| **Legitimate ids (counter-proof)** | `tsk_20260926135200_d4e5f6`, `vfy_2026-09-26_x1` | worked | **still work (zero false rejections)** |

The check is **byte-by-byte** rather than a regex: no new `regex` dependency, and ASCII-only **naturally excludes**
Unicode homoglyphs, Windows-illegal path characters and NTFS alternate data streams.

---

## Conventions

- **Defence depth only**: a normal UI path **cannot** supply an illegal id (`selectedTaskId` comes from real
  directory names returned by `list_tasks`; deep links have their own frontend allowlist), so this release's
  **user-visible behaviour is effectively unchanged**. The value is that the code now matches what
  `ARCHITECTURE.md` promises, and **future commands inherit the protection automatically**.
- **One behaviour change**: for an illegal id, `read_baseline` now returns an error instead of a default value.
  The command **already** used `Err` to report a missing task id; an illegal character is the same class of caller
  error, and silently degrading would hide bugs.
- **Read-only boundary unchanged**: all four commands still only read files / `stat`, and never write business data.

---

## Boundaries (what this release does not do)

- **No new features, no UI changes**: no new pages, sections or commands; zero new i18n keys; `src/api` method
  signatures unchanged.
- **No refactor of internally derived paths**: the `task_id` values in `scanner.rs` / `insights.rs` / `search.rs`
  come from `read_dir`'s `file_name()` (structurally free of separators, already filtered by the `tsk_` / `vfy_`
  prefixes) and are **not external input**, so they are deliberately left alone.
- **Not included**: cleanup / delete entries, task re-run or rework, notifications / tray badges, a local full-text
  index (all following existing decisions).

---

## Upgrading

- The update path is the same `latest.json` / `latest-gitee.json` shared by `0.1.0` / `0.1.1-beta.1` /
  `0.1.1-beta.2` / `0.1.1-beta.3`; semantic versioning compares `0.1.1-beta.4 > 0.1.1-beta.3`, so upgrading from
  any earlier release works directly;
- This release is **pure hardening**; every existing feature (task list / four log kinds / search & export /
  update check / four insight sections / command palette / deep links) **behaves as before**.
