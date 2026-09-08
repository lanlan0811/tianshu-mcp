# v0.1.6 Release Notes

- Release date: 2026-09-08
- Version: `tianshu-mcp@0.1.6`
- License: Apache-2.0
- Chinese version: [release-v0.1.6.md](release-v0.1.6.md)

---

## Fix: project-folder binding got stuck

Field report: selecting the "project folder" hung — it never navigated to the project path and clicked
"选择文件夹". Investigation: **the adapter was not broken; three defects in the native-dialog chain stacked up**
(measured evidence below).

### Defect 1: the footer click never verified that the dialog opened
The old code trusted `element.click()`'s return value; but that button can be clicked without the native popup
ever appearing. The log line "waiting for native dialog timed out" was a **downstream symptom**, not the root cause.

**Fix**: after clicking, call `findFolderDialog()` to confirm the dialog really appeared; otherwise log the
current dropdown DOM snapshot and fail loudly (making selector drift easy to diagnose).

### Defect 2: the detection budget was eaten by PowerShell cold start
Measured: a PowerShell process cold start costs **4.5–6.3 s** (regardless of UIA vs Win32 probing).
The old code polled from Node every 800 ms → a **15 s budget allowed only ~2 probes**, so any TraeWork slowness
meant a guaranteed timeout.

**Fix**: poll **inside a single PowerShell call** (400 ms interval) and raise the budget from 15 s to **30 s**;
also switched `spawnSync` to async `spawn` so the event loop is not blocked.

### Defect 3: CJK paths were destroyed by the console code page
Measured: `D:\Trae项目\ts-bind-test` written via SendKeys/clipboard became `D:Traes-bind-test`
(CJK and backslashes dropped), so "the path was typed" but a different folder got selected.

**Fix**: write the path with Win32 **`WM_SETTEXT`** (handle obtained from UIA) — fully reliable for CJK.

### Additional fixes

- **The confirm click hit a file-list row**: `AutomationId="1"` is not unique (rows also use 0/1/2…);
  now located by **AutomationId=1 AND ControlType=Pane**, then clicked by bounding rect.
- **PowerShell output garbled for Chinese**: the script now emits ASCII only; Node maps it back via
  `localizeDialogMessage()`.
- **Non-Work binding fallback**: when binding fails in Code/Design, the driver **falls back to Work once**,
  switches back to the target mode, and re-verifies the project is still bound; only if both fail does it
  report an error (including the reason from each mode).

---

## Machine verification

Full chain on a project **absent from the dropdown**:

```text
run_task(projectPath=D:\Trae项目\ts-bind-test, agentId=traework, mode=Code, autoVerify=true)
```

| Step | Result |
|---|---|
| Switch to Code mode | ✅ |
| Dropdown miss (its 12 entries did not include the project) | ✅ went to the native dialog |
| Native dialog appeared and was detected | ✅ |
| Wrote the CJK path + clicked confirm | ✅ dialog closed |
| Project entered TraeWork's list | ✅ `solo-lite.local-project-folders` 22 → 23 |
| Task sent | ✅ TraeWork created `result.txt` |
| Auto-verification | ✅ `succeeded` (1/1 check passed) |

## Change list

| Type | Content |
|---|---|
| Fixed | Footer click verifies the dialog opened; detection polls inside one PS call (30 s budget); `WM_SETTEXT` for CJK paths; confirm located by id+Pane; ASCII-only output |
| Added | Non-Work binding falls back to Work once |
| Docs | `docs/traework-cdp.md` / `.en.md`: 7 new pitfall entries + fallback note |
| Tests | 167 → **172** (dialog message-mapping/platform-branch unit tests + Code→Work fallback integration test) |

## Known limitations

- The chain relies on the native Windows dialog; the **window must stay visible** and no third-party tool
  (e.g. a screenshot utility) may steal focus.
- Once a project folder is bound, TraeWork records it in its own project list, so later tasks can hit the dropdown directly.
- The macOS branch remains fail-closed (unverified).

## Upgrade

```bash
npm install -g tianshu-mcp@0.1.6
```
