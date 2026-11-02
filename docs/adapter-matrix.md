# Agent 能力调研矩阵（adapter-matrix.md）

外部 AI-Agent 接入调研结论。维护原则：优先官方 CLI；Electron 桌面产品仅在能通过本机 CDP 严格核验产品、进程、项目与会话时使用隔离 GUI adapter，不调用未公开内部协议。

更新记录：本文件与 `docs/agent-profiles.md` 配套。状态随 M2/M3 调研推进刷新。

## 汇总矩阵

| Agent | 接口类型 | 状态 | 可执行发现 | 登录态 | 任务/文件回读 | 备注 |
|---|---|---|---|---|---|---|
| **Codex**（OpenAI 桌面端） | **MSIX GUI + CDP**（`codex-gui` adapter） | ✅ **Windows 真机已验证**（COM 激活 + CDP + 关键选择器 + 验收返修闭环，2026-09-11；见 [codex-windows-smoke.md](codex-windows-smoke.md)；macOS 标 research） | Appx 查询优先（`Get-AppxPackage` → InstallLocation）→ 扫盘 `WindowsApps\OpenAI.Codex_*` 取最新版本 | 复用 `~/.codex`（auth.json），与用户手动打开的实例共享 | DOM 回读项目、模型/思考等级、权限、回复 | GUI 宿主 `app\ChatGPT.exe` 无法直启（策略拒绝），须 `IApplicationActivationManager` 激活并注入专属 `--user-data-dir`；见 [codex-gui-cdp.md](codex-gui-cdp.md) |
| **Zcode**（ZCode 桌面） | Electron + 独立 `zcode-gui` CDP adapter | **research（Windows 3.11.2 选择器已适配，macOS 待补齐）** | 数据驱动固定盘/注册表/标准目录/macOS bundle | 复用本机登录态 | 模型直选 + provider/family 兜底；composer 项目复选项与绑定回读 | Windows 证据见 [zcode-windows-smoke.md](zcode-windows-smoke.md)；无头 CLI 仍不存在 |
| **Kimi Code**（Moonshot AI 桌面端） | 普通 Electron 安装（实测 1.0.2）+ 独立 `kimicode-gui` CDP adapter | **Windows 真机已验证**（成功路径、未登记工作区导入 + 自动验收、失败→返修→再验收同会话闭环）；macOS 标 `research` 且 fail-closed | 标准目录 `{PROGRAMFILES}/Kimi Code` 等 + D 盘优先 + 相对路径模板（`Kimi-Code/Kimi Code/Kimi Code.exe` 等）；macOS 探测 `Kimi Code.app` bundle | 复用本机 Kimi Code 登录态；检测到**未开启 CDP 的既有实例**转 `needs_user(close_existing_instance)`，绝不盲杀 | DOM 回读工作区（**完整路径**）、模型与思考档位（pill）、执行模式、会话 id 与回复 | 以 `--remote-debugging-port` 注入即可，**无需 MSIX COM 激活**。**双渲染进程**：模型/思考档位/执行模式菜单渲染在 `Kimi Browser Overlay` 浮层窗口，工作区菜单与「切换模型」对话框在主窗口。以**工作区**（任务文件夹）组织任务，**不支持无项目派发**；未登记工作区经原生「添加工作区」对话框导入。模型三级选择（pill 回读 → overlay 快捷菜单 → 「更多模型…」对话框）；思考档位按**界面实际档位集合**校验（官方 `Low/High/Max`，非官方 `On/Off`）；执行模式强制「完全自动」。运行检测：`button.stop`（`aria-label="中断"`）/ `send.is-starting`。取消照 Codex M14 语义（尽力点停 + `cancelWaitMs` 有界等待，未确认时如实标注）；`needs_user` 六类均由 `continue_task` 恢复。详见 [kimi-cdp.md](kimi-cdp.md) |
| **Open Design**（Open Design 桌面端） | 普通 Electron 安装（实测 0.24.1，内嵌 Node 的外层启动器）+ 独立 `opendesign-gui` CDP adapter | ✅ **已接线**（`selectors.ts` 的 `primary` 全部落地，证据取自产品 Web 前端产物里的 `data-testid` 钩子；12 步执行链 + 验收-返修闭环已接线，Windows 真机取证）；macOS 标 `research` 且 fail-closed | 显式 `gui.exePath` → D 盘优先 + 相对路径模板（`Open Design/Open Design.exe`）→ 注册表卸载信息 → 标准目录 `{PROGRAMFILES}/Open Design` 等；版本与命名空间从 `<安装目录>/resources/open-design-config.json` 读取 | 复用本机登录态与数据目录（`%APPDATA%\Open Design\namespaces\<namespace>`；**产品会覆盖 `--user-data-dir`**）；已有实例无调试端口时转 `needs_user(close_existing_instance)`，绝不 kill 用户进程 | 工作目录（回读校验）、模型（精确匹配 + 回读）、设计系统（搜索过滤 + 精确点选 + 回读）、设计方向、任务书（可信输入 + 回读）、对话文本哈希与产物指纹（三信号） | **`ELECTRON_RUN_AS_NODE` 会让启动器退化成 Node 而拒绝 `--remote-debugging-port`**（受管启动已自动净化环境）；启动器是「分离子进程形态」（宣告端口后自行 `exit=0`）；端口基准 9889。设计方向只支持原型/文档/网站复刻。运行检测为**三信号**（停止按钮 + 对话文本哈希 + 产物指纹）。详见 [opendesign-cdp.md](opendesign-cdp.md) |
| **stub**（测试用） | 本地脚本 | ✅ 内置测试 | 测试注入 profile | 无 | — | 仅 M1 集成测试使用 |

