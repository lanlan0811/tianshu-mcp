# Visual acceptance (in development, targeting v0.5.0)

[中文](visual-acceptance.md)

Visual acceptance extends `run_task`, `verify_task`, `get_task_report`, `query_task`, and `rework_task` with objective screenshot comparisons and static image specifications. It does not perform AI content or style evaluation. The website directory is outside this feature's scope.

## Runtime and installation

Existing features retain Node.js >=20; visual execution requires >=20.3. Browser and image dependencies load on demand. Neither npm installation nor MCP startup downloads a browser.

```sh
tianshu-mcp visual browser install
tianshu-mcp visual doctor /path/to/project
tianshu-mcp visual init /path/to/project
```

Pinned dependencies: puppeteer-core 24.43.1, @puppeteer/browsers 2.13.2, sharp 0.34.5, pixelmatch 7.2.0. The installer reads Puppeteer's browser revision mapping. Browsers live under the MCP data directory's `browsers` folder. Restore missing optional image dependencies with `npm install --include=optional`; their absence does not prevent existing MCP features from starting.

Minimum browser launch and screenshot verified locally on Windows 10 Pro 10.0.19045 x64, Node 24.18.0, Chrome 148.0.7778.97, on 2026-09-14. Actual visual evidence for macOS 13+ Intel/Apple Silicon and other Node versions is pending. This is not a completed compatibility claim. See [validation progress](visual-validation.en.md).

## Configuration

Edit `.tianshu-mcp/acceptance.json`. `init` merges a disabled template, preserves existing configuration, and refuses to overwrite an existing visual section. Absent files retain default command inference; invalid/unreadable configuration blocks acceptance. Omitted `checks` still infer commands; explicitly empty `checks: []` disable configured commands. `extraChecks` and `checksMode=replace` never disable visual gates. `requireChanges` defaults to true; artifact-only checks may explicitly set false.

```json
{
  "checks": [], "requireChanges": false,
  "visual": {
    "enabled": true, "browser": { "mode": "managed" },
    "viewports": [{ "id": "desktop", "width": 1280, "height": 720, "deviceScaleFactor": 1 }],
    "pages": [{ "id": "home", "source": { "type": "static", "root": "public" },
      "route": "/index.html", "readySelector": "main", "maskSelectors": ["[data-visual-dynamic]"], "steps": [] }],
    "images": [{ "id": "cover", "files": ["output/cover.png"], "formats": ["png"],
      "width": { "exact": 1200 }, "height": { "exact": 630 }, "fileSizeBytes": { "max": 2097152 } }]
  }
}
```

Unknown visual fields, duplicate IDs, empty enabled rules, and conflicting options are rejected. Checks are required unless `optional: true`; configuration, mask integrity, and baseline integrity errors still block.

| Field | Options/defaults |
|---|---|
| browser | managed; chrome/edge with optional executablePath; executable requires executablePath |
| baselineRoot | Project-relative `tests/visual/baselines` |
| viewports | Stable id, width, height, deviceScaleFactor; default desktop 1280×720 and mobile 390×844, DPR 1 |
| defaults | capture=viewport, pixelThreshold=0.1, maxDiffRatio=0.001, locale=en-US, timezone=UTC, colorScheme=light; element requires selector |
| limits | concurrency=1 (1–4), serviceTimeoutMs=60000, navigationTimeoutMs=30000, itemTimeoutMs=60000, roundTimeoutMs=300000 |
| Capacity limits | stabilitySamples=3 (2–3), inputBytes=20971520, decodedPixels=32000000, artifactBytes=524288000 |
| allowedOrigins | Exact HTTP/HTTPS/WS/WSS origins, no path; empty by default |

Three mutually exclusive page sources:

```json
{ "type": "existing", "url": "http://127.0.0.1:4173" }
```
```json
{ "type": "command", "command": "npm", "args": ["run", "preview", "--", "--port", "4173"], "cwd": ".", "env": { "TEST_TOKEN": "VISUAL_TEST_TOKEN" }, "readyUrl": "http://127.0.0.1:4173" }
```
```json
{ "type": "static", "root": "public" }
```

Ports and commands above are examples supplied by each project. Command services require an explicit unoccupied port. Environment values reference environment variable names, not secret literals. Static services default to ephemeral ports and deny directory listings, traversal, and escaping symlinks. Existing services are not terminated. Identical definitions share one managed service per round; browsers use isolated temporary profiles.

Page options include viewports (IDs), capture (viewport/fullPage/element), selector, pixelThreshold, maxDiffRatio, storageState, and baseline (explicit shared reference path). Default baselines are partitioned as `<baselineRoot>/<platform>/<browserKind>/<caseId>/<viewportId>.png`.

