# tianshu-mcp v0.5.9 发布说明

[English](release-v0.5.9.en.md)

**修复：server 退出 / 重启归档路径上，GUI agent 的终态不再谎报已停止**（[issue #14](https://github.com/lanlan0811/tianshu-mcp/issues/14)）。

## 问题

`driver="gui"` 的 agent（codex / zcode / kimicode / qoder / traework）是**外部桌面应用**，`tianshu-mcp` 对其进程**没有所有权**：abort 之后，适配器至多"尽力点击界面停止按钮"，而且只有 Codex / Kimi Code / Qoder CN 有停止能力。旧实现里：

- `persistInterrupted()` 对所有活动任务统一写 `lastMessage = "server 退出，进程已终止"`；
- `initialize()` 归档重启遗留任务只写「server 重启遗留（启动时归档，不续跑）。」

于是快照声称进程已终止，而 ZCode / Codex 窗口里的任务**可能仍在自主运行、继续修改用户项目**；server 重启后这些任务既没有被观察、也没有任何提示人工检查的文案。风险定位：**编排器已死 + GUI 持续改用户项目 + 无人观察 = 效应残留**（外部任务终止 ≠ 外部效应终止）。

## 修复

**终态文案按 `driver` 分流（spawn 语义与 GUI 语义不再混用）**

| 场景 | 终态文案 |
|---|---|
| spawn 子进程 | `server 退出，进程已终止`（不变，`killTree` 确实终止了进程树） |
| GUI，已确认界面空闲 | `server 退出；已确认 <窗口名> 内运行停止。` |
| GUI，点击过但未确认空闲 | `server 退出；<窗口名> 内运行未确认停止，窗口中的任务可能仍在继续，请人工打开 <窗口名> 确认无残留运行。` |
| GUI，无停止结果（如 ZCode / TraeWork 无停止能力） | `server 退出；<窗口名> 内运行无停止结果可确认，窗口中的任务可能仍在继续，请人工打开 <窗口名> 确认无残留运行。` |
| 重启归档的 GUI 遗留任务 | `server 重启遗留（启动时归档，不续跑）；<窗口名> 内运行未确认停止，… 请人工打开 <窗口名> 确认无残留运行。` |

**判定只有一条**：适配器回报 `guiStop.idle === true` 才允许说"已确认停止"；`idle === false` 与"字段缺失"都按未确认处理。取消路径（issue #6）与中断路径共用同一个 `guiStopDisclosure()`，不再有两套标准。

**shutdown 时把"尽力停止"跑完再落终态**

- 新配置 `config.json` → `shutdown.guiStopWaitMs`（默认 `15000`，可覆盖）：`shutdownInterrupt()` 给 GUI 任务一份**全局共享**的等待预算（全部 GUI 任务共享一份，退出耗时不随任务数增长），等到期或 orchestrator 先落终态为止；spawn 类保持原 2s 预算不变。
- 若 orchestrator 在预算内落了终态（携带更精确的适配器结果），管理器直接让位，保留其文案。

**重启归档如实 + 人工确认路径**

- `initialize()` 归档遗留 GUI 任务时追加人工检查提示并置 `guiResidualUnconfirmed`。
- 结构化字段：`TaskMeta.interruptedCleanStop`（是否已确认停止）、`TaskMeta.guiResidualUnconfirmed`（重启归档待确认）；`query_task` / `list_tasks` 的 meta 块新增 **`guiStopUnconfirmed`**，编排方据此**禁止直接重派**同项目任务。
- 确认方式**不新增工具**：人工核实窗口无残留运行后调用 `cancel_task`，清除待确认标记并追加 `gui_residual_acknowledged` 事件，**不改终态与 `errorType`**。

**窗口名不再硬编码**：改由 `profile.displayName` 派生（剥掉说明性括号段与通用后缀，剥空则退回原名；无 `displayName` 回退 `agentId`）。旧实现把 `zcode`/`qoder` 一律写成 "Codex"，本身即失真。

## 不做的事（明确边界）

- **不在 `initialize()` 里自动 CDP 重连去点停止**：适配器对无归属证明的实例是 fail-closed 的（宁可不动也不误杀用户会话），重启时又没有会话锚点；自动动手风险高于收益。本次以"如实标注 + 人工确认"堵住效应残留，符合红线 8 的表述要求。
- 不新增 MCP 工具（工具数仍为 11）、不改状态机 `TRANSITIONS`、不改重派护栏语义、不改 `run_task` / `continue_task` 参数。

## 兼容性

**PATCH 版本**：`run_task` / `continue_task` / `cancel_task` 等工具的入参不变；`TaskStatus` 取值不变；新增字段与配置项全部可选，旧 `task.json` 快照缺字段时按"未确认"处理（保守方向偏安全）。`cancel_task` 对已终态任务的行为从"无动作"扩展为"可清除 GUI 待确认标记"，返回文本相应变化。

## 门禁与证据

- 新增单元用例 9 项（`test/unit/gui-stop-disclosure.test.ts`）与集成用例 5 项（`test/integration/gui-shutdown-interrupt.test.ts`），覆盖三条 shutdown 结果路径、重启归档 + `cancel_task` 确认清除、spawn 类不受 GUI 分流影响。
- 集成用例以**真实 `CodexGuiAdapter` 子类**注入脚本 adapter（`AgentAdapterRegistry.ensureAdapterFor()` 会按实现类重建非本类 adapter，普通实现会被覆盖——这一点已写入用例注释）。
- 类型检查、lint（`--max-warnings 0`）、全量测试、构建、严格 stdio 检查全部通过。

相关文档：[项目 README](../README.md)｜[CHANGELOG](../CHANGELOG.md)｜[架构说明](../ARCHITECTURE.md)｜[交接文档](../HANDOFF.md)｜[实施计划](plans/issue-14-gui-shutdown-interrupt-plan.md)
