---
name: tianshu-mcp
description: 让外部 AI-Agent（codex/zcode/traework/kimicode/qoder）做项目开发并自动验收、失败返修的编排方法。当任务需要“叫一个 AI-Agent 去开发/改代码/补测试并验收，不行就返修”时先加载本技能：按它用 mcp__tianshu-mcp__ 的 11 个工具（run_task/continue_task/query_task/list_tasks/get_task_report/verify_task/rework_task/cancel_task/get_profiles/prepare_visual_baseline/approve_visual_baseline）派活、暂停继续、轮询、查历史、读验收报告、驱动返修、管理视觉基准，并按硬失败错误码快速定位卡点。小改动或纯问答不需要。
triggers: '开发|编码|写代码|改代码|实现功能|加功能|修复|重构|补测试|写测试|验收|返修|返工|重做|自动验收|自动返修|任务书|ai.?agent|子代理|外部.?agent|agent|codex|zcode|traework|kimicode|kimi.?code|qoder|claude|编排|项目开发|派活|派单'
---

# tianshu-mcp 编排技能：叫外部 AI-Agent 开发并验收

**你是总指挥，不是开发**。你不改项目代码，只通过本 MCP 派活、轮询、读报告、驱动返修，并把结论如实汇报给用户。

**首行强指令**：动手前读完本文件。任务书模板、六种派活示例、meta 字段全表（§4）、错误码速查（§5）、项目级验收配置模板、needs_user/取消示例在同目录 `usage-examples.md`，需要时用读取文件工具查看，长方法论不必背。

---

## 0. 一分钟心智模型

```text
run_task（秒回 taskId，异步）
   → query_task 轮询（5–10 秒一次）
        ├─ needs_user      → §5：让用户在客户端处理 → continue_task 恢复
        ├─ 硬失败           → §9：读 agentEndReason，不要当“agent 没做好”重试
        └─ 终态            → §6：读 get_task_report 的 checks / analysis / visual
   → 验收失败且 autoFixRounds>0 → 自动返修（先落修复计划，再回原会话）
   → 人工不满意 → rework_task(taskId, feedback=针对性摘要)
```

三条不变式：

1. **异步契约**：`run_task` 只返回 `taskId`；严禁把它当同步调用等结果。
2. **验收是唯一裁判**：agent 说“完成”不算通过，`get_task_report` 的 checks 才算。
3. **不空转**：同一诊断只重试一次；第二次仍失败就带证据汇报，或换 agent / 缩小任务。

---

## 1. 工具面（11 个）

| 工具 | 能力 / 审批 | 作用 | 关键入参 |
|---|---|---|---|
| `run_task` | write + 审批 | 派活给外部 agent；**异步**返回 `taskId` | 见 §3 |
| `query_task` | read | 轮询状态 + agent 日志尾（`tailLines` 缺省 40 行） | `taskId`、`tailLines?` |
| `list_tasks` | read | 查历史任务（每行：taskId / status / agent / project / 摘要） | `projectPath?`、`status?`、`limit?`（缺省 50，上限 200） |
| `get_task_report` | read | 读某轮验收报告 **Markdown 全文** | `taskId`、`round?`（0-based，缺省最新） |
| `verify_task` | read | 对任务或任意项目**独立验收**（不改源码、无需审批） | `taskId` 或 `projectPath` 二选一、`extraChecks?`、`checksMode?`、`baselineRef?` |
| `rework_task` | write + 审批 | 手动返修：终态任务重新入队续跑（同 agent/项目、同一轮次记账） | `taskId`、`feedback?` |
| `continue_task` | write + 审批 | 恢复 `needs_user`（仅 codex/zcode/kimicode/qoder） | `taskId`、`message`（必填） |
| `cancel_task` | write + 审批 | 取消运行中任务（GUI agent 尽力点停止并回读） | `taskId`、`reason?` |
| `get_profiles` | read | 看当前机器实际探测结果（可用性、profileStatus、探测来源） | — |
| `prepare_visual_baseline` | write + 审批 | 视觉基准**候选**准备（截图或导入参考图） | `projectPath` 等，见 §8 |
| `approve_visual_baseline` | write + 审批 | **用户明确授权后**批准候选，写入正式基准 | `candidateId`、`expectedDigest`、`approvalNote` |

---

## 2. 何时不要用（边界）

