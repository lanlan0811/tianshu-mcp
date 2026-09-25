# issue #19 / #20 / #21 / #22 真机记录

> 记录时间：2026-09-25 · 机器：Windows 10 Pro 19045 · Codex `26.917.9434.0`
> （`OpenAI.Codex_26.917.9434.0_x64__2p2nqsd0c76g0`，AUMID `OpenAI.Codex_2p2nqsd0c76g0!App`）
> 被测版本：`master`（v0.6.7）本地 `npm run build` 产物 `dist/`。
> 驱动方式：真实 MCP server（`buildServer`）+ 内存 transport；#19/#21 用**真实 Codex 桌面端 GUI**
> （MSIX COM 激活 + CDP，非假 CDP），#20/#22 用真实子进程（CLI / 本机 `node:http` 端点）+ stub agent。
> 数据目录与项目均为一次性 scratch（`%TEMP%\tianshu-rm*`），**不触碰任何真实工程**。
> 本文件沿用既有 `docs/issue-*-record.md` 的体例（记录类文档中文单语）。
> 真机取证脚本位于 `.claude/plans/rm19.mjs` / `rm20.mjs` / `rm21.mjs` / `rm22.mjs`（`.claude/` 受 `.gitignore` 忽略，故意不入库），
> 各节均给出可直接复跑的参数要点。

---

## 1. #19 结构化修复指令 —— ✅ 已取得真机记录（前后对比）

**任务**：`tsk_20260925143313_2fc503`，agent=codex，`autoVerify=true`，`autoFixRounds=1`，终态 `succeeded`。

**复现要点**（一次性 scratch 项目）

- `src/app.ts` 含**两处真实类型不一致**：第 13 行 `retries: "three"`（接口声明为 `number`）、
  第 17 行 `makeConfig()` 少传实参。
- `.tianshu-mcp/acceptance.json` 注册一条 `name: "typecheck"` 的检查（命中提取器的 `typecheck` 启发式）；
  该检查**真的读 `src/app.ts`**，按文件真实内容定位行列并输出 **tsc 格式**报错后 `exit 1`
  （不是写死的报错文本）。
- 第 0 轮任务书要求 agent 只新建 `notes.md`、**不得修改 `src/`**（制造一个必然失败的真实验收）。

### 1.1 前后对比

| | 第 0 轮（返修前） | 第 1 轮（返修后） |
|---|---|---|
| 结论 | `[FAIL]`（`typecheck` 失败） | `[PASS]` |
| `typecheck` 输出 | 两条 tsc 格式报错 | 通过 |
| `repairDirectives` | 2 条（文件 / 行 / 问题 / 动作 / 来源） | 通过轮次不产出该字段 |
| agent 改动 | 仅新建 `notes.md`（遵守「不动 src/」） | 修好 `src/app.ts` 两处（`+2 -2`） |

服务端日志时间线（节选）：

```
06:36:41.814 任务 tsk_20260925143313_2fc503 第 0 轮验收: 失败（2 项检查）
06:36:41.849 [codex] 已生成修复计划：.zcode/plans/codex-fix-r1.md
06:36:41.852 [codex] 第 1 轮返修指令已引用修复计划 .zcode/plans/codex-fix-r1.md
06:37:28.807 任务 tsk_20260925143313_2fc503 第 1 轮验收: 通过（2 项检查）
06:37:28.824 任务 tsk_20260925143313_2fc503 结束: succeeded
```

### 1.2 第 0 轮的检查输出与结构化指令

检查输出尾部（真实 tsc 格式）：

```
src/app.ts(13,3): error TS2322: Type 'string' is not assignable to type 'number'.
src/app.ts(17,10): error TS2554: Expected 1 arguments, but got 0.
```

`report-0.json` 的 `repairDirectives`（原样摘录）：

