# v0.9.7 — Open Design on-device fix release

> **Wired up the artifact export path that previously had zero callers + fixed 4 adapter defects
> found over three rounds of real-machine smoke testing**:
> ① home-entry drift causing `selector_drift` hard failures;
> ② failure-state predicate never wired across three layers, so the adapter waited out the deadline
> (10+ minutes) on a failed screen;
> ③ working-directory readback false failure (`title` shape predicate + the product flushing its
> config 8.2 seconds late);
> ④ artifact export was never wired at all (`exportArtifact` had zero callers) — this release
> connects it and verifies both zip and HTML on a real machine.

**No breaking changes; tool surface unchanged (still 8 tools); no caller changes needed.**
New **optional** parameter `exportKind` (`html` / `zip`): after a task finishes successfully,
the artifact is exported to `projectPath` automatically.

---

## Background

Real-machine smoke testing against Open Design (**0.24.1**) with model
`cline-pass/deepseek-v4.1-flash`, workspace `D:\Trae项目\AI游戏\Minecraft`.
Three rounds of testing surfaced the four defects below; item ④ is the headline deliverable —
it had **never been connected**.

---

## Added ④: artifact export path (previously `exportArtifact` had zero callers)

`export.ts` already contained the full export logic (pick the menu item + drive the native save
dialog) plus unit tests, but **`run.ts` never called it** and the schema had no `exportKind` field —
a textbook "predicate complete, wiring missing" gap. Same family as defect ②:
**testing only the pure predicates cannot catch a wiring gap**.

### Key finding: overturns the original implementation's core assumption

The original code drove a **native save dialog** (fill the address bar + click save).
What actually happens on a real machine:

```
Click "导出为独立 HTML" (Export as standalone HTML)
  → a childless #32770 shell window appears (title blob:od://app/<uuid>, zero child controls)
  → the download stalls at ~/Downloads/<uuid>.tmp (constant at 24279 bytes)
```

So 0.24.1 exports via a **browser-style download** (blob → Electron `will-download`);
that window is the download host window, **not** a save dialog drivable via Win32/UIA.
The old route could therefore never observe an artifact.

### Correct approach (reproduced successfully on a real machine)

```
1. CDP: Page.setDownloadBehavior({ behavior:'allow', downloadPath: <project root> })
2. Click the toolbar "导出" button (aria-label=导出)
3. Click the menu item "导出为独立 HTML" / "下载为 .zip"
4. The file lands directly in the project root — no dialog interaction at all
```

`saveViaNativeDialog` is demoted to an **optional fallback** (one short-budget attempt; on failure
it does not return — the flow continues to "wait for the artifact to land", the only real success
criterion). This matters: on the actual happy path no dialog appears at all, so treating it as
mandatory would block the most common success path.

### Wiring scope

- `cdp.ts`: new `setDownloadDir` (sends both `Page.` and `Browser.` protocol variants; idempotent)
- `export.ts`: makes it a required step **before** clicking the menu item (the download starts the
  moment you click, so setting it afterwards is too late)
- `run.ts`: calls `exportArtifact` on the `finished` terminal state (an export failure **does not**
  change the terminal state — it is only written into the summary)
- `exportKind` threaded through five layers: schema → adapter → task → context → handlers

---

## Fixed ①: home-entry drift → `selector_drift` hard failure

**Symptom**: the task hard-failed during the connect stage with `endReason=selector_drift`,
even though the page was perfectly healthy.

**Root cause**: the home page `od://app/` and the conversation page `.../files/` are
**two mutually exclusive layouts** —

| Page | `home-hero` | `workspace-home-chrome` | `working-dir-trigger` |
|---|---|---|---|
| Home `od://app/` | 1 | **0** | 1 |
| Conversation `.../files/` | **0** | 1 | **0** |

`run.ts` runs `ensureHomePage()` first, then the layout guard.
`OPEN_DESIGN_HOME_ENTRY_SELECTOR` only had `entry-view-home` / `entry-nav-home` —
both of which **exist only on the home page**. On the conversation page it clicked air →
could not return home → the guard ran on the **conversation page** → `title` count was always 0 →
hard failure.

