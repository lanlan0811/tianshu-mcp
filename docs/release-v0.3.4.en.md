# tianshu-mcp v0.3.4 release notes

Fixes ZCode project binding, model readback, native-dialog timeouts and session loss after environment recovery in [#8](https://github.com/lanlan0811/tianshu-mcp/issues/8), [#9](https://github.com/lanlan0811/tianshu-mcp/issues/9) and [#10](https://github.com/lanlan0811/tianshu-mcp/issues/10).

## Changes

- Project triggers use ordered override, primary and exact fallback tiers. Ambiguous matches stop selection; binding requires the full project path.
- Model readback decodes stable attributes, supports split provider/model labels and excludes hidden, transparent or clipped outgoing values.
- Initialization shares one deadline (120 seconds by default), with 30-second probes, 60-second native operations and at most two additional safe retries. Windows queries only the owned native dialog. Uncertain side effects are reconciled before further action; submission is never blindly repeated.
- New resumable `needs_user/setup_recovery` state. Environment recovery without a session sends the full original task, context and validated references, excludes the user's environment confirmation and consumes no repair rounds.
- Dispatch dismisses residual menus and waits for a unique, enabled, unobstructed button. One bounded observation window verifies both message and session, using the task marker or unique session delta rather than guessing the latest session. No automatic resend.

See the [ZCode guide](zcode-cdp.en.md) and [configuration guide](agent-profiles.en.md).

Actual Windows tasks, sessions and 2/2 reports are linked in the [hardware validation record](zcode-issue-8-10-validation.en.md).

## Distribution and compatibility

This release publishes a GitHub Release and tarball, and is also published to npm (`tianshu-mcp@0.3.4`, `latest`); `npx -y tianshu-mcp` now obtains this patch, or install the attached tarball. GitHub is primary and Gitee mirrors code and tags, with the mirror release created automatically by the workflow.

macOS has automated and CI coverage but no real-device end-to-end verification for this patch. The ZCode profile remains `research`.
