# 更新日志（CHANGELOG）

本文件记录 `tianshu-mcp` 的所有重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

英文版：[CHANGELOG.en.md](CHANGELOG.en.md)

---

## [未发布]

### 计划中

- 更多外部 AI-Agent 适配（新 agent = 一个 profile +（如需）一个 adapter 文件）。
- TraeWork 在 macOS 下的可执行探测与原生对话框驱动（当前 macOS 分支 fail-closed）。
- 可选的项目级技能播种（默认不写入目标项目仓库）。

---

## [0.1.5] — 2026-09-08

### 新增

- **TraeWork 面板模式切换**：`run_task` 新增 `mode` 参数，支持 `Work` / `Code` / `Design`。
  - 解析优先级：显式 `mode` 参数 > 任务书文本识别 > 保持 `Work`。
  - 文本识别覆盖中英混写（「切换到 Code 模式」「use design mode」「工作模式」「代码模式」「设计模式」等）。
  - 新增 `gui.modeSwitch` profile 开关（默认 `true`）。
  - 新增纯函数 `detectModeFromText` / `resolveMode`（可单测）。
- **专属 SVG 资产**：`assets/tianshu-mcp-icon.svg`（应用图标）、`assets/tianshu-mcp-banner.svg`（长方形横幅）。
- 新增 `scripts/probe-traework.mjs mode <Work|Code|Design>` 子命令（真机诊断/验证）。
- 新增中英双语发布说明 `docs/release-v0.1.5.md` / `.en.md`。

### 变更

- **TraeWork 执行顺序调整**：实测发现三种模式**各自维护独立的项目绑定**，切换模式会把输入栏项目换成该模式上次使用的项目。
  因此顺序改为「确保实例 → 等待 UI → 新建会话 → 切到目标模式 → 在目标模式内绑定项目 → 切模型 → 发送」。
- 绑定后复核「模式 + 项目」双双就位，任一不符即**响亮失败**（不静默在错误模式下开发）。
- meta 块新增 `model` / `mode` 字段，便于天枢回读。
- `package.json`：`license` 由 `MIT` 改为 `Apache-2.0`（与仓库 `LICENSE` 文件一致）；
  新增 `repository` / `homepage` / `bugs`；`files` 增加 `assets`。
- README.md / README.en.md 全量重写：技术栈勋章、SVG 横幅（在图标上方）、语言隔离（中文 README 只引中文文档，英文 README 只引英文文档）。

### 修复

- **rework 反馈竞态**（预存缺陷，负载下偶发）：终态快照先落盘，调用方立即 `rework_task(feedback)` 写入的指示
  会被上一轮收尾的 `delete meta.reworkFeedback` 抹掉，导致返修轮拿不到反馈。改为在 `startTask` 启动时原子取走并清空。
  新增回归测试 `test/integration/rework-feedback-race.test.ts`。
