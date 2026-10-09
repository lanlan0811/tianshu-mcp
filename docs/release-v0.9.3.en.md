# v0.9.3 — Codex 26.1002 Compatibility Fix Release

> **Codex adapter fix release**: after the Codex desktop app upgraded to **26.1002**, the
> adapter surfaced **5 defects in a row**. Three of them made dispatching **entirely
> impossible** — and the worst one **falsely reported success**.
> Each is fixed here with real-device evidence or a regression lock.

**No breaking changes; the tool surface is unchanged (still 8 tools) — upgrade requires no caller changes.**

---

## Background

After Codex upgraded from **26.930** to **26.1002**, several UI behaviors changed, while
many adapter conditions had been established against real-device measurements of the older
version. They failed one after another on the new build:

| Change | Old assumption | Consequence |
|---|---|---|
| Restart lands on an **existing conversation** | composer is always mounted | Connect times out, **never reaches dispatch** |
| `messageArea` container **includes** the composer | conversation text means "delivered" | **False-positive send success** |
| Detached clone `innerText` returns a hollow shell | cloning is a safe collection method | Constant conversation hash, **stability detection meaningless** |
| Process exit → CDP `ECONNREFUSED` | reporting the CDP error is enough | Error points at a **symptom**, not the cause |

---

## Fixes

### 1. False-positive send confirmation (most severe)

The container matched by `messageArea` **also wraps the composer**:

```
MainContentSurface(y=96,h=680)
  └─ … └─ _ComposerLayoutRoot_(y=610)
           └─ div.ProseMirror          ← the input box
```

So "the task brief is still sitting in the input box" counted as "the conversation area
already contains that text" → the adapter reported
`instruction confirmed sent (conversation=true)` while **nothing had been sent**, then polled
a page that would never change until timeout; the leftover text also polluted the next round.

**Fix**: node-level traversal of the visible container, skipping the composer component
subtree entirely.

### 2. Inverted readiness condition during connect

`connectStableCodex` used to accept only `chatInput` as the readiness signal:

```ts
if (await candidate.exists("chatInput")) return candidate;   // ← the only signal accepted
...
// "New chat" is not clicked until line 320
if (gui.freshSession && !(await cdp.click("newChat"))) ...
```

But when the page rests on an existing conversation, the composer is **not mounted**
(measured: `chatInput=0`, while the "New chat" button is clickable). So it retried until
timeout and reported "Codex input box has not recovered", **never reaching the step that
clicks "New chat"** — the order was inverted.

**Fix**: the readiness condition is now "`chatInput` mounted **or** `newChat` clickable",
and the code explicitly waits for the composer after clicking "New chat" (the composer on a
fresh conversation page mounts **asynchronously**). If it does not appear, the adapter reports
"input box did not appear after clicking New chat" instead of an ambiguous timeout.

### 3. Distorted reply-stability detection (constant `conversationText`)

The old implementation collected text from a **detached clone**. Detached nodes have
**no layout** — Chromium returns only a hollow shell for `innerText`:

| | Measured |
|---|---|
| Real conversation in the visible container | **605 characters** |
| Read back from the detached clone | **4 characters** (`"输出内容"`) |

So `conversationText` was constant and the hash was constant (three rounds all hashed to
`87b0fa42c896`), making reply-stability detection meaningless.

The `[class*="Composer"]` substring match also **clobbered the conversation scroll container**
— the Tailwind variant `has-[[data-composer-expand-toggle]]` contains that substring too, and
29 matching nodes **included the entire `thread-scroll-container`**.

**Fix**:
- Node-level traversal with `textContent` (layout-independent; identical for detached and
  in-tree nodes).
- Skip only composer **component** nodes (exact base names `_ComposerLayoutRoot_` /
  `_ComposerLayoutBody_`).
- Leaf text is joined with an **empty string** — joining with a space would split
  `【tianshu:xxx】` into two pieces and break `seenMessage`.

**Real-device re-verification**: `conversationText` **4 → 428 characters**; the hash now
varies with content; the model toolbar and effort bar no longer pollute the text.

### 4. Process exit misreported as CDP disconnect

After killing the process on a real device, CDP reports `ECONNREFUSED` — that is a
**consequence**, not the cause. The old implementation treated it as a CDP disconnect,
pointing troubleshooting in the wrong direction.

**Fix**: added `diagnoseCdpLoss()`, shared by both disconnect exits (the send-confirmation
loop and the run-detection loop). Probe failures conservatively assume "process still alive"
rather than misreporting an instance exit.

### 5. Hard-coded program name in CDP error messages

`TraeworkCdpClient` is reused by **6** adapters
(traework / codex / kimicode / minimax / opendesign / qoder), but the error text hard-coded
TraeWork — the other five pointed users at the **wrong program** on error.

**Fix**: added `CdpClientOptions.appLabel`; each adapter passes its own program name.

---

## Other changes

- **Added** `scripts/smoke-codex.mjs`: a real-device smoke script for Codex, registered as
  `npm run smoke:codex` and included in the npm `files` manifest.
- **CI fix**: removed banned emoji from source comments. The project's plain-text protocol
  rule scans all of `src/**/*.ts` (**comments included**) for emoji status icons; a hit turns
  all four platforms red.

---

## Verification

| Item | Status |
|---|---|
| typecheck | pass |
| eslint | pass |
| CI (4 platforms × Node 20/22/24) | pass |
| GUI build gate | pass |
| Real device: 3-round new-task smoke (`5.6 Terra` + reasoning effort "high") | 3/3 succeeded, artifacts verified item by item |
| Real device: `conversationText` regression re-check | 4 → 428 characters, hash varies with content |
| Regression lock (reverting the fix turns it red) | pass |

---

## Known issues

1. **Occasional "send not triggered" on the first round of a new conversation**: on Codex
   26.1002, text is typed but sending is not triggered, reported as `send_unknown` (text
   remains in the input box, no artifact produced). That path **never resends** (resending is
   riskier than a misjudgment), so it reports an honest error rather than a false success.
   The send path will be fixed separately next time.
2. **Model picker may include group headings**: on newer builds the group heading (e.g.
   "Default/Recommended models") shares `role="menuitemradio"` with real model items and may
   leak into model candidates (real items carry `data-state`; headings do not).
3. **`【tianshu】` marker loses middle segments when split across spans**: the most common
   shape is handled at the leaf-joining step; deeply nested cases remain for later.

---

## Upgrade

```bash
npm i -g tianshu-mcp@0.9.3
```

Or configure your MCP client with `npx -y tianshu-mcp@0.9.3`.

**No caller changes required** — the tool surface and argument contracts are unchanged.