- **小改动 / 纯问答 / 只读代码分析**：直接做，不要为本技能开任务。
- **本 MCP 未连接**：工具面里看不到 `mcp__tianshu-mcp__*` 时，先提示用户按天枢 `config.json → mcp.servers.tianshu-mcp` 接入（见项目 `docs/tianshu-integration.md`），**不要空转**，更不要假装调用。
- **agent 未安装 / 未登录**：`get_profiles` 报 `[FAIL] 不可用` 时如实转达，不要改路径硬试或换一个“看起来像”的窗口。

---

## 3. 选 agent

所有内置 agent 都是 **GUI 驱动**（CDP 控制桌面端），不是 CLI。默认 `agentId` 取项目登记值，未登记时为 `codex`。

### 3.1 参数兼容矩阵（传错即报错，不会静默忽略）

| 参数 | codex | zcode | traework | kimicode | qoder |
|---|---|---|---|---|---|
| `projectPath` | 必填 | **可省略**（无项目模式，见 §3.4） | 必填 | 必填 | 必填 |
| `model` | **必填**（面板模型名） | **必填**，`供应商/模型` | 可选 | **必填**（界面模型名） | 可选 |
| `modelSource` | ✗ | ✗ | ✗ | ✗ | 可选 `default`/`custom` |
| `reasoningLevel` | `低/中/高`（`low/medium/high`） | ✗ | ✗ | `低/low`、`高/high`、`max`、`on`、`off` | `低/中/高/极高/最大/关闭思考` |
| `mode` | ✗ | ✗ | **唯一支持**（`Work`/`Code`/`Design`） | ✗ | ✗ |
| `planDoc` | 可选 | ✗ | ✗ | ✗ | **必填**且必须可读 |
| `designSystem` | 可选 | ✗ | ✗ | ✗ | ✗ |
| `allowCreateProject` | ✗ | 可选（`false` 关自动导入） | ✗ | ✗ | ✗ |
| `continue_task` | 仅 `login_required` / `user_confirmation` | `agent_question` 回发答案；其余作已处理确认 | **不支持** | 见 §5 | 见 §5 |

`reasoningLevel` 别名（`极高`/`xhigh`、`最大`、`关闭思考`）**只有 qoder 接受**，传给其他 agent 会直接报错。`max`/`off` 是全局取值，各适配器自行判定是否支持。

**默认值优先级**（不写参数时的取值顺序）：

| 项 | 优先级 |
|---|---|
| `autoVerify` | 调用参数 > server 默认（**默认 `true`**，即默认开验收） |
| `autoFixRounds` | 调用参数 > agent 缺省 > server 默认 `0`（=不自动返修）。agent 缺省：codex 5，zcode 2，kimicode 2，qoder 3，traework 未设（落 server 默认 0） |
| `taskTimeoutMs` | 调用参数 > profile `timeoutMs`（GUI agent 均 30 分钟）> server 默认 30 分钟 |

### 3.2 逐个 agent 要点

- **`codex`**（默认，推荐先试）：ChatGPT/Codex 桌面端，MSIX COM 激活 + CDP（Windows 冷启动实测 60–90 秒，首轮偏慢属正常；macOS spawn `.app` + CDP）。
  `model` 必填且用**面板里的模型名**；`planDoc`/`designSystem` 会拼进初始指令且必须存在、在项目内。**不支持 `mode`**。
- **`zcode`**：ZCode 桌面端（Electron CDP）。`model` 必填 `供应商/模型`（如 `DeepSeek/deepseek-flash`）；发送前确认「完全访问」权限模式；**不支持 `mode`**。支持省略 `projectPath` 的无项目模式（§3.4）。
- **`traework`**：TraeWork / TRAE SOLO CN。`model` 可选；**唯一支持 `mode`**（不传时从任务书文本识别「切换 X 模式」，识别不到保持 `Work`）；实现顺序固定为「新建会话 → 切模式 → 在目标模式内绑定项目」。窗口必须保持可见（发送依赖模拟输入）。**`continue_task` 不支持**。
- **`kimicode`**：Kimi Code 桌面端（普通 Electron，实测 1.0.2；CDP 基准端口 9666）。`model` 必填，直接填**界面模型名**（如 `K3`、`K2.8 Preview`、`stepfun/step-3.7-flash:free`）。
  `reasoningLevel` 取值域刻意**不含 `中`/`medium`**（那不是任何模型的合法档位）：官方模型 `低/low`、`高/high`、`max`；非官方模型只有 `on`/`off`。档位集合以**界面实际渲染的标签**为准，传了界面不存在的档位在发送前报错，绝不静默沿用；不传时官方档位沿用界面当前值、非官方强制 `on`。
  **不支持 `mode`**；**`allowCreateProject` 不适用**；**`projectPath` 必填**（以工作区组织任务，不支持无项目派发）。未登记工作区经原生「添加工作区」对话框导入，同名/同路径歧义一律 fail-closed。
  排查注意：模型/思考档位/执行模式菜单渲染在独立的 `Kimi Browser Overlay` 浮层窗口，别在主窗口找。
