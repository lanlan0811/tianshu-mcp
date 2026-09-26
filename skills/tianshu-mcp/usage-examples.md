# tianshu-mcp 使用示例（子文件）

本文件是 `SKILL.md` 的展开件：任务书模板、六种 agent 派活示例、meta 块解读、错误码速查、验收与返修模板、needs_user/取消示例、汇报模板。**方法论在主文件，这里只给可直接复制的形状**；需要哪节就读哪节。

约定：示例中的模型名、路径、端口都是**样例**，必须换成你机器上的实际值（模型名以界面/`get_profiles` 为准，路径必须真实存在）。

---

## 1. 任务书模板（`run_task` 的 `task` 字段）

```text
目标：<一句话，要做什么>
验收要点：
- <可验证的结果/行为，尽量写成可检查条件>
- <涉及命令：如 npm run build 应通过>
约束：
- <不改动范围 / 不要动哪些文件 / 要遵守的既有风格>
相关文件：
- `src/xxx.ts`（做什么用）、`test/yyy.test.ts`（在哪加用例）
上下文：
- <背景 / 已知约定 / 为什么这么做>
```

真实可用示例：

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

要点：

- 「相关文件 / 上下文」里的项目内路径**用反引号或 `./` 相对路径**书写（如 `` `src/run.ts` ``、`./docs/plan.md`）。task/context 中的路径引用会在**发送前**校验存在性与项目边界，写错立即报错，而不是带病派单。
- 长背景拆到 `run_task` 的 `context` 参数更清爽：它以【上下文与约束】拼进初始指令。
- **纯只读/纯排查任务**：任务书写清楚“不要修改任何文件”，并确认项目 `.tianshu-mcp/acceptance.json` 里 `requireChanges: false`（否则零变更必然判失败，见 §5.1）。

---

## 2. 派活示例（六种）

### 2.1 codex（默认；`model` 必填，支持 `reasoningLevel` / `planDoc` / `designSystem`）

```text
run_task(projectPath=D:/repo/app, agentId=codex,
  model=GPT-5.6 Sol,
  reasoningLevel=高,
  planDoc=./docs/plan.md,
  designSystem=./design-system,
  task=按计划文档实现列表页与详情页,
  autoVerify=true, autoFixRounds=5)
```

- `planDoc` / `designSystem` 会被拼进初始开发指令（「根据计划文档(<planDoc>)…和设计系统(<designSystem>)…」），**路径必须存在且在项目内**。
- `reasoningLevel`：`低/中/高` 或 `low/medium/high`；不传时沿用面板当前等级。
- **不支持 `mode`**（传了直接报错）。
- 冷启动实测 60–90 秒，首轮等待偏慢属正常，**不要因为慢就取消**。
- 模型名必须是面板里的名字；错误文本会附可见候选。

### 2.2 zcode（`model` 必填且为「供应商/模型」）

```text
run_task(projectPath=D:/repo/app, agentId=zcode,
  model=DeepSeek/deepseek-flash,
  task=按 `./docs/plan.md` 与 `./design-system` 实现功能,
  autoVerify=true, autoFixRounds=2)
```

发送前会确认「完全访问」权限模式；`mode` 不支持；`allowCreateProject` 见 §2.4。

若 `query_task` 返回 `needs_user`，先读 meta 的 `needsUserKind` 与 `pendingQuestion`：

```text
continue_task(taskId=tsk_..., message=采用 PostgreSQL 方案)
```

- `agent_question`：`message` 作为答案发送到**原会话**。
- `close_existing_instance` / `login_required` / `system_permission` / `setup_recovery`：先让用户处理（关旧实例 / 登录 / 授系统权限 / 在 ZCode 里确认目标项目），`message` 仅作为「已处理」确认。
- **traework 不支持 `continue_task`**；若 traework 任务停在 `needs_user`，需人工处理后重派新任务。

### 2.3 ZCode 无项目派发（省略 `projectPath`）

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
- 成功后终态文案是「未进行项目验收」；对该任务调 `verify_task` / `get_task_report` 会得到 `not_applicable: no_project`，**不会从 cwd 推导目录**。
- 省略 `projectPath` 但解析出的 agent 不是 ZCode（例如项目默认 agent 是 codex）会返回参数错误——**不会被悄悄改判为 ZCode**。

### 2.4 派到 ZCode 但禁止自动创建项目

```text
run_task(
  projectPath=D:/repo/my-app,
  agentId=zcode,
  model=DeepSeek/deepseek-flash,
  task=修复登录超时,
  allowCreateProject=false
)
```

目标目录不在 ZCode 项目列表中时返回 `project_not_registered`，且**在任何导入副作用之前**停止（不打开原生文件夹对话框、不添加项目）；在 ZCode 中手动登记后重提即可。省略该参数则保持既有自动导入行为。其他 agent 传该参数会得到「不支持」错误。

### 2.5 traework（`model` 可选；**唯一支持 `mode`**）

```text
run_task(projectPath=D:/repo/app, agentId=traework,
  model=GLM-5.3,
  mode=Code,
  task=重构导出模块,
  autoVerify=true)
```

