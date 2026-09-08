# v0.1.7 Release Notes

- Release date: 2026-09-08
- Version: `tianshu-mcp@0.1.7`
- License: Apache-2.0
- Chinese version: [release-v0.1.7.md](release-v0.1.7.md)

---

## Fix: project-folder binding still failed (v0.1.6 did not fully resolve it)

Field report: binding `D:\Trae项目\AI游戏\五子棋` showed the native dialog, but the **edit box was empty**
and "选择文件夹" was clicked anyway. Failing task log (`tsk_20260908233713_26e336`):

```
[info] 原生对话框已确认（窗口「Select Project Folder」…），写入路径…
[warn] 原生对话框操作失败：点击确认后对话框仍存在
```

The failure came immediately after `写入路径…` — the path never took effect, yet confirm was clicked.

### Root cause (measured)

**The MCP passes a `normPath()`-normalized path** (lowercase drive + forward slashes, e.g.
`d:/Trae项目/AI游戏/象棋`), and the **native Windows folder picker does not accept that form**.
Measured comparison:

| Written path | Read-back | After clicking confirm |
|---|---|---|
| `d:/Trae项目/AI游戏/象棋` (normalized) | `d:/Trae项目/AI游戏/象棋` | **Dialog stays open** (path rejected) |
| `D:\Trae项目\AI游戏\象棋` (native) | `D:\Trae项目\AI游戏\象棋` | **Dialog closes, binding succeeds** |

The read-back passed (because that is what was written), but the picker rejected the form, so the confirm
had no effect.

### Fixes

1. **Convert to a native path before writing**: new `toNativeWindowsPath()` (forward→back slashes, uppercase drive).
   This is the actual root-cause fix.
2. **Read-back verification after writing**: `WM_GETTEXT` compares the edit box with the target; on mismatch it
   **re-locates and retries** (up to 3 times); if it still mismatches it **does not click confirm** and fails loudly
   (avoiding a wrong directory selection).
3. **hwnd continuity**: the handle detected after the footer click is passed into the write script so only that
   window is touched; after clicking, success requires **that hwnd** to be gone, not "any matching window".
4. **Auto-close stale dialogs**: before binding, leftover dialogs from a previous failure are scanned and
   `WM_CLOSE`d, so nothing is written to a stale window.
5. **Hardened confirm-button location**: in addition to `AutomationId=1` and `ControlType=Pane`, the rect must be
   in the lower half of the dialog (rules out coincidental Panes).
6. The dialog script's full trace (`HWND` / `READBACK` / result) is written to the task log for future diagnosis.

---

## Machine verification (2026-09-08)

| Scenario | Result |
|---|---|
| **New Chinese project** `D:\Trae项目\AI游戏\象棋` (absent from the dropdown, forced native dialog) | ✅ `READBACK|1|D:\Trae项目\AI游戏\象棋` → `OK|path verified and dialog closed` → bound → TraeWork created `result.txt` → verification `succeeded` |
| Chinese project `五子棋` (already in the list) | ✅ dropdown hit, completed |
| ASCII project `ts-bind-test` (regression) | ✅ dropdown hit, task `succeeded` |
| Project registration | ✅ `solo-lite.local-project-folders` 25 → 27, including both Chinese projects |

## Change list

| Type | Content |
|---|---|
| Fixed | **Root cause**: convert to a native Windows path before writing (`toNativeWindowsPath`) |
| Fixed | `WM_GETTEXT` read-back verification + retry; never click confirm on mismatch |
| Fixed | hwnd continuity + post-click check on the same window |
| Fixed | auto-close stale dialogs before binding |
| Fixed | confirm button must be in the lower half of the dialog |
| Added | full dialog-script trace written to the task log |
| Docs | `docs/traework-cdp.md` / `.en.md`: 2 new pitfall entries |
| Tests | 172 → **178** (8 unit tests incl. path normalization; 3 integration tests incl. stale-dialog cleanup) |

## Known limitations

- Relies on the native Windows dialog; the window must stay visible and no third-party tool may steal focus.
- The macOS branch remains fail-closed (unverified).

## Upgrade

```bash
npm install -g tianshu-mcp@0.1.7
```
