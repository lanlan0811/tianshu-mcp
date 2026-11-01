# v0.9.8 — shared CDP transport moved out and renamed (pure refactor)

> **`TraeworkCdpClient` is moved out of the `traework/` directory into
> `src/agents/cdp/client.ts` and renamed to `GuiCdpClient`. No agent is removed in this
> release; behaviour is unchanged.**
>
> This is release 1 of the six-release plan "remove TraeWork and Qoder CN support". It exists
> as its own release for one reason: do the high-risk refactor first — the one that would
> break five agents at once if done wrong — and confirm zero behaviour change with a full
> regression before any deletion happens.

**No breaking changes, no new parameters, tool surface unchanged (still 8 tools), zero
behaviour change.**

---

## Background: why `src/agents/traework/` cannot simply be deleted

`TraeworkCdpClient` (formerly `src/agents/traework/cdp/client.ts`) carries the **generic CDP
transport**: WebSocket connection, `send` timeouts, `CdpDisconnectedError` /
`CdpUnavailableError` disconnect semantics, `listTargets` / `probe` readiness probing.

Six GUI adapters reuse it:

```text
src/agents/codex/cdp.ts          src/agents/codex/instance.ts
src/agents/zcode/cdp.ts          src/agents/zcode/instance.ts
src/agents/kimicode/cdp.ts       src/agents/minimax/cdp.ts
src/agents/opendesign/cdp.ts     src/agents/qoder/cdp.ts
```

A straight `rm -rf src/agents/traework/` would break codex / zcode / kimicode / opendesign /
minimax all at once. So the transport has to move first, decoupled from any product name.

---

## Changes

### Move and rename

| Item | Change |
|---|---|
| File | `src/agents/traework/cdp/client.ts` → `src/agents/cdp/client.ts` |
| Class | `TraeworkCdpClient` → `GuiCdpClient` |
| Error classes | `CdpDisconnectedError` / `CdpUnavailableError` **unchanged** (neutral semantics, 20+ references) |

### Transport layer split from the selector layer

After the move the file was split once more, so that deleting TraeWork's selector table can
never touch the shared transport:

- **Stays in `src/agents/cdp/client.ts` (transport + generic primitives)**: connect, command,
  evaluate, `listTargets` / `probe`, `visibleLabels` diagnostics, `clickAt` / `insertText` /
  `pressKey` / `pressEnter` / `pressEscape`, plus the new **semantically neutral** liveness
  probe `probeSignals(candidates)` (the caller maps its own candidate selectors in; the
  transport only answers "visible or not").
- **Stays in `src/agents/traework/cdp/client.ts` (selector semantics)**: `TraeworkCdpClient`
  is now a subclass of `GuiCdpClient`, holding only what requires `SELECTORS`:
  `exists` / `text` / `click` / `focus` / `center`, `probeLiveness(overrides)` (resolves
  semantic keys into candidate lists, then delegates to `probeSignals`) and
  the `interpretLiveness()` reading.

So when 0.9.9 deletes `traework/`, what disappears is TraeWork's own selector semantics; the
shared transport is untouched.

### Transitional shells

During 0.9.8, `src/agents/traework/cdp/client.ts` and `selectors.ts` keep re-export shells so
this release is a **purely mechanical rename** — the six internal references inside
`src/agents/traework/` need no edits, keeping the blast radius minimal. 0.9.9 removes them
together with the directory.

> The selector table `selectors.ts` deliberately stays under `traework/` in this release: it
> has exactly one consumer (TraeWork). Moving it buys nothing and only leaves one more file to
> delete in 0.9.9.

### Consumer comments

The six adapters (`codex` / `zcode` / `kimicode` / `minimax` / `opendesign` / `qoder`) had
comments such as "on top of TraeworkCdpClient" or "two TraeworkCdpClients"; these now use the
new class name. A stale class name in a comment misdirects readers just as effectively as a
stale one in code.

---

## Verification

| Gate | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run lint` (`--max-warnings 0`) | 0 warnings |
| `npx vitest run test/unit test/integration test/protocol` | all green (the pre-existing `zcode-rework-loop` concurrency flake remains as previously recorded) |
| Logic-line changes | **none** — `git diff` contains only import lines and comments (manually reviewed) |

Regression focus: `test/unit/gui-cdp-client.test.ts` (formerly `traework-cdp-client.test.ts`,
now testing the transport) locks `send` timeouts, "onclose rejects every pending request", and
"the connection-failure message uses the `appLabel` application name";
`test/unit/traework-client.test.ts` (new) locks that the selector layer's `probeLiveness` is
still a **single** evaluation. Every existing per-agent integration suite (codex / zcode /
kimicode / opendesign / minimax / qoder) still passes, proving transport behaviour is
unchanged.
