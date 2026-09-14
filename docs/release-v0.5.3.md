# tianshu-mcp v0.5.3 发布说明

**核心主题**：**ZCode 真机回访修复（issue #12 第二轮）**。v0.5.2 发布后在 Windows 10 真机上对无项目派发做了 6 次回访，暴露并修复了三个缺陷：GUI 桌面实例无法跨 server 退出驻留、顶部「新建任务」点击返回成功却不切页导致后续一路静默空等、窗口被节流时发送失败归因误导。

本版本为 **PATCH**：仅缺陷修复，无新增参数或行为变更。既有调用方的工具签名、meta 块字段、报告格式与验收配置**保持向后兼容**，升级无需改动调用方。

## 修复

### GUI 实例跨 server 退出驻留（Windows，真机发现）

`zcode`、`codex` 的 GUI 实例此前按平台分支 spawn（`detached: process.platform !== "win32"`），而 `traework` 用的是无条件 `detached: true`。最小实验（Windows 10 / Node 24.18.0）显示同一段 spawn：non-detached 子进程在父进程退出后存活 0，detached 存活 1。因此 Windows 上 MCP server（或一次性 smoke / probe 脚本）一退出，ZCode 就被连坐杀掉，`keptInstance` 的「实例跨 server 退出驻留」形同虚设——`needs_user` 提示「请在 ZCode 中处理后再调用 continue_task」，而窗口其实已经消失。

现把该不变量收敛为单一来源 `guiInstanceSpawnOptions()`，三处 GUI 实例共用（`codex` 原先连 `unref()` 都带平台分支，一并去掉）；`verify/runner`、`visual/services`、`agents/spawn` 这些**需要整组终止**的执行型子进程语义相反，继续按平台分支，不受影响。

### 新建任务不切页导致静默空等（真机发现）

ZCode 停在已有会话时，顶部 `conversation-new-task` 是惰性挂载的图标——点击派发成功（返回 `true`）却不切换页面，而会话页的 composer **不挂载** `composer-workspace-trigger`。于是无项目模式的 default 确认、有项目模式的绑定等待都会空等到截止时间，最后只报一句 `needs_user/setup_recovery`（实测空转 30 秒）。

现在新建任务后以「项目触发器已挂载」验证草稿**真的**建立；未建立则回退侧栏 `task-new-button`（Windows 3.11.2 实测可靠，此前该兜底只覆盖有项目模式），两者都失败才以 `setup_failed` fail-closed 并报出「触发器仍未挂载」。修复后的真机日志：

```text
[warn] [zcode] 顶部新建任务按钮未建立草稿（clicked=true）；回退侧栏新建任务按钮
[info] [zcode] 已通过侧栏新建任务按钮进入新草稿
[info] [zcode] 已确认 default 工作区（无项目模式），跳过项目绑定与导入
```

### 发送失败归因误导（真机发现）

窗口被最小化或完全遮挡时页面被 Chromium 节流（`visibilityState=hidden`），发送按钮「明明在视口内」却点不到，`elementFromPoint` 命中的也不是按钮本身。旧文案只报「ZCode 发送按钮未在观察期内启用或被遮挡」，会把用户引向按钮；现在会识别该状态并报出「ZCode 窗口当前不在前台」及把窗口置于前台的操作指引。`Page.bringToFront` 经真机实测**无法**恢复被遮挡的 Electron 窗口，因此不假装能自动恢复。

## 真机验证（Windows 10 x64）

v0.5.2 之后 6 次真机回访（环境：Windows 10 x64 `10.0.19045`、Node `v24.18.0`、ZCode `3.11.2.6792`）：

| # | 前置 UI 状态 | 终态 | 结论 |
|---|---|---|---|
| 1 | 全新实例，页面为草稿 | `failed/send_unknown` | 消息未提交，真因仍未定 |
| 2 | 复用实例，停在已有会话 | `needs_user/setup_recovery` | 复现「新建任务不切页」：触发器从未就绪，空转 30 秒 |
| 3 | 手工切到草稿 | `succeeded/reply_stable` | 采样到完整提交时序 |
| 4 | 停在会话页 + 窗口最小化 | `failed/internal` | 修复生效：日志含回退侧栏证据 |
| 5 | 草稿页 + 窗口可见 | `succeeded/reply_stable` | 零警告完成 |
| 6 | 窗口最小化 | `succeeded/reply_stable` | 「窗口最小化即必然失败」不成立 |

完整证据链见 [issue #12 Windows 10 真机验收记录](zcode-issue-12-windows-evidence.md) 的「第二轮回访（v0.5.2 之后）」，含未复现 / 未验证事实的诚实披露（第 1 次 `send_unknown` 真因仍未定、发送诊断文案在真机上未走到）。

## 测试与验证

- 全量测试 **532 passed / 10 skipped**（Windows 10 x64，Node 24.18.0），较 v0.5.2 净增 **7** 个用例：草稿未建立时回退侧栏入口并完成派发、两个入口都建立不了草稿时 fail-closed 且不发送、页面被节流时发送失败归因为窗口不在前台、页面可见时保留原有的按钮归因文案，以及 GUI 实例 spawn 不变量（跨平台无条件 detached + unref）的 2 项回归。
- `typecheck` / `lint`（`--max-warnings 0`）/ `build` / `pack:check` 全部通过；`check:stdio` 全场景 PASS。