- `mode` 取 `Work` / `Code` / `Design`；不传时从任务书文本识别「切换 X 模式」，识别不到保持 `Work`。
- 窗口必须保持可见（发送依赖模拟输入）；实现顺序固定为「新建会话 → 切模式 → 在目标模式内绑定项目」——**Work/Code/Design 各自维护独立的项目绑定**。
- 停在 `needs_user` 时**无法恢复**：人工处理后重派。

### 2.6 kimicode（`model` 必填且填界面模型名；档位按界面实际集合校验）

```text
run_task(projectPath=D:/repo/app, agentId=kimicode,
  model=K3,
  reasoningLevel=high,
  task=按 `./docs/plan.md` 实现功能,
  autoVerify=true, autoFixRounds=2)
```

- `model` **必填**，直接填**界面上的模型名**（如 `K3`、`K2.8 Preview`、`K2.7 Code Highspeed`）；非官方模型填全名（如 `stepfun/step-3.7-flash:free`）。名字必须与界面一致，否则发送前以 `model_unavailable` / `model_mismatch` 失败（错误文本附可见候选）。
- `reasoningLevel` 取值域**刻意不含 `中`/`medium`**：官方模型用 `低/low`、`高/high`、`max`；非官方模型只有 `on` / `off`。
  档位集合以**界面实际渲染的标签**为准——传了界面不存在的档位会在发送前报错（**绝不静默沿用**）。不传时：官方档位沿用界面当前值，非官方档位强制 `on`。
- **不支持 `mode`**；**`allowCreateProject` 不适用**（ZCode 专用）；**`projectPath` 必填**——Kimi Code 以工作区组织任务，**不支持无项目派发**。
- 未登记的工作区会自动经原生「添加工作区」对话框导入；若与已登记工作区同名或路径重复，会 fail-closed 报歧义，**不会猜一个点**。
- 首次启动偏慢（`launchTimeoutMs` 90s）；若已有未开 CDP 的 Kimi Code 实例，任务转 `needs_user(close_existing_instance)`，需用户手动关闭后 `continue_task`。
- 官方额度用尽时界面返回 `provider.auth_error` / `HTTP 403` 并判 `agent_error`——可改用非官方免费模型（如 `stepfun/step-3.7-flash:free`）后重派。
- 排查提示：模型 / 思考档位 / 执行模式菜单渲染在独立的 `Kimi Browser Overlay` 浮层窗口，**别在主窗口找**。

### 2.7 qoder（仅 Qoder CN；`projectPath` + 可读 `planDoc` 必填）

```text
run_task(projectPath=D:/repo/app, agentId=qoder,
  planDoc=./plans/development.md,
  modelSource=custom,
  model=<界面模型名>,
  reasoningLevel=极高,
  task=按计划实现项目，并满足计划中的验收条件,
  autoVerify=true, autoFixRounds=3)
```

- `model` 与 `reasoningLevel` 都可省略（**沿用界面当前值并记录**）；不可把示例名当真实模型。
- `modelSource=default|custom` 用于消除「默认/自定义」两组**同名**歧义；省略 `modelSource` 但只给 `model` 时要求**跨组唯一精确匹配**，重名报 `qoder_model_ambiguous`，不要靠猜。
- `reasoningLevel` 支持 `低/中/高/极高/最大/关闭思考`（等价 `low/medium/high/xhigh/max/off`）。可用档位以**该模型在「模型管理」里实际渲染的选项**为准，不支持的档位在**发送前**报错，禁止静默降级。
- 思考等级是 **Qoder 全局偏好**：保存后影响之后的任务，任务结束**不还原**；报告会记录实际模型与等级。权限模式沿用当前设置，**不自动开「完全访问」**。
- 工作区以**完整路径**匹配；未登记目录经「新的任务 → 工作区 → 新建工作区 → 添加可读写文件夹 → 创建」导入；目录不存在直接报错，**不会自动创建磁盘目录**。
- **自动与手动返修都先落修复计划**，再把失败说明、计划文件名、完整路径与**全文**发回原会话（即使计划文件在项目目录外，也有全文可执行）。
- **macOS 禁止派发**（`unsupported_platform`，状态为 `research`）。
- 多题续答：`continue_task` 的 `message` 传 **JSON 对象字符串**，键为界面上**完整问题文字**：

```json
{"选择开发语言":"TypeScript","需要哪些测试":["单元测试","集成测试"]}
```

多选值用选项文字数组；先全量校验再操作答题控件，题目变化 / 缺答案 / 选项不存在都**保留等待**，**不接受推荐项代替答案**。单题可直接用普通文本。

### 2.8 opendesign（⚠️ 开发中：界面接线未完成，当前派活会硬失败 `selector_drift`）

```text
run_task(projectPath=D:/repo/design, agentId=opendesign,
  model=<界面模型名>,
  designSystem=Claude,
  designDirection=原型,
  task=为落地页设计一段，用大幅建筑摄影和流畅的滚动动效呈现项目特色,
  autoVerify=true, autoFixRounds=2)
```

- `designDirection` **必填**：只支持 `原型` / `文档` / `网站复刻`（等价 `prototype` / `document` / `clone`）。
  UI 里还有 `幻灯片` / `图片` / `HyperFrames`，但适配器**不支持**，且是在**入口**就拒绝（不会进 GUI 才报错）。
