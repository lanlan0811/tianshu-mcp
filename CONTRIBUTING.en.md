# Contributing to tianshu-mcp

Thanks for your interest in contributing. This guide covers the development environment, engineering
conventions, and the submission workflow.

Chinese version: [CONTRIBUTING.md](CONTRIBUTING.md)

---

## 1. Prerequisites

| Item | Requirement |
|---|---|
| Node.js | ≥ 20 (CI covers 20 / 22 / 24) |
| Package manager | npm (the repo ships `package-lock.json`) |
| OS | Windows / macOS / Linux (three-platform CI matrix) |
| Git | Needed for baseline-analysis features and commits |

## 2. Local development

```bash
git clone https://github.com/lanlan0811/tianshu-mcp.git
cd tianshu-mcp
npm ci                # install from the lockfile
npm run build         # sync-version + tsc → dist/
npm test              # vitest (unit + integration + protocol)
```

Scripts:

| Command | Purpose |
|---|---|
| `npm run build` | Sync the version (`scripts/sync-version.mjs`) and compile to `dist/` |
| `npm run dev` | Run `src/index.ts` directly via `tsx` (stdio server) |
| `npm test` | Full test suite (vitest run) |
| `npm run test:watch` | Watch mode |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint with `--max-warnings 0` (zero tolerance) |
| `npm run check:stdio` | Strict stdio protocol check (runs the built `dist`) |
| `npm run check:stdio:src` | Same, but runs the source entry via `tsx` (no build needed) |
| `npm run format` | Prettier over `src` and `test` |
| `npm run pack:check` | `npm pack --dry-run` to inspect the published contents |

## 3. Required before committing (same as CI)

```bash
npm run typecheck && npm run lint && npm test && npm run build && npm run check:stdio
```

`check:stdio` spawns a real child process and validates the complete stdout/stderr byte stream per
scenario: stdout may contain only newline-delimited, schema-valid MCP JSON-RPC messages (requests and
response IDs checked); empty lines, non-JSON lines, parser errors, or trailing fragments at exit all
fail the run. It covers six scenarios: first start, second start with matching skills,
`--no-skill-install`, a corrupt `config.json`, logs while a stub task runs, and clean EOF shutdown.

CI enforces two extra checks — keep them in mind locally:

1. **No unexpected tracked diff after build**: `npm run build` rewrites `src/version.generated.ts`;
   when bumping the version, commit that file together with `package.json`, otherwise CI's
   "No unexpected tracked diff after build" fails.
2. **Tarball contents and installed-package protocol**: CI installs the freshly built tarball into a
   clean consumer directory, reads the installed bin dynamically, and reuses `scripts/check-stdio.mjs`
   (the consumer installs no dev dependencies).

## 4. Engineering conventions

- **Language**: code comments, logs, error messages and docs are in Chinese; public docs must be
  **bilingual in two separate files** (`X.md` and `X.en.md`).
- **No hardcoding**: machine paths, usernames, ports, etc. go through profiles/config or placeholders
  (e.g. `{LOCALAPPDATA}`); code provides discovery rules and defaults only.
- **Cross-platform**: anything touching paths/processes/signals must handle both Windows and POSIX
  (the three-platform CI matrix verifies this).
- **SVG icons only**: emoji must not be used as icons.
- **stdout is reserved for the MCP protocol**: runtime code under `src/**` must not call
  `console.log/info/debug`; log through `src/util/log.ts` (which writes stderr via `console.error`).
  ESLint's `no-console` enforces this, and `npm run check:stdio` covers new output with a real process.
- **Zero lint warnings**: `npm run lint` runs with `--max-warnings 0`.
- **Tests**: new features and fixes should ship with tests; prefer unit tests for pure functions and
  integration/protocol tests for orchestration or protocol behavior.
- **External input**: always validated with zod (`src/config/schema.ts`).

## 5. Code map

```text
src/
├── index.ts              entry point (stdio)
├── server.ts             assembly: config/logging/manager/engine/registry/tool registration/skill self-install
├── config/               zod schemas and data-dir persistence (hot reload)
├── mcp/                  tool registry, handlers, context, result formatting (text + meta block)
├── tasks/                task state machine, queue, concurrency gate, event-stream persistence
├── loop/                 single-task orchestration (rework loop) and repair-plan generation
├── agents/               adapter abstraction, registry, spawn wrapper, built-in profiles
│   └── traework/         GUI driver (CDP client / selectors / launcher / UI / restricted computer-use)
├── verify/               acceptance engine (command checks + code analysis + git baseline + reports)
└── util/                 logging, paths, files, timeouts
```

Test layers:

| Layer | Location | Notes |
|---|---|---|
| Unit | `test/unit/` | Pure functions and component logic |
| Integration | `test/integration/` | stub-agent 3 playbooks, TraeWork fake-CDP end-to-end |
| Protocol | `test/protocol/` | Official SDK stdio/in-memory client asserting the tool surface and return format |
| Real process | `scripts/check-stdio.mjs` | Strict stdio gate: real child-process byte stream, stdout may carry MCP messages only |
| Real-machine probe | `scripts/probe-traework.mjs` | Requires a real TraeWork, **not in CI** |

## 6. Commits and branches

- **Commit on `master` only**; do not create other branches.
- **Commit messages are in Chinese**, preferably `type: summary` with type one of
  `feat` / `fix` / `docs` / `chore` / `test` / `refactor`.
- **One feature, one commit**, with all gates green before committing.
- Push to both remotes: `github` (primary) and `gitee` (mirror).

```bash
git add .
git commit -m "feat: add xxx"
git push github master
git push gitee master
```

## 7. Versioning and releases

- Versions follow Semantic Versioning. To release:
  1. bump `version` in `package.json`;
  2. run `npm run build` to sync `src/version.generated.ts`;
  3. commit and push to both remotes;
  4. tag (e.g. `v0.1.5`) and push the tag to both remotes → the `Release` workflow validates
     `tag == package.json == tarball` and creates a GitHub Release (draft, publish manually);
  5. `npm publish --registry=https://registry.npmjs.org --access public`.
- Record the change in [CHANGELOG.md](CHANGELOG.md) / [CHANGELOG.en.md](CHANGELOG.en.md).

## 8. Adding a new external AI-Agent

In most cases **no code change is needed** — add a profile to the data-dir `agent-profiles.json`:

1. Follow the field reference in [docs/agent-profiles.en.md](docs/agent-profiles.en.md).
2. CLI agents: configure `command` / `argsTemplate` / `promptMode` / `cwd`;
   GUI agents: configure `driver: "gui"` plus the `gui` section.
3. If output parsing needs special semantics (e.g. non-zero exit but success), implement an
   `AgentAdapter` and register it in the registry.
4. Self-check discovery with `get_profiles`, then run one real task through acceptance.

## 9. Reporting issues

- Bugs / feature requests: use the repository issue templates (`.github/ISSUE_TEMPLATE/`).
- Security vulnerabilities: **do not** open a public issue; report privately per [SECURITY.en.md](SECURITY.en.md).

## 10. Code of conduct

By participating you agree to abide by [CODE_OF_CONDUCT.en.md](CODE_OF_CONDUCT.en.md).