状态图例：✅ 可接入（已实现/已冒烟）｜🔍 调研中｜⬜ 规划/占位｜❌ 已证伪不支持

## E1 — 细粒度事件上报现状（issue #18）

适配器可在关键节点上报语义事件，由 `query_task` 回传最近 N 条（详见 [事件流](event-stream.md)）。
上报是**可选能力**：未实现的适配器行为完全不变。

| Agent | 是否上报 | 发射的事件 |
|---|---|---|
| **Codex** | ✅ 已实现 | `task_dispatched` / `confirmation_dialog_detected`（残留弹窗清理、原生「选择文件夹」）/ `awaiting_user_authorization`（`loginIndicator`、`needs_login`、`needs_user`）/ `file_modification_started`（运行信号首次出现） |
| **ZCode** | ⬜ 保留接口、暂不上报 | — |
| **Kimi Code** | ⬜ 保留接口、暂不上报 | — |
| **Open Design** | ✅ 已实现 | `task_dispatched` / `confirmation_dialog_detected` / `awaiting_user_authorization` / `file_modification_started`（`run.ts` 已接入 `onEvent`） |
| **CLI 类 agent**（含 stub） | ⬜ 不适用（无 GUI 交互节点） | — |
| 引擎侧（与适配器无关） | ✅ | `rework_triggered`（自动返修 `mode:"auto"`、手动 `rework_task` `mode:"manual"`） |

> `file_modification_started` 是**启发式**推断：适配器并不直接观测文件系统，只能从界面运行信号
> （停止按钮）推断执行已开始，其 detail 一律写「可能开始改动文件」，**不声称已改动**。

## 扩展新 agent（三步）

1. 数据目录 `agent-profiles.json` 新增 profile（见 agent-profiles.md）；默认能力够用则**零代码**。
2. 需要特殊输出解析（如非 0 退出码但成功、要解析 JSON 结果）→ 继承/实现 `AgentAdapter` 并 `registry.register(id, adapter)`。
3. `get_profiles` 自检可执行探测，跑一次 stub/codex 冒烟任务验收。

## C1 — codex exec 实测（2026-09-07，`codex.exe exec --help`）

