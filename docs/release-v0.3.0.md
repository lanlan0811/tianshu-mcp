# tianshu-mcp v0.3.0 发布说明

v0.3.0 新增 **Codex 桌面端 GUI 适配器**（`codex-gui`），把统一任务闭环扩展到 Codex：
`run_task → 绑定/新建项目 → 选模型与思考强度 → 发指令 → 运行检测 → 自动验收 → 同会话自动返修`。

核心能力与安全边界见 [codex-gui-cdp.md](codex-gui-cdp.md)。

## 破坏性变更

**`agentId=codex` 的执行方式由无头 CLI 改为桌面端 GUI，原 `codex exec` 无头路径已移除。**

- 升级后 `run_task(agentId="codex")` 会启动并驱动 Codex 桌面窗口，不再是无头子进程。
- 本路径要求本机已安装 Codex 桌面端（MSIX 商店包）。
- 如需保留无头执行，请另建一个 `driver=spawn` 的 profile，见 [agent-profiles.md](agent-profiles.md)。

```jsonc
// 保留无头执行的 profile 示例（新建 agentId，勿与内置 codex 冲突）
"codex-cli": {
  "driver": "spawn",
  "command": "{LOCALAPPDATA}/OpenAI/Codex/bin/<hash>/codex.exe",
  "argsTemplate": ["exec", "<prompt:arg>", "--skip-git-repo-check", "--sandbox", "workspace-write"],
  "promptMode": "arg", "cwd": "task"
}
```

## 主要能力

- **安装发现**：Appx 查询优先（自动跟版本），失败回退扫盘并取最新版本；AUMID 动态解析。
- **启动**：Codex 为 MSIX 包，GUI 宿主无法直启（策略拒绝），改用 `IApplicationActivationManager`
  COM 激活并注入专属 `--user-data-dir` + `--remote-debugging-port`；CDP 接管后收敛到主应用页。
- **项目**：按目录名匹配已有项目；未登记目录**自动登记**进 Codex 项目状态（幂等 + 备份 + 原子写 +
  仅在受管实例停止时写），失败回退界面新建路径。
- **模型与思考强度**：模型按 `menuitemradio` 选择；思考强度为滑块（0–4 档），方向键精确设置并回读校验。
- **验收与返修**：复用既有验收引擎；失败自动生成项目内 `.zcode/plans/codex-fix-r<N>.md` 并写入返修指令，
  默认最多 5 轮。
- **运行检测**：停止按钮为权威信号；无运行信号时失败开放为 `idle_timeout` 且保留实例。

## 真实验收

Windows 10 x64 真机已完成：

1. 已登记项目的全链路；
2. 验收失败 → 自动生成修复计划 → 返修通过 的闭环；
3. 未登记项目经自动登记后的全链路（模型 `GPT-5.6 Sol` + 思考强度「高」）；
4. 真实业务任务：驱动 Codex 用 HTML+CSS+JS 开发「切水果小游戏」，产物通过验收标准，
   并在无头浏览器中实测可玩（得分上升、生命扣减、Game Over 与重开正常、无 JS 异常）。

证据见 [Codex Windows 真机验收记录](codex-windows-smoke.md)。

## 兼容与已知限制

- `GuiProfile` / `ExecutableDiscovery` 新增字段均有默认值，既有 `spawn` profile 不受影响。
- macOS 未验证：Codex GUI 内置状态为 `research`，不参与就绪判定。
- 新建项目的界面路径依赖应用窗口前台（Windows 前台锁）；自动化登记覆盖了绝大多数场景。

## 发布门禁

typecheck、lint、全量测试（340 项）、build、严格 stdio、npm pack 内容及干净消费者安装必须全部通过；
版本在 `package.json`、lockfile、生成文件、tag 与 Release 输入间保持一致。
