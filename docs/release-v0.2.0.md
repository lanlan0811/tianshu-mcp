# tianshu-mcp v0.2.0 发布说明

v0.2.0 新增 ZCode Electron CDP GUI adapter，并把统一任务闭环扩展为：`run_task → query_task → needs_user/continue_task → 自动验收 → 同会话自动返修 → 再验收`。

核心能力与安全边界见 [zcode-cdp.md](zcode-cdp.md)。MCP 工具数由 8 增至 9。Windows 10 x64 已完成真实开发、受控失败后同会话返修，以及 `AskUserQuestion → needs_user → continue_task` 闭环，见 [Windows 真机验收记录](zcode-windows-smoke.md)。ZCode profile 仍保持 `research`，因为 macOS 真机证据尚未完成；该状态是有意的发布门禁，不影响 Codex/TraeWork 既有能力。

发布门禁：typecheck、lint、全量测试、build、严格 stdio、npm pack 内容及干净消费者安装必须全部通过；版本在 `package.json`、lockfile、生成文件、tag 与 Release 输入间保持一致。
