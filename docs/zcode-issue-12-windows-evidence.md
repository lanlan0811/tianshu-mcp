# issue #12 Windows 10 真机验收记录（v0.5.2）

英文版：zcode-issue-12-windows-evidence.en.md

本文件记录 **ZCode 无项目派发（`default` 工作区）与 `allowCreateProject`** 在真实环境下的验收结果。
证据来自本仓一次性真机脚本（驱动 `dist/` 的完整 server + in-memory MCP client），不是单元测试桩。

## 环境

| 项 | 值 |
|---|---|
| OS | Windows 10 x64（`10.0.19045`） |
| Node | `v24.18.0` |
| ZCode | `3.11.2.6792`（`D:\Z-Code\ZCode\ZCode.exe`） |
| tianshu-mcp | 本仓 `master`，v0.5.2 待发布提交 |
| 驱动方式 | `dist/server.js` + `InMemoryTransport` + 官方 SDK Client，隔离数据目录 |

## 测试 A：无项目派发（省略 `projectPath`）

调用：

```text
run_task(
  agentId=zcode,
  model=DeepSeek/deepseek-flash,
  task=只回答一句话：你当前所在的工作区（项目）名称是什么？不要读取或修改任何文件，不要执行任何命令。
)
```

观察（进度轨迹来自 `query_task`）：

| 观察项 | 结果 |
|---|---|
| `run_task` 提交 | 成功，返回 `taskId`；文案「无项目模式：ZCode default 工作区」 |
| 自动切换工作区 | 出现进度「ZCode 切换到 default 工作区」，任务随后正常发送 |
| 终态 | `succeeded`，`agentEndReason=reply_stable` |
| 任务快照 | `workspaceMode="default"`、`projectPath=""`、`displayPath=""`、`autoVerify=false`、`autoFixRounds=0`、`verificationNotApplicable="no_project"`、`boundProjectPath=""` |
| 任务目录内容 | 仅 `agent-0.log` / `task.json` / `task.jsonl` —— **无 `baseline.json`、无 `visual-snapshot.json`、无 `report-*`** |
| 终态文案 | 「任务完成：agent 退出码 0（无项目模式，未进行项目验收）」 |
| `verify_task(taskId)` | 返回 `not_applicable: no_project`，未从 cwd 推导目录 |
| `get_task_report(taskId)` | 返回「不产生项目验收报告（not_applicable: no_project）」 |
| ZCode 会话 | 真实会话 `sess_9cbc9ba6-…`，`boundProjectPath=""` |

**ZCode 项目条目对比**：派发前 34 条 → 派发后 34 条，**新增 0 / 消失 0**。

## 测试 B：`allowCreateProject=false` + 未登记目录

调用：

```text
run_task(
  projectPath=D:/Trae项目/tianshu-mcp/.rivet/scratch/no-create-project,
  agentId=zcode,
  model=DeepSeek/deepseek-flash,
  task=<同上>,
  allowCreateProject=false
)
```

| 观察项 | 结果 |
|---|---|
| 终态 | `failed`，`agentEndReason=project_not_registered` |
| 失败时机 | 在「准备文件夹面板」之前 —— 未打开原生文件夹对话框 |
| 错误文案 | 「目标目录未在 ZCode 项目列表中登记，且本次调用禁止自动创建项目（allowCreateProject=false）：…。请在 ZCode 中手动添加该项目后重新提交，或省略 allowCreateProject 以允许自动导入。」 |
| ZCode 项目条目 | 仍为 34 条，**不含 `no-create-project`** |

## 本仓当前 ZCode 状态（副作用披露）

真机测试把 ZCode 的工作区从原先绑定的 `D:\Trae项目\tianshu-mcp` 切到了「不在项目中工作」（`default`）。
- **项目条目零变化**（34 → 34），未新增、未删除任何项目；
- 自动恢复绑定时 ZCode 的项目触发器处于未挂载状态（`projectTrigger=false`），无法在不额外操作 UI 的前提下安全回写，故未继续自动化；
- 如需恢复：在 ZCode 输入区点项目下拉，重新勾选目标项目即可。

## 本轮真机发现并修复的两个缺陷

两个缺陷都**只在真机暴露**，单元/集成测试全绿——因为测试分别绕过了 MCP 协议层与真实 Radix 下拉行为。

### 缺陷 1：`projectPath` 未在 MCP schema 层放开

- 现象：真机调 `run_task` 不带 `projectPath` → `MCP error -32602: Invalid arguments for tool run_task: Required at projectPath`。
- 根因：handler 已支持无项目分支，但 `RunTaskParamsSchema.projectPath` 仍是必填；请求在协议层就被 SDK 拒绝。
- 为何单测没抓到：`test/unit/zcode-handler.test.ts` 直接调用 handler，**绕过** MCP 的 `inputSchema` 校验。
- 修复：`src/config/schema.ts` 改为 `AbsPath.optional()`。
- 回归门：`test/integration/task-flow.test.ts` 新增协议层用例，断言错误文本**不含** `-32602` 且不再出现 `Input validation error`。

### 缺陷 2：缺少「切换到 default 工作区」且菜单点击被 toggle 反噬

- 现象一：ZCode「新建任务」会**继承上一次绑定**，使无项目派发永远停在 `needs_user/setup_recovery`。
- 现象二：排查中发现 `attemptProjectMenu` 在项目菜单**已经打开**时仍点击触发器；Radix 下拉是 toggle 语义，这一击把菜单关掉，而 `clickProjectTriggerAndConfirm` 会一路轮询到 deadline 才返回，外层重试只有一次机会 → 直接 `setup_failed`（文案误报为「菜单未打开」）。
- 真机证据：探针 dump 到 `{role:"menuitemcheckbox", testid:"composer-work-outside-project", checked:"true"}`（菜单其实是开着的）。
- 修复：
  1. `src/agents/zcode/selectors.ts` 新增 `workOutsideProject`（`[data-testid="composer-work-outside-project"]`），真机实测点击后触发器文本回读为占位词「选择项目」；
  2. `src/agents/zcode/cdp.ts` 新增 `clickWorkOutsideProject()`（要求唯一可见匹配）；
  3. `src/agents/zcode/run.ts` 新增 `enterDefaultWorkspace()`，无项目模式确认失败时先显式切换再复确认；`confirmDefaultWorkspace` 对「明确绑定着某项目」立即返回，不再白等 deadline；
  4. `clickProjectTriggerAndConfirm()` **先查菜单是否已开**，已开则直接视为 opened，不再点击；
  5. `attemptProjectMenu()` 进入前先 `dismissMenus()`。
- 回归用例：`test/unit/zcode-dom.test.ts`「菜单已开时不再点击触发器（且零鼠标事件）」；`test/integration/zcode-flow.test.ts`「继承旧绑定时自动切换并派发」「切换不可用时保留现场不发送」。

## 未验证项

- **macOS**：本环境无 macOS，ZCode 在 darwin 上的 `default` 工作区切换、`composer-work-outside-project` 选择器与原生行为**未验证**。
- **Windows 11**：本次为 Windows 10 实测；issue 报告者的 Windows 11 证据未被复现，也不互相替代。
- `continue_task` / `rework_task` 在无项目模式下的真机续跑：仅单测覆盖（`FakeZcode`）。
