# tianshu-mcp v0.4.0 release notes

Brings the `codex` and `zcode` GUI drivers to macOS, adds a `projectPath` safety gate, and lands a batch of engineering work that removes event-loop freezes and speeds up the test suite.

> This release comes from community PR [#11](https://github.com/lanlan0811/tianshu-mcp/pull/11) (13 + 4 commits). The maintainer resolved the conflicts against `master` and fixed the Windows-platform defects before merging.

## Added

- **Codex GUI driver on macOS**: spawns the executable inside `ChatGPT.app` directly (`activation` defaults per platform: `spawn`/`msix-com`), with `detached+unref` instance persistence; POSIX process enumeration and SIGTERM stop; darwin discovery defaults; cross-platform project-registration state file; the run-observation loop reconnects CDP across transient renderer hangs and target replacement.
- **ZCode GUI driver on macOS**: adapts to the main process rewriting its title (relaxed port attribution + bounded scan of the configured port range when argv hides the debug port); the folder panel is rewritten for the macOS window form (NSOpenPanel as a standalone window + AX value write into the go-to field, immune to IME interception); the lazy "new task" button falls back to the sidebar button.
- **`projectPath` safety gate**: validated at submission — absolute path + existing directory + `realpath` symlink canonicalization (the receipt states the resolved source); the user's home directory itself and system/root directories are rejected (including macOS `/private/*` realpath forms); dirty git repos get an uncommitted-changes coexistence warning.
- **macOS headless path (user profile)**: the built-in `codex` profile still uses the GUI driver; to avoid GUI automation, add a `driver=spawn` `codex-cli` profile in the data directory to run `codex exec`. ⚠️ Keep the codex CLI up to date: ≤0.130.0 is signed with a revoked certificate and macOS Gatekeeper kills it outright; ≥0.154.0 is required. See "macOS headless path: codex-cli" in the README.

## Upgrade notes (behaviour changes)

- **Acceptance checks now run in parallel by default**: new `verifyConcurrency` (range 1–4), **default changed from serial to 2**. When checks depend on each other's order (a later check reading build output, `--fix`, shared cache directories), set it to `1` for fully serial behaviour; project-level `.tianshu-mcp/acceptance.json` can override it. Report and log formats are unchanged (concatenated in declaration order).
- **Project identity now uses the `realpath`-canonicalized path**: behind symlinked entries (e.g. macOS `/tmp` → `/private/tmp`) a directory may no longer match its previous `projects.json` record or historical task directories. If older tasks appear missing, look them up by the canonical real path.
- **The published package no longer ships `.d.ts` files**: `tsconfig.build.json` disables `declaration`; dist file count 140 → 71. The package declares no `types` field and its `exports` only expose runtime code, so the practical impact on consumers is minimal.

## Fixed

- Fixed **drive roots not being rejected by the safety gate on Windows**: `normPath` strips the trailing slash (`D:\` → `d:`), which never equals the `d:/` entries in the reject list; a dedicated drive-root check was added.
- Fixed symlink ambiguity in `normalizeProjectPath` (macOS `/tmp` → `/private/tmp` used to degrade path matching to name matching and falsely report `project_ambiguous`).
- Fixed the zcode macOS `needsPermission` false positive (the `ACCESSIBILITY_PERMISSION_REQUIRED` literal inside the script text turned every failure into a permission problem).
- Fixed `get_profiles` not listing user-defined profiles from the data directory (`run_task` accepted them while discovery did not report them).
- Fixed flakiness/isolation in a cancellation case and an integration test stub (the `acceptance-parallel` abort point is now deterministic; the `zcode-flow` stub now mocks `listDialogs`).
- CDP `connect()` failure paths now clean up their WebSocket; the `send()` timeout timer is `unref`'d.

## Performance

- All `execFileSync`/`spawnSync` calls async + a 1.5s TTL cache for process enumeration — eliminates event-loop freezes during Windows polling (up to 30s each).
- Bounded-parallel acceptance checks (see `verifyConcurrency` above).
- Git baseline hashing reduced to a single pass; code analysis reads each file once; `get_profiles` and task-snapshot reads are parallel.
- Test suite 267s → 51s (UI-layer sleep is dependency-injected; vitest split into a parallel unit project and a serial integration project; **443 tests**).

## Platform and verification status

- **Windows 10 x64**: the Windows jobs in the three-platform CI matrix are green; the maintainer's local full run is **443/443**.
- **macOS**: the **basic closed loops** for `codex` and `zcode` were machine-verified by the contributor on macOS arm64 (ZCode 3.11.2 / ChatGPT.app 26.901.51231); **the cancel / rework / `continue_task` / new-project matrices are not covered, and both remain `research` on darwin**.
- The maintainer has **no macOS device**, so the macOS hardware results above are **not independently re-verified** — they are taken from the contributor's submitted records and documentation.

## Distribution and compatibility

- Published as a GitHub Release with a tarball, and to npm (`tianshu-mcp@0.4.0`, `latest`). GitHub is primary; Gitee mirrors code and tags.
- This is a **MINOR** release: it adds capabilities and carries the behaviour changes above (under 0.x semantics the MINOR slot is where breaking changes go, consistent with v0.2.0 / v0.3.0). Read the upgrade notes before upgrading.

Related docs: [ZCode guide](zcode-cdp.en.md), [Codex desktop driver](codex-gui-cdp.en.md), [configuration](agent-profiles.en.md), [acceptance config](acceptance-config.en.md), [changelog](../CHANGELOG.en.md).
