# v0.9.4 — Codex Send-Confirmation Fix Release

> **Fixes "instruction delivered but reported as unconfirmable"**: on 26.1002 the send
> confirmation check `seenMessage` was **permanently false**, reporting `send_unknown`. What
> users saw was "text typed but send not triggered" — **while the message had in fact already
> been delivered**. The root cause is that conversation-text collection **dropped bare text
> nodes**, losing the middle segments of the `【tianshu:…】` marker.

**No breaking changes; the tool surface is unchanged (still 8 tools) — upgrade requires no caller changes.**

---

## Background

v0.9.3 fixed a **false positive** (reading text it should not have read). This release fixes
its mirror image: **failing to read text it should have read** — a true positive misjudged as
a negative.

Both are mistakes of the same collection function, in opposite directions:

| Release | Defect | Direction |
|---|---|---|
| Before v0.9.3 | `messageArea` wrapped the composer → text still in the input box counted as "delivered" | **false positive** |
| Before v0.9.4 | leaf traversal dropped `#text` → the marker in the conversation read back mutilated | **false negative** |

---

## Root cause

Codex renders message bodies as **fragmented** DOM — the marker is split across multiple
nodes, with element and bare text nodes **interleaved** (measured on a real device):

```
SPAN     "【tianshu"
#text    ":tsk_20261009083825_4d992a"
#text    ":r0"
#text    ":initial"
SPAN     "】在当前项目创建 docs/verify-fix.md…"
```

The node-level traversal introduced in v0.9.3 was:

```js
for(const c of n.children){hasElementChild=true;walk(c)}   // walks only children (elements)
if(!hasElementChild){
  const t=(n.textContent||'').trim();                       // drops own text if it has element children
  if(t)parts.push(t);
}
```

It walked **only element nodes**, and discarded a node's own text whenever it had element
children — so the four `#text` nodes were **dropped wholesale**, and the joined result
degraded to:

```
【tianshu】在当前项目创建 docs/verify-fix.md…
```

**Every middle segment — `:tsk_20261009083825_4d992a:r0:initial` — was lost.**

The send-confirmation check in `run.ts` is `conversationText.includes(marker)` — with the
marker read mutilated, `seenMessage` was permanently false, all three signals were false, and
the adapter reported `send_unknown`.

**Real-device counter-proof** (same task, before vs after the collection fix):

| | `conversationText` | contains full marker |
|---|---|---|
| Before fix | 289 chars, reads `【tianshu】…` | **false** |
| After fix | 291 chars, reads `【tianshu:tsk_…:r0:initial】…` | **true** |

Separate evidence proves the message **had indeed been delivered**: `composerText` 165 → 0
(text left the input box), the stop button appeared (run signal), and the artifact
`docs/verify-fix.md` was written to disk.

---

## Fix

Traversal changed from `children` to `childNodes` (including `#text`), joined in document
order; composer component nodes are still skipped whole:

```js
const walk=(n)=>{
  if(n.nodeType===3){                       // bare text node: collect directly
    const t=(n.nodeValue||'').trim();
    if(t)parts.push(t);
    return;
  }
  if(n.nodeType!==1)return;
  if(isComposerComponent(n))return;         // composer components still skipped whole
  for(const c of n.childNodes)walk(c);      // the key change: childNodes, not children
};
```

---

## Verification

**Regression lock** (1 new case, replicating the real-device `SPAN`/`#text` interleaving):

```
AssertionError: expected '【tianshu】在当前项目创建 docs/verify-fix.md'
  to contain 'tianshu:tsk_20261009083825_4d992a:r0:initial'
```

— the failure message matches the real-device symptom **verbatim**, i.e. the RED case
reproduces the original defect.

**Counter-proof loop**: reverting the `src` fix (keeping the test) reads back `【tianshu】…`
and turns red; restoring it turns green.

**Real-device end-to-end** (`tsk_20261009102459_0e6869`):

```
[codex] instruction confirmed sent (conversation=true, input cleared=true, run signal=false)
task tsk_20261009102459_0e6869 finished: succeeded
```

| Signal | Result |
|---|---|
| `seenMessage` (permanently false before) | **true** |
| Conversation hash | varies round by round: `b86128cc` → `a5fddf7f` → `1c6bb700` → `108a8d3d` → `4cfcc9ca` |
| Stable rounds → terminal state | `reply_stable` after 4 rounds |
| Artifact | `docs/send-fix-verify.md` (111 B, "# 发送验证" + body) written to disk |

**Gates**: typecheck pass / eslint pass / full suite `1688 passed` (the 2 failures are
pre-existing local-environment issues, proven by baseline experiment to fail on an
already-green commit too).

---

## Known issues

1. **Model picker may include group headings**: on newer builds the group heading (e.g.
   "Default/Recommended models") shares `role="menuitemradio"` with real model items and may
   leak into model candidates (real items carry `data-state`; headings do not).
2. **`messageArea` may match a hidden shell**: a real device shows two `MainContentSurface`
   elements, the first a 0×0 hidden shell (its `vis()` check is size-based, so no
   mis-selection was observed — but a defensive check would be worthwhile).

---

## Upgrade

```bash
npm i -g tianshu-mcp@0.9.4
```

Or configure your MCP client with `npx -y tianshu-mcp@0.9.4`.

**No caller changes required** — the tool surface and argument contracts are unchanged.