- `designSystem` 传**设计系统名**（如 `Claude`、`Neutral Modern`），不是目录路径——与 codex 的 `designSystem` 语义不同（那边是目录）。
- `mode` 不支持（那是 traework 的面板模式）；`model` 必填，按名字**精确匹配**菜单项，未命中会报错并**回显当前可见候选**，不会退化成模糊匹配。
- 目录绑定按「展开工作目录 → 选择目录 → 原生『选择文件夹』填绝对路径 → **回读显示值校验**」；已是目标目录则跳过。
- 视觉验收要求项目里有可截图的页面来源；适配器只**推导建议**（静态入口优先），**不会自动修改** `.tianshu-mcp/acceptance.json`。
- 修复/优化计划落项目根 `.opendesign/plans/`（Open Design 只能读它工作目录白名单内的文件）。
- **当前阶段**：选择器尚未真机采集完，派活会硬失败 `selector_drift` 并列出缺失键；这不是缺陷而是 fail-closed 保护。
  详见 [docs/opendesign-cdp.md](../../docs/opendesign-cdp.md) 与 `.dsh/plans/opendesign-gui-adapter-plan.md`。

### 2.9 codex-cli（用户自建 profile；无头路径，无 GUI）

内置 `codex` 走桌面 GUI 驱动。不想依赖 GUI 自动化（或需要可复现的无头执行）时，在数据目录 `~/.tianshu-mcp/agent-profiles.json` 加一个 `driver=spawn` 的 profile（示例见 README「macOS 无头路径：codex-cli」），之后按普通 agent 派活：

```text
run_task(projectPath=/path/to/项目, agentId=codex-cli,
  task=按计划实现功能, autoVerify=true, autoFixRounds=2)
```

- `model` 参数对 spawn 类 agent **不生效**（CLI 用 `~/.codex/config.toml` 的默认模型）；要锁模型就在 `argsTemplate` 里追加 `"-m", "<模型名>"`。
- codex CLI 需 **≥0.154.0**（≤0.130.0 签名证书已吊销，macOS Gatekeeper 直接 SIGKILL）。
- 写入被 `workspace-write` 沙箱限制在项目目录内；POSIX 下取消/超时对进程组 `SIGTERM`→`SIGKILL`。
- **无头路径没有 GUI 交互**：不存在 `user_confirmation` 这类等待，`continue_task` 不适用；失败直接看 `agentEndReason` 与日志。

### 2.9 通用约定

- `run_task` 是**异步契约**：立即返回 `taskId` + 队列位置，不要当同步调用等结果。
- 轮询间隔 5–10 秒（`query_task` 缺省返回 agent 日志末 40 行）；同项目串行 + 全局并发默认 2，重复派单只会排队。
- **重试复用同一条 `idempotencyKey`（issue #15）**：`tools/call` 超时、断线、宿主重启后重发同一意图时，`run_task` 会返回**原 `taskId` 与当前状态**（不排队第二轮 agent），`verify_task` 会返回「进行中」或既有报告（不重跑检查）。**参数变了就换 key**——同键异参 fail-closed 报错并回报原记录 id。幂等重放的响应文本以「幂等重放：」开头、meta 带 `idempotencyReplay`，不要汇报成「已重新派单」。
- 只有 `needs_user` 能用 `continue_task` 恢复，且当前支持 **codex / zcode / kimicode / qoder / opendesign**（opendesign 目前只会产出 `close_existing_instance`，恢复语义为「复检环境后补发完整任务书」）；traework 与 spawn 类会被明确拒绝。
- `autoVerify` 不传时**默认开**；`autoFixRounds` 不传时取 agent 缺省（codex 5 / zcode 2 / kimicode 2 / qoder 3 / traework 落 server 默认 0）。

---

## 3. 参数速查（易错项）

| 参数 | 谁支持 | 易错点 |
|---|---|---|
| `modelSource` | 仅 qoder | 传给其他 agent 直接报错 |
| `reasoningLevel` 别名 `极高`/`xhigh`/`最大`/`关闭思考` | 仅 qoder | 传给其他 agent 直接报错 |
| `mode` | 仅 traework | 其他 agent 传了报错 |
| `allowCreateProject` | 仅 zcode（有项目模式） | 其他 agent 传了报错 |
| `planDoc` | codex（可选）、qoder（**必填**） | qoder 的计划文件必须存在且可读，相对路径按项目根解析 |
| `designSystem` | 仅 codex | 路径必须存在且在项目内 |
| `projectPath` 省略 | 仅 zcode | 其余 agent 需要 `projectPath`；Kimi Code 尤其如此 |
| `extraChecks` / `checksMode` / `baselineRef` | 仅 verify_task | 独立 projectPath 下 `baselineRef` 只能是 git ref，不能是任务 ID |
| `idempotencyKey` | run_task / verify_task | trim 后 1..128 字符、不含控制字符；**两工具各自独立命名空间**；同键异参 fail-closed；不传即维持原行为 |
| `tailLines` | query_task | 缺省 40 行 |
| `round` | get_task_report | **0-based**；缺省最新；显式 `0` 合法 |

---

## 4. meta 块解读（字段全表）

