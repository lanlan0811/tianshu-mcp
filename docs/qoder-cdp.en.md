# Qoder CN GUI adapter

The adapter drives the Qoder CN desktop interface through CDP and uses Tianshu MCP's objective verification and rework engine. Only Qoder CN is supported. A matching window title or the international edition is not a substitute. Automated tests do not establish Windows desktop compatibility; real desktop acceptance must also pass. macOS remains `research` and dispatch is disabled.

## Invocation

```json
{
  "agentId": "qoder",
  "projectPath": "D:\\projects\\example",
  "planDoc": "plans/development.md",
  "task": "Implement the development plan and add tests",
  "modelSource": "custom",
  "model": "An already configured model name",
  "reasoningLevel": "xhigh",
  "autoFixRounds": 3
}
```

The project directory must exist and the plan must be readable. Relative plan paths resolve against the project root. Instructions include the full project and plan paths. The adapter does not create missing project directories.

Model parameters are optional. Omitted model and reasoning settings retain the current values. A model name without `modelSource` must have a unique exact match across the default and custom groups. Specify `default` or `custom` to disambiguate duplicate names.

Reasoning aliases are `低/low`, `中/medium`, `高/high`, `极高/xhigh`, `最大/max`, and `关闭思考/off`. Available levels come from the selected model's actual Model Management options. A custom model need not provide every level. Unsupported levels are rejected without downgrade.

Reasoning preferences are changed in Model Management, saved, and reopened for readback. They remain global Qoder preferences and affect later tasks. Reports record the actual model and level. The current permission mode is retained; the adapter never enables full access automatically.

## Installation and workspaces

Discovery checks explicit `gui.exePath`, preferred-drive candidates, registry and shortcuts, then other drives and standard locations. An invalid explicit path fails instead of silently choosing another installation. Paths and discovery budgets are configurable and do not depend on a developer's personal directory.

A connectable primary workbench can be reused. An existing instance without usable CDP is preserved and reported as `needs_user`. Save your work and handle the instance, then call `continue_task`. The adapter does not close or restart an existing instance.

Workspace identity is checked by full path. Names are candidates only, including when directories share a name or contain spaces or non-ASCII characters. Existing unregistered directories are added through New Task, the workspace picker, New Workspace, Add Folder, the native folder picker, and Create. Native dialogs must match ownership, a newly appeared window, and title; the selected source path is then read back.

Initial development starts a new conversation. Rework and continuation restore the saved conversation and recheck its project path. An unconfirmed conversation cannot receive work.

## Waiting and recovery

Use `query_task` for waiting reasons, session identifiers, actual model settings, and stop confirmation. Generation controls, tool execution, and streaming activity indicate work in progress. A static screen, an old completion message, or a lost connection does not prove completion. Objective verification starts only after this user turn's reply has ended and running signals have disappeared.

- **Approval, login, and environment prompts:** Handle them in Qoder, then call `continue_task`. The adapter resumes observation without sending confirmation text to the model. It does not approve, switch models, or resend development instructions automatically.
- **Agent questions:** Supply an explicit answer through `continue_task.message`. A single question accepts plain text. For multiple questions, provide a JSON object keyed by the complete displayed question text. Multiselect answers can use arrays of exact option labels.
- **Uncertain submission:** A checkpoint is persisted before submitting instructions or answers. Missing acknowledgement never causes an automatic resend. Inspect the original conversation and follow the task report.
- **Cancellation and timeout:** Only the owned conversation is stopped, followed by readback. `guiStop.idle=false` means stopping was not confirmed; do not infer completion or dispatch more work.

Example content for the `message` string when answering multiple questions:

```json
{
  "Choose the development language": "TypeScript",
  "Which tests are required?": ["Unit tests", "Integration tests"]
}
```

All questions and answers are validated before answer controls are changed. Recommended or default options never replace missing user answers. Changed questions, missing answers, or unavailable options leave the task waiting.

## Verification and rework

An agent's completion claim is not acceptance. Verification uses configured project checks, change analysis, and enabled visual checks. On failure, MCP first writes `rework-<taskId>-r<round>.md` in the task data directory, then sends the original conversation the failure details, filename, absolute path, and full plan text. The full text remains available even when the plan is outside the project directory.

The default rework limit is three rounds; `autoFixRounds` accepts 0–10. At the limit, the report is retained and the task needs attention. Approval, connection, login, and other infrastructure failures do not trigger code rework.

## Verification boundaries

After building, run `npm run probe:qoder -- install` for installation discovery or `npm run probe:qoder -- state --port 9777` for an existing instance, replacing the port with your configured value. The probe never launches the app, submits tasks, or approves prompts. Connecting may bring the existing workbench forward. Output omits task and reply text; review paths and session identifiers before sharing it.

Automated tests use controlled GUI substitutes and require neither login nor a desktop. Real public MCP verification passed on Windows 10 / Qoder CN 0.3.4 on 2026-09-22: an existing workspace with default Qwen3.8-Flash / low completed development and acceptance; a newly registered workspace with custom deepseek-v4-flash / high completed development, rejection of an injected fixture regression, plan generation, original-session repair, and acceptance again. The user approved reading the external repair plan; resuming only reobserved the original turn. See the [redacted states and reports](qoder-evidence/windows-smoke.json), [default model settings](qoder-evidence/default-model-settings.png), and [custom model settings](qoder-evidence/custom-model-settings.png). These models are examples, not required defaults. macOS path and platform tests do not constitute real GUI validation.
