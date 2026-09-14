---
name: tianshu-mcp
description: 让外部 AI-Agent（codex/zcode/traework）做项目开发并自动验收、失败返修的编排方法。当任务需要"叫一个 AI-Agent 去开发/改代码/补测试并验收，不行就返修"时先加载本技能：按它用 mcp__tianshu-mcp__ 的 11 个工具（run_task/continue_task/query_task/list_tasks/get_task_report/verify_task/rework_task/cancel_task/get_profiles/prepare_visual_baseline/approve_visual_baseline）派活、暂停继续、轮询、查历史、读验收报告、驱动返修、管理视觉基准，并按硬失败错误码快速定位卡点。小改动或纯问答不需要。
triggers: '开发|编码|写代码|改代码|实现功能|加功能|修复|重构|补测试|写测试|验收|返修|返工|重做|自动验收|自动返修|任务书|ai.?agent|子代理|外部.?agent|agent|codex|zcode|traework|claude|编排|项目开发|派活|派单'
---

# tianshu-mcp 编排技能：叫外部 AI-Agent 开发并验收

**首行强指令**：你正处理"派外部 AI-Agent 开发并验收、失败返修"类任务。动手前先通读本技能全文；任务书模板、四种 agent 派活示例、meta 块字段全表、错误码速查、返修提示语模板在同目录 `usage-examples.md`，需要时用读取文件工具查看，长方法论不必背。

## 工具面（11 个）

| 工具 | 能力 / 审批 | 作用 |
|---|---|---|
| `run_task` | write + 审批 | 派活给外部 agent 开发；异步返回 taskId |
| `query_task` | read | 轮询状态与 agent 日志尾 |
| `list_tasks` | read | 按项目/状态查历史任务 |
| `get_task_report` | read | 读某轮验收报告全文（Markdown） |
| `verify_task` | read | 对任务或任意项目独立验收（不改源码） |
| `rework_task` | write + 审批 | 手动返修；对视觉阻塞任务先重新验收 |
| `cancel_task` | write + 审批 | 取消运行中的任务 |
| `continue_task` | write + 审批 | 恢复 `needs_user`（仅 codex/zcode） |
| `get_profiles` | read | 查看 agent 适配与可执行探测结果 |
| `prepare_visual_baseline` | write + 审批 | 视觉基准**候选**准备（截图或导入参考图） |
| `approve_visual_baseline` | write + 审批 | 用户审阅后批准候选，写入正式基准 |

## 何时不要用（边界）

- 小改动 / 纯问答 / 只读代码分析：不需要本技能与 MCP，直接做。
- 本 MCP 未连接：工具面里看不到 `mcp__tianshu-mcp__*` 时，先提示用户按天枢 `config.json → mcp.servers.tianshu-mcp` 接入（见项目 docs/tianshu-integration.md），**不要空转**，更不要假装调用。

## 1. 选 agent（默认均为 GUI 驱动：CDP 控制桌面端，非 CLI）