- **`qoder`**：仅 **Qoder CN**；`projectPath` 与可读 `planDoc` 必填。
  `model`/`reasoningLevel` 可省略（沿用界面当前值并记录）；指定模型时若「默认」与「自定义」两组同名，必须用 `modelSource` 消歧，否则报 `qoder_model_ambiguous`。
  思考等级经「模型管理」设置并**重新打开回读**验证，不支持的档位在发送前报错；修改会保留为**全局偏好**（任务结束不还原），报告会说明影响。权限模式沿用当前设置，**不自动切「完全访问」**。
  自动与手动返修都**先落修复计划**，再把失败说明、计划文件名、完整路径与**全文**发回原会话。**macOS 为 `research` 且禁止派发**（`unsupported_platform`）。
- **`codex-cli`**（可选，用户自建 profile，非内置）：不想依赖 GUI 时的**无头**路径，走 `codex exec`。需用户先在数据目录 `agent-profiles.json` 加 `driver=spawn` 的 profile（示例见 README「macOS 无头路径：codex-cli」）。
  `model` 参数对它**不生效**（模型取 `~/.codex/config.toml`，要锁模型在 `argsTemplate` 里加 `-m`）；无 GUI 交互，`continue_task` 不适用。CLI 需 **≥0.154.0**（≤0.130.0 签名证书已吊销，macOS 会被 Gatekeeper 直接 SIGKILL）。

### 3.3 状态语义（`status` 字段）

| 取值 | 含义 | 能否派发 |
|---|---|---|
| `ready` | 该平台闭环已验证 | 可 |
| `research` | 已实现但真机矩阵未覆盖 | **可**（探测成功即可跑；失败会说明原因） |
| `unsupported` | 明确不支持 | 否 |

内置取值：`traework` 恒为 `ready`；`zcode` 恒为 `research`（Windows 闭环已通过，macOS 取消/返修/新建项目矩阵未齐）；`codex` 在 Windows `ready`、darwin `research`；`kimicode` 在 Windows `ready`、darwin `research`；`qoder` 在 Windows `ready`、其他平台 `research`。

**`ready` ≠ 全平台无限制**：TraeWork 与 Kimi Code 的 macOS 可执行探测与原生对话框驱动仍 fail-closed；qoder 在非 Windows 直接拒绝派发。

不确定时问用户，或读项目 `projects.json` 的 `defaultAgentId`；用 `get_profiles` 看当前机器实际探测结果（含未安装提示与用户自定义 profile）。

### 3.4 ZCode 无项目模式（省略 `projectPath`）

只有 ZCode 支持。任务在其 `default` 工作区执行：**不**登记/导入项目、**不**采集 Git 基线、**不**执行项目验收。

- `autoVerify` 固定 `false`、`autoFixRounds` 固定 `0`；显式传 `autoVerify=true` 或 `autoFixRounds>0` 会在提交前报错。
- 任务书里**不要**写反引号路径或 `./`、`../` 引用——无项目模式无法解析，发送前即报错并要求提供 `projectPath`。
- 终态标注 `not_applicable: no_project`；对它调 `verify_task` / `get_task_report` 会得到 `not_applicable: no_project`，不会从 cwd 猜目录。
- 省略 `projectPath` 但解析出的 agent 不是 ZCode（例如默认 agent 是 codex）→ 排队前报参数错误，**不会**被悄悄改判成 ZCode。
- 空串 / `null` / 相对路径 / 不存在的目录**不视为**无项目模式，仍按有项目模式拒绝。

---

## 4. 派活：run_task

