# 更新日志（CHANGELOG）

本文件记录 `tianshu-mcp` 的所有重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

英文版：[CHANGELOG.en.md](CHANGELOG.en.md)

---

## [0.6.10] - 2026-09-26

### 新增

- **Open Design 工作目录绑定编排**（`src/agents/opendesign/workspace.ts`，计划 P2 流程）：已绑定则跳过（不做无意义点击、不改动用户既有绑定）→ 展开「工作目录」→ 点「选择目录」→ 原生对话框 → **回读界面显示值校验**；`normalizeWorkspacePath` / `workspaceMatches`（大小写/斜杠归一 + 界面截断省略号的前缀匹配）。**判据是回读一致，不是对话框关闭**——两者不一致时如实报 `readback` 失败，绝不当成成功继续。
- **Open Design 原生「选择文件夹」对话框自动化**（`src/agents/opendesign/dialog.ts`，计划 P2 的不依赖选择器部分）：`toNativeDialogPath`（**绝对化** + 盘符大写 + 反斜杠）、`listOwnedDialogs`（枚举属目标进程的可见 `#32770`）、`closeStrayDialogs`（只关自己 pid 的残留模态框）、`selectOpenDesignFolder`（**双路线**：`WM_SETTEXT` 优先、失败退回键盘输入；两条都要求**回读一致**，确认后**等对话框真的关闭**才算成功）。安全边界：只操作「本次新出现 + 属目标进程 + 类名 `#32770` + 可见 + **唯一**」的窗口，基线在点击前采样，多个新对话框直接放弃，路径只经环境变量进入脚本。
- **Open Design 运行检测（三信号）**（`src/agents/opendesign/liveness.ts`，计划 P5 核心）：停止按钮可见性 + 对话文本哈希 + **产物文件 mtime/大小指纹**；纯函数 `judgeOpenDesignPoll`，判定序为 运行信号 → 失败态 → 提问 → needs_user（停止久亮且全静止）→ 总时限 timeout → idle_timeout → finished。**产物信号是本适配器的关键差异**：Open Design 生成设计稿时会长时间不刷对话却持续写文件，只看文本会把这类正常工作判成「空闲完成」。
- **Open Design 修复/优化计划文档**（`src/agents/opendesign/fixplan.ts`，计划 P6 核心）：落**项目根** `.opendesign/plans/opendesign-fix-r<N>.md`（每轮独立、绝不覆盖），正文含未通过项、**视觉验收差异表**（目标/视口/结论/差异比例/产物路径 + 逐条失败原因）、通过项、跳过项、代码分析与修复要求；`buildOpenDesignFixPrompt` 生成「未通过说明 + 计划文档相对路径 + 证据」的返修指令。
- **Open Design 视觉验收页面来源推导**（`src/agents/opendesign/visual.ts`，计划 P6）：`findStaticEntries`（广度优先 + 深度上限 3 + 跳过 `node_modules`/`.tianshu-mcp` 等噪声，按入口文件名与层级排序）、`hasPreviewableProject`、`suggestVisualPages`（先静态入口、再工程结构，两者都不成立时 `configured:false` 并给出可操作提示）。**只推导不落盘**：绝不自动修改 `.tianshu-mcp/acceptance.json`——验收配置显式化是仓库既有原则，偷偷补配置会让验收口径变成隐藏状态；推导不出来时也不硬编码 `/index.html`。
- `run.ts` 在接管实例后先**清理属于本实例 pid 的残留 `#32770`**：模态框会吞掉主窗口合成点击，不清掉会让下一轮把「点选择目录毫无反应」误判成选择器失效；并在门禁前记录视觉页面来源建议（诊断用，不阻塞本轮）。

### 修复

- **`gui.selectors` 覆盖语义改为「权威」**（`cssCandidates`）：原实现把覆盖值与内置 fallbacks **合并**，而 fallbacks 含 `[aria-haspopup]` 这类宽泛语义候选，页面上常有多个元素命中 → 「唯一命中」判据必然失败 → **热修复选择器反而把功能彻底关掉**（表现为 `no-panel：触发器无法唯一定位`）。现在覆盖值一旦给出就**只**用它。
- `toNativeDialogPath` 对**相对路径与空路径**的处理：`path.win32.normalize("")` 会返回 `"."`，原实现会把 `.` 当有效路径送进原生对话框（表现为「确认后什么都没发生」）；现在相对路径按当前工作目录解析为绝对路径，空/空白路径返回空串由调用方 fail-closed。

### 测试

- 新增 **65** 个用例：`opendesign-workspace.test.ts` 14 个（路径比较、已绑定跳过且零点击、成功路径与**基线采样顺序**、触发器缺失/菜单项缺失/原生失败/回读不一致四条失败路径、回读空值）、`opendesign-liveness.test.ts` 20 个、`opendesign-dialog-fixplan.test.ts` 19 个、`opendesign-visual.test.ts` 12 个（静态入口发现与文件名优先级/深度上限/噪声跳过、工程结构判定、推导不出来的如实路径）；`opendesign-dom.test.ts` 补覆盖语义回归。
- 全量 **1268 passed / 12 skipped**（110 文件）；`typecheck` / `eslint src test scripts` / `build` 全绿。

## [0.6.9] - 2026-09-26

### 新增

- **Open Design 适配器阶段 P1（选择器与页面内表达式层）**：新增 `src/agents/opendesign/selectors.ts`（16 个语义键的选择器注册表 + 页面内 `resolveFnSource` + **布局守卫键集**）与 `dom.ts`（13 个页面内表达式，标记前缀 `od:`：存在性/文本/单点/首点/精确匹配/候选回显/计数/输入值/对话文本/触发区文本/布局盘点/菜单收起/方向项可见）。`run.ts` 的派活门禁由「未实现」升级为**布局守卫**：关键选择器未采集或页面锚点未命中时，硬失败 `selector_drift` 并列出缺失键，**不进任何坐标点击**。详见 [Open Design GUI（CDP）适配器](docs/opendesign-cdp.md)。

### 修复

- **`ELECTRON_RUN_AS_NODE` 导致 Open Design 完全无法启动（真机关键根因）**：`Open Design.exe` 是「内嵌 Node 的 Electron」外层启动器；调用方若带 `ELECTRON_RUN_AS_NODE=1`（DSH harness 会注入），启动器被置为 Node 模式，`--remote-debugging-port` / `--headless` 一律被拒（`bad option:`，退出码 9），表现为「无窗口、无新日志、无崩溃转储」。受管启动现在**净化环境**（新增 `OPEN_DESIGN_ENV_DENYLIST` + `sanitizedSpawnEnv()`，清 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` / `ELECTRON_ENABLE_LOGGING` / `ELECTRON_EXTRA_LAUNCH_ARGS`），命令行不变。清除后启动器立即打印 `DevTools listening on ws://127.0.0.1:9889/…`。
- **启动器「分离子进程形态」被误判为失败**：启动器接受调试端口后打印 `DevTools listening` 并**自行以 0 退出**，真正的 Electron 主进程是它 spawn 的分离子进程。首版把退出码 0 直接判成 `needs_user(close_existing_instance)`，真机表现为「明明起来了却要用户关闭旧实例」。现在从 stderr 解析宣告端口（`devtoolsPortsFromOutput()`）并在剩余预算内继续轮询；退出码 9 归为「无法接管」，其他非零才抛错并附 stderr 尾部。
- **`resolveFnSource` 只认数组 spec**：`specArgs()` 产出的是 JSON 字符串，被当成 CSS 候选去 `querySelectorAll` → **永远零命中**（静默失效）。现在两种形态都支持；同时补 `__odSpecError` 哨兵，让「表达式拼错」报 `count=-1` 而不是伪装成「页面没这个元素」。

### 变更

- 受管启动改为收集 **stderr 尾部**（新增 `guiInstanceDiagSpawnOptions()`，有界 4KB 缓冲）。原 `guiInstanceSpawnOptions()`（stdio 全忽略）保持不变、继续服务其他 GUI agent。

### 测试

- 新增 **23** 个用例（`test/unit/opendesign-dom.test.ts`）：注册表不变量（回退候选不得宽泛容器型、布局守卫不含运行期键）、`missingSelectorKeys` fail-closed 与覆盖热修复、`specArgs` 六元组契约，以及在 **linkedom 真实 DOM** 上执行全部页面内表达式（存在性/可见性、单点唯一性、精确匹配不回退模糊、候选回显、坏候选容错、布局盘点 `count=0`/`-1`、方向项精确匹配、Escape 收起）。
- `opendesign-discovery.test.ts` 增至 **28** 用例：新增环境净化（含「不改调用方 process.env」）与调试端口宣告解析（IPv4/localhost/IPv6、去重保序、噪音不误判）。
- 全量 **1202 passed / 12 skipped**（106 文件）；`typecheck`、`eslint src test scripts`、`build` 全绿。

## [0.6.8] - 2026-09-26

### 新增

- **Open Design GUI 适配器（阶段 P0：安装发现 / 实例接管 / CDP 探测）**：新增内置 agent `opendesign`（`driver=gui`、`adapter=opendesign-gui`），把 Open Design 桌面端（Electron，实测 0.24.1）纳入 tianshu-mcp 的派活闭环。本阶段交付安装探测、数据目录推导、实例复用/受管启动与 CDP 产品校验，**界面驱动（目录绑定、模型/设计系统/设计方向、输入发送、运行检测、视觉验收）留待后续阶段**；未接完界面时派活会**硬失败 `not_implemented`** 并列出缺失的选择器键，而不是假装成功。详见 [Open Design GUI（CDP）适配器](docs/opendesign-cdp.md)。
- **只读诊断探针 `scripts/probe-opendesign.mjs`**：`install` / `process` / `cdp` / `appconfig` / `anchors` 五个子命令，与既有 `probe-kimicode.mjs` 同构；默认只读（不点击、不输入、不发送），仅显式 `--launch` 才启动实例。`npm run probe:opendesign` 可用。

### 变更

- **新增 `designDirection` 参数**（`run_task`，仅 Open Design 生效）：只支持「原型 / 文档 / 网站复刻」（`prototype` / `document` / `clone`），UI 里的「幻灯片 / 图片 / HyperFrames」**显式拒绝**；非法取值在**入口**即拒绝，不进 GUI。刻意不复用 `mode`（后者是 TraeWork 的面板模式）。
- `designSystem` 参数补充 Open Design 语义：此处传**设计系统名**（如 `Claude`），由适配器在设计系统面板搜索并点选。

### 真机取证（Windows 10 19045 / Open Design 0.24.1）

- 本产品有**进程级单实例锁**，且主进程**强制** `app.setPath("userData", …)`——`--user-data-dir` 开关会被覆盖，因此不做「专属 userData 受管实例」；策略为**复用优先 → 自管启动 → `needs_user(close_existing_instance)` 请用户关闭**，绝不 kill 用户进程。
- 本产品的 daemon / web sidecar 也以同一可执行文件启动（argv 带 `*.mjs` 脚本），实测 11 个同名进程里只有 1 个真·桌面主进程；根进程判定必须剔除 sidecar，否则用户关窗后受管实例**永远起不来**。
- CDP 基准端口原计划 9777，实测**已被 Qoder CN 占用**（区段 9777-9796）→ 改为 **9889**（区段 9889-9898）。
- 版本门禁判据必须是**产品版本**（安装目录 `resources/open-design-config.json` 的 `appVersion`）；CDP `/json/version` 的 `Browser` 是 **Electron 版本**，误用会阻断全部派发（已加回归测试）。

### 测试

- 新增 **34** 个用例（2 文件）：安装发现（固定盘相对路径 / 注册表回退 / 显式路径权威性 / 版本与命名空间读取 / 脏数据不误判）、进程枚举与根进程过滤（含 sidecar 实测形态）、CDP 产品校验（拒绝异种 Electron）、版本门禁、设计方向归一与菜单候选精确匹配。全量 **1173 passed / 12 skipped**（105 文件）。新增用例**不依赖本机安装 Open Design**（全部走注入与临时目录）。

## [0.6.7] - 2026-09-24

### 新增

