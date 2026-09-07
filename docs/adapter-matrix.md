# Agent 能力调研矩阵（adapter-matrix.md）

外部 AI-Agent 接入调研结论。维护原则：**只接有官方 CLI / 编程接口的 agent**；无接口的不 pty 硬接，明确标 unsupported 并给替代建议。

更新记录：本文件与 `docs/agent-profiles.md` 配套。状态随 M2/M3 调研推进刷新。

## 汇总矩阵

| Agent | 接口类型 | 状态 | 可执行发现 | 登录态 | 任务/文件回读 | 备注 |
|---|---|---|---|---|---|---|
| **Codex**（OpenAI 桌面端） | 本地 CLI `codex.exe` | ✅ 可接入（M2 冒烟待跑） | `executableDiscovery` → `.../Codex/bin/<hash>/codex.exe` | 复用 `~/.codex`（auth.json），与桌面端同账号 | cwd 内读写文件；`--json` JSONL / `-o` 末条消息 | `codex exec "<prompt>" -C .`；sandbox/审批模式 M2 定（见 C1） |
| **Zcode**（本机 CLI） | 待调研（`.zcode/cli`，Node CLI，无 PATH 命令） | 🔍 M2-Z1 调研中 | —（未自动探测） | 复用本机登录态 | 待定 | 见下方 Z1 |
| **TraeWork**（Trae CN / TRAE SOLO CN） | 本机未安装，无可验证接口 | 🔍 M3-T1（本机实测：仅遗留缓存目录，无 exe） | — | — | — | 装回 Trae 后再查 CLI/HTTP；仍无则标 unsupported（见 T1） |
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
- `--sandbox read-only|workspace-write|danger-full-access`；`--approve-for-me` 走自动审批；非交互自动化需按策略选 sandbox/审批模式（**M2 真实冒烟定 profile 时确认**）。
- `--json` 事件输出 JSONL；`-o, --output-last-message <FILE>` 取末条消息；`--ephemeral` 不落会话文件。
- `--skip-git-repo-check`：允许非 git 仓库（我们的任务都在 git 项目内，可留可去）。
- 精确 `argsTemplate`（sandbox 模式/是否需要 `--json`）→ M2 用真实小任务冒烟后回填 agent-profiles.md 样例，属数据调整。

**结论（adapter 配置基线）**：

```jsonc
"codex": {
  "command": "<bin 绝对路径，或用 executableDiscovery 自动取最新 <hash>>",
  "argsTemplate": ["exec", "<prompt:arg>", "-C", ".", "--skip-git-repo-check"],
  "promptMode": "arg",
  "cwd": "task",
  "env": {},
  "killTree": "taskkill",
  "executableDiscovery": { "dirs": ["C:/Users/Lenovo/AppData/Local/OpenAI/Codex/bin"], "fileNames": ["codex.exe"] }
}
```

> 说明：`-C .` 里的 `.` 在 spawn cwd=项目目录下即项目根；若某些版本需要绝对路径，可在 M2 联调时把 argsTemplate 改为显式绝对路径（profile 数据可改）。sandbox 与审批：自动化场景倾向 `--sandbox workspace-write`；若 codex 触发审批请求会阻塞非交互执行，届时改用 `--approve-for-me` 或按需 `danger-full-access`，并在 profile `authNote` 注明。

## T1 — TraeWork 可编程接口（2026-09-07 实测）

结论：**本机未安装可运行的 Trae / TraeWork**，无可编程接口可验证。

- 只发现遗留缓存目录：`%APPDATA%\Trae CN`、`%APPDATA%\TRAE SOLO CN`（含 VSCode 系缓存：Cache/Local Storage/GPUCache…），无可执行文件；`%APPDATA%\TRAE Work CN` 目录为空。
- `AppData` 下 `find -iname "trae*.exe"` 无结果；`%LOCALAPPDATA%\Programs` 无 Trae。
- 因此：**adapter 保持 `research` 占位**（开发计划 §13 T1 的无接口/不可验证分支）。本机无 Trae 时 `traework` 不可用属正确行为。
- 若后续安装 Trae 系产品：重新执行 T1（查 CLI/HTTP/MCP host/登录态），有接口再实现 adapter；仍无接口则标 `unsupported` + 替代建议（不 pty 硬接）。

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
