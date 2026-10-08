# tianshu-mcp v0.9.1

**Release date**: 2026-10-08
**Type**: Bug fixes (**no breaking changes**)
**Chinese version**: release-v0.9.1.md

---

## In one line

Running the full loop against the real TraeWork desktop app (Code mode + `DeepSeek-V4.1-Flash`)
surfaced 5 defects. Two of them are **conclusion-opposite-to-reality** class —
**a queue notice reported as "task completed"** (false success) and
**the cancel path entirely broken** (false failure). Also adds a TraeWork real-machine smoke script.

**No breaking changes and no change to the tool surface (still 8 tools); upgrade requires no caller changes.**

---

## Why this deserves its own release

These two defects **never appeared before real-machine testing**, because they only trigger under
specific real conditions:

| Defect | Trigger | Consequence |
|---|---|---|
| Queue notice reported as completion | **Free-tier peak hours** (high model demand → queued) | You get `succeeded` although the task **never started executing** |
| Cancel path broken | Every cancel | The stop button cannot be clicked, the task keeps running in the GUI, and the result can only honestly say "stop unconfirmed" |

For orchestration-style callers (treating `run_task` as an async job and deciding on the terminal
status), both classes lead to **follow-up actions based on a false premise**.

---

## Fixes

### 1. Queue notice reported as "task completed" (false success)

**Symptom**: During free-tier peak hours a dispatched task enters the queue and TraeWork shows

```
Queue notice
The current model is in high demand. You are #1064 in line. Upgrade for priority
response at peak times, or try another model / switch to Auto mode to continue.
```

**Root cause (two conditions combining)**:

1. That bubble carries the「由 AI 生成」footer — **exactly the adapter's completion marker**;
2. While queued, `stopVisible` / `tailLoading` are **both false** — the authoritative run signals miss.

The poll verdict therefore fell straight into the `finished` branch → reported `succeeded`,
**returning "you are #1064 in line" as the deliverable**.

**Fix**:

- Added queue detection, evaluated **before** the completion marker. The discriminator is the
  position phrase「排(在\|队) N 位」, so prose merely mentioning "queue" is not misjudged
  (a dedicated test guards this).
- Queueing is treated as **temporary waiting**: keep polling, periodically report the position;
  it does **not** occupy the「运行证据=」prefix (that prefix is the semantic contract for
  "the agent has started running"; being queued is precisely "not started yet", and occupying it
  would mislead callers).
- The timeout message now states "was queued throughout (last position N) — the task never started;
  consider another model, off-peak retry, or membership", distinguishing it from "the task ran but failed".

**Real-machine replay evidence** (same real DOM + real liveness probe):

```
Before: judgePoll = finished   ← false success
After:  judgePoll = queue      ← position 1064 extracted correctly
```

### 2. Stop button unclickable on cancel

`click()` used to try `element.click()` first and only fall back to coordinate clicks on error.
But `stopButton` matches an **icon element** (`.chat-input-v2-send-button-stop-icon`), and such
elements **have no `click()` method** — `TypeError: e.click is not a function` bubbled straight up,
making the **fallback branch unreachable**.

Now **coordinate click first, DOM click as fallback** (matching the kimicode adapter), with a
`typeof` guard in the DOM branch and no exception bubbling.

### 3. CDP already disconnected by ourselves on cancel

The cancel branch was written `return abortResult()` instead of `return await abortResult()`.

Per JS semantics, `return <promise>` runs the outer `finally` (including `cdp.disconnect()`)
**immediately**, without waiting for the async body — so the connection was already cut by this
function's own finally when the stop button was clicked, reporting
`CDP_UNAVAILABLE: disconnected: client disconnected`.

Stack-trace evidence:

```
at TraeworkCdpClient.disconnect
at runTraeworkTask            ← run.js finally block
at async TraeworkGuiAdapter.run
at async TaskOrchestrator.run
```

For comparison: kimicode / minimax / opendesign all write `return await abortResult()` —
**only traework was missing the `await`**.

**This defect also explains why two consecutive real-machine runs both reported
`guiStop={clicked:false,idle:false}`** — not that the stop button was unclickable, but that the
connection had already been cut by ourselves.

### 4. `lastRunSignal` always undefined

