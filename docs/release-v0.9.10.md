# v0.9.10 — 移除 Qoder CN 调用支持（破坏性变更）

> **彻底移除 `qoder` agent 的调用支持：整目录删除、接线清理、fix-loop 分支清理、测试改写、文档全量收口。**
>
> 这是「移除 TraeWork 与 Qoder CN」六版计划的第 3 版。第 2 版（0.9.9）已移除 TraeWork，
> 本版移除另一个反复出现真机缺陷的 GUI 适配器。

**本版是破坏性变更**：宿主若在配置里固定了 `agentId: "qoder"`，升级后调用会失败
（`agent_unresolved`）。其余五个 agent 与 `stub` 行为零变化，工具面仍是 8 个工具。

---

## 破坏性变更

| 变更 | 影响 |
|---|---|
| `qoder` agent 消失 | `query_info(type="profiles")` 不再列出；`run_task(agentId="qoder")` → `agent_unresolved` 硬失败 |
| `modelSource` 参数废弃 | 任何 agent 传入 `modelSource` 都被统一拒绝（提示移除） |
| 历史 `agentId:"qoder"` 任务 | `rework` / `continue` 落到 `failed(agent_unresolved)`，**绝不被 CLI adapter 兜底误跑** |

### 迁移方式

- **宿主配置里写死了 `agentId: "qoder"`**：换成仍在的 agent（codex / zcode / kimicode /
  opendesign / minimax），或降级 MCP 版本。
- **传了 `modelSource`**：移除该参数（该参数已无任何适配器消费）。

---

## 变更明细

### 删除

```text
src/agents/qoder/adapter.ts      src/agents/qoder/cdp.ts        src/agents/qoder/dialog.ts
src/agents/qoder/discovery.ts    src/agents/qoder/instance.ts   src/agents/qoder/liveness.ts
src/agents/qoder/model.ts        src/agents/qoder/profile.ts    src/agents/qoder/questions.ts
src/agents/qoder/references.ts   src/agents/qoder/run.ts        src/agents/qoder/selectors.ts
src/agents/qoder/workspace.ts
→ 整个 src/agents/qoder/ 目录消失
```

测试面删除 10 个 `qoder-*` 用例。

### 源码接线

| 文件 | 改动 |
|---|---|
| `src/agents/builtin.ts` | 删 `QODER_PROFILE` import 与注册表项；端口基准注释去掉 qoder |
| `src/agents/registry.ts` | 删 `QoderGuiAdapter` / `discoverQoder` import；`qoder` 从默认 CLI 列表移除；删 `qoder-gui` 适配器分支与 `discoverQoder` 探测分支 |
| `src/config/schema.ts` | `adapter` 枚举去掉 `qoder-gui`；`superRefine` 报错文案同步；`modelSource` 注释改「已废弃」 |
| `src/mcp/handlers.ts` | 删 `validateQoderReferences` / `normalizeLevel` import；删 `modelSource` 守卫与 `qoder-gui` 分支；新增 `modelSource` 统一废弃拒绝（有/无项目两条路径各一处） |
| `src/loop/fix-loop.ts` | 删 qoder 专用返修分支（原报告门禁 + 计划全文注入 + session 落盘）；**`actualModel` 改无条件落盘**（见下） |
| `src/tasks/task-manager.ts` | 删 qoder rework / continue 分支；continue 白名单文案去掉 qoder |
| `src/tasks/task.ts` / `src/mcp/formatter.ts` | 删 `qoderSessionId` / `qoderTurnId` 字段与透传 |
| `src/mcp/context.ts` | 删 `meta.agentId === "qoder"` 的恢复上下文分支 |
| `src/mcp/tools.ts` / `src/server.ts` | 描述与 instructions 去掉 Qoder CN / modelSource 段 |
| 其余 | minimax / opendesign / zcode / verify 里的 qoder 注释去掉 |

### 顺带修正的既存缺陷：`actualModel` 落盘

`fix-loop` 里 `meta.actualModel = runRes.actualModel ?? ...` 原在 `if (meta.agentId === "qoder")`
块内。而 `actualModel` 有**两个生产方**：qoder 与 **Open Design**（`opendesign/run.ts` 的
`result({ ..., actualModel })`）。因为该赋值被 qoder 门挡住，**Open Design 的模型回读从未落盘**——
`context.ts` 的 `meta.actualModel ?? meta.model` 对它永远走 `??` 右侧。

删除 Qoder 顺带暴露了这个缺陷。本版把该赋值**移出 qoder 门、改为无条件落盘**，Open Design 的
`actualModel` 从此正确写入任务快照与 meta。这属行为变化，已在 release note 登记。

### 历史任务重跑 fail-closed

registry 不再为 qoder 预置 CLI 基座，`resolve("qoder")` 返回 `ok:false`。数据目录里遗留的
`agentId: "qoder"` 任务若被 `rework` / `continue`，会落 `failed(agent_unresolved)`，
**绝不被 CLI adapter 兜底误跑**（新增 `test/integration/legacy-removed-agent-rework.test.ts` 锁死）。

---

## 验证

| 门 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 0 error |
| `npm run lint`（`--max-warnings 0`） | 0 warning |
| `npx vitest run test/unit test/integration test/protocol` | **全绿**（详见提交记录） |
| `npm run build && npm run check:stdio` | stdout 纯净 |
| 逻辑面影响 | 其余五个 agent 的既有集成用例（codex / zcode / kimicode / opendesign / minimax）全部照常通过 |

**回归重点**：`test/integration/legacy-removed-agent-rework.test.ts` 锁「历史 qoder 任务重跑
fail-closed 且不被兜底」；`test/unit/registry-driver.test.ts` 锁「registry 不再预置 qoder 基座」。
