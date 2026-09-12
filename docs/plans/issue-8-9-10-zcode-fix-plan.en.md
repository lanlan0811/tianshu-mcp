# ZCode issues #8, #9 and #10: repair and v0.3.4 release plan

## 1. Objective and findings

Restore the complete ZCode path: import and bind the project, select the model, submit work, resume paused work, and verify real artifacts. Use staged automatic recovery with a configurable two-minute default budget; request user action only when recovery cannot safely continue.

- Issues [#8](https://github.com/lanlan0811/tianshu-mcp/issues/8) and [#10](https://github.com/lanlan0811/tianshu-mcp/issues/10): merging primary and fallback project selectors makes unrelated project actions invalidate binding readback.
- Issue #10: native dialog probes time out, and script-internal waits exceed the child process timeout.
- Issue [#9](https://github.com/lanlan0811/tianshu-mcp/issues/9): environment confirmation without a session anchor skips the session baseline/delta and drops original context and references.
- Issue #8 also reports contaminated model text. A local pure-function reproduction confirms that old model text and an accessibility label embedded before the current model still produce a false mismatch. Include this directly related blocker.

Baseline: clean master, version 0.3.3; 63 tests in five relevant files pass but do not cover these triggering conditions.

## 2. Implementation

### Project and model readback

- Resolve project triggers by override, primary, then exact fallbacks. Only advance after zero visible matches; multiple matches in a tier are ambiguous. Share this rule across clicking, menu scoping and readback. Remove broad project-label substring selectors.
- Verify the normalized absolute path of the current binding. A display name may help only when uniquely associated with the requested path; a matching name must never override conflicting paths.
- Decode stable current-model attributes first, then use visible current labels and their titles, finally legacy markup. Exclude hidden stale values and accessibility hints. Reject conflicting evidence rather than accepting concatenated textContent.

### Initialization and import recovery

- Track preparation, dialog baseline, folder opening, path submission and binding confirmation, including confirmed results.
- After a timeout, reconcile CDP, imported projects and binding before retrying. Continue immediately if import/binding actually succeeded.
- Retry transient read-only operations within limits. Before repeating any click, typing or submission, prove the previous action did not take effect; otherwise do not replay the whole import.
- Share a deadline between process timeouts and internal script waits; retries never reset it. Cancellation interrupts waits and reaps this operation's helper process.
- On macOS, failed observation is not an empty sheet baseline. Preserve owner, pre-existing window and unique-new-sheet checks.
- Keep tasks running while recovering; report stage changes and periodic progress through existing events. Log elapsed time, phase, attempts and error categories. Do not consume code-repair rounds.
- Preserve the scene and pause recoverably on exhausted recovery budget, permissions or ambiguity; the overall task deadline takes precedence.

### Session recovery and submission

- Distinguish initial dispatch after environment confirmation from an existing-session answer/rework. The mere presence of resume does not decide which path applies.
- Initial dispatch after confirmation captures a pre-send session list and includes original task, context and validated references. Confirmation text is never sent to the model.
- Existing-session answers/rework require the original session; missing or ambiguous anchors never select the most recent conversation.
- Use one bounded observation window for send confirmation and session identity: at most 60 seconds and no more than remaining task time. Message visibility, cleared input or running signals alone are insufficient to establish identity.
- Prefer a task marker. Initial dispatch may use a unique session-list delta; multiple new sessions require marker disambiguation, not the active pane.
- On unresolved send/identity, preserve the scene and explicit send_unknown/session_lost diagnostics. Never automatically resend.

## 3. Interfaces and defaults

Keep run_task and continue_task arguments unchanged. Add gui settings to agent-profiles.json:

| Setting | Default | Meaning |
|---|---:|---|
| setupRecoveryTimeoutMs | 120000 | Initialization through confirmed project binding |
| dialogProbeTimeoutMs | 30000 | One native dialog observation |
| dialogOperationTimeoutMs | 60000 | One folder operation |
| setupRecoveryMaxRetries | 2 | Additional attempts per safely retryable phase |

Every wait is limited by configuration, phase deadline and remaining task time. Old profiles inherit defaults. Add needsUserKind=setup_recovery to adapter and persisted task types; continue_task treats its message as confirmation, rechecks binding and continues the original task. Permission failures retain system_permission.

## 4. Verification

- Execute real CDP expressions against DOM fixtures: primary trigger plus add/move/detach buttons, overrides, hidden and duplicate nodes, same-named paths, Chinese and English.
- Cover mixed stale/current model text, embedded labels, encoded attributes, missing attributes and conflicting evidence.
- Cover transient probe recovery, timed-out operations that actually bound the project, exhausted budgets, cancellation, macOS permissions and unknown baselines. Assert no repeated side effects or consumed repair rounds.
- Exercise real context construction and the ZCode runner for anchorless confirmation, delayed registration, stale panes, multiple new sessions and existing-session answers. Verify complete prompts and single submission.
- Run Windows 10 real-device acceptance using isolated data and temporary projects: cold import, reuse, confirmation after closing a non-CDP instance, real output and automated verification. Obtain model from the environment and pass it explicitly; never hardcode provider, install path or port.
- Require typecheck, lint, full tests, build, strict stdio, pack and clean-consumer checks, plus Windows/macOS/Linux × Node 20/22/24 CI.
- macOS real-device validation remains explicitly incomplete and does not increase support status. Preserve task logs, session IDs, artifacts and reports as evidence.

## 5. Documentation and delivery

- Store separate Chinese and English tracked plans in docs/plans before implementation. Do not force-add ignored .codex/.zcode content.
- Complete project/model readback, session recovery and initialization recovery as separate stages, each with tests and bilingual documentation.
- Work only on master. Inspect scope, use git add ., Chinese commit messages, and push each stage to GitHub then Gitee. Respect .gitignore and do not modify the website.
- Update bilingual configuration, ZCode usage/recovery, acceptance evidence and changelog. Exclude visual acceptance issue #3 and unrelated driver rewrites.
- Target 0.3.4, or the next unoccupied patch if taken at implementation time. Synchronize package, lockfile, generated version and release notes.
- After Windows real-device acceptance and full CI for the release commit, push the version tag to both remotes, run release.yml, and verify the GitHub Release and attachment. Explicitly record any credential-related Gitee release skip rather than claiming success.
- Publish a patch Release, not npm. Explain that npx users do not automatically receive it. Failed gates block release; never overwrite a published tag.