The progress note said「运行信号：」while the orchestrator (`fix-loop`) extracts via
`/运行证据=([^；]+)/` — **of the six GUI adapters only traework used different wording**.

That field is a **documented `query_task` field** and the caller's basis for "is the agent actually
generating"; being permanently undefined meant the smoke script's cancel trigger
(`lastRunSignal === "stop_button"`) **never fired** — in the first real run, the cancel never
happened even though the task ran to completion.

Now「…；运行证据=\<value\>；…」. The value **must be immediately followed by「；」**: the regex
`[^；]+` would otherwise swallow a trailing `）` and yield dirty values such as `"stop_button）"`,
equally breaking the caller's equality checks.

### 5. Finishing the v0.9.0 tool-surface consolidation

| Leftover | Consequence |
|---|---|
| `skills/tianshu-mcp/SKILL.md` had 3 **operational instructions** still naming `cancel_task` | An agent following the docs calls a nonexistent tool → `Tool not found` |
| 3 smoke scripts still called the old tool names | The real-machine main path errors out immediately |
| `rework-repair-hint.test.ts`'s case was a **false green** (called a removed tool while only asserting `isError`) | Masked the defect; permanently green |
| `verify-params.test.ts`'s no-param allowlist contained the removed `get_profiles` | The allowlist was silently dead |

---

## Added: TraeWork real-machine smoke script

```
npm run smoke:traework -- --confirm-send \
  --model "DeepSeek-V4.1-Flash" --mode Code \
  --project "<absolute path>" --task "<task brief>" \
  [--cancel-after-ms 25000] [--auto-verify]
```

- **Three-part guard**: `--confirm-send` / `--model` / `--task` must all be present to send
  (missing any one prints usage and exits 2).
- `--mode <Work|Code|Design>`: TraeWork's three-mode panel; project binding is **isolated per mode**.
- `--cancel-after-ms`: triggers a cancel after running starts, exercising the
  "click stop button + bounded wait" path.
- Isolated data directory; does not pollute `~/.tianshu-mcp`.

---

## Verification

### Real-machine final check (Code mode + DeepSeek-V4.1-Flash + `D:\Trae项目\AI游戏\Minecraft`)

| Path | Result |
|---|---|
| Success | `succeeded`; SVG output matching the brief (512×512, 3/8 grass `#5D9C3C` + 5/8 dirt `#8B5A2B` + two rows of `#3E6B27` jagged transition) |
| Queue | Same real DOM replayed: before `finished` (false success) → after `queue` (position 1064) |
| Cancel | Before `guiStop={clicked:false,idle:false}` + "no stop result to confirm" → after `{clicked:true,idle:true}` + "confirmed stopped", ≈ 1.2s |

### Gates

```
tsc --noEmit                    exit 0
eslint . --max-warnings 0       clean
vitest run                      1673 passed / 12 skipped
```

### Regression locks (all verified by counter-evidence)

| File | What it locks | Counter-evidence |
|---|---|---|
| `test/unit/traework-cancel-path.test.ts` | the `await` must not be dropped, `click()` is coordinate-first, `stopButton` is an icon element | injecting the regression turns it red precisely |
| `test/unit/last-run-signal-contract.test.ts` | the note contract across all 6 GUI adapters + no trailing dirty characters | injecting the old wording turns it red |
| `test/unit/traework-reply.test.ts` (4 queue cases) | queue is not misjudged as completion + false-positive guard | removing queue detection turns 3 cases red |

---

## Upgrade notes

**No caller changes needed**: tool surface, parameters and return shapes are unchanged.
Just upgrade.

Known pre-existing environment failures (**unrelated to this release**, for reference only):
`spawn-regression` (this machine lacks `tianshu-runtime.exe`) and `codex-flow`; both confirmed by a
git-worktree comparison at the pre-change HEAD.

---

## Scope (what this release does not do)

- **No queue-time limit**: while queued, the adapter keeps waiting up to `taskTimeoutMs`
  (30 minutes by default). "End early after N minutes of queueing" is a product decision; this
  release only reports honestly and does not change policy.
- **`continue_task` still unsupported for traework**: traework remains outside the `continue_task`
  support list, which is why queueing does not go through `needs_user` (that would be an
  unrecoverable dead end).
