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

## 第二轮回访（v0.5.2 之后，2026-09-15）

v0.5.2 发布后对无项目派发做了 6 次真机回访，目标是确认「触发器点击被吞」的有界重试改动够用，并复验此后新增的修复。
环境同上（Windows 10 x64、Node `v24.18.0`、ZCode `3.11.2.6792`），驱动方式相同（`dist/server.js` +
`InMemoryTransport` + 官方 SDK Client，隔离数据目录）。

### 6 次运行的结果

| # | 前置 UI 状态 | 终态 | 现场结论 |
|---|---|---|---|
| 1 | 全新 spawn 实例，页面为草稿 | `failed/send_unknown` | 消息未提交（输入框未清空、无运行信号、无新会话）；`用户消息=true` 系假信号 |
| 2 | 复用实例，停在**已有会话** | `needs_user/setup_recovery` | 30 秒内 `dismissMenus`×50 / `clickProjectTriggerAndConfirm`×49 / `workspaceBinding`×49，`clickWorkOutsideProject` **0 次**——触发器从未就绪 |
| 3 | 手工用侧栏按钮切到**草稿** | `succeeded/reply_stable` | 采样到完整提交时序（见下） |
| 4 | 停在会话页 + 窗口被最小化 | `failed/internal` | 修复生效（日志有回退证据，见下）；发送按钮 10 秒内拿不到可点位置 |
| 5 | 草稿页 + 窗口可见 | `succeeded/reply_stable` | 零警告：`已确认 default 工作区` → 模型/权限回读 → 完成 |
| 6 | **窗口最小化**（`iconic=True`、`visibility=hidden`） | `succeeded/reply_stable` | 进度含 `运行证据=stop_button` |

### 缺陷：顶部「新建任务」返回成功却不切页

真机复现判据（只读探针，停在已有会话时）：

- 页面 `rows=2`，`[data-testid="composer-workspace-trigger"]` **挂载数 0**；composer 实际挂载的是
  `v4-composer-input`、`chat-attachment-button`、`chat-mode-select-trigger`、`v4-model-config`、
  `chat-context-usage-trigger`、`chat-model-select-trigger`、`chat-thought-level-select-trigger`、`v4-composer-send`；
- 点击 `conversation-new-task` 返回 `true`，但页面**无任何变化**（rows 仍为 2、触发器仍未挂载）；
- 改用侧栏 `[data-testid="task-new-button"]` 后 2 秒内 `rows=0`、触发器挂载数 1、文本回读为占位词「选择项目」。

修复后的真机证据（第 4 次运行的 agent 日志，逐字）：

```text
[warn] [zcode] 顶部新建任务按钮未建立草稿（clicked=true）；回退侧栏新建任务按钮
[info] [zcode] 已通过侧栏新建任务按钮进入新草稿
[info] [zcode] 已确认 default 工作区（无项目模式），跳过项目绑定与导入
```

同一次运行中，第 2 次失败的那一步（30 秒空等 → `needs_user`）不再出现。

### 发送阶段的三种形态

| 形态 | 现象 | 归因 |
|---|---|---|
| 第 1 次 | `sendMessage` 111ms 返回，随后 60 秒无运行信号 | 未定（见下） |
| 第 4 次 | `sendMessage` 10 秒内拿不到可点位置并抛错 | 窗口最小化导致页面节流，`elementFromPoint` 命中非按钮节点 |
| 第 6 次 | 同样窗口最小化，**发送成功** | 说明「窗口最小化即必然失败」不成立 |

第 3 次运行的提交时序（独立只读探针，3 秒粒度）：

```text
17:14:57  inputLen=93  inputHead="【tianshu:tsk_20260915011"  sendDisabled=false
17:15:03  inputLen=0   sendDisabled=true                    ← 输入框被清空 = 已提交
17:15:09  rows=0→2  sessionNodes=10→11                      ← 新会话建立、助手回复出现
```

以产品同路径（`Input.insertText` + `sendMessage()` 点击 `v4-composer-send`）在既有实例上单独复现，同样提交成功
（输入框清空、`assistantRows` 0→1、会话节点 8→10）。因此「`insertText` 无效」与「`clickAt` 无效」两个假设均被
证伪；`sendButton` 在空输入时为 `disabled=true`、注入文本后转 `false`，编辑器 state 确实收到了文本。

### 本轮未复现 / 未验证

- **第 1 次 `send_unknown` 的真因未定**：同路径探针可提交成功，第 6 次在同样「窗口最小化」条件下也成功，因此
  不能把窗口状态当作该次失败的解释。失败时 `用户消息=true` 是**假信号**——`messageList` 的兜底选择器是 `main`，
  而实测 `mainContainsComposer=true`，`v4-timeline` 容器文本里含「选择项目 / 完全访问 / DeepSeek/deepseek-flash」
  等 composer 控件文本；只要输入框里还留着任务标记，`conversationText()` 就会含标记。该假信号掩盖了「消息滞留
  在输入框」这一真实状态（`seenStateChange=false` 才是真信号），**本轮未修**。
- **`sendMessage` 的节流诊断文案未在真机走到**：仅单元测试覆盖（页面 `visibilityState=hidden` 时归因「窗口不在
  前台」）。第 4 次运行使用的是不含该诊断的构建，第 6 次虽最小化却发送成功。
- **`Page.bringToFront` 无法恢复被遮挡的 Electron 窗口**（真机实测：调用返回 ok，`visibilityState` 仍为
  `hidden`）——因此该状态只能诊断并指引用户，不能自动恢复。窗口可用 `ShowWindow(SW_RESTORE)` +
  `SetForegroundWindow` 恢复（本轮多次使用，恢复后 `visibility=visible`、`hasFocus=true`）。
- **macOS / Windows 11 仍未验证**（与上文「未验证项」一致）。

### 副作用披露（本轮）

- 真机探针直接调用 `sendMessage()` 复现发送路径时，向 ZCode 的 `default` 工作区真实提交了 1 条探针消息
  （「请只回复一个字：好」），因此 ZCode 会话数 +1；6 次回访各自新建了会话。
- 项目条目数未统计（本轮未做派发前后对比），但 6 次运行都是无项目模式，不涉及项目登记或导入。
- 第 4 次运行期间 ZCode 窗口处于最小化状态，回访结束后已用 `ShowWindow(SW_RESTORE)` 恢复为前台可见。