- **`projectBasename` 跨平台**：原用 `path.basename`（POSIX 下不切反斜杠），Linux/macOS CI 必失败；
  改为显式按 `\` 与 `/` 切分。

### 测试

- 测试总数 **153 → 167**（新增 14 项模式相关用例）。
- 真机端到端验证：`mode=Work` / `mode=Code` / `mode=Design` 三者均完成「切模式 → 绑项目 → 发送 → 生成文件 → 自动验收通过」。

---

## [0.1.4] — 2026-09-08

### 新增

- TraeWork GUI 驱动接入（CDP）：`traework` 由 `unsupported` 改为 `driver=gui` / `status=ready`。
  - 能力：启动/复用实例 → 新建会话 → 绑定项目文件夹（下拉命中优先，未命中走受限 computer-use 原生对话框）
    → 可选指定模型 → 任务书回读校验后发送 → 轮询到完成 → 自动验收 → 失败生成修复计划并同会话返修。
  - 安全：默认复用用户实例、绝不按进程树强杀、终止前核对命令行；computer-use 仅允许 TraeWork 文件夹对话框。
- `AgentAdapter` 新增可选 `run()` 执行面；编排层按 `adapter.run` 分支（CLI 走 spawn 不变）。
- profile 新增 `driver`（`spawn` / `gui`）与 `gui` 配置段；`run_task` 新增 `model` 参数。
- 新增 `src/agents/traework/**`（CDP 客户端、选择器表、启动器、会话/输入/模型/回复模块、受限 computer-use）。
- 验收失败时自动生成修复计划文件 `rework-<taskId>-r<N>.md`（任务目录 + 项目 `.tianshu-mcp`），返修消息引用文件名。

### 变更

- `docs/adapter-matrix.md` 的 T1 结论由 `unsupported` 更正为「已接入（driver=gui）」。
- formatter 透传取消来源字段（`abortSource` 等）到 `query_task` 的 meta 块。

### 修复

- 超时终态统一：普通超时也落 `failed(timeout)` + 一次 `timeout_killed` 事件，顺序固定。
- `shutdown` 测试轮询稳定化。

### 测试

- 测试总数 **72 → 153**（新增 TraeWork 相关单元/集成用例）。
- 真机端到端验证：`run_task(agentId=traework, model=GLM-5.3, autoVerify=true)` 驱动 TraeWork 创建文件并验收通过。

---

## [0.1.3] — 2026-09-08

### 修复

- **S1** 无理由取消被误记 `interrupted`：新增 `cancelRequestedAt` / `abortSource` 独立字段，取消意图不依赖可选 `reason`（5 项回归测试）。
- **S2** 超时终态统一（与 0.1.4 同源）。
- **S3** tracked 预脏净差异归因：基线前脏文件按内容 hash 排除未变改动，staged/unstaged 不再误报为 agent 变更（4 项回归）。
- **S4** `verify_task(taskId)` 持久化更新原任务元数据（`reportRound` / `verificationSource` / `latestVerificationVerdict`，保留 `agentId`）；
  MCP 版本单一来源（`sync-version` 注入）。
- **S5** `projects.json` 正式 Zod schema + `config`/`profiles`/`projects` last-known-good + 内容 sha256 热加载失效检测
  （修复损坏 JSON 被当缺失重置的缺陷）。

### 变更

- **S6** CI/Release `npm ci` 重试修正（成功即停 / 3 次上限 / attempt 计数）；Vitest v3 升级（审计 0 漏洞）；纯文本状态标记（emoji 扫描测试）。

### 测试

- 测试总数 **53 → 72**。

---

## [0.1.2] — 2026-09-08

### 变更

- 构建去掉 sourceMap 发布（无 `.map`，tarball ≈ 69.9 KB）。

### 测试

- 测试总数 **53**。

---

## [0.1.1] — 2026-09-07

### 新增

- **R1–R5 修复后版本**：
  - **R1** 取消/中断状态机持久化（`cancel_requested → cancelled`，`cancelReason`/`finishedAt`/`errorType` 落盘，重启可恢复、幂等、shutdown 有界等待）。
  - **R2** 调用级 `taskTimeoutMs` 优先级修正 + 跨平台进程树终止（POSIX 进程组 SIGTERM→SIGKILL，Windows `taskkill /T /F`）。
  - **R3** Git 基线参与差异计算（以 `baseline.head` 为边界，agent 提交不丢变更，脏工作区 hash 归因）。
  - **R4** 验收工具参数与报告轮次语义（`round=0` 合法、手动验收不覆盖报告、`extraChecks` 追加 + `checksMode=replace`、`optional` 不影响 verdict、`baselineRef` 校验）。
  - **R5** 移除 agent 路径硬编码（`{LOCALAPPDATA}` 等占位符 + 平台标准候选），`config`/`profile`/`projects` mtime 热加载。
- **R6** 跨平台 CI 矩阵（Windows/macOS/Linux × Node 20/22）与 Release 版本一致性（tag/输入 = `package.json` = tarball），tarball 内容校验。
- **R7** npm 发布 `tianshu-mcp@0.1.1` + `npx -y` 拉起 8 工具连通通过。
- **R8** 中英双语文档同步（含 4 篇英文专题文档）。

---

## [0.1.0] — 2026-09-07

### 新增

- 首个可用版本：**M1 核心引擎 + stub-agent 全链路**。
  - 8 个 MCP 工具：`run_task` / `query_task` / `list_tasks` / `get_task_report` / `cancel_task` / `verify_task` / `rework_task` / `get_profiles`。
  - `TaskManager` 状态机 / 每项目串行队列 / 全局并发闸 / cancel(kill tree) / 事件流落盘。
  - 验收引擎：git 基线/diff、默认检查集推导、命令 runner、代码分析、`report.md` / `report.json`。
  - fix-loop 自动返修 + `needs_attention`；技能自检安装。
  - stub-agent 三剧本（good / fix-on-first / never）集成测试 + 协议测试，**53/53 绿**。

---

[未发布]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/lanlan0811/tianshu-mcp/releases/tag/v0.1.0