除下列情况外，各工具结果文本末尾都是「人类可读文本 + 结构化 meta」：

- `get_task_report` 成功时直接返回 `report-<round>.md` 原文；
- `prepare_visual_baseline` / `approve_visual_baseline` 成功时直接返回视觉操作的 JSON 原文；
- **任何工具的错误结果**都只有 `Error: …` 文本，不带 meta 块。

```text
---tianshu-mcp-meta---
{
  "ok": false,
  "taskId": "tsk_20260922120000_a1b2c3",
  "status": "needs_attention",
  "agentId": "qoder",
  "projectPath": "d:/repo/my-app",
  "model": "<派单时的模型参数>",
  "actualModel": "<实际生效模型>",
  "actualReasoningLevel": "极高",
  "modelSource": "custom",
  "round": 2,
  "changedFiles": ["src/a.ts", "src/b.ts"],
  "diffstat": "+18 -4",
  "reportFiles": { "md": "<任务目录>/report-1.md", "json": "<任务目录>/report-1.json" },
  "logFile": "<任务目录>/agent-1.log",
  "errorType": "verify_failed",
  "agentEndReason": "completion_mark",
  "reportRound": 1,
  "verificationSource": "auto",
  "qoderSessionId": "<会话 id>",
  "guiStop": { "clicked": true, "idle": true },
  "message": "验收失败，自动返修轮次已用尽（3/3 轮）。…"
}
---tianshu-mcp-meta---
```

读法（按决策用途分组）：

| 字段 | 含义 |
|---|---|
| `ok` | 是否成功（**仅 `status=succeeded` 时为 true**） |
| `status` | `queued`/`running`/`verify_start`/`fixing`/`needs_user`/`succeeded`/`failed`/`needs_attention`/`cancelled`/`interrupted` |
| `message` | 状态摘要 / 失败原因，**最先读** |
| `errorType` | 失败归类：`timeout`/`spawn`/`agent_failed`/`verify_failed`/`cancelled`/`interrupted`/`agent_unresolved`/`internal` |
| `agentEndReason` | agent 侧结束原因（硬失败定位主用，取值见 §5） |
| `lastRunSignal` | 最近一次运行观察到的信号（GUI 完成标志/空闲判定依据） |
| `needsUserKind` | `needs_user` 时的等待类型（六类，见 §8） |
| `pendingQuestion` | `needs_user` 时的问题原文或需用户处理事项说明 |
| `round` | 已进行的 agent 轮次（= `roundsUsed`） |
| `changedFiles` / `diffstat` | 相对 **git 基线**的变更清单（含未跟踪新增）与增删摘要 |
| `reportFiles` / `logFile` | 最近一轮验收报告 md/json 与 agent 日志的绝对路径 |
| `reportRound` | 最近一次验收的报告轮次（**0-based，区别于 agent 轮次**） |
| `verificationSource` | 最近一次验收来源：`auto`（run_task 自动）/ `manual`（verify_task） |
| `latestVerificationVerdict` | 手动验收结论（不改变任务终态时单独记录） |
| `checks` | 本轮检查项摘要（name / passed / durationMs） |
| `abortSource` | 中断来源：`user`/`shutdown`/`timeout`/`internal` |
| `cancelReason` / `cancelRequestedAt` | 取消原因与发起时间 |
| `keptInstance` | 是否因任务未真正完成而保留了 GUI 实例 |
| `zcodeSessionId` / `qoderSessionId` / `boundProjectPath` | 会话锚点与项目绑定回执（kimicode 的锚点仅在服务端保留，不回显） |
| `modelProvider` / `permissionMode` | 实际生效的供应商标识与权限模式（zcode 等） |
| `actualModel` / `actualReasoningLevel` / `modelSource` | 实际生效模型、等级与模型来源（qoder） |
| `guiStop` | 最近一次中断时 GUI 停止的点击与空闲确认结果（`clicked` / `idle`）；`idle=true` 才是**已确认**停止 |
| `guiStopUnconfirmed` | 出现即为 `true`：GUI 任务的终态**未确认**停止（`guiStop.idle=false` 或重启归档无任何确认手段），重派前必须先人工确认并用 `cancel_task` 消除（§9.5.1） |
| `progressSummary` / `lastRunSignal` | 轮询期进度摘要 / 最近运行信号 |
| `finishedAt` | 终态落定时间 |
| `model` / `mode` | 本次派单传入的模型 / 面板模式 |
| `idempotencyKey` | 本次调用携带的幂等键（issue #15；调用方自己传入的原文） |
| `idempotencyReplay` | `hit` = 返回既有任务/报告且未执行；`in_progress` = 同键验收正在执行、本次未重复执行；**缺省 = 本次为真实执行** |
| `projectActiveTask` | 未传幂等键时，同工作区已存在的**未结束**任务 `{taskId, status}`（仅提示，不拦截派单） |

规则：`ok=true` 且 `status=succeeded` → 交付达成；否则先读 `message`，再按 `errorType` / `agentEndReason` 查 §5，最后读 `reportFiles.md` 全文定位。

> **注意**：`reasoningLevel` 是**入参**，不回显在 meta 里；qoder 的实际等级看 `actualReasoningLevel`，codex 的实际等级只能在面板上看。

