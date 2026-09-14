# tianshu-mcp v0.5.2 发布说明

**核心主题**：**ZCode 无项目派发（issue #12）**。`run_task` 的 `projectPath` 变为可选 —— 省略时 ZCode 在其 `default`（无项目）工作区承接任务：不登记/导入项目、不采集 Git 基线、不冻结项目快照、不进入项目锁、不执行项目验收。配套 `allowCreateProject` 可在目标目录未登记时禁止自动导入。同时统一了 ZCode 项目触发器的就绪判据、修正了错误信息失实，并补齐 Windows 10 真机验收证据。

本版本为 **MINOR**：新增可选参数 `allowCreateProject` 并放开 `projectPath` 的必填约束。既有调用方的工具签名、meta 块字段、报告格式与验收配置**保持向后兼容**，升级无需改动调用方。

## 新增

### ZCode 无项目派发（issue #12）

```text
run_task(
  agentId=zcode,
  model=DeepSeek/deepseek-flash,
  task=用一句话说明当前工作区，不要读写任何文件
)
```

- **只支持 ZCode**。省略 `projectPath` 而解析出的目标是其他 agent 时，在排队前返回参数错误；空串 / `null` / 相对路径 / 不存在的目录**不视为**无项目模式，仍按有项目模式拒绝。
- 验收与返修强制关闭：`autoVerify` 固定 `false`、`autoFixRounds` 固定 `0`；显式开启会在提交前报错。
- 任务书含明确本地文件引用（反引号路径 / 绝对路径 / `./` / `../`）时，发送前报错要求提供 `projectPath` —— 无项目模式不会退回 cwd 解析。
- 执行成功后终态文案明示「未进行项目验收」，任务元数据以 `verificationNotApplicable: "no_project"` 结构化标注；`verify_task` / `get_task_report` 对该类任务返回 `not_applicable: no_project`，不从 cwd 推导目录。
- 发送前必须确认会话确实处于未绑定项目的 `default` 工作区；发现继承了旧绑定时，**自动点开项目菜单选择「不在项目中工作」**再回读确认（真机实测：切换后触发器文本变为「选择项目」）。

### `allowCreateProject`（ZCode 专用，可选布尔）

- 省略 = 保持既有「目标未登记即自动导入」行为。
- `false` = 目标目录未登记时**在任何导入副作用之前**停止派发，返回可识别的 `project_not_registered` 与处理说明：不打开原生文件夹对话框、不添加项目。请在 ZCode 中手动登记后重新提交。
- 其他 agent 显式传入该参数会得到明确的「不支持」错误，而不是被静默忽略。

### Windows 10 真机验收记录

[`docs/zcode-issue-12-windows-evidence.md`](zcode-issue-12-windows-evidence.md)（英文版同目录 `.en.md`）：ZCode `3.11.2.6792` 上无项目派发与 `allowCreateProject=false` 的完整证据链，含「派发前后 ZCode 项目条目 **34 → 34**、新增 0 / 消失 0」的对比，以及本轮在真机上暴露并修复的两个缺陷。

## 修复

- **`projectPath` 未在 MCP schema 层放开（真机发现）**：handler 已支持无项目分支，但 `RunTaskParamsSchema.projectPath` 仍是必填，真实 `run_task` 会被 SDK 拒成 `-32602 Required at projectPath`；单元测试直接调用 handler、绕过了 `inputSchema`，所以全绿也没抓到。已改为 `AbsPath.optional()`，并在 `test/integration/task-flow.test.ts` 补协议层回归用例。
- **缺少「不在项目中工作」切换，且项目菜单已开时点击被 toggle 反噬（真机发现）**：ZCode「新建任务」会继承上一次绑定，使无项目派发永久停在 `needs_user/setup_recovery`；同时 `clickProjectTriggerAndConfirm` 在项目菜单**已经打开**时仍点击触发器，把 Radix 下拉关掉后一路轮询到 deadline，误报「项目菜单未打开」。现新增 `workOutsideProject` 选择器与 `enterDefaultWorkspace()` 显式切换，点击前先查菜单状态，`confirmDefaultWorkspace` 对「明确绑定着项目」立即返回而非空等。
- **项目触发器就绪判据不一致（issue #12 §五）**：等待用 `exists`（只看元素宽高），点击走 `pick`（要求该层恰好一个未被裁剪的可见节点），存在 `exists=true` 但 `click=false` 的窗口。等待与点击现共用同一份**结构化探测**，区分未挂载 / 已挂载但不可见或被裁剪 / 不唯一 / 禁用 / 被遮挡 / 就绪，并新增点击后置检查（项目菜单必须真正打开）。
- **错误信息与行为失实**：「等待项目触发器超时」不再用于描述早退（多匹配、禁用）或菜单未打开；失败文案携带 `selector`、匹配数与命中节点最小属性，诊断日志记录尝试次数、实际耗时与剩余预算。
- **集中超时**：新增 `gui.projectTriggerTimeoutMs`（默认 15s）替换原先写死的两处 `15_000`；「等待 → 回退一次侧栏新建任务 → 再等待」共享同一截止时间，重试不重置预算。

## 真机验证（Windows 10 x64）

| 场景 | 结果 |
|---|---|
| 无项目派发 | `succeeded` / `reply_stable`；快照 `workspaceMode=default`、`projectPath=""`、`verificationNotApplicable=no_project`；任务目录仅 `agent-0.log` / `task.json` / `task.jsonl`（**无 baseline / 快照 / report**） |
| `verify_task` / `get_task_report` | 均返回 `not_applicable: no_project` |
| ZCode 项目条目 | 34 → 34，新增 0 / 消失 0 |
| `allowCreateProject=false` + 未登记目录 | `failed` / `project_not_registered`，未打开文件夹面板、未新增项目条目 |

环境：Windows 10 x64（`10.0.19045`）、Node `v24.18.0`、ZCode `3.11.2.6792`、`model=DeepSeek/deepseek-flash`。

> **副作用披露**：真机测试把本仓 ZCode 的工作区从原先绑定的 `D:\Trae项目\tianshu-mcp` 切到了「不在项目中工作」，**项目条目零变化**。自动回写绑定时触发器处于未挂载状态，未继续自动化；需要时在 ZCode 输入区点项目下拉重新选择即可。

## 测试与验证

- 全量测试 **525 passed / 10 skipped**（54 文件通过 / 3 skipped，Windows 10 x64 / Node 24），较 v0.5.1 净增 **39** 个用例。
- `typecheck` / `lint`（`--max-warnings 0`）/ `build` / `pack:check`（192 文件）全部通过；`check:stdio` **6/6 场景 PASS**（11 工具，`version=0.5.2`）。
- 干净消费者安装：空目录 `npm install <tgz>` 成功，`dist/index.js` 启动后 11 工具握手成功并可 EOF 优雅关闭。

## 分发与兼容性

- GitHub 为主仓库，Gitee 为代码、标签与发行版镜像；npm 同步发布 `tianshu-mcp@0.5.2`（`latest`）。
- **无破坏性变更**：既有调用方无需改动；`run_task` 省略 `projectPath` 的调用从「参数校验失败」变为「真正的无项目派发」，这是本版本有意引入的行为变更。
- **未验证项**：macOS 上的无项目派发与选择器（本环境无 macOS）；无项目模式下的 `continue_task` / `rework_task` 真机续跑（仅单测覆盖）。

相关文档：[ZCode CDP 适配器](zcode-cdp.md)｜[Windows 10 真机验收记录](zcode-issue-12-windows-evidence.md)｜[项目 README](../README.md)｜[CHANGELOG](../CHANGELOG.md)
