# M2 Codex rework 闭环真实记录（失败 → rework_task → 再验收）

- 日期：2026-09-07
- 环境：本机 Windows / Codex 桌面端 CLI `codex-cli 0.153.4`（`~/.codex` 登录态，真实模型运行）
- 数据目录：`%TEMP%\m2-rework\home`（临时，不触碰真实 ~/.tianshu-mcp）
- 项目：临时 git 仓库（基线含 `package.json` + `verify.mjs`；`npm test` 校验 `fibonacci(10)===55 && fibonacci(20)===6765`）
- 任务：`tsk_20260907185811_43f6b6`

## 事件流（task.jsonl，真实时间戳）

```
created → queued (10:58:11)
started 第 0 轮 agent 执行 (10:58:11)      ← Phase A: codex 创建 lib.js
succeeded 第 0 轮验收 2/2 (10:59:03)       ← diffstat +11 -0 (lib.js 新增)
   ── [Phase B] 破坏性注入 FAIL：lib.js 改为恒返 0 → 手动 verify_task：❌ failed（diffstat +1 -10）──
rework 请求 (queued, 10:59:08) 带 feedback ── ← Phase C: rework_task
started 第 1 轮 agent 执行 (10:59:08)      ← codex 读反馈修复 lib.js
succeeded 第 1 轮验收 2/2 (11:00:07)       ← diffstat +1 -1；npm test PASS
```

## 三阶段结果

| 阶段 | 动作 | 结果 | 证据 |
|---|---|---|---|
| A | `run_task(codex)` 建 lib.js → 自动验收 | `succeeded`（round 1） | report-0.md：git-diff-check PASS + test PASS（1152ms, exit 0），diffstat +11 -0 |
| B | 注入 `fibonacci()→0` → `verify_task` | `failed`（ok:false） | verify 报告：1 项检查未通过，changedFiles=[lib.js]，diffstat +1 -10 |
| C | `rework_task(taskId, feedback=失败摘要)` → codex 修复 → 轮询 | `succeeded`（round 2） | report-1.md：test PASS（1124ms, exit 0），diffstat +1 -1；修复后 `npm test` 手动复验 PASS |

## 修复产物（codex 第二轮实际改的 lib.js diff +1 -1）

注入的坏实现（`export function fibonacci() { return 0; }`）被 codex 修复为正确的迭代实现（含 `fibonacci(10)===55`、`fibonacci(20)===6765` 校验通过）。

## 意义（对应 DoD §18 #3）

真实 Codex 会话内完成 **run_task → query_task → verify_task →（失败）rework_task → 再验收 succeeded** 全链路，含一次真实的「验收失败 → 反馈喂回同一 agent → 修复 → 再验通过」。验收失败判定来自本 MCP 的自动命令检查（非人工放水），证明 rework 反馈回路有效。

## 物证位置

- 任务事件流 / 双轮 agent 日志 / 双轮报告：`%TEMP%\m2-rework\home\tasks\tsk_20260907185811_43f6b6\`（task.jsonl / agent-0.log / agent-1.log / report-0.md / report-1.md / verify-0.log / verify-1.log）
- 摘要证据：`%TEMP%\m2-rework\evidence.txt`
