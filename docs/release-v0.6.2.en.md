# v0.6.2 — GUI agent selector drift fixes (codex / qoder / traework)

> Tracking issue: [#23](https://github.com/lanlan0811/tianshu-mcp/issues/23). See the [issue #23 verification record](issue-23-selector-drift-record.md).

## Fixed

- **Codex: project-picker trigger copy drift (26.917)**. The trigger `aria-label` is "选择项目：<name>" ("Select project") on some versions, while on others (26.915, verified locally) it is still "切换项目：<name>" ("Switch project"). The primary selector, fallbacks and aria patterns now cover both copies (plus the English `Select/Switch project`), and `boundProjectName` reads both back. **A full 20-key real-machine audit** (`probe-codex.mjs audit`) was also run: on local 26.915 there is no drift other than this trigger, and 9 verified keys were bumped to `verifiedVersion: 26.915.x`.

- **Qoder: layered selectors + real-machine workspace-binding fix (0.3.4)**. `src/agents/qoder/selectors.ts` was upgraded from flat strings to a layered spec matching Codex (`primary/fallbacks/texts/ariaLabels/ariaPatterns/verifiedVersion`, 27 keys) with a new `qoderCandidates()`. `QoderCdpClient` keeps the string `selector()` semantics and adds `candidates()/existsKey()/clickKey()` (probe candidates in order, then click — no wasted timeout budget on multiple candidates).
  **A fresh real-machine probe corrected the issue's conclusion**: on 0.3.4 the workspace menu **does render** — the real cause is that the page has **two** `[data-workspace-picker-trigger]` elements, and the old `click()` (which requires a single match) failed as ambiguous. The workspace trigger's primary selector is now the unique `button[aria-label^="切换或清空当前工作区"]`, with `[data-workspace-picker-trigger]` demoted to a fallback; the "menu is open" check is relaxed to "search box **or** overlay (`[role=menu][data-state=open]`)". **The production `bindWorkspace` now passes end-to-end on real Qoder 0.3.4** (workspace-menu → workspace-search → workspace-selected → path read-back matches).

- **TraeWork: new `discovery.ts` + install-dir fix + port diagnostics**. Added `src/agents/traework/discovery.ts` (reusing the zcode/qoder fixed-drive enumeration, registry `InstallLocation`, and relative-path logic) with a dedicated `traework-gui` branch in `registry.ts`. Fixed the built-in profile: removed the wrong `{APPDATA}/TRAE SOLO CN` (verified to be the **user-data dir**, holding Cache/Crashpad/nested tool exes — not the install location) in favor of `{LOCALAPPDATA}/Programs/TRAE SOLO CN` etc.; added `preferredDrives: ["D:"]` and `relativePaths: ["TRAE Work CN/TRAE SOLO CN.exe"]`. **On Windows the executable name is narrowed to `TRAE SOLO CN.exe`** — the old list contained `Trae CN`, which would mismatch the unrelated TraeCode CN product. `waitReady` timeouts now emit on-site diagnostics (child exit code, port-listener enumeration, detection of existing instances without the debug port) — **diagnosis only: no launch-strategy change, no termination of existing instances**.

## Added

- **Unified selector diagnostics across the three GUI agents** (`src/agents/gui-diagnostics.ts`): on selector-resolution failure, the nearest visible page candidates (aria-labels / short texts) are appended to the error and log, so users can locate drift in one step without opening CDP by hand. Wired into codex / qoder / traework.
- **Codex full-key audit mode**: `scripts/probe-codex.mjs --launch audit` prints the primary hit count and matched labels for all 20 selector keys, serving as a "script + evidence table" gate.
- **TraeWork selector version field unified**: `verified: boolean` → `verifiedVersion: string` (matching codex/kimicode), so drift reports share one vocabulary across all four GUI agents.

## Tests

- 25 new unit cases: `gui-diagnostics` (8), `qoder-selectors` (6), `traework-discovery` (7), `traework-launcher` diagnostics (4), plus `codex-core` dual-copy trigger/read-back (1 new, 1 rewritten).
- Full `npm test`: **966 passed / 12 skipped** (940 in v0.6.1, net +26).
- Real-machine evidence in the [issue #23 verification record](issue-23-selector-drift-record.md).

## Compatibility

- No tool contract, data-model or MCP-annotation changes; purely GUI adapter-layer fixes and diagnostics. Selector-override semantics (`gui.selectors` in `agent-profiles.json`) are unchanged (a single-string override still wins).
