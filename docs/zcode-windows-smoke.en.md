# ZCode Windows Hardware Acceptance Record

Acceptance date: 2026-09-11  
Environment: Windows 10 x64, ZCode `3.11.2.6792` (auto-discovered at `D:\Z-Code\ZCode\ZCode.exe`), model `DeepSeek/deepseek-flash`, permission mode Full Access.

Every task ran in an isolated temporary Git fixture. Neither this repository nor a user project was modified. MCP preserved the ZCode instance and did not close the user's window.

| Scenario | Task / session | Result |
|---|---|---|
| Real file development | `tsk_20260911173032_edc5bb` / `sess_1cc7b011-e1a4-4caf-bb2f-cc6096026db4` | ZCode created `done.txt=PASS`; `git diff --check` and `node check.mjs` both passed (2/2), ending with `reply_stable` |
| Controlled acceptance failure and automatic repair | `tsk_20260911175749_f2678a` / `sess_d3d15c20-8458-4b12-95bc-0b85eee41812` | Round 0 produced `FAIL` and failed acceptance as designed; MCP generated one repair plan, round 1 reused the same session, changed the value to `PASS`, and passed 2/2 checks |
| Model question and continuation | `tsk_20260911184918_0ffe5f` / `sess_5a665e9c-f9b1-4f21-847f-db4d492ca5a2` | ZCode invoked `AskUserQuestion` and MCP returned `needs_user`; `continue_task(PASS)` selected and submitted the exact option in the original session's question card without duplicating it in the normal composer, then passed 2/2 checks |

The same acceptance run also covered non-CDP instance protection, native folder-picker import, exact project-path read-back, model display/internal-ID read-back, permission read-back, send confirmation, stable new-session tracking, renderer-reload recovery, and delayed message acceptance.

The macOS paths have unit, fake-CDP, and CI coverage but no hardware evidence yet, so the built-in ZCode profile remains `research`.
