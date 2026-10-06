# Log Viewer 0.1.1-beta.5 — deep-link parsing hardened against malformed percent-encoding (issue #33)

> Full change log in [CHANGELOG](../CHANGELOG.en.md); feature docs in [docs/gui-log-viewer.en.md](gui-log-viewer.en.md).

This is a **bug-fix release** of the 0.1.1 line, delivering issue #33: the deep-link parser `parseDeepLink` threw
`URIError` on **malformed percent-encoding**, contradicting its own declared contract that "everything else returns
`null`". Decoding failures are now closed off as "unrecognised" and **are never rethrown**. **No new features, no new UI** —
but there **is one user-visible behaviour change**: a malformed deep link now produces an honest notice instead of failing
silently, and no longer disables deep-link handling for the whole session.

---

## Fixed in this release

### Deep-link parsing no longer throws `URIError` on malformed percent-encoding (issue #33)

**The problem**: `decodeURIComponent(segments[0])` at `mcp-gui/src/core/deeplink.ts:46` was a **bare call** with no
`try/catch`, while the function's own header states the contract: "**everything else returns `null`** (no guessing, no
loose matching)" — **the implementation contradicted its contract**. A deep link is **externally constructible input**
(the `tianshu://` protocol can be triggered by any web page or script), and a malformed escape such as
`tianshu://task/%zz` throws `URIError: URI malformed`.

**The root cause is not "a missing check" but a split convention**: the same function already contains three defences
aimed at external input (the `try/catch` around `new URL`, the outright rejection of `..` / `%2e`, the allowlist test) —
**only `decodeURIComponent` was treated as a pure function that cannot fail**. The same kind of decode in
`src/visual/services.ts:62-67` (HTTP request-path decoding) **is** wrapped in `try/catch` — one site guarded, one not.

**The fix** (minimal sufficient repair, one site only):

```diff
   const segments = parsed.pathname.split("/").filter((seg) => seg !== "");
   if (segments.length !== 1) return null;
-  const taskId = decodeURIComponent(segments[0] as string);
+  // `decodeURIComponent` throws `URIError` on **externally controlled** malformed escapes
+  // (`%zz`, `%`, `%80`, …), while this function's contract is "everything else returns null"
+  // (see the header). The enqueue side does no business judgement (`queue_deeplinks` in `lib.rs`
+  // only queues), so malformed input inevitably reaches here — it must be closed off in place:
+  // a failed decode means "unrecognised", surfaced honestly by the caller, never rethrown.
+  let taskId: string;
+  try {
+    taskId = decodeURIComponent(segments[0] as string);
+  } catch {
+    return null;
+  }
   if (!TASK_ID_RE.test(taskId)) return null;
```

**Why fix here rather than adding a defensive catch in `App.vue`**: the caller needs to know that "this link is
unrecognised" in order to surface a notice (`setError(t("deeplink.invalid", …))`). The error must become a **return
value**, not be intercepted from the outside — an outer catch would merely swallow malformed links silently.

---

## Input classes covered (both throw)

| Class | Examples | Why it throws |
|---|---|---|
| ① malformed escape sequences | `%zz`, `%`, `%z`, `%2`, `%%`, `%C3%28`, `%E0%A4%A` | not a valid `%XX` sequence |
| ② valid syntax but decoding to invalid UTF-8 | `%80`, `%FF`, `%ED%A0%80` | isolated continuation byte / illegal byte sequence |

**Covering only ① would have been insufficient**: the issue's example is `%zz` (class ①), but class ② throws just as
hard and is equally externally constructible. This release tests both.

| Input | Before | After |
|---|---|---|
| `tianshu://task/%zz` | **throws `URIError`** | `null` (honest notice) |
| `tianshu://task/%80` | **throws `URIError`** | `null` (honest notice) |
| `["…/%zz", "…/tsk_2"]` batch | **whole batch aborts** (`tsk_2` swallowed) | skips the malformed one, selects `tsk_2` |
| `tianshu://task/tsk%5F1` | `{taskId:"tsk_1"}` | **unchanged** |
| `tianshu://task/a%2Fb` | `null` | **unchanged** |
| `tianshu://task/tsk%5C1` | `null` | **unchanged** |
| `tianshu://task/tsk_1` | `{taskId:"tsk_1"}` | **unchanged** |
| `..` / `%2e` / empty / multi-segment | `null` | **unchanged** |