```json
{
  "items": [
    { "file": "src/app.ts", "line": 13,
      "issue": "TS2322: Type 'string' is not assignable to type 'number'.",
      "action": "修正该处类型错误（依据 TS2322 提示）", "source": "typecheck" },
    { "file": "src/app.ts", "line": 17,
      "issue": "TS2554: Expected 1 arguments, but got 0.",
      "action": "修正该处类型错误（依据 TS2554 提示）", "source": "typecheck" }
  ],
  "sources": ["typecheck"]
}
```

**提取出的 `文件:行` 与两处真实缺陷完全对得上（13 / 17），没有错位。**

`report-0.md` 的对应段落：

```markdown
## 结构化修复指令

- `src/app.ts:13` — TS2322: Type 'string' is not assignable to type 'number'. → 修正该处类型错误（依据 TS2322 提示）（来源 typecheck）
- `src/app.ts:17` — TS2554: Expected 1 arguments, but got 0. → 修正该处类型错误（依据 TS2554 提示）（来源 typecheck）
```

### 1.3 返修计划里的 2.5 节（自动返修真正引用的指令）

`.zcode/plans/codex-fix-r1.md`（codex 分支的返修计划，被作为第 1 轮返修指令引用）节选：

```markdown
## 2.5 结构化修复指令（可直接执行）

- `src/app.ts:13` — TS2322: Type 'string' is not assignable to type 'number'. → **修正该处类型错误（依据 TS2322 提示）**
- `src/app.ts:17` — TS2554: Expected 1 arguments, but got 0. → **修正该处类型错误（依据 TS2554 提示）**

## 3. 通过的项（勿破坏）
- [PASS] git-diff-check
```

### 1.4 第 1 轮验收通过后项目里的实际状态

```ts
export const defaults: JobConfig = {
  name: "nightly",
  retries: 3,                    // 13 行：原来是 "three"（字符串）
};
export function makeDefault(): JobConfig {
  return makeConfig("nightly");  // 17 行：原来是 makeConfig()（少传实参）
}
```

即 agent 依据 2.5 节的定位**精确修掉了这两处**，返修闭环成立。

### 1.5 判定

| 验收标准 | 结果 |
|---|---|
| 失败轮次给出结构化修复指令（文件/行/问题/动作） | ✅ 1.2 / 1.3 |
| 指令定位与真实缺陷一致 | ✅ 13 / 17 两处均命中 |
| 提取不到时显式回退、不静默留空 | 单测/集成测试覆盖（`fallbackReason`） |
| `rework_task` 的 `repairHint` 贯通 | 集成测试覆盖 |
| **至少一份前后对比的真机返修记录** | ✅ 本节 |
| 已知限制照旧（`outputTail` 末 4000 字符截断） | ✅ 未放大报告体积，提取不到即回退 |

### 1.6 顺带如实记录的一处小瑕疵（非阻断）

`reportToMd()` 对 `## 结构化修复指令` 段是**无条件渲染**的：通过轮次没有 `repairDirectives`，
于是第 1 轮报告里出现了

```
## 结构化修复指令

（不可用，请改看上方各检查项的输出尾部）原因：本轮报告未生成结构化指令
```

在**通过**的报告里这句「不可用…请改看上方失败输出」是多余的（通过轮次本就没有要修的东西）。
不影响判定，也不影响失败轮次的指令质量；如需要可后续把该段改成仅在失败轮次渲染。

---

## 2. #20 三级验收配置继承 —— ✅ 已取得真机记录

**复现要点**

- 数据目录（`TIANSHU_MCP_HOME`）：`%TEMP%\tianshu-rm20-*\home`
- **全局层** `<home>/acceptance.default.json`：`{ "requireChanges": false, "verifyConcurrency": 3, "checks": [{ "name": "global-check", "cmd": ["node","-e","process.exit(0)"] }] }`
- **项目层** `<proj>/.tianshu-mcp/acceptance.json`：`{ "verifyConcurrency": 1 }` —— **刻意只写一个字段、不写 `requireChanges`**（这正是本 issue 要修的 `.default()` 污染隐患的触发形态）
- 项目为 git 仓库（含基线 commit），验收检查因 `requireChanges: false` 不触发「零改动」门禁

