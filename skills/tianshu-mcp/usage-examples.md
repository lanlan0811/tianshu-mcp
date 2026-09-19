# tianshu-mcp 使用示例（子文件）

正文过长方法论不背：任务书模板、五种 agent 派活示例、meta 块字段全表、错误码速查、验收与返修模板、视觉验收与基准保护、needs_user/取消示例都在这里，按需用读取文件工具查看。

## 1. 任务书模板

给 `run_task` 的 `task` 字段，建议覆盖 5 要素：

```text
目标：<一句话，要做什么>
验收要点：
- <可验证的结果/行为，尽量列出可检查条件>
- <涉及命令：如 npm run build 应通过>
约束：
- <不改动范围 / 不要动哪些文件 / 遵守的既有风格>
相关文件：
- <src/xxx.ts、tests/yyy.test.ts 等，引导 agent 少走弯路>
上下文：
- <背景 / 已知约定 / 为什么这么做>
```

要点：

- 「相关文件 / 上下文」里的项目内路径建议用反引号或 `./` 相对路径书写（如 `` `src/run.ts` ``、`./docs/plan.md`）——task/context 中的路径引用会在发送前校验存在性与项目边界，写错会立即报错而不是带病派单。
- 「上下文」也可拆到 `run_task` 的 `context` 参数：它会以【上下文与约束】拼进 agent 初始指令，适合放较长且与任务书正文解耦的背景。

示例（真实可用）：

```text
目标：给本项目加一个命令行 flag --dry-run，让 run 命令只打印将执行的命令而不真正执行。
验收要点：
- npm run build 通过；npm test 通过
- 运行 `node dist/cli.js run --dry-run` 不产生任何副作用（不写文件）
约束：
- 不要改动 src/config/ 下已稳定的 schema
- 保持现有参数解析风格（commander）
相关文件：
- `src/cli.ts`（入口与参数定义）、`src/run.ts`（执行逻辑）
上下文：
- 现有 run 命令会写 out/ 目录；dry-run 应跳过全部写操作
```

## 2. 五种 agent 派活示例

### 2.1 codex（默认；model 必填，支持 reasoningLevel / planDoc / designSystem）

```text
run_task(projectPath=D:/repo/app, agentId=codex,
  model=GPT-5.6 Sol,
  reasoningLevel=高,
  planDoc=./docs/plan.md,
  designSystem=./design-system,
  task=按计划文档实现列表页与详情页,
  autoVerify=true, autoFixRounds=5)
```

- `planDoc` / `designSystem` 会被拼进初始开发指令「根据计划文档(<planDoc>)…和设计系统(<designSystem>)…」，路径必须存在且在项目内。
- `reasoningLevel` 接受 低/中/高 或 low/medium/high；不传沿用面板当前等级。
- 不支持 `mode` 参数，传了会直接报错。
- 冷启动实测 60–90 秒，首轮等待偏慢属正常，不要因慢就取消。

### 2.2 zcode（model 必填且为「供应商/模型」）

```text
run_task(projectPath=D:/repo/app, agentId=zcode,
  model=DeepSeek/deepseek-flash,
  task=按 `./docs/plan.md` 与 `./design-system` 实现功能,
  autoVerify=true, autoFixRounds=2)
```

若 `query_task` 返回 `needs_user`，先读 meta 的 `needsUserKind` 与 `pendingQuestion`：

```text
continue_task(taskId=tsk_..., message=采用 PostgreSQL 方案)
```

- `needsUserKind=agent_question`：message 作为答案发送到原会话。
- `needsUserKind=close_existing_instance / login_required / system_permission / setup_recovery`：先让用户处理（关旧实例 / 登录 / 授系统权限 / 在 ZCode 里确认目标项目），message 仅作为用户已处理的确认。
- **traework 不支持 `continue_task`**；若 traework 任务停在 `needs_user`，需人工处理后重派新任务。

### 2.2.1 ZCode 无项目派发（省略 `projectPath`）

只支持 ZCode：任务在 `default` 工作区执行，不登记/导入项目、不采集 Git 基线、不执行项目验收。

```text
run_task(
  agentId=zcode,
  model=DeepSeek/deepseek-flash,
  task=用一句话说明当前工作区状态，不要读写任何文件
)
```

