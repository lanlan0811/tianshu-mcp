# Codex Desktop GUI Hardware Acceptance Record (codex-windows-smoke.en.md)

- Date: 2026-09-11
- Platform: Windows 10 x64
- Codex: `OpenAI.Codex` 26.903.9818.0 (MSIX / `2p2nqsd0c76g0`)
- Adapter: `codex-gui` (`driver=gui`, `activation=msix-com`)
- Related: [codex-gui-cdp.en.md](codex-gui-cdp.en.md), [adapter-matrix.en.md](adapter-matrix.en.md)
- Reproduce: `node scripts/probe-codex.mjs --launch`

## 1. Environment facts

| Item | Value |
|---|---|
| Install location | `C:\Program Files\WindowsApps\OpenAI.Codex_26.903.9818.0_x64__2p2nqsd0c76g0` |
| GUI host | `<install>\app\ChatGPT.exe` |
| AUMID | `OpenAI.Codex_2p2nqsd0c76g0!App` |
| Managed profile | `%LOCALAPPDATA%\tianshu-mcp\codex-gui\profile` |
| Other version on host | `26.903.8094.0` also present (scan fallback must take the newest) |

## 2. Item-by-item acceptance

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Install discovery (Appx first) | ✅ | `Get-AppxPackage -Name OpenAI.Codex` → correct InstallLocation/AUMID |
| 2 | Managed instance launch (COM activation) | ✅ | Activation returned a pid; command line carries the dedicated `--user-data-dir` and `--remote-debugging-port=9333` |
| 3 | CDP readiness | ✅ | `/json/version` = `Chrome/152.x`; `/json/list` main page `app://-/index.html` |
| 4 | Target convergence | ✅ | Correctly avoided the `app://-/index.html?initialRoute=%2Favatar-overlay` secondary window |
| 5 | Reuse existing managed instance | ✅ | From the second run: "复用受管实例 pid=…，CDP 端口 9333" |
| 6 | Bind existing project | ✅ | "已选择既有项目：tianshu-mcp", "项目绑定回读通过" |
| 7 | Model + reasoning level | ✅ | Trigger read-back `GPT-5.6 Sol 高`; selector excludes menubar and mode switcher |
| 8 | Enforce permission | ✅ | Read-back "完全访问" |
| 9 | Input and send | ✅ | "指令已确认发送（对话区=true，输入清空=true）" |
| 10 | Run detection | ✅ | `pending → running(stop_button) → finished(stop_button_gone+text_stable)` |
| 11 | End-to-end task | ✅ | Codex actually created the file with content `OK`; task status `succeeded` |
| 12 | Isolation | ✅ | Managed instance uses a separate profile and does not disturb the user's own instance |

## 3. Verification + repair loop (decisions 9/10/11/12)

Real loop against an **already-bound** project (this repository):

1. A temporary acceptance config required `scratch file content === PASS`; the initial task only asked for `OK`.
2. Round 0 verification **failed** (2 checks) → log "已生成修复计划：`.zcode/plans/codex-fix-r1.md`".
3. The repair instruction cited that plan: "第 1 轮返修指令已引用修复计划 `.zcode/plans/codex-fix-r1.md`", sent to the **same session**.
4. Round 1 verification **passed** → status `succeeded`; the file content became `PASS`.

Conclusion: the loop **verification fails → MCP auto-generates an in-project standalone repair plan (round-numbered, not overwritten) → cites it and repairs → re-verification passes** is proven on hardware (see [codex-gui-cdp.en.md](codex-gui-cdp.en.md) §9).

## 4. Defects found only on hardware and fixed

None of the following were caught by unit/integration tests (with a fake CDP); all were surfaced on real hardware, fixed, and now guarded by tests:

| # | Defect | Fix |
|---|---|---|
| 1 | `__codexResolve` argument mismatch (single array vs 5 positional) threw on `texts.length` | Accept both forms + unit test |
| 2 | Model trigger mis-matched the top menu bar (also carries `aria-haspopup`) | Selector `excludes` + scope + unit test |
| 3 | Project picker trigger missed the "切换项目：<name>" form | Precise text/pattern match + unit test |
| 4 | `boundProjectName` matched whole-page text, making the binding check vacuous | Read `aria-label="切换项目：<name>"` |
| 5 | Message-area selector used bare `main`/`#root`, pulling in nav chrome | Use `MainContentSurface`; relax send confirmation to any direct evidence |
| 6 | "源文件夹" is a non-clickable `<label>`; `element.click()` is also untrusted | Trusted mouse events + `elementFromPoint` hit validation; target the drop-zone button |
| 7 | "创建项目" `<h2>` title shares text with the button, causing ambiguity | `clickExact` prefers interactive elements + unit test |
| 8 | The native dialog is invisible to UIA top-level enumeration | Use Win32 `EnumWindows` + `FromHandle` |
| 9 | Leftover native dialogs from a failed run blocked the next run | New `closeStrayDialogs` startup cleanup |
| 10 | PowerShell cold-start `Add-Type` exceeded the timeout | Widen timeouts; make baseline enumeration non-fatal |

## 5. Known limitations

- **The new-project path depends on a foreground window**: the native folder picker only opens while the app window is active. Every step was verified separately on hardware (the `#32770 Select Project Root` dialog really opens, keyboard automation submits, the create-project dialog shows the source folder), but in a fully unattended environment a foreground policy that blocks raising the window can still return `project_create_failed`. Binding **existing projects** and the verification/repair loop are unaffected.
- **macOS unverified**: built-in status `research`, excluded from readiness.
- The `stopButton` wording may change across versions; if it misses, the fail-open path (`idle_timeout`) applies and completion is never misjudged.
