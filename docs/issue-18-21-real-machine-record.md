# issue #18 / #19 / #21 真机记录

> 记录时间：2026-09-24 · 机器：Windows 10 Pro 19045 · Codex `26.917.8451.0`
> （`OpenAI.Codex_26.917.8451.0_x64__2p2nqsd0c76g0`，AUMID `OpenAI.Codex_2p2nqsd0c76g0!App`）
> 驱动方式：真实 MCP server（`buildServer`）+ 内存 transport + 真实 Codex GUI（COM 激活 + CDP），
> **非假 CDP**。数据目录与项目均为一次性 scratch（`%TEMP%\tianshu-rm*`），不触碰任何真实工程。
> 本文件沿用既有 `docs/issue-*-record.md` 的体例（记录类文档中文单语）。

---

## 1. #18 细粒度事件流 —— ✅ 已取得真机记录

**任务**：`tsk_20260924225851_8d2575`，agent=codex，model=`5.6 Terra`，`autoVerify=false`。
**任务书**：只新建 `marker.txt`（内容 `tianshu-ok`），不许改其他文件。

**结果**：终态 `succeeded`，`agentEndReason=reply_stable`；Codex **确实执行了真实改动** ——
scratch 项目里 `marker.txt` 内容为 `tianshu-ok`（8 字节，创建于 23:00，与事件时间线吻合）。

`query_task` 回传的 `recentEvents`（原样摘录）：

| 时刻 | 事件 | detail | data |
|---|---|---|---|
| 14:59:51.220 | `task_dispatched` | 第 0 轮指令已确认送达 Codex | `{round:0, seenMessage:true, seenCleared:false, seenRunning:false}` |
| 15:00:18.365 | `file_modification_started` | 停止按钮出现，Codex 开始执行（可能开始改动文件） | `{round:0, evidence:"stop_button"}` |

```json
[
  { "ts": "2026-09-24T14:59:51.220Z", "event": "task_dispatched", "state": "running",
    "detail": "第 0 轮指令已确认送达 Codex",
    "data": { "round": 0, "seenMessage": true, "seenCleared": false, "seenRunning": false } },
  { "ts": "2026-09-24T15:00:18.365Z", "event": "file_modification_started", "state": "running",
    "detail": "停止按钮出现，Codex 开始执行（可能开始改动文件）",
    "data": { "round": 0, "evidence": "stop_button" } }
]
```

**对照 issue #18 验收标准**：

- [x] 至少一个内置 GUI agent 实现事件上报 —— codex（本记录）+ traework（假 CDP 集成测试）
- [x] `query_task` 返回中可见最近 N 条事件摘要 —— 见上表
- [x] 未实现事件上报的适配器行为与既有版本一致 —— 单测/集成测试
- [x] **至少一份真机记录 —— 本文件 §1**

**一并验证的两点**：

1. 事件时间线与界面状态一致：`task_dispatched` 在「指令已确认发送」日志（14:59:51.219）之后 1ms 落盘；
   `file_modification_started` 出现在运行信号首次为 `stop_button` 的进度日志（15:00:24）之前 ——
   即「运行信号首次出现」这个判定点确实先于进度回报，符合设计。
2. **文案如实**：该事件的 detail 是「可能开始改动文件」，未声称已改动 ——

---

## 2. #19 结构化修复指令 —— ⚠️ 未取得，4 次尝试均因 GUI 环境状态失败

