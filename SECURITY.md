# 安全策略（SECURITY）

英文版：[SECURITY.en.md](SECURITY.en.md)

## 支持的版本

安全修复只面向最新发布版本。请升级到最新版后再报告问题。

| 版本 | 支持 |
|---|---|
| 0.1.x（最新） | ✅ |
| 更早版本 | ❌ |

## 报告漏洞

**请不要通过公开 Issue 报告安全漏洞。**

请使用 GitHub 的私密漏洞报告通道：

1. 打开 <https://github.com/lanlan0811/tianshu-mcp/security/advisories/new>
2. 或在该仓库 **Security → Advisories → Report a vulnerability** 提交。

报告请尽量包含：

- 受影响版本（`npm view tianshu-mcp version` 或 `package.json`）；
- 复现步骤（最小可复现配置/命令）；
- 影响评估（能读什么、能写什么、是否需要本地访问）；
- 若已知，给出缓解建议。

**响应预期**：收到后 7 天内确认，30 天内给出修复或缓解计划；修复发布后会在 Release 说明与
[CHANGELOG.md](CHANGELOG.md) 中致谢（如你希望匿名请注明）。

## 安全模型（本项目的设计边界）

理解以下边界有助于判断问题是否属于「设计内行为」。

### 1. 凭证零管理

- 本 MCP **不保存、不读取、不转发**任何外部 AI-Agent 的 API key 或登录态。
- 各 agent 使用各自的登录态（例如 Codex 用 `~/.codex`，TraeWork 用其桌面端登录态）。
- TraeWork 驱动只通过 CDP 操作 UI，**不接触**其凭证文件。

### 2. 命令执行面收敛

- 验收命令来自**白名单式结构化配置**（`name` + `cmd` 为 argv 数组），**不拼接 shell 字符串**，
  默认不使用 `shell: true`。
- 命令在**目标项目目录**内执行，超时受 `verifyCommandTimeoutMs` 约束。
- 任务产物（日志、报告、修复计划）只写入任务数据目录与项目内 `.tianshu-mcp/`。

### 3. 进程与路径

- 路径参数要求绝对路径且目录存在，并做规范化。
- 子进程使用 `windowsHide`、stdio 管道；终止使用进程树 kill（Windows `taskkill /T /F`，
  POSIX 进程组 SIGTERM→SIGKILL）。
- **GUI 驱动（TraeWork）额外约束**：
  - 默认复用用户已有实例，绝不新起第二个；
  - 绝不按进程树盲杀；终止前核对命令行归属，无法确认则放弃终止并告警；
  - 传给 GUI 进程的路径一律使用原生平台形式。

### 4. 桌面自动化白名单

内置 computer-use **仅**允许驱动 TraeWork 的文件夹选择对话框（窗口标题匹配 + 宿主进程白名单）。
其他任何窗口（浏览器、终端、编辑器、系统对话框）一律拒绝并抛 `COMPUTER_USE_DENIED`。

### 5. 权限审批

写/执行类工具（`run_task` / `cancel_task` / `rework_task`）默认声明 `requireApproval`，
由宿主（天枢）在 UI 侧把关；读/查询/验收类工具免审批。

### 6. 代码保护

- 动工前采集 git 基线（HEAD + 脏状态）；验收报告相对基线计算变更。
- **不自动** commit / stash / 回滚；需要回滚由用户基于报告自行决定。

## 依赖与供应链

- 运行时依赖最小集：`@modelcontextprotocol/sdk`、`zod`、`cross-spawn`。
- 提交前 `npm audit` 应无已知漏洞；CI 在 Ubuntu/Windows/macOS × Node 20/22 上运行类型检查、
  lint、测试与构建。
- 发布物经 `npm pack` 内容校验（必须含 `dist/`、技能、双 README、LICENSE、`assets/`）。

## 不在范围内

- 外部 AI-Agent 自身的行为与漏洞（请向其厂商报告）。
- 用户自行在 profile 中填写的 `env` 敏感值（属本机自担风险字段，不会写入任务日志）。
- 因用户手动授予过高系统权限而导致的越权。
