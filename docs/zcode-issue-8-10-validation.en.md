# ZCode #8 / #9 / #10 validation record

Date: 2026-09-13 (Asia/Shanghai). Windows 10 x64, ZCode 3.11.2.6792. The test model was read from local configuration and passed as `DeepSeek/deepseek-flash`; application paths, ports and providers were not hardcoded into business logic.

## Windows hardware results

Tests used isolated MCP data directories and temporary Git projects. Only test-owned ZCode instances were cleaned up between scenarios. Original reports remain in local temporary directories. Sanitized copies are retained locally under `docs/zcode-issue-8-10-evidence/`, excluded by `.gitignore` and not distributed with the repository. File names below refer to those local copies. Logs retain stages and dispatch records and omit repetitive read-only CDP debug lines.

| Scenario | Task and session | Result and evidence |
|---|---|---|
| Reuse an imported project | `tsk_20260913005417_79babf`; `sess_68271737-310e-44f0-8d43-8326833eb3d5` | Full-path binding and model/permission readback passed; actual `done.txt=PASS` created. 2/2 report（`reuse-report.json`）, result（`reuse-result.json`）, log（`reuse-agent.log`）, artifact（`reuse-done.txt`） |
| Handle a non-CDP instance, continue the same task, cold start and first import | `tsk_20260913071919_d0512b`; `sess_4d9e439b-56c0-4ae7-a619-9c045abd0bb2` | Initial pause（`resume-before.json`）: `needs_user/close_existing_instance`, round=0, no session. After ending the test instance, `continue_task` cold-started ZCode and imported/bound the new project in approximately 97 seconds. One native submission, one prompt insertion, one dispatch; environment confirmation excluded. 2/2 report（`resume-report.json`）, result（`resume-result.json`）, stages（`resume-agent.log`）, artifact（`resume-done.txt`） |

Acceptance ran `git diff --check` and `node check.mjs`, which reads the actual file and requires `PASS`. Recovery consumed no repair attempts. Final `round=1` reflects the executor's existing increment after completing round-0 verification.

## Additional findings fixed during verification

- Provider/model labels may use multiple spans; transparent ancestors and clipped outgoing animation text must not count as current model evidence.
- Already-bound projects must not be toggled off. Residual menus must be dismissed before typing so they cannot trap focus.
- Windows native queries now filter by process/handle before accessing the dialog accessibility tree, with one shared deadline.
- Disabled or covered send buttons require read-only readiness checks. DOM tests verify that dispatch occurs only once.

Earlier timeout and `send_unknown` debugging tasks are not counted as successful acceptance and were never automatically resent. A real native timeout entered `needs_user/setup_recovery` and preserved the task; automated integration tests additionally cover same-task continuation through actual TaskManager context construction.

## Automated coverage and platform limitations

DOM fixtures execute production CDP expressions. Recovery tests cover transient probe retries, post-timeout binding reconciliation, exhausted budgets, cancellation of an actual helper process, macOS permission errors and unknown baselines. Integration tests cover full context/references during environment recovery, delayed registration, stale active sessions, multiple new sessions and existing-session continuation without duplicate dispatch.

macOS has automated and CI verification only, **no real-device end-to-end verification** for this patch. Its built-in profile remains `research`; other drivers' support levels are unchanged.

Both tasks changed only the untracked `done.txt` (+2/-0). Cold-import recovery acceptance finished at `2026-09-12T23:23:49.737Z`: `git diff --check` took 161ms and `node check.mjs` 305ms; both exited 0 without timing out and verified PASS on disk.
