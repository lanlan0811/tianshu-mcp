# v0.1.10 Release Notes

- Version: `tianshu-mcp@0.1.10`
- Date: 2026-09-10
- Chinese version: [release-v0.1.10.md](release-v0.1.10.md)
- Related issue: [GitHub issue #1](https://github.com/lanlan0811/tianshu-mcp/issues/1)

## Highlights

This release fixes log pollution of the MCP stdio transport contract. The unified logger previously
sent only ERROR to stderr while INFO/WARN/DEBUG went to stdout, sharing the same stream as MCP
JSON-RPC messages and making strict stdio clients fail to parse the handshake or tool calls.

After the fix:

- **stdout carries valid MCP JSON-RPC messages only**; no diagnostic log is ever written there.
- **DEBUG/INFO/WARN/ERROR all go to stderr** and are still appended to `<data dir>/logs/server.log`.
- **An `INFO`/`WARN` line on stderr is normal diagnostics**, not a server error; only a startup failure
  is fatal and exits non-zero.
- No client-side log filtering, log disabling, or MCP SDK upgrade is required.

No new configuration is needed for this to take effect.

## Changes

| Location | Change |
|---|---|
| `src/util/log.ts` | All levels passing the threshold now write stderr; module comment documents that stdout belongs to the MCP transport |
| `eslint.config.js` | Enables `no-console` (allowing `console.error` only) for `src/**/*.ts` to block new direct stdout writes |
| `scripts/check-stdio.mjs` | New strict stdio smoke: real child process validating the complete stdout/stderr byte stream |
| `test/unit/log.test.ts` | New regression tests for the four levels' channels, thresholds, file logging, and UTF-8 (child-process probe) |
| `test/fixtures/log-probe.ts` | New log-channel probe fixture |
| `.github/workflows/ci.yml` | Adds Node 24 to the matrix; runs the strict stdio check after build; pack-check installs the tarball into a consumer and reuses the check |
| `.github/workflows/release.yml` | Adds `lint`, a post-build strict stdio check and the installed-package protocol gate, failing before a draft is created |

## Strict stdio check

`npm run check:stdio` (runs the built `dist`) and `npm run check:stdio:src` (runs the source via `tsx`)
run the same script with these rules:

- Capture stdout/stderr completely, decode as UTF-8, and inspect every line from launch until the child
  process `close`, including empty lines and trailing fragments at exit.
- Every stdout line must be a newline-delimited MCP message that passes the official
  `JSONRPCMessageSchema`, with request/response IDs matched; any non-protocol line or parser error fails
  the run — nothing is filtered away.
- Six scenarios: first default start, second start with matching skills, `--no-skill-install`, a corrupt
  `config.json` triggering WARN, logs during a stub task, and clean EOF shutdown (exit code 0).
- Asserts the tool set matches the source definitions, `serverInfo.version` matches `package.json`, and
  logs stay on stderr and in the file.

The cross-platform implementation uses `process.execPath`, argv arrays, `shell: false`,
`windowsHide: true`, `os.tmpdir()` and `path` — no GNU timeout, shell redirection, or fixed drive
letters — and injects only isolated user directories (`HOME`/`USERPROFILE`/`TIANSHU_MCP_HOME`) into the child.

## Verification

- Before the fix: `test/unit/log.test.ts` failed 4/6; `check-stdio` failed 6/6 scenarios (evidence in
  `docs/m2-evidence/issue1-old-impl-log-test-failure.txt` and
  `docs/m2-evidence/issue1-old-impl-stdio-check-failure.txt`).
- After the fix: all six scenarios pass for both the source entry and the built `dist` entry, with zero
  non-protocol lines on stdout.
- Distribution check: the tarball produced by `npm pack` is installed into a clean consumer directory
  (no dev dependencies), the installed bin is read dynamically, and the same strict stdio check passes
  all six scenarios.
- Release gates: `typecheck && lint && test && build && check:stdio && pack:check`.
- CI matrix: Windows / macOS / Linux × Node 20 / 22 / 24, evidenced by actual CI results.

## Install

```bash
npm install -g tianshu-mcp@0.1.10
```