- 省略 `autoVerify` / `autoFixRounds` 即为关；显式写 `autoVerify=true` 或 `autoFixRounds>0` 会在提交前被拒绝。
- 任务书里不要写反引号路径或 `./`、`../` 引用——无项目模式无法解析，会在发送前报错并要求提供 `projectPath`。
- 成功后终态文案是「未进行项目验收」；对该任务调 `verify_task` / `get_task_report` 会得到 `not_applicable: no_project`，不从 cwd 推导目录。
- 省略 `projectPath` 但解析出的 agent 不是 ZCode（例如默认 agent 为 codex）时，会在排队前返回参数错误——不会被悄悄改判为 ZCode。

### 2.2.2 派到 ZCode 但禁止自动创建项目

```text
run_task(
  projectPath=D:/repo/my-app,
  agentId=zcode,
  model=DeepSeek/deepseek-flash,
  task=修复登录超时,
  allowCreateProject=false
)
```

目标目录不在 ZCode 项目列表中时返回 `project_not_registered`，**不产生任何导入副作用**（不打开原生文件夹对话框、不添加项目）；在 ZCode 中手动登记该项目后重新提交即可。省略该参数则保持既有自动导入行为。

### 2.3 traework（model 可选；唯一支持 mode）

```text
run_task(projectPath=D:/repo/app, agentId=traework,
  model=GLM-5.3,
  mode=Code,
  task=重构导出模块,
  autoVerify=true)
```

- `mode` 缺省时从任务书文本识别「切换 Work/Code/Design 模式」，识别不到保持 `Work`。
- TraeWork 窗口需保持可见；实现顺序为「新建会话 → 切模式 → 在目标模式内绑定项目」。

### 2.3.1 kimicode（model 必填且直接填界面模型名；reasoningLevel 按界面档位集合校验）

```text
run_task(projectPath=D:/repo/app, agentId=kimicode,
  model=K3,
  reasoningLevel=High,
  task=按 `./docs/plan.md` 实现功能,
  autoVerify=true, autoFixRounds=2)
```

- `model` **必填**，直接填**界面上的模型名**（如 `K3`、`K2.8 Preview`、`K2.7 Code Highspeed`）；非官方模型直接填全名（如 `stepfun/step-3.7-flash:free`）。名字必须与界面完全一致，否则发送前以 `model_unavailable` / `model_mismatch` 失败（错误文本会附上可见候选）。
- `reasoningLevel` 可选：**官方模型**用 `Low` / `High` / `Max`（也接受 `low`/`high`/`max`）；**非官方模型**只有 `on` / `off`。档位集合以**界面实际渲染的档位标签**为准——传了界面不存在的档位会在发送前报错（不会静默沿用）。不传时：官方档位沿用界面当前值，非官方档位强制 `on`。
- **不支持 `mode`**；**`allowCreateProject` 不适用**（那是 ZCode 专用）；**`projectPath` 必填**（Kimi Code 以工作区组织任务，**不支持无项目派发**）。
- 未登记的工作区会自动经原生「添加工作区」对话框导入；若目标目录与已登记工作区同名或路径重复，会 fail-closed 报歧义，**不会猜一个点**。
- 首次启动偏慢（`launchTimeoutMs` 90s）；若已有未开 CDP 的 Kimi Code 实例，任务转 `needs_user(close_existing_instance)`，需用户手动关闭后 `continue_task`。
- 官方额度用尽时界面会返回 `provider.auth_error` / `HTTP 403` 并判 `agent_error`——可改用非官方免费模型（如 `stepfun/step-3.7-flash:free`）后重派。

### 2.4 codex-cli（用户自建 profile；无头路径，无 GUI）

内置 `codex` 走桌面 GUI 驱动。不想依赖 GUI 自动化（或需要可复现的 CI 式无头执行）时，在数据目录 `~/.tianshu-mcp/agent-profiles.json` 加一个 `driver=spawn` 的 profile，示例见 README「macOS 无头路径：codex-cli」。之后按普通 agent 派活：

```text
run_task(projectPath=/path/to/项目, agentId=codex-cli,
  task=按计划实现功能, autoVerify=true, autoFixRounds=2)
```

- `model` 参数对 spawn 类 agent **不生效**：CLI 用 `~/.codex/config.toml` 的默认模型；要锁模型可在 `argsTemplate` 里追加 `"-m", "<模型名>"`。
- codex CLI 版本要求 ≥0.154.0（≤0.130.0 签名证书已吊销，macOS Gatekeeper 直接 SIGKILL）。
- 写入被 `workspace-write` 沙箱限制在项目目录内；POSIX 下取消/超时对进程组 SIGTERM→SIGKILL。
- **无头路径无 GUI 交互**：不存在 `user_confirmation` 这类 GUI 等待，`continue_task` 不适用；失败直接看 `agentEndReason` 与日志。

