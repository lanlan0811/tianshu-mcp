# tianshu-mcp v0.3.2 发布说明

v0.3.2 修复 issue #5 / #6：**MCP 任务模型与 Codex GUI 内 turn 的状态脱节**。前者是"等用户确认时恒报 running"的完成判定死锁，后者是 `cancel_task` 只停 MCP 侧等待、不停 GUI 内运行且描述失实。两个问题同根，一并收敛；另含一次真机模拟测试发现的模型切换修复。

## 等待用户检测（issue #5）

Codex 停在"等待用户确认"界面（方案确认卡/订阅结账页等）时，turn 是暂停而非结束，但停止按钮仍可见——旧版完成判定把"停止按钮可见"当作绝对运行信号，任务从此死锁在 `running`，只能干等 30 分钟总超时。

- **stall 兜底**：停止按钮持续可见且对话哈希 `gui.stallTimeoutMs`（默认 5 分钟）不变 → 任务转 `needs_user`（新等待类型 `user_confirmation`），编排方收到可操作的 `pendingQuestion`；对话内容恢复变化会重置计时。
- **可配置界面检测**：`gui.selectors.userGate`（如结账页 `embedded-checkout`、确认卡选择器）命中即快速转 `needs_user`；默认未配置 = 禁用，不内置未真机验证的选择器。
- **选择器收紧**：`stopButton` 移除 `aria-label*="取消"` 过匹配（等待用户界面上的"取消"按钮曾被误判为运行信号）。

## 恢复通道（issue #5 牵连）

`continue_task` 扩展支持 codex（此前显式只允许 zcode，codex 产出 `needs_user` 后无处可去）：

- `user_confirmation`：用户在 Codex 窗口处理完后恢复，MCP 仅重新接入观察 GUI 内运行（不发送消息）；恢复前 turn 已完成也能正确判 `succeeded`。
- `login_required`：复检环境后重新派发任务书（新会话 + 项目绑定 + 完整初始指令）。
- zcode 原有恢复行为不变；其他 agent 明确拒绝。

## 取消真停 GUI（issue #6）

- `cancel_task` 对 GUI agent 不再"请求即成功"：先经 CDP 尽力点击界面停止按钮，并在 `gui.cancelWaitMs`（默认 15 秒）内有界等待 GUI 真正空闲后落 `cancelled`；未确认停止时终态文案明示"GUI 内运行未确认停止，Codex 窗口中的任务可能仍在继续"。
- CLI agent 的进程树终止语义不变；`needs_user` 状态取消的文案提示"GUI 内可能仍有等待中的会话"（此时 MCP 侧无 CDP 连接，列为已知边界）。
- **重派防交叠护栏**：派发前发现受管实例上仍有未停止的运行时先尽力停止；仍不空闲则以 `instance_busy` 硬失败拒绝派发，杜绝新旧 turn 在同一应用内交叠。

## 真机模拟测试发现的修复

在 Windows + Codex 26.903.9818.0 上以 `run_task`（agent=codex）做端到端模拟时发现：模型菜单的 `menuitemradio` 对 trusted 鼠标点击只收起菜单、不切换选中态，导致"选模型与思考等级"步骤失败（滑块读不到为级联现象）。`clickModelItem` 改为页面内 DOM `.click()` 并经真机验证——与"项目选择触发器需要 trusted 才能展开"的相反行为已注明。

## 其他

- `GuiProfile` 新增 `stallTimeoutMs`（默认 300000）与 `cancelWaitMs`（默认 15000），均可由 agent-profiles.json 覆盖。
- 工具描述对齐实际语义（`cancel_task` 区分 CLI/GUI；`continue_task` 去掉"只用于 ZCode"限定）；SKILL.md §4/§5 与 usage-examples.md §7 补齐恢复与取消示例。
- 启动日志工具数改按注册表实际数量输出。

## 升级与兼容性

- 无破坏性变更：状态机未新增过渡态；`needsUserKind` 新增 `user_confirmation` 取值。
- 使用方式见技能文档：`needs_user` 处理（§4）、取消语义（§5）、恢复与取消示例（usage-examples.md §7）。

## 验证

- 全量 355 个单元/集成测试通过；GitHub CI 矩阵（ubuntu/macos/windows × Node 20/22/24）与严格 stdio 门禁全绿。
- Windows 11 + Codex 26.903.9818.0 真机端到端模拟：派发 Codex 开发"纯 HTML 切水果小游戏"全流程（含 CDP 瞬时断连后经 `rework_task` 恢复至 `succeeded`）。
