# Structured repair directives (issue #19)

Chinese version: [repair-directives.md](repair-directives.md)

## 1. Why this exists

When acceptance fails, the MCP generates a repair plan and feeds it back to the agent. But that
report is a **full narrative** — the agent has to locate by itself "which line has the type
mismatch, which file has a TODO, which file has an anomalous changed-line count". That raises its
reasoning cost and increases the chance that a misreading makes the rework fail.

Structured repair directives parse the failure reasons straight into **executable actions**:

```
- `src/foo.ts:42` — TS2322: Type 'string' is not assignable to type 'number'. → 修正该处类型错误（依据 TS2322 提示）
- `package-lock.json` — 锁文件被修改 → 确认依赖变更是有意的；若非有意请还原该锁文件
- （无具体文件） — 新增/变更行含 TODO/FIXME/HACK 共 3 处 → 实现或移除这些待办标记
```

Each directive is `{ file?, line?, issue, action, source }`: `issue` says **what** is wrong, `action`
says **what to do**.

## 2. Extractors: two built-in sources

Extraction happens inside the acceptance engine (`extractRepairDirectives()` in
`src/verify/directives.ts`) and **only on failed rounds** — a passing round has nothing to fix, so
extracting there would only bloat the report.

| Source | Input | Output |
|---|---|---|
| `typecheck` | The `outputTail` of failed checks whose name/argv matches `typecheck\|tsc\|--noEmit\|mypy\|pyright` | One directive per `file(line,col): error TSxxxx` / `file:line:col - error TSxxxx` line (absolute paths normalized to project-relative POSIX; duplicates collapsed) |
| `diffstat` | The report's `analysis` section | One directive each for oversized single-file changes (>500 lines) and modified lockfiles (`package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` / `Cargo.lock` / `go.sum` / `Pipfile.lock` / `poetry.lock` / `composer.lock`); plus one each for line-level signal counts (TODO/FIXME, console.log/debugger, secret-like patterns) |

> **Why there is no "test checker" source**: test-failure command output has no stable file/line
> (every framework formats differently). Parsing it anyway would produce **wrong** locations, which
> is worse than producing none. Those failures always take the fallback path (below).
>
> The `diffstat` line-level signals (TODO / debug output / secret-like) are **counts only** with no
> stable file or line, so their directives deliberately **omit** `file` — locations are never faked.

## 3. Fallback: when extraction fails, fall back to the full report

**This is the robustness floor of the capability**: the extractors never throw, and failure is
expressed as data in `fallbackReason`:

```jsonc
// report-<round>.json
"repairDirectives": {
  "items": [],
  "sources": [],
  "fallbackReason": "本轮失败原因无法解析为可直接执行的指令（如测试类失败无稳定的文件/行号）"
}
```

Renderers (the repair plan and the rework message) therefore **state the unavailability
explicitly** instead of silently leaving a gap:

```markdown
## 2.5 结构化修复指令（不可用，回退完整报告）

原因：本轮失败原因无法解析为可直接执行的指令（如测试类失败无稳定的文件/行号）

> 请**阅读第 2 节的完整失败输出**自行定位问题，不要依赖本节的省略形式。
```

If a single source throws, the error is swallowed and recorded in `fallbackReason` while the
**other sources keep working** — one broken extractor must not strip the rework of all context.

## 4. Three consumption paths

| Carrier | Content |
|---|---|
| `report-<round>.json` | The full `repairDirectives` field (persisted: needed across server restarts and by the manual-rework path, which re-reads this file) |
| `report-<round>.md` | A `## 结构化修复指令` section (each item annotated with its source) |
| Repair plan doc (`rework-<id>-r<n>.md` / Codex's `codex-fix-r<n>.md`) | A `## 2.5 结构化修复指令` section, inserted between section 2 (failures) and section 3 (passing checks) |
| Rework message (the body sent to the agent) | A `【结构化修复指令（摘要，最多 10 条）】` block; when extraction fails it is **not** added here (the plan doc's section 2.5 already states it honestly) |

## 5. `rework_task`'s `repairHint`

Besides the engine's automatic extraction, the caller can supply its own hint:

```jsonc
rework_task(taskId, feedback="请按提示修复后重跑验收。",
            repairHint="src/done.txt:1 — 内容应为 PASS 而非 TODO → 把该行改为 PASS")
```

- A free-form string, **max 4000 characters** (rejected at the protocol layer beyond that).
- Rendered in the next round's task book as a `【结构化修复提示】` block, placed **before**
  `feedback` — precise locations first, the longer explanation after.
- When omitted, behaviour is exactly as in previous versions.

## 6. Known limitations (disclosed honestly)

- **`outputTail` truncation**: a check's output tail is truncated to the last **4000 characters**
  (`src/verify/runner.ts`). A large TypeScript project's total error count can far exceed that, so
  **only the tail errors are extractable**; what cannot be extracted does not appear out of nowhere —
  go back to the full report. This limitation is accepted deliberately: rather than inflating report
  size to extract more, the fallback path carries the burden.
- **Path normalization**: paths relative to the project root are kept as-is; an absolute path inside
  the project becomes relative, while one outside the project is **kept as-is** (no unverifiable
  trimming).
- **Directives are a to-do list, not proof of a fix**: they describe what to do; whether it is
  actually fixed is still decided by the next acceptance round.
