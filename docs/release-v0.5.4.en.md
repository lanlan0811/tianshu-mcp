# tianshu-mcp v0.5.4 Release Notes

[中文](release-v0.5.4.md)

**Theme**: **Visual acceptance phase 2 — AI visual content validation (issue #13)**. Alongside phase 1's objective pixel comparison and static image-spec checks (v0.5.0), this release adds an **optional, off-by-default** content-check dimension: it validates whether the content of an image or page screenshot matches an expectation you declare explicitly (logo elements, style match, page semantics, and so on).

This is a **PATCH** release: the new capability is optional and **off by default**, and tool signatures, report fields, and the default behaviour of `pages`/`images` remain **backward compatible**. The one thing consumer code should note is enum growth — `VisualResult.status` gains `"uncertain"` and `kind` gains `"content"` — so anything that exhaustively switches on `status` must handle it.

## Positioning

Issue #3 listed "AI validation of whether image content matches the task description" as an optional extension; its objective parts (screenshot comparison, image specs, baseline approval, offline report) shipped with v0.5.0. This release closes out that extension and answers the five design questions issue #13 raised:

| Issue #13 question | Answer in this release |
|---|---|
| Model and credential source (without breaking the "zero credential management" red line) | **Delegate only to a user-defined command**: no model client, no bundled agent-CLI presets, no key reads. The judge command manages its own login state or key |
| Reproducibility (keep judgement jitter from spinning the rework loop) | An input-hash cache guarantees the same product yields the same conclusion; each judgement samples 3 times by default and takes the majority, and split votes yield `uncertain` (never gating, never triggering rework); warning items themselves stay out of the gate |
| Gate placement (warning-only by default vs counted as failure) | **Warning-only** by default; a per-rule `blocking: true` upgrades it to a failing item that joins the repair plan |
| Cost and timeout | `content.timeoutMs` (default 90000ms) is the per-invocation timeout; samples are configurable per rule (≤9); the cache reruns nothing for identical input; the constraint `samples × timeoutMs ≤ limits.roundTimeoutMs` is **enforced at configuration time** (`CONFIG_INVALID` otherwise, rather than a late `doctor` hint); `visual doctor` additionally suggests a total budget for multiple rules |
| Offline and privacy defaults | `allowRemote` defaults to `false` and the byte-egress placeholder needs a per-rule opt-in; the docs and `SECURITY.md` state plainly that whether data leaves the machine depends on your command, and mark the limits of the MCP's enforcement |

## What was added

### Configuration surface

```jsonc
{
  "visual": {
    "enabled": true,
    "content": {
      "enabled": true,                                  // false by default; explicit opt-in
      "command": "vision-cli",
      "argsTemplate": ["judge", "--image", "<image:path>", "--expect-file", "<expect:file>"],
      "cwd": ".",
      "env": { "VISION_API_KEY": "MY_VISION_KEY" },     // a user-declared reference, not the secret itself
      "allowRemote": false,                             // egress denied by default
      "samples": 3,
      "timeoutMs": 90000,
      "minConfidence": 0.6,                             // omitted turns the confidence gate off
      "cache": true
    },
    "contents": [
      { "id": "logo-elements", "files": ["assets/logo.png"],
        "expect": "the logo contains a blue gear and the white text TIANSHU", "blocking": false }
    ],
    "pages": [
      { "id": "home", "source": { "type": "static", "root": "dist" }, "route": "/" },
      { "id": "login-semantic", "source": { "type": "static", "root": "dist" }, "route": "/login",
        "pixel": false,                                  // semantic-only: exempt from baselines
        "content": { "expect": "a username field, a password field and a login button exist", "blocking": true } }
    ]
  }
}
```

Configuration is off by default; declaring rules without enabling them, a missing effective command/template, an unknown placeholder, a byte-egress placeholder without the `allowRemote` opt-in, `samples × timeoutMs` exceeding the budget, and derived-id collisions are all rejected at the schema layer.

### Command contract

- Placeholders: `<image:path>` (absolute image path), `<expect:file>` (temporary file with the expectation), `<image:base64:file>` (temporary file with the image's base64, requires `allowRemote: true`). Any other `<...>` token is rejected.
- The **last stdout line** must be strict JSON: `{ "passed": boolean, "confidence"?: 0..1, "reason": string }`.
- Exit code `0` means the command ran normally (**not** that the judgement passed); non-`0` is a command failure.
- The expectation travels through a temporary file, avoiding command-line escaping and length limits and keeping it out of the process command line and system audit logs; temporary files are deleted in `finally` after each sample.
- The child runs with `shell: false` and structured argv, and is killed as a process tree on timeout.

### Judgement and debouncing

- Sampling is **serial within an item** (items still obey `limits.concurrency`), and the majority vote decides pass/fail.
- Split votes, or effective confidence below `minConfidence`, yield `CONTENT_UNCERTAIN` (neither failing nor triggering rework).
- The cache key covers the image digest, expectation, command string, the **command's absolute path and binary digest**, argument template, cwd, environment-value digest, `allowRemote`, `samples`, and `minConfidence` — so upgrading your CLI invalidates it automatically.
- `minConfidence` **does not apply** when the command reports no confidence (deliberate, to avoid misjudging every such command); the report states that.
- Escape hatches: `content.cache: false` disables caching; `tianshu-mcp visual content cache clear <taskId>` clears it.

### Reason codes

| Code | status | Repairable | Trigger |
|---|---|---|---|
| `CONTENT_MATCH` | passed | no | Majority vote satisfies the expectation |
| `CONTENT_MISMATCH` | failed | yes | Majority vote does not satisfy the expectation |
| `CONTENT_UNCERTAIN` | uncertain | no | Votes split, or below `minConfidence` |
| `CONTENT_COMMAND_MISSING` | — (round) | — | A rule's **effective** command cannot be resolved → whole-round `configurationError`, no result row |
| `CONTENT_COMMAND_FAILED` | blocked | no | Command exited non-zero |
| `CONTENT_TIMEOUT` | blocked | no | Single item timed out |
| `CONTENT_OUTPUT_INVALID` | blocked | no | Last stdout line missing / not JSON / fields invalid |
| `CONTENT_ENV_MISSING` | — (round) | — | A declared host environment variable is missing → whole-round `configurationError`, no result row |
| `CONTENT_CONFIG_INVALID` | blocked | no | Runtime fallback (normally the schema rejects it first) |

### CLI and diagnostics

```sh
tianshu-mcp visual content probe /path/to/project [ruleId]   # real judgement, no evidence and no cache written
tianshu-mcp visual content cache clear TASK_ID               # clear the task-level judgement cache (no --apply)
tianshu-mcp visual doctor /path/to/project                   # gains content-command resolution and budget findings
```

## Red line and egress statement

**Zero credential management (no new credential reads)**: the MCP reads, stores, and forwards no keys, implements no model/vendor HTTP client, and ships no agent-CLI presets. Judgement is fully delegated to a command you declare.

**Where enforcement stops (read this literally)**: whether images leave the machine **depends on the behaviour of your command**; the MCP cannot block that at the system level. Its enforcement is contract-level only — `allowRemote` defaults to `false`, and a rule without the opt-in using `<image:base64:file>` is rejected outright by the schema. `visual doctor` lists each rule's `allowRemote` declaration. Confirm your command's actual behaviour yourself.

## Fixed

**The repair plan listed `optional:true` failures as "must fix"** (the defect issue #13's acceptance criteria require fixing): `repair-plan.ts` filtered only on `skipped`, so warning-only failures also appeared under section 2 "must fix". It now also requires `!c.optional` and adds section 3.2 "warning-only items (no fix required)" listing optional check failures plus `optional:true`/`uncertain` visual items, while section 5 states explicitly that **artifacts must not be faked and checks must not be relaxed to silence a warning**.

## Upgrading

1. Existing configurations need **no changes** and behave exactly as before (content validation is off by default).
2. To enable it, set `content.enabled` to `true` in your `.tianshu-mcp/acceptance.json` under `visual` and supply your own command and `argsTemplate`. Use `visual content probe` to confirm the command works and the judgement is stable before running acceptance for real.
3. Rules × samples × per-invocation timeout can exceed `limits.roundTimeoutMs` (default 300000ms; the factory default 3 × 90000 = 270000 is consistent). Run `visual doctor` for the suggested budget when enabling it; if you raise `roundTimeoutMs`, keep it consistent with `samples × timeoutMs` or the schema will reject the configuration.
4. For code consuming `VerifyReport`: if it exhaustively matches `VisualResult.status`, add an `"uncertain"` branch; if it exhaustively matches `kind`, add `"content"`.

## Compatibility and scope

- This is a **PATCH** (0.5.3 → 0.5.4): the new capability is optional and off by default, and existing signatures and report fields are backward compatible.
- Content items **warn only** by default and are not a gate; only a per-rule `blocking: true` joins failure and rework.
- Enabling content validation changes the `visual` config digest and therefore a task's frozen snapshot: if a historic blocked task starts reporting `VISUAL_INTEGRITY` because of it, go through the existing `visual rules review` → `visual rules approve` flow. **Do not bypass it.**

## Tests and validation

- **644 passed / 12 skipped** overall (Windows 10 x64, Node 24.18.0), 112 cases more than v0.5.3.
- The 12 browser-gated cases run **12/12** on Windows 10 under `TIANSHU_VISUAL_BROWSER_TEST=1`, including 2 new ones covering the `pixel:false` semantic-page exemption and "one screenshot yields both a pixel and a content item".
- `typecheck` / `lint` (`--max-warnings 0`) / `build` / `check:stdio` all pass.
- Real macOS system evidence was collected by CI: the target commit's `CI` workflow is green across all 22 jobs, 6 of them `visual-browser` jobs covering macOS 15 (Apple Silicon arm64) and macOS 15 Intel (x64) across Node 20/22/24.
- **Not covered (stated plainly)**: no measurement against a real third-party vision CLI (all evidence comes from the in-repo stub); and "images never leave the machine" is not verifiable at the system level. See [validation progress](visual-validation.en.md).
