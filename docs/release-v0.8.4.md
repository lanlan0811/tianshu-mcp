# tianshu-mcp v0.8.4

**发布日期**：2026-10-07
**类型**：工具面瘦身（无破坏性变更）
**英文版**：release-v0.8.4.en.md

---

## 一句话

`run_task` / `verify_task` 的 `acceptanceOverride` 线上声明改为骨架形态，
`tools/list` 从 **35581 → 11717 字符（−67.1%）**，工具名、参数集与校验语义全部不变。

---

## 背景：工具面体积的真实构成

优化前的实测分布（经官方 SDK `client.listTools()` 取线上真实字节，与生产注册路径一致）：

```
工具数: 13
tools/list 总字符: 35581

 13619  run_task          ← 其中 12483 是 acceptanceOverride 子树
 13029  verify_task       ← 其中 12196 是 acceptanceOverride 子树
   924  prepare_visual_baseline
   884  query_task
   777  approve_visual_baseline
   777  continue_task
   754  rework_task
   727  wait_task
   677  cancel_task
   652  wait_any
   576  list_tasks
   559  get_task_report
   449  get_profiles
```

**两个工具占了 74.9%，其中 `acceptanceOverride` 一项就占全工具的 69.4%。**

## 根因

`acceptanceOverride` 内联的是 `PartialAcceptanceConfigSchema`，组装后 11005 字符：

| 组成 | 字符数 |
|---|---|
| `VisualConfigSchema` | **9579**（87%） |
| `AcceptanceCheckSchema` | 380 |
| 其余标量字段 | 约 550 |

而 MCP 协议下**每个工具的 `inputSchema` 独立序列化**，跨工具无法用 `$ref` 共享——
`run_task` 与 `verify_task` 各内联了完整一份，两份合计 **24679 字符**。

这也解释了一个容易误判的点：**优化的主战场不在工具数量**。当时计划中的「13 → 8 工具合并」
所涉及的 9 个工具加起来只有 6145 字符（占工具面 17.3%）——即使合并后 schema 完全不膨胀，
其收益上限也只是本次的零头。

## 改动

### 1. 线上声明骨架化

新增 `AcceptanceOverrideWireSchema`（`src/config/schema.ts`），供 `RunTaskWireSchema` /
`VerifyTaskWireSchema` 使用：

| 字段 | 严格形态 | 骨架形态 |
|---|---|---|
| `checks` | `AcceptanceCheckSchema` 数组 | **不变**（保留完整校验） |
| `visual` | `VisualConfigSchema`（9579 字符） | `z.record(z.unknown())`（不透明） |
| `requireChanges` | `z.boolean().optional()` | **不变** |
| `verifyConcurrency` | `z.number().transform(...)` | **不变** |

逐工具效果：`run_task` 14435 → 2503，`verify_task` 13366 → 1434，其余 11 个零变化。

### 2. 校验下沉（成对实施，不可拆）

**这是本次最关键的一处**。实施前实测发现：**线上 `inputSchema` 是 `acceptanceOverride` 的唯一校验层**——
`grep acceptanceOverride src/ | grep parse` 返回空，两个 handler 内都只有
`rawArgs as XxxParams` 类型断言。

后果是：`visual` 转为不透明对象后，其内部字段的非法输入（如 `visual.enabled: "yes"`）
会**穿透 SDK 层直达 handler**——这是 fail-open 回归。

因此在 `runTaskHandler` / `verifyTaskHandler` 入口新增 `validateAcceptanceOverride()`，
用严格 `PartialAcceptanceConfigSchema` 复核。实测确认：坏输入仍被拒，且错误来源正确标记为
handler 下沉层（文案含 `acceptanceOverride 参数不合法`，不含 SDK 的 `-32602`）。

## 验证

### 体积（实测）

| 指标 | 前 | 后 |
|---|---|---|
| `tools/list` 总字符 | 35581 | **11717（−67.1%）** |
| `run_task` | 14435 | 2503 |
| `verify_task` | 13366 | 1434 |
| 工具数 | 13 | **13（不变）** |

### 测试（含反证）

- **下沉层防回归**：4 条用例专打「只有下沉层能拦」的 `visual` 缝隙，并断言错误来源。
  **反证**：临时移除两处下沉校验 → 精确 4 条变红，其余 8 条仍绿。
- **线上 schema 契约**：断言除设计上无参的 `get_profiles` 外，每个工具的线上
  `inputSchema.properties` 非空——锁定 `.refine()` / `z.discriminatedUnion` 陷阱
  （实测这两者线上退化为 `{"type":"object","properties":{}}`，参数信息全丢）。
- **编译期同构锁**：wire 与严格 schema 字段集双向等价，骨架字段集恰为 4 个。
  该锁经反证（注入多余字段 → TS2322）；早先用条件类型别名写的版本**不会报错**，已废弃。

### 门禁

```
tsc --noEmit                exit 0
eslint --max-warnings 0     全绿
```

## 已知限制

- **`visual` 不再自描述**：宿主 LLM 从线上 schema 只能看到一个不透明对象，看不到
  `viewports` / `pages` / `defaults` 等内部字段名。功能不受影响，但需查
  [docs/acceptance-config.md](acceptance-config.md)。这是换取 67% 体积下降的直接代价。
- **未做工具合并**：本轮不改任何工具名。计划中 13 → 8 的合并未实施——其收益约
  2000–4000 字符，却要动协议测试、GUI 镜像、44 处运行时文案四个面。留待后续按需评估。

## 升级说明

**无需任何调用方改动**。工具名、参数名、参数约束、错误语义全部保持。

唯一的可见差异是宿主 LLM 看到的 `acceptanceOverride.visual` 从「展开的字段列表」变成
「不透明对象」——这影响的是模型对字段的自主推断能力，不影响实际传参与校验。