**Order invariant**: the `tsk%5F1` row is the discriminator — it requires **decode first, then check the allowlist**.
Moving the `try/catch` after the allowlist, or validating the raw string first, would turn this row from green to red.

---

## User-visible behaviour change (the most important item in this release)

Measured before the fix (reproduced locally, not inferred):

| Observation | Before | After |
|---|---|---|
| Is `subscribeDeepLinks(...)` at `App.vue:170` reachable? | **false** — never runs once `await drainDeepLinkQueue()` throws | true |
| `setError` call count | **0** — no notice at all | 1 (honest "unrecognised" notice) |
| Subsequent deep links in that session | **all dead** (the subscription was never established) | received normally |

In other words: with **one** malformed link mixed into the queue at cold start, the pre-fix build would lose deep-link
handling **for the entire session** with **no notice whatsoever**; after the fix that link is reported honestly and every
other deep link works. This is heavier than the issue's own wording ("one throw aborts the batch"), which this round's
measurements pinned down to "the subscription chain breaks".

---

## Tests and verification

- Frontend **172 passed** (15 files; baseline 169 + 3 new groups); `check:schema` (including `GUI version consistent
  (0.1.1-beta.5)`) / `typecheck` / `lint` all green.
- New cases: "does not throw + returns `null`" for 10 malformed inputs (both classes); a malformed link not blocking the
  rest of the batch; the decode-order invariant.
- **RED → GREEN as measured fact**: the new cases first went red (`URIError: URI malformed`, root-cause stack pointing at
  `deeplink.ts:46`), then green after the implementation change.
- **Rollback self-check**: reverting the fix to the bare call turns the 2 new cases **red again** (`2 failed | 6 passed`) —
  proof the tests have discriminating power.

---

## Scope notes

- **Footprint**: 1 source file (`src/core/deeplink.ts`, one `try/catch`) + 1 test file + 4 bilingual docs.
- **Zero Rust changes**: enqueue (`queue_deeplinks`) and dequeue (`take_pending_deeplinks`) in `lib.rs` **deliberately do
  no business judgement** — malformed URLs are queued either way and the frontend parser is where the contract lives
  (consistent with the §16.10 division of responsibility).
- **Same-family sites inventoried**: all 5 `decodeURIComponent` sites in the repo were classified — beyond this issue,
  `src/visual/services.ts:63` and `src/agents/zcode/model.ts:182` already have `try/catch`; `scripts/gitee-gui-release.mjs:325`
  and `mcp-gui/scripts/build-updater-manifest.mjs:188` are not driven by external input. `src/agents/kimicode/dom.ts:174`
  has no `try/catch`, but it runs inside a `page.evaluate` injection script whose exceptions are caught by the outer CDP
  call — **recorded as a known same-family observation, intentionally not changed here** (avoiding scope creep into the
  agent-adapter subsystem).

---

## Boundaries (what this release does not do)

- **No new features, no UI changes**: no new pages, sections or commands; zero new i18n keys; `src/api` signatures unchanged.
- **No Rust changes**: no `.rs` file touched.
- **No existing test weakened**: the 5 pre-existing deep-link cases are unchanged verbatim.

---

## Upgrade notes

- The update path shares the same `latest.json` / `latest-gitee.json` as `0.1.0` / `0.1.1-beta.1` … `0.1.1-beta.4`,
  compared by semantic version: `0.1.1-beta.5 > 0.1.1-beta.4`, so an upgrade from any earlier version works directly.
- This release fixes parser tolerance only; existing features (task list / four log views / search & export / update check /
  four insight sections / command palette / deep links) are **behaviourally unchanged** — only how malformed deep links are
  handled changes, from "fails silently" to "reported honestly".