### 2.5 返回与继续的通用约定

- `run_task` 是**异步契约**：立即返回 `taskId`，不要当同步调用等结果。
- 轮询间隔约 5–10 秒（`query_task` 缺省返回 agent 日志末 40 行）；同项目串行 + 全局并发默认 2，重复派单只会排队。
- 只有 `needs_user` 可用 `continue_task` 恢复，且**仅 codex/zcode/kimicode**；其余状态/agent 会被明确拒绝。

## 3. meta 块解读（字段全表）

`run_task` / `query_task` / `verify_task` 等结果文本末尾的结构化块（**例外**：`get_task_report` 直接返回报告 Markdown 原文，不带 meta 块）：

```text
---tianshu-mcp-meta---
{
  "ok": false,
  "taskId": "tsk_20260907120000_a1b2c3",
  "status": "needs_attention",
  "agentId": "codex",
  "projectPath": "d:/repo/my-app",
  "model": "GPT-5.6 Sol",
  "round": 3,
  "changedFiles": ["src/a.ts", "src/b.ts"],
  "diffstat": "+18 -4",
  "reportFiles": { "md": "<任务目录>/report-2.md", "json": "<任务目录>/report-2.json" },
  "logFile": "<任务目录>/agent-2.log",
  "errorType": "verify_failed",
  "reportRound": 2,
  "verificationSource": "auto",
  "message": "验收失败，自动返修轮次已用尽（3/5 轮）。…"
}
---tianshu-mcp-meta---
```

读法（按决策用途分组）：

| 字段 | 含义 |
|---|---|
| `ok` | 是否成功（仅 status=succeeded 时为 true） |
| `status` | queued/running/verify_start/fixing/needs_user/succeeded/failed/needs_attention/cancelled/interrupted |
| `message` | 状态摘要/失败原因，最先读 |
| `errorType` | 失败归类：timeout/spawn/agent_failed/verify_failed/cancelled/interrupted/agent_unresolved/internal |
| `agentEndReason` | agent 侧结束原因（硬失败定位主用，取值见 §4） |
| `lastRunSignal` | 最近一次运行观察到的信号（GUI 完成标志/空闲判定依据） |
| `needsUserKind` | needs_user 时的等待类型：agent_question/close_existing_instance/login_required/system_permission/setup_recovery/user_confirmation |
| `pendingQuestion` | needs_user 时 agent 提出的问题原文（或需用户处理事项的说明） |
| `round` | 已进行的 agent 轮次（=roundsUsed） |
| `changedFiles` | 相对 git 基线的变更清单（含未跟踪新增） |
| `diffstat` | 增删行摘要（`+A -D`） |
| `reportFiles` | 最近一轮验收报告 md/json 绝对路径 |
| `logFile` | 最近一轮 agent 日志 |
| `reportRound` | 最近一次验收的报告轮次（0-based，区别于 agent 轮次） |
| `verificationSource` | 最近一次验收来源：auto（run_task 自动）/ manual（verify_task 手动） |
| `latestVerificationVerdict` | 手动验收结论（不改变任务终态时单独记录） |
| `checks` | 本轮检查项摘要（name/passed/durationMs） |
| `abortSource` | 中断来源：user/shutdown/timeout/internal |
| `cancelReason` / `cancelRequestedAt` | 取消原因与发起时间 |
| `keptInstance` | 是否因任务未真正完成而保留了 GUI 实例 |
| `zcodeSessionId` / `boundProjectPath` | 会话与项目绑定回执（zcode/codex） |
| `modelProvider` / `permissionMode` | 实际生效的供应商标识与权限模式（zcode） |
| `progressSummary` | 轮询期进度摘要 |
| `finishedAt` | 终态落定时间 |
| `model` / `mode` | 本次派单的模型 / 面板模式（按 agent 生效） |

> `reasoningLevel`（codex）是**入参**，只影响派单，不回显在 meta 块里——要确认实际等级请看 Codex 面板。

规则：`ok=true` 且 status=succeeded → 交付达成；否则先读 `message`，再按 `errorType`/`agentEndReason` 查 §4，最后读 `reportFiles.md` 全文定位。

## 4. 硬失败错误码速查