---

## 5. 硬失败错误码速查

**硬失败**（`hardFailure`）表示基础设施/环境/前置条件问题，**不进验收、不进自动返修**，落 `failed` + `errorType=spawn`。把它当「agent 没做好」反复重试是空转。

先记终态映射：

| `agentEndReason` | 终态 |
|---|---|
| `task_timeout` | `needs_attention` + `errorType=timeout`（codex/zcode）；qoder 落 `failed(timeout)` |
| `idle_timeout` / `cdp_disconnected` | `needs_attention` + `errorType=agent_failed`（codex/zcode） |
| 其余 `hardFailure` | `failed` + `errorType=spawn` |

| `agentEndReason` | 含义 | 处置 |
|---|---|---|
| `setup_failed` | 找不到安装 / 实例未就绪 / 点不到「新对话」 | 让用户确认已安装且能手动打开；重试一次 |
| `project_ambiguous` | 项目同名或路径重复，无法消歧 | 已转 `needs_user(setup_recovery)`：请用户确认目标项目后 `continue_task` |
| `project_mismatch` | 项目绑定或回读不一致，幂等重试仍失败 | 同上：请用户在 GUI 里确认或手工绑定 |
| `project_create_failed` | 在 GUI 内新建项目失败 | 让用户手动把项目加进 agent，或换 `projectPath` |
| `project_not_registered` | ZCode `allowCreateProject=false` 且目录未登记 | 在 ZCode 中手动登记该项目后重提 |
| `model_unavailable` | 面板里找不到指定模型（附可见候选） | 用面板实际模型名重派 |
| `model_mismatch` | 模型回读与期望不符 / 档位不被该模型支持 | 确认 `model` 与界面完全一致；档位改到界面实际存在的集合 |
| `permission_unknown` | 权限模式未确认（如 ZCode 未开「完全访问」） | 让用户在 agent 内切好权限模式 |
| `cdp_disconnected` | CDP 连接断开且未能恢复 | 让用户关掉冲突实例；重试 |
| `instance_busy` | 同项目/同实例已有未停止的运行（重派护栏） | 先 `cancel_task` 并**确认 GUI 已停**，或等其自行结束 |
| `session_lost` | zcode/kimicode/qoder 找不到原会话锚点 | 用新任务重派，不要指望恢复原会话 |
| `input_mismatch` / `send_unknown` | 发送前回读不一致 / 发送结果无法确认（**绝不自动重发**） | 人工看窗口状态，必要时 `continue_task` 或重派 |
| `idle_timeout` | GUI 长时间静止且无完成标志（现场已保留） | 看窗口里 agent 是否真卡住；必要时 `continue_task` 或取消 |
| `agent_error` | Kimi Code 界面出现失败文案/「继续」按钮（如官方额度用尽 `provider.auth_error`） | 读窗口内错误原文；额度/模型类可换非官方免费模型后重派 |
| `unsupported_platform` | Qoder 在非 Windows 平台派发 | 换平台或换 agent（qoder 的 macOS 状态是 `research`） |
| `qoder_error` | Qoder 运行期错误，原文带具体码：`qoder_model_ambiguous` / `qoder_model_missing` / `qoder_model_readback_failed` / `qoder_reasoning_unsupported` / `qoder_workspace_mismatch` / `qoder_workspace_ambiguous` / `qoder_folder_dialog` / `qoder_input_readback_failed` / `qoder_question_ambiguous` / `qoder_question_answers_required` / `qoder_question_unknown_title` / `qoder_question_answer_missing` / `qoder_question_option_unavailable` / `qoder_question_not_multiselect` / `qoder_question_changed` / `qoder_session_lost` / `qoder_stage_timeout` / `qoder_checkpoint_missing` | 按码处置：模型/档位类按界面实际值重派；工作区类让用户确认目录；提问类补齐答案或用 JSON 对象、选项文字必须与界面一致；`*_stage_timeout` 多为窗口未前台/被遮挡 |
| `task_timeout`（`errorType=timeout`） | 任务级超时 | 大任务调大 `taskTimeoutMs`；或拆小任务 |
| `aborted` | 被取消 / 中断 | 看 `abortSource`，按 SKILL §6 处理 |

上表未覆盖的：先读 `message` 全文（多数带可执行建议），再读 `reportFiles.md`。

**另一类“报错”不是任务终态**，而是工具入参被拒（立即返回，不排队、不产生任务）：`allowCreateProject` 用于非 ZCode、`mode` 用于非 traework、`modelSource` 用于非 qoder、`极高/最大/关闭思考` 用于非 qoder、qoder 缺 `planDoc` 或计划文件不可读、无项目模式传 `autoVerify=true`/`autoFixRounds>0`、`verify_task` 既没给 `taskId` 也没给 `projectPath`、以及**幂等键冲突**（见下）。这类改参数重试即可。

**幂等键冲突（issue #15）**：报「`idempotencyKey '<key>'` 已被任务/验收记录 `<id>` 占用，但本次参数与首次提交不同」= 你复用了旧 key 却改了参数（换了项目、任务书、agent、`extraChecks` 等）。处置：**改用一条新 key** 重发，或直接对原记录 id 操作（`query_task` / `get_task_report` / `rework_task`）；不要靠改参数绕过冲突。

