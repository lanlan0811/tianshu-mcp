# tianshu-mcp v0.4.1 发布说明

**文档版本**：把编排技能文档（`skills/tianshu-mcp/`）对齐 v0.4.0 的实际工具面，并补齐开源仓库的贡献者名录。**本版本无代码行为变更**，升级无需改动调用方。

## 新增

- **技能文档全面对齐 v0.4.0 工具面**（`SKILL.md` + `usage-examples.md`，server 启动时幂等同步到 `~/.rivet/skills/tianshu-mcp/`）。此前的技能文档自 v0.3.2 起未跟进 v0.3.3 → v0.4.0 的工具面变化，本次逐项补齐：
  - **projectPath 安全闸门**（v0.4.0 引入但技能未提）：绝对路径 + 存在目录 + realpath 归一、拒绝主目录与系统/根级目录、脏仓共处警示；并明确这是**基础设施拒绝**，改路径重试即可，不要误判成 agent 失败。
  - **硬失败错误码速查表**：`setup_failed` / `project_ambiguous` / `project_mismatch` / `project_create_failed` / `model_unavailable` / `model_mismatch` / `permission_unknown` / `cdp_disconnected` / `instance_busy` / `session_lost` / `input_mismatch` / `send_unknown` / `idle_timeout` / `task_timeout` / `aborted` 的含义与处置；明确硬失败**不进验收、不进自动返修**，反复重试即空转。
  - **needs_user 等待类型补全**：新增 `setup_recovery`（zcode 初始化恢复重试与预算用尽，常见于项目同名歧义、绑定回读不一致、原生面板超时）；补 `continue_task` 只接受 `needs_user`、codex 仅支持 `login_required`/`user_confirmation`、zcode 会话定位信息丢失时拒绝恢复等限制。
  - **codex-cli 无头路径**：用户自建 `driver=spawn` profile 的用法、`model` 对其不生效、codex CLI 需 ≥0.154.0（≤0.130.0 签名证书被吊销）。
  - **状态语义**：`ready` 与 `research` 的区别（`research` 仍可执行，只是平台矩阵未覆盖），以及各平台当前取值。
  - **验收行为变更**：检查项**默认并行 2**（`verifyConcurrency` 1–4，v0.4.0 起）、顺序依赖的 checks 必须显式设 1、`requireChanges` 零变更门禁对纯只读任务的影响。
  - **usage-examples.md** 补：`codex-cli` 派活示例、meta 块字段全表（新增 `agentEndReason`/`lastRunSignal`/`checks`/`round`/`keptInstance`/`zcodeSessionId`/`modelProvider`/`permissionMode`/`progressSummary`）、错误码速查表、项目级 `.tianshu-mcp/acceptance.json` 配置模板（含并行干扰警示）、`setup_recovery` 恢复示例、profile 整键覆盖语义。
- **双语 README 贡献者名录**：新增「贡献者 / Contributors」小节，按首次参与顺序列出通过 Issue 与 PR 参与项目的社区成员（头像 + 名字，可点击跳转）。

## 修复

- 无代码修复。本版本不含运行时行为变更。

## 升级注意

- **无需迁移**：调用方 API、工具参数、meta 块字段、验收配置格式与 v0.4.0 完全一致。
- 已安装旧版技能的环境会在 server 下次启动时自动同步新技能（内容 hash 变化才覆盖，旧文件备份为 `.bak-<时间戳>`）。

## 平台与验证状态

- **Windows 10 x64**：本地门禁（`typecheck` / `lint` / `build` / `pack:check` / 严格 stdio）与 **443/443** 测试全绿。
- **macOS**：`codex` 与 `zcode` 的**基本闭环**已由贡献者在 macOS arm64 真机验证；**取消 / 返修 / `continue_task` / 新建项目矩阵未覆盖，两者 darwin 仍保持 `research`**。维护者无 macOS 设备，该结论未独立复验。

## 分发与兼容性

- 发布 GitHub Release 与 tarball，并同步发布到 npm（`tianshu-mcp@0.4.1`，`latest`）。GitHub 为主仓库，Gitee 为代码、标签与发行版镜像。
- 本版本为 **PATCH**：仅文档与元数据变更，无破坏性变更。

相关文档：[项目 README](../README.md)｜[CHANGELOG](../CHANGELOG.md)｜[技能文档 SKILL.md](../skills/tianshu-mcp/SKILL.md)｜[使用示例](../skills/tianshu-mcp/usage-examples.md)