### 2.1 真实 CLI 子进程（三层理解析）

命令（真实子进程，非进程内调用）：

```
TIANSHU_MCP_HOME=<home> node dist/index.js config acceptance <proj>
```

原样输出（节选）：

```json
{
  "ok": true,
  "layers": [
    { "source": "global",  "present": true, "config": { "checks": [ { "name": "global-check", "cmd": ["node","-e","process.exit(0)"] } ], "requireChanges": false, "verifyConcurrency": 3 } },
    { "source": "project", "present": true, "config": { "verifyConcurrency": 1 } },
    { "source": "override", "present": false }
  ],
  "appliedOrder": ["global", "project"],
  "effective": { "checks": 1, "requireChanges": false, "verifyConcurrency": 1, "visual": "（未配置）" },
  "summary": "生效层=global>project checks=1 requireChanges=false verifyConcurrency=1 visual=（未配置）"
}
```

**关键点**：项目层只写了 `verifyConcurrency`，`effective.requireChanges` 仍为 **`false`**（取自全局层）——
即项目层**没有**因为 `AcceptanceConfigSchema` 的 `.default(true)` 而 materialize 出 `requireChanges: true`
反过来覆盖全局层的 `false`。这就是 v0.6.5 新增 `PartialAcceptanceConfigSchema`（无任何默认值）所要防的隐患，
在本机真实 CLI 上逐字段可见。

### 2.2 真实任务：引擎侧摘要行（`resolveChecks()` 真实路径）

```
[INFO] 验收配置层 task=tsk_20260925142321_5d60d4 生效层=global>project checks=1 requireChanges=false verifyConcurrency=1 visual=（未配置）
[INFO] 任务 tsk_20260925142321_5d60d4 第 0 轮验收: 通过（2 项检查）
[INFO] 任务 tsk_20260925142321_5d60d4 结束: succeeded
```

`report-0.json` 的检查项：`["git-diff-check","global-check"]` —— 基础检查集取自**全局层**（项目层未声明 `checks`），
内建 `git-diff-check` 与历史行为一致。

### 2.3 任务级 `acceptanceOverride` 只影响当次任务

```
[INFO] 验收配置层 task=tsk_20260925142325_d51a4a 生效层=global>project>override checks=1 requireChanges=false verifyConcurrency=1 visual=（未配置）
```

`report-0.json` 检查项：`["git-diff-check","override-check"]`（`checks` 整体被覆盖，`global-check` 不再出现）。

**CLI 能读出该层**（`--task` 从真实任务快照读 `TaskMeta.acceptanceOverride`）：

```
TIANSHU_MCP_HOME=<home> node dist/index.js config acceptance <proj> --task tsk_20260925142325_d51a4a
```

```json
{
  "layers": [
    { "source": "global",   "present": true },
    { "source": "project",  "present": true, "config": { "verifyConcurrency": 1 } },
    { "source": "override", "present": true,
      "path": "<home>\\tasks\\tsk_20260925142325_d51a4a\\task.json（TaskMeta.acceptanceOverride）",
      "config": { "checks": [ { "name": "override-check", "cmd": ["node","-e","process.exit(0)"] } ], "requireChanges": false } }
  ],
  "appliedOrder": ["global", "project", "override"]
}
```

**兄弟任务不受影响**：同项目、不带覆盖再跑一次 → `生效层=global>project`（回落到项目/全局配置，override 层消失）。

### 2.4 全局层写坏 → fail-closed

把 `<home>/acceptance.default.json` 写成 `{ 这不是合法 JSON`：