**幂等重放不是新执行**：`run_task` 命中同键 → 文本「幂等重放：该 idempotencyKey 已对应任务 `<taskId>`（未新建任务）」+ `idempotencyReplay: "hit"`；`verify_task` 命中执行中 → 「该 idempotencyKey 对应的验收仍在执行中（未重复执行）」+ `"in_progress"`（**成功结果**，不是错误）。汇报时必须如实说明「未新建 / 未重跑」。

---

## 6. 验收：verify_task 示例

不改源码、无需审批（能力归 `execute`：会跑项目命令、可产生构建产物）。三种典型用法：

```text
# 1) 复跑某任务的验收（用该任务动工前基线；round 缺省对最新状态）
verify_task(taskId=tsk_...)

# 2) 独立健康检查（无任务上下文，按当前基线）
verify_task(projectPath=D:/repo/app)

# 3) 临时加验 + 指定基线（extraChecks 追加在基础集之后）
verify_task(projectPath=D:/repo/app, baselineRef=HEAD~1,
  extraChecks=[{name=lint, cmd=[npm, run, lint], timeoutMs=120000}],
  checksMode=append)

# 4) 幂等重试（issue #15）：宿主超时/断线后重发同一意图，复用同一条 key
verify_task(projectPath=D:/repo/app, checksMode=replace,
  extraChecks=[{name=smoke, cmd=[node, check.mjs]}],
  idempotencyKey="verify-app-20260923-1")
# → 执行中：成功结果 + idempotencyReplay="in_progress"（未重复执行）
# → 已完成：返回既有 reportRound 与报告路径（未重跑）
```

- **幂等键用法**：`idempotencyKey` 由宿主按「本次逻辑意图」生成**一次**，之后所有重试复用同一条；参数一旦变化必须换 key。`run_task` 的键与 `verify_task` 的键互不影响（各自命名空间）。TTL 默认 24h（见 §9.7），过期后同键会重新真实执行。

- `checksMode=replace` 时**只用** `extraChecks`，不跑项目基础集。
- `extraChecks` 单条支持 `name` / `cmd`（argv 数组或字符串）/ `timeoutMs` / `optional`（`optional:true` 失败只记 warning）。**`cmd` 请用数组**；字符串形态不支持转义，引号不闭合不报错而是静默拆成多个 argv。
- 命令优先级：`extraChecks` > 项目 `.tianshu-mcp/acceptance.json` > projects.json 管理员补录 > 按技术栈推导的默认集。
- 传 `taskId`：只更新该任务的验收结论字段，**不改写原任务终态**；任务没有保存的动工前基线时会报错，改用 `projectPath` 或传 `baselineRef`。
- 传 `projectPath`：`baselineRef` 只能是 **git ref**（如 `HEAD~1`）；写任务 ID 会报错。

### 6.1 项目级验收配置模板（写进目标项目仓库）

`<目标项目>/.tianshu-mcp/acceptance.json`：

```jsonc
{
  // 默认 true：git 项目相对动工前基线零变更即判失败（防“什么都没做却报成功”）
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

- `cmd` 推荐 argv 数组；字符串会被**安全分词**执行（`shell: false`，不拼 shell 字符串）。
- **纯只读/纯排查类任务必须设 `"requireChanges": false`**，否则零变更必然被判失败。
- 非 git 项目跳过零变更门禁并在报告注明。
- 默认并行 2 是有意为之（提速）；不确定就用 `verifyConcurrency: 1` 换确定性。

### 6.2 视觉验收与基准保护

项目在 `.tianshu-mcp/acceptance.json` 里配 `visual.enabled: true` 后，`run_task` / `verify_task` 会自动带上截图对比与静态图片规格检查。**不需要新工具**；读 `get_task_report` 的 `visual` 段落与离线 HTML 看指标、差异区域与证据。

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
# 2) 用户查看 preview 并明确授权后，带摘要批准
approve_visual_baseline(candidateId=<uuid>, expectedDigest=<sha256>,
  approvalNote="用户已审阅候选并批准", taskId=tsk_...)
```

- 两个工具都是 `write` + 需宿主审批的有副作用操作；**自动返修禁止调用批准入口**。
- 缺基准只能生成候选，**不能判视觉通过**；候选被改、原基准变化、跨项目候选都会被拒绝。
- 不要为通过而改基准、阈值、屏蔽区域或关闭规则——规则冻结会检出并报 `VISUAL_INTEGRITY`。
- 配置或基准变化时用 `tianshu-mcp visual rules review/approve` 建立新的任务快照（CLI 在 stdio 前分流）。
- 报告 `visual.results[]` 每项有 `status`（`passed`/`failed`/`blocked`/`skipped`/`uncertain`）、`optional`、稳定原因码 `code`、`repairable` 与产物路径；禁用视觉时整个 `visual` 字段省略（旧报告仍可读）。
- CLI 辅助：`tianshu-mcp visual init|doctor [project]`、`visual browser install`、`visual content probe <project> [ruleId]`、`visual content cache clear <taskId>`、`visual artifacts clean <taskId> [--apply]`（默认只预览）。

---

## 7. 查历史：list_tasks 示例

