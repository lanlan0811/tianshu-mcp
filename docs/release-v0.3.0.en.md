# tianshu-mcp v0.3.0 Release Notes

v0.3.0 adds a **Codex desktop GUI adapter** (`codex-gui`), extending the unified task loop to Codex:
`run_task → bind/create project → pick model and reasoning strength → send instructions → run detection →
auto-verify → same-session auto-repair`.

Capabilities and safety boundaries: [codex-gui-cdp.en.md](codex-gui-cdp.en.md).

## Breaking changes

**`agentId=codex` now executes through the desktop GUI instead of the headless CLI; the previous
`codex exec` headless path has been removed.**

- After upgrading, `run_task(agentId="codex")` launches and drives the Codex desktop window rather than a
  headless child process.
- This path requires the Codex desktop app (MSIX store package) to be installed.
- To keep headless execution, add a separate `driver=spawn` profile; see
  [agent-profiles.en.md](agent-profiles.en.md).

```jsonc
// Keep headless execution with a new agentId (do not collide with the built-in codex)
"codex-cli": {
  "driver": "spawn",
  "command": "{LOCALAPPDATA}/OpenAI/Codex/bin/<hash>/codex.exe",
  "argsTemplate": ["exec", "<prompt:arg>", "--skip-git-repo-check", "--sandbox", "workspace-write"],
  "promptMode": "arg", "cwd": "task"
}
```

## Highlights

- **Install discovery**: Appx query first (version-agnostic), scan fallback taking the newest version; AUMID
  resolved dynamically.
- **Launch**: Codex ships as an MSIX package whose GUI host cannot be launched directly (policy denies it);
  it uses `IApplicationActivationManager` COM activation with a dedicated `--user-data-dir` +
  `--remote-debugging-port`, then CDP attaches and converges on the main app page.
- **Projects**: match existing projects by directory name; an unregistered directory is **registered
  automatically** into Codex project state (idempotent + backup + atomic write + written only while the
  managed instance is stopped), falling back to UI creation on failure.
- **Model and reasoning strength**: models are picked as `menuitemradio`; reasoning strength is a slider
  (0–4) set precisely with arrow keys and read back for verification.
- **Verification and repair**: reuses the existing acceptance engine; on failure it generates an in-project
  `.zcode/plans/codex-fix-r<N>.md` and cites it in the repair instruction, up to 5 rounds by default.
- **Run detection**: the stop button is the authoritative signal; without it the adapter fails open to
  `idle_timeout` while keeping the instance.

## Hardware acceptance

Completed on Windows 10 x64:

1. Full loop for a registered project;
2. The verify-fail → generated repair plan → repair-pass loop;
3. Full loop for an unregistered project after automatic registration (model `GPT-5.6 Sol`, reasoning "高");
4. Real business task: drove Codex to build a "Fruit Ninja" mini-game in HTML+CSS+JS; the artifacts passed
   acceptance and were verified playable in a headless browser (score rises, lives decrement, Game Over and
   restart work, no JS exceptions).

Evidence: [Codex Windows hardware acceptance record](codex-windows-smoke.en.md).

## Compatibility and known limitations

- New `GuiProfile` / `ExecutableDiscovery` fields all have defaults, so existing `spawn` profiles are unaffected.
- macOS unverified: the built-in Codex GUI status is `research` and is excluded from readiness.
- The UI creation path for new projects depends on the app window being foreground (Windows foreground lock);
  automatic registration covers the vast majority of cases.

## Release gate

typecheck, lint, the full test suite (340 tests), build, strict stdio, npm pack contents and a clean-consumer
install must all pass; the version must agree across `package.json`, the lockfile, generated files, the tag and
the Release input.
