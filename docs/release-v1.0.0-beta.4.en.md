# v1.0.0-beta.4 — Attributable first-npx handshake timeouts

> Input: a user-supplied timeout diagnostic ticket reporting
> `MCP connect tianshu-mcp timed out after 60000ms`.
> The ticket attributed the root cause to "npx cold-fetching on first start" but
> **admitted that "the cold-fetch duration itself was never measured — >60s is an inference"**.
> This release turns that inference into a measurement first, then decides what to change based on it.

**What is fixed here is an observability gap, not a latency number.**

---

## Up front: this release does not claim to "fix the 60s timeout"

The cost of a first `npx` cold fetch depends on the network and the registry, which this repository
does not control. What ships is three things:

1. **Attributability** — after a timeout, the log itself says which stage was slow;
2. **Measured evidence** — the inference is upgraded to a reproducible number;
3. **A user-side troubleshooting path** — three steps, each with an observable result.

---

## Added: startup breakdown timing

`src/index.ts` takes four `performance.now()` marks (monotonic clock, immune to system time changes)
from the moment `main()` is entered:

```text
[INFO] 启动分段：进程就绪 3ms（node 24.22.1，pid 2520）
[INFO] tianshu-mcp 已连接（stdio）。… 启动分段：logger 34ms（create 3ms）/ buildServer 31ms / connect 1ms / 总计 34ms
```

- **As soon as the logger exists**, one line is written — if the host's first `npx` launch times out,
  this at least proves the process was started.
- **After `connect()` completes**, one summary line.
- **When the total exceeds 10s**, an extra `[WARN]` states the attribution (usually an `npx` cold fetch)
  and the remedy (a global install).

### The problem before this change

There was **no log output at all** prior to `connect()`. After a host-reported handshake timeout,
`server.log` could not distinguish three situations that require completely different responses:

| Situation | Log evidence before the fix |
|---|---|
| The process was never started | blank (indistinguishable from the next two) |
| npx is fetching; the process has not run yet | blank |
| The process started; the server's own initialization is slow | blank |

### The channel contract is unchanged

Everything goes through `logger` (stderr + `logs/server.log`); **no `console.log` is added**.
stdout still carries JSON-RPC only — every strict assertion in `scripts/check-stdio.mjs`
(blank line / non-JSON / trailing CR / leftover fragment) passes, with zero new bytes on stdout.

---

## Changed: actionable errors for missing visual dependencies

`src/visual/runtime.ts` gets two messages rewritten from non-actionable phrases into copy-and-run
commands. **The error codes are unchanged** (`IMAGE_DEPENDENCY_MISSING` / `BROWSER_DEPENDENCY_MISSING`
are consumed by upstream verdicts and tests):

| Missing | Before | After |
|---|---|---|
| `sharp` | `Install optional image dependencies: npm install --include=optional` | States `npm install -g tianshu-mcp --include=optional`, and `npm install` inside the repo |
| Browser deps | `Reinstall tianshu-mcp browser dependencies` | States `npm install -g tianshu-mcp` + `tianshu-mcp visual browser install` |

---

## Measurements (the basis for this release; all from tool output in this round)

| Experiment | Result |
|---|---|
| `npx -y tianshu-mcp` with isolated `npm_config_cache`, no global install, non-repo cwd | **101798 ms** (server self-reported `0.9.10`, proving a real registry fetch rather than a local package) |
| The host handshake window in the same scenario | 60000 ms ⇒ **the timeout was actually reproduced**, not inferred |
| `npm install --omit=dev` (consumer shape) | 59871 ms / 100 MB / 171 top-level packages |
| `npm install --omit=dev --omit=optional` | 45810 ms / 77 MB / 165 top-level packages |
| Only the 3 handshake-required packages (sdk + zod + cross-spawn) | 24062 ms / 22 MB / 91 top-level packages |
| Server's own startup (after the change, local, warm) | logger 3 ms / buildServer 31 ms / connect 1 ms / **34 ms total** |

**Conclusion: the slow part is installation, not server startup** (34 ms — three orders of magnitude
below the 60000 ms window).

---

## Rejected approach: moving dependency declarations

The original plan was to move `puppeteer-core` / `@puppeteer/browsers` / `pixelmatch` from `dependencies`
to `optionalDependencies`, on the grounds that install-time cost did not match runtime need — these four
packages are indeed all **dynamically imported**, and the handshake path never touches their module graph.

Measurement falsified it:

1. `npm install --omit=dev` does **not** omit optional dependencies — that group still installed
   `puppeteer-core`, `pixelmatch` and `sharp`.
2. Only an additional `--omit=optional` brought it down to 165 packages / 77 MB, and
   **`npx` cannot inject that flag**.
3. `sharp` was **already** in `optionalDependencies`, yet the original ticket observed its install script running.

**Moving the declaration therefore saves no seconds, so it was dropped rather than shipped as a no-op.**

---

## Docs

- `README.md` / `README.en.md`: a new three-step "first start reports a handshake timeout" section —
  read the breakdown lines → bypass npx to isolate → install globally to remove the path.
- `ARCHITECTURE.md` / `ARCHITECTURE.en.md`: the startup chapter documents the breakdown semantics and the
  split between handshake-required and visual on-demand dependencies.
- `HANDOFF.md` / `CHANGELOG.md` / `CHANGELOG.en.md`: this release's entry and measurements.

---

## Verification

| Gate | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| `npm run lint` (`--max-warnings 0`) | exit 0 |
| `npx vitest run` (full) | **1538 passed / 12 skipped** (1550 total, 119 files passed / 3 skipped, 122 total) |
| `npm run check:stdio` (source `dist/index.js`) | 8/8 scenarios PASS, no non-protocol content on stdout |
| `npm run check:stdio` (clean consumer dir with the tarball) | 8/8 scenarios PASS, `serverInfo.version = 1.0.0-beta.4` |
| `npm run check:removed-agents` | exit 0 |
| GitHub Actions run 426 (`9c2bd51`) | **22/22 jobs success** |

---

## Known remaining issues

- **No claim of fixing the 60s timeout**: a first cold fetch depends on the network and the registry,
  which the repository does not control.
- **`package-lock.json` is still at `0.9.8`**, several versions behind `package.json`. Not introduced by
  this release; the scope was not expanded to address it.
- **Whether the client's 60000 ms ceiling is configurable remains unverified** — the ticket reports the
  error string lives in a native binary and cannot be found statically.
