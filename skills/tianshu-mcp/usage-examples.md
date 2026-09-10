# tianshu-mcp 使用示例（子文件）

正文过长方法论不背：任务书模板、meta 块解读、返修提示语模板都在这里，按需 `read_file`。

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
- src/cli.ts（入口与参数定义）、src/run.ts（执行逻辑）
上下文：
- 现有 run 命令会写 out/ 目录；dry-run 应跳过全部写操作
```

## 2. meta 块解读示例

`query_task` / `run_task` 等结果文本末尾的结构化块：

```text
---tianshu-mcp-meta---
{
  "ok": false,
  "taskId": "tsk_20260907120000_a1b2c3",
  "status": "needs_attention",
  "agentId": "codex",
  "projectPath": "d:/repo/my-app",
  "round": 3,
  "changedFiles": ["src/a.ts", "src/b.ts"],
  "diffstat": "+18 -4",
  "reportFiles": { "md": "<路径>/report-2.md", "json": "<路径>/report-2.json" },
  "logFile": "<路径>/agent-2.log",
  "message": "验收失败，自动返修轮次已用尽（3/2 轮）。…"
}
---tianshu-mcp-meta---
```

读法：

| 字段 | 含义 |
|---|---|
| `ok` | 是否成功（succeeded 才有 true） |
| `status` | queued/running/verify_start/fixing/needs_user/succeeded/failed/needs_attention/cancelled/interrupted |
| `round` / `roundsUsed` | 已进行的 agent 轮次 |
| `changedFiles` | 相对 git 基线的变更清单（含未跟踪新增） |
| `diffstat` | 增删行摘要（`+A -D`） |
| `reportFiles` | 最近一轮验收报告 md/json 绝对路径 |
| `logFile` | 最近一轮 agent 日志 |
| `message` | 状态摘要/失败原因 |

规则：`ok=true` 且 status=succeeded → 交付达成；否则读 `reportFiles.md` 全文定位。

## 3. ZCode 派活与继续

```text
run_task(projectPath=D:/repo/app, agentId=zcode,
  model=DeepSeek/deepseek-flash,
  task=按 `./docs/plan.md` 与 `./design-system` 实现功能,
  autoVerify=true)
```

若 `query_task` 返回 `needs_user`：

```text
continue_task(taskId=tsk_..., message=采用 PostgreSQL 方案)
```

`agent_question` 的 message 会发送到原会话；关闭旧实例、登录或系统权限场景的 message 仅作为用户已处理的确认。

## 4. 返修提示语模板

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

## 5. 汇报模板

`get_task_report` 拿全文后向用户汇报建议包含：

```text
任务 <taskId> 已完成（<agent>）。
- 变更文件：src/a.ts、src/b.ts（+18 -4）
- 自动命令检查：build ✅ / test ✅ / lint 跳过
- 代码分析：无可疑标记；注意 README 新增超大改动 ⚠️
- 验收报告：<report.md 路径>
```