`projectPath`（绝对路径）+ `task`（任务书）是核心两件套；`task` 要写清**目标 / 验收要点 / 约束 / 相关文件 / 上下文**（模板见 usage-examples.md §1）。

- `context`：补充上下文，会以【上下文与约束】拼进初始指令。task/context 中**反引号包裹或路径形态的引用会在发送前校验**（必须存在且在项目内），写错立即报错而不是带病派单。
- `autoVerify` 默认开；`autoFixRounds` 0–10（见 §3.1 优先级）。
- 返回立即给 `taskId` 与队列位置，**不要等结果**。

### 4.1 projectPath 安全闸门（v0.4.0 起）

`run_task` / `verify_task` 提交时校验，不通过直接报错（属**基础设施拒绝**，改路径重试即可）：

- 必须是绝对路径且**已存在**的目录；`realpath` 消除符号链接（macOS `/tmp` → `/private/tmp`），回执会明示解析来源。
- 拒绝**用户主目录本身**与根级/系统目录（`/`、`/etc`、`/usr`、`/var`、`/tmp`、`/Users`、`C:\`、`C:\Windows`、`C:\Users`、`C:\Program Files`、`D:\` 等，含 macOS `/private/*` realpath 形态）。**只挡精确相等的根**，子目录（`/tmp/xxx`、`D:\repo\app`）正常可用。
- 目标是 git 仓库且有未提交变更时，回执追加**共处警示**：该仓库同时有人的改动，agent 的 diff 与基线都会与之共处。

用户没给绝对路径时**先问**，不要猜路径。

---

## 5. needs_user：continue_task

meta 的 `needsUserKind` 给出等待类型，`pendingQuestion` 给出问题原文或处理说明。只有 `status=needs_user` 可恢复，其他状态一律拒绝。

| `needsUserKind` | 出现于 | 用户先做什么 | `continue_task` 的行为 |
|---|---|---|---|
| `agent_question` | zcode / kimicode / qoder | 无需操作（或在客户端补充信息） | **把 `message` 发表在原会话**（不重发任务书）。qoder 多题用 JSON 对象字符串，键为界面完整问题文字，多选值为字符串数组；先全量校验再提交，缺答案/题目变化/选项不存在都保留等待 |
| `user_confirmation` | codex / kimicode / qoder | 在客户端窗口完成确认（方案卡/订阅页等） | **只重新接入观察**，不发送消息 |
| `login_required` | codex / zcode / kimicode / qoder | 在窗口完成登录 | codex：复检环境后**重新派发任务书**（新会话 + 项目绑定 + 完整初始指令）；kimicode/qoder：补发完整任务书；zcode：message 仅作已处理确认 |
| `close_existing_instance` | zcode / kimicode / qoder | 关闭冲突的旧实例（MCP 不自动关停） | 复检环境后补发完整任务书（message 不作问题发送） |
| `system_permission` | zcode / kimicode | 授予系统权限（辅助功能等） | 同上 |
| `setup_recovery` | zcode / kimicode / qoder | 在客户端确认目标项目/工作区，或手工完成绑定 | 同上；无锚点的环境恢复会补发完整原任务、上下文与已验证引用 |

限制与纪律：

- **codex 只支持 `login_required` / `user_confirmation`**，其余等待类型会被明确拒绝；**traework 与 spawn 类 agent 完全不支持 `continue_task`**。
- `agent_question` 的恢复依赖服务端保存的**原会话锚点**（zcode `zcodeSessionId`/`zcodeSessionTitle`、kimicode 同名锚点、qoder `qoderSessionId`）。锚点丢失时**明确拒绝**，绝不擅自打开“最近会话”。
- **禁止新开会话冒充恢复**；用户处理后的确认文本不会作为问题发给模型。
- 用户尚未处理就调 `continue_task`，任务会再次转 `needs_user`（如实反映 GUI 状态），稍后再试即可。
- qoder 的“发送/答题提交结果不确定”也会转 `needs_user(setup_recovery)`，此时**禁止自动重发**：请人工核对原会话，再决定继续或重派。

---

## 6. 终态解读

| 终态 | 含义 | 处置 |
|---|---|---|
| `succeeded` | 验收通过（或未开验收且 agent 正常退出） | `get_task_report(taskId, round?)` 取 changedFiles / diffstat / checks，向用户汇报 |
| `failed` | 未开自动返修时的失败，或**硬失败**（`errorType=spawn`） | 读 `agentEndReason`（§9）区分：硬失败按表中处置；真失败给**针对性** feedback 调 `rework_task` |
| `needs_attention` | ①自动返修轮次用尽仍失败；②验收**阻塞**（配置/完整性错误、缺基准、页面不可达等）；③GUI 空闲/超时/断线（`errorType=agent_failed`/`timeout`） | 先读报告定位，再决定 `rework_task` 或转人工 |
| `cancelled` / `interrupted` | 取消 / 超时或中断 | 看 `abortSource`（`user`/`shutdown`/`timeout`/`internal`）；GUI 任务另看 `guiStopUnconfirmed`（见下） |

关键区别：

- **视觉阻塞任务**调 `rework_task` 会**先只重新验收、不启动 agent、不消耗返修轮次**：通过即结束，仍阻塞则回到 `needs_attention`，只有出现真实缺陷才启动返修。
- **`needs_attention`（验收失败）** 的返修才真正回到 agent，`feedback` 会作为追加指示。
- **硬失败（`failed` + `errorType=spawn`）** 不是“agent 没做好”，重试前先按 §9 修环境。
- **`running` 卡死**才用 `cancel_task`：CLI agent 终止进程树；GUI agent 尽力点击界面停止并等待空闲（有界超时），取消文案会如实标注 GUI 侧是否已停。
  **标注“未确认停止”时不要重派同项目任务**——窗口内可能仍在跑，重派护栏也会以 `instance_busy` 拒绝。
- **`needs_user` 状态下取消**：run 协程已退出、CDP 已断开，MCP 无法再点 GUI 停止按钮，文案会提示人工检查。
- **`interrupted` + `guiStopUnconfirmed=true`（server 退出 / 宿主 EOF / 重启归档）**：`tianshu-mcp` 对 GUI 进程没有所有权，**“编排器已停”不等于“窗口里的任务已停”**。先让用户人工打开对应窗口确认没有还在跑的 turn，再调 `cancel_task(taskId, reason="已人工核对窗口无残留运行")` 清除待确认标记（终态仍是 `interrupted`），**之后**才可安全重派同项目任务。详见 `usage-examples.md` §9.5.1。
- **幂等重放不是新任务**：`run_task` 命中同一 `idempotencyKey` 时返回的是**原任务**（含终态），响应文本以「幂等重放：」开头、meta 带 `idempotencyReplay: "hit"`；不要把它当成本次新派单，也不要据此认为又要等一轮。终态任务要继续推进用 `rework_task`，或换一条新 key 重新派单。

汇报纪律：**不要反复空转重试**。多次仍不过或不可修时，如实汇报 `errorType`/`agentEndReason`、失败 check 与输出尾部、变更清单，并给建议（人工看报告 / 换 agent / 缩小任务）。

---

## 7. 轮询与查询

- `query_task(taskId, tailLines?)` 间隔 **5–10 秒**；返回状态行 + 最近消息 + agent 日志尾（缺省 40 行）。
- 查历史用 `list_tasks(projectPath?, status?, limit?)`（缺省 50，上限 200）；`projectPath` 与 `run_task` 同样做 realpath 归一。
- **同一项目勿重复派单**：每项目串行 + 全局并发（`concurrency.maxRunning`，默认 2）；重复派只会排队，反而更慢。
- **重试必须带幂等键（issue #15）**：`tools/call` 超时、连接抖动、宿主重启后重发同一意图时，**复用同一条 `idempotencyKey`** 调 `run_task` / `verify_task`——`run_task` 会返回原 `taskId` 与原状态（不会排队第二轮 agent），`verify_task` 执行中返回「进行中」、已完成返回既有报告（不会重跑 `build`/`e2e`/部署类检查）。**换参数就得换 key**：同键异参会直接报冲突。未带 key 时若响应里出现 `projectActiveTask`，说明该工作区已有未结束任务——先 `query_task` 复核，不要盲目再派。
- 状态语义：`queued` 排队中（每项目串行）/ `running` 开发中 / `verify_start` 验收中 / `fixing` 返修中 / `needs_user` 等用户 / 终态见 §6。

---

## 8. 验收：理解与独立复验

### 8.1 验收报告解读

`get_task_report(taskId, round?)` 返回报告 Markdown 全文。**注意：报告类与视觉基准类工具的成功结果不带 meta 块**——`get_task_report` 返回报告原文，`prepare_visual_baseline` / `approve_visual_baseline` 返回视觉操作的 JSON 原文；其余工具结果末尾都带 `---tianshu-mcp-meta---` JSON 块（字段全表见 usage-examples.md §4），任何工具的**错误**结果也不带 meta 块。

- `checks[]`：每项 PASS / FAIL / SKIP + 输出尾部。默认**并行 2 条**（`verifyConcurrency`，1–4）；checks 之间有顺序依赖（后续读 build 产物、带 `--fix`、共享缓存目录）时**必须显式设 1**，否则偶发误报。
- `analysis`：变更清单、diffstat、可疑标记命中（TODO/FIXME、`console.log`/`debugger`、疑似密钥形态、超大单文件改动告警）。这是**确定性规则，不是 LLM 评审**，命中只提示人工，不等同于任务失败。
- `visual`：启用视觉时的独立段落（§8.3）。
- `requireChanges` 门禁（默认开）：相对动工前基线**零变更**判失败，防“什么都没做却报成功”。**纯只读/纯排查任务**必须在 `.tianshu-mcp/acceptance.json` 设 `"requireChanges": false`，否则必然失败。
- changedFiles/diffstat 相对**动工前 git 基线**（run_task 自动采集，含未跟踪新增）。MCP **不自动 commit/stash/回滚**。

### 8.2 独立复验：verify_task

只读、不改源码、无需审批。`taskId` / `projectPath` 二选一：

- 传 `taskId`：用该任务动工前基线复跑，只更新其验收结论字段（`latestVerificationVerdict`），**不改写原任务终态**。
- 传 `projectPath`：独立健康检查，不设 `baselineRef` 时按当前基线；`baselineRef` 可填 git ref（如 `HEAD~1`），传 `task` 表示沿用任务基线。**独立路径验收不产生独立任务，遇配置/视觉阻塞时记录为 `needs_attention`。**
- `extraChecks` 临时加验（`name`/`cmd`/`timeoutMs`/`optional`）；`checksMode` 缺省 `append`（项目/默认集 + 追加），`replace` 才只跑 extraChecks。
- 命令优先级：`extraChecks` > 项目 `.tianshu-mcp/acceptance.json` > projects.json 管理员补录 > 按技术栈推导的默认集。
- 任务没有保存的动工前基线时会报错——改用 `projectPath` 或传 `baselineRef`。

### 8.3 视觉验收与基准保护

项目在 `.tianshu-mcp/acceptance.json` 配 `visual.enabled: true` 后，`run_task`/`verify_task` 自动带上截图对比与静态图片规格检查，**不需要新工具**。

- **缺陷**（布局差异、图片规格错误、可定位的交互失败）按 `autoFixRounds` 返修；**阻塞**（缺基准、页面不可达、浏览器缺失、资源被策略拦截、截图不稳定）进 `needs_attention`，**不触发 agent 返修**。
- **基准必须由用户审阅批准**：`prepare_visual_baseline` 只生成候选（返回 `candidateId`/`digest`/preview），`approve_visual_baseline` 只能在用户查看候选并明确授权后调用，且必须带 `expectedDigest` 与 `approvalNote`。**缺基准只能出候选、不能判通过。**
- **禁止绕过**：不得为通过而改基准、阈值、屏蔽区域或关闭规则——规则冻结会检出并报 `VISUAL_INTEGRITY`；要变更走 `tianshu-mcp visual rules review/approve` 重建任务快照（CLI 在 stdio 前分流）。
- **自动返修禁止调用批准入口**；两个基准工具都是有副作用的 `write`，宿主必须实施实际授权控制（审批标注不能替代）。
- 读报告 `visual` 段落与 `files.html` 离线报告（并排、透明叠加、区域定位）；返修计划会给出检查 ID、路由/文件、视口、预期与实际指标、差异区域及证据路径。
- 阻塞处理流程：先在环境或审批上解决，再 `rework_task`（系统先重新验收，通过后不启动 agent）。

**AI 内容校验**（`visual.contents[]` 与 `pages[].content`，v0.5.4 起，可选、默认关闭）：

- **凭证零管理**：判定完全委托用户自备的本地命令；MCP 不读取/存储/转发任何凭证，也不实现模型客户端。命令契约与占位符（`<image:path>` / `<expect:file>` / `<image:base64:file>`）见 `docs/visual-acceptance.md`。
- **默认仅告警**：内容项 `blocking:false` 映射为 `optional:true`，不改变结论、不触发返修。整轮消息会出现「AI 内容告警未通过（不影响结论）」，报告与返修计划另有「仅告警项（不必修复）」小节——**不要为消除告警伪造产物或放宽检查**。
- **只有 `blocking:true` 才致败**（`CONTENT_MISMATCH` 进返修计划「必须修复」）。
- **整轮阻塞**：任一规则的**有效**命令不可解析（`CONTENT_COMMAND_MISSING`）或宿主环境变量缺失（`CONTENT_ENV_MISSING`）会让整轮进 `needs_attention` 且**不产出任何视觉结果行**。这是 fail-closed，不是告警。
- **`uncertain` 不是失败**：票不集中或低于 `minConfidence` 时判 `uncertain`，永不阻塞、不触发返修；命令不报 confidence 时 `minConfidence` 不生效。
- 排查：`tianshu-mcp visual doctor <project>`、`visual content probe <project> [ruleId]`、`visual content cache clear <taskId>`。
- **数据外发**：`allowRemote` 默认 `false`，未放行的规则禁止使用字节外传占位符；图片是否离开本机取决于用户命令的行为，MCP 无法在系统层拦截。

---

## 9. 硬失败与错误码速查

**硬失败**（`hardFailure`）不进验收、不进自动返修，落 `failed` + `errorType=spawn`。读到它先查环境，别当“agent 没做好”反复重试。

`agentEndReason` 与终态映射（先记住这张表，再看错误码表）：

| `agentEndReason` | 任务终态 |
|---|---|
| `task_timeout` | `needs_attention` + `errorType=timeout`（GUI：codex/zcode）；qoder 落 `failed(timeout)` |
| `idle_timeout` / `cdp_disconnected` | `needs_attention` + `errorType=agent_failed`（codex/zcode） |
| 其余 `hardFailure` 原因 | `failed` + `errorType=spawn`（**基础设施失败**） |

| `agentEndReason` | 含义 | 处置 |
|---|---|---|
| `setup_failed` | 找不到安装 / 实例未就绪 / 点不到「新对话」 | 让用户确认已安装且能手动打开；重试一次 |
| `project_ambiguous` | 项目同名或路径重复，无法消歧 | 已转 `needs_user(setup_recovery)`：请用户确认目标项目后 `continue_task` |
| `project_mismatch` | 项目绑定或回读不一致，幂等重试仍失败 | 同上：请用户在 GUI 里确认/手工绑定 |
| `project_create_failed` | 在 GUI 内新建项目失败 | 让用户手动把项目加进 agent，或换 `projectPath` |
| `project_not_registered` | ZCode `allowCreateProject=false` 且目录未登记 | 在 ZCode 中手动登记该项目后重提 |
| `model_unavailable` | 面板里找不到指定模型（错误文本附可见候选） | 用面板实际模型名重派 |
| `model_mismatch` | 模型回读与期望不符 / 档位不被该模型支持 | 确认 `model` 与界面完全一致；档位改到界面实际存在的集合 |
| `permission_unknown` | 权限模式未确认（如 ZCode 未开「完全访问」） | 让用户在 agent 内切好权限模式 |
| `cdp_disconnected` | CDP 连接断开且未能恢复 | 让用户关掉冲突实例；重试 |
| `instance_busy` | 同项目/同实例已有未停止的运行（重派护栏） | 先 `cancel_task` 并**确认 GUI 已停**，或等其自行结束 |
| `session_lost` | zcode/kimicode/qoder 找不到原会话锚点 | 用**新任务**重派，不要指望恢复原会话 |
| `input_mismatch` / `send_unknown` | 发送前回读不一致 / 发送结果无法确认（**绝不自动重发**） | 人工看窗口状态，必要时 `continue_task` 或重派 |
| `idle_timeout` | GUI 长时间静止且无完成标志（现场已保留） | 看窗口里 agent 是否真的卡住；必要时 `continue_task` 或取消 |
| `agent_error` | Kimi Code 界面出现失败文案/「继续」按钮（如官方额度用尽 `provider.auth_error`） | 读窗口内错误原文；额度/模型类可换非官方免费模型后重派 |
| `unsupported_platform` | Qoder 在非 Windows 平台派发 | 换平台或换 agent；qoder 的 macOS 状态是 `research` 且禁止派发 |
| `qoder_error` | Qoder 运行期错误，错误原文带具体码：`qoder_model_ambiguous`/`qoder_model_missing`/`qoder_model_readback_failed`、`qoder_reasoning_unsupported`、`qoder_workspace_mismatch`/`qoder_workspace_ambiguous`、`qoder_folder_dialog`、`qoder_input_readback_failed`、`qoder_question_*`、`qoder_session_lost`、`qoder_stage_timeout` | 按码处置：模型/档位类按界面实际值重派；工作区类让用户确认目录；提问类补齐答案或改用 JSON 对象；`*_timeout` 类看窗口是否被遮挡/未前台 |
| `task_timeout`（`errorType=timeout`） | 任务级超时 | 大任务调大 `taskTimeoutMs`；或拆小任务 |
| `aborted`（`errorType=cancelled`/`interrupted`） | 被取消 / 中断 | 按 §6 处理 |

`errorType` 取值：`timeout` / `spawn` / `agent_failed` / `verify_failed` / `cancelled` / `interrupted` / `agent_unresolved` / `internal`。

工具层面的**参数拒绝**（不是任务终态）也会直接报错，常见的有：`allowCreateProject` 非 ZCode、`mode` 非 traework、`modelSource` 非 qoder、`极高/最大/关闭思考` 非 qoder、Qoder 缺 `planDoc` 或计划文件不可读、无项目模式传 `autoVerify=true`。

**幂等键冲突（issue #15）**：`run_task` / `verify_task` 报「`idempotencyKey '<key>'` 已被任务/验收记录 `<id>` 占用，但本次参数与首次提交不同」时，说明你**复用了旧 key 却改了参数**（例如同一条 key 换了项目、任务书或 agent）。处置：改用一条**新的** key 重新调用，或直接对原记录 id 操作（`query_task` / `get_task_report` / `rework_task`）——**不要**通过改动参数绕过冲突后继续复用该 key。

---

## 10. 纪律

- 写/执行类工具（`run_task` / `cancel_task` / `rework_task` / `continue_task` / `prepare_visual_baseline` / `approve_visual_baseline`）**需审批**：不绕过、不替用户代点同意、不因等待而伪造结果。只读工具（`query_task` / `list_tasks` / `get_task_report` / `verify_task` / `get_profiles`）无需审批。
- **重试要带幂等键**：同一次逻辑派单/验收的每次重试都复用同一条 `idempotencyKey`；参数变了就换 key。不要把幂等重放的响应（`idempotencyReplay: "hit"` / `"in_progress"`）汇报成「已重新派单 / 已重新验收」。
- **不代替外部 agent 手改项目代码**；不改用户 git 历史；不读取/转发任何 agent 凭证（登录态各 agent 自持）。
- 验收命令来自白名单式配置、按 argv 分词执行（`shell: false`），不做 shell 注入。
- 报错与不确定性**如实转达**：区分「实际通过」「未验证」「阻塞」，不把未验证说成已验证。
- 本技能由 server 启动时幂等同步到 `~/.rivet/skills/tianshu-mcp/`（内容 hash 变化才覆盖，旧文件备份为 `.bak-<时间戳>`，**新会话生效**）；改技能以本仓库 `skills/` 为准。

---

## 快速上手清单

1. `get_profiles` → 确认目标 agent `[PASS] 可用`（看 profileStatus 与探测来源）；不可用就转达用户，别硬试。
2. `run_task(projectPath=<绝对路径>, task=<任务书>, agentId=codex, model=<面板模型名>, autoVerify=true, autoFixRounds=5, idempotencyKey=<本次逻辑派单的稳定标识>)` → 拿 `taskId`。**model 以界面实际为准**，示例名不可当真；`idempotencyKey` 建议由宿主按「本次意图」生成一次并在所有重试中复用（见 §7）。
3. `query_task(taskId)` 每 ~8 秒轮询到终态；`needs_user` 按 §5 处理，硬失败按 §9 定位。
4. 终态按 §6 处理；汇报带 `get_task_report` 的 changedFiles 与 diffstat；启用视觉时一并读 `visual` 段落与离线 HTML。
