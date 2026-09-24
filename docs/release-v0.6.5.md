# v0.6.5 — 验收配置三级继承

> 关联 issue：[#20](https://github.com/lanlan0811/tianshu-mcp/issues/20)。详见 [验收配置规范](acceptance-config.md)。

## 背景

原先仅支持项目级 `.tianshu-mcp/acceptance.json` 覆盖 `requireChanges` / `verifyConcurrency` 等字段。
一个天枢宿主下挂载多个同类项目（例如多个前端工程）时，逐个项目创建配置文件成本过高，维护也容易遗漏。

## 新增

- **三级继承链**（优先级低 → 高）：

  | 顺序 | 层 | 来源 |
  |---|---|---|
  | 1 | 全局兜底 | `<数据目录>/acceptance.default.json`（缺失 = 空配置，不报错） |
  | 2 | 项目覆盖 | `<project>/.tianshu-mcp/acceptance.json` |
  | 3 | 任务级临时覆盖 | `run_task` / `verify_task` 的 `acceptanceOverride` 参数 |

- **`acceptanceOverride` 参数**：格式同 `acceptance.json`；**仅当次任务/当次验收生效**，
  随任务快照保存。它是**任务数据而非配置文件**：不写任何 `acceptance*.json`、不影响同项目其他任务
  与其他项目；同一任务的 `rework_task` / `continue_task` 沿用同一快照，覆盖继续生效。
  无项目模式**显式拒绝**该参数（没有项目验收可覆盖，静默忽略会误导调用方）。
- **`tianshu-mcp config acceptance [projectPath] [--task <taskId>]`**：打印各层是否存在、
  实际生效顺序 `appliedOrder`、最终取值 `effective` 与一行摘要。每轮验收也往 `server.log`
  写一行同源摘要。命令在创建 MCP server 之前返回，只写面向人的 stdout。
- 新增 `src/config/acceptance-merge.ts`：按用途收敛的合并工具（**刻意不做通用深合并**）。

## 修复：分层解析的 `.default()` 污染

`AcceptanceConfigSchema` 给 `requireChanges` 上了 `.default(true)`。若用它解析「只写了
`verifyConcurrency`」的项目文件，会 materialize 出 `requireChanges: true`，在三级继承里
**反过来把全局层的 `requireChanges: false` 覆盖掉** —— 继承链会静默失效。

修法：新增**无任何默认值**的 `PartialAcceptanceConfigSchema` 专供分层解析；默认值只在
最终生效值缺省时由消费方兜底。`AcceptanceConfigSchema` 保留给既有的 visual/legacy 调用方。

## 关键设计决定

| 决定 | 理由 |
|---|---|
| 合并粒度 = 字段 | 高优先级层**显式书写**的字段整体取胜；`undefined` 视为「本层未书写」，不参与覆盖 |
| 数组整体覆盖 | `checks` 写了就整段替换。拼接会让「项目追加一项检查」变成「项目无法移除全局检查」，歧义大且不可预测 |
| **`visual` 整体覆盖，不深合并** | `visual` 的 schema 几乎每个字段都带默认值，深合并会让低优先级层的**显式**取值被高优先级层「未书写、仅因默认值而出现」的字段静默覆盖（与 `requireChanges` 同类的污染）。要做对必须改成「在原始 JSON 上合并、只对结果校验一次」，改动面大而收益有限 —— 故明确选择整体覆盖 |
| 坏层 fail-closed | 某层「存在但读不了 / JSON 坏 / 字段不合法」不被当空配置跳过，而是进 `needs_attention` 并指明层与文件；仅 `ENOENT` 才算「该层不存在」 |
| visual 取自合并结果 | `executeVerify` 不再二次读项目文件，否则 override/全局层的 `visual` 会随项目文件是否存在而改变语义 |
| 计入幂等入参摘要 | `runTaskKeyedFields()` 与 `verifyIdempotencyDigest()` 均纳入 `acceptanceOverride` —— 否则同键重放会返回一个「策略不同」的旧任务 |
| 每轮一行摘要 | `resolveChecks()` 输出 `生效层=… checks=… requireChanges=… verifyConcurrency=…`，与 `config acceptance` 同源 |
| 调试命令不挂 `visual` 命名空间 | `acceptance.json` 是验收引擎的配置，视觉验收只是共用一个文件；混进 visual 会误导 |

**与 issue 建议的一处有意偏离**：issue 建议「配置合并采用深合并策略」。本版对**标量**（即 issue 举的
`requireChanges` / `verifyConcurrency`）与数组都按上述语义正确实现；但对 `visual` 明确选择
**整体覆盖**，理由见上表。该偏离同时记录在 CHANGELOG、`docs/acceptance-config.md` 双语与
ARCHITECTURE §7.4，便于后续维护者按需重估。

## 兼容性

- **无工具契约、数据模型或 MCP 注解变更**。`acceptanceOverride` 是新增可选参数；
  `extraChecks` 语义与优先级不变（仍高于基础集）。
- **不创建全局 `acceptance.default.json` 时，单项目行为与 v0.6.4 完全一致。**
- 项目级 `.tianshu-mcp/acceptance.json` 的既有语义不变；错误语义仍为 fail-closed。

## 测试

- 新增 36 个用例（3 个文件）：
  - `test/unit/acceptance-merge.test.ts`（18）：标量覆盖 / 下层独有字段保留 / `checks` 整体覆盖 /
    `visual` 整体覆盖 / `undefined` 不算书写 / 两层皆空；`resolveAcceptanceLayers` 的生效顺序与
    缺失层跳过；`summarizeResolved` 摘要；**`.default()` 污染对照**（分层 schema 不补 vs 带默认
    schema 会补出 `true`，并验证「只写 verifyConcurrency 的项目层不会覆盖全局 requireChanges=false」）；
    `verifyConcurrency` 越界 clamp；`readAcceptanceLayer` 的缺失 / 正常 / JSON 坏 / 字段不合法 / 目录当文件读。
  - `test/integration/acceptance-override.test.ts`（6）：覆盖 `checks` 后判定翻转且**只影响当次任务**
    （兄弟任务回到项目配置）；`verify_task` 也接受覆盖且**不粘**（下一次不带覆盖即回到失败、轮次推进）；
    无项目模式拒绝该参数；全局层参与合并、缺失时行为与既有版本一致；项目层优先于全局层；
    全局文件写坏 → `needs_attention` 且消息指明该层。
  - `test/unit/config-cli.test.ts`（12）：三层识别与 `appliedOrder`；全局独有字段不被项目层清空；
    `--task` 读快照且 override 最高优先级；任务不存在时如实报错；未提供 `--task` 时明确标注；
    某层写坏时**错误分层可见**且其余层仍被解析；未知选项/多余参数被拒绝；`summary` 与 `effective` 一致。
- 全量 `npm test`：**1073 passed / 12 skipped**（99 文件；v0.6.4 为 1037 passed / 12 skipped，净增 36）。
- `check:stdio`：dist 与 src 均 **8/8**（未新增 MCP 工具，场景数不变）。
- CLI 手动冒烟：`node dist/index.js config acceptance` 输出三层与取值（无层时 `ok=true`、
  `appliedOrder=[]`）。

## 真机记录

本 issue 的验收标准是「三级继承按优先级正确合并，有单元测试覆盖」「提供查看最终生效配置的调试命令或
日志」「全局默认文件缺失时不报错」——三项均由上述单测 / 集成测试 / CLI 冒烟覆盖，**无真机 GUI 依赖**，
故本版不需要真机记录。
