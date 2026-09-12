---
name: tianshu-mcp
description: 让外部 AI-Agent（codex/zcode/traework）做项目开发并自动验收、失败返修的编排方法。当任务需要"叫一个 AI-Agent 去开发/改代码/补测试并验收，不行就返修"时先加载本技能：按它用 mcp__tianshu-mcp__ 的 9 个工具（run_task/continue_task/query_task/list_tasks/get_task_report/verify_task/rework_task/cancel_task/get_profiles）派活、暂停继续、轮询、查历史、读验收报告、驱动返修。小改动或纯问答不需要。
triggers: '开发|编码|写代码|改代码|实现功能|加功能|修复|重构|补测试|写测试|验收|返修|返工|重做|自动验收|自动返修|任务书|ai.?agent|子代理|外部.?agent|agent|codex|zcode|traework|claude|编排|项目开发|派活|派单'
---

# tianshu-mcp 编排技能：叫外部 AI-Agent 开发并验收

**首行强指令**：你正处理"派外部 AI-Agent 开发并验收、失败返修"类任务。动手前先通读本技能全文；任务书模板、三种 agent 派活示例、meta 块字段解读、返修提示语模板在同目录 `usage-examples.md`，需要时用读取文件工具查看，长方法论不必背。

## 何时不要用（边界）

- 小改动 / 纯问答 / 只读代码分析：不需要本技能与 MCP，直接做。
- 本 MCP 未连接：工具面里看不到 `mcp__tianshu-mcp__*` 时，先提示用户按天枢 `config.json → mcp.servers.tianshu-mcp` 接入（见项目 docs/tianshu-integration.md），**不要空转**，更不要假装调用。

## 1. 选 agent（三者均为 GUI 驱动：CDP 控制桌面端，非 CLI）

- `codex`（默认，推荐先试）：ChatGPT 桌面端（MSIX 商店包，COM 激活 + CDP，复用 `~/.codex` 登录态）。Windows 已就绪，macOS 未验证前为 `research`。**model 必填**（面板可选模型名，如 `GPT-5.6 Sol`）；可选 `reasoningLevel`（低/中/高 或 low/medium/high）、`planDoc`（计划文档路径）、`designSystem`（设计系统目录路径）；**不支持 `mode`**。冷启动实测 60–90 秒，首轮等待偏慢属正常。
- `zcode`：ZCode 桌面端（Electron CDP）。要求已安装、已登录；**model 必填**且格式为 `供应商/模型`（如 `DeepSeek/deepseek-flash`）；**不支持 `mode`**；发送前确认「完全访问」权限模式。macOS 真机证据补齐前 profile 为 `research`，用 `get_profiles` 读取当前机器实际探测结果。
- `traework`：TraeWork（TRAE SOLO CN）桌面端。要求已登录、窗口保持可见。`model` 可选；`mode` 可选（`Work`/`Code`/`Design`；不传时从任务书文本识别「切换 X 模式」，识别不到保持 `Work`；实现顺序为「新建会话 → 切模式 → 在目标模式内绑定项目」）。
- 不确定时问用户，或读项目 `projects.json` 的 `defaultAgentId`；用 `get_profiles` 看当前实际可用性（含可执行探测与未安装提示）。

## 2. 派活：run_task

参数要点：

- `projectPath`：**必须**是项目绝对路径（如 `D:\repo\my-app`）。
- `task`：自然语言任务书。要写清 **目标 / 验收要点 / 约束 / 相关文件 / 上下文**，模板见 usage-examples.md。
- `agentId`：默认取项目 default 或 codex；`model`/`mode`/`reasoningLevel` 等约束见 §1。
- `context`：补充上下文/约束文本，会以【上下文与约束】拼进 agent 初始指令。task/context 中反引号包裹或路径形态的引用会在发送前校验（必须存在且在项目内），写错立即报错。
- `autoVerify: true`：跑完自动验收（命令检查 + 代码分析）。
- `autoFixRounds: N`（0–10）：>0 才开启失败自动返修。优先级：调用参数 > agent 缺省（codex 5、zcode 2）> server 默认 0（不开启）。
- `taskTimeoutMs`：任务级超时；缺省 30 分钟。

返回立刻给 `taskId`（异步契约）。**不要把任务书当同步调用等结果。**

## 3. 轮询与查询

- `query_task(taskId, tailLines?)` 间隔约 5–10 秒，看 agent 日志尾与状态（tailLines 缺省返回日志末 40 行）。
- 查历史任务用 `list_tasks(projectPath?, status?, limit?)`（limit 缺省 50，上限 200）。
- 同一项目勿重复派单：每项目串行 + 全局并发（默认 2），重复派会排队，反而更慢。
- 状态语义：`queued` 排队中 / `running` 开发中 / `verify_start` 验收中 / `fixing` 返修中；`needs_user` 表示 agent 在等用户（按 §4 处理）；终态见 §5。