**Fix**: add `workspace-home-chrome` (the only entry on the conversation page that returns home —
measured aria=`主页`, and clicking it changes the URL to `od://app/`). Also pinned down `title`'s
**"home-only" semantics**: it is used by `ensureHomePage` to decide "are we already home", so mixing
in keys that also exist on the conversation page makes the adapter think it is home and every
home-only control then matches 0.

---

## Fixed ②: failure state not wired → waited out the deadline on a failed screen

**Symptom**: the UI already showed "运行失败 / AI 未能生成内容，请重新发起任务", yet the adapter kept
logging `running；运行证据=send_starting；稳定轮=0` and **waited 10+ minutes** until the deadline.

**Root cause**: `liveness.ts`'s `errorText → kind:"failed"` predicate was **already in place**
(unit-tested), but the collection chain was never wired across three layers:

| Layer | Status |
|---|---|
| `liveness.ts` type `errorText` | present |
| `liveness.ts` `evidenceOf` → `error_text` | present |
| `liveness.ts` verdict → `kind="failed"` | present (and unit-tested) |
| `cdp.ts` `OpenDesignPollSnapshot` | **missing** |
| `cdp.ts` `pollExpression` collection | **missing** |
| `run.ts` poll assembly | **missing** |

**Fix**: completed all three layers + synced the `fake-cdp` stub (a stub missing the field means the
real-machine `failed` verdict is never reachable in tests). Real-machine evidence used the product's
own hooks: `chat-run-error-card` / `chat-run-error-description`.

---

## Fixed ③: working-directory readback false failure (`title` shape predicate)

**Symptom**: `reason=readback; the native dialog confirmed, but the working directory read back as
"工作目录", which does not match the target` — even though the binding had **actually succeeded**
(`app-config.json`'s `recentLinkedDirs` already contained the target, first in the list).

**Root cause (two layers)**:

1. The `working-dir-trigger` `title` attribute **changes meaning with state**:
   - empty state: `title` is a tooltip — "Let the Agent read this local directory (it will not be
     imported into Design Files)";
   - bound state: `title` holds the **full path**, while `innerText` only shows the last segment.

   The old predicate read `innerText` only, so it had to fall back to the `recentLinkedDirs` sidecar.

2. That file is written **asynchronously** — measured on a real machine:

   | Event | Time |
   |---|---|
   | Native dialog completed | 08:30:30.6 |
   | Readback attempts 1–3 (budget 4×700ms) | 08:30:31.3 – 32.7 |
   | Verdict `readback` failure | 08:30:33.1 |
   | **`app-config.json` actually flushed** | **08:30:38.8 (8.2s late)** |

   The sidecar was always stale → a **successful binding was reported as a failure**.

**Fix**: trust `title` only when it **looks like a path** (drive letter / forward slash / UNC),
falling back to `innerText` otherwise. The full path now self-justifies and no longer depends on
flush timing.

---

## Verification

| Item | Result |
|---|---|
| typecheck | exit 0 |
| Whole opendesign family | 9 files, **129 passed** |
| All 8 `fake-cdp` consumers | **115 passed** |
| lint | exit 0 |
| **Counter-proofs** for the three fixes | rolling each back turns the corresponding case red (proves the tests discriminate) |
| Export path **real-machine end-to-end** | zip / html, two rounds each, all green |

Export verification (through the **real implementation**, not a hand-rolled probe):

**zip** →
```
Download directory pointed at: D:\Trae项目\AI游戏\Minecraft
No native save dialog appeared — treating as browser-style download, waiting for the artifact
Artifact landed: ...\Website-Clone.zip
Extracted Website-Clone.zip, entry minecraft-promo.html
→ {"ok": true, "artifact": "Website-Clone.zip", "entry": "minecraft-promo.html"}
```
Artifact checks: magic `504b0304`, `testzip()` clean, 3 entries
(`minecraft-promo.html` 178065B + `DESIGN-HANDOFF.md` 6980B + `DESIGN-MANIFEST.json` 5081B).

**html** →
```
Artifact landed: ...\minecraft-promo.html
→ {"ok": true, "artifact": "minecraft-promo.html"}
```

---

## Upgrade notes

No breaking changes. To enable automatic export, add the optional parameter to `run_task`:

```
run_task --agent opendesign --project-path <dir> --export-kind zip|html
```

Without `exportKind`, behavior is identical to 0.9.6 (no automatic export).
