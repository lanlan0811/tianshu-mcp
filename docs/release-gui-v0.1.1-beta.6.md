# 日志台 0.1.1-beta.6 — 工具面同步 MCP 0.9.0（13 → 8）

> 完整变更记录见 [CHANGELOG](../CHANGELOG.md)；功能文档见 [docs/gui-log-viewer.md](gui-log-viewer.md)。

这是 0.1.1 线的**同步版**：把「MCP 能力」视图的工具清单与 MCP 主包 **v0.9.0 的工具面合并**
（13 → 8）对齐。**无新增功能、无界面结构变更**——但**有一条用户可见的内容变更**：
能力视图里的工具名与说明全部换新，旧版显示的 13 个工具名已不存在于 MCP 0.9.0。

---

## 本次变更

### 工具面清单 13 → 8（对齐 tianshu-mcp v0.9.0）

**背景**：MCP 主包 v0.9.0 把 13 个工具按域合并为 8 个（三组合并，视觉基准两工具保持独立）。
日志台的「MCP 能力」视图内嵌了一份**镜像清单**（`mcp-gui/src/core/capabilities.ts`），
由 `scripts/check-schema-parity.mjs` 与真源 `src/mcp/tools.ts` 的 `TOOL_DEFS`
按 `name + capability + requireApproval` **顺序敏感**比对。主包改名后镜像必须同步，
否则 CI 的 GUI 工作流直接红。

**合并映射**（旧 → 新）：

| 旧工具 | 新工具 |
|---|---|
| `cancel_task` + `continue_task` + `rework_task` | **`manage_task`**（`action` 三选一） |
| `list_tasks` + `get_task_report` + `get_profiles` | **`query_info`**（`type` 三选一） |
| `wait_any` | 并入 **`wait_task`**（批量模式：传 `taskIds`） |
| `run_task` / `query_task` / `verify_task` | 不变 |
| `prepare_visual_baseline` / `approve_visual_baseline` | **不变**（明确保持两个独立工具） |

**改动文件**（4 个）：

- `src/core/capabilities.ts` —— `MCP_TOOLS` 由 13 条改为 8 条，顺序与主包 `TOOL_DEFS` 一致
- `src/i18n/zh-CN.ts` —— 中文工具说明重写（`manage_task` / `query_info` / `wait_task` 三条
  改为覆盖各自分支的合并描述）
- `src/i18n/en-US.ts` —— 英文工具说明同步
- `test/capabilities.test.ts` —— 数量断言 `13 → 8`，新增「新工具在列」断言

### 三族归属随之更新

| 族 | 工具 |
|---|---|
| `read`（读/查询，无副作用） | `query_task` / `query_info` / `wait_task` |
| `write`（有副作用，需审批） | `run_task` / `manage_task` / `prepare_visual_baseline` / `approve_visual_baseline` |
| `execute`（跑项目命令但不改源码，免审批） | `verify_task` |

### 审批语义保持

`manage_task` 为 `write` + 需审批（合并前的 `cancel_task` / `continue_task` / `rework_task`
三者都是该组合）；`query_info` 为 `read` + 免审批（合并前三者同）；`wait_task` 保持
`read` + 免审批。**审批语义等价，无放宽或收紧。**

---

## 用户可见行为变更（本版唯一一条）

能力视图的工具清单从 13 条变为 8 条，且**旧工具名不再出现**。若你在日志台里按旧名
（如 `cancel_task` / `list_tasks`）查找工具，会找不到——按上表映射到新名即可。

**这只是展示层的同步**：日志台是**只读**消费方，不调用 MCP 工具，所以本次变更
不影响任何日志读取、任务浏览或报告查看功能。

---

## 测试与验证

```
vue-tsc --noEmit                     exit 0
vitest run                           173 passed（15 文件）
node scripts/check-schema-parity.mjs 全部一致（含「MCP 工具面（前端镜像）（8 项）」
                                     与「GUI 版本号一致（0.1.1-beta.6）」）
```

其中 `capabilities.test.ts` 的断言链：

- 清单恰 8 条、名称唯一
- `wait_task` 在列且为 `read` + 免审批（原 `wait_any` 的语义并入其中）
- `manage_task`（`write`）与 `query_info`（`read`）在列
- 三族划分覆盖全部工具、`capability` 取值合法
- 审批语义与能力族一致（`write` 全需审批、`read`/`execute` 全免审批）

---

## 口径说明

**版本号为什么是 beta.6 而非 0.1.2**：本次是**内容同步**，无新功能、无界面结构变更、
无数据格式变更。按 GUI 版本线既有惯例（beta 系列承载迭代修正），走 `0.1.1-beta.6`。

**为什么必须发这一版**：日志台是与 MCP 主包**独立发布**的（`gui-v*` tag 独立于 `v*`），
所以主包发 0.9.0 不会自动带上 GUI。不发这一版的话，装最新 npm 包的用户配旧版日志台，
会在能力视图里看到一套已经不存在的工具名。

---

## 边界（本版没做什么）

- **未改任何界面布局 / 交互 / 视觉**——只换清单数据与说明文案
- **未改日志读取、任务浏览、报告渲染**——本次不触及 `src/core/` 下的数据逻辑
  （仅 `capabilities.ts` 的静态清单）
- **未改 Rust 侧**（`src-tauri/`）——工具面是纯前端镜像，不涉及后端
- **未支持按旧工具名搜索**——不引入别名层，保持「只反映真源」的单一事实来源原则

---

## 升级说明

**直接覆盖安装即可，无迁移动作。** 应用自身的偏好设置（数据目录列表等）不受影响。

与 MCP 主包的版本对应关系：

| 日志台 | 对应的 MCP 工具面 |
|---|---|
| `0.1.1-beta.6` | tianshu-mcp **0.9.0**（8 工具） |
| `0.1.1-beta.5` 及更早 | tianshu-mcp 0.8.x（13 工具） |
