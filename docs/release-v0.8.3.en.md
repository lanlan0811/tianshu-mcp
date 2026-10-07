# tianshu-mcp v0.8.3

**Bug-fix release** (issue [#38](https://github.com/lanlan0811/tianshu-mcp/issues/38), following up the two remaining items from [#35](https://github.com/lanlan0811/tianshu-mcp/issues/35)).

This release fixes two independent defects: TraeWork's dropdown-footer click used the **wrong input signal for its retry decision**, and **logical setup failures were misreported as environmental ones**.

---

## Problem A: the click "succeeded" yet still idled for the full 20 s

`src/agents/traework/cdp/client.ts`'s `click()` comment claims "DOM click first, coordinate click as fallback", but the implementation is:

```ts
if ((await this.evaluate<boolean>(expr)) === true) return true;   // a weak signal taken as "success"
```

That `true` only means "**the element exists and is visible**" — it does **not** mean the native popup was raised. For DirectUI buttons this is an intermittent fact (`element.click()` reports success without opening the popup; measured in #35). Because the value is treated as success, the coordinate fallback is **reachable only when `evaluate` throws**.

The resulting chain:

```
e.click() pretends to succeed → log says "点击=选择器" → waitDialogAppeared(20_000) idles → fail
                               └─ no remediation whatsoever during those 20 s
```

**The root cause is not "the coordinate click is missing" but "whether a click worked is judged by its return value instead of by its side effect".**

### Fix: a side-effect-driven three-tier ladder

The criterion becomes "**did the native dialog actually appear**", with execution methods ordered by reliability:

| Tier | Method | Basis |
|---|---|---|
| ① | Coordinate click `clickAt` | A real mouse event, equivalent to `Input.dispatchMouseEvent`; measured stable on real hardware in #35 |
| ② | Semantic-key DOM `click` | The weak signal (potentially the "reports success without opening the popup" tier) |
| ③ | Text fallback | Broadens to matching the text "选择文件夹" inside the footer / dropdown container |

Each tier has its **own bounded probe window** (first tier = budget × 0.30) and **must escalate** on failure. Logs record the method that actually worked (replacing the misleading "点击=选择器").

## A second defect caught on real hardware: the budget inflated by 41%

The first live measurement ran a 20 s budget out to **28183 ms**:

| Live measurement | Value |
|---|---|
| Old implementation, total | **28183 ms** (+41%) |
| After the fix | **19213 ms ≤ 20000 ms** |

Root cause: `waitDialogAppeared` checks the deadline **after** probing, and a single probe measures **1.0–4.8 s** (PowerShell cold start + `EnumWindows`), so every tier overflowed by "one probe + a fixed `sleep(1500)`".

The fix has three parts:

1. Check the remaining budget **before** probing (`MIN_PROBE_COST_MS`);
2. Keep `sleep` inside the window boundary;
3. **Always allow at least one probe per tier** — otherwise the coordinate first tier is skipped outright under a short budget. `A-core` caught exactly that regression (`expected '选择器' to be '坐标'`); without it the change would have "fixed one false negative and introduced another".

> **One substantive disagreement with the issue's advice**: the issue suggests narrowing the first wait to 2–3 s. Measurement refutes this — a single probe alone takes 1.0–4.8 s, so a 2–3 s window allows only **0–1 probes**, and a slightly slow dialog would be judged a failure and fall back to the **less reliable** DOM click. The 20 s total budget is therefore kept, but **split proportionally**.

---

## Problem B: logical failures reported as `errorType=spawn`

`src/loop/fix-loop.ts` mapped every `hardFailure` to `spawn`, even though the upstream adapter already held the failure's nature (`endReason=setup_failed`) — **the nature was discarded at the mapping point**.

`spawn` means "the process failed to launch". Yet the original symptom in #35 was a **deterministically failing** logical defect (project unbound in Code mode) reported as `spawn` — steering log readers toward repeated environment retries.

### Fix: adapter self-classification + orchestrator safe default

```ts
// src/agents/adapter.ts
errorType?: "spawn" | "setup_failed";   // the adapter's own classification of the failure

// src/loop/fix-loop.ts
const errorType = runRes.errorType ?? "spawn";   // byte-identical default
const headline = errorType === "setup_failed" ? "setup 阶段失败" : "agent 基础设施失败";
```

TraeWork's seven `hardFailure` points split by "**could a retry or a different environment possibly succeed?**":

| Failure point | Classification |
|---|---|
| Mode switch failed / project binding failed / mode changed after binding / bind verification failed / model switch failed | **`setup_failed`** |
| Executable not found / `cdp_lost` | `spawn` (genuine infrastructure) |

**The other six agents are unaffected** (the default stays `spawn`), and a regression lock asserts exactly that.

### The blast radius is smaller than expected

`errorType` is a `string` in MCP's `formatter.ts`, `string | null` in the GUI's `types.ts` whose filter options come from **dynamic facets** (`filter.ts`), and a free-form string in Rust's `insights.rs` — so **a new value is backward compatible**. `mcp-gui`'s `check:schema-parity` only validates the status/event vocabularies and does not include `errorType`.

---

## Verification

| Item | Result |
|---|---|
| **RED→GREEN (problem B)** | Baseline **4 failed** (`expected undefined to be 'setup_failed'` / copy `agent 基础设施失败`) → **12 passed** after the fix |
| **Reverse control (problem A)** | Reverting the fix turns `A-budget-real` **red**: the old implementation probes **12 times** (an unbounded loop per tier), the new one **3 times** |
| **Live success path** | TraeWork CN `1.107.1` (CDP 9222, mode=Code): **`via=坐标`, 5938 ms, hwnd=14616800** (control: the old implementation idled the full 20 s in the same scenario) |
| **Live budget path** | **19213 ms ≤ 20000 ms** (was 28183 ms) |
| Full suite | **1629 passed / 1 failed → all green after the fix** (the one failure was this round's comments using `⚠️`, tripping `protocol-text.test.ts`'s emoji gate — fixed) |
| `mcp-gui` | 172 passed |
| `tsc --noEmit` / `eslint --max-warnings 0` | green |

## Known limitations

- The intermittent "DOM click fires but no dialog appears" phenomenon itself was **not reproduced on live hardware**. The fake-CDP cases pin the **decision logic** (side-effect driven vs return-value driven), while live verification covers **the actual click method and timing after the fix** — no claim is made that the original intermittent rate was reproduced.
- **The third tier (text fallback) receives only ~34 ms** under the current default budget (the second tier consumes all the remainder). Preserving all three tiers properly would require splitting the second tier proportionally too; not changed in this round (the issue's DoD — "coordinate-first + no more 20 s idle" — is met).
- **`center("cascadeMenuFooter")` still returns coordinates when the dropdown is not open** (a fallback selector matches a persistent element), so a coordinate click may land on nothing and burn the first-tier window. The three-tier fallback makes this non-fatal; tightening the selector is left for later.
- **Problem B was not verified on live hardware in isolation** (it would require changing the user's workspace binding state); its logic is covered by assertions at both the adapter and orchestrator layers.
- No compatibility claim is made for "all TraeWork versions" — live conclusions are tied to the measured version `1.107.1`.
