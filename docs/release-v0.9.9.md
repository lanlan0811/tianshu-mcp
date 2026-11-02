# v0.9.9 — 移除 TraeWork 调用支持（破坏性变更）

> **彻底移除 `traework` agent 的调用支持：整目录删除、接线清理、测试改写、文档全量收口。**
>
> 这是「移除 TraeWork 与 Qoder CN」六版计划的第 2 版。第 1 版（0.9.8）已把六个 GUI 适配器
> 共用的 CDP 传输底座迁出 `traework/` 目录；本版才真正删除该目录。

**本版是破坏性变更**：宿主若在配置里固定了 `agentId: "traework"`，升级后调用会失败
（`agent_unresolved`）。其余六个 agent 与 `stub` 行为零变化，工具面仍是 8 个工具。

---

## 破坏性变更

| 变更 | 影响 |
|---|---|
| `traework` agent 消失 | `query_info(type="profiles")` 不再列出；`run_task(agentId="traework")` → `agent_unresolved` 硬失败 |
| `driver="gui"` 缺省回退取消 | 自定义 GUI profile 若「写了 `driver="gui"` 却没写 `adapter`」，升级后**解析即报错**（旧版静默回落到 `traework-gui`） |
| `mode` 参数废弃 | 任何 agent 传入 `mode` 都被统一拒绝并提示改用 `designDirection` |

### 迁移方式

- **宿主配置里写死了 `agentId: "traework"`**：换成仍在的 agent（codex / zcode / kimicode /
  qoder / opendesign / minimax），或降级 MCP 版本。
- **自定义 GUI profile 缺 `adapter`**：显式补上，可选值为
  `codex-gui` / `zcode-gui` / `kimicode-gui` / `qoder-gui` / `opendesign-gui` / `minimax-gui`。
  报错文案已列出这份清单，照做即可。
- **传了 `mode`**：移除该参数；要表达设计取向改用 `designDirection`（Open Design）。

---

## 变更明细

### 删除

```text
src/agents/traework/adapter.ts          src/agents/traework/cdp/client.ts   (0.9.8 薄壳)
src/agents/traework/cdp/selectors.ts    src/agents/traework/computeruse/dialog.ts
src/agents/traework/computeruse/guard.ts src/agents/traework/discovery.ts
src/agents/traework/launcher.ts         src/agents/traework/run.ts
src/agents/traework/ui/composer.ts      src/agents/traework/ui/model.ts
src/agents/traework/ui/reply.ts         src/agents/traework/ui/session.ts
→ 整个 src/agents/traework/ 目录消失
```

测试面删除 15 个 `traework-*` 用例；`test/integration/traework-fake-cdp.test.ts` 的
「假 CDP 驱动真实 run 逻辑」方法由 `test/fake-cdp.ts` 保留（kimicode / opendesign 仍在用）。

### 源码接线

| 文件 | 改动 |
|---|---|
| `src/agents/builtin.ts` | 删整个 `traework` profile 块；端口基准注释去掉 traework |
| `src/agents/registry.ts` | 删 `TraeworkGuiAdapter` / `discoverTraework` import；`traework` 从默认 CLI 列表移除；删 `traework-gui` 分支与降级条件；新增 `driver="gui"` 无 `adapter` 的**防御性兜底**（schema 已挡，这里再挡一次） |
| `src/config/schema.ts` | `adapter` 枚举去掉 `traework-gui`；`AgentProfileSchema` 新增 `superRefine`——`driver="gui"` 无 `adapter` 即 fail-closed，文案列出全部可选 adapter |
| `src/agents/adapter.ts` / `src/tasks/task.ts` / `src/tasks/task-manager.ts` | `mode` 字段注释改为「已废弃」；`mode?: TraeworkMode` 保留（见下） |
| `src/mcp/handlers.ts` | 删五处「XX 不支持 mode 参数」的分散拒绝，收敛为**一条统一废弃文案**（在任何 agent 分支之前） |
| `src/mcp/tools.ts` | `run_task` 描述去掉 TraeWork 段，改述 `mode` 已废弃 |
| `src/server.ts` | `instructions` 的 agent 列表去掉 traework |
| `src/loop/fix-loop.ts` / `repair-plan.ts` / `mcp/context.ts` / `formatter.ts` | 注释里的 TraeWork 去掉 |

### 为什么 `mode` 键保留在 schema 里

`src/config/schema.ts` 是裸 `z.object`（**默认 strip，不是 reject**）：直接删 `mode` 键，
旧调用方只会发现参数「消失」，拿不到任何解释。故保留键、在 handler 统一拒绝，给出可读的
迁移文案。字段类型仍为 `TraeworkMode`（`Work` / `Code` / `Design`）——它现在只服务「读取旧任务
快照 + 迁移文案」，改名与删除留到后续版本。

---

## 验证

| 门 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 0 error |
| `npm run lint`（`--max-warnings 0`） | 0 warning |
| `npx vitest run test/unit test/integration test/protocol` | **128 文件通过 / 3 跳过；1611 用例通过 / 12 跳过** |
| `npm run build && npm run check:stdio` | stdout 纯净 |
| 逻辑面影响 | 其余六个 agent 的既有集成用例（codex / zcode / kimicode / qoder / opendesign / minimax）全部照常通过 |

**回归重点**：`test/unit/registry-driver.test.ts`（原 `traework-driver`）新增「`driver="gui"`
缺 `adapter` → fail-closed 且报错含全部可选项」用例；`test/unit/zcode-handler.test.ts` 锁
「传 `mode` → 统一废弃文案且不提交任务」；`test/fake-cdp.ts` 保留，证假 CDP 方法对
kimicode / opendesign 仍然可用。
