# v0.9.2 — ZCode Real-Device Smoke Fix Release

> **ZCode adapter regression fixes**: two rounds of real-device smoke testing (code generation +
> multi-turn new-task creation) surfaced **5 defects**, all related to ZCode 3.14.4's
> **model-identifier semantics** and **clickability criteria**. Three of them made specific models
> **completely undispatchable**; one was a **false success** ("click returns true but the page
> does not move").

**No breaking changes. Tool surface unchanged (still 8 tools). Upgrade requires no caller changes.**

---

## Background

ZCode's model identity has three **mutually non-derivable** semantics. The adapter previously
hard-split or hard-compared against the `provider/model` convention in several places, causing
fail-closed behavior on specific models:

| Semantics | Real-device value (model used in this test) |
|---|---|
| Panel visible label | `OpenRouter/inclusionai/ling-3.0-flash-sante:free` (may carry a `group/` prefix) |
| Panel group display name | `OpenRouter` (user-visible) / `openrouter` (testid segment) |
| `provider/model` argument | `openrouter` + `inclusionai/ling-3.0-flash-sante:free` |

Key point: **the model name itself may contain `/` and `:`** (OpenRouter free models use a
`:free` suffix and the model id contains `inclusionai/`), while the group display name and the
argument segment have **no correspondence**.

---

## Fixes

### ZCode model identifiers (4 defects)

| Defect | Symptom and root cause | Resolution |
|---|---|---|
| **Adapter completely unusable when the model name contains a colon** | `data-model-current-value` has the form `custom:<provider>:<urlencoded-model>`. The old implementation derived the model name via `decodeURIComponent(v).split(":").at(-1)`, **assuming model names contain no colon**. Real counter-example: `custom:openrouter:inclusionai%2Fling-3.0-flash-sante%3Afree` decodes with the last segment truncated to `free`, mismatching the visible label → raises "current model attribute conflicts with visible label", making **every `run_task` fail** | Parse by **stripping the `<kind>:<provider>:` prefix** (split only the first two segments, keep the third intact), matching the attribute format one-to-one. Only trust the result when it matches the visible label; otherwise fall back to the old logic for validation (conflict detection is not relaxed) |
| **Panel group name differs from the argument segment → `model_unavailable`** | Users pass `cline-pass/deepseek-v4.1-flash` as shown in the panel, but the owning group is displayed as `cline` (testid `...registry-provider:new-provider-2`) — **neither segment matches** | When exact provider matching fails, **enumerate visible groups and hover each** to try matching the model name; prefer the **complete original string** for model matching, then fall back to `spec.model`; readback validation accepts three forms: full string / model segment only / provider segment only |
| **Still reports `model_mismatch` after a successful switch** | The panel's visible label concatenates the **group display name** before the model name (`.composer-provider-prefix` = `cline/`). The old readback only accepted full candidate strings → `display=cline/cline-pass/deepseek-v4.1-flash` matched none of the three candidates. **Provider fallback and model selection had both succeeded, yet the final validation killed the run** | Added `uiModelNameMatches()`: try an exact match first; on failure, **strip one** leading `segment/` prefix and retry. The wait condition and the final validation share it. Only one level is stripped — stripping more would match structurally unrelated names |
| **Three-segment model argument rejected by parameter validation** | Model names may contain `/`, so passing "panel group + model display name" necessarily yields three segments (`openrouter/inclusionai/ling-3.0-flash-sante:free`), while `parseZcodeModel` required `split("/").length === 2` → immediately raises "expected provider/model"; **the model cannot even pass parameter validation** | Split on the **first `/`** (everything before is the provider, the rest is the model), corresponding one-to-one with the panel's two separate fields. `/x`, `x/`, and slash-less values are still rejected |

### ZCode clickability (1 defect)

| Defect | Symptom and root cause | Resolution |
|---|---|---|
| **Top "new task" button click is a false success** | Three consecutive smoke rounds **each** logged "top new-task button did not create a draft (clicked=true); falling back to the sidebar button" — only the fallback kept runs alive. Root cause: `conversation-new-task` sits at the bottom of the page's scroll container (real device y=2474, viewport height 640). Width and height are both > 0, so the old criterion considered it "visible", and the mouse event was dispatched **outside the viewport** where Chromium silently drops it — while `click()` still returned `true` | The generic `click()` now applies the same **clickability criteria** as `probeProjectTrigger`: viewport clipping (the center point must fall within `innerWidth`/`innerHeight`) plus an `elementFromPoint` hit test (the target itself or a descendant). On failure it returns `false` and **dispatches no mouse events at all**, so callers take the fallback path instead of waiting |

**Real-device re-verification**: after the fix the warning disappeared and per-round new-task
duration dropped from **67–73s to 46s**.

---

## Real-device verification

Both smoke rounds ran on ZCode 3.14.4.7912 (Windows):

**Round one: code-generation loop**

- Switched from the "currently selected colon-bearing model" state to the target model and dispatched → `succeeded`
- Artifact: `zcode-accept.txt` with byte-exact expected content

**Round two: three new-task rounds (openrouter / inclusionai/ling-3.0-flash-sante:free)**

| Round | taskId | Result | Artifact |
|---|---|---|---|
| 1 | `tsk_20261008231635_614c75` | `succeeded` | `docs/minecraft-intro.md` (2285 B) |
| 2 | `tsk_20261008231843_39fcec` | `succeeded` | `docs/minecraft-gameplay.md` (2642 B) |
| 3 | `tsk_20261008232011_6977cb` | `succeeded` | `docs/minecraft-ecosystem.md` (3472 B) |
| Re-verify | `tsk_20261008232829_f3f922` | `succeeded` | `docs/verify-round.md` |

All three rounds had **distinct session IDs** (new-task isolation correct) and artifacts matched
every requirement in the task briefs.

---

## Tests

- **7 new regression locks**: three-segment parsing and its boundaries (4), readback prefix
  stripping hit and no-overreach cases (2), clickability three states (3)
- **All verified by counter-proof**: reverting the fix makes exactly the target cases go red
- Full suite: **1682 passed / 12 skipped** (1696)
- `typecheck` exit 0

---

## Upgrade

```bash
npm install -g tianshu-mcp@0.9.2
```

The tool surface is identical to 0.9.1 (8 tools); no caller-side changes are required.