Steps support click/input/hover with selector (input also requires value), scroll with selector or x/y, and wait with exactly one of selector/url/durationMs. Selector waits optionally specify visible/hidden state. Arbitrary JavaScript preparation scripts are forbidden. Full-page capture scrolls within limits for lazy loading. Font/image readiness, disabled animation, explicit masks, and two adjacent identical captures determine stability. Missing masks, fully masked screenshots, unstable pages, and blocked resources cannot pass.

storageState is project-relative JSON: `cookies: [{name,value,domain,path,expires,httpOnly,secure,sameSite}]`, `origins: [{origin,localStorage:[{name,value}]}]`. Only import test account state. Reports omit Cookie/localStorage contents.

Image files must be listed explicitly. Only static PNG/JPEG/WebP are accepted, with matching extensions and complete decoding. width, height, aspectRatio, fileSizeBytes, and dpi accept exact or min/max. transparency is transparent (actual transparent pixels) or opaque. Missing DPI is unknown and fails a configured DPI requirement. Dimensions are checked after orientation normalization. Missing/corrupt/noncompliant images are repairable; permission/dependency/resource failures block.

Pixel threshold is passed to pixelmatch. Difference ratio is differing pixels divided by unmasked pixels and passes at `<= maxDiffRatio`. Recognized antialiasing is excluded. Dimension mismatches fail without scaling. Artifacts include differences, annotated regions, the 100 largest connected regions, and overall bounds.

## Baselines and approval

Preparation request JSON:

```json
{ "projectPath": "/path/to/project", "caseIds": ["home"], "viewportIds": ["desktop"] }
```

Optional `imports: [{caseId,viewportId,file}]` imports project-local PNG/JPEG/WebP references. Candidates stay in MCP storage and return candidateId, digest, and preview. Inspect previews before explicitly approving:

```sh
tianshu-mcp visual baseline prepare prepare-request.json
tianshu-mcp visual baseline approve approve-request.json
```

Approval JSON: `{candidateId,expectedDigest,approvalNote,taskId?}`. An optional taskId must reference a needs_attention task in the same project. Changed digests, baselines, rules, or project identity reject adoption. Git-ignored targets are rejected without forced staging or ignore edits. MCP `prepare_visual_baseline`/`approve_visual_baseline` use the same request structures. Both have side effects and require actual host authorization controls. Automatic repair must never approve baselines.

Rules and baseline digests are frozen before agent execution and checked around verification. Rule changes require a separate review:

```sh
tianshu-mcp visual rules review TASK_ID
tianshu-mcp visual rules approve TASK_ID REVIEW_ID DIGEST "Explicit user approval note"
```

Baseline/environment blockers enter needs_attention with a pending verification marker. After resolution, rework_task verifies first: pass ends the task, continued blocking waits, and only real defects trigger agent repair.

## Reports and retention

Artifacts live at `<home>/tasks/<taskId>/visual/<reportRound>`. Automatic/manual verification allocate exclusive report rounds and preserve history. Markdown/JSON expose an independent visual section. Offline HTML supports status filters, side-by-side images, opacity overlays, metrics, and region coordinates without CDNs.

```sh
tianshu-mcp visual artifacts clean TASK_ID
tianshu-mcp visual artifacts clean TASK_ID --apply
```

Default behavior previews only. Applying deletes that task's visual directory, retains reports and cleanup markers, and never deletes official baselines. Budget exhaustion blocks instead of removing historical evidence. CLI dispatch occurs before MCP stdio connection.

## Troubleshooting

| Symptom | Action |
|---|---|
| Clock text, random copy, or carousels differ every round | Mask the dynamic region explicitly with `maskSelectors`; do not raise the threshold to hide a real regression. An unmatchable or all-encompassing mask blocks |
| Full-page size changes every round (lazy loading, infinite scroll) | A continuously expanding page blocks; fix readiness or stabilize content instead of relaxing `maxDiffRatio` |
| External fonts/images/APIs are blocked | Allow the exact origins in `allowedOrigins`, then re-verify; a partial page never passes |
| Baselines mismatch across systems or machines | Baselines are partitioned by `<platform>/<browserKind>` by default; prepare and approve candidates for the new environment rather than sharing another machine's baseline |
| Global shift after a browser upgrade | The baseline manifest records the full browser version; re-prepare candidates and go through approval after upgrading |
| How thresholds are interpreted | `pixelThreshold` is pixelmatch's colour tolerance and `maxDiffRatio` is the allowed difference ratio; recognized antialiasing is excluded by default |
| Blocked because a baseline is missing | A missing baseline can only produce a candidate that a user must review and approve; automatic repair never approves |
| A visually blocked needs_attention task | Resolve the environment or approval first, then `rework_task`; the system re-verifies first and only starts the agent for real defects |
