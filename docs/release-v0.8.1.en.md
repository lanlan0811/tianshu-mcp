# v0.8.1 — Completion detection no longer calls a running task "done" (issue #31)

> See [CHANGELOG](../CHANGELOG.en.md#081---2026-10-06).

## Theme: "no run signal observed" may only converge to idle_timeout

The `finished` verdict of four drivers (ZCode / Kimi Code / MiniMax Code / Open Design) previously looked
only at `stable >= stableRounds` and **did not require that a run signal had been observed in this run**,
whereas Codex has had that gate from the start. When the stop-button / loading selectors drift, the UI
*looks* static — so a task that is still running was judged successful after
`stableRounds × pollInterval` (≈12s by default) and went straight into the acceptance / rework chain.
That is precisely the landing point of "misjudging a task as succeeded".

Key evidence: these four drivers' `PollState` **does not carry that dimension at all** (only
`hash/stable/idleSince`), while Codex's carries `sawRunning` — so this was not "someone forgot a check",
the signal did not exist at the type level. At the same time, tier 4 of the `ARCHITECTURE.md` §8.3
flowchart already states "a run signal never observed → `idle_timeout`": **this release brings the
implementation back in line with the documented contract**, it does not add new semantics.

## Fix 1: add the "observed a run signal" gate to four drivers

| driver | run-signal set | `finished` criterion change |
|---|---|---|
| ZCode | `stopVisible \|\| loading \|\| activeTool` | `sawRunning && stable >= stableRounds && inputEnabled` |
| Kimi Code | `stopVisible \|\| sendStarting` | `sawRunning && stable >= stableRounds && assistantText.trim()` |
| MiniMax Code | `stopVisible` | same shape as above |
| Open Design | `stopVisible \|\| sendStarting` | `sawRunning && stable >= stableRounds && conversationText.trim()` |

Each `PollState` gains `sawRunning`: the running branch sets it, all other construction sites propagate
it. **A run signal that is never observed may only converge to `idle_timeout`** (abnormal end, instance
kept).

**MiniMax Code is a fifth violation the issue did not list** — its `liveness.ts` is fully isomorphic to
Kimi / Open Design and landed in the same period (2026-10-05); it was an omission and is fixed here too.

## Fix 2: fix-loop now really parks these drivers' abnormal ends as needs_attention

**Changing the drivers alone does not close the loop.** `fix-loop.ts`'s
`idle_timeout → needs_attention` allowlist previously covered **only `zcode` / `codex`**; the other three
drivers' `idle_timeout` slipped past that file's two `!autoVerify` exits because `autoVerify` defaults to
`true` (`src/server.ts:81`) and **still entered the project acceptance chain**. In other words, with the
gate alone the user would see "the task still goes into acceptance, just 10 minutes later".

The verdict is now an independently testable pure function, `shouldParkAsNeedsAttention()`, and all five
wired GUI drivers land on `needs_attention` (a non-terminal status recoverable via `continue_task`).

## Fix 3: run signals from send confirmation are now passed to the observation loop

A same-family defect surfaced during implementation by integration tests. The send-confirmation loop (the
bounded observation window after clicking send) already calls `poll()` and accumulates run signals into
each driver's `seenRunning`, but that variable was **only used for the "was the send confirmed" judgement
and never handed to the observation loop**. With the gate in place, if selectors drift or the turn
finishes before the observation loop starts, the loop sees no run signal at all → a started task can never
be judged complete. Yet the send-confirmation phase is the **most reliable evidence** that "this round
really started".

The four drivers now pass that signal along via `ObserveArgs.sawRunningSeed`. ZCode's `seenRunning` also
folds in "the conversation text changed" (not a run signal), so a separate `sawRunningAtSend` accumulates
only genuine signals.

> This sits one layer deeper than the issue describes: not only was the gate missing, so was the transfer
> path for the evidence the gate needs.

In addition, `reobserve` rounds (`user_confirmation` recovery) now **seed** `sawRunning` — the observed
turn was already confirmed running before the recovery, and without the seed "the turn finished right
before recovery → `finished` unreachable → a bogus `idle_timeout`" would follow. ZCode has no `reobserve`
path (`continue + !sendMessage` still re-sends the task brief), so it needs no seed.

## Behaviour boundaries

- **Normally completing tasks behave exactly as before**: a run signal appears, then stillness → still
  `finished`.
- When no run signal can be collected, convergence moves from ≈12s to `idleTimeoutMs` (10 minutes by
  default) and lands on `needs_attention`. That is the existing semantics of `ARCHITECTURE.md` §8.3, not
  something this release introduces.
- **Open Design's artifact fingerprint (`artifactSignature`) is not counted as a run signal** (the tail of
  the issue's suggestion is not adopted): it is the **substrate of the stillness verdict**, while
  `opendesign/run.ts`'s `fetchArtifactForSummary` keeps writing files **after** the `finished` terminal
  state. Treating it as a run signal would make "already finished but still moving artifacts" never
  completable.
- This release contains **no mcp-gui (log viewer) changes** — the GUI follows its own version line
  `gui-v*` (currently `0.1.1-beta.4`).

## Verification

- Contract test `test/unit/liveness-running-gate.test.ts` (14 cases): four invariant groups — "no run
  signal at all → must not return `finished`" (four drivers + a Codex control), "after a run signal was
  observed, completion still works", the reobserve seed, and "send-phase signals must reach the
  observation loop".
- `test/unit/fix-loop-abort-parking.test.ts` (5 cases): the three newly included drivers' `idle_timeout`
  is inside the `needs_attention` set, and successful terminal states never fall into that branch.
- **Counter-example verification**: rolling back zcode's gate turns the contract test red immediately
  (1 failed) — the test really exercises that gate.
- Integration regression: `zcode-flow` 81/81, `kimicode-flow` 51/51.
- Full unit run: 93 files / 1263 cases passing; full integration run: 35 files / 348 passing / 0 failing.
- `tsc --noEmit` / ESLint `--max-warnings 0` / `build` / `check:stdio` all pass.

## Known limitations

- **This is a pure-function and orchestration-layer fix with no real-machine verification**: the run-signal
  collection layer (selectors) of the four drivers is untouched. Real-machine evidence
  (`npm run probe:zcode|kimicode|minimax|opendesign`) needs logged-in GUI instances and is deferred to the
  next real-machine batch.
- **MiniMax Code's degradation risk (known, accepted)**: its `stopVisible` relies on
  `[data-testid="stop-button"]`, extracted from product artifacts and **not re-verified on a real machine**
  (see the "to be re-verified" note at the top of `minimax/liveness.ts`). If that testid does not actually
  exist, then with the gate in place every MiniMax task converges to `idle_timeout` → `needs_attention`.
  This is intentional fail-closed behaviour: `needs_attention` is recoverable via `continue_task`, whereas a
  false success is irreversible. Real-machine evidence should cover this item first.

## Credits

- @jian-in (issue #31): pinpointed the criterion divergence across the four drivers and supplied
  line-by-line evidence, making root-cause confirmation a matter of minutes.