**硬失败**（`hardFailure`）表示基础设施/环境/前置条件问题，**不进验收、不进自动返修**——把它当"agent 没做好"反复重试是空转。读 `agentEndReason` 定位：

| `agentEndReason` | 含义 | 处置 |
|---|---|---|
| `setup_failed` | 找不到安装 / 实例未就绪 / 点不到「新对话」 | 让用户确认已安装并可手动打开；重试一次 |
| `project_ambiguous` | 项目同名或路径重复，无法消歧 | 已转 `needs_user`(setup_recovery)，请用户确认目标项目后 `continue_task` |
| `project_mismatch` | 项目绑定或回读不一致，幂等重试仍失败 | 同上，请用户在 GUI 里确认或手工绑定 |
| `project_create_failed` | 在 GUI 内新建项目失败 | 让用户手动把项目加进 agent，或换 `projectPath` |
| `model_unavailable` | 面板里找不到指定模型（错误文本附可见候选） | 用 `get_profiles` / 面板实际模型名重派 |
| `model_mismatch` | 模型回读与期望不符 | 同上；确认面板模型名与 `model` 参数完全一致 |
| `permission_unknown` | 权限模式未确认（如 ZCode 未开「完全访问」） | 让用户在 agent 内切好权限模式 |
| `cdp_disconnected` | CDP 连接断开且未能恢复 | 让用户关掉冲突实例；重试 |
| `instance_busy` | 同项目已有未停止的运行（重派护栏） | 先 `cancel_task` 并**确认 GUI 已停**，或等其自行结束 |
| `session_lost` | zcode/kimicode 找不到原会话锚点 | 用新任务重派，不要指望恢复原会话 |
| `input_mismatch` / `send_unknown` | 发送前回读不一致 / 发送结果无法确认（**不重复发送**） | 人工看窗口状态，必要时 `continue_task` 或重派 |
| `idle_timeout` | GUI 长时间静止且无完成标志（现场已保留） | 看窗口里 agent 是否真卡住；必要时 `continue_task` 或取消 |
| `agent_error` | Kimi Code 界面出现「继续」按钮或失败文案（如官方额度用尽 `provider.auth_error`） | 读窗口内错误原文；额度/模型类可换非官方免费模型后重派 |
| `task_timeout`（`errorType=timeout`） | 任务级超时 | 大任务调大 `taskTimeoutMs`；或拆小任务 |
| `aborted` | 被取消/中断（`abortSource` 区分来源） | 按 SKILL §5 处理 |

上表未覆盖的：先读 `message` 全文（多数带可执行建议），再读 `reportFiles.md`。

## 5. 验收：verify_task 示例

只读、不改源码、无需审批。三种典型用法：

```text
# 1) 复跑某任务的验收（用该任务动工前基线；round 缺省对最新状态）
verify_task(taskId=tsk_...)

# 2) 独立健康检查（无任务上下文，按当前基线）
verify_task(projectPath=D:/repo/app)

# 3) 临时加验 + 指定基线（extraChecks 追加到基础集之后）
verify_task(projectPath=D:/repo/app, baselineRef=HEAD~1,
  extraChecks=[{name=lint, cmd=npm run lint, timeoutMs=120000}],
  checksMode=append)
```

- `checksMode=replace` 时只用 `extraChecks`，不跑项目基础集。
- `extraChecks` 单条支持 `name`/`cmd`（argv 数组或字符串）/`timeoutMs`/`optional`（optional:true 失败只记 warning）。
- 验收命令优先级：extraChecks > 项目 `.tianshu-mcp/acceptance.json` > projects.json 管理员补录 > 按技术栈推导的默认集（详见 docs/acceptance-config.md）。

### 5.1 项目级验收配置模板（写进目标项目仓库）

`<目标项目>/.tianshu-mcp/acceptance.json`：

```jsonc
{
  // 默认 true：git 项目相对动工前基线零变更即判失败（防"什么都没做却报成功"）
  "requireChanges": true,
  // 命令检查并行度 1-4，缺省继承 server 的 verifyConcurrency（默认 2）
  // ⚠ checks 之间有顺序依赖（读 build 产物 / 带 --fix / 共享缓存）时必须设 1
  "verifyConcurrency": 1,
  "checks": [
    { "name": "typecheck", "cmd": ["npm", "run", "typecheck"], "timeoutMs": 120000 },
    { "name": "lint",      "cmd": ["npm", "run", "lint"] },
    { "name": "test",      "cmd": ["npm", "test"] },
    // optional:true 时失败只记 warning，不影响本轮 verdict
    { "name": "e2e", "cmd": ["npm", "run", "test:e2e"], "optional": true }
  ]
}
```