```text
# 某项目最近需关注的任务
list_tasks(projectPath=D:/repo/app, status=needs_attention, limit=10)

# 全局最近 50 条
list_tasks()
```

返回每行一条（列：taskId / status / agent / project / 任务摘要），可用于接续 `get_task_report` / `rework_task`。`projectPath` 与 `run_task` 同样做 realpath 归一；`status` 传状态枚举值（如 `needs_attention`、`succeeded`）。空结果返回「没有符合条件的任务。」。

---

## 8. 返修提示语模板

给 `rework_task(taskId, feedback)` 的 `feedback` 讲究**针对性**，避免空转：

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

好例子（拿报告里的失败项喂回去）：

```text
上一轮 `npm run build` 报错：TS2345: Argument of type 'string' is not assignable to
parameter of type 'number' (src/run.ts:42)。请只修这一处类型问题并重跑 npm run build 确认。
```

自动返修（`autoFixRounds>0`）落盘规则：

- **`codex`**：修复计划写到**项目内** `gui.fixPlanDir`（默认 `.zcode/plans/codex-fix-r<N>.md`，文件名含轮次、不覆盖历史）——因为 Codex 只能读项目工作区内的文件。
- **`qoder`**：写到 **MCP 任务目录**（`<home>/tasks/<taskId>/rework-<taskId>-r<N>.md`），并把**文件名、完整路径与全文**一起发回原会话（计划在项目目录外也能执行）。
- **`zcode` / `traework` / `kimicode` 等其余 agent**：写到任务目录（`rework-<taskId>-r<N>.md`），把路径引用进下一轮指令，避免临时计划污染项目工作区。

手动 `rework_task` 的 `feedback` 按上面的针对性模板书写；对 qoder，手动返修同样会先生成计划再回原会话（原会话锚点或验收报告缺失时会直接拒绝，不新开任务冒充续修）。

---

## 9. needs_user 恢复与取消示例

### 9.1 codex 停在等待用户确认（`user_confirmation`）

```text
1) 提示用户：请在 Codex 窗口完成该确认（点确认/继续/订阅按钮等）。
2) 用户确认已处理后：continue_task(taskId, message="已在 Codex 窗口确认")
3) 恢复后 MCP 只重新接入观察（不会向 Codex 发送消息），继续 query_task 轮询到终态。
```

用户尚未处理就调 `continue_task` 时，任务会**再次**转 `needs_user`（如实反映 GUI 状态），稍后再试即可。

### 9.2 codex 需要登录（`login_required`）

```text
在 Codex 窗口完成登录 → continue_task(taskId, message="已登录")
MCP 复检环境后重新派发任务书（新会话 + 项目绑定 + 完整初始指令）。
```

### 9.3 zcode 初始化恢复未完成（`setup_recovery`）

常见于项目同名歧义、绑定回读不一致、原生面板操作超时（自动恢复的有限重试与预算已用尽）：

```text
1) 提示用户：请在 ZCode 中确认目标项目（必要时手工完成绑定/关掉多余面板）。
2) continue_task(taskId, message="已在 ZCode 中确认目标项目")
3) message 只是「已处理」确认，不会作为问题发送；原任务上下文被保留。
```

### 9.4 qoder 提问续答与发送不确定（`agent_question` / `setup_recovery`）

```text
# 单题
continue_task(taskId=tsk_..., message=使用 TypeScript)

# 多题：message 是 JSON 对象字符串，键为界面上的完整问题文字
continue_task(taskId=tsk_..., message={"选择开发语言":"TypeScript","需要哪些测试":["单元测试","集成测试"]})
```

- 题目变化、缺答案、选项文字不存在、单选用数组：都会保留等待并报出对应 `qoder_question_*` 错误，**不会**拿推荐项/默认项代替。
- 若任务是因「发送或答题提交结果不确定」转 `needs_user(setup_recovery)`：**先人工核对原会话**，不要盲目继续或重发（适配器保留检查点，就是不重复提交）。

### 9.5 取消 GUI agent 任务（cancel_task）

```text
cancel_task(taskId, reason="用户要求停止")
→ 返回 meta.message 可能为：
  "已取消：…；已确认 <窗口名> 内运行停止。"                    ← 已确认停止，可安全重派
  "已取消：…；<窗口名> 内运行未确认停止，窗口中的任务可能仍在继续，请人工打开 <窗口名> 确认无残留运行。"  ← 需人工检查
  "已取消：…；<窗口名> 内运行无停止结果可确认，…（ZCode / TraeWork 无停止能力）"  ← 需人工检查
  "已取消（等待用户处理时）：…；GUI 内可能仍有等待中的会话，请人工检查。"
  "已取消 …（尚未落终态：GUI 侧停止可能未完成，请稍后 query_task 复核）"
```

GUI agent 取消语义：尽力点击界面停止按钮并等待 GUI 空闲（有界超时）。**未确认停止前不要重派同项目任务**——重派护栏会以 `instance_busy` 拒绝派发（防止新旧 turn 交叠），宁可等人工确认。也可看 meta 的 `guiStop`（`clicked` / `idle`）与 `guiStopUnconfirmed`：`guiStopUnconfirmed=true` 或 `guiStop.idle=false` 即未确认停止。

