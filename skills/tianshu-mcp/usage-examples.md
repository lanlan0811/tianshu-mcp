# tianshu-mcp 使用示例（子文件）

正文过长方法论不背：任务书模板、三种 agent 派活示例、meta 块字段解读、验收与返修模板都在这里，按需用读取文件工具查看。

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

## 2. 三种 agent 派活示例

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
- `needsUserKind=close_existing_instance / login_required / system_permission`：先让用户处理（关旧实例 / 登录 / 授系统权限），message 仅作为用户已处理的确认。

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

## 3. meta 块解读示例

`run_task` / `query_task` 等结果文本末尾的结构化块：

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
| `needsUserKind` | needs_user 时的等待类型：agent_question/close_existing_instance/login_required/system_permission |
| `pendingQuestion` | needs_user 时 agent 提出的问题原文 |
| `round` / `roundsUsed` | 已进行的 agent 轮次 |
| `changedFiles` | 相对 git 基线的变更清单（含未跟踪新增） |
| `diffstat` | 增删行摘要（`+A -D`） |
| `reportFiles` | 最近一轮验收报告 md/json 绝对路径 |
| `logFile` | 最近一轮 agent 日志 |
| `reportRound` | 最近一次验收的报告轮次（0-based，区别于 agent 轮次） |
| `verificationSource` | 最近一次验收来源：auto（run_task 自动）/ manual（verify_task 手动） |
| `latestVerificationVerdict` | 手动验收结论（不改变任务终态时单独记录） |
| `abortSource` | 中断来源：user/shutdown/timeout/internal |
| `model` / `mode` / `reasoningLevel` | 本次派单的模型 / 面板模式 / 思考等级（按 agent 生效） |

规则：`ok=true` 且 status=succeeded → 交付达成；否则读 `message` 与 `reportFiles.md` 全文定位。

## 4. 验收：verify_task 示例

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

## 5. 查历史：list_tasks 示例

```text
# 某项目最近失败/需关注的任务
list_tasks(projectPath=D:/repo/app, status=needs_attention, limit=10)

# 全局最近 50 条
list_tasks()
```

返回含每条任务的 taskId/status/agentId/时间摘要，可用于接续 `get_task_report` / `rework_task`。

## 6. 返修提示语模板

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

补充：自动返修（autoFixRounds）路径下，server 会先把失败证据写成修复计划文档（codex 写到项目 `.zcode/plans/`），并在下一轮指令中引用该文档；手动 `rework_task` 的 feedback 则按上面的针对性模板书写。

## 7. 汇报模板

`get_task_report` 拿全文后向用户汇报建议包含：

```text
任务 <taskId> 已完成（<agent>，model=<model>）。
- 变更文件：src/a.ts、src/b.ts（+18 -4）
- 自动命令检查：build PASS / test PASS / lint 跳过
- 代码分析：无可疑标记；注意 README 存在超大单文件改动（告警）
- 验收报告：<report.md 路径>
```
