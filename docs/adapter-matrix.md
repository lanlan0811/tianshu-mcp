# Agent 能力调研矩阵（adapter-matrix.md）

外部 AI-Agent 接入调研结论。维护原则：**只接有官方 CLI / 编程接口的 agent**；无接口的不 pty 硬接，明确标 unsupported 并给替代建议。

更新记录：本文件与 `docs/agent-profiles.md` 配套。状态随 M2/M3 调研推进刷新。

## 汇总矩阵

| Agent | 接口类型 | 状态 | 可执行发现 | 登录态 | 任务/文件回读 | 备注 |
|---|---|---|---|---|---|---|
| **Codex**（OpenAI 桌面端） | 本地 CLI `codex.exe` | ✅ **已冒烟通过**（2026-09-07 run_task→verify_task，见 [m2-smoke-record.md](m2-smoke-record.md)） | `executableDiscovery` → `.../Codex/bin/<hash>/codex.exe`（实测 v0.153.4） | 复用 `~/.codex`（auth.json），与桌面端同账号 | cwd 内读写文件；stdout 流式 | `codex exec "<prompt>" --sandbox workspace-write`（勿与 --approve-for-me 同用） |
| **Zcode**（本机 CLI） | 待调研（`.zcode/cli`，Node CLI，无 PATH 命令） | 🔍 M2-Z1 调研中 | —（未自动探测） | 复用本机登录态 | 待定 | 见下方 Z1 |
| **TraeWork / TRAE SOLO CN** | 桌面 IDE（v1.107.1 实测） | ❌ **unsupported**（无无头可编程驱动接口，见 T1） | 有 VS Code 家族 CLI（`bin/trae-solo-cn.cmd` → open/serve-web/扩展管理），**无 agent-exec** | — | — | `byted-solo.builtin-mcp` 是 MCP 客户端扩展，非被驱动接口 |
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

## T1 — TraeWork / TRAE SOLO CN 可编程接口（2026-09-07 实测，已定论）

**结论：`unsupported`——本机安装的 Trae 产品（TRAE SOLO CN v1.107.1）无 codex 风格的无头可编程 agent 驱动接口。**

实测证据（安装目录 `D:\TRAE Work CN`，即 TRAE SOLO CN）：

- 应用：`D:\TRAE Work CN\TRAE SOLO CN.exe`（Electron，product.json `name: TRAE SOLO CN`，version `1.107.1`）。
- 提供的 CLI 仅 VS Code 家族命令（`bin/trae-solo-cn.cmd` 以 ELECTRON_RUN_AS_NODE 调 `resources/app/out/cli.js`）：
  - `open` / `open-url` / `serve-web` / `install-extension` / `uninstall-extension` / `list-extensions` / `locate-extension` / `version` / `tunnel` / `command` / `open-devtools`
  - **没有任何 `agent exec` / headless agent 驱动子命令**。
- 全安装目录（排除 node_modules）`find -iname "*codex*" -o -iname "*agent*.exe" -o -iname "*solo*cli*"` 无结果；无独立 agent CLI 二进制。
- 扩展含 `byted-solo.builtin-mcp`（MCP **客户端**扩展，供 IDE 内接 MCP server）与 `cloudide.icube-agent-shell-exec`；这些是 IDE 侧能力，不是可供本 MCP server 外部调用的无头接口。
- `%PATH%` 无 trae；无 `--headless`/远程 agent API。

因此：TRAE SOLO CN（TraeWork 系）当前**不能被 tianshu-mcp 作为外部 agent 无头驱动**。已在内置 profile 标 `status: "unsupported"`。若 Trae 未来提供 headless agent CLI / 官方远程接口，可重跑本调研并实现 adapter（R14：不 pty 硬接、不 GUI 自动化默认实施）。

> 更正记录：早前版本基于 `%APPDATA%` 误判「本机未安装 Trae」；本次在 `D:/` 发现真实安装并完成定论。

## Z1 — Zcode headless 入口（M2 前置，进行中）

背景：本机 Zcode = `C:\Users\Lenovo\.zcode\cli`（Node CLI，无 PATH 命令）；桌面应用复用同一数据。

**2026-09-07 实测**：`.zcode\cli` 根目录仅含运行期数据目录（`agents/` `exec/` `plugins/` `rollout/` `artifacts/` `log/` `db/` + 大量 `sess_*` 会话目录），**没有 `package.json`/bin/可执行入口**；agent 会话数据分别落在 `agents/sess_*` 与 `exec/sess_*`。说明真正的 CLI 入口不在数据目录，需向 Zcode 产品侧确认（或桌面端持有）。

待确认问题：

- [ ] `zcode` 的无头 exec/子命令入口在哪里（可能在安装目录而非数据目录）？
- [ ] 无头模式参数、工作目录、stdout/日志、退出码语义？
- [ ] 登录态路径与复用方式？
- [ ] 结论写入本文件 → 回填 `agent-profiles.md` 样例 + `builtin.ts` zcode profile。

处理策略：向 Zcode 侧确认安装目录/无头接口。若仅 GUI：评估列入 pty 备选方案（占位标注，不默认实施）。

## 只读调研来源（D:\Tianshu 逆向，仅作事实依据）

- MCP 机制与工具回传约束：见开发计划 §1（只回文本、异步轮询、长任务需异步化）。
- 本机探测（2026-09-07）：Node v24 / 无 agent CLI 在 PATH；Codex 桌面端自带 `codex.exe` CLI；`codex-code-mode-host.exe` / computer-use 运行时 / chrome-native-host 存在。
