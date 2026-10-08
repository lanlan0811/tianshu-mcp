# Log Viewer 0.1.1-beta.6 — tool surface synced to MCP 0.9.0 (13 → 8)

> Full change history in [CHANGELOG](../CHANGELOG.en.md); feature docs in [docs/gui-log-viewer.en.md](gui-log-viewer.en.md).

This is the **sync release** of the 0.1.1 line: it aligns the "MCP capabilities" view's tool list
with the MCP main package's **v0.9.0 tool-surface consolidation** (13 → 8). **No new features, no
UI structure changes** — but there is **one user-visible content change**: every tool name and
description in the capabilities view is new, and the 13 old names no longer exist in MCP 0.9.0.

---

## What changed

### Tool list 13 → 8 (aligned with tianshu-mcp v0.9.0)

**Background**: MCP main package v0.9.0 merged 13 tools into 8 by domain (three merges; the two
visual-baseline tools stayed separate). The log viewer's "MCP capabilities" view embeds a **mirror
list** (`mcp-gui/src/core/capabilities.ts`), which `scripts/check-schema-parity.mjs` compares
against the source of truth `TOOL_DEFS` in `src/mcp/tools.ts` by
`name + capability + requireApproval`, **order-sensitive**. Once the main package renamed tools,
the mirror had to follow — otherwise the GUI workflow in CI goes red immediately.

**Merge map** (old → new):

| Old tools | New tool |
|---|---|
| `cancel_task` + `continue_task` + `rework_task` | **`manage_task`** (`action`, one of three) |
| `list_tasks` + `get_task_report` + `get_profiles` | **`query_info`** (`type`, one of three) |
| `wait_any` | folded into **`wait_task`** (batch mode: pass `taskIds`) |
| `run_task` / `query_task` / `verify_task` | unchanged |
| `prepare_visual_baseline` / `approve_visual_baseline` | **unchanged** (deliberately kept as two tools) |

**Files touched** (4):

- `src/core/capabilities.ts` — `MCP_TOOLS` goes from 13 entries to 8, in the same order as the
  main package's `TOOL_DEFS`
- `src/i18n/zh-CN.ts` — Chinese descriptions rewritten (`manage_task` / `query_info` / `wait_task`
  now describe all of their branches)
- `src/i18n/en-US.ts` — English descriptions synced
- `test/capabilities.test.ts` — count assertion `13 → 8`, plus "new tools present" assertions

### Capability families updated accordingly

| Family | Tools |
|---|---|
| `read` (read/query, no side effects) | `query_task` / `query_info` / `wait_task` |
| `write` (side effects, approval required) | `run_task` / `manage_task` / `prepare_visual_baseline` / `approve_visual_baseline` |
| `execute` (runs project commands without changing source; approval-free) | `verify_task` |

### Approval semantics preserved

`manage_task` is `write` + approval (all three of `cancel_task` / `continue_task` / `rework_task`
were in that same class before); `query_info` is `read` + approval-free (likewise); `wait_task`
stays `read` + approval-free. **The approval semantics are equivalent — nothing loosened or
tightened.**

---

## User-visible behaviour change (the only one)

The capabilities view now lists 8 tools instead of 13, and **the old names no longer appear**.
If you look for a tool by its old name (`cancel_task` / `list_tasks`, …), you will not find it —
use the map above to find the new name.

**This is a display-layer sync only**: the log viewer is a **read-only** consumer and never calls
MCP tools, so nothing about log reading, task browsing or report viewing is affected.

---

## Tests & verification

```
vue-tsc --noEmit                     exit 0
vitest run                           173 passed (15 files)
node scripts/check-schema-parity.mjs everything consistent (incl. "MCP tool surface
                                     (frontend mirror) (8 items)" and "GUI version
                                     consistent (0.1.1-beta.6)")
```

The assertion chain in `capabilities.test.ts`:

- exactly 8 entries, unique names
- `wait_task` present as `read` + approval-free (it now carries the former `wait_any` semantics)
- `manage_task` (`write`) and `query_info` (`read`) present
- the three families cover every tool and every `capability` value is legal
- approval semantics match the capability families (all `write` require approval; all
  `read`/`execute` are approval-free)

---

## Notes on the version number

**Why `beta.6` and not `0.1.2`**: this is a **content sync** — no new features, no UI structure
change, no data-format change. Following the existing convention of the GUI version line (the beta
series carries iterative corrections), it ships as `0.1.1-beta.6`.

**Why this release is necessary**: the log viewer is released **independently** of the MCP main
package (`gui-v*` tags are separate from `v*`), so shipping main-package 0.9.0 does not carry the
GUI along. Without this release, users on the latest npm package running an older viewer would see
a set of tool names that no longer exists.

---

## Scope (what this release does not do)

- **No layout / interaction / visual changes** — only list data and description text
- **No changes to log reading, task browsing or report rendering** — nothing under `src/core/`
  is touched except the static list in `capabilities.ts`
- **No Rust-side changes** (`src-tauri/`) — the tool surface is a frontend-only mirror
- **No search-by-old-name alias** — deliberately keeping "reflect the source of truth only" as the
  single-fact principle

---

## Upgrade notes

**Install over the top; no migration steps.** The app's own preferences (data directory list, etc.)
are unaffected.

Version correspondence with the MCP main package:

| Log viewer | MCP tool surface |
|---|---|
| `0.1.1-beta.6` | tianshu-mcp **0.9.0** (8 tools) |
| `0.1.1-beta.5` and earlier | tianshu-mcp 0.8.x (13 tools) |