> **后续（2026-09-25）**：本节结论**已被取代**。Codex 升级到 `26.917.9434` 后，网络与 GUI 抖动因素消失，
> 但暴露出一条**独立的适配器缺陷**（模型触发器回读混入整条思考等级条 → `model_mismatch`，见下方「第二层」）。
> 在该缺陷修复前，`#19` 的前后对比真机记录已在 scratch 数据目录用「克隆内置 profile + 只改
> `gui.modelSwitch=false`」绕开取到 —— 见 [issue #19/#20/#21/#22 真机记录](issue-19-22-real-machine-record.md) §1。
> 本节保留为**当时的事实记录**，不改写。

**复现脚本**（一次性 scratch）：`.tmp-check/rm-stage-b.mts`（已随临时目录清理；要点见下）

- scratch 项目含 `.tianshu-mcp/acceptance.json`，注册一条 `name: "typecheck"` 的检查
  （`node verify.mjs`）；`verify.mjs` 在缺少 `fixed.txt` 时向 **stderr 输出真实 tsc 格式**的两条报错
  （`src/app.ts(12,3): error TS2322: …` 与 `(13,7): error TS2554: …`）并 exit 1。
- `run_task(agentId="codex", model="5.6 Terra", autoVerify=true, autoFixRounds=1)`，
  任务书要求 agent 新建 `fixed.txt`。
- 预期：第 0 轮验收失败 → 生成 `rework-<taskId>-r0.md` 的 2.5 节（由上述两条 tsc 格式报错提取）
  → agent 收到含指令摘要的返修消息 → 新建 `fixed.txt` → 第 1 轮通过，形成前后对比。

**5 次尝试的实际失败点**（**均发生在任务派发之前，未消耗 agent 额度**）：

| # | 时刻 | 失败点 | message |
|---|---|---|---|
| 1 | 15:05:31 | `ensureModelAndLevel` 型号/等级回读 | `model_mismatch`：`期望 5.6 Terra，实际 5.6 Terra 中 无 极低 轻度 中 高 极高 最高 Ultra 持续` |
| 2 | 15:07:37 | 同上 | 同上 |
| 3 | 15:12:10 | 等待输入框就绪 | `Codex 输入框尚未恢复`（connectStableCodex 约 3.5 分钟后超时） |
| 4 | 15:16:09 | 同上 | 同上 |
| 5 | 15:37:52 | 同上 | 同上（已先关闭残留实例**并重置受管 profile**，仍失败） |

**根因（分两层，均已实测确认）**：

**第一层（第 3~5 次）：本机对外网络中断。** 该时段实测 `api.github.com` / `chatgpt.com` /
`api.openai.com` / `www.baidu.com` 全部 `000`（TLS 握手失败），仅 `gitee.com` 200；
Codex 桌面端连不上后端时不渲染聊天输入框，`connectStableCodex` 必然超时。
第 5 次已先关闭全部残留实例、并重置受管 profile（206MB）后仍失败，反证不是 GUI 状态或 profile 损坏。
**网络恢复后的复跑证实了这一点**：输入框在 44 秒内就绪（此前 3.5 分钟都不出现）。

**第二层（网络恢复后仍失败）：Codex 26.917 的模型回读缺陷 —— 这是真正的阻塞点。**
网络恢复后连跑 3 次，每次都通过输入框与项目绑定，但都倒在 `ensureModelAndLevel`：

```
模型/等级切换回读不一致：期望 5.6 Terra，实际 5.6 Terra 中 无 极低 轻度 中 高 极高 最高 Ultra 持续
```

即**模型触发器的文本里混入了整条思考等级条**（型号 + 全部档位名）。复跑验证：

- 未指定 `reasoningLevel`：`model_mismatch`；
- 显式指定 `reasoningLevel: "中"`：日志显示「思考强度滑块已设为 medium（档位 1）」**成功**，
  但随后仍以 `model_mismatch` 失败 —— 说明**等级侧能对上，是型号侧的回读比对不通过**；
- 关闭全部实例、从干净启动重试（排除残留菜单）：仍然如此。

**该缺陷会阻断所有 codex 派发**（不只影响本次取证）。注意 §1 那次成功（14:55–15:01 UTC）
用的是**同一版本同一型号** —— 说明它与应用界面状态/版本渲染相关，不是恒定失败；
具体触发条件需要专项排查。**这已超出 issue #18~#22 的范围，建议单开 issue 跟踪。**

**结论**：**#19 的真机记录被上述模型回读缺陷阻塞**，需先修该缺陷（或改用其它 agent）才能取证。
复现要点与预期产物如下，缺陷修复后可直接重跑。

**复现要点**（网络正常时可直接重跑）：scratch 项目 + 一条 `name` 命中 typecheck 启发式、
输出**真实 tsc 格式**报错的检查（缺 `fixed.txt` 即失败）+ `autoFixRounds=1`；
预期产物：第 0 轮 `rework-<taskId>-r0.md` 的 2.5 节给出 `src/app.ts:12` / `:13` 两条指令，
agent 新建 `fixed.txt` 后第 1 轮 `report-1.json` 的 `passed=true`。

**注意**：#19 的**功能本身**已由 35 个单测/集成用例覆盖（含 tsc pretty/plain 两式解析、
diffstat 五类指令、回退语义、`repairHint` 贯通到下一轮任务书、2.5 节在计划文档中的位置），
缺的只是这一份真机留痕。

---

## 3. #21 dryRun —— 不需要真机记录

> **后续（2026-09-25）**：按「不需要」的判定仍然成立（验收标准是「有对应测试**或**真机证据」），
> 但为把四个 issue 的证据补齐，本轮**额外**跑了一份真机证据（真实 Codex GUI，源码零改动）——
> 见 [issue #19/#20/#21/#22 真机记录](issue-19-22-real-machine-record.md) §3。

该 issue 的验收标准原文是「dryRun 模式下源码零改动，**有对应测试或真机证据**」——
已由 `test/integration/dry-run.test.ts` 满足（合规预演后 `git status` 中所有变更都落在
`.tianshu-mcp/` 下、源码文件未被触碰；违规预演触发 `dry_run_violation`）。
本版按「或」取测试路径，故**不需要**真机记录。

---

## 4. 附带发现：Codex 型号名已漂移（建议修正文档）

用 `model: "GPT-5.6 Sol"` 派发时被 fail-closed 拒绝，错误信息给出了**当前真实候选**：

```
模型不存在或同名歧义：GPT-5.6 Sol（匹配 0；可见候选=默认 推荐模型集、6 Luna、5.6 Terra、5.6 Luna）
```

也就是说 `docs/codex-gui-cdp.md` / `.en.md` 里「如 `GPT-5.6 Sol`」这个示例**在 26.917 上已不存在**。
本次改用 `5.6 Terra` 后派发正常，故已同步修正两份文档的示例与 `README`/`ARCHITECTURE` 中引用该型号的位置
（仅改示例值，不改代码；适配器本身是 fail-closed 的，遇到不存在的型号会明确报出候选列表，行为正确）。

---

## 5. 真机副作用的清理说明

跑真机必然留下痕迹，如实列出以便你确认：

| 副作用 | 位置 | 清理方式 |
|---|---|---|
| 受管 Codex 实例（窗口/进程） | `%LOCALAPPDATA%\tianshu-mcp\codex-gui\profile` | **已全部关闭**（`Get-Process ChatGPT` 计数为 0；用户原本未运行 Codex，故无自身会话受影响） |
| 受管 profile **被重置**（排查第 5 次失败时删除，206MB） | 同上 | 这是 tianshu-mcp 自建的**专用隔离 profile**（非用户自己的 Codex 数据），应用下次启动会自动重建；**其中原有的 Codex 登录态一并丢失**，下次真机运行可能需要重新登录一次。如实记录以备核对 |
| 登记的 scratch 项目（4 个） | Codex 项目列表 | 需在 Codex 里手动删除；**改动前已自动备份** `~/.codex/.codex-global-state.json.tianshu-mcp-backup.json` |
| scratch 项目与临时数据目录 | `%TEMP%\tianshu-rm*` / `tianshu-rmb-*` / `tianshu-rm19-*` | 已删除 |
| ChatGPT 额度 | —— | 仅 §1 的成功任务消耗了一次轻量任务（新建一个 8 字节文件）；§2 的 5 次尝试均在派发前失败，**未消耗** |
