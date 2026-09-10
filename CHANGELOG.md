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

## [0.1.10] — 2026-09-10

### 修复

- **修复 stdio 日志污染（issue #1）**：统一日志模块此前只有 ERROR 走 `console.error`，
  INFO/WARN/DEBUG 都走 `console.log`，与 MCP JSON-RPC 消息共用 stdout，导致严格 stdio 客户端
  握手或工具调用失败。现在所有通过阈值的级别一律写 stderr，stdout 只承载合法 MCP 消息。
- 日志文件追加、时间戳、级别标签与 `<数据目录>/logs/server.log` 路径保持不变；启动失败仍以 stderr 报错。

### 新增

- 新增 `scripts/check-stdio.mjs` 严格 stdio 冒烟：真实子进程按字节校验完整 stdout/stderr，
  stdout 只允许有换行分隔的合法 MCP JSON-RPC 消息（官方 schema 校验），空行 / 非 JSON / parser error /
  退出残留片段任意一条即失败。覆盖首次启动、已有技能再次启动、`--no-skill-install`、
  损坏 `config.json`、stub 任务运行期日志、正常 EOF 关闭六个场景。
- 新增 `npm run check:stdio` 与 `npm run check:stdio:src` 脚本。

### 测试

- 新增 `test/unit/log.test.ts`：以真实子进程验证四级日志的输出通道、默认 INFO 过滤、阈值过滤后的
  文件日志与 UTF-8 内容（修复前 4/6 失败，见 `docs/m2-evidence/issue1-old-impl-log-test-failure.txt`）。
- CI 三平台矩阵增加 Node 24；构建后用严格 stdio 检查替换仅验证 EOF 退出的冒烟。
- CI `pack-check` 与 Release 把本次 tarball 安装到干净消费者目录，动态读取已安装 bin 并复用同一严格
  stdio 检查；Release 增加 `lint` 与安装包协议门禁，失败即阻断草稿创建。
- ESLint 对 `src/**/*.ts` 启用 `no-console`（仅允许 `error`），防止再次向 stdout 直接输出。

---

## [0.1.9] — 2026-09-09

### 修复

- 修复 TraeWork 长时间思考期间 DOM 静止约 36 秒就被误判完成的问题：停止按钮与任务尾部 loading
  成为权威运行信号，并优先于完成标志；稳定轮数只启动空闲计时，默认持续 10 分钟才返回 `idle`。
- 修复 CDP WebSocket 断开后 `Runtime.evaluate` 永久挂起：连接关闭/错误会拒绝全部待处理请求，
  单次 CDP 命令默认 15 秒超时，任务取消最多约 1 秒生效。
- 仅 `completion_mark` / `ask_user` 会释放本模块启动的实例；空闲、超时、取消与 CDP 断开均保留实例，
  并通过 `agentEndReason` / `keptInstance` 暴露原因。
- 修复服务关闭恰逢 orchestrator 采集基线、任务状态仍为 `queued` 时被误记成用户取消的竞态；
  用户取消现在只依据结构化取消意图判断。

### 新增

- 轮询期间默认每 30 秒写入可由 `query_task` 观察的进度事件。
- 新增 `gui.idleTimeoutMs`、`gui.cdpSendTimeoutMs`、`gui.progressIntervalMs` 与 5 个可覆盖的存活探针选择器。

### 测试

- 新增存活真值表、CDP 命令超时/断线收敛、选择器表达式及假 CDP 实例保留等回归测试。
- Windows/macOS/Linux × Node 20/22 与 tarball 门禁保持覆盖。

---

## [0.1.8] — 2026-09-08

### 修复

- **原子写并发缺陷**（CI 偶发失败的真实根因）：`writeJsonAtomic`/`writeTextAtomic` 的临时文件名
  为 `<目标>.<pid>.tmp`，同进程并发写同一目标时共用同一临时文件——先完成者 rename 走后，
  后完成者抛 `ENOENT`；Windows 上并发 rename 还会抛 `EPERM`。表现为 `rework_task` 偶发返回
  `undefined` meta（CI windows/Node20 命中）。修复：临时文件名加随机后缀 + rename 瞬时错误退避重试。