- `cmd` 推荐 argv 数组；字符串会被安全分词执行（`shell:false`，不拼接 shell 字符串）。
- **纯只读/纯排查类任务**必须设 `"requireChanges": false`，否则零变更必然被判失败。
- 非 git 项目跳过零变更门禁并在报告注明。
- 默认并行 2 是有意为之（提速）；不确定就用 `verifyConcurrency: 1` 换确定性。

### 5.2 视觉验收与基准保护

项目在 `.tianshu-mcp/acceptance.json` 里配置 `visual` 且 `enabled: true` 后，`run_task`/`verify_task` 会自动带上截图对比与静态图片规格检查。**不需要新工具**；读 `get_task_report` 的 visual 段落与离线 HTML 即可看到指标、差异区域与证据。

```text
# 视觉阻塞（缺基准 / 页面不可达 / 资源被拦）→ needs_attention，等待用户处理
query_task(taskId=tsk_...)
# 处理后重新验收：系统先 verify，通过即结束；只有真实缺陷才启动 agent
rework_task(taskId=tsk_...)
```

基准必须由用户审阅批准，禁止自动批准：

```text
# 1) 生成候选（截图或导入参考图），返回 candidateId/digest/preview
prepare_visual_baseline(projectPath=D:/repo/app)
# 2) 用户查看 preview 后明确授权，再带摘要批准
approve_visual_baseline(candidateId=<uuid>, expectedDigest=<sha256>,
  approvalNote="用户已审阅候选并批准", taskId=tsk_...)
```

- 两个工具都是 `write` + 需宿主审批的有副作用操作；**自动返修禁止调用批准入口**。
- 缺基准只能生成候选，**不能判视觉通过**；候选被改、原基准变化、跨项目候选都会拒绝。
- 不要为了通过而修改基准、阈值、屏蔽区域或关闭规则——会被规则冻结检测拦截并报 `VISUAL_INTEGRITY`。
- 配置或基准变化时用 `tianshu-mcp visual rules review/approve` 建立新的任务快照（CLI 在 stdio 前分流）。
- 视觉缺陷返修时，报告会给出检查 ID、路由/文件、视口、预期与实际指标、差异区域及证据路径。
- 报告 `visual.results[]` 每项 status 为 `passed`/`failed`/`blocked`/`skipped`，并带 `optional`、稳定原因码 `code`、`repairable` 与产物路径；禁用视觉时整个 `visual` 字段省略（旧报告仍可读）。
- CLI 辅助命令：`tianshu-mcp visual init|doctor [project]`、`visual browser install`、`visual artifacts clean <taskId> [--apply]`（默认只预览）。

## 6. 查历史：list_tasks 示例

```text
# 某项目最近失败/需关注的任务
list_tasks(projectPath=D:/repo/app, status=needs_attention, limit=10)

# 全局最近 50 条
list_tasks()
```

返回每行一条的文本（列：taskId / status / agent / project / 任务摘要），可用于接续 `get_task_report` / `rework_task`。`projectPath` 会与 run_task 同样做 realpath 归一；`status` 传终态或过程态枚举值（如 `needs_attention`）。

## 7. 返修提示语模板

给 `rework_task(taskId, feedback)` 的 `feedback`，讲究**针对性**，避免空转：

```text
请针对上一次验收失败项定向修复：
1. <失败 check 名> 未通过：<把报告输出尾部的关键错误贴进来>
2. <代码分析命中项，如 debugger/console.log 残留>：请移除
3. 约束提醒：<只改必要文件，不要重构无关部分>
```

坏例子（空转）：

```text
再试试，还不行就继续修。
```

好例子（拿 get_task_report 的失败项喂回去）：

```text
上一轮 `npm run build` 报错：TS2345: Argument of type 'string' is not assignable to
parameter of type 'number' (src/run.ts:42)。请只修这一处类型问题并重跑 npm run build 确认。
```

补充：自动返修（autoFixRounds）路径下，server 会先把失败证据写成修复计划文档，再把该文档路径引用进下一轮指令。**落盘位置按 agent 不同**：

- `codex`：写到**项目内** `fixPlanDir`（默认项目根 `.zcode/plans/codex-fix-r<N>.md`，文件名含轮次不覆盖历史）——因为 Codex 只能读项目工作区内的文件。
- `zcode` / `traework` 等其余路径：写到 **MCP 任务数据目录**（`<home>/tasks/<taskId>/rework-<taskId>-r<N>.md`），避免临时计划污染项目工作区。

