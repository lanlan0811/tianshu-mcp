# v0.8.2 — Codex model-trigger readback no longer mistakes the effort strip for the model name (issue #34)

> See [CHANGELOG](../CHANGELOG.en.md#082---2026-10-07).

## Theme: make "read a model name" actually read only the model name

The Codex model trigger used to be read via the **whole `innerText` of the button**. Measured on
`26.930.4958.0`, that button carries not just the model name but the **entire reasoning-effort strip** —
all 9 carousel layers live in the DOM (`无/极低/轻度/中/高/极高/Max/Ultra/持续`), only the current one at
`opacity:1` while the rest are `opacity:0` **but still `display:block`**, so `innerText` picks them all up:

```text
6 Luna
中
无 极低 轻度 中 高 极高 Max Ultra 持续
```

The old parser required the text to **end** with a level word; it actually ended with `持续` → no match →
`if (!m) return { model: flat }` took the **whole string** as the model name → `exactUiName(model, "6 Luna")`
always false → the model-switch branch ran → `model_mismatch` after three rounds.

**The blast radius is "every Codex dispatch that specifies `model`"**: the failure happens *before* the task
brief is sent, which makes `autoFixRounds` a no-op — the task never reaches the repair stage. The issue
reproduced on `26.917.9434` / `26.917.8451`; re-testing on `26.930.4958.0` showed it **still reproduces**.

## Fix: read structure, not the whole string

A regex approach would have to **enumerate every level word** (`无/极低/轻度/…/Max/Ultra/持续`) and would
break again each time the product adds one; it also cannot distinguish "the model name itself contains a
level word" from "a level strip leaked in". So the read now targets **structure** — it returns the current
value itself, decoupled from how many steps exist:

| Priority | Source | Hardware evidence |
|---|---|---|
| ① `attrs` | `[data-codex-intelligence-trigger]`'s `data-selected-reasoning-effort` + `[class*=ModelPickerTriggerModelText]` inside it | measured `medium` |
| ② `nodes` | model-name node + `[class*=ModelPickerTriggerEffortLabel] .sr-only` | measured `.sr-only` text `中` |
| ③ `innerText` | the raw string → split by `parseTriggerValue` (legacy layout / class-name drift fallback) | legacy layouts |

**The `matches()` predicate was not touched at all** — only the data fed to it. That boundary matters:
the symptom (`model_mismatch`) surfaces in `run.ts`, while the root cause lives in the read layer
(`cdp.ts` treating three distinct meanings as one) and the parse layer (`model.ts`'s overly narrow
contract) — so the fix landed there.

## Companion contracts

- **When the two effort sources disagree, the attribute wins**, and the mismatch is reported via `warn`
  (never silently picking one).
- **All three sources empty = "not read this time"**: `resolveTriggerReadback` returns `{ model: "" }` and
  the caller `waitStableTrigger` keeps waiting — it **must not** report `model_mismatch` from it (a normal
  occurrence while the page is still rendering).
- **The stability predicate now compares the parsed model name**: it used to compare raw text, which the
  carousel animation keeps changing forever.
- **`xhigh` is explicitly not guessed**: `NormalizedLevel` only has low/medium/high, so
  `levelFromTriggerToken("xhigh")` returns `undefined`.

## Incidental finding: slider steps drift across versions

On `26.930.4958.0` the reasoning slider has **4 steps** (`aria-valuemin=0 / aria-valuemax=3`), with
`data-selected-reasoning-effort` measured as `0=low / 1=medium / 2=high / 3=xhigh`; the "5 steps / max=4"
note in `run.ts` came from `26.903`. **`LEVEL_SLIDER_STOP`'s `high=2` still holds on the new layout** —
no implementation change, only the stale comment was corrected.

## Verification

| Item | Result |
|---|---|
| Hardware re-verification (production code, Codex `26.930.4958.0`) | `modelTriggerReadback()` → `{model:"6 Luna", levelToken:"medium", source:"attrs"}`, model name matches the panel |
| Pre-fix control | the same button's `innerText` was `6 Luna 中 无 极低 轻度 中 高 极高 Max Ultra 持续` → the whole string became the model name |
| New unit cases | 10 (real-device string fallback / structure-over-innerText / authoritative-wins-on-conflict / empty-sources-don't-misfire / `xhigh` not guessed) |
| New end-to-end case | 1 (simulates the polluted real-device shape; still no misfire when only the `innerText` fallback remains) |
| Reversal self-check | reverting `parseTriggerValue` turns 6 new cases red; restoring makes them green (the tests have discriminating power) |
| Full suite | **1621 passed / 12 skipped** (131 files); `mcp-gui` 172 passed |
| Gates | `tsc` / `lint` / `check:stdio` all green |

## Known limitations

- **The level-word set drifts across versions**: the issue's string ends with `最高`, the local measurement
  with `Max`. This is the direct reason for choosing "read structure".
- **Structural reads depend on class base names** (hash suffixes change), the same convention every existing
  Codex selector in this repo follows; drift can be hot-fixed via `gui.selectors`, and the new structural
  probe item in `probe-codex.mjs` serves as drift monitoring.
- "Model names drift across versions" (`5.6 Terra` / `6 Luna`, etc.) is normal product behaviour; the
  adapter's existing fail-closed + candidate-echo design is unchanged.
