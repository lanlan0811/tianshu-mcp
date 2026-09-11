# Agent 能力调研矩阵（adapter-matrix.md）

外部 AI-Agent 接入调研结论。维护原则：优先官方 CLI；Electron 桌面产品仅在能通过本机 CDP 严格核验产品、进程、项目与会话时使用隔离 GUI adapter，不调用未公开内部协议。

更新记录：本文件与 `docs/agent-profiles.md` 配套。状态随 M2/M3 调研推进刷新。

## 汇总矩阵

| Agent | 接口类型 | 状态 | 可执行发现 | 登录态 | 任务/文件回读 | 备注 |
|---|---|---|---|---|---|---|
| **Codex**（OpenAI 桌面端） | 本地 CLI `codex.exe` | ✅ **已冒烟通过**（2026-09-07 run_task→verify_task，见 [m2-smoke-record.md](m2-smoke-record.md)） | `executableDiscovery` → `.../Codex/bin/<hash>/codex.exe`（实测 v0.153.4） | 复用 `~/.codex`（auth.json），与桌面端同账号 | cwd 内读写文件；stdout 流式 | `codex exec "<prompt>" --sandbox workspace-write`（勿与 --approve-for-me 同用） |
| **Zcode**（ZCode 桌面） | Electron + 独立 `zcode-gui` CDP adapter | **research（Windows 真机已通过，macOS 待补齐）** | 数据驱动固定盘/注册表/标准目录/macOS bundle | 复用本机登录态 | DOM 回读项目、模型、权限、会话与回复 | Windows 证据见 [zcode-windows-smoke.md](zcode-windows-smoke.md)；无头 CLI 仍不存在 |
| **TraeWork / TRAE SOLO CN** | 桌面 IDE（v1.107.1）+ **CDP GUI 驱动** | ✅ **已接入并真机验证**（2026-09-08；见 T1 更正与 [traework-cdp.md](traework-cdp.md)） | 无头 CLI 不存在；以 `--remote-debugging-port` 驱动聊天 UI | 复用 TraeWork 桌面端登录态（本 MCP 不读取凭证） | 从 DOM 提取回复；项目文件由 TraeWork 自身写入 | `byted-solo.builtin-mcp` 是 MCP 客户端扩展，非被驱动接口 |
| **stub**（测试用） | 本地脚本 | ✅ 内置测试 | 测试注入 profile | 无 | — | 仅 M1 集成测试使用 |

状态图例：✅ 可接入（已实现/已冒烟）｜🔍 调研中｜⬜ 规划/占位｜❌ 已证伪不支持

## 扩展新 agent（三步）

1. 数据目录 `agent-profiles.json` 新增 profile（见 agent-profiles.md）；默认能力够用则**零代码**。
2. 需要特殊输出解析（如非 0 退出码但成功、要解析 JSON 结果）→ 继承/实现 `AgentAdapter` 并 `registry.register(id, adapter)`。
3. `get_profiles` 自检可执行探测，跑一次 stub/codex 冒烟任务验收。

## C1 — codex exec 实测（2026-09-07，`codex.exe exec --help`）

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

## T1 — TraeWork / TRAE SOLO CN 驱动接口（2026-09-07 初判 unsupported → 2026-09-08 更正为已接入）

**最终结论：`ready`（driver=gui）——无头 CLI 确实不存在，但 CDP 驱动桌面 UI 可行，已实现并真机验证。**

### T1.1 初判（2026-09-07）：无头 CLI 不存在（该部分结论成立）

实测证据（安装目录 `D:\TRAE Work CN`，即 TRAE SOLO CN）：

- 应用：`D:\TRAE Work CN\TRAE SOLO CN.exe`（Electron，product.json `name: TRAE SOLO CN`，version `1.107.1`）。
- 提供的 CLI 仅 VS Code 家族命令（`bin/trae-solo-cn.cmd` 以 ELECTRON_RUN_AS_NODE 调 `resources/app/out/cli.js`）：
  - `open` / `open-url` / `serve-web` / `install-extension` / `uninstall-extension` / `list-extensions` / `locate-extension` / `version` / `tunnel` / `command` / `open-devtools`
  - **没有任何 `agent exec` / headless agent 驱动子命令**。
- 全安装目录（排除 node_modules）`find -iname "*codex*" -o -iname "*agent*.exe" -o -iname "*solo*cli*"` 无结果；无独立 agent CLI 二进制。
- 扩展含 `byted-solo.builtin-mcp`（MCP **客户端**扩展，供 IDE 内接 MCP server）与 `cloudide.icube-agent-shell-exec`；这些是 IDE 侧能力，不是可供本 MCP server 外部调用的无头接口。
- `%PATH%` 无 trae；无 `--headless`/远程 agent API。

**该结论只覆盖「无头 CLI」这一条路线**，当时据此把 profile 标为 `status: "unsupported"`。

### T1.2 更正（2026-09-08）：CDP GUI 驱动可行并已接入

复核发现 TraeWork 支持 `--remote-debugging-port`（Electron/VS Code 家族），且同目录项目
`oh-dsh-trae-api` 已用该机制跑通「驱动聊天 UI → 提取回复」。据此新增 GUI 驱动路线：

- 连接：`TRAE SOLO CN.exe --remote-debugging-port=<port>` → `GET /json` 取页面 WS（页面为 `solo-lite.html`）。
- 已实测选择器：聊天输入框、新建任务、任务列表（`.taskText` / `.task-list-group-name`）、
  模式切换器、模型下拉、项目文件夹下拉（`cascadeMenu` + `cascadeMenuItemWithSubtitle` + `cascadeFooterButton`）。
- 项目登记：下拉未命中时经 Windows 原生对话框写入路径，实测成功登记项目目录。
- 端到端：`run_task(agentId="traework", model="GLM-5.3", autoVerify=true)` 驱动 TraeWork 创建文件并验收通过。

**为什么不走 HTTP**：LLM/agent 请求在 TTNet 层 TDE 加密，无法在客户端外构造；CDP 驱动完整客户端是唯一可行路径。
实现与踩坑记录见 [traework-cdp.md](traework-cdp.md)。

> 更正记录：早前版本基于 `%APPDATA%` 误判「本机未安装 Trae」；随后在 `D:/` 发现真实安装并定论「无无头 CLI」；
> 本次进一步确证 GUI 路线可行，profile 已改为 `status: "ready"` + `driver: "gui"`。

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
