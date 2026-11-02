# v1.0.0-beta.1 — 参数面收敛

> **移除 TraeWork 专属的 `mode` 字段与全部透传，并把已废弃的 `TraeworkMode` 类型中性化——
> `grep -rin traework src/` 归零。**
>
> 这是「移除 TraeWork 与 Qoder CN」六版计划的第 4 版：前两版删掉了两个 agent，
> 本版把因此失去消费者的参数面收干净。

**本版无行为变化**：工具名 / 参数集 / 校验语义均不变。`mode` 仍在 `run_task` 的入参 schema 里、
仍被 handler 统一拒绝——只是内部不再有任何字段承载它。

---

## 变更

### 删除 `mode` 字段与透传链

| 文件 | 改动 |
|---|---|
| `src/agents/adapter.ts` | 删 `TaskContext.mode` |
| `src/tasks/task.ts` | 删 `TaskMeta.mode` |
| `src/tasks/task-manager.ts` | 删 `NewTaskInput.mode` 与落盘 |
| `src/mcp/formatter.ts` | 删 `MetaBlockFields.mode` 与透传 |
| `src/mcp/context.ts` | 删 `mode` 透传 |
| `src/mcp/handlers.ts` | 删三处 `mode: args.mode` 透传 |

这些字段自 0.9.9 起已无任何消费者（唯一消费者 TraeWork 已移除），只是「留给旧调用方拿文案」的
空壳。**迁移文案由 `handlers.ts` 的统一拒绝承担**，不依赖这些字段。

### 类型中性化

`TraeworkModeSchema` / `TraeworkMode` → `DeprecatedPanelModeSchema` / `DeprecatedPanelMode`。
`RunTaskParamsSchema.mode` 仍保留该键（**已废弃的显式拒绝**）——`src/config/schema.ts` 是裸
`z.object`（未知键默认 strip），删键只会让参数「消失」而拿不到解释。

**效果**：`grep -rin traework src/` 零命中（本计划 G2 目标的 src 侧达成）。

---

## 验证

| 门 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 0 error |
| `npm run lint`（`--max-warnings 0`） | 0 warning |
| `npx vitest run test/unit test/integration test/protocol` | 全绿 |
| `npm run build && npm run check:stdio` | stdout 纯净 |
| 零残留 | `grep -rin traework src/` → 0 命中 |

**回归重点**：`test/unit/zcode-handler.test.ts` 锁「传 `mode` → 统一废弃文案且不提交任务」
（证明删字段后拒绝路径仍生效）；`test/unit/registry-driver.test.ts` 锁 registry 的 driver/adapter
选择与 `driver="gui"` 缺 `adapter` 的 fail-closed。
