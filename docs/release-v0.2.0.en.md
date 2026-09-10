# tianshu-mcp v0.2.0 Release Notes

v0.2.0 adds a ZCode Electron CDP GUI adapter and extends the shared loop to `run_task → query_task → needs_user/continue_task → automatic verification → same-session repair → re-verification`.

See [zcode-cdp.en.md](zcode-cdp.en.md) for capabilities and safety boundaries. The MCP tool count increases from 8 to 9. The built-in ZCode profile intentionally remains `research` until the real Windows task loop and macOS hardware evidence are completed; Codex and TraeWork behavior remains available.

The release gate requires typecheck, lint, the full test suite, build, strict stdio, npm-package content checks, and a clean-consumer installation. `package.json`, lockfile, generated version, tag, and Release input must agree.