> **已被 C2 取代**：自 2026-09-11 起 Codex 适配器改为桌面端 GUI 驱动（`codex-gui`）。
> 本节保留为历史记录；如需无头执行可另立 profile 复用下列结论。

可执行（本机探测到）：`C:\Users\Lenovo\AppData\Local\OpenAI\Codex\bin\<hash>\codex.exe`。

`codex exec` 关键事实：

- Prompt 即参数 `[PROMPT]`；用 `-` 或管道时从 stdin 读（**promptMode 可 arg 或 stdin**，若 stdin 有管道且给了参数则拼 `<stdin>` 块）。
- `-C, --cd <DIR>` 指定工作根（配合 `cwd: task` 双保险）。
- `--sandbox read-only|workspace-write|danger-full-access`；**实测 0.153.4 中 `--sandbox` 与 `--approve-for-me` 互斥**，不能同用；非交互自动化用 `--sandbox workspace-write` 即可（approval 输出显示 never）。
- `--json` 事件输出 JSONL；`-o, --output-last-message <FILE>` 取末条消息；`--ephemeral` 不落会话文件。
- `--skip-git-repo-check`：允许非 git 仓库（我们的任务都在 git 项目内，可留可去）。
- 详细实测记录见 [m2-smoke-record.md](m2-smoke-record.md)。

**结论（adapter 配置基线，M2 已真实冒烟定稿）**：

```jsonc
"codex": {
  "command": "<bin 绝对路径，或用 executableDiscovery 自动取最新 <hash>>",
  "argsTemplate": ["exec", "<prompt:arg>", "--skip-git-repo-check", "--sandbox", "workspace-write"],
  "promptMode": "arg",
  "cwd": "task",
  "env": {},
  "killTree": "taskkill",
  "executableDiscovery": { "dirs": ["C:/Users/Lenovo/AppData/Local/OpenAI/Codex/bin"], "fileNames": ["codex.exe"] }
}
```

## Z1 — Zcode headless 入口（2026-09-07 实测，结论仅限无头路线）

**结论：`unsupported`——ZCode 是 Electron 桌面应用（`D:\Z-Code\ZCode\ZCode.exe`），未随包提供 headless agent-exec CLI 供外部无头驱动。**

实测证据：

- 安装目录 `D:\Z-Code\ZCode\`：标准 Electron 布局（`ZCode.exe` + resources/app.asar），无 `cli.js`/headless launcher/`cli.exe`。
- `resources/tools/` 打包工具仅 `cua-helper`（computer-use）、`ripgrep`、`ugrep`——均为应用内部辅助，无 agent 驱动命令。
- `~/.zcode/cli/` 是运行时数据目录（agents/exec/rollout/`sess_*` 会话 + 一个含 `mcp.servers` 的 `config.json`，schema 与本项目一致），**不是可执行入口**。
- `%PATH%`/npm 全局无 `zcode` 命令；无 headless 子命令文档/入口。

因此 tianshu-mcp **无法把 Zcode 作为外部 agent 无头 spawn**（R14：不 pty 硬接、不 GUI 自动化默认实施）。内置 profile 已把 zcode 置为 `status: "research"`→应改为 unsupported 说明留待：若 ZCode 未来提供 headless CLI/官方接口，可重跑本调研。

> 2026-09-11 更正：无头 CLI 结论保持不变，但 Electron CDP GUI 路线已实现为独立 `zcode-gui` adapter，支持 `needs_user/continue_task` 和自动验收返修。内置 profile 在 Windows/macOS 真机闭环全部完成前保持 `research`。详见 [zcode-cdp.md](zcode-cdp.md)。

## 只读调研来源（D:\Tianshu 逆向，仅作事实依据）

- MCP 机制与工具回传约束：见开发计划 §1（只回文本、异步轮询、长任务需异步化）。
- 本机探测（2026-09-07）：Node v24 / 无 agent CLI 在 PATH；Codex 桌面端自带 `codex.exe` CLI；`codex-code-mode-host.exe` / computer-use 运行时 / chrome-native-host 存在。
