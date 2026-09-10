---
name: tianshu-mcp
description: 让外部 AI-Agent（codex/zcode/traework）做项目开发并自动验收、失败返修的编排方法。当任务需要"叫一个 AI-Agent 去开发/改代码/补测试并验收，不行就返修"时先加载本技能：按它用 mcp__tianshu-mcp__run_task/continue_task/query_task/verify_task/rework_task 派活、暂停继续、轮询、读验收报告、驱动返修。小改动或纯问答不需要。
triggers: '开发|编码|写代码|改代码|实现功能|加功能|修复|重构|补测试|写测试|验收|返修|返工|重做|ai.?agent|子代理|外部.?agent|agent|codex|zcode|traework|claude|编排|项目开发|派活'
---

# tianshu-mcp 编排技能：叫外部 AI-Agent 开发并验收

**首行强指令**：你正处理"派外部 AI-Agent 开发并验收、失败返修"类任务。动手前先通读本技能全文；任务书模板、meta 块解读示例、返修提示语模板在同目录 `usage-examples.md`，需要时用 `read_file` 读取，长方法论不必背。

## 何时不要用（边界）

- 小改动 / 纯问答 / 只读代码分析：不需要本技能与 MCP，直接做。
- 本 MCP 未连接：工具面里看不到 `mcp__tianshu-mcp__*` 时，先提示用户按天枢 `config.json → mcp.servers.tianshu-mcp` 接入（见项目 docs/tianshu-integration.md），**不要空转**，更不要假装调用。

## 1. 选 agent

- `codex`：Codex 桌面端自带 CLI（通用编码，默认，推荐先试）。
- `zcode`：ZCode 桌面端独立 CDP GUI adapter。要求已安装、已登录；`model` 必须为 `供应商/模型`，发送前确认“完全访问”。双平台真机证据补齐前 profile 为 `research`，用 `get_profiles` 读取当前机器实际探测结果。
- `traework`：TraeWork（TRAE SOLO CN）桌面端，**GUI 驱动**（CDP）。适合需要 TraeWork 原生能力的任务；要求 TraeWork 已登录、窗口可见。可用 `model` 指定模型（如 `GLM-5.3`）、`mode` 指定面板模式（`Work`/`Code`/`Design`）。
- 不确定时问用户，或读项目 `projects.json` 的 `defaultAgentId`。用 `get_profiles` 看当前实际可用性（会做可执行探测）。

## 2. 派活：run_task

参数要点：

- `projectPath`：**必须**是项目绝对路径（如 `D:\repo\my-app`）。
- `task`：自然语言任务书。要写清 **目标 / 验收要点 / 约束 / 相关文件 / 上下文**，模板见 usage-examples.md。
- `agentId`：默认取项目 default 或 codex。
- `model`：TraeWork 可选；ZCode 必填且格式为 `供应商/模型`（如 `DeepSeek/deepseek-flash`）。
- `mode`：可选，仅 GUI 类 agent（`traework`）生效，指定面板模式 `Work` / `Code` / `Design`；不传时从任务书文本识别（如「切换到 Code 模式」），识别不到则保持 `Work`。实现顺序为「新建会话 → 切模式 → 在目标模式内绑定项目」。
- `autoVerify: true`：跑完自动验收（命令检查 + 代码分析）。
- `autoFixRounds: N`：>0 才开启失败自动返修；ZCode 缺省为 2，其余 agent 仍按 server 默认。
- `taskTimeoutMs`：任务级超时，缺省 30 分钟，长任务可调大。

返回立刻给 `taskId`（异步契约）。**不要把任务书当同步调用等结果。**

## 3. 轮询：query_task

- `query_task(taskId)` 间隔约 5–10 秒，看 agent 日志尾与状态。
- 同一项目勿重复派单：每项目串行，重复派会排队，反而更慢。
- 状态语义：
  - `queued` 排队中 / `running` 开发中 / `verify_start` 验收中 / `fixing` 返修中；
  - `needs_user` 表示 ZCode 正在等待问题回答、关闭旧实例、登录或系统权限；按提示处理后调用 `continue_task(taskId, message)`，禁止新开会话冒充恢复；
  - 终态见下。

## 4. 终态解读

- `succeeded`：用 `get_task_report(taskId)` 取 changedFiles / diffstat / checks，向用户汇报变更与结论。
- `failed`：**未开自动返修或硬失败**。读 `query_task` 的 meta 与 `get_task_report` 定位失败 checks；如可修 → `rework_task(taskId, feedback=失败摘要)` 手动续修（feedback 会给下一轮 agent）；再轮询/`verify_task`。
- `needs_attention`：自动返修轮次已用尽仍失败。同样先读报告，给**针对性** feedback 调 `rework_task`（不要无脑重复同样的话）。多次仍不过或不可修：如实向用户汇报并给建议（人工看报告/换 agent/缩小任务），**不要反复空转重试**。
- `running` 卡死/超时：`cancel_task(taskId, reason)` 终止（kill 进程树）。

## 5. 验收报告解读要点

- 结果文本末尾有 `---tianshu-mcp-meta---` 块（JSON），天枢可正则抽取。字段：`ok / status / round / changedFiles / diffstat / reportFiles / logFile / message`。
- 报告全文走 `get_task_report`：`checks[]`（每项 PASS/FAIL/SKIP + 输出尾部）、`analysis`（变更清单、diffstat、可疑标记命中计数、超大单文件改动告警、结构性核对提示）。
- 注意：代码分析是确定性规则（TODO/FIXME、console.log/debugger、疑似密钥形态、超大改动），**不是** LLM 评审——命中仅提示人工，不等同于任务失败。
- changedFiles/diffstat 都相对**动工前 git 基线**（run_task 自动采集）。MCP 不自动 commit/stash；需要回滚时由用户基于报告决定。

## 6. 纪律

- 写/执行类工具（run/cancel/rework）需审批：不绕过、不替用户代点同意。
- 不代替外部 agent 手改项目代码；不改用户 git 历史；不读取/转发任何 agent 密钥（登录态各 agent 自持）。
- 验收命令来自白名单式配置，不做 shell 注入。

## 快速上手清单

1. `get_profiles` → 确认目标 agent 可用。
2. `run_task(projectPath, task, agentId=codex, autoVerify=true, autoFixRounds=2)` → 拿 taskId。
3. `query_task(taskId)` 每 ~8 秒轮询到终态。
4. 终态处理见上；汇报时带 `get_task_report` 的 changedFiles 与 diffstat。
