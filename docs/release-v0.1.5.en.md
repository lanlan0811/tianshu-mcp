# v0.1.5 Release Notes

- Release date: 2026-09-08
- Version: `tianshu-mcp@0.1.5`
- License: Apache-2.0
- Chinese version: [release-v0.1.5.md](release-v0.1.5.md)

---

## Highlights

### 1. TraeWork panel mode switching (new feature)

`run_task` gained an optional `mode` parameter supporting `Work` / `Code` / `Design`:

```jsonc
run_task({
  "projectPath": "D:/xxx/my-app",
  "agentId": "traework",
  "task": "Switch to Code mode and implement the login API",
  "model": "GLM-5.3",
  "mode": "Code",          // optional: explicit
  "autoVerify": true,
  "autoFixRounds": 2
})
```

Resolution order: **explicit `mode` parameter > task-text detection > keep `Work`**.
Text detection handles mixed Chinese/English phrasing ("switch to Code mode", "use Design mode", "工作模式", "代码模式", "设计模式", …).

**Key finding from real-machine testing**: TraeWork's three modes **each keep an independent project binding** — switching modes replaces the input bar's project with whatever that mode last used. The execution order was therefore changed to:

```text
ensure instance → wait for UI → new session → switch to target mode → bind project inside that mode → switch model → send task → poll to completion
```

After binding, both the mode and the project are re-verified; any mismatch **fails loudly** (never silently develops in the wrong mode).

Machine-verified (2026-09-08): both `mode=Code` and `mode=Design` completed "switch mode → bind project → send → create file → auto-verification passed".

### 2. README rewritten (bilingual)

- New dedicated **SVG app icon** (`assets/tianshu-mcp-icon.svg` — the Tianshu hub star with three agent nodes)
- New **SVG wide banner** (`assets/tianshu-mcp-banner.svg`, 1280×320), placed above the icon
- Both READMEs now carry stack badges: CI, npm version/downloads, license, TypeScript, Node ≥ 20, MCP SDK
- Language isolation: `README.md` references Chinese docs only; `README.en.md` references English docs only

### 3. License unified

`package.json`'s `license` changed from `MIT` to `Apache-2.0`, matching the repository's `LICENSE` file (the full Apache License 2.0 text).

---

## Change list

| Type | Content |
|---|---|
| New | `run_task`'s `mode` parameter (Work/Code/Design) |
| New | `gui.modeSwitch` profile switch (default `true`) |
| New | `detectModeFromText` / `resolveMode` pure functions (unit-tested) |
| New | `assets/tianshu-mcp-icon.svg`, `assets/tianshu-mcp-banner.svg` |
| New | `scripts/probe-traework.mjs mode <Work\|Code\|Design>` subcommand |
| Changed | TraeWork execution order: project binding now happens inside the target mode |
| Changed | meta block now exposes `model` / `mode` for Tianshu to read back |
| Changed | `package.json`: version 0.1.5, license Apache-2.0, added repository/homepage/bugs, `files` includes `assets` |
| Changed | README.md / README.en.md fully rewritten |
| Docs | `docs/traework-cdp.md`/`.en.md` cover mode switching; `docs/agent-profiles.md`/`.en.md` cover `gui.modeSwitch` |

## Testing

| Item | Result |
|---|---|
| Unit + integration + protocol | **167/167 passed** (v0.1.4 had 153; 14 new mode-related cases) |
| lint / typecheck / build | all clean |
| CI (ubuntu/windows/macos × Node 20/22 + tarball check) | all green |
| Real-machine end-to-end | `mode=Work` / `mode=Code` / `mode=Design` all passed |

## Upgrade

```bash
npm install -g tianshu-mcp@0.1.5
# or let Tianshu pull the latest version in npx mode
```

To specify the panel mode when driving TraeWork:

```text
run_task(projectPath=..., agentId=traework, task=..., mode=Code)
```

## Known limitations

- `mode` only applies to GUI agents (`traework`); CLI agents (`codex`) ignore it.
- The TraeWork window must stay visible (sending relies on simulated input).
- TraeWork UI upgrades may change selectors; diagnose with `scripts/probe-traework.mjs` and override them via the profile's `gui.selectors`.