### 9.5.1 server 退出 / 重启后的 GUI 残留确认（issue #14）

```text
# server 退出（宿主退出 / stdio EOF）后重新接入：
query_task(taskId)
→ meta.status = "interrupted"，meta.abortSource = "shutdown"
   文案二选一：
     "server 退出；已确认 <窗口名> 内运行停止。"                 ← 停止已确认，可安全重派
     "server 退出；<窗口名> 内运行未确认停止，窗口中的任务可能仍在继续，请人工打开 <窗口名> 确认无残留运行。"
     "server 退出；<窗口名> 内运行无停止结果可确认，…"           ← 无停止能力（zcode / traework）
   meta.interruptedCleanStop = false、meta.guiStopUnconfirmed = true

# 重启归档（上一进程被 kill，来不及落终态）：
→ 文案为 "server 重启遗留（启动时归档，不续跑）；… 请人工打开 <窗口名> 确认无残留运行。"
   meta.guiResidualUnconfirmed = true

# 人工打开该窗口，确认没有还在跑的 turn 之后：
cancel_task(taskId, reason="已人工核对窗口无残留运行")
→ 清除待确认标记（追加 gui_residual_acknowledged 事件），status 仍是 interrupted
→ meta.guiStopUnconfirmed 变为不存在、meta.guiResidualUnconfirmed = false
```

**顺序纪律**：`guiStopUnconfirmed` 为真时**先人工确认、再重派**同项目任务——`tianshu-mcp` 对 GUI 进程没有所有权，`interrupted` 只说明**编排器**不再观察，不等于窗口里的任务已停。服务端在 shutdown 时会给 GUI 任务一份全局共享的 `shutdown.guiStopWaitMs`（默认 15 秒）预算去"尽力停止 + 有界等待"，但到期仍无法确认时只会如实标注，**不会**替你断言已停止；重启归档更是**不会**自动去点停止（无会话锚点、对无归属证明的实例 fail-closed）。

### 9.6 agent-profiles.json 相关配置（可选）

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

- `stallTimeoutMs`：停止按钮持续可见 + 对话无变化持续此时长 → 判定等待用户（默认 300000 = 5 分钟）。长命令型任务（大依赖安装/构建）建议调大。
- `cancelWaitMs`：取消时点停止按钮后等待 GUI 空闲的上限（默认 15000 = 15 秒）。
- `selectors.userGate`：等待用户界面的检测选择器（如结账页 `embedded-checkout`），配置后命中即快速转 `needs_user`；**默认未配置 = 禁用**，配置前请真机核对。
- `defaultAutoFixRounds`：该 agent 的自动返修缺省轮数（codex 5 / zcode 2 / kimicode 2 / qoder 3）。
- 整键覆盖语义：数据目录 `agent-profiles.json` 里同名键会**覆盖**内置 profile 的对应字段；用户自定义 profile（如 `codex-cli`）会出现在 `get_profiles` 中。

### 9.7 server 级配置（config.json，可选）

```json
{ "shutdown": { "guiStopWaitMs": 15000 }, "idempotency": { "ttlMs": 86400000, "maxEntries": 2000 } }
```

- `shutdown.guiStopWaitMs`：server 退出时，GUI agent 任务「尽力点击界面停止 + 有界等待空闲」的**全局共享**上限（默认 15000 = 15 秒，全部 GUI 任务共用一份预算，退出耗时不随任务数增长）。spawn 类任务不受影响（固定 2 秒等 `killTree` 收尾）。到期仍未确认空闲时，终态如实写「未确认停止」并置 `guiStopUnconfirmed`；调大它可以让退出时更容易等到确认结果，代价是退出（以及宿主关闭）变慢。
- `idempotency.ttlMs`：幂等键映射（`<数据目录>/idempotency.json`）的有效期，默认 `86400000`（24 小时）。TTL 内同键重试重放既有结果，过期后同键会**真实执行**——长周期重试场景可按需调大。
- `idempotency.maxEntries`：映射条目上限，默认 `2000`（1..100000）。超限按 `createdAt` 逐出最旧，只影响「是否还能重放」，不影响任何已创建的任务与报告。

---

## 10. 汇报模板

`get_task_report` 拿全文后，向用户汇报建议包含：

```text
任务 <taskId> 已完成（<agent>，model=<实际模型>，等级=<实际等级或“未指定”>）。
- 变更文件：src/a.ts、src/b.ts（+18 -4）
- 自动命令检查：build PASS / test PASS / lint SKIP（原因）
- 代码分析：无可疑标记；注意 README 存在超大单文件改动（告警）
- 验收报告：<report.md 路径>
- 未验证/阻塞项：<如实列出，例如“macOS 未验证”“AI 内容告警项未通过但不影响结论”>
```

失败 / 需关注时，汇报建议包含：`errorType` / `agentEndReason` 与 `message` 原文、失败的 check 名与输出尾部、变更文件与 diffstat、以及下一步建议（针对性返修 / 人工介入 / 换 agent / 缩小任务）。

**汇报纪律**：区分「实际通过」「未验证」「阻塞」三种状态；不把自动化测试通过当成真机 GUI 已验证；不把未完成的发布动作说成已完成。