- **任务终态 webhook 通知**（[issue #22](https://github.com/lanlan0811/tianshu-mcp/issues/22)）：任务完成 / 失败 / 进入 `needs_attention` 时向配置的 URL **异步 POST** 一条 JSON，降低长任务盯屏成本。详见 [任务终态通知](docs/notifications.md)。
- **全局 `config.json` 新增 `notifications.webhook`**：`enabled`（默认 false）/ `url` / `timeoutMs` / `maxRetries` / `backoffMs` / `secret`（HMAC-SHA256 签名）/ `events`。
- **`src/tasks/notifier.ts`**：`TaskNotifier`（fire-and-forget、重试 + 退避 + 超时、失败仅告警）与 `statusToEvent()` 映射。

### 变更

- `TaskStore` 构造函数新增**可选**第三参 `notifier`；终态通知在 `updateStatus` 写闭包内 `appendEvent` + `writeSnapshot` **成功之后**派发。既有 `new TaskStore(home, logger)` 调用完全不受影响。
- `src/server.ts` 装配 `TaskNotifier`（惰性读取同一份 `config.json`，故运行中改配置也能生效）。

### 兼容性

- **默认关闭**：不配置或 `enabled:false` 时**完全不发起任何请求**，行为与 v0.6.6 一致。
- **无工具契约、数据模型或 MCP 注解变更**；仅新增一个**可选**的 config 段。

### 说明（如实披露）

- **钩子点是 `TaskStore.updateStatus()`**（状态跃迁的唯一咽喉），**不是** `TaskOrchestrator.finish()` —— 后者只覆盖编排器主导的结束，`cancel()` 的 queued 分支、`initialize()` 的重启归档、`shutdownInterrupt()` / `persistInterrupted()` 全都绕过它。
- **「恰好一次」按 `taskId + status + finishedAt` 去重，不能用 `prev !== status`**：多条路径会**先直接改写 `meta.status`** 再调用 `updateStatus`，那时 `prev` 已等于目标状态。`finishedAt` 由 `updateStatus` 在写终态时刷新、并被 `rework`/`continueTask` 清空 —— 故同回合重复写入被抑制，而**返修后的新回合会再次通知**。跨 server 重启或接收端重试仍可能重复送达，建议接收端按同一键幂等。
- **默认只推真终态**：`needs_attention`（终态）→ `needs_human`；`needs_user`（**非终态**，可被 `continue_task` 恢复、之后可能再次进入）单独成类且**默认不订阅**，需要它的调用方须显式加入 `events`（已知会反复推送）。`cancelled` 同样默认关闭。
- **尽力投递，不保证送达**：发送全异步，端点慢或挂掉**不阻塞状态机**；失败（网络错误 / 超时 / 非 2xx）重试 `maxRetries` 次后仅记一条 `warn`，**绝不改变任务终态**。
- **请求体含本地路径**：包含 `projectPath` 与验收报告文件的绝对路径；转发到公网服务前请确认接收端可信。
- **`enabled=true` 但缺 `url` 会被 schema 拒绝**（禁止「开了却不发」的静默混淆）；`config.json` 走 last-known-good，写坏只告警并沿用上一份有效配置。

## [0.6.6] - 2026-09-24

### 新增

- **`run_task` 干跑模式 `dryRun`**（[issue #21](https://github.com/lanlan0811/tianshu-mcp/issues/21)）：agent 只分析规划、输出将要修改的文件清单与方案、**不动源码**；验收引擎只做静态分析（引用文件是否存在、拟改位置是否存在、明显逻辑冲突），跳过 typecheck/test/build。详见 [dryRun 干跑模式](docs/dry-run.md)。
- **`src/verify/dry-run.ts`**：计划 schema（`path` / `action` / `reason` / `edits`）、静态检查、报告与方案文档渲染。
- **「先审后做」闭环**：dryRun 产出的方案文档落在**项目内** `.tianshu-mcp/dry-run-plan-<taskId>.md`，`meta.dryRunPlanDoc` 给出项目相对路径，可直接作为后续正式 `run_task` 的 `planDoc`。

### 变更

- **`TaskMeta` 新增 `dryRun` / `dryRunReportMd` / `dryRunReportJson` / `dryRunPlanMd`**；`metaFromTask` 暴露 `dryRun` / `dryRunReportFiles` / `dryRunPlanDoc`。
- 报告产物**严格分离**：dryRun 写 `dry-run-report-<round>.md` / `.json`（json 带 `kind: "dry-run"`），**不碰** `report-<round>.*`，因此不消耗验收轮次、也不污染常规报告列表。

### 兼容性

- **`dryRun` 是新增可选参数，默认关闭**：不传时 `run_task` 行为与 v0.6.5 完全一致。
- 无工具契约、数据模型破坏性变更；MCP 注解不变。

### 说明（如实披露）

- **判定为 `needs_attention` 而非 `failed`**：方案有问题属人工裁决，不是可以自动返修的代码缺陷；dryRun **不进入返修循环**、**忽略 `autoVerify`**、**需要 `projectPath`**（无项目模式显式拒绝）。
- **计划缺失时降级但可见**：`planExtracted: false` + `fallbackReason` 写明原因，检查降级为仅零改动门禁；报告与文案都如实标注「计划提取: 失败」，不静默通过。
- **零改动门禁是核心证据**：相对动工前基线求差，排除 MCP 自有产物（计划文件、任务书点名的 planDoc）后仍有变更 → `dry_run_violation`（阻断）。它**不依赖计划写对** —— agent 完全不产出计划时这条仍然有效。
- **不保证 agent 遵守只读约束**：靠任务书里的明确指令 + 事后门禁。**违反会被拦下并如实报告，但已发生的改动不会自动回滚**（MCP 从不自动 commit / stash / checkout）。
- **静态检查无法判断方案是否合理**：只能验证「文件存在、位置对得上、无明显矛盾」——那正是「先审」要人工做的事。
- **`planDoc` 的适配器差异**：目前只由 **Codex 与 Qoder CN** 的提示词构造消费；CLI 类 agent 与 ZCode / Kimi Code / TraeWork 不读取它，对这些 agent 需把方案路径写进 `task` 文本（文件在项目内，它们能读）。这一点已写入 `docs/dry-run` 双语与 README。

## [0.6.5] - 2026-09-24

### 新增

- **验收配置三级继承**（[issue #20](https://github.com/lanlan0811/tianshu-mcp/issues/20)）：`<数据目录>/acceptance.default.json`（全局兜底）→ `<project>/.tianshu-mcp/acceptance.json`（项目覆盖）→ 任务级临时覆盖。一个宿主下挂多个同类项目时，公共策略写全局层即可，不必逐项目建文件。详见 [验收配置规范](docs/acceptance-config.md)。
- **`run_task` / `verify_task` 新增可选 `acceptanceOverride`**：任务级临时验收配置覆盖（格式同 `acceptance.json`），**仅当次生效**、随任务快照保存、不写入任何 `acceptance*.json`、不影响同项目其他任务。无项目模式显式拒绝该参数。
- **`tianshu-mcp config acceptance [projectPath] [--task <taskId>]` 调试命令**：打印各层是否存在、实际生效顺序与最终取值，排障无需靠猜。每轮验收另往 `server.log` 写一行同源摘要。
- 新增 `src/config/acceptance-merge.ts`（按用途收敛的合并工具，**刻意不做通用深合并**）。

### 修复

- **分层解析的 `.default()` 污染隐患**：`AcceptanceConfigSchema` 的 `requireChanges` 带 `.default(true)`，若用它解析「只写了 `verifyConcurrency`」的项目文件会 materialize 出 `requireChanges: true`，在三级继承里**反过来覆盖全局层的 `false`**。新增无默认值的 `PartialAcceptanceConfigSchema` 供分层解析，默认值只在最终取值缺省时兜底。

### 变更

- `resolveChecks()` 改为三级合并，并把合并后的 `visual` 一并返回；`executeVerify` 不再二次读取项目文件（否则 override/全局层的 `visual` 会随项目文件是否存在而改变语义）。
- `LOCKFILE_PATTERN` 的统一导出（v0.6.4）之后，`acceptance-config` 双语优先级表按三级继承重写。

### 兼容性

- **无工具契约、数据模型或 MCP 注解变更**（`acceptanceOverride` 是新增可选参数；`extraChecks` 语义与优先级不变，仍高于基础集）。
- 不创建全局 `acceptance.default.json` 时，单项目行为与 v0.6.4 完全一致（全局层缺失 = 空配置、不报错）。
- 项目级 `.tianshu-mcp/acceptance.json` 的既有语义不变；错误语义仍是 fail-closed（仅 `ENOENT` 视为「该层不存在」）。

### 说明（如实披露）

- **合并粒度是「字段」**：高优先级层显式书写的字段整体取胜；**数组（`checks`）整体覆盖而非拼接** —— 拼接会让「项目追加一项检查」变成「项目无法移除全局检查」。
- **`visual` 整体覆盖、不做跨层深合并**：`visual` 的 schema 几乎每个字段都带默认值，深合并会让低优先级层的**显式**取值被高优先级层「未书写、仅因默认值而出现」的字段静默覆盖（与 `requireChanges` 同类的污染）。需要跨层复用视觉配置时请在项目层写完整 `visual` 段。**这是与 issue 建议的「深合并」的一处有意偏离**，理由记录在 `docs/acceptance-config.md` 与 ARCHITECTURE §7.4。
- **任务级覆盖计入幂等入参摘要**：同键换一套验收策略会被 fail-closed 拒绝，而不是返回策略不同的旧任务。

## [0.6.4] - 2026-09-24

### 新增

- **结构化修复指令 `repairDirectives`**（[issue #19](https://github.com/lanlan0811/tianshu-mcp/issues/19)）：失败轮次把验收失败原因解析为**可直接执行的动作**（`file? / line? / issue / action / source`），随返修计划、返修消息一起喂给 agent，省去它从整篇报告里定位「哪一行类型不匹配、哪个文件有 TODO」的开销。详见 [结构化修复指令](docs/repair-directives.md)。
- **两个内置提取来源**：`typecheck`（解析失败类型检查项输出尾部的 tsc pretty / plain 两式报错，绝对路径归一化为项目相对 posix 路径，同处报错去重）与 `diffstat`（超大单文件改动、被改动的锁文件、TODO / 调试输出 / 疑似密钥的行级计数）。
- **`rework_task` 新增可选 `repairHint`**（自由字符串，上限 4000 字符）：调用方自带结构化修复提示，在下一轮任务书的 `【结构化修复提示】` 块中**排在 `feedback` 之前**。

### 变更

- **`report-<round>.md` 新增 `## 结构化修复指令` 小节**；`report-<round>.json` 新增 `repairDirectives` 字段（**仅失败轮次**）。
- **两块返修计划（通用 `rework-*.md` 与 Codex `codex-fix-r*.md`）新增 `## 2.5 结构化修复指令` 小节**，位于第 2 节（失败项）与第 3 节（通过项）之间。
- `LOCKFILE_PATTERN` 由 `code-analysis.ts` 导出，供分析告警与提取器**共用一份清单**，避免两处漂移。

### 兼容性

- **无工具契约、数据模型或 MCP 注解变更**。`repairDirectives` 是报告内的新增可选字段，读取方按缺省忽略即可；`repairHint` 不传时 `rework_task` 行为与 v0.6.3 完全一致。
- 提取**只在验收失败的轮次**执行；通过的轮次不产出该字段（不徒增报告体积）。

### 说明（如实披露）

- **提取不到时显式回退**：`fallbackReason` 非空 ⇒ 渲染方写明「不可用，回退完整报告」并要求 agent 回到完整失败输出，**不允许静默留空**。单个来源抛错会被吞掉并记入原因，其余来源继续工作 —— 提取器永不抛错。
- **测试类失败不做提取**：测试框架输出没有稳定的文件/行号，强行解析会产出**错误**定位，比不给更糟。
- **`diffstat` 的行级信号不伪造位置**：`signals.ts` 只做计数、无稳定文件与行号，故对应指令省略 `file` 字段。
- **已知限制**：`outputTail` 被截断到最后 4000 字符，大型项目只能提取到尾部类型错误，其余靠回退兜底 —— 有意接受的取舍。

## [0.6.3] - 2026-09-24

### 新增

- **细粒度事件流**（[issue #18](https://github.com/lanlan0811/tianshu-mcp/issues/18)）：适配器可在关键节点主动上报语义事件，`query_task` 回传最近 N 条，长任务下可区分「正常执行」与「卡在弹窗等人」。词表 5 类：`task_dispatched` / `confirmation_dialog_detected` / `awaiting_user_authorization` / `file_modification_started` / `rework_triggered`。详见 [事件流文档](docs/event-stream.md)。
- **`query_task` 新增可选入参 `eventLimit`**（整数 1..50，**缺省 10**）：事件同时出现在 meta 块的 `recentEvents` 数组与文本区的「最近事件」段落。
- **两个内置 GUI 适配器落地上报**：codex 与 traework（各 4 个发射点）；`rework_triggered` 由引擎侧统一上报（自动返修 `mode:"auto"`、手动 `rework_task` `mode:"manual"`）。

### 变更

- **手动 `rework_task` 的事件由匿名 `note` 改为类型化 `rework_triggered`**（`task.jsonl` 可见）。既有 `note` 事件的语义与用途不变，`progressSummary` / `lastRunSignal` 仍由 `note` 承载。
- **`TaskEventName` 联合类型新增 5 个成员**，与 `AGENT_EVENT_NAMES` 同源（避免两处词表漂移）。

### 兼容性

- **无工具契约、数据模型或 MCP 注解变更**。`recentEvents` 是新增可选字段：未实现事件上报的适配器（含全部 CLI 适配器）返回空数组、文本区不出现事件段落，**其余字段与 v0.6.2 完全一致**。
- 事件写入既有的 `task.jsonl`（**不新建并行事件文件**）；读取侧只读尾部 64 KiB 窗口，内存占用与文件总大小解耦。

### 说明（如实披露）

- **`file_modification_started` 是启发式推断**：codex / traework 适配器并不直接观测文件系统，只能从界面「运行中」信号（停止按钮）推断执行已开始。其 detail 一律写「停止按钮出现，开始执行（可能开始改动文件）」，**不声称文件确已改动**；确切的文件改动证据请看验收报告的 `changedFiles` / `diffstat`。
- **事件上报是可选能力**：钩子挂在 `AgentRunOptions.onEvent` 而非 agent profile（`agent-profiles.json` 是纯 JSON，装不下函数）；未实现的适配器一个字节都不用改。适配器侧统一经 `makeEmitter` 上报 —— 未提供钩子时空操作，且吞掉上报异常，**上报失败绝不影响任务本体**。
- **事件不保证送达**：属观测能力而非交付保证；`query_task` 只反映「最后一次落盘的事件」。

## [0.6.2] - 2026-09-23

### 修复

- **Codex 项目选择触发器文案跨版本漂移**（[issue #23](https://github.com/lanlan0811/tianshu-mcp/issues/23) 例 1）：触发器 `aria-label` 在部分版本为「选择项目：<名>」、部分（本机实测 26.915）仍为「切换项目：<名>」。`projectPickerTrigger` 主/回退/模板并列覆盖两文案（含英文 `Select/Switch project`），`boundProjectName` 的项目名回读同步兼容。**并完成全量 20 键真机审计**（`node scripts/probe-codex.mjs --launch audit`）：本机 26.915 除该触发器外无其他漂移，9 个已实测键的 `verifiedVersion` 提升为 `26.915.x`。
- **Qoder 工作区绑定在 0.3.4 失败**（issue #23 例 2）：真机重探**更正了 issue 的结论**——0.3.4 工作区菜单**并非不渲染**，真因是页面存在**两个** `[data-workspace-picker-trigger]`，旧 `click()` 要求唯一命中而判歧义失败。工作区触发器主选择器改用唯一的 `button[aria-label^="切换或清空当前工作区"]`（`[data-workspace-picker-trigger]` 降为回退）；「菜单已打开」判定放宽为「搜索框 **或** 浮层」。生产 `bindWorkspace` 已在真实 Qoder 0.3.4 上跑通。
- **TraeWork 安装发现失败**（issue #23 例 3）：新增 `src/agents/traework/discovery.ts`（固定盘枚举 + 注册表 `InstallLocation` + 相对路径），`registry.ts` 增 `traework-gui` 专用分支。修正内置 profile——删除错误的 `{APPDATA}/TRAE SOLO CN`（实测该目录是**用户数据目录**：Cache/Crashpad/嵌套工具 exe，非安装位置），改为 `{LOCALAPPDATA}/Programs/TRAE SOLO CN` 等，并补 `preferredDrives`/`relativePaths`。**Windows 文件名收窄为只认 `TRAE SOLO CN.exe`**（旧清单含 `Trae CN`，会误匹配另一产品 TraeCode CN）。`waitReady` 超时新增现场诊断（子进程退出码、端口监听者枚举、既有未带调试端口实例检测），**只诊断、不改启动策略、不终止既有实例**。

### 新增

- **三 GUI agent 统一的选择器诊断**（`src/agents/gui-diagnostics.ts`）：选择器解析失败时把页面可见候选标签（最接近的 aria-label / 短文本）写进错误与日志，使用者一步定位漂移，无需人工开 CDP。已接入 codex / qoder / traework。
- **Codex 全键审计模式** `scripts/probe-codex.mjs --launch audit`：对全部 20 个语义键输出 primary 命中数与命中标签，作为「脚本 + 证据表」门禁。
- **Qoder 选择器分层结构**：`src/agents/qoder/selectors.ts` 由扁平字符串升级为 `primary/fallbacks/texts/ariaLabels/ariaPatterns/verifiedVersion`（27 键）；`QoderCdpClient.selector()` 保留字符串语义，另增 `candidates()/existsKey()/clickKey()`。
- **TraeWork 选择器版本字段统一**：`verified: boolean` → `verifiedVersion: string`（与 codex/kimicode 一致）。

### 文档

- 新增 [issue #23 验证记录](docs/issue-23-selector-drift-record.md)（含 20 键审计表、Qoder 0.3.4 重探、TraeWork discovery 真机结果）；发布说明 [v0.6.2](docs/release-v0.6.2.md)。

## [0.6.1] - 2026-09-23

### 新增

- **危险目录判定收敛为可注入平台的纯函数** `isDangerousProjectDir(norm, platform)`（`src/util/path.ts`）：精确根 / 盘符根 / 系统目录子树三选一判定，任意平台都能验证三平台形态。

### 变更

- **`verify_task` 的能力由 `read` 改为 `execute`**（[issue #17](https://github.com/lanlan0811/tianshu-mcp/issues/17) 问题 2）：它会执行项目配置命令、可产生构建产物，本就不是只读。**宿主需知**：其 MCP `readOnlyHint` 由 `true` 变为 **`false`**；`requireApproval` 维持 `false`（仍免审批，R11 结论不变）——**策略层请以 `_meta.requireApproval` 而非 `readOnlyHint` 判断是否需授权**，`docs/tianshu-integration` 双语的 policy 示例已同步。
- **`ToolDef.capability` 联合类型删除始终无人使用的 `"network"`**，收敛为三族语义（`read` / `write` / `execute`），并写进类型定义与 `tools.ts` 头注释。

### 修复

- **系统目录改为子树拒绝**（issue #17 问题 4）：`/etc`、`/usr`、`/bin`、`/sbin`、`/private/etc` 与 `c:/windows`、`c:/program files`、`c:/program files (x86)` 由「仅精确相等」升级为**边界感知子树拒绝**，修补了 `c:/windows/system32`、`/etc/anything` 这类漏挡。边界感知使 `c:/windows.old`、`/etcetera`、`/usrlocal` 不被误伤；`/var`、`/tmp`、`/opt`、用户主目录等维持精确匹配（macOS 的 `os.tmpdir()` 就是 `/var/folders/...`，子树拒绝会切断测试基座与合法工作区）。
- **项目登记失败不再静默**（issue #17 问题 3）：`run_task` 原先丢弃 `registerProject` 的返回值（`void registered;`）又用 `projectByPath` 二次读取同一条记录；现直接消费返回值、删除冗余读取，登记失败时记 `WARN` 并返回结构化 `isError` 且**不派单**（杜绝「任务已建、项目未登记」的半状态）。
- **计数与实际不符收尾**（issue #17 问题 1）：改正 `test/protocol/protocol.test.ts` 头注释残留的「9 个工具」，并新增 `TOOL_DEFS` 数量硬断言；`ci.yml` 注释、`HANDOFF`（两处）与 `CONTRIBUTING` 双语滞后的「6 场景」同步为 **8**（issue #16 新增两技能场景后未同步）。

### 文档

- **`cmd` 字符串形态的坑显式化**（issue #17 问题 5，零行为变更）：`docs/acceptance-config.md` / `.en.md` 新增实测表（无转义、引号不闭合不报错、空引号产出空参数），`schema.ts` / `store.ts` 注释、`SKILL.md`、`usage-examples.md` 补「推荐一律用数组形态」提示。
- 双语：README（`verify_task` 能力列 + M31 里程碑）、ARCHITECTURE（工具表三族语义 + `readOnlyHint` 推导规则 + §15 两条新缺口）、SECURITY（§3 危险目录匹配语义 + §5 措辞改准）、`docs/tianshu-integration`、`docs/acceptance-config`；单语：HANDOFF、`SKILL.md`、`usage-examples.md`；新增 `docs/issue-17-small-fixes-record.md`（实测证据）。

### 测试

- 全量 **940 passed / 12 skipped**（Windows 10 x64，Node 24.18.0），较 v0.6.0 的 898 净增 **42** 项：`project-dir-guard` 新增 `isDangerousProjectDir` 三平台表驱动用例（含 `c:/windows.old`、`/etcetera`、`/private/var/folders/...` 三个关键反例）与 win32 子树集成用例；`protocol` 新增 11 工具 × capability × 四注解**真值表**与数量硬断言；`zcode-handler` 新增登记失败不派单、返回值被消费（断言 `projectByPath` 调用计数为 0）；`core` 新增 `splitCmd` 边界语义锁定。
- 严格 stdio 门禁 dist 与 src 两条入口各 **8/8**；`pack:check` 通过（232 文件）。

## [0.6.0] - 2026-09-23

### 新增

- **技能自检安装的三态与放行入口**（[issue #16](https://github.com/lanlan0811/tianshu-mcp/issues/16)）：
  - `skills.autoInstall` 由布尔升级为 `true | "prompt" | false`（既有 `true`/`false` 继续合法，无需迁移）。`"prompt"` 语义为**首次安装照常、需变更时不自动覆盖**（只告警并在清单记 `pendingUpdate`）——stdio server 无同步交互通道，故「prompt」实为「不自动 + 留待确认」。
  - 新增启动参数 `--approve-skill-update`（等价环境变量 `TIANSHU_MCP_APPROVE_SKILL_UPDATE=1`）：本次启动允许把「需变更」的技能目录覆盖为包内版本（先备份）。**对已确证含用户本地修改的目录不生效**；`--no-skill-install` / `autoInstall:false` 的否决权高于本参数。
  - 新增 `skills.backupKeep`（默认 3，范围 0..50，`0` = 不清理）：覆盖成功后按时间戳保留最新 N 个 `.bak-<时间戳>` 目录，删除项记日志。
- 安装清单 `<目标>/.tianshu-mcp-install.json`（`schema`/`name`/`packageVersion`/`contentHash`/`installedAt`/`sourceDir`，保留时含 `pendingUpdate`），用于区分「未改动的旧版包副本」与「用户本地修改」——此前两者在原理上不可区分。

### 修复

- **技能源不再从当前工作目录发现内容**（issue #16 问题 1）：`resolveSkillSourceDir()` 只由 `import.meta.url` 相对包自身定位，**删除两处 `process.cwd()` 候选**及一条永不命中的宽松候选；找不到源时沿用既有「跳过安装 + 告警」路径。此前在某个自带 `skills/tianshu-mcp/` 的第三方仓库目录里调试起 server，会把该仓库内容安装进 `~/.rivet/skills/` 并在新会话生效。
- **技能覆盖不再静默替换用户本地修改**（issue #16 问题 2）：检测到目标内容与清单记录不符（= 用户改过）或来源不明（无有效清单）时**保留现有内容并告警**（附「改名/删除后重启」与「手工合并」两条处置指引），仅在内容可证未被改动或显式放行时才覆盖。
- **安装不再可能留下半成品**：改为「拷贝到 `<目标>.incoming-<ts>-<hex>`（含写清单）→ 旧目录备份为 `<目标>.bak-<ts>` → 换入」的原子路径，失败回滚并清理临时目录；启动时清理 mtime 早于 1 小时的 `.incoming-*` 崩溃残留。此前「先 rename 旧目录、再直接往目标拷贝」的崩溃窗口会留下半拷贝目录，在新语义下会被误判为「用户修改」而永久阻塞升级。
- **覆盖相关日志分级修正**：旧版覆盖 / 保留用户修改 / 来源不明 / 安装失败一律 `WARN`（此前备份与安装均为 `INFO`，容易被日志淹没）；跳过与清单补写保持 `INFO`。hash 只打印前 8 位，完整值落在清单文件。

### 测试

- 新增单元用例 `test/unit/skill-install.test.ts`（30 项）：源定位三态（含「cwd 下同名诱饵不影响源」回归与「源码不再出现 `process.cwd()`」文本断言）、hash 排除规则（清单自身与 `.DS_Store`/`Thumbs.db`/`desktop.ini`/`._*`/`.git*`）、清单解析（缺失/非法 JSON/schema·name·hash 不合法 → corrupt）、判定矩阵 6 态 × 模式 × 放行的表驱动覆盖、真实文件系统端到端（首次/幂等/清单自愈/可信旧版覆盖/用户修改保留且无备份/`prompt` 保留与 `pendingUpdate`/放行覆盖/失败回滚/备份收敛/非匹配项不删/残留临时目录清理/日志分级/源缺失）、以真实 `skills/tianshu-mcp` 为源的冒烟。
- `test/unit/config-hotreload.test.ts` 补 `skills.autoInstall` 三态与 `skills.backupKeep` 的默认值/覆盖/非法值 last-known-good 用例。
- 严格 stdio 门禁新增两个独立场景（6→8）：`skill-locally-modified`（种子预置「含本地修改」目录 → 断言不覆盖、无备份、无安装日志）、`skill-approve-update`（种子预置「来源不明」目录 + 传参 → 断言覆盖为包内版本、生成备份、写入清单）；新增 dev-only 夹具 `scripts/seed-skill-state.mjs`（登记为 `npm run seed:skill-state`，不进 npm 包）。
- 全量 **898 passed / 12 skipped**（Windows 10 x64，Node 24.18.0），较 v0.5.10 净增 33 项用例。

### 文档

- 新增 `docs/release-v0.6.0.md` / `.en.md`、`docs/issue-16-skill-install-hardening-record.md`（Windows 10 真机复验 R1–R7 原始证据与未覆盖项）。
- README 双语新增「技能自检安装」小节（源定位、清单与三类判定、`autoInstall` 三态表、放行/关闭参数）并补 M30 里程碑；ARCHITECTURE 双语新增 §3.4「技能自检安装的信任与判定模型」（判定矩阵、原子性、日志分级、备份治理）并把技能边界列入安全红线；SECURITY 双语新增「技能自检安装的供应链边界」；`docs/agent-profiles.md` / `.en.md` 更新 `skills` 配置说明；HANDOFF 同步版本快照与文件表。

## [0.5.10] - 2026-09-23

### 新增

- **`run_task` / `verify_task` 幂等键 `idempotencyKey`**（[issue #15](https://github.com/lanlan0811/tianshu-mcp/issues/15)）：宿主在 `tools/call` 超时后重试不再变成「重复派单 / 重复验收」。
  - `run_task`：TTL（默认 24h）内同键同参重复提交**恒返回原 `taskId` 与当前 meta**（含终态任务，只读不重派）；同键异参 fail-closed 报错并回报原 `taskId`。
  - `verify_task`：同键验收**执行中**返回成功结果 + `idempotencyReplay: "in_progress"`（刻意不是 `isError`，避免宿主再重试放大）；**已完成**直接返回既有报告路径与该轮 `reportRound` / 结论，**不重跑**检查。
  - 两个工具各自独立命名空间；键为 trim 后 1..128 字符、不含控制字符（协议级校验，非法即 `参数不合法`）。
- 新数据文件 `<数据目录>/idempotency.json`（原子写、惰性加载、TTL + 容量裁剪），进程重启后仍能识别重试；`TaskMeta` 新增 `idempotencyKey` / `idempotencyScope` / `idempotencyDigest` 供审计与映射文件损坏时重建。
- 新配置 `config.json` → `idempotency.ttlMs`（默认 `86400000`）、`idempotency.maxEntries`（默认 `2000`，超限按 `createdAt` 逐出最旧）。
- meta 块新增 `idempotencyKey`、`idempotencyReplay`（`hit` / `in_progress`）与 `projectActiveTask`；`tools/list` 的 `annotations.idempotentHint` 对两个工具置 `true`（**前提是调用方传入 `idempotencyKey`**，工具描述与技能文档已写明）。
- **重复派单降级保险**：未传幂等键时，`run_task` 仍会点名同工作区未结束的任务（活动态 + `needs_user`），提示改用幂等键或先 `query_task` 复核。

### 修复

- 幂等命中时向原任务事件流追加审计 `note`（`幂等重放：keyDigest=…`）；键**明文不入日志与事件流**（只用 sha256 前 8 位摘要）。
- `verify_task` 独立路径记录 id 由 `vfy_<Date.now()>` 改为既有的 `genVerifyId()`（`vfy_<时间戳>_<随机6位>`，此前该函数全仓无调用方），同毫秒并发不再可能撞 id。
- **崩溃窗口**：幂等路径在同一临界区内**先落映射、再建任务**（`runExclusive` 串行化同键并发）；崩溃于两者之间时，重试看到「有映射无任务快照」即视为未生效并重新派发，不会留下两条 agent 队列。
- **写失败 fail-open**：映射落盘失败仍返回已派发的任务，并在响应与 meta 明示「幂等记录写入失败，本任务无法被同键重放」，绝不把已经跑起来的 agent 报成派发失败。

### 测试

- 新增单元用例 `test/unit/idempotency.test.ts`（16 项）：键规范、`canonicalDigest` 稳定序列化、TTL 过期、容量逐出、跨实例恢复、损坏重建、`runExclusive` 串行化与失败不阻断、在途标记、写失败 fail-open。
- 新增集成用例 `test/integration/idempotency.test.ts`（8 项）：同键重放只产生一个 `tsk_*` 目录、同键异参 fail-closed、终态照实重放、未传 key 零回归、`projectActiveTask` 提示、独立路径已完成重放不新增报告、**执行中重放为成功结果**、taskId 模式重放、**跨 server 重启**的派单与验收重放。
- 协议用例补 `idempotentHint` 断言（仅两个工具为 true）；`config-hotreload` 补 `idempotency.ttlMs` / `maxEntries` 默认值与覆盖。
- 类型检查、lint（`--max-warnings 0`）、全量测试、构建、严格 stdio 检查（6/6）、`pack:check` 全部通过。

### 文档

- 新增 `docs/release-v0.5.10.md` / `.en.md`；README 双语补幂等重试条目、工具表与里程碑；ARCHITECTURE 双语补数据文件、配置项与注解说明；`skills/tianshu-mcp/` 补参数速查、meta 字段、错误码与纪律；HANDOFF 同步版本快照。

## [0.5.9] - 2026-09-23

### 修复

- **server 退出 / 重启归档路径的 GUI 终态不再谎报已停止**（[issue #14](https://github.com/lanlan0811/tianshu-mcp/issues/14)）：GUI agent 是外部桌面应用，server 对其进程**没有所有权**，abort 后适配器至多"尽力点击界面停止"，旧实现统一写「server 退出，进程已终止」是把只对 spawn 子进程成立的断言套到了 GUI 上——编排器已死、GUI 可能仍在改用户项目、且无人观察。
  - `persistInterrupted()` 按 `driver` 分流：spawn 类维持原文案；GUI 类按适配器回报的 `guiStop` 如实落「已确认 … 内运行停止」/「未确认停止，窗口中的任务可能仍在继续，请人工打开 … 确认无残留运行」/「无停止结果可确认」（ZCode、TraeWork 不点停止、不回传 `guiStop`）。
  - `shutdownInterrupt()` 为 GUI 任务提供**全局共享**的 `guiStopWaitMs` 预算（新配置，默认 15000，`config.json` 可覆盖），让"尽力停止 + 有界等待"跑完再落终态；spawn 类保持原 2s 预算。到期未确认时如实标注。
  - `initialize()` 归档重启遗留任务时，GUI 类追加「未确认停止 + 请人工检查」并置 `guiResidualUnconfirmed`；profile 不可读时保守按 GUI 处理。
  - `abortTerminal()`（shutdown 竞态中的另一写方）两个分支都落 `guiStop` 与结构化字段；窗口名改由 `profile.displayName` 派生（旧实现把 zcode/qoder 一律写成 "Codex"，本身即失真）；`runRes.guiStop` 改为对所有 agent 落盘（此前只写 qoder，其余 GUI agent 的停止结果在 shutdown 竞态里丢失）。

### 新增

- `TaskMeta` 新增结构化字段 `interruptedCleanStop`（是否**已确认**停止）与 `guiResidualUnconfirmed`（重启归档的待人工确认标记）；`query_task` / `list_tasks` 的 meta 块新增 `guiStopUnconfirmed`，编排方据此禁止直接重派。
- 人工确认路径（**不新增工具**）：对已终态的 GUI 任务调用 `cancel_task`，可清除 `guiResidualUnconfirmed` 并追加 `gui_residual_acknowledged` 事件，**不改终态与 errorType**。
- 新配置 `config.json` → `shutdown.guiStopWaitMs`（默认 15000）：server 关闭时 GUI 停止等待的全局上限，与 `gui.cancelWaitMs`（取消路径）解耦。

### 测试

- 新增单元用例 `test/unit/gui-stop-disclosure.test.ts`（三态披露判定、窗口名派生与"剥空退回原名"、任何输入都不得出现「进程已终止」）。
- 新增集成用例 `test/integration/gui-shutdown-interrupt.test.ts`（shutdown 的 `idle=true`/`idle=false`/无停止结果三条路径、重启归档 + `cancel_task` 确认清除、spawn 类不受 GUI 分流影响）。
- `config-hotreload` 补 `guiStopWaitMs` 默认值与覆盖用例；`codex-flow` 的运行中取消用例同步为结构化断言。

## [0.5.8] - 2026-09-23

### 变更

- **四份主文档按代码逐项核对重写**（README 双语 / HANDOFF / ARCHITECTURE 双语），核对范围覆盖 `src/mcp/`、`src/tasks/`、`src/loop/`、`src/agents/`（五个 GUI 适配器全部）、`src/verify/`、`src/visual/`、`src/config/`、`src/util/`：
  - **验收阶段顺序修正**：内置 `git-diff-check` 在配置的检查项**之前**执行，视觉检查在命令检查**之后**执行（旧文档写反）。
  - **`visual.enabled=false` 的真实边界**：快照冻结与完整性核对**恒定执行**，与 `enabled` 无关；`enabled` 只决定是否真的跑截图/规格/内容判定（这正是检出「验收配置或基准被改」的机制）。
  - **工具返回契约修正**：`prepare_visual_baseline` / `approve_visual_baseline` 的成功结果同样不带 meta 块，任何工具的错误结果也不带（旧文档称仅 `get_task_report` 例外）。
  - **五份 agent 表补齐 Qoder CN**：agent 列表、driver 列表、`endReason` 表、`needsUserKind` 表、取消能力表、registry 特殊探测分支、GUI 实例生命周期、测试分层说明全部由「四个 driver」更正为「五个」，并把 Qoder CN 执行顺序与完成判定写入架构文档。
  - **`endReason` / `needsUserKind` 逐值核对**：补 Kimi Code 的 `system_permission` / `setup_recovery`；注明 Qoder CN 是唯一能产出全部 6 种 kind 的适配器且**不产出 `idle_timeout`**（静止而无本轮完成证据 → `needs_user(setup_recovery)`）；注明 Codex 因 `needsClose` 从不返回 true 而没有 `close_existing_instance` 路径；注明 ZCode 与 TraeWork 不点界面停止按钮也不回传 `guiStop`。
  - **取消语义**改为按适配器能力分列；**检查点**明确 `qoder-session.json` 是唯一持久化检查点（含四个 phase 的读写点），其余为内存态判断。
  - 修正 **Kimi Code 档位取值域**（README 首页示例与里程碑文字由 `Low`/`High`/`Max` 改为 `低/low`、`高/high`、`max`、`on`、`off`）、**测试基线**（776 项/73 文件 → 826 passed / 12 skipped、81 文件，并给出单元 54 / 集成 26 / 协议 1 的构成）、**运行时依赖许可表**（补 Apache-2.0 与 ISC 项，纠正「均为 MIT」）。
  - 架构文档新增「声明了但当前无消费方」的 profile 字段提示框（`gui.windowMode`、`gui.modelRequired`、ZCode 的 `gui.stallTimeoutMs` / `gui.cancelWaitMs`），并把已知缺口更新为两条真实技术债。

### 修复

- **分发缺口**：`scripts/probe-traework.mjs` 此前不在 `package.json` 的 `files` 中，而文档要求用户运行该探针——npm 包内拿不到该脚本。现已纳入分发，并补齐 `probe:traework` / `probe:zcode` / `probe:codex` 三个 npm script（此前只有 `probe:kimicode` / `probe:qoder`，而对应脚本早已随包发布）。
- **源码注释与描述**：`src/mcp/handlers.ts`、`src/server.ts` 头注「9 个工具」更正为 11；MCP `instructions` 补 `kimicode` / `qoder`；`src/agents/gui-instance.ts` 头注补全五个使用者；`src/tasks/task.ts` 修正贴在 Qoder 字段上的 Kimi Code 注释并注明 `qoderTurnId` 无写入方。**均无运行时行为变更。**

### 测试

- 全量 **826 passed / 12 skipped**（Windows 10 x64，Node 24.18.0）；类型检查与 lint 通过；`npm pack`（231 文件）核验包含五个探针脚本。
- 文档相对链接检查：四份主文档 + 技能文档共 **255 条相对链接、0 条失效**。

## [0.5.7] - 2026-09-22

### 变更

- **编排技能文档（`skills/tianshu-mcp/`）按当前代码逐项重写**（`SKILL.md` + `usage-examples.md`，server 启动时幂等同步到 `~/.rivet/skills/tianshu-mcp/`）。逐项核对了 `src/mcp/tools.ts`、`src/config/schema.ts`、`src/tasks/task.ts`、`src/tasks/task-manager.ts`、`src/loop/fix-loop.ts`、`src/mcp/formatter.ts`、`src/agents/builtin.ts` 与五个适配器的实际实现后修正偏差：
  - 新增**参数兼容矩阵**（projectPath / model / modelSource / reasoningLevel / mode / planDoc / designSystem / allowCreateProject / continue_task 九个维度 × 五个 agent），明确「传错即报错」的边界。
  - 修正 **Kimi Code 思考档位取值域**：此前写作 `Low`/`High`/`Max`，实际仅接受 `低/low`、`高/high`、`max`、`on`、`off`（刻意不含 `中`/`medium`），且档位集合按界面实际渲染标签校验、非官方模型不传时强制 `on`。
  - 修正 **`autoVerify` 默认值**（server 默认开启，此前文档未说明），补全 **`autoFixRounds` 缺省轮数**（codex 5 / zcode 2 / kimicode 2 / qoder 3 / traework 落 server 默认 0）与 `taskTimeoutMs` 的完整优先级。
  - 补齐 **qoder** 章节：`modelSource` 消歧、模型管理档位保存回读、全局偏好不还原、发送/答题检查点不重发、自动与手动返修均先落计划并回发全文、macOS 禁止派发；新增 qoder 多题续答 JSON 对象示例。
  - 新增 **`needsUserKind` × agent × `continue_task` 行为矩阵**（六类等待 × 四类 agent），此前按 agent 零散描述且未写清哪些类型只作「已处理」确认、哪些会补发完整任务书。
  - 新增 **`agentEndReason` → 终态映射表**（`task_timeout`/`idle_timeout`/`cdp_disconnected` 与其余硬失败分别落 `needs_attention` 或 `failed(spawn)`），并补 `project_not_registered`、`unsupported_platform`、`qoder_error`（含 18 个具体码）等缺失错误码。
  - 补齐 **meta 字段全表**缺失项：`qoderSessionId`、`actualModel`、`actualReasoningLevel`、`modelSource`、`guiStop`（并说明 `reasoningLevel` 是入参不回显、codex 实际等级需看面板）。
  - 明确 **`verify_task` 三种用法差异**（任务复验只更新结论字段；独立 projectPath 的 `baselineRef` 只能是 git ref；手动验收报告轮次分配）与 `prepare_visual_baseline`/`approve_visual_baseline` 的必填参数约束（UUID + 64 位十六进制摘要）。
  - 清理重复与冗余内容，改为「主文件讲方法论 + 子文件给可复制形状」的分工；中英文表述与代码实际错误文案对齐。

## [0.5.6] - 2026-09-22

### 新增

- 新增 Qoder CN GUI 适配：安装发现、完整路径工作区绑定与导入、默认/自定义模型选择、模型管理思考等级保存回读。
- 接入已有 MCP 开发、运行检测、客观验收和原会话返修流程；自动与手动返修均先保存修复计划，再发送文件名、完整路径与全文。
- 新增模型来源与实际设置报告；保留权限模式，披露全局思考偏好影响；审批不代批，提问使用专用答题控件，提交不明不重发。
- Windows 默认/自定义模型、新工作区与原会话返修真机验收通过；macOS 保持 research 并禁止派发。详见 [Qoder 操作说明](docs/qoder-cdp.md)。
- 恢复单元测试文件隔离，修复安装探测命令 mock 泄漏导致 Git 基线测试依赖执行顺序的问题；lint 排除临时探测目录。

### 测试

- 全量 **826 passed / 12 skipped**（Windows 10 x64，Node 24.18.0；78 个测试文件通过 + 3 个真实浏览器文件按设计 skip），较 v0.5.5 净增约 60 项：安装发现优先级（显式 → D 盘 → 注册表/快捷方式 → 标准目录）、错误安装路径与身份校验、中文/空格/同名路径、工作区导入与回读失败、模型跨组重名与档位不支持、保存未生效回读、发送/答题提交不明不重发、本轮绑定完成判定（旧回复与静止不触发）、原会话返修、取消与超时停止不确定、macOS 平台分支 fail-closed。
- 真实浏览器门禁用例（`TIANSHU_VISUAL_BROWSER_TEST=1`）在 Windows 10 本机维持 12/12；`npm pack` 内容校验与干净消费者安装 + 严格 stdio 检查在本机通过。
- 未覆盖项如实标注：Qoder 的取消真停、提问续答与登录/额度/网络等待分类**仅由 hermetic 集成测试覆盖**；macOS 未做真机 GUI 验证。详见 [HANDOFF §9.12](HANDOFF.md)。

### 计划中

- Qoder CN 的 macOS 真机验证矩阵（保持 `research`，未验证前禁止派发）。
- Qoder CN 取消真停 GUI、提问续答与登录/额度/网络等待分类的真机验证（当前仅 hermetic 集成测试覆盖）。

## [0.5.5] - 2026-09-20

### 新增

- **新增 Kimi Code GUI 适配（`agentId=kimicode`，第四个 GUI agent）**：Kimi Code 桌面端（Moonshot AI，实测 1.0.2）是**普通 Electron 安装**，以 `--remote-debugging-port` 注入后经 CDP 驱动，**不需要** MSIX COM 激活。
  - **双渲染进程 CDP 驱动**：模型菜单 / 思考档位 / 执行模式菜单经应用内 `browserOverlayOpenMenu()` 渲染在独立的 `Kimi Browser Overlay` 渲染进程（实测点击 `model-pill` 后主窗口 DOM 节点数不变、不产生任何菜单节点），工作区菜单与「切换模型」对话框仍在主窗口 → 客户端同时持有两个页面，并排除 `Screenshot` target。
  - **工作区绑定与导入**：以**归一化完整路径**为唯一判据（同名不同目录一律 fail-closed，绝不猜一个点），未登记的工作区经原生「添加工作区」对话框（`#32770`；Win32 坐标点击 + `WM_SETTEXT`/`WM_GETTEXT`）导入，绑定后回读面板选中项与 `ws-chip` 文本。
  - **模型三级选择**：pill 回读 → overlay 快捷菜单直选 → 「更多模型…」→ 主窗口「切换模型」对话框搜索精确选行（非官方模型的唯一入口）；思考档位按**界面实际渲染的档位集合**校验（官方 `Low/High/Max`，非官方 `On/Off`），请求界面不存在的档位在发送前以 `model_mismatch` 响亮失败，绝不静默沿用。
  - **执行模式强制「完全自动」**并在切换后回读确认；`run_task.reasoningLevel` 取值域扩展为 `low/medium/high` + `max/on/off`。
  - **运行检测**：`button.stop`（`aria-label="中断"`）与 `button.send.is-starting` 为权威运行信号；发送以标记 + 60s 有界确认（会话 id 与用户消息落地为必需锚点），**绝不重发**。
  - **`needs_user` 六类与 `continue_task` 恢复**：`close_existing_instance` / `login_required` / `user_confirmation` / `agent_question` / `system_permission` / `setup_recovery`；提问续答写回原会话（不重发任务书）、用户确认仅重连观察、环境类补发完整任务书；定位不到原会话一律 `session_lost` fail-closed。
  - **取消与重派护栏**：照 Codex M14 语义，`cancel_task` 尽力点 `button.stop` 并在 `gui.cancelWaitMs` 内有界等待界面空闲，未确认停止时终态如实明示；派发前发现未停止的运行先尽力停止，仍不空闲以 `instance_busy` 拒绝。
  - **真机验证（Windows 10 x64 + Kimi Code 1.0.2）**：成功路径、未登记工作区导入 + 自动验收、失败 → 返修 → 再验收**同会话闭环**均已通过。**取消、提问续答、同名工作区歧义仅由 hermetic 集成测试覆盖**（未在真机点停、未触发真实提问卡片）；macOS 为 `research` 且 fail-closed（可执行探测与原生对话框驱动未在 macOS 实测）。

### 计划中

- 更多外部 AI-Agent 适配（新 agent = 一个 profile +（如需）一个 adapter 文件）。
- Kimi Code 的 macOS 真机验证矩阵，以及取消 / 提问续答 / 同名歧义的真机验证（当前仅 hermetic 集成测试覆盖）。
- TraeWork 在 macOS 下的可执行探测与原生对话框驱动（当前 macOS 分支 fail-closed）。
- 可选的项目级技能播种（默认不写入目标项目仓库）。
- Codex 与 ZCode GUI 的 macOS 取消/返修/新建项目矩阵（当前两者 darwin 均保持 `research`）。
- `needs_user` 状态下取消任务时经临时 CDP 连接尽力停止 GUI 内等待中的会话。
- ZCode 无项目派发在 macOS 上的真机验证（本轮仅 Windows 10 实测）。
- ZCode **未登记项目**的自动导入在 Windows 上无法完成：原生面板脚本靠 `SetForegroundWindow` 抢前台来激活地址栏，而后台 MCP server 的子进程会被 Windows 拒绝，地址栏 Edit 永不出现，脚本空转到 deadline（实测 56s 后由 `budget.check()` 归类为 setup 预算耗尽）；且 PowerShell 的 stdout 在管道里被缓冲、进程被 kill 后缓冲丢失，日志里连一条 `native:` 阶段都看不到，排障方向被误导。临时对策：先在 ZCode 中手动把目标目录加入项目列表；修复方向是脚本内改用 `AttachThreadInput` 抢前台（或改走 ZCode 受支持的登记入口）。
- AI 内容校验的跨轮判定翻转熔断（本轮以缓存 + 采样覆盖；若真机数据显示仍扰动再议）、跨任务缓存共享、参考图/设计稿差异比对。

### 修复

- **补齐 issue #13 计划 §5 G 要求的两项契约映射断言（v0.5.4 发布后补）**：`CONTENT_TIMEOUT` 此前只实现了分类逻辑、测试仅断言传输层 `outcome.timeout`，判定桩的 `sleep` 模式从未被用例使用；现补 `visual-content-command` 的端到端断言（超时 → 单项 `blocked` + `CONTENT_TIMEOUT` + 仍为仅告警 + 临时输入文件已删除），并补成功路径的临时输入删除断言，以及 `visual doctor` 的「多规则总预算超 `roundTimeoutMs` 只给建议值」分支断言。v0.5.4 tag（`ea797d1`）的用例数为 644，master 现为 647。

---

## [0.5.4] — 2026-09-16

**视觉验收第二阶段：AI 视觉内容校验（issue #13）**——在既有客观像素/规格检查之外，新增一个**可选、默认关闭**的内容校验维度：校验图片或页面截图的内容是否符合用户显式声明的期望描述。判定完全委托用户自备的本地命令（MCP 全程不读取/存储/转发任何凭证），默认仅告警，采样多数票 + 任务级缓存防抖。完整说明见 [v0.5.4 发布说明](docs/release-v0.5.4.md)。

### 新增

- **内容校验配置面**：`visual.content`（全局命令与预算）、`visual.contents[]`（图片内容规则）、`pages[].content`（页面语义校验）与 `pages[].pixel`（默认 `true`；`false` 表示语义-only 页面，豁免基准要求与像素对比，但必须声明 `content`）。配置默认关闭，需显式启用；声明了规则却不启用、有效命令/模板缺失、未知占位符、未放行 `allowRemote` 却使用字节外传占位符、`samples × timeoutMs` 超出 `limits.roundTimeoutMs`、派生 id 冲突等一律在 schema 层拒绝。
- **命令契约**：占位符模板（`<image:path>` / `<expect:file>` / `<image:base64:file>`）+ stdout 末行严格 JSON（`{passed, confidence?, reason}`）。期望文本经临时文件传递，规避命令行转义与长度上限，也避免进入进程命令行与系统审计日志；临时文件每轮采样后在 `finally` 中删除。逐规则可覆盖 `command`/`argsTemplate`/`cwd`/`env`/`samples`/`allowRemote`。
- **判定防抖**：单项内串行采样 + 多数票（票不集中判 `uncertain`）+ 可选置信度闸门（`minConfidence`）；任务目录级输入哈希缓存，键含图片摘要、期望文本、命令字符串、**命令绝对路径与二进制摘要**、参数模板、cwd、环境值摘要（不落明文）、`allowRemote`、`samples`、`minConfidence`。自备 CLI 升级即自动失效；命令身份无法可靠计算时不做缓存；仅成功完成的判定入缓存。
- **结果与报告**：`VisualResult.kind` 新增 `"content"`、`status` 新增 `"uncertain"`；内容项在报告 md 与离线 HTML 中输出期望描述、采样票型、判定理由、提供者命令与缓存命中，并在命令不报 confidence 时标注「minConfidence 未生效」。HTML 状态筛选新增 `uncertain` 档位。
- **CLI 与诊断**：`visual content probe <project> [ruleId]`（按声明规则跑真实判定但不写证据、不写缓存）、`visual content cache clear <taskId>`；`visual doctor` 新增 `content command`（逐条有效命令解析结果 + `allowRemote` 声明清单，不可解析即该项失败）与 `content budget`（规则数 × samples × timeoutMs 与 `roundTimeoutMs` 对比并给建议值，不自动改配置）。

### 修复

- **返修计划把 `optional:true` 的失败列为「必须修复」**（issue #13 验收标准要求修复的既有缺陷）：`repair-plan.ts` 的 `failed` 过滤条件原先只排除 `skipped`，导致仅告警的检查失败也被列进第 2 节。现补 `!c.optional`，并新增第 3.2 节「仅告警项（不必修复）」列出 optional 检查失败与 `optional:true`/`uncertain` 的视觉项，同时在第 5 节明确要求不得为消除告警而伪造产物或放宽检查。

### 安全

- [SECURITY.md](SECURITY.md) / [SECURITY.en.md](SECURITY.en.md) 的「凭证零管理」小节增补内容校验的边界：判定委托用户声明的本地命令，MCP 不读取/存储/转发凭证；图片是否离开本机取决于该命令；**MCP 的强制力仅在契约层**（未放行 `allowRemote` 时禁用字节外传占位符），无法在系统层阻止用户命令外传，需用户自行确认其命令行为。

### 测试

- 全量 **644 passed / 12 skipped**（Windows 10 x64，Node 24.18.0），较 v0.5.3 净增 112 项用例：schema 10 条校验正反用例（含预算自洽反例）、`tallyContentVotes` 穷举、缓存键稳定性与命令升级失效、占位符展开与 stdout 解析、整轮级阻塞不产结果行（全局命令与逐规则覆盖命令各一）、单项失败仅告警可见、返修计划隔离、缓存零重跑、探测与缓存清理、doctor 内容诊断、判定归口回归（`uncertain` 与 `optional:true` 均不致败、`blocking:true` 才致败），以及语义-only 页面冻结摘要显式记 null（不受残留基准文件影响）。
- 12 项真实浏览器门禁用例在 Windows 10 本机以 `TIANSHU_VISUAL_BROWSER_TEST=1` 跑通 **12/12**，其中新增 2 项覆盖 `pixel:false` 语义页豁免基准与「一次截图产出像素 + 内容两项」。
- macOS 真实系统证据由 CI 采集：目标提交的 `CI` 工作流 22 个作业全绿，其中 6 个 `visual-browser` 作业覆盖 macOS 15（Apple Silicon arm64）与 macOS 15 Intel（x64）× Node 20/22/24。
- 未覆盖项如实标注：未与真实三方视觉 CLI 实测；「图片未离开本机」无法在系统层验证。详见 [验证进度](docs/visual-validation.md)。

### 兼容性

- 本版本为 **PATCH**：新增可选能力且**默认关闭**，既有调用方签名、报告字段与 `pages`/`images` 默认行为**向后兼容**。唯一需要消费方注意的是枚举扩展——`VisualResult.status` 新增 `"uncertain"`、`kind` 新增 `"content"`，严格穷举 `status` 的外部消费方需一并处理。

---

## [0.5.3] — 2026-09-15

**ZCode 真机回访修复（issue #12 第二轮）**：修复 Windows 上 GUI 实例无法跨 server 退出驻留、新建任务不切页导致静默空等、发送失败归因误导三个真机缺陷。完整说明见 [v0.5.3 发布说明](docs/release-v0.5.3.md)，真机证据见 [Windows 10 验收记录](docs/zcode-issue-12-windows-evidence.md)。

### 修复

- **ZCode / Codex 桌面实例在 Windows 上无法跨 server 退出驻留（真机发现）**：`zcode`、`codex` 的 GUI 实例此前按平台分支 spawn（`detached: process.platform !== "win32"`），而 `traework` 用的是无条件 `detached: true`。最小实验（Windows 10 / Node 24.18.0）显示同一段 spawn：non-detached 子进程在父进程退出后存活 0，detached 存活 1。因此 Windows 上 MCP server（或一次性 smoke / probe 脚本）一退出，ZCode 就被连坐杀掉，`keptInstance` 的「实例跨 server 退出驻留」形同虚设——`needs_user` 提示「请在 ZCode 中处理后再调用 continue_task」，而窗口其实已经消失。现把该不变量收敛为单一来源 `guiInstanceSpawnOptions()`，三处 GUI 实例共用（`codex` 原先连 `unref()` 都带平台分支，一并去掉）；`verify/runner`、`visual/services`、`agents/spawn` 这些**需要整组终止**的执行型子进程语义相反，继续按平台分支，不受影响。
- **新建任务点击返回成功但页面不切换，后续一路静默空等（真机发现）**：ZCode 停在已有会话时，顶部 `conversation-new-task` 是惰性挂载的图标——点击派发成功（返回 `true`）却不切换页面，而会话页的 composer **不挂载** `composer-workspace-trigger`。于是无项目模式的 default 确认、有项目模式的绑定等待都会空等到截止时间，最后只报一句 `needs_user/setup_recovery`（实测空转 30 秒）。现在新建任务后以「项目触发器已挂载」验证草稿**真的**建立；未建立则回退侧栏 `task-new-button`（Windows 3.11.2 实测可靠，此前该兜底只覆盖有项目模式），两者都失败才以 `setup_failed` fail-closed 并报出「触发器仍未挂载」。
- **发送失败归因误导（真机发现）**：窗口被最小化或完全遮挡时页面被 Chromium 节流（`visibilityState=hidden`），发送按钮「明明在视口内」却点不到，`elementFromPoint` 命中的也不是按钮本身。旧文案只报「ZCode 发送按钮未在观察期内启用或被遮挡」，会把用户引向按钮；现在会识别该状态并报出「ZCode 窗口当前不在前台」及把窗口置于前台的操作指引。`Page.bringToFront` 经真机实测**无法**恢复被遮挡的 Electron 窗口，因此不假装能自动恢复。

### 测试

- 全量 **532 passed / 10 skipped**（Windows 10 x64，Node 24.18.0），较 v0.5.2 净增 7 项用例——草稿未建立时回退侧栏入口并完成派发、两个入口都建立不了草稿时 fail-closed 且不发送、页面被节流时发送失败归因为窗口不在前台、页面可见时保留原有的按钮归因文案，以及 GUI 实例 spawn 不变量（跨平台无条件 detached + unref）的 2 项回归。

### 文档

- [issue #12 Windows 10 真机验收记录](docs/zcode-issue-12-windows-evidence.md) 追加「第二轮回访（v0.5.2 之后）」：6 次真机运行的结果与现场取证、`newTask` 不切页的复现判据、发送阶段各失败面的证据，以及本轮**未复现 / 未验证**的事实（含第 1 次 `send_unknown` 的真因仍未定、`sendMessage` 诊断文案在真机上未走到）。

---

## [0.5.2] — 2026-09-14

**ZCode 无项目派发（issue #12）**：`run_task` 的 `projectPath` 变为可选，ZCode 在 `default` 工作区承接任务；配套 `allowCreateProject` 可禁止自动导入项目。完整说明见 [v0.5.2 发布说明](docs/release-v0.5.2.md)，真机证据见 [Windows 10 验收记录](docs/zcode-issue-12-windows-evidence.md)。

### 新增

- **ZCode 无项目派发（issue #12）**：`run_task` 的 `projectPath` 改为可选。省略时 ZCode 在 `default` 工作区承接任务——不分配目录、不登记/导入项目、不采集 Git 基线、不冻结项目快照、不进入项目锁与项目验收；成功后以结构化字段标注 `not_applicable: no_project`，终态文案明示「未进行项目验收」。`query_task` / `list_tasks` 正常展示该类任务；`verify_task` / `get_task_report` 返回明确的不适用说明，不从 cwd 推导目录。
- **`allowCreateProject`（ZCode 专用，可选布尔）**：省略 = 保持既有「目标未登记即自动导入」行为；显式 `false` 时，目标目录未登记即在**任何导入副作用之前**停止派发，返回可识别的 `project_not_registered` 与处理说明（不打开原生文件夹对话框、不添加项目）。其他 agent 显式传入该参数会得到明确的「不支持」错误，而不是被静默忽略。
- **Windows 10 真机验收记录**（`docs/zcode-issue-12-windows-evidence{,.en}.md`）：ZCode 3.11.2.6792 上无项目派发与 `allowCreateProject=false` 的完整证据，含「派发前后 ZCode 项目条目 34 → 34、新增 0 / 消失 0」的对比。

### 修复

- **ZCode 项目触发器就绪判据不一致（issue #12 §五）**：等待用的是 `exists`（只看元素宽高），点击走的是 `pick`（要求该优先级层恰好一个未被裁剪的可见节点），两者判据不同，因此存在 `exists=true` 但 `click=false` 的窗口。现在等待与点击**共用同一份结构化探测**，区分未挂载 / 已挂载但不可见或被裁剪 / 不唯一 / 禁用 / 被遮挡 / 就绪；并新增点击后置检查——项目菜单必须真正打开，`menu-not-open` 单独归类。
- **错误信息与行为失实**：「等待项目触发器超时」不再被用来描述早退（多匹配、禁用）或菜单未打开；失败文案携带 `selector`、匹配数与命中节点最小属性，诊断日志记录尝试次数、实际耗时与剩余预算。
- **集中超时**：新增 `gui.projectTriggerTimeoutMs`（默认 15s）替换原先写死的两处 `15_000`；整个「等待 → 回退一次侧栏新建任务 → 再等待」共享同一截止时间，重试不重置预算，并被 setup 恢复预算与任务总时限夹住。
- **`projectPath` 未在 MCP schema 层放开（真机发现）**：handler 已支持无项目分支，但 `RunTaskParamsSchema.projectPath` 仍是必填，真实 `run_task` 会在协议层被 SDK 拒成 `-32602 Required at projectPath`；而单元测试直接调 handler、绕过了 `inputSchema`，所以全绿也没抓到。已改为 `AbsPath.optional()`，并在 `test/integration/task-flow.test.ts` 补协议层回归用例（断言文本不出现 `-32602` / `Input validation error`）。
- **缺少「不在项目中工作」切换，且项目菜单已开时点击被 toggle 反噬（真机发现）**：ZCode「新建任务」会继承上一次绑定，使无项目派发永久停在 `needs_user`；同时 `clickProjectTriggerAndConfirm` 在项目菜单**已经打开**时仍点击触发器，把 Radix 下拉关掉后一路轮询到 deadline，误报「项目菜单未打开」。现新增 `workOutsideProject` 选择器与 `enterDefaultWorkspace()` 显式切换（切换后以 `workspaceBinding` 回读为准），点击前先查菜单是否已开；`confirmDefaultWorkspace` 对「明确绑定着项目」立即返回而非空等。

---

## [0.5.1] — 2026-09-14

文档与验证证据补齐；**无运行时行为变更**。完整说明见 [v0.5.1 发布说明](docs/release-v0.5.1.md)。

### 新增

- `npm run evidence:visual:windows`（`scripts/evidence-visual-windows.mjs`）：在 Windows 10 本机采集完整功能矩阵证据（`existing`/静态/命令三种来源、端口冲突阻塞且不结束他人服务、就绪失败有界阻塞并清理子进程、本机 Edge 独立实例与版本不匹配、缺浏览器阻塞），9/9 通过。
- `docs/visual-validation-evidence/`：视觉验收验证的原始机器可读记录（Windows 10 矩阵 JSON 与测试输出、macOS 双架构 `environment.json`、macOS CI 摘要），随包分发。

### 修复

- `package-lock.json` 根包版本滞后：v0.5.0 发布时锁文件仍为 `0.4.1`（与 `package.json` 的 `0.5.0` 不一致），本版本同步为 `0.5.1`。

### 测试

- 视觉验收补两条真实浏览器门禁用例：项目路径含中文与空格时截图正常；主文档 302 跳转到未放行来源时按策略拦截，显式放行后通过。全量测试 **486 passed / 10 skipped**。
- 采集 macOS 13+ 平台证据：macOS 15 真机 runner 上 Intel x64 与 Apple Silicon arm64（Node 20/22/24）各跑通 10 文件 51 用例。

### 文档

- **技能文档（`skills/tianshu-mcp/`）对齐代码实况**：`SKILL.md` 补全 11 个工具表与能力/审批列（含 `prepare_visual_baseline`/`approve_visual_baseline`），视觉验收独立成节（阻塞不触发返修、`rework_task` 先重新验收、基准审批与冻结），错误码表补 `setup_recovery` 与 `errorType` 取值，修正 agent 状态语义（`traework` 恒为 `ready`、`codex` 平台相关）与 `continue_task` 仅支持 codex/zcode；`usage-examples.md` 修正 `get_task_report` 不带 meta 块、移除 meta 表误列的 `reasoningLevel`、按 agent 区分自动修复计划落盘位置（codex 在项目内 `.zcode/plans/`、其余在任务目录），并补 `list_tasks` 实际输出列与视觉 CLI 命令。
- `docs/visual-validation{,.en}.md` 重写为完整平台证据表（系统、Node、浏览器版本、命令、结果）。
- 双语 README 与 HANDOFF 按当前代码与提交历史更新。

---

## [0.5.0] — 2026-09-14

新增**可选视觉验收模块**：把页面截图对比与静态图片规格检查接入「开发 → 验收 → 返修 → 再验收」闭环。未启用视觉的项目行为兼容；旧报告与旧任务快照仍可读取。完整说明见 [v0.5.0 发布说明](docs/release-v0.5.0.md)。

### 新增

- **页面来源**：互斥的 `existing` / `command` / `static` 三种来源；服务按定义在同轮复用；静态托管拒绝目录穿越与项目外符号链接；端口占用即阻塞，不擅自复用或结束其他服务。
- **截图与交互**：`viewport` / `fullPage` / `element` 模式与声明式 `click` / `input` / `hover` / `scroll` / `wait` 步骤；固定就绪流程（隔离上下文、登录态、字体与图片、关闭动画、屏蔽、采样）；支持整页有界滚动触发懒加载。
- **稳定化与屏蔽**：最多 3 次采样取相邻一致；持续变化、超像素预算或无法稳定即阻塞；屏蔽选择器定位失败或全图屏蔽都不通过。
- **像素对比**：统一 PNG；尺寸不一致直接失败不缩放；屏蔽区域不计入分子分母；pixelmatch 抗锯齿默认排除；连通区域分析输出坐标、面积、标注图，最多保留 100 个区域并记录其余数量与整体包围框。
- **静态图片规格**：显式文件列表；编码格式与扩展名一致性、存在非空且完整解码、EXIF 方向归一后的宽高、宽高比、字节数、可选 DPI 与真实透明像素判定；不支持格式明确报告。
- **基准两阶段**：`prepare` 生成候选（候选 ID、摘要、目标路径、预览），`approve` 核对候选/原基准/配置摘要后原子写入正式基准与 manifest；缺基准只能生成候选、不能判视觉通过；自动返修不调用批准入口。
- **规则冻结**：任务动工前保存视觉配置与基准摘要，每轮前后核对；变化需经独立 `rules review` / `rules approve` 重建快照。
- **MCP 工具**：新增 `prepare_visual_baseline`、`approve_visual_baseline`（均为有副作用、需宿主审批的 `write` 操作）。
- **CLI**：新增 `tianshu-mcp visual` 子命令（`init`、`browser install`、`doctor`、`baseline prepare/approve`、`rules review/approve`、`artifacts clean`），在 stdio 连接前分流。
- **报告与产物**：`VerifyReport` 新增可选 `visual` 字段与 `files.html`；离线 HTML 支持状态过滤、图片并排、透明叠加与区域定位，纯本地产物、文本转义、无 CDN；每轮产物位于 `<home>/tasks/<taskId>/visual/<round>/`，轮次由统一任务级锁分配。
- **阻塞与恢复**：区分可返修缺陷、环境阻塞与用户取消；视觉阻塞进 `needs_attention` 并保留待重新验收标记；`rework_task` 对视觉阻塞先重新验收、仅真实缺陷才消耗返修预算；通用与 Codex 专用返修计划均含视觉证据并明示不得修改基准/阈值/开关绕过。
- **配置健壮性**：无效 acceptance 配置显式阻塞而非静默回退；显式 `checks: []` 才关闭命令检查；`extraChecks` 与 `checksMode=replace` 不覆盖视觉门禁；`visual` 严格校验未知字段、重复 ID、空规则与冲突选项。
- **依赖与运行时**：固定 `puppeteer-core@24.43.1`、`@puppeteer/browsers@2.13.2`、`sharp@0.34.5`、`pixelmatch@7.2.0`；图像库为可选动态依赖，缺失不阻止启动；浏览器按需显式安装，npm 安装与 MCP 启动均不下载浏览器；视觉模块要求 Node.js >=20.3，非视觉功能保留 >=20。
- **文档与门禁**：新增双语视觉验收指南与验证进度；CI 新增真实浏览器矩阵（ubuntu/windows/macos-intel/macos × Node 20/22/24）与生产包消费者验收；release 要求目标提交存在成功 CI 且缺少镜像凭据时阻塞。

### 修复

- 验收引擎解析到无效项目配置时不再静默回退默认检查，改为显式阻塞并给出原因。
- 手动验收与自动验收统一使用任务级锁分配报告轮次，避免并发或恢复覆盖历史证据。
- 手动验收遇到视觉阻塞时任务落 `needs_attention`，不再误记 `failed`。
- `rework_task` 允许对视觉阻塞但缺少原会话定位的任务先重新验收，不再直接拒绝。
- ZCode 恢复预算在取消/截止时间到达时先确定原因再中止依赖操作，避免原因被下游 abort 监听覆盖。
- `TaskOrchestrator` 启动阶段遇到视觉完整性问题时区分「被取消」与「阻塞」，取消不再误记为 `needs_attention`。

### 测试

- 全量 **486 passed / 8 skipped**（Windows 10 x64，Node 24.18.0）：新增视觉配置、图片规格、报告、基准、缓冲、快照、服务、真实浏览器捕获、流程与返修用例。
- 8 项真实浏览器门禁用例以 `TIANSHU_VISUAL_BROWSER_TEST=1` 单独跑通；生产 tarball 独立消费者视觉冒烟通过。

---

## [0.4.1] — 2026-09-13

文档版本：把编排技能文档对齐 v0.4.0 实际工具面，并补齐开源仓库的贡献者名录。本版本无代码行为变更。

### 文档

- **技能文档全面对齐 v0.4.0 工具面**（`skills/tianshu-mcp/`，server 启动时幂等同步到 `~/.rivet/skills/tianshu-mcp/`）：
  - `SKILL.md` 新增 **projectPath 安全闸门**说明（绝对路径 + 存在目录 + realpath 归一、主目录与系统根目录拒绝、脏仓警示），避免把基础设施拒绝误判为 agent 失败。
  - `SKILL.md` 新增 **硬失败错误码速查**（`setup_failed`/`project_ambiguous`/`project_mismatch`/`model_unavailable`/`model_mismatch`/`permission_unknown`/`cdp_disconnected`/`instance_busy`/`session_lost`/`input_mismatch`/`send_unknown`/`idle_timeout` 等），明确硬失败不进验收与自动返修。
  - `SKILL.md` 补全 needs_user 等待类型：新增 `setup_recovery`（zcode 初始化恢复未完成）；补 `continue_task` 的状态与类型限制、zcode 会话定位信息丢失时的拒绝语义。
  - `SKILL.md` 补 `codex-cli` 无头路径（用户自建 `driver=spawn` profile、model 不生效、CLI ≥0.154.0 版本要求）、`ready`/`research` 状态语义、验收 **默认并行 2**（`verifyConcurrency`）与 `requireChanges` 零变更门禁。
  - `usage-examples.md` 新增：`codex-cli` 派活示例；meta 块**字段全表**（补 `agentEndReason`/`lastRunSignal`/`checks`/`round`/`keptInstance`/`zcodeSessionId`/`modelProvider`/`permissionMode`/`progressSummary` 等）；**错误码速查表**；项目级 `.tianshu-mcp/acceptance.json` 配置模板（含 `verifyConcurrency` 并行干扰警示与 `requireChanges` 用法）；`setup_recovery` 恢复示例；profile 整键覆盖语义。
- **双语 README 补贡献者名录**：新增「贡献者 / Contributors」小节，按首次参与顺序列出通过 Issue 与 PR 参与项目的社区成员（头像 + 名字）。

### 其他

- `package.json` 版本号提升至 `0.4.1`（`serverInfo.version` 经 build 自动同步）。

---

## [0.4.0] — 2026-09-13

### 新增

- `projectPath` 安全闸门：`run_task`/`verify_task` 提交即校验（绝对路径 + 存在目录 + realpath
  消除符号链接），拒绝主目录本身与系统/根级目录（含 macOS `/private/*` realpath 形态）；
  提交回执明示符号链接解析来源；git 仓库有未提交变更时追加共处警示（多会话场景）。
- ZCode GUI 驱动支持 macOS：适配主进程标题改写（argv 隐藏后端口探测放宽 + 配置端口段补扫）、
  spawn detached+unref 实例驻留；文件夹面板按 macOS 窗口形态重写（NSOpenPanel 独立窗口 +
  go-to 字段 AX 直写，免疫中文输入法截获）。2026-09-13 macOS arm64 + ZCode 3.11.2 真机闭环
  验证（绑定→回读→发送→运行证据→验收 PASS→succeeded）；取消/返修/新建项目矩阵补齐前
  macOS 保持 `research`。
- Codex GUI 驱动支持 macOS：spawn ChatGPT.app 包内可执行（activation 按平台默认 spawn/msix-com），
  detached+unref 实例驻留；POSIX 进程枚举与 SIGTERM 停止；darwin 安装发现默认目录；
  项目登记状态文件（`~/.codex/.codex-global-state.json`）darwin 直写；运行观察环对
  renderer 瞬时无响应/target 替换做 CDP 重连（连续 5 次才判断开）。2026-09-13 macOS arm64
  真机闭环验证（发现→登记→绑定→发送→运行证据→验收 PASS→succeeded）；取消/返修矩阵
  补齐前 macOS 保持 `research`。

### 修复

- zcode macOS 新建任务惰性按钮兜底：`conversation-new-task` 可能命中首页惰性图标（点击无响应），
  项目触发器未命中时回退侧栏 `[data-testid=task-new-button]` 大按钮再重试。
- `normalizeProjectPath` 解析符号链接：macOS `/tmp`→`/private/tmp` 曾使项目路径匹配失败
  退化为名称匹配，误报 `project_ambiguous`；realpath 失败退回词法归一。
- zcode macOS 面板失败的 `needsPermission` 误报：execFile message 内嵌脚本文本（含
  `ACCESSIBILITY_PERMISSION_REQUIRED` 字面量）把一切失败报成权限问题，改判 stderr 的
  execution error 行。
- `get_profiles` 列出数据目录 `agent-profiles.json` 中的用户自定义 profile（此前未 resolve 不显示，`run_task` 却可用，探测反馈不一致）。
- zcode-flow 测试桩补 `listDialogs`，消除真实 osascript/PowerShell 调用在全量负载下撞 `taskTimeoutMs` 墙钟导致的 flake。
- CDP `connect()` 失败分支自清理 WebSocket（不再依赖调用方兜底 disconnect）；`send()` 超时定时器 unref。
- **盘符根未被 `projectPath` 闸门拦截**（Windows）：`normPath` 会剥掉尾斜杠（`D:\` → `d:`），与拒绝清单里的 `d:/` 永不相等，故闸门对盘符根形同虚设；改为**单独的盘符根判定**，覆盖所有盘符而不依赖枚举。
- `test/unit/project-dir-guard.test.ts` 的系统目录断言不可移植：`/etc`、`/usr` 是 POSIX 路径，Windows 上命中的是「目录不存在」而非拒绝清单；按平台分支，Windows 侧改验盘符根与 `C:/Windows`。
- `test/unit/acceptance-parallel.test.ts` 取消用例偶发（单跑绿、全量红）：固定 250ms 在慢平台可能早于子进程 spawn，使在途 check 被误记为 `skipped`；改为**等两个在途 check 真正启动后再取消**。

### 性能

- GUI 实例探测、发现、注册全链路 `execFileSync`/`spawnSync` 异步化；就绪等待环每 tick 复用进程快照，进程枚举加 1.5s TTL 缓存——消除 Windows 轮询期事件循环冻结（单次最坏 30s）。
- 验收命令检查有界并行：新增 `verifyConcurrency`（**⚠ 默认值由串行变为 2**，范围 1–4；项目级 `.tianshu-mcp/acceptance.json` 可覆盖，=1 完全退化串行——写构建产物/带 `--fix`/共享缓存目录的 checks 建议显式设 1）；日志按声明顺序拼接、格式不变；取消信号可中断在途与未启动检查。
- git 基线哈希两遍并一遍 + 异步有界并发（untracked 上限 5000 截断）；代码分析每文件只读一次，大文件嗅探只读前缀。
- `get_profiles` 与任务快照读改 `Promise.all`。
- 测试套件 267s → 51s：traework UI 层 sleep 改依赖注入（生产默认值不变），vitest 拆 unit 并行 / integration 串行双 project。
- `tsconfig.build.json` 关闭 declaration，dist 去除 70 个 `.d.ts`（140 → 71 文件）。

### 文档

- README（中英）新增「macOS 无头路径：codex-cli（用户 profile）」——含 ≤0.130.0 签名证书吊销的警示与完整 profile 示例。

---

## [0.3.4] — 2026-09-13

- 修复 #8/#10 的项目选择器歧义、完整路径绑定误判和模型混合文本回读。
- 修复 #9 的无会话环境恢复：完整任务、上下文和引用只发送一次，使用任务标记或唯一会话差集定位。
- 增加共用截止时间的初始化恢复、可配置预算及 `setup_recovery` 暂停；原生操作超时先复检副作用，取消回收辅助进程。
- 修复拆分模型标签、隐藏动画旧值、项目菜单焦点截获和发送按钮尚未就绪的问题。
- 补充真实 DOM、取消及恢复回归，Windows 真机覆盖新项目冷导入、已导入项目复用和同任务恢复，实际产物与 2/2 验收通过。
- 本版本发布 GitHub Release/tarball 并同步发布到 npm（`latest`）；macOS 尚无本次真机验证，ZCode profile 保持 `research`。

详见 [发布说明](docs/release-v0.3.4.md) 和 [验收证据](docs/zcode-issue-8-10-validation.md)。

## [0.3.3] — 2026-09-12

修复 issue #4 / #7：适配 ZCode 3.11.2 的模型菜单与项目绑定语义，并将验收引擎收紧为 fail-closed，防止零用例、零变更任务假绿。

### 修复

- ZCode 供应商分组选择器同时兼容 `group-provider` 与 3.11.2 `group-family`；模型流程改为直选优先、供应商分组展开兜底，并在失败信息中附带可见文本与 `data-testid` 候选。
- 添加新项目前收起残留工作区菜单，以最多三轮“收起—点击—验证”闭环消除首次点击被吞。
- 项目选择优先点击 composer 菜单的 `menuitemcheckbox`，旧版侧栏项仅作回退；项目名称按 NFKC、空白和大小写归一化。
- 项目绑定回读同时校验 composer 触发器文本与完整路径，未绑定占位词不再误判；绑定失败最多两轮幂等重试。
- ZCode/TraeWork 内置发现目录统一为 `{PROGRAMFILES}` / `{PROGRAMFILES(X86)}`；自定义 profile 的环境占位符按大小写不敏感方式展开，未知占位符保留原样。
- 非 optional 测试检查在退出码为 0 但输出显示零用例时改判失败。
- Git 项目默认要求相对动工前基线产生变更；纯问答/分析任务可在 `.tianshu-mcp/acceptance.json` 设置 `"requireChanges": false` 显式关闭。

### 测试

- 回归覆盖 ZCode 3.11.2 family 平铺模型、旧版分组兜底、testid 诊断、项目点击被吞、composer 绑定与回读重试，以及零用例/零变更门禁。

---

## [0.3.2] — 2026-09-12

修复 issue #5 / #6：**MCP 任务模型与 Codex GUI 内 turn 的状态脱节**。
前者是"等用户确认时恒报 running"的完成判定死锁，后者是 `cancel_task` 只停 MCP 侧等待、
不停 GUI 内运行且描述失实。同根问题一并收敛。

### 修复

- **等待用户检测（issue #5）**：
  - `judgeCodexPoll` 新增 stall 兜底：停止按钮持续可见且对话哈希 `gui.stallTimeoutMs`
    （默认 5 分钟）不变 → 判定等待用户，任务转 `needs_user`（`needsUserKind=user_confirmation`），
    不再死锁在 `running` 直到总超时；对话内容恢复变化会重置 stall 计时。
  - 新增可配置界面检测 `gui.selectors.userGate`（如结账页 `embedded-checkout`、确认卡）：
    命中即快速转 `needs_user`；默认未配置 = 禁用，不内置未真机验证的选择器。
  - 收紧 `stopButton` 选择器：移除 `aria-label*="取消"` 过匹配（等待用户界面的"取消"
    按钮曾被误判为运行信号）。
- **恢复通道（issue #5 牵连）**：`continue_task` 扩展支持 codex——
  - `user_confirmation`：用户在 Codex 窗口处理完后恢复，MCP 仅重新接入观察 GUI 内运行
    （不发送消息）；恢复前 turn 已完成也能正确判 `succeeded`；
  - `login_required`：复检环境后重新派发任务书（新会话 + 项目绑定 + 完整初始指令）；
  - zcode 原有恢复行为不变；其他 agent 明确拒绝。
- **取消真停 GUI（issue #6）**：
  - `cancel_task` 对 GUI agent 不再"请求即成功"：先经 CDP 尽力点击界面停止按钮，
    并在 `gui.cancelWaitMs`（默认 15 秒）内有界等待 GUI 真正空闲后落 `cancelled`；
    未确认停止时终态文案明示"GUI 内运行未确认停止，Codex 窗口中的任务可能仍在继续"；
  - CLI agent 的进程树终止语义不变；
  - `needs_user` 状态取消的文案提示"GUI 内可能仍有等待中的会话"（此时 MCP 侧无 CDP 连接，
    列为已知边界）。
- **重派防交叠护栏（issue #6 连锁）**：派发前发现受管实例上仍有未停止的运行时，
  先尽力停止；仍不空闲则以 `instance_busy` 硬失败拒绝派发，杜绝新旧 turn 在同一
  应用内交叠（取消后立刻重派曾实测踩中）。
- 启动日志的工具数由硬编码 `8` 改为按注册表实际数量（`TOOL_DEFS.length`，当前为 9）输出。

### 变更

- 工具描述对齐实际语义：`cancel_task` 区分 CLI（kill 进程树）与 GUI（尽力点击停止 +
  有界等待）；`continue_task` 去掉"只用于 ZCode"限定。
- `GuiProfile` 新增 `stallTimeoutMs`（默认 300000）与 `cancelWaitMs`（默认 15000）配置项，
  均可由 agent-profiles.json 覆盖。
- 技能文档（SKILL.md §4/§5、usage-examples.md §7）补齐 codex `user_confirmation` /
  `login_required` 恢复方式、GUI 取消语义与相关配置示例。

---

## [0.3.1] — 2026-09-12

v0.3.0 发布后的文档与发布自动化收口：**无源码行为变更**，重点是技能自检安装文档全面重写、
GitHub/Gitee 发行版正文合成与链接修复。

### 变更

- **技能文档（`skills/tianshu-mcp/`）全面重写并对齐 v0.3.0 实际工具面**：
  - 修正 `codex` 描述：由「无头 CLI」更正为 ChatGPT 桌面端 GUI adapter（MSIX + COM 激活 + CDP），
    标注 `model` 必填、`reasoningLevel` / `planDoc` / `designSystem` 用法、不支持 `mode`；
  - 补齐 `run_task` 的 `context` 参数语义与 task/context 路径引用发送前校验说明；
    修正 `autoFixRounds` 默认值优先级（调用参数 > codex 5 / zcode 2 > server 默认 0）；
  - 补齐 `list_tasks`、`query_task(tailLines)`、`get_task_report(round)` 与
    `verify_task`（`extraChecks` / `checksMode` / `baselineRef`）的用法与验收命令四级优先级；
  - 补充 `needs_user` 四种等待类型与 meta 块 `needsUserKind` / `pendingQuestion` / `errorType` /
    `reportRound` / `verificationSource` 等字段解读；
  - 审批清单补上 `continue_task`；使用示例中的 emoji 状态标记改为文字（PASS / 告警）。
- **发布自动化修复（v0.3.0 tag 实测暴露）**：
  - Release 正文改为由 `docs/release-v<版本>.md` 与 `.en.md` 双语合成，文档内相对链接改写为
    该 tag 的绝对链接，缺文档时工作流明确报错（不再产出空壳正文）；
  - `Full Changelog` 经 `git describe` 解析上一 tag，生成 `compare/<prev>...<tag>` 比较链接，
    不再退化为 commits 链接；
  - 正文 `CI` 链接解析同 SHA 的 CI 运行，避免误指 Release 自身运行；
  - Gitee 发行版纳入 `release.yml` 自动化：`scripts/gitee-release.mjs` 幂等创建/更新
    （需仓库 Secret `GITEE_TOKEN`，未配置时明确提示并跳过）。
- `.gitignore` 忽略 npm pack 产物与本地临时校验目录。
- 补齐本文件与英文版底部缺失的 `[0.1.10]` / `[0.2.0]` / `[0.3.0]` / `[0.3.1]` 比较链接。

---

## [0.3.0] — 2026-09-12

Codex 桌面端改为 **GUI 驱动**：新增 `codex-gui` adapter，通过 MSIX COM 激活 + CDP 接管，
驱动 ChatGPT 桌面端完成「定位安装 → 启动 GUI → 绑定/新建项目 → 选模型与思考等级 →
发指令开发 → 运行检测 → 验收 → 自动返修」全流程。

### 破坏性变更（BREAKING）

- **`agentId=codex` 的执行方式由无头 CLI 改为桌面端 GUI**：新增 `driver=gui` +
  `adapter=codex-gui` + `activation=msix-com`，**移除了原 `codex exec` 无头路径**。
  升级后 `run_task(agentId="codex")` 会启动并驱动 Codex 桌面窗口，不再是无头子进程。
  如需保留无头执行，请按 `docs/agent-profiles.md` 另建一个 `driver=spawn` 的 profile
  （`argsTemplate: ["exec", "<prompt:arg>", "--skip-git-repo-check", "--sandbox", "workspace-write"]`）。
- 该路径要求本机已安装 Codex 桌面端（MSIX 商店包）；纯 CLI 环境不再直接可用。

### 新增

- `codex-gui` adapter（`src/agents/codex/**`）：Appx 优先的安装发现（回退扫盘取最新版本）、
  MSIX COM 激活 + 专属 `user-data-dir` + 动态调试端口、CDP 接管与页面收敛（排除 overlay 次级窗口）。
- 任务参数扩展：`reasoningLevel`（低/中/高，中英双语）、`planDoc`、`designSystem`。
- 模型与思考等级：模型为 `menuitemradio` 候选，**思考强度为滑块**（0–4 档：轻度/中/高/极高/极高），
  用方向键精确设置并回读校验；等级比较采用精确匹配（避免「高」误命中「极高」）。
- **项目自动登记**：未在 Codex 侧登记的目标目录会直接写入 Codex 项目状态
  （幂等、写前备份、原子写、仅在本 MCP 受管实例停止时写），从而走稳定的已绑定路径，
  不再依赖脆弱的原生文件夹对话框；失败时自动回退界面新建路径。
- 验收与返修：复用既有 AcceptanceEngine（`package.json` 推导默认集，含弱验收标注）；
  验收失败由 MCP 自动生成项目内 `.zcode/plans/codex-fix-r<N>.md`（每轮独立、不覆盖）并写入返修指令，
  默认最多 5 轮（`defaultAutoFixRounds`）。
- 运行检测：停止按钮为权威运行信号，文本稳定仅在其后作为完成证据；无运行信号时失败开放为
  `idle_timeout` 且保留实例（不会误判完成）。
- `scripts/probe-codex.mjs` 真机诊断脚本；Codex 单测 67 项与集成测试（含验收失败→生成计划→返修通过闭环）。
- 文档：`docs/codex-gui-cdp.md`、`docs/codex-windows-smoke.md`（含第二轮真实业务任务验收）及英文版。

### 变更

- `GuiProfile` 新增 `activation` / `userDataDir` / `appxPackageName` / `permissionMode` / `fixPlanDir`；
  既有 `spawn` profile 不受影响。
- `ExecutableDiscovery` 新增 `appxPackageName` / `installRelativeExe` / `scanRoots` / `scanPattern`。

### 修复（真机实测暴露）

- 模型触发器误命中同组权限 chip（4 个 chip 均带 `aria-haspopup`，仅模型 chip 无 `aria-label`）。
- 思考强度原按菜单项点击，永远无法设置（实为滑块）。
- 菜单/弹层需 **trusted** 鼠标事件才会展开（DOM `.click()` 无效）。
- 绑定项目后工具条重渲染期间模型 chip 空读被误判为「模型不符」。
- 模型/思考强度触发器选择器排除顶部菜单栏与模式切换器。
- 冷启动就绪等待放宽到 150s（登记会先停实例，实测冷启动约 85s）。
- CI：修复 `normalizeDir` 断言依赖宿主平台导致 ubuntu/macos 失败。
- 修复集成测试未注入 `ensureRegistered` 而污染真实 Codex 项目状态的问题。

### 验收

- Windows 10 x64 真机：已登记项目的全链路、验收失败→自动生成计划→返修通过闭环；
  未登记项目经自动登记后全链路通过。
- 真实业务任务：驱动 Codex 用 HTML+CSS+JS 开发「切水果小游戏」（`GPT-5.6 Sol` + 思考强度「高」），
  产物通过验收标准，并在无头浏览器中实测可玩（得分上升、生命扣减、Game Over 与重开正常、无 JS 异常）。
- macOS 未验证：Codex GUI 内置状态为 `research`，不参与就绪判定。

---

## [0.2.0] — 2026-09-11

### 新增

- 独立 `zcode-gui` Electron CDP adapter：数据驱动 Windows/macOS 安装探测、动态端口、产品/进程归属核验和全局串行锁。
- ZCode 精确项目绑定、受守卫的原生文件夹面板、`供应商/模型`、完全访问回读和幂等发送。
- `needs_user` 暂停状态与需审批的 `continue_task`，支持原会话问题回答及旧实例、登录、系统权限处理后的环境复检。
- 多信号运行检测、进度事件、现场保留、默认自动验收和 2 轮同会话返修；返修计划只写 MCP 任务数据目录。
- `scripts/probe-zcode.mjs`、假 CDP/状态机/路径/模型测试和中英文文档。

### 安全与兼容

- GUI profile 新增显式 `adapter`；旧 `driver="gui"` 配置继续按 TraeWork 兼容。
- ZCode 双平台真实闭环证据完成前，内置 profile 保持 `research`。
- 不调用未公开 `app-server`，不读取凭证，不关闭用户实例，不使用固定屏幕坐标。

### 修复与验收

- 修复 ZCode 动态模型标签的回读解析、渲染器短暂繁忙/重载、新会话延迟登记和旧会话 ID 污染。
- 续答 `AskUserQuestion` 时改为在原会话可访问问题卡片中精确选项并提交；零匹配或多匹配时 fail-closed。
- Windows 10 x64 真机已通过文件开发、受控失败后同会话返修、模型提问后 `continue_task` 续跑三个闭环；macOS 真机仍待补齐。

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

[0.5.8]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.5.7...v0.5.8
[0.5.7]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.5.6...v0.5.7
[0.5.6]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.5.5...v0.5.6
[0.5.5]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.5.4...v0.5.5
[0.5.4]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.3.4...v0.4.0
[0.3.4]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.10...v0.2.0
[0.1.10]: https://github.com/lanlan0811/tianshu-mcp/compare/v0.1.9...v0.1.10
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