```
CLI  → ok=false；global 层错误 =
       { "code": "CONFIG_INVALID",
         "message": "验收配置层 global 不合法（…\\home\\acceptance.default.json）：SyntaxError: Expected property name or '}' in JSON at position 2 (line 1 column 3)" }
任务 → status=needs_attention
       message = 验收阻塞 [CONFIG_INVALID]: 验收配置层 global 不合法（…\\home\\acceptance.default.json）：…
```

即 **fail-closed**：坏层阻断本轮验收并**指明层与文件路径**，不静默忽略；调试命令同时把「哪一层坏了」如实分层显示，
其余层仍可解析。

### 2.5 判定

| 验收标准 | 结果 |
|---|---|
| 全局层参与合并、优先级低于项目层 | ✅ 2.1 / 2.2 |
| 项目层缺省字段不污染低优先级层的显式取值（本版修复的隐患） | ✅ 2.1 / 2.2（`requireChanges=false` 保持） |
| 任务级覆盖仅当次任务生效、不影响兄弟任务 | ✅ 2.3 |
| 坏层 fail-closed 且消息指明层与文件 | ✅ 2.4 |
| 调试命令可打印各层生效情况与最终配置 | ✅ 2.1 / 2.3 |

---

## 3. #21 dryRun 干跑模式 —— ✅ 已取得真机记录（真实 GUI agent 上的零改动验证）

**任务**：`tsk_20260925143808_2d8554`，agent=codex，`dryRun=true`（同时传 `autoVerify=true`、
`autoFixRounds=2`，用于确认 dryRun 会忽略它们），终态 **`succeeded`**。
`message`：**「dryRun 通过：计划含 2 个文件，源码零改动。」**

**复现要点**：scratch 项目含 `README.md` 与 `src/app.ts`（`greet` 在第 1 行）+ 一次基线 commit；
任务书要求「把 README 标题改成指定名称 + 给 `greet` 加一个可选问候语参数；先给方案，不要动源码」——
只读约束由 `makeBuildCtx()` 注入的 `DRY_RUN_CONSTRAINT` 下发给 agent。

### 3.1 六项断言

| 断言 | 观测 |
|---|---|
| 预演完成（不落 `needs_user`/`failed`） | `succeeded`（`agentEndReason=reply_stable`） |
| **零源码改动** | `git status --porcelain` 仅 `?? .tianshu-mcp/`；源码改动条目为空 |
| 计划被解析 | `dry-run-report-0.json` 的 `planExtracted: true` |
| 未消耗验收轮次 | 任务目录**无** `report-<round>.json`，只有 `dry-run-report-0.md/.json` |
| 已产出 dry-run 报告 | `dry-run-report-0.md` / `-0.json`（json 带 `kind: "dry-run"`） |
| 方案文档落到项目内（可作后续 `planDoc`） | `meta.dryRunPlanDoc = .tianshu-mcp/dry-run-plan-tsk_20260925143808_2d8554.md` |

服务端日志：

```
06:40:27.022 Codex 进度：pending；运行证据=none；对话哈希=573662be814d；稳定轮=1
06:40:37.309 任务 tsk_20260925143808_2d8554 第 0 轮 dryRun 静态分析: 通过（1 项 finding）
06:40:37.336 任务 tsk_20260925143808_2d8554 结束: succeeded
```

**注意**：`dryRun` 是 round 0 首次派发时注入约束；本次真机确认了「一次注入即覆盖 codex 适配器」的设计
（未对适配器代码做任何 dryRun 相关改动）。

### 3.2 agent 真实产出的计划文件

`.tianshu-mcp/dry-run-plan.json`（原样摘录）：

```json
{
  "summary": "将 README 标题更新为“rm21 dryRun 验证项目”，并为 greet 增加默认值为 hello 的可选问候语参数。",
  "files": [
    { "path": "README.md", "action": "modify", "reason": "将标题行改为指定的项目名称。" },
    { "path": "src/app.ts", "action": "modify",
      "reason": "让 greet 可接收自定义问候语，同时保留现有调用的 hello 默认行为。",
      "edits": [ { "line": 1, "symbol": "greet",
                   "action": "增加可选的问候语参数（默认值 hello），并用该参数替代固定的 hello 文本。" } ] }
  ]
}
```

