# Agent 能力调研矩阵（adapter-matrix.md）

外部 AI-Agent 接入调研结论。维护原则：**只接有官方 CLI / 编程接口的 agent**；无接口的不 pty 硬接，明确标 unsupported 并给替代建议。

更新记录：本文件与 `docs/agent-profiles.md` 配套。状态随 M2/M3 调研推进刷新。

## 汇总矩阵

| Agent | 接口类型 | 状态 | 可执行发现 | 登录态 | 任务/文件回读 | 备注 |
|---|---|---|---|---|---|---|
| **Codex**（OpenAI 桌面端） | 本地 CLI `codex.exe` | ✅ 可接入（M2 联调中） | `executableDiscovery` 到 `AppData/Local/OpenAI/Codex/bin/<hash>/codex.exe` | 复用 `~/.codex`（auth.json），与桌面端同账号 | cwd 内读写文件；stdout 流式 | `codex exec "<prompt>" --skip-git-repo-check` |
| **Zcode**（本机 CLI） | 待调研（`C:\Users\Lenovo\.zcode\cli`，Node CLI，无 PATH 命令） | 🔍 M2-Z1 调研中 | —（未自动探测） | 复用本机登录态 | 待定 | 见下方 Z1 |
| **TraeWork**（Trae CN / TRAE SOLO CN） | 待调研（桌面 IDE；未见独立 CLI） | 🔍 M3-T1 调研中 | — | 待定 | 待定 | 见下方 T1 |
| **stub**（测试用） | 本地脚本 | ✅ 内置测试 | 测试注入 profile | 无 | — | 仅 M1 集成测试使用 |

状态图例：✅ 可接入（已实现/已冒烟）｜🔍 调研中｜⬜ 规划/占位｜❌ 已证伪不支持

## 扩展新 agent（三步）

1. 数据目录 `agent-profiles.json` 新增 profile（见 agent-profiles.md）；默认能力够用则**零代码**。
2. 需要特殊输出解析（如非 0 退出码但成功、要解析 JSON 结果）→ 继承/实现 `AgentAdapter` 并 `registry.register(id, adapter)`。
3. `get_profiles` 自检可执行探测，跑一次 stub/codex 冒烟任务验收。

## Z1 — Zcode headless 入口（M2 前置）

背景：本机 Zcode = `C:\Users\Lenovo\.zcode\cli`（Node CLI：含 agents/exec/plugins…），无 PATH 命令；桌面应用复用同一数据。

待确认问题：

- [ ] `zcode` CLI 有无无头 exec/子命令（如 `zcode run <prompt>` / agent exec）？
- [ ] 无头模式参数、工作目录、stdout/日志、退出码语义？
- [ ] 登录态路径与复用方式？
- [ ] 结论写入本文件 → 回填 `agent-profiles.md` 样例 + `builtin.ts` zcode profile。

处理策略：查 `.zcode/cli` 结构与命令帮助；必要时与 Zcode 侧确认。若仅 GUI：评估列入 pty 备选方案（占位标注，不默认实施）。

## T1 — TraeWork 可编程接口（M3 前置）

背景：Trae 为桌面 IDE（`%LOCALAPPDATA%\TRAE SOLO CN` / `Trae CN`）；未见独立 `TraeWork` CLI。

待确认问题：

- [ ] TraeWork 是否提供 CLI / 本地 HTTP / MCP host？
- [ ] 参数、cwd、登录态、权限（是否可无头跑编码任务）？
- [ ] 结论写入本文件：可接入 → 实现 adapter + 真实任务验证；无接口 → 明确标 `unsupported` + 替代建议（如 GUI 自动化利弊评估存档，不实施）。

## 只读调研来源（D:\Tianshu 逆向，仅作事实依据）

- MCP 机制与工具回传约束：见开发计划 §1（只回文本、异步轮询、长任务需异步化）。
- 本机探测（2026-09-07）：Node v24 / 无 agent CLI 在 PATH；Codex 桌面端自带 `codex.exe` CLI；`codex-code-mode-host.exe` / computer-use 运行时 / chrome-native-host 存在。