- `codex`（默认，推荐先试）：ChatGPT/Codex 桌面端。**model 必填**（面板可选模型名，如 `GPT-5.6 Sol`）；可选 `reasoningLevel`（低/中/高 或 low/medium/high）、`planDoc`（计划文档路径）、`designSystem`（设计系统目录路径）；**不支持 `mode`**（传了直接报错）。Windows 经 MSIX COM 激活 + CDP（冷启动实测 60–90 秒，首轮偏慢属正常）；macOS 直接 spawn `ChatGPT.app` + CDP。
- `zcode`：ZCode 桌面端（Electron CDP）。要求已安装、已登录；**model 必填**且格式为 `供应商/模型`（如 `DeepSeek/deepseek-flash`）；**不支持 `mode`**；发送前确认「完全访问」权限模式。
- `traework`：TraeWork（TRAE SOLO CN）桌面端。要求已登录、窗口保持可见。**`model` 可选**；**`mode` 可选**（`Work`/`Code`/`Design`；不传时从任务书文本识别「切换 X 模式」，识别不到保持 `Work`；实现顺序为「新建会话 → 切模式 → 在目标模式内绑定项目」）。`continue_task` **不支持 traework**。
- `codex-cli`（可选，用户自建 profile，非内置）：不想依赖 GUI 自动化时的**无头**路径，走 `codex exec`。需用户先在数据目录 `agent-profiles.json` 加一个 `driver=spawn` 的 profile（示例见 README「macOS 无头路径：codex-cli」）。`model` 参数对它**不生效**，模型取 CLI 的 `~/.codex/config.toml`。注意 CLI 版本：≤0.130.0 签名证书已被吊销，macOS Gatekeeper 会直接 SIGKILL，需 ≥0.154.0。
- 状态语义：`ready` 表示当前平台闭环已验证；`research` 表示已实现但矩阵未覆盖（**仍可执行**）。内置取值：`traework` 为 `ready`，`zcode` 为 `research`，`codex` 在 Windows 为 `ready`、在 darwin 为 `research`（macOS 上 `codex`/`zcode` 基本闭环已真机验证，但取消/返修/新建项目矩阵未覆盖）。注意 `ready` 不等于全平台无限制：TraeWork 在 macOS 下的可执行探测与原生对话框驱动仍 fail-closed（见 README 计划中条款）。
- 不确定时问用户，或读项目 `projects.json` 的 `defaultAgentId`；用 `get_profiles` 看当前机器实际探测结果（含可执行探测、未安装提示与用户自定义 profile）。

## 2. 派活：run_task

参数要点：

- `projectPath`：**必须**是项目绝对路径（如 `D:\repo\my-app`），且提交即过安全闸门（见 §2.1）。
- `task`：自然语言任务书。要写清 **目标 / 验收要点 / 约束 / 相关文件 / 上下文**，模板见 usage-examples.md。
- `agentId`：默认取项目 default 或 codex；`model`/`mode`/`reasoningLevel` 等约束见 §1（按 agent 生效，传错会被明确拒绝）。
- `context`：补充上下文/约束文本，会以【上下文与约束】拼进 agent 初始指令。task/context 中反引号包裹或路径形态的引用会在发送前校验（必须存在且在项目内），写错立即报错。
- `autoVerify: true`：跑完自动验收（命令检查 + 代码分析；启用视觉的项目再加视觉检查）。
- `autoFixRounds: N`（0–10）：>0 才开启失败自动返修。优先级：调用参数 > agent 缺省（codex 5、zcode 2；traework 未设缺省）> server 默认 0（不开启）。
- `taskTimeoutMs`：任务级超时。优先级：调用参数 > profile 的 `timeoutMs` > server 默认 30 分钟。

返回立刻给 `taskId`（异步契约）。**不要把任务书当同步调用等结果。**

### 2.1 projectPath 安全闸门（v0.4.0 起）

`run_task` / `verify_task` 提交时校验，不通过直接报错（属**基础设施拒绝**，不是 agent 失败，改路径重试即可）：

