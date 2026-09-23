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
- **AI 内容校验（可选，默认关闭）同样不引入任何凭证管理**：MCP 不读取任何密钥，不实现任何模型/厂商
  HTTP 客户端，也不内置 agent CLI 预设。判定完全**委托给用户显式声明的本地命令**，由该命令自行使用它
  自己的登录态或密钥。MCP 只做三件事：按模板拼参数、spawn 该命令（`shell:false` + 结构化 argv）、
  解析其 stdout 末行 JSON。

**数据外发的强制力边界（务必如实理解）**：

- 图片是否离开本机**取决于用户自备命令的行为**，MCP 无法在系统层拦截。
- MCP 的强制力仅在**契约层**：`allowRemote` 默认为 `false`，未逐规则显式放行的规则**禁止**在
  `argsTemplate` 中使用字节外传占位符 `<image:base64:file>`（schema 直接拒绝该配置，不是运行期提示）。
- `visual doctor` 会列出每条规则的 `allowRemote` 声明供人工核对。
- 因此需要用户自行确认其命令的实际行为；MCP 不对此做含糊承诺。

### 2. 命令执行面收敛

- 验收命令来自**白名单式结构化配置**（`name` + `cmd` 为 argv 数组），**不拼接 shell 字符串**，
  默认不使用 `shell: true`。
- 命令在**目标项目目录**内执行，超时受 `verifyCommandTimeoutMs` 约束。
- AI 内容校验的自备命令同样以 `shell:false` + 结构化 argv 执行，超时受 `visual.content.timeoutMs`
  约束并杀进程树；用户声明的环境变量使用 `{ 子进程变量名: 宿主环境变量名 }` 引用，缺失即整轮阻塞，
  MCP 自身不读取该变量的内容。
- 任务产物（日志、报告、修复计划）只写入任务数据目录与项目内 `.tianshu-mcp/`。

### 2.1 技能自检安装的供应链边界（issue #16）

- **内容来源唯一**：随包分发的技能只从**包自身**定位（`import.meta.url` 相对的 `skills/tianshu-mcp/`），
  **不从当前工作目录发现内容**——避免「在某个第三方仓库目录里调试起 server，该仓库自带的同名路径被
  安装进 `~/.rivet/skills/` 并在新会话生效」。
- **不静默覆盖**：安装目标目录内维护内容 hash 清单；检测到**用户本地修改**（清单记录与目标内容不符）
  或**来源不明**（无有效清单）时默认**保留现有内容并告警**，绝不静默替换。仅当内容可证未被改动时
  才自动升级，或经用户显式传入 `--approve-skill-update` / `TIANSHU_MCP_APPROVE_SKILL_UPDATE=1` 放行。
- **可回退**：覆盖前先备份为 `<目标>.bak-<时间戳>`，历史备份保留个数由 `skills.backupKeep` 治理
  （默认 3，`0` = 不清理）。
- 本模块只写 `~/.rivet/skills/`（`os.homedir()` 动态解析）与其下的备份/临时目录，不触碰项目目录，也不读取任何凭证。

### 3. 进程与路径

- 路径参数要求绝对路径且目录存在，并做规范化。
- **危险目录闸门（`assertSafeProjectDir`）**：写入类入口（`run_task` / `verify_task`）拒绝
  - **系统目录及其子树**：`/etc`、`/usr`、`/bin`、`/sbin`、`/private/etc`（macOS realpath 形态）与
    `c:/windows`、`c:/program files`、`c:/program files (x86)`——匹配为**边界感知**（要求前缀后为 `/`），
    因此 `c:/windows.old`、`/etcetera` 不会被误伤。
  - **精确相等的根**：`/`、盘符根（`C:\` / `D:\` 等）、`/var`、`/tmp`、`/opt`、用户主目录、`c:/users` 等。
- **`/var`、`/tmp` 为何只挡精确根**：它们之下存在合法工作区——macOS 的 `os.tmpdir()` 就是
  `/var/folders/...`，若按子树拒绝会连带拒掉测试基座与大量临时工作区。这是有意的取舍，
  边界残留记录在 [ARCHITECTURE §15](ARCHITECTURE.md)。
- 子进程使用 `windowsHide`、stdio 管道；终止使用进程树 kill（Windows `taskkill /T /F`，
  POSIX 进程组 SIGTERM→SIGKILL）。
- **GUI 驱动（TraeWork）额外约束**：
  - 默认复用用户已有实例，绝不新起第二个；
  - 绝不按进程树盲杀；终止前核对命令行归属，无法确认则放弃终止并告警；
  - 传给 GUI 进程的路径一律使用原生平台形式。

### 4. 桌面自动化白名单

内置原生自动化**仅**允许驱动 TraeWork 或 ZCode 本次新打开、且所有者进程可核验的文件夹选择对话框。
其他任何窗口（浏览器、终端、编辑器、系统对话框）一律拒绝并抛 `COMPUTER_USE_DENIED`。

### 5. 权限审批

有副作用的写类工具（`run_task` / `cancel_task` / `rework_task` / `continue_task` /
`prepare_visual_baseline` / `approve_visual_baseline`）默认声明 `requireApproval`，由宿主（天枢）在 UI 侧把关。
读/查询类工具免审批。**`verify_task` 能力归 `execute`（会跑项目命令、可产生构建产物，故 MCP
`readOnlyHint` 为 false），但仍按 R11 免审批**——本项目不因「执行」这一分类而要求用户逐次授权。

### 6. ZCode GUI 边界

- CDP 仅连接 `127.0.0.1`，并同时核验 ZCode 页面标识与调试端口所属进程。
- 不读取、复制、解密或打印 ZCode 登录数据、密钥和凭证；不调用安装包内未公开的 `app-server` 协议。
- 既有无 CDP 实例只触发 `needs_user`，绝不自动关闭。超时或断线保留窗口，不自动点击停止。
- 文件夹路径经环境变量或 argv 传递，写入后回读一致才确认。

### 7. 代码保护

- 动工前采集 git 基线（HEAD + 脏状态）；验收报告相对基线计算变更。
- **不自动** commit / stash / 回滚；需要回滚由用户基于报告自行决定。

## 依赖与供应链

- 运行时依赖最小集：`@modelcontextprotocol/sdk`、`zod`、`cross-spawn`。
- 提交前 `npm audit` 应无已知漏洞；CI 在 Ubuntu/Windows/macOS × Node 20/22/24 上运行类型检查、
  lint、测试与构建。
- 发布物经 `npm pack` 内容校验（必须含 `dist/`、技能、双 README、LICENSE、`assets/`）。

## 不在范围内

- 外部 AI-Agent 自身的行为与漏洞（请向其厂商报告）。
- 用户自行在 profile 中填写的 `env` 敏感值（属本机自担风险字段，不会写入任务日志）。
- 因用户手动授予过高系统权限而导致的越权。
