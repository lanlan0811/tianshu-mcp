# DoD #8 真实 Tianshu 会话实测记录（技能加载 + MCP 工具 + 完整任务闭环）

- 日期：2026-09-07（深夜追加）
- 环境：Tianshu rivet runtime（`D:\Tianshu\rivet-runtime\main.js`）**真实 serve 会话**；模型 deepseek-v4-pro；独立临时 RIVET_HOME（含 stub agent profile 与安装的 tianshu-mcp 技能）
- 验证对象：真实 agent 会话内 **skill 加载**、**mcp__tianshu-mcp__* 工具面**、**run_task→query_task→验收→报告 全闭环**

## 1. 会话与工具面（serve 日志）

```
Rivet Runtime API listening on http://localhost:18333
[server:WARN] MCP: 1 servers connected, 8 tools   ← tianshu-mcp 8 工具已注册
```

会话 meta：`toolCallCount`、model=`deepseek-v4-pro`、status=active。

## 2. skill 显式加载（session tool-result-trace.jsonl）

真实 agent 在该会话中：
- `skill` 工具调用成功（isError:false，contentLen=2738 = SKILL.md 全文），随后成功释放；
- 模型自述：**`tianshu-mcp` 在 available-skills 列表**，`skill` 工具成功返回完整编排指令（派活/轮询/验收/返修全流程）。

## 3. MCP 工具实际调用（同 trace）

```
{"name":"mcp__tianshu-mcp__get_profiles","isError":false,"contentLen":885,...}
{"name":"mcp__tianshu-mcp__get_profiles","isError":false,...}
```

模型自述：`mcp__tianshu-mcp__*` 系列工具全部在工具面中且连通可用；`get_profiles` 返回 codex/stub 可用、zcode/traework unsupported。

## 4. 完整任务闭环（run_task → query_task → succeeded → report）

同 serve 真实会话，模型编排 stub agent 在临时 git 项目（`C:/Users/Lenovo/AppData/Local/Temp/dod8-proj`，验收 = `node check.mjs` 校验 done.txt==PASS）完成：

- `run_task` → `tsk_20260907224648_a04e3c`（queued）
- 轮询 `query_task` → **succeeded**（第 0 轮）
- `get_task_report` → changedFiles=`done.txt`，diffstat=`+2 -0`
- 验收 2/2 全绿：`git-diff-check` PASS、`done-marker`（node check.mjs）PASS

### 物证（已落盘）

- 任务产物：`report-0.md` / `report-0.json` / `agent-0.log` / `task.jsonl` / `baseline.json` / `verify-0.log`
- 验收报告摘录：`结论: 通过 ✅`；`[PASS] git-diff-check`、`[PASS] done-marker`；`变更 0 个已跟踪 + 1 个未跟踪（done.txt）`；`diffstat +2 -0`

## 5. 结论

修复计划 §12.7 / DoD #8 的**可自动化部分全部实测通过**：
- ✅ 真实 Tianshu agent 会话内 skill 可加载（available-skills 命中 + `skill` 调用成功返回全文）
- ✅ `mcp__tianshu-mcp__*` 工具在真实会话工具面并成功调用
- ✅ 完整任务闭环（stub run_task → 验收 succeeded → 报告）真实执行并落盘

> 注：本记录用独立临时 RIVET_HOME（含 deepseek key、stub profile、tianshu-mcp 技能）运行真实 rivet serve 会话达成，与桌面 GUI 共用同一 runtime 与同一 MCP 工具注册机制；GUI 桌面内手工点按仍可由用户复现，但工具面/技能/任务闭环的机制性证据已完备。
