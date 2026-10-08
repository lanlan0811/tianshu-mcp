# tianshu-mcp v0.9.0

**发布日期**：2026-10-08
**类型**：工具面合并（**BREAKING**）
**英文版**：release-v0.9.0.en.md

---

## 一句话

13 个 MCP 工具按域合并为 **8 个**：`cancel_task` / `continue_task` / `rework_task` → **`manage_task`**，
`list_tasks` / `get_task_report` / `get_profiles` → **`query_info`**，`wait_any` → **`wait_task`（批量模式）**。
视觉基准两工具**保持独立**。

---

## 迁移表（升级前对照）

| 原调用 | 新调用 |
|---|---|
| `cancel_task(taskId, reason?)` | `manage_task(taskId, action="cancel", reason?)` |
| `continue_task(taskId, message)` | `manage_task(taskId, action="continue", message)` |
| `rework_task(taskId, feedback?, repairHint?)` | `manage_task(taskId, action="rework", feedback?, repairHint?)` |
| `list_tasks(projectPath?, status?, limit?)` | `query_info(type="tasks", projectPath?, status?, limit?)` |
| `get_task_report(taskId, round?)` | `query_info(type="report", taskId, round?)` |
| `get_profiles()` | `query_info(type="profiles")` |
| `wait_any(taskIds, timeoutMs?)` | `wait_task(taskIds, timeoutMs?)` |
| `wait_task(taskId, timeoutMs?)` | **不变** |
| `run_task` / `query_task` / `verify_task` | **不变** |
| `prepare_visual_baseline` / `approve_visual_baseline` | **不变**（不合并） |

---

## 为什么不合并视觉基准

原计划（计划文档 §4.1 合并组 4）曾考虑把 `prepare_visual_baseline` + `approve_visual_baseline`
合成 `visual_baseline`。**本次明确放弃**，两条理由：

1. **收益极小**：这两个工具合计约 500 字符，占工具面 4%。而它们承载的是**防篡改闸门**——
   `approveBaseline` 校验 `digest(content) !== args.expectedDigest` 即抛
   `CANDIDATE_CHANGED`（`src/visual/baselines.ts`）。把 `prepare` / `approve` 塞进一个工具的
   `action` 分支，会让 `candidateId` / `expectedDigest` / `approvalNote` 这三个必填参数
   在参数层失去显式位置。
2. **风险与收益不成比例**：500 字符换一个安全闸门的清晰度，不划算。

同理，`run_task` / `query_task` / `verify_task` 三个高频核心工具**完全不动**。

---

## 技术要点：分支约束为什么必须下沉

合并后的三个新工具的 schema 都是 **plain `z.object`**，而不是 `z.discriminatedUnion`——
这不是风格选择，是硬约束：

**实测**（经官方 SDK `client.listTools()`，与生产同路径）：

| zod 形态 | 线上 `inputSchema` | 结果 |
|---|---|---|
| `z.object({...})` | 382 字符，字段完整 | 可用 |
| `z.object({...}).refine(...)` | **33 字符 → `{"type":"object","properties":{}}`** | 参数信息全部丢失 |
| `z.discriminatedUnion("action", [...])` | **33 字符 → `{"type":"object","properties":{}}`** | 参数信息全部丢失 |

宿主 LLM 会看到一个「无参数、无字段说明」的空 schema。因此分支约束改由 handler 内的
`checkBranchFields()` 白名单承担：

- `action=continue` 要求 `message` 非空（原为 schema 层 `z.string().min(1, "message 不能为空")`）
- `type=report` 要求 `taskId` 非空
- `wait_task` 要求 `taskId` 与 `taskIds` **恰有其一**
- **分支外字段 fail-closed**：`action=cancel` 携带 `message` 会被明确拒绝
  （「action=cancel 不接受参数: message」），而不是静默忽略——符合项目通篇的 fail-closed 原则

---

## 注解层的一处取舍

`src/server.ts` 的 `destructiveHint` 原按工具名硬编码（`cancel_task` / `rework_task` /
`approve_visual_baseline`）。合并后只剩 `manage_task` 与 `approve_visual_baseline`。

**MCP 注解是工具级、无法按 action 区分**，所以 `manage_task` 只能二选一：

- 标 `true`：`action=continue`（恢复任务，非破坏性）也被一并标记——**语义略宽**
- 标 `false`：`action=cancel` / `rework` 的破坏性提示丢失——**安全信号缺失**

**本次选 `true`**（宁可过报不可漏报），并在工具描述里写明「本工具含破坏性 action：cancel / rework」。
`requireApproval` 恒为 `true`，实际闸门不受影响。

---

## 验证

### 工具面（实测）

| 指标 | 值 |
|---|---|
| 工具数 | **8**（由 13 合并） |
| 跨仓一致性 `check-schema-parity.mjs` | **MCP 工具面（前端镜像）（8 项）** 通过 |
| `mcp-gui` 测试 | **173 passed** |

### 测试

- **新增 `test/integration/tool-consolidation.test.ts`（21 例）**，锁定三条不变量：
  ① 工具面恰为 8 个且 7 个旧名全部消失；
  ② 三个新工具的线上 `inputSchema` 必须暴露非空 `properties`（防空 schema 陷阱）；
  ③ 分支约束在下沉层仍 fail-closed（缺 `message`、缺 `taskId`、二选一违反、`taskIds` 超 20 等）。
  **RED→GREEN 完整**：实施前 11 failed / 10 passed → 实施后 21 passed。
- `test/protocol/protocol.test.ts`：真值表 13 行 → 8 行；工具名数组、`idempotentHint`
  否定清单、`destructiveHint` 断言同步。
- 9 个既有集成测试文件的调用点改为新形式（`cancel-noreason` / `cancel-state` /
  `idempotency` / `query-events` / `rework-feedback-race` / `rework-repair-hint` /
  `task-flow` / `verify-params` / `wait-task`）。

### 门禁

```
tsc --noEmit                exit 0
eslint --max-warnings 0     全绿
node mcp-gui/scripts/check-schema-parity.mjs   8 项一致
```

---

## 同步范围（四个面）

工具改名是跨面操作，本次**一次性全改**：

| 面 | 内容 |
|---|---|
| **协议测试** | `test/protocol/protocol.test.ts` 真值表与名字数组 |
| **GUI 镜像** | `mcp-gui/src/core/capabilities.ts`（8 条）、`i18n/zh-CN.ts`、`i18n/en-US.ts`、`test/capabilities.test.ts` |
| **运行时文案** | `src/agents/**` **47 处**「请调用 continue_task」类提示 → `manage_task(action="continue")` |
| **文档技能** | `README` 双语工具表、`ARCHITECTURE` 双语、`skills/tianshu-mcp/SKILL.md`、`usage-examples.md`、`docs/wait-task.md` 双语 |

---

## 升级注意

**技能文件的旧副本不会自动替换**。`skills/tianshu-mcp/` 由 server 启动时幂等同步到
`~/.rivet/skills/tianshu-mcp/`，带安装清单（版本 + 内容 hash）。若清单处于
「需变更但未自动覆盖」状态，需按 `docs/agent-profiles.md` 的 `--approve-skill-update`
流程放行一次，否则宿主会话里的技能文本可能仍指向已删除的工具名。

**其余无需手工干预**：运行时文案、GUI 镜像、协议测试均已随包同步。
