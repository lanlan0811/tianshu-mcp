# tianshu-mcp v0.5.6 release notes

[简体中文](release-v0.5.6.md)

The fifth GUI training adds Qoder CN (`agentId=qoder`) to the existing development, liveness, objective verification and repair workflow. The MCP surface remains at 11 tools.

- Configurable installation discovery prioritizes D-drive candidates and verifies Qoder CN identity. Existing instances are preserved; unavailable connections provide recovery guidance.
- Workspaces bind by full path. Unregistered existing directories are imported through New Workspace and the native folder picker.
- `modelSource` distinguishes default and custom models. Names match exactly and omitted settings retain current values. Model Management saves and rereads reasoning preferences; unsupported levels fail explicitly. Global preferences persist and permission mode is retained.
- Completion correlates the current user turn, assistant output and running signals. Uncertain sends retain checkpoints. Users handle approvals; resuming only observes the original conversation. Multi-question answers are fully validated before submission.
- Automatic and manual repair first write a plan, then send its filename, full path and complete text to the original conversation before verification runs again.
- Fix a race when reopening an asynchronously closing model menu. Prompt entry uses real newline input and strict readback.
- Isolate test files to prevent discovery mocks from contaminating Git baseline checks. CI and Release now verify Qoder distribution files.

Real public MCP verification passed on Windows 10 / Qoder CN 0.3.4: default-model development in an existing workspace, custom-model development in a newly imported workspace, objective rejection of a controlled fixture regression, repair-plan generation, user approval recovery, original-session repair and successful re-verification. See the [redacted states and reports](https://github.com/lanlan0811/tianshu-mcp/blob/v0.5.6/docs/qoder-evidence/windows-smoke.json) and [operation guide](qoder-cdp.en.md). Screenshots capture only Model Management, excluding accounts and project paths.

macOS remains `research`: path and platform branches have automated coverage, but real GUI dispatch is disabled pending desktop validation. The Windows sample models are verification configurations, not hardcoded product defaults.

Publication is complete: both remotes carry the same `master` and `v0.5.6` tag at release commit `9ee03da`, CI is green across all 22 jobs ([run 35741308742](https://github.com/lanlan0811/tianshu-mcp/actions/runs/35741308742)), and the Release workflow succeeded ([run 35742181558](https://github.com/lanlan0811/tianshu-mcp/actions/runs/35742181558)) with `tianshu-mcp-0.5.6.tgz` attached and the Gitee mirror release `v0.5.6` created. `tianshu-mcp@0.5.6` is published on npm as `latest` (`dist.shasum` = `67d6babc…`), and a consumer installed from the registry re-passed the strict stdio check 6/6.
