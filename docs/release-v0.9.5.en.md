# v0.9.5 — Kimi Code Model-Switch Fix

> **Fixes "models outside the quick menu can never be selected"**: when the Kimi Code
> overlay page is in the `hidden` state it does **not participate in hit testing** —
> `elementFromPoint(row center)` returns the stage container `browser-overlay-stage`
> instead of the row. Synthetic clicks are received by that container, so listeners on
> the row **never fire**. Yet the adapter still reads `clicked: true` (coordinates were
> computed and the match count was correct), concludes the click landed, and the
> "Switch model" dialog never appears → reports `model_unavailable` ("model does not
> exist") — misreporting an **environment** problem as a **product** problem.

**No breaking changes. Tool surface unchanged (still 8 tools). No caller changes needed.**

---

## Background

A user reported "the model keeps failing". Investigation showed two separate things:
`cline-pass/deepseek-v4.1-flash` (the entry in the quick menu) genuinely fails to
respond; switching to `deepseek-v4.1-flash` from the `step-plan` group instead made
the adapter report `model_unavailable` — even though that model **exists and can be
selected manually** (confirmed by the user's screenshot).

Neither case is "the model does not exist". Both are **the only entry point missing its
target**: models outside the quick menu can only be reached via
"More models…" → the "Switch model" dialog, and that step is **intermittently broken**
on real hardware.

---

## Root cause

Real-machine probes (reproduced 5/5, including `elementFromPoint` and event-listener
instrumentation):

| State | `document.visibilityState` | `elementFromPoint(row center)` | Events on the row |
|---|---|---|---|
| Repro | `hidden` | `OTHER:browser-overlay-stage` | **none** |
| Normal | `visible` | `CHILD` (hits row) | `pointerdown,mousedown,mouseup,click` |

**A/B causal verification** (identical click code, only page visibility changed):

| Phase | Overlay state | Hit point | Dialog |
|---|---|---|---|
| A as-is | `hidden` | `OTHER:browser-overlay-stage` | **not opened** |
| B bring-to-front + focus emulation | `visible` | `CHILD` | **opened in 1000ms** |

On the code side, `clickAt()` only performs a foreground check for the **main window**
(`if (role === "main") { if (await this.pageHidden()) await this.focusMainWindow(); }`),
and the **overlay page was never brought to front**. `ensureOverlay()` only connects
and validates the URL — it has no focus step.

> **Signal trap**: `clicked: true` only means "coordinates computed and the match was
> unique" — **it does not mean the event was delivered**. The only real criterion is a
> post-condition read-back (did the dialog appear, does the model read back correctly).

---

## Fix

Added `focusOverlayWindow()` (isomorphic to the existing `focusMainWindow()`) and
`overlayPageHidden()`, and made `clickAt()` decide based on the **page's own
visibility** for the overlay branch:

```ts
try {
  if (role === "main") {
    if (await this.pageHidden()) await this.focusMainWindow();
  } else if (await this.overlayPageHidden()) await this.focusOverlayWindow();
} catch {
  /* If visibility is unreadable treat as visible and click anyway (read-back still judges) */
}
```

`focusOverlayWindow()` sequence: `Page.enable` → `Page.bringToFront` →
`Emulation.setFocusEmulationEnabled` → **wait for visibility to converge**
(based on `visibilityState` turning visible, not a fixed sleep).

---

## Verification

**Regression locks** (2 new tests):

1. `overlay page in hidden state must be brought to front before clicking "More models…"` — RED then GREEN
2. `no bring-to-front needed when the overlay page is visible` — avoids needless jitter

The RED failure was anchored in the **layer under test**:

```
AssertionError: expected 0 to be greater than 0
 ❯ test/integration/kimicode-flow.test.ts:903:61
   expect(targets.states.overlay.overlayBringToFrontCalls).toBeGreaterThan(0)
```

**Disproof loop**: reverting the overlay branch in `clickAt` (keeping the tests) turns
the new case RED while the other stays GREEN; restoring the fix returns to GREEN
(59 passed).

**Real-machine end-to-end**: **0/5 before** the fix (five consecutive clicks landed but
the dialog never opened) → **4/4 after**, where the first run hit the exact original
condition (`hidden(menu open)=true`) and still opened the dialog.

**Gate-named files**: `Test Files 10 passed (10)` / `Tests 162 passed (162)`;
typecheck green / eslint green (`--max-warnings 0`).

---

## Known issues

1. **`npm test` is unusable on this machine**: the `node.cmd` shim under
   `D:/Tianshu/node-runtime` (`"%~dp0tianshu-runtime.exe" %*`) fails in the project cwd
   with `tianshu-runtime.exe is not recognized`. Invoking vitest directly
   (`node node_modules/vitest/vitest.mjs run <file>`) is unaffected.
2. **Overlay visibility is timing-sensitive**: the fix handles it by waiting for
   convergence; if the product later keeps the overlay permanently `visible`, this
   branch degrades to a no-op (correctness unaffected).

---

## Upgrade

```bash
npm i -g tianshu-mcp@0.9.5
```

Or configure your MCP client with `npx -y tianshu-mcp@0.9.5`.

**No caller changes needed** — the tool surface and parameter contracts are unchanged.