- 必须是绝对路径且是**已存在**的目录；`realpath` 消除符号链接（macOS `/tmp` → `/private/tmp`），回执会明示解析来源。
- 拒绝**用户主目录本身**，以及根级/系统目录（`/`、`/etc`、`/usr`、`/var`、`/tmp`、`/Users`、`C:\`、`C:\Windows`、`C:\Users`、`C:\Program Files`、`D:\` 等，含 macOS `/private/*` realpath 形态）。**只挡精确相等的根**，其子目录（`/tmp/xxx`、`D:\repo\app`）正常可用。
- 目标是 git 仓库且有未提交变更时，回执追加共处警示（提示该仓库同时有人的改动，agent 的 diff 不会与它们混同，但基线不同）。

不要在用户没给绝对路径时擅自猜路径；宁先问用户。

## 3. 轮询与查询

- `query_task(taskId, tailLines?)` 间隔约 5–10 秒，看 agent 日志尾与状态（tailLines 缺省返回日志末 40 行）。
- 查历史任务用 `list_tasks(projectPath?, status?, limit?)`（limit 缺省 50，上限 200）。
- 同一项目勿重复派单：每项目串行 + 全局并发（默认 2），重复派会排队，反而更慢。
- 状态语义：`queued` 排队中 / `running` 开发中 / `verify_start` 验收中 / `fixing` 返修中；`needs_user` 表示 agent 在等用户（按 §4 处理）；终态见 §5。

## 4. needs_user：continue_task

meta 块中 `needsUserKind` 给出等待类型、`pendingQuestion` 给出问题原文。**仅 codex/zcode 可恢复**，traework 会被拒绝。

- `agent_question`（zcode）：agent 提了问题 → 用 `continue_task(taskId, message=<答案>)`，message 会发到原会话。
- `close_existing_instance` / `system_permission` / `setup_recovery`（zcode）：需用户先处理（关闭旧实例 / 授系统权限 / 在 ZCode 里确认目标项目或手工完成绑定）→ 用户处理完后调 `continue_task(taskId, message=<已处理说明>)`，message 仅作为已处理的确认（**不会**当问题发送）。
- `user_confirmation`（codex）：Codex 停在等待用户确认界面（方案确认卡/订阅确认等），turn 暂停而非结束 → 用户在 **Codex 窗口**完成处理后调 `continue_task(taskId, message=<已处理说明>)`；恢复后仅重新接入观察 GUI 内运行（**不发送消息**），turn 完成/失败由观察得出。
- `login_required`（codex/zcode）：需要登录 → 在窗口完成登录后 `continue_task(taskId, message=<已处理说明>)`；codex 会复检环境后重新派发任务书（新会话 + 项目绑定 + 完整初始指令）。

限制与纪律：

- `continue_task` 只接受 `needs_user` 状态；其他状态会被明确拒绝。
- codex 只支持 `login_required` / `user_confirmation` 两种等待类型，其余会拒绝。
- zcode `agent_question` 恢复依赖原会话定位信息（`zcodeSessionId`）；定位信息丢失时明确拒绝恢复，**不会**擅自打开"最近会话"。
- 禁止新开会话冒充恢复。

## 5. 终态解读

- `succeeded`：用 `get_task_report(taskId, round?)`（round 为 0-based 报告轮次，缺省最新）取 changedFiles / diffstat / checks，向用户汇报变更与结论。
- `failed`：**未开自动返修或硬失败**。读 meta 的 `errorType` 与 `get_task_report` 定位失败 checks；如可修 → `rework_task(taskId, feedback=失败摘要)` 手动续修（feedback 会作为追加指示给下一轮 agent）；再轮询或 `verify_task`。
- `needs_attention`：两类含义——①自动返修轮次已用尽仍失败；②**验收阻塞**（配置/完整性错误，或视觉阻塞如缺基准、页面不可达、资源被拦）。同样先读报告，给**针对性** feedback 调 `rework_task`。视觉阻塞时 `rework_task` 会**先重新验收、不先启动 agent**：通过即结束，仍阻塞则回到 `needs_attention`，只有出现真实缺陷才启动返修。多次仍不过或不可修：如实向用户汇报并给建议（人工看报告 / 换 agent / 缩小任务），**不要反复空转重试**。
- `cancelled` / `interrupted`：用户取消或超时/中断（meta 的 `abortSource` 区分 user/shutdown/timeout/internal）。`running` 卡死可用 `cancel_task(taskId, reason)` 终止：CLI agent 终止进程树；GUI agent（codex/zcode/traework）尽力点击界面停止按钮并等待 GUI 空闲（有界超时），取消文案会如实标注 GUI 侧是否已停止——若标注"未确认停止"，窗口内的运行可能仍在继续，需人工检查，**不要在确认停止前重派同项目任务**（会新旧交叠；重派护栏也会以 `instance_busy` 直接拒绝派发）。
- `needs_user` 状态下取消：run 协程已退出、CDP 已断开，MCP 侧无法再点 GUI 停止按钮，取消文案会提示"GUI 内可能仍有等待中的会话，请人工检查"。

## 6. 验收报告解读要点

- 除 `get_task_report`（直接返回报告 Markdown 原文）外，其余工具结果文本末尾都带 `---tianshu-mcp-meta---` 块（JSON），天枢可正则抽取；字段全表见 usage-examples.md。
- 报告全文走 `get_task_report(taskId, round?)`：`checks[]`（每项 PASS/FAIL/SKIP + 输出尾部）、`analysis`（变更清单、diffstat、可疑标记命中计数、超大单文件改动告警）、以及在启用视觉时的独立 `visual` 段落。`round` 为 0-based 报告轮次，缺省取最新；显式 `round: 0` 合法。
- `verify_task` 可对任务或任意项目独立验收（**不改源码、无需审批**）：`taskId` / `projectPath` 二选一；`extraChecks` 临时加验（`checksMode` 默认 append 追加，`replace` 才替换）；`baselineRef` 可填任务 ID（用该任务动工前基线）或 git ref（如 `HEAD~1`）；独立 projectPath 不设 baselineRef 时按当前基线做健康检查。对任务 ID 验收只更新其验收结论字段（`latestVerificationVerdict`），**不改写原任务终态**；独立 projectPath 且遇配置/视觉阻塞时，独立 vfy 记录落 `needs_attention`。
- 验收命令优先级：`extraChecks` > 项目 `.tianshu-mcp/acceptance.json` > projects.json 管理员补录 > 按技术栈推导的默认集。
- **检查项默认并行 2 条**（`verifyConcurrency`，范围 1–4，v0.4.0 起；此前为串行）。项目级 `.tianshu-mcp/acceptance.json` 可覆盖。若 checks 之间有顺序依赖（后续读 build 产物、带 `--fix`、共享缓存目录），需把 `verifyConcurrency` 显式设为 `1` 退化为串行，否则会偶发误报。
- `requireChanges` 门禁：项目配置默认开启——相对动工前基线**零变更**会被判失败（防止 agent"什么都没做却报成功"）。纯只读/纯排查类任务要在 `.tianshu-mcp/acceptance.json` 设 `requireChanges: false`，否则必然失败。
- 注意：代码分析是确定性规则（TODO/FIXME、console.log/debugger、疑似密钥形态、超大改动），**不是** LLM 评审——命中仅提示人工，不等同于任务失败。
- changedFiles/diffstat 都相对**动工前 git 基线**（run_task 自动采集，含未跟踪新增）。MCP 不自动 commit/stash；需要回滚时由用户基于报告决定。

## 7. 视觉验收与基准保护

项目在 `.tianshu-mcp/acceptance.json` 配置 `visual` 且 `enabled: true` 后，`run_task`/`verify_task` 自动带上截图对比与静态图片规格检查，**不需要新工具**。

- 验收结论：视觉缺陷（布局差异、图片规格错误、可定位的交互失败）按 `autoFixRounds` 返修；视觉阻塞（缺基准、页面不可达、浏览器缺失、资源被策略拦截、截图不稳定）进 `needs_attention`，**不触发 agent 返修**——`rework_task` 会先只重新验收，不启动 agent、不额外消耗返修轮次，通过即结束，仍阻塞则回到 `needs_attention`。
- 读 `get_task_report` 的 `visual` 段落与 `files.html` 离线报告（图片并排、透明叠加、区域定位）。返修时报告会给出检查 ID、路由/文件、视口、预期与实际指标、差异区域及证据路径。
- **基准必须由用户审阅批准**：`prepare_visual_baseline` 只生成候选（返回 candidateId/digest/preview），`approve_visual_baseline` 只能在用户查看候选并明确授权后调用，且必须带 `expectedDigest` 与 `approvalNote`。缺基准只能生成候选、**不能判视觉通过**。
- **禁止绕过**：不得为通过而修改基准、阈值、屏蔽区域或关闭规则——规则冻结会检出并报 `VISUAL_INTEGRITY`；配置或基准变化需用 `tianshu-mcp visual rules review/approve` 重建任务快照（CLI 在 stdio 前分流）。
- **自动返修禁止调用批准入口**；两个工具都是有副作用的 `write` 操作，宿主必须实施实际授权控制（审批标注不能替代）。
- 阻塞处理流程：先处理环境或完成审批，再 `rework_task`（系统先重新验收，通过后无需启动 agent）。

Visual acceptance reuses the existing task tools with independent evidence. Never weaken baselines, thresholds, masks or enabled rules to bypass failures; baseline approval requires explicit user review and authorization, and automatic repair must never approve candidates. Resolve blockers before `rework_task`, which verifies first.

## 8. 硬失败与错误码速查

任务报告 `needs_attention` / `failed` 且属**硬失败**（`hardFailure`，不进验收与返修）时，读 meta 的 `agentEndReason` / `errorType` / `message` 直接定位，不要把硬失败当成"agent 没做好"反复重试。常见码：

| `agentEndReason` | 含义 | 处置 |
|---|---|---|
| `setup_failed` | 找不到安装 / 实例未就绪 / 点不到「新对话」 | 让用户确认已安装并可手动打开；重试一次 |
| `project_ambiguous` | 项目同名或路径重复，无法消歧 | 转 `needs_user`(setup_recovery)：请用户确认目标项目后 `continue_task` |
| `project_mismatch` | 项目绑定或回读不一致，幂等重试仍失败 | 同上，请用户在 GUI 里确认/手工绑定 |
| `project_create_failed` | 在 GUI 内新建项目失败 | 让用户手动把项目加进 agent，或换 `projectPath` |
| `model_unavailable` | 面板里找不到指定模型（错误文本附可见候选） | 用 `get_profiles` / 面板实际模型名重派 |
| `model_mismatch` | 模型回读与期望不符 | 同上；确认面板模型名与 `model` 参数完全一致 |
| `permission_unknown` | 权限模式未确认（如 ZCode 未开「完全访问」） | 让用户在 agent 内切好权限模式 |
| `cdp_disconnected` | CDP 连接断开且未能恢复 | 让用户关掉冲突实例；重试 |
| `instance_busy` | 同项目已有未停止的运行（重派护栏） | 先 `cancel_task` 并**确认 GUI 已停**，或等其自行结束 |
| `session_lost` | zcode 找不到原会话锚点 | 用新任务重派（不要指望恢复原会话） |
| `input_mismatch` / `send_unknown` | 发送前回读不一致 / 发送结果无法确认（**不重复发送**，避免重发） | 人工看窗口状态，必要时 `continue_task` 或重派 |
| `idle_timeout` | GUI 长时间静止且无完成标志（现场已保留） | 看窗口里 agent 是否真的卡住；必要时 `continue_task` 或取消 |
| `setup_recovery` | zcode 初始化/原生面板操作超时或恢复预算用尽 | 进 `needs_user`：请用户在 ZCode 确认项目/绑定后 `continue_task` |
| `task_timeout`（`errorType=timeout`） | 任务级超时 | 大任务调大 `taskTimeoutMs`；或拆小任务 |
| `aborted`（`errorType=cancelled`/`interrupted`） | 被取消/中断 | 按 §5 处理 |

`errorType` 取值：`timeout` / `spawn` / `agent_failed` / `verify_failed` / `cancelled` / `interrupted` / `agent_unresolved` / `internal`。

## 9. 纪律

- 写/执行类工具（`run_task` / `cancel_task` / `rework_task` / `continue_task` / `prepare_visual_baseline` / `approve_visual_baseline`）需审批：不绕过、不替用户代点同意；`query_task` / `list_tasks` / `get_task_report` / `verify_task` / `get_profiles` 为只读，无需审批。
- 不代替外部 agent 手改项目代码；不改用户 git 历史；不读取/转发任何 agent 密钥（登录态各 agent 自持）。
- 验收命令来自白名单式配置、按 argv 分词执行，不做 shell 注入。
- 本技能由 server 启动时幂等同步到 `~/.rivet/skills/tianshu-mcp/`（内容 hash 变化才覆盖，旧文件备份为 `.bak-<时间戳>`）；改技能以本仓库 `skills/` 为准。

## 快速上手清单

1. `get_profiles` → 确认目标 agent 可用（看 status 与可执行探测结果）。
2. `run_task(projectPath=<绝对路径>, task=<任务书>, agentId=codex, model=GPT-5.6 Sol, autoVerify=true, autoFixRounds=5)` → 拿 taskId（model 以 get_profiles/面板实际为准）。
3. `query_task(taskId)` 每 ~8 秒轮询到终态；遇 `needs_user` 按 §4 处理，遇硬失败按 §8 定位。
4. 终态处理见 §5；汇报时带 `get_task_report` 的 changedFiles 与 diffstat；启用视觉时一并读 `visual` 段落与 HTML。