## 4. needs_user：continue_task

meta 块中 `needsUserKind` 给出等待类型、`pendingQuestion` 给出问题原文：

- `agent_question`（zcode）：agent 提了问题 → 用 `continue_task(taskId, message=<答案>)`，message 会发到原会话。
- `close_existing_instance` / `system_permission`（zcode）：需用户先处理（关闭旧实例 / 授系统权限）→ 用户处理完后调 `continue_task(taskId, message=<已处理说明>)`，message 仅作为已处理的确认。
- `user_confirmation`（codex）：Codex 停在等待用户确认界面（方案确认卡/订阅确认等），turn 暂停而非结束 → 用户在 **Codex 窗口**完成处理后调 `continue_task(taskId, message=<已处理说明>)`；恢复后仅重新接入观察 GUI 内运行（**不发送消息**），turn 完成/失败由观察得出。
- `login_required`（codex/zcode）：Codex 需要登录 → 在窗口完成登录后 `continue_task(taskId, message=<已处理说明>)`；codex 会复检环境后重新派发任务书。

禁止新开会话冒充恢复。

## 5. 终态解读

- `succeeded`：用 `get_task_report(taskId, round?)`（round 为 0-based 报告轮次，缺省最新）取 changedFiles / diffstat / checks，向用户汇报变更与结论。
- `failed`：**未开自动返修或硬失败**。读 meta 的 `errorType` 与 `get_task_report` 定位失败 checks；如可修 → `rework_task(taskId, feedback=失败摘要)` 手动续修（feedback 会作为追加指示给下一轮 agent）；再轮询或 `verify_task`。
- `needs_attention`：自动返修轮次已用尽仍失败。同样先读报告，给**针对性** feedback 调 `rework_task`（不要无脑重复同样的话）。多次仍不过或不可修：如实向用户汇报并给建议（人工看报告 / 换 agent / 缩小任务），**不要反复空转重试**。
- `cancelled` / `interrupted`：用户取消或超时/中断（meta 的 `abortSource` 区分 user/shutdown/timeout/internal）。`running` 卡死可用 `cancel_task(taskId, reason)` 终止：CLI agent 终止进程树；GUI agent（codex 等）尽力点击界面停止按钮并等待 GUI 空闲（有界超时），取消文案会如实标注 GUI 侧是否已停止——若标注"未确认停止"，Codex 窗口内的运行可能仍在继续，需人工检查，**不要在确认停止前重派同项目任务**（会新旧交叠；重派护栏也会直接拒绝派发）。

## 6. 验收报告解读要点

- 结果文本末尾有 `---tianshu-mcp-meta---` 块（JSON），天枢可正则抽取；字段读法示例见 usage-examples.md。
- 报告全文走 `get_task_report`：`checks[]`（每项 PASS/FAIL/SKIP + 输出尾部）、`analysis`（变更清单、diffstat、可疑标记命中计数、超大单文件改动告警）。
- `verify_task` 可对任务或任意项目独立验收（**不改源码、无需审批**）：`taskId` / `projectPath` 二选一；`extraChecks` 临时加验（`checksMode` 默认 append 追加，`replace` 才替换）；`baselineRef` 可填任务 ID（用该任务动工前基线）或 git ref（如 `HEAD~1`）；独立 projectPath 不设 baselineRef 时按当前基线做健康检查。
- 验收命令优先级：`extraChecks` > 项目 `.tianshu-mcp/acceptance.json` > projects.json 管理员补录 > 按技术栈推导的默认集。
- 注意：代码分析是确定性规则（TODO/FIXME、console.log/debugger、疑似密钥形态、超大改动），**不是** LLM 评审——命中仅提示人工，不等同于任务失败。
- changedFiles/diffstat 都相对**动工前 git 基线**（run_task 自动采集，含未跟踪新增）。MCP 不自动 commit/stash；需要回滚时由用户基于报告决定。

## 7. 纪律

- 写/执行类工具（run/cancel/rework/continue）需审批：不绕过、不替用户代点同意；query/list/report/verify/get_profiles 为只读，无需审批。
- 不代替外部 agent 手改项目代码；不改用户 git 历史；不读取/转发任何 agent 密钥（登录态各 agent 自持）。
- 验收命令来自白名单式配置、按 argv 分词执行，不做 shell 注入。

## 快速上手清单

1. `get_profiles` → 确认目标 agent 可用。
2. `run_task(projectPath, task, agentId=codex, model=GPT-5.6 Sol, autoVerify=true, autoFixRounds=5)` → 拿 taskId（model 以 get_profiles/面板实际为准）。
3. `query_task(taskId)` 每 ~8 秒轮询到终态；遇 `needs_user` 按 §4 处理。
4. 终态处理见 §5；汇报时带 `get_task_report` 的 changedFiles 与 diffstat。