### 测试

- 新增 `test/unit/atomic-write.test.ts`（3 项：并发 JSON/文本写全部成功、不残留临时文件）。

---

## [0.1.7] — 2026-09-08

### 修复

- **项目文件夹绑定仍然失败**（v0.1.6 未根治；实战反馈：原生对话框出现但编辑框为空就点了确认）：
  - **根因**：MCP 内部传入 `normPath()` 规范化路径（小写盘符 + 正斜杠，如 `d:/Trae项目/AI游戏/象棋`），
    而 **Windows 原生文件夹选择器不接受该形式**——实测同样回读一致，但点击确认时对话框不关闭。
    修复：写入前用新增的 `toNativeWindowsPath()` 转成 `D:`。
  - 写入后用 `WM_GETTEXT` **回读校验**；不一致则重新定位并重试（最多 3 次）；仍不一致**不点确认**并明确报错。
  - footer 点击后探测到的 **hwnd 贯穿传给写入脚本**，只操作该窗口；点击后复查「该 hwnd 是否消失」。
  - 绑定前**自动关闭遗留对话框**（上次失败残留），避免写到旧窗口上。
  - 确认按钮增加「矩形位于对话框下半部」校验，排除同名 Pane 误命中。
  - 对话框脚本全过程输出（HWND/READBACK）写入任务日志，便于排障。

### 测试

- 测试总数 **172 → 181**（单测含路径规范化、原子写并发安全；集成含遗留对话框清理）。
- 真机验证：新中文项目 `D:\Trae项目\AI游戏\象棋`（不在下拉）走原生对话框全链路通过；
  `五子棋` 与 ASCII 项目 `ts-bind-test` 回归通过。

---

## [0.1.6] — 2026-09-08

### 修复

- **项目文件夹绑定卡住 / 报「等待原生对话框超时」**（实战反馈，非适配器损坏）：
  - `clickDropdownFooter` 旧实现只看 `element.click()` 的返回值就当点击成功，但该按钮点击后
    原生弹窗可能并未出现 → 现在**点击后必须确认对话框真的出现**，否则记录下拉 DOM 快照并明确失败。
  - 原生对话框探测在 Node 侧每 800ms 轮询一次，而 PowerShell 冷启动约 4.5–6s，
    15s 预算只够约 2 次探测 → 改为**单次 PowerShell 调用内轮询**（脚本内 400ms 间隔），预算提到 30s。
  - **中文路径被破坏**（实测 `D:\Trae项目\ts-bind-test` 被写成 `D:Traes-bind-test`）：
    SendKeys/剪贴板受控制台代码页影响 → 改用 Win32 **`WM_SETTEXT`** 直接写入编辑框，CJK 路径完全可靠。
  - **确认按钮点到了文件列表项**：`AutomationId="1"` 不唯一（列表行也用 0/1/2…）→ 改为
    **AutomationId=1 且 ControlType=Pane** 组合定位后再按矩形坐标点击。
  - PowerShell 输出中文乱码 → 脚本内**只用 ASCII 输出**，Node 侧 `localizeDialogMessage()` 映射回中文。

### 新增

- **非 Work 模式的绑定兜底**：在 Code/Design 模式绑定失败时自动**回落 Work 重试一次**，
  成功后再切回目标模式并复核项目仍在；两次都失败才报错，错误信息包含两种模式各自的原因。
- 真机验证：对**不在下拉列表**的新项目（`D:\Trae项目\ts-bind-test`）执行
  `run_task(agentId=traework, mode=Code)` 全链路通过——原生对话框写入路径 → 点击确认 →
  项目进入 TraeWork 列表（`solo-lite.local-project-folders` 22→23 条）→ 发送任务 → 自动验收 `succeeded`。

### 变更

- `docs/traework-cdp.md` / `.en.md`：踩坑表新增 7 条；补充「下拉项 ≠ 项目 map」的事实与兜底说明。

### 测试

- 测试总数 **167 → 172**（新增对话框消息映射/平台分支单测 + Code→Work 兜底集成测试）。

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

[未发布]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.9...HEAD
[0.1.9]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/lanlan0811/tianshu-mcp/releases/tag/v0.1.0