静态分析唯一 finding 是**预期内**的非阻断告警（零改动门禁在排除 MCP 自有产物后仍如实报出 diffstat）：

```
[dry_run_artifacts_only] — 仅检测到 MCP 允许的产物变更（diffstat +23 -0），不计为源码改动
```

### 3.3 判定

| 验收标准 | 结果 |
|---|---|
| dryRun 模式下源码零改动 | ✅ 3.1（真实 `git status`） |
| 产出可审阅的静态分析报告与结构化计划 | ✅ 3.1 / 3.2 |
| 方案可作后续正式任务的 `planDoc` | ✅ `meta.dryRunPlanDoc` 指向项目内文件 |
| 不消耗验收轮次、不进返修循环 | ✅ 3.1 |
| **有对应测试或真机证据** | ✅ 集成测试 + 本节真机 |

### 3.4 如实披露

预演仍是一次**真实 agent 调用**（消耗额度）；只读约束靠任务书指令 + 事后零改动门禁，
**违反会被拦下但已发生的改动不会自动回滚**（MCP 从不自动 commit/stash/checkout）；
静态检查无法判断方案是否合理。`planDoc` 目前只由 Codex 与 Qoder CN 消费。

---

## 4. #22 终态 webhook 通知 —— ✅ 已取得真机记录

**复现要点**

- 真实 MCP server + `stub` agent；`<home>/config.json` 的 `notifications.webhook` 逐用例改写
  （`loadConfig` 按内容签名失效，运行中改配置即生效）。
- 接收端是**真实 `node:http` 服务**，监听 `127.0.0.1` 随机端口，**绝不外发**；记录原始 body（用于校验 HMAC）。
- 三个 scratch 项目分别用 `good` / `good`（配必然失败的检查）/ `sleep`（供取消）剧本。

**14 项断言全绿**：

| # | 用例 | 观测 | 结果 |
|---|---|---|---|
| 1 | `succeeded` → 通知 | 恰好 1 次 POST；`event=done`、`status=succeeded`、`X-Tianshu-Event: done`；body 携带 `taskId/agentId/projectPath`；`X-Tianshu-Signature` 与 `sha256=HMAC-SHA256(secret, 原始 body)` 逐字符一致 | ✅ |
| 2 | `failed` → 通知 | 1 次 POST，`event=failed` | ✅ |
| 3 | 端点恒 500（`maxRetries=2`、`backoffMs=50`） | 恰好 3 次尝试；**任务仍 `succeeded`**，仅落一条 `WARN`（不阻塞状态机） | ✅ |
| 4 | `cancelled` 未订阅（默认集只有真终态） | 任务到 `cancelled`，**接收端尝试次数为 0**（完全未发起 fetch） | ✅ |
| 5 | `cancelled` 显式加入 `events` | 1 次 POST，`event=cancelled` | ✅ |
| 6 | `enabled:false` | 任务 `succeeded`，尝试次数 0 | ✅ |

用例 1 的真实请求体（原样摘录）：

```json
{
  "taskId": "tsk_20260925142447_d1dd27",
  "event": "done",
  "status": "succeeded",
  "ts": "2026-09-25T06:24:51.321Z",
  "finishedAt": "2026-09-25T06:24:51.310Z",
  "agentId": "stub",
  "projectPath": "c:/Users/…/projOk",
  "round": 1,
  "reportRound": 0,
  "message": "[PASS] 验收通过（第 0 轮）：2/2 项命令检查通过。…",
  "reportMd": "…\\tasks\\tsk_20260925142447_d1dd27\\report-0.md",
  "reportJson": "…\\tasks\\tsk_20260925142447_d1dd27\\report-0.json"
}
```

签名头（真实请求头）：

