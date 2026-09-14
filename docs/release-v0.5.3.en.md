# tianshu-mcp v0.5.3 Release Notes

**Theme**: **ZCode hardware-revisit fixes (issue #12, second round)**. After v0.5.2, six hardware revisits of project-less dispatch on Windows 10 exposed — and this release fixes — three defects: GUI desktop instances could not outlive the server exit, the top-bar "new task" click reported success without switching pages so everything afterwards waited silently, and send-failure attribution was misleading when the page was throttled.

This is a **PATCH** release: bug fixes only, no new parameters or behaviour changes. Tool signatures, meta-block fields, report formats and acceptance configs remain **backward compatible**; upgrading requires no caller changes.

## Fixed

### GUI instances could not outlive the server exit (Windows, found on hardware)

The `zcode` and `codex` GUI instances were spawned behind a platform branch (`detached: process.platform !== "win32"`) while `traework` already used an unconditional `detached: true`. A minimal experiment (Windows 10 / Node 24.18.0) on the same spawn shows a non-detached child's survival after the parent exits is 0 and a detached child's is 1. As a result, as soon as the MCP server (or a one-shot smoke / probe script) exited on Windows, ZCode was killed along with it and `keptInstance`'s "instance survives the server exit" was a no-op — `needs_user` told the user to "handle it in ZCode, then call continue_task" while the window was already gone.

The invariant now lives in one place, `guiInstanceSpawnOptions()`, shared by all three GUI instances (`codex` even branched `unref()` by platform; that branch is gone). The execution-type children in `verify/runner`, `visual/services` and `agents/spawn` keep their platform branch because their semantics are the opposite — they must be terminable as a group.

### "New task" reported success without switching pages, then everything waited silently (found on hardware)

When ZCode is parked on an existing conversation, the top-bar `conversation-new-task` is a lazily mounted icon — the click is dispatched and returns `true` but the page does not switch, and a conversation page's composer does **not** mount `composer-workspace-trigger`. Both the project-less default confirmation and the project-binding wait therefore idled until their deadline and reported nothing better than `needs_user/setup_recovery` (measured: 30 seconds of dead waiting).

The draft is now verified by "the project trigger is mounted" after clicking new-task; when it is not, the flow falls back to the sidebar `task-new-button` (reliable on Windows 3.11.2; that fallback previously existed only on the project branch) and only fails closed with `setup_failed` — reporting "the trigger is still not mounted" — when both entry points fail. Real-machine log after the fix:

```text
[warn] [zcode] 顶部新建任务按钮未建立草稿（clicked=true）；回退侧栏新建任务按钮
[info] [zcode] 已通过侧栏新建任务按钮进入新草稿
[info] [zcode] 已确认 default 工作区（无项目模式），跳过项目绑定与导入
```

### Misleading attribution for send failures (found on hardware)

When the window is minimised or fully occluded, Chromium throttles the page (`visibilityState=hidden`) and the send button becomes unclickable even though it sits inside the viewport — `elementFromPoint` does not hit the button itself. The old message said only "the ZCode send button was not enabled or was covered within the observation window", pointing users at the button; the driver now recognises that state and reports "the ZCode window is not in the foreground" together with the instruction to bring it forward. `Page.bringToFront` was measured to be **unable** to restore an occluded Electron window, so no automatic recovery is pretended.

## Hardware verification (Windows 10 x64)

Six hardware revisits after v0.5.2 (environment: Windows 10 x64 `10.0.19045`, Node `v24.18.0`, ZCode `3.11.2.6792`):

| # | Initial UI state | Final state | Conclusion |
|---|---|---|---|
| 1 | Fresh instance on a draft page | `failed/send_unknown` | Message not submitted; true cause still undetermined |
| 2 | Reused instance parked on an existing conversation | `needs_user/setup_recovery` | Reproduced "new task does not switch pages": the trigger never became ready, 30s of dead waiting |
| 3 | Manually switched to a draft | `succeeded/reply_stable` | Full submit timeline sampled |
| 4 | Parked on a conversation + window minimised | `failed/internal` | Fix effective: the log shows the sidebar fallback |
| 5 | Draft page + window visible | `succeeded/reply_stable` | Completed with zero warnings |
| 6 | Window minimised | `succeeded/reply_stable` | "Minimised window always fails" does not hold |

The full evidence chain is in the [issue #12 Windows 10 acceptance record](zcode-issue-12-windows-evidence.en.md), section "Second visit (after v0.5.2)", including honest disclosure of facts that were **not** reproduced or **not** verified this round (the true cause of run 1's `send_unknown` is still undetermined, and the new send diagnostic was never reached on hardware).

## Tests & verification

- Full suite: **532 passed / 10 skipped** (Windows 10 x64, Node 24.18.0), a net gain of **7** cases over v0.5.2: falling back to the sidebar entry when no draft is established and still dispatching, failing closed without sending when neither entry point creates a draft, attributing a send failure to "window not in the foreground" when the page is throttled, keeping the original button attribution when the page is visible, plus 2 regression cases for the GUI-instance spawn invariant (unconditional detached + unref across platforms).
- `typecheck` / `lint` (`--max-warnings 0`) / `build` / `pack:check` all pass; `check:stdio` passes every scenario.