手动 `rework_task` 的 feedback 则按上面的针对性模板书写，不生成计划文档。

## 8. needs_user 恢复与取消示例

### 8.1 codex 停在等待用户确认（user_confirmation）

轮询时看到任务转为 `needs_user`、`needsUserKind=user_confirmation`（Codex 停止按钮持续可见且对话长时间未变化，如方案确认卡/订阅确认页）：

```text
1) 提示用户：请在 Codex 窗口完成该确认（点确认/继续/订阅按钮等）。
2) 用户确认已处理后：continue_task(taskId, message="已在 Codex 窗口确认")
3) 恢复后 MCP 只重新接入观察（不会向 Codex 发送消息），继续 query_task 轮询到终态。
```

注意：若用户尚未处理就调 continue_task，任务会再次转 `needs_user`（如实反映 GUI 状态），稍后再试即可。

### 8.2 codex 需要登录（login_required）

```text
在 Codex 窗口完成登录 → continue_task(taskId, message="已登录")
MCP 复检环境后重新派发任务书（新会话 + 项目绑定 + 完整初始指令）。
```

### 8.3 zcode 初始化恢复未完成（setup_recovery）

`needsUserKind=setup_recovery` 表示 ZCode 的项目设置阶段自动恢复（有限重试 + 预算）用尽——常见于项目同名歧义、绑定回读不一致、原生面板操作超时：

```text
1) 提示用户：请在 ZCode 中确认目标项目（必要时手工完成绑定/关掉多余面板）。
2) continue_task(taskId, message="已在 ZCode 中确认目标项目")
3) 注意 message 只是"已处理"的确认，不会作为问题发送；原任务上下文被保留。
```

### 8.4 取消 GUI agent 任务（cancel_task）

```text
cancel_task(taskId, reason="用户要求停止")
→ 返回 meta.message：
  "已取消：…；GUI 内运行已停止。"                      ← 已确认停止，可安全重派
  "已取消：…；GUI 内运行未确认停止，…窗口中的任务可能仍在继续。" ← 需人工检查
  "已取消（等待用户处理时）：…；GUI 内可能仍有等待中的会话，请人工检查。"
  "已请求取消，但任务尚未在本调用内落终态…"            ← 稍后 query_task 复核
```

GUI agent 取消语义：尽力点击界面停止按钮并等待 GUI 空闲（有界超时）；**未确认停止前不要重派同项目任务**——重派护栏会以 `instance_busy` 拒绝派发（防止新旧 turn 交叠），宁可等人工确认。

### 8.5 agent-profiles.json 相关配置（可选）

```json
{
  "profiles": {
    "codex": {
      "gui": {
        "stallTimeoutMs": 300000,
        "cancelWaitMs": 15000,
        "selectors": { "userGate": "[class*=\"embedded-checkout\"]" }
      }
    }
  }
}
```

- `stallTimeoutMs`：停止按钮持续可见 + 对话无变化持续此时长 → 判定等待用户（默认 300000=5 分钟）。长命令型任务（大依赖安装/构建）建议调大。
- `cancelWaitMs`：取消时点击停止按钮后等待 GUI 空闲的上限（默认 15000=15 秒）。
- `selectors.userGate`：等待用户界面的检测选择器（如结账页 `embedded-checkout`、确认卡），配置后命中即快速转 `needs_user`；默认未配置=禁用，配置前请真机核对。
- profile 的整键覆盖语义：数据目录 `agent-profiles.json` 里同名键会**覆盖**内置 profile 的对应字段；用户自定义 profile（如 `codex-cli`）会出现在 `get_profiles` 中。

## 9. 汇报模板

`get_task_report` 拿全文后向用户汇报建议包含：

```text
任务 <taskId> 已完成（<agent>，model=<model>）。
- 变更文件：src/a.ts、src/b.ts（+18 -4）
- 自动命令检查：build PASS / test PASS / lint 跳过
- 代码分析：无可疑标记；注意 README 存在超大单文件改动（告警）
- 验收报告：<report.md 路径>
```

失败/需关注时的汇报建议包含：`errorType`/`agentEndReason` 与 `message` 原文、失败的 check 名与输出尾部、变更文件与 diffstat、下一步建议（针对性返修 / 人工介入 / 换 agent / 缩小任务）。