```
x-tianshu-signature: sha256=d95b1401f454abe9750f4620a13c2c728bf7aa75cbc83a3d1bc2a72d01bf7d53
```

派发时机也可在服务端日志中看到「先落本地事实、再对外通知」：
`任务 … 结束: succeeded`（06:24:51.359）之后紧跟 `通知已送达（done，HTTP 200）`（06:24:51.423）。

### 4.1 判定

| 验收标准 | 结果 |
|---|---|
| 终态可配置 URL 主动推送，调用方无需挂屏轮询 | ✅ 用例 1/2 |
| 恰好一次（同回合不重复，返修新回合可再通知） | ✅ 用例 1（1 次 POST）；去重键语义见 `HANDOFF.md` §0.6.7 |
| 失败/超时不阻塞任务、有重试与退避 | ✅ 用例 3 |
| 默认只订阅真终态，`cancelled` / `needs_user` 需显式开启 | ✅ 用例 4/5 |
| 未启用时零请求 | ✅ 用例 6 |
| HMAC-SHA256 签名可用 | ✅ 用例 1 |

---

## 5. 附带发现（与本四 issue 无关，但会影响 Codex 真机复核）

**Codex 26.917.9434 的模型触发器回读缺陷（阻塞全部 codex 派发）**

本机实测 `model_mismatch`：

```
模型/等级切换回读不一致：期望 6 Luna，实际 6 Luna 中 无 极低 轻度 中 高 极高 最高 Ultra 持续
```

即模型触发器的 `innerText` 里混入了**整条思考等级条**（型号 + 全部档位名 持续/Ultra/极高…），
`parseTriggerValue()` 的正则要求文本**以「低/中/高」结尾**才能分离出等级，此处以「持续」结尾 → 整串被当作型号
→ `exactUiName(triggerValue.model, spec.model)` 必然为假 → 走换模型分支 → 三轮后判 `model_mismatch`。
26.917.8451 与 26.917.9434 **两个版本均复现**，且非恒定（同一版本曾成功派发过一次）。

**处理**：该缺陷超出 issue #18~#22 范围，建议单开 issue 跟踪。本轮 #19/#21 的真机取证为不阻塞进度，
在 scratch 数据目录的 `agent-profiles.json` 中用**克隆内置 profile + 只改一个字段**的方式绕开：

```jsonc
// profiles.codex.gui.modelSwitch = false  （不切换模型，沿用界面当前模型）
```

运行时日志如实可见：`[codex] profile.gui.modelSwitch=false，忽略指定模型`。
**这属于取证规避，不是修复**；默认 profile 仍为 `modelSwitch: true`，产品行为未改。

**型号名继续漂移**：`docs/agent-profiles` / `docs/codex-gui-cdp` 里「以面板/错误回显为准」的写法仍然正确 ——
本机 26.917.9434 的可用候选为 `默认 推荐模型集、6 Astra、6 Sol、6 Luna`（此前的 `5.6 Terra` 已不存在），
适配器 fail-closed 并回显候选列表，行为符合设计。

---

## 6. 真机副作用与清理

| 副作用 | 位置 | 处理 |
|---|---|---|
| 受管 Codex 实例（窗口/进程） | `%LOCALAPPDATA%\tianshu-mcp\codex-gui\profile` | 取证前后均按需关闭；用户原本未运行 Codex，无自身会话受影响 |
| Codex 项目列表新增 scratch 项目登记 | `~/.codex/.codex-global-state.json` | 每次登记前自动备份为 `*.tianshu-mcp-backup.json`；scratch 项目名形如 `proj`，可在 Codex 内手动移除 |
| scratch 数据目录与项目 | `%TEMP%\tianshu-rm19-*` / `rm20-*` / `rm21-*` / `rm22-*` | 保留以便人工复核，可随时整体删除 |
| ChatGPT 额度 | —— | 仅真实 GUI 任务消耗（#19 一轮自动返修、#21 一轮只读预演） |