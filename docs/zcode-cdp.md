# ZCode GUI（CDP）适配器

## 状态

ZCode 已从无头 CLI 占位升级为独立的 `zcode-gui` adapter。它通过 Electron 的本地 CDP 页面驱动 ZCode 主界面；Windows/macOS 原生自动化只处理由 ZCode 新打开的文件夹选择面板。内置 profile 当前仍为 `research`：Windows 10 已完成安装发现、版本读取和既有非 CDP 实例保护验证；macOS 真机完整闭环证据尚未录入，因此不得标为 `ready`。

## 安装发现顺序

1. `profile.command` 或 `profile.gui.exePath`；
2. Windows 固定盘，按 `executableDiscovery.preferredDrives` 排序，再套用 `relativePaths`；
3. Windows 卸载注册表中的安装位置；
4. Program Files、Program Files (x86)、LocalAppData Programs、LocalAppData 等 profile 标准目录；
5. PATH；
6. macOS `/Applications/ZCode.app` 与 `~/Applications/ZCode.app` 的 `Contents/MacOS/ZCode`。

`D:\Z-Code\ZCode\ZCode.exe` 只是当前 Windows 验收样本，由“D 盘优先 + 相对路径模板”发现，不是业务硬编码。运行 `node scripts/probe-zcode.mjs all` 可只读查看安装、版本、进程和 CDP 目标。

## CDP 与实例保护

- 只连接 `127.0.0.1`，同时核验 CDP 页面具有 ZCode 产品标识，并核验 ZCode 根进程命令行中的调试端口。
- 已有有效 CDP 实例时复用。
- ZCode 已运行但没有 CDP 时，任务进入 `needs_user/close_existing_instance`。MCP 不关闭用户进程，也不复制登录数据到隔离目录。
- 没有实例时，以 profile 配置的动态端口启动可见窗口并复用原登录态。
- 登录页、macOS Accessibility 权限、模型提问分别进入 `login_required`、`system_permission`、`agent_question`。
- CDP 断开、空闲超时、任务总超时都保留 ZCode 现场；不会点击停止或伪造“已终止”。

## 调用

```text
run_task(
  projectPath=D:/repo/app,
  agentId=zcode,
  model=DeepSeek/deepseek-flash,
  task=根据 `.codex/plans/feature.md` 与 `./design-system` 完成开发,
  autoVerify=true
)
```

- `model` 必填且必须是精确的 `供应商/模型`。供应商、模型不存在、同名歧义或切换回读不一致时，发送前失败。
- ZCode 不支持 TraeWork 的 `mode`；传入即参数错误。
- `task/context` 中反引号路径、绝对路径以及 `./`、`../` 路径会在发送前解析。路径必须存在并位于 `projectPath` 内。
- 每次初始调用新建会话；自动返修、`rework_task` 和 `continue_task` 只允许恢复已记录的原会话。
- 发送前必须精确绑定项目、回读绝对路径、选择模型并回读“完全访问”。任一状态不明确都 fail-closed。
- ZCode 默认 `autoVerify=true`，未显式指定时 `autoFixRounds=2`。

## `needs_user` 与继续

`needs_user` 会释放项目运行槽和 ZCode 全局串行锁，但保存任务 ID、Git 基线、会话 ID、项目路径、模型和权限状态。服务重启不会把它归档为 `interrupted`。

```text
continue_task(taskId=tsk_..., message=选择 PostgreSQL)
```

若暂停原因是 `agent_question`，`message` 只发到精确定位的原会话；若原因是关闭旧实例、登录或系统权限，`message` 只代表“用户已处理”，恢复后重新检查环境，不把确认文本发给模型。重复恢复、状态错误或会话丢失均会拒绝。

## 项目与文件夹面板

项目优先按规范化绝对路径匹配。Windows 比较大小写不敏感并统一斜杠；macOS 保留平台路径语义。只有 basename 同名但无可核验路径时会停止，不会猜选。

找不到项目时，adapter 记录已有原生对话框，再点击 ZCode 的“选择文件夹”。Windows 只处理新出现且进程属于 ZCode 的 `#32770` 窗口，通过 UI Automation 设置并回读路径；macOS 只操作 ZCode 的 sheet/window，通过 `osascript` argv 传入路径。提交后仍需从 ZCode 回读完整项目路径。

## 运行、验收与返修

轮询同时读取停止按钮、加载卡、活动工具、助手回复哈希、问题卡、输入框和发送按钮。停止、加载或活动工具任一存在即保持 `running`；文本短暂停顿不会提前完成。默认每 30 秒写一条结构化进度摘要。

正常完成后进入统一验收引擎。验收失败时，唯一返修计划写在 `<TIANSHU_MCP_HOME>/tasks/<taskId>/rework-<taskId>-r<round>.md`，提示词包含该绝对路径和完整报告绝对路径；不向项目写临时 `.tianshu-mcp` 副本。ZCode 无法读取计划时失败，不降级成一句摘要。轮次用尽进入 `needs_attention`。

## 排障

- `close_existing_instance`：保存 ZCode 工作并手动退出，再调 `continue_task`。
- `model_unavailable/model_mismatch`：用 `node scripts/probe-zcode.mjs selectors` 和 profile 选择器覆盖检查 UI 版本漂移。
- `project_ambiguous/project_mismatch`：确保侧栏能暴露完整路径，移除无法消歧的同名项。
- `system_permission`：在 macOS 系统设置中手动授予 ZCode/System Events Accessibility 权限。
- `cdp_disconnected`：保留当前现场，确认实例仍在及端口归属后人工裁决。

## 真机证据状态（2026-09-11）

| 平台 | 已验证 | 未完成 |
|---|---|---|
| Windows 10 x64 | 自动发现 `D:\Z-Code\ZCode\ZCode.exe`、版本 `3.11.2.6792`、检测到既有无 CDP 实例且不终止 | 用户关闭旧实例后的项目绑定、模型、真实开发、提问继续、返修闭环 |
| macOS | 跨平台实现与 CI 单元/假 CDP 路径 | 真实设备安装、Accessibility、完整端到端证据 |

在两端完整证据补齐之前，内置 profile 必须保持 `research`。
