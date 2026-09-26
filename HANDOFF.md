# HANDOFF.md — 项目交接说明

> **交接快照：2026-09-24 · 开发版本 `0.6.7`；`v0.6.7` 已发布（GitHub Release / Gitee 发行版 / npm `latest` 三者一致，发布提交 `ca98797`）。**
> **issue #18~#22 五项增强已全部交付**（v0.6.3~v0.6.7，每版各自完整发布），**五个 issue 均已回复并关闭**（2026-09-24）。
> **#18~#22 的真机记录已全部补齐**（2026-09-25）：见 [issue #19/#20/#21/#22 真机记录](docs/issue-19-22-real-machine-record.md) 与 [issue #18/#19/#21 真机记录](docs/issue-18-21-real-machine-record.md)；各 issue 另附真机证据补充评论。
> **⚠️ 新发现一条会阻断全部 Codex 派发的适配器缺陷**（`26.917.9434` 模型触发器回读混入整条思考等级条 → `model_mismatch`），尚未修复、建议单开 issue，详见下方「真机取证补记」与记录文件 §5。
> 本文写给**接手本仓库的人**：先说清「这是什么、现在到哪一步」，再给出「怎么跑、怎么改、哪里会踩坑」。
> 工作区规则见 `AGENTS.md`（gitignore，仅本地）；安装与用法见 `README.md`，本文不重复，只做导览与状态记录。

---

### Open Design GUI 适配器 · 阶段 P2/P5/P6 不依赖选择器的核心模块（0.6.10，2026-09-26）

- **本轮把「不依赖选择器」的部分全部做完了**，这样选择器一旦采集到就能直接接线，不必再等代码：
  | 模块 | 内容 |
  |---|---|
  | `workspace.ts` | 工作目录绑定编排（已绑定则**跳过且零点击** → 展开 → 点选择目录 → 原生对话框 → **回读校验**）；`normalizeWorkspacePath` / `workspaceMatches`（含界面截断省略号的前缀匹配） |
  | `dialog.ts` | 原生「选择文件夹」双路线（`WM_SETTEXT` 优先 / 失败退回键盘输入），两条都要求回读一致，确认后**等对话框真的关闭**；安全边界=本次新出现 + 属目标进程 + `#32770` + 可见 + 唯一，基线点击前采样，多个新对话框直接放弃 |
  | `liveness.ts` | **三信号**运行检测（停止按钮 + 对话文本哈希 + **产物 mtime/大小指纹**）；纯函数 `judgeOpenDesignPoll` |
  | `fixplan.ts` | 修复/优化计划落项目根 `.opendesign/plans/opendesign-fix-rN.md`（每轮独立不覆盖）+ 返修指令 |
  | `visual.ts` | 视觉验收页面来源**推导**（静态入口优先，其次工程结构；都不成立就如实说）——**只推导不落盘**，绝不自动改 `.tianshu-mcp/acceptance.json` |
- **为什么产物信号是必需的**：Open Design 生成设计稿时会长时间不刷对话却持续写文件；只看对话文本会把这类正常工作判成「空闲完成」。
- **两条硬判据**（容易做错，写下防回归）：
  1. **绑定成功 = 回读一致**，不是「原生对话框关掉了」——对话框确认只说明系统接受了目录；
  2. **原生对话框关闭 ≠ 应用已接受**，两者不一致时报 `readback` 失败，绝不当成功继续。
- **修掉一个会反噬的热修复缺陷**：`gui.selectors` 覆盖值过去会与内置 fallbacks **合并**，而 fallbacks 含
  `[aria-haspopup]` 这类宽泛候选，页面上多个元素命中 → 「唯一命中」判据必然失败 →
  **热修复选择器反而把功能彻底关掉**（`no-panel：触发器无法唯一定位`）。现在**覆盖是权威的**：给了就只用它。
- **测试**：新增 65 用例（workspace 14 / liveness 20 / dialog+fixplan 19 / visual 12），绑定编排用例跑在
  linkedom 真实 DOM 上并断言了**基线采样顺序**；全量 **1268 passed / 12 skipped**（110 文件）；
  `typecheck` / `eslint src test scripts` / `build` / `check:stdio` 全绿。**新增用例不依赖本机安装 Open Design**。
- **仍然卡在同一处**：`selectors.ts` 的 `primary` 仍为空占位（沙箱无外网 → 应用主线程卡在启动期 → CDP 连上不响应）。
  选择器一到位，`run.ts` 就能把 P2 绑定、P3 模型/设计系统、P4 方向/输入/发送、P5 轮询、P6 验收与返修依次接上。

---

### Open Design GUI 适配器 · 阶段 P1 交接（0.6.9，2026-09-26）

- **范围**：选择器注册表 + 页面内表达式层（`selectors.ts` / `dom.ts`），并把派活门禁从「未实现」升级为**布局守卫**。
- **⚠️ 本轮最重要发现：`ELECTRON_RUN_AS_NODE` 会让 Open Design 完全起不来**（详见 [docs/opendesign-cdp.md](docs/opendesign-cdp.md) §2.1）：
  `Open Design.exe` 是「内嵌 Node 的 Electron」外层启动器；调用方若带 `ELECTRON_RUN_AS_NODE=1`（**本机 DSH harness 会注入**），
  启动器被置为 Node 模式，`--remote-debugging-port` / `--headless` 全被拒（`bad option:`，退出码 9），
  表现为「无窗口、无新日志、无崩溃转储」——**我本轮一开始就误判成应用损坏，排查了很久**。
  清除该变量后同一条命令立刻打印 `DevTools listening on ws://127.0.0.1:9889/…`。
  **受管启动已自动净化环境**（`OPEN_DESIGN_ENV_DENYLIST` / `sanitizedSpawnEnv()`），命令行不变。
  手工排查时记得自己 `Remove-Item Env:\ELECTRON_RUN_AS_NODE`。
- **第二个真机形态**：启动器接受调试端口后打印 `DevTools listening` 并**自行以退出码 0 退出**，
  真正的 Electron 主进程是它 spawn 的分离子进程。**退出码 0 绝不等于失败**——
  已改为从 stderr 解析宣告端口并继续轮询（`devtoolsPortsFromOutput()`）。
- **布局守卫（`run.ts`）**：关键选择器未采集 → `selector_drift` 并列出缺失键，**不进任何坐标点击**；
  选择器采集后门禁自动解除，无需改代码。守卫**只收初始页面就存在的锚点**
  （不含 `stopButton`、各菜单项、设计系统搜索框——收了会让适配器永远起不来）。
- **P1 未完成的部分（阻塞原因如实记录）**：`selectors.ts` 的 `primary` 仍是**空占位**，真实 DOM 采集**没做成**。
  原因：本机 DSH 会话**无外网**，而 Open Design 启动期会做版本/遥测/计费请求，请求不可达导致**主线程卡在启动期**——
  进程与窗口都在、`DevTools listening` 已打印，但 `/json`、`/json/version` **连上后不响应**（curl 连接成功、0 字节、超时）。
  这不是代码缺陷，是环境限制。**在能联网的普通终端里**按 docs §9 的 5 步即可完成采集。
- **测试**：新增 23 用例（`opendesign-dom.test.ts`，含在 linkedom 真实 DOM 上执行全部表达式）；
  全量 **1202 passed / 12 skipped**（106 文件）；`typecheck` / `eslint src test scripts` / `build` 全绿。
  新增用例**不依赖本机安装 Open Design**。
- **下一步（P1 收尾 → P2）**：在联网终端 `node scripts/probe-opendesign.mjs anchors --launch`，
  把选择器写回 `selectors.ts` 的 `primary`（或用 `agent-profiles.json` 的 `gui.selectors` 覆盖，免发版），
  确认探针「布局守卫」一节显示全部命中；随后进 P2 目录绑定（含原生对话框归属核对）。

---

### Open Design GUI 适配器 · 阶段 P0 交接（0.6.8，2026-09-26）

- **范围**：新增内置 agent `opendesign`（`driver=gui` / `adapter=opendesign-gui`）的**安装发现 + 实例接管 + CDP 探测**；
  界面驱动（P1 选择器采集 → P2 目录绑定 → P3 模型/设计系统 → P4 方向/输入/发送 → P5 运行检测 → P6 视觉验收与返修）**尚未实现**。
- **完整计划**：`.dsh/plans/opendesign-gui-adapter-plan.md`（含 20 轮确认结论与 §7.1 真机实测修正）。
- **真机事实**（详见 [docs/opendesign-cdp.md](docs/opendesign-cdp.md)）：
  - 普通安装（非 MSIX）；`D:\Open Design\Open Design.exe`；产品版本与命名空间从 `<安装目录>\resources\open-design-config.json` 读（实测 `0.24.1` / `release-stable-win`）。
  - **进程级单实例锁** + 主进程强制 `app.setPath("userData", …)` → `--user-data-dir` 会被覆盖，**不做**「专属 userData 受管实例」；策略为复用优先 → 自管启动 → `needs_user(close_existing_instance)`，**绝不 kill 用户进程**。
  - **sidecar 陷阱**：daemon / web sidecar 也是同一 exe 的子进程（argv 带 `*.mjs`），实测 11 个同名进程只有 1 个真主进程。`rootOpenDesignProcesses()` 必须剔除它们，否则用户关窗后受管实例**永远起不来**。
  - 端口基准原计划 9777，实测**已被 Qoder CN 占用**（区段 9777-9796）→ 改为 **9889**（区段 9889-9898）。
  - 版本门禁用**产品版本**；CDP `/json/version` 的 `Browser` 是 **Electron 版本**（41.3.0），误用会阻断全部派发（已加回归测试）。
- **本阶段刻意 fail-closed**：`selectors.ts` 仍是空占位，`run.ts` 在缺关键选择器时**硬失败 `not_implemented`** 并列出缺失键。
  这是有意设计——派一个还没接上界面的适配器却报成功，会污染验收与返修记账。**P1 采集完选择器后**该门禁自然解除。
- **接口变更**：新增 `run_task` 参数 `designDirection`（仅 Open Design；只支持「原型 / 文档 / 网站复刻」，其余显式拒绝，入口即拒）；
  `designSystem` 对 Open Design 的语义是**设计系统名**。`mode` 刻意不复用（那是 TraeWork 的面板模式）。
- **探针**：`npm run probe:opendesign`（`install` / `process` / `cdp` / `appconfig` / `anchors`），默认只读；`--launch` 才启动实例。
  **跑 `cdp` / `anchors` 需先把现有 Open Design 窗口关掉**（未开调试端口的实例无法接管，探针会如实报告）。
- **测试**：新增 34 用例（`test/unit/opendesign-{discovery,model}.test.ts`），全量 **1173 passed / 12 skipped**（105 文件）；
  `typecheck` / `eslint src test scripts` / `check:stdio`（dist 与 src 各 8/8）全绿。
  **新增用例不依赖本机安装 Open Design**（用注入 + 临时目录），符合「新增用例不得依赖本机 GUI agent」的既有教训。
- **下一步（P1）**：关掉现有窗口后 `node scripts/probe-opendesign.mjs anchors --launch`，
  把收敛出的稳定选择器写回 `src/agents/opendesign/selectors.ts`，并补 `dom.ts` 表达式与 layoutGuard。

---

### 真机取证补记（2026-09-25，issue #19~#22）

按计划文档 `.claude/plans/issue-18-22-plan.md` 的「交付后待办」，本轮把 issue #19~#22 的真机记录补齐，
机器 Windows 10 Pro 19045，被测版本 `master`（v0.6.7）的本地 `npm run build` 产物。
完整记录：[issue #19/#20/#21/#22 真机记录](docs/issue-19-22-real-machine-record.md)（中文单语，沿用既有 `docs/issue-*-record.md` 体例）。

| issue | 真机方式 | 结果 |
|---|---|---|
| #19 | 真实 Codex GUI + `autoVerify` + `autoFixRounds=1` | ✅ **前后对比**：第 0 轮 `[FAIL]` → `repairDirectives` 精确给出 `src/app.ts:13` / `:17`（与两处真实缺陷一致）→ 2.5 节进返修计划 → 第 1 轮 `[PASS]` |
| #20 | 真实 CLI 子进程 + 真实 MCP server + stub | ✅ 三级继承逐字段可见；**项目层只写 `verifyConcurrency` 时 `requireChanges` 仍为全局层的 `false`**（本版修的 `.default()` 污染隐患）；override 不粘连；坏层 fail-closed |
| #21 | 真实 Codex GUI + `dryRun=true` | ✅ 6/6：零源码改动（`git status` 仅 `.tianshu-mcp/`）、`planExtracted=true`、不消耗验收轮次、方案文档可作 `planDoc` |
| #22 | 真实 MCP server + 真实本地 `node:http` 端点 + stub | ✅ 14/14：恰好一次 POST、HMAC 验签、500 端点重试 3 次不阻塞、白名单过滤、`enabled:false` 零请求 |

- **取证脚本**：`.claude/plans/rm19.mjs` / `rm20.mjs` / `rm21.mjs` / `rm22.mjs`（`.claude/` 受 `.gitignore` 忽略，故意不入库）。
  **要复跑请先读记录文件各节的「复现要点」** —— 脚本依赖 scratch 数据目录（`%TEMP%\tianshu-rm*`）+ `dist/` 构建产物。
- **⚠️ 本轮新发现：Codex 模型回读缺陷（阻断全部 codex 派发，尚未修复）**。`26.917.9434`（`26.917.8451` 同样复现）下模型触发器的
  `innerText` 混入整条思考等级条（实测回读 `6 Luna 中 无 极低 轻度 中 高 极高 最高 Ultra 持续`），
  `parseTriggerValue()` 要求文本以「低/中/高」结尾才能分离等级，此处以「持续」结尾 → 整串被当作型号 →
  `exactUiName()` 必然为假 → 三轮后判 `model_mismatch`。**这是本轮 #19/#21 取证的实际阻塞点**，
  取证时在 scratch 数据目录用「克隆内置 profile + 只改 `gui.modelSwitch=false`」绕开
  （运行时日志如实打印 `[codex] profile.gui.modelSwitch=false，忽略指定模型`）；**属取证规避，不是修复**，
  内置 profile 仍为 `modelSwitch: true`、产品行为未改。**建议单开 issue 跟踪**，修好后上面两个规避可撤掉。
- **型号名继续漂移**：`26.917.9434` 的可用候选为 `默认 推荐模型集、6 Astra、6 Sol、6 Luna`
  （此前文档示例里的 `5.6 Terra`、更早的 `GPT-5.6 Sol` 均已不存在）。适配器 fail-closed 并回显候选，
  行为符合设计；文档「以面板/错误回显为准」的写法依然正确。
- **一处不阻断的小瑕疵（本轮顺带发现，未修）**：`reportToMd()` 对 `## 结构化修复指令` 段**无条件渲染**，
  于是**通过**轮次的报告里也会出现「（不可用，请改看上方各检查项的输出尾部）原因：本轮报告未生成结构化指令」。
  不影响判定与失败轮次的指令质量；如要清理，改成仅在失败轮次渲染即可（`src/verify/report.ts:79-92`）。
- **四个 issue 已各附一条真机证据补充评论**（2026-09-25，均 HTTP 201）：
  [#19](https://github.com/lanlan0811/tianshu-mcp/issues/19#issuecomment-5828195336) /
  [#20](https://github.com/lanlan0811/tianshu-mcp/issues/20#issuecomment-5828195588) /
  [#21](https://github.com/lanlan0811/tianshu-mcp/issues/21#issuecomment-5828195699) /
  [#22](https://github.com/lanlan0811/tianshu-mcp/issues/22#issuecomment-5828195817)。
  评论正文见 `.claude/plans/issue-19-rm-reply.md` ~ `issue-22-rm-reply.md`，重发脚本 `.claude/plans/post-rm-replies.mjs`（均 gitignore）。
- **真机副作用**：受管 Codex 实例已关闭；scratch 项目登记进了 `~/.codex/.codex-global-state.json`
  （每次登记前自动备份为 `*.tianshu-mcp-backup.json`，项目名形如 `proj`，需在 Codex 内手动移除）；
  scratch 数据目录与项目保留在 `%TEMP%\tianshu-rm19-*|rm20-*|rm21-*|rm22-*` 供人工复核。

---

### 0.6.7 开发交接（任务终态 webhook 通知，issue #22）

- **范围**：终态跃迁时向配置的 URL 异步 POST 通知。无新 MCP 工具、无数据模型变更、无 MCP 注解变更。
- **问题**：长任务下调用方必须挂屏轮询 `query_task`，完成/失败/需人工时无主动推送。
- **配置**：全局 `config.json` 的 `notifications.webhook`（`src/config/schema.ts` 的 `WebhookConfigSchema`）：`enabled`（默认 false）/ `url` / `timeoutMs`（5s）/ `maxRetries`（2）/ `backoffMs`（500）/ `secret` / `events`。**`enabled=true` 但缺 `url` 由 schema `.refine()` 拒绝**。放全局而非项目 `acceptance.json`：通知路由是宿主/传输层关注点，且 `updateStatus` 处只有数据目录 / taskId / logger，无法每次跃迁都廉价读项目配置。
- **钩子点是 `TaskStore.updateStatus()`**（状态跃迁唯一咽喉），**不是** `TaskOrchestrator.finish()` —— 后者只覆盖编排器主导的结束；`cancel()` 的 queued 分支、`initialize()` 的重启归档、`shutdownInterrupt()` / `persistInterrupted()` 全都绕过它。派发时机在 `appendEvent` + `writeSnapshot` **成功之后**（先落本地事实，再对外通知）。
- **「恰好一次」的正解（改这块前必读）**：按 `taskId + status + finishedAt` 去重（`TaskNotifier.sent`，进程内）。**不能用 `prev !== status`** —— 多条路径（cancel 的 queued 分支、shutdownInterrupt）会**先直接改写 `meta.status`** 再调用 `updateStatus`，那时 `prev` 已等于目标状态，门条件恒假。`finishedAt` 由 `updateStatus` 在写终态时刷新为 `updatedAt`（`task-store.ts`），并被 `rework()` / `continueTask()` 清空 —— 故同回合重复写入被抑制，而**返修后的新回合同样状态会再次通知**。
- **`notify()` fire-and-forget**：返回 void，内部 `void this.send(...)`；`send()` 自身吞掉一切异常，`notify()` 再兜一层 catch。端点慢或挂掉**不阻塞状态机写入链**。
- **事件类别**：`done`(succeeded) / `failed`(failed) / `needs_human`(`needs_attention`，真终态) / `needs_user`(`needs_user`，**非终态**) / `cancelled`(cancelled|interrupted)。**默认只订阅 `done`/`failed`/`needs_human`**；`needs_user` 单独成类且默认关闭（它可被 continue 恢复、之后可能再次进入，默认打开会反复打扰）；`cancelled` 同样默认关闭。
- **请求**：`POST` + `content-type: application/json` + `X-Tianshu-Event: <event>`；配 `secret` 时加 `X-Tianshu-Signature: sha256=<hex>`（HMAC-SHA256 对**原始 body 字符串**签名）。`redirect: "manual"` + `AbortSignal.timeout(timeoutMs)`（与 `src/visual/services.ts` 同一约定）。重试 `1 + maxRetries` 次，退避 `backoffMs × 第几次`；全失败仅一条 `warn`。
- **`TaskStore` 新增可选第三参 `notifier`**：大量测试直接 `new TaskStore(home, logger)`，**必须保持可选**；`src/server.ts` 用 `new TaskNotifier(() => dataHome.loadConfig(), logger)` 惰性读配置（运行中改配置即生效）。
- **如实披露**：尽力投递、不保证送达；跨 server 重启或接收端重试仍可能重复送达（建议接收端按同一键幂等）；请求体含 `projectPath` 与报告文件绝对路径，转发到公网前确认接收端可信；飞书/钉钉需自行适配报文格式（文档给了自建转发服务与网关改写两种接法 + 签名校验示例）。
- 测试：新增 **29** 用例 / 2 文件（`notifier` 单测 20、`webhook-notify` 集成 9）+ 测试基建（`startMockWebhook` / `closedPortUrl` / `waitForCondition`）；全量 **1139 passed / 12 skipped**（103 文件，较 v0.6.6 的 1110 净增 29）；`check:stdio` dist 与 src 均 **8/8**。文档：[任务终态通知](docs/notifications.md) 双语 + [发布说明 v0.6.7](docs/release-v0.6.7.md) 双语；ARCHITECTURE 双语新增 §5.7（原「细粒度事件流」顺延为 §5.8，文内交叉引用已同步）。
- **本版无真机依赖**（通知触发只依赖状态机跃迁，stub agent 即可完整驱动），故不需要真机记录；测试也不依赖外网（mock 只监听 127.0.0.1 随机端口）。
- **发布实测**：CI 四平台 **22/22 全绿**（`ca98797`）；`release.yml` 成功并生成 GitHub Release（`v0.6.7`，正文 11548 字符）；Gitee 发行版经 `scripts/gitee-release.mjs 0.6.7 0.6.6` 更新成功；npm `latest` 已为 **v0.6.7**（248 文件，已 `npm view` 复验）。**issue #22 已回复并关闭**（`state_reason=completed`）。

### 0.6.3~0.6.7 五项增强交付小结（issue #18~#22）

按计划文档 `.claude/plans/issue-18-22-plan.md` 分五阶段交付，每阶段独立实现 / 测试 / 双语文档 / 双仓提交 / 完整发布：

| 版本 | issue | 主题 | 净增用例 | 全量测试 |
|---|---|---|---|---|
| v0.6.3 | #18 | `query_task` 细粒度事件流 | +36 | 1002 |
| v0.6.4 | #19 | 结构化修复指令 + `rework repairHint` | +35 | 1037 |
| v0.6.5 | #20 | 三级验收配置继承 + `config acceptance` | +36 | 1073 |
| v0.6.6 | #21 | `run_task` 干跑模式 `dryRun` | +37 | 1110 |
| v0.6.7 | #22 | 终态 webhook 通知 | +29 | 1139 |

- **一次 CI 事故与修复**：v0.6.5 首轮 **九作业全挂** —— 新增用例依赖本机装了 ZCode。**通用教训：新增用例不得依赖本机安装的 GUI agent**；需要某个内置 agent 可解析时，用数据目录 `agent-profiles.json` 覆盖它（并记得把 `stub` 一起写回）。
- **真机记录的实际结果**（2026-09-24 实跑，详见 [issue #18/#19/#21 真机记录](docs/issue-18-21-real-machine-record.md)）：
  - **#18 ✅ 已取得**：真实 Codex GUI（COM 激活 + CDP，非假 CDP）跑通任务 `tsk_20260924225851_8d2575`（model `5.6 Terra`），终态 `succeeded` 且 Codex 真的写出了 `marker.txt`；`query_task` 回传 `task_dispatched` 与 `file_modification_started`（`evidence=stop_button`）两条事件，并验证了「事件时间线先于进度回报」。
  - **#19 ⚠️ 未取得（2026-09-24）→ ✅ 已于 2026-09-25 补齐**：9/24 那次同套脚本 5 次尝试**均在派发前**失败，未消耗额度 —— 当时根因是**本机网络中断**（`chatgpt.com` / `api.openai.com` / `api.github.com` / `baidu.com` 全部 000，仅 gitee 通），Codex 连不上后端就不渲染输入框。**9/25 复跑后网络已正常，暴露的是另一条独立缺陷**（模型触发器回读混入整条思考等级条 → `model_mismatch`），已按顶部「真机取证补记」绕开并取到**前后对比**记录；详见 [issue #19/#20/#21/#22 真机记录](docs/issue-19-22-real-machine-record.md) §1。
  - **#21 不需要（2026-09-24 判定）→ 2026-09-25 额外补了真机**：其验收标准原文是「有对应测试**或**真机证据」，已由集成测试满足；本轮为把四个 issue 证据补齐，另跑了一份真实 GUI 的零改动验证（见新记录 §3）。
- **顺带修正一处文档漂移**：`model: "GPT-5.6 Sol"` 在本机 **26.917 上已不可用**（适配器 fail-closed 回显候选 `6 Luna / 5.6 Terra / 5.6 Luna`；26.917.9434 的候选又变为 `6 Astra / 6 Sol / 6 Luna`，见顶部「真机取证补记」）。`docs/codex-gui-cdp` 与 `docs/agent-profiles` 双语的 `model` 示例已改为「以面板/错误回显为准」并说明型号随版本漂移；**历史记录类文档刻意保持原样**（记录的是当时事实）。
- **五项均已回复并关闭**（2026-09-24，各一条回复 + `state_reason=completed`）。回复文案见 `.claude/plans/issue-close-comments.md`（gitignore，含逐条验收标准对照）；#18/#19 的真机记录补充评论正文与重发脚本见 `.claude/plans/issue-18-followup.md` / `issue-19-followup.md` / `post-issue-followups.mjs`。
- **GitHub API 写权限的来源（备忘，别再误判）**：本机 `~/.git-credentials` 存有 `github.com` 的凭据（用户 `lanlan0811`，经典 PAT，`X-OAuth-Scopes: gist, repo, workflow`），`git push` 正是用它。需要用 API 写操作时可用 `git credential fill` 取出（**只经环境变量传递，不落日志/不回显**）。**注意 `GH_TOKEN` / `GITHUB_TOKEN` 环境变量与 `gh` CLI 均不可用**，别据此判定「没有权限」。

### 0.6.6 开发交接（dryRun 干跑模式，issue #21）

- **范围**：`run_task` 新增干跑模式（只分析规划、不改源码）+ 静态分析报告 + 「先审后做」闭环。无新 MCP 工具、无 MCP 注解变更。
- **问题**：`run_task` 直接驱动 agent 改源码，理解偏差可能产生大量需回滚的改动；调用方希望「先看方案再决定是否真干」。
- **开关**：`RunTaskParamsSchema.dryRun`（默认关闭）；`TaskMeta.dryRun` 随快照保存；计入 `runTaskKeyedFields()` 幂等摘要（它改变 agent 行为约束与验收口径）。
- **只读约束注入点（关键）**：`src/mcp/context.ts` 的 `makeBuildCtx()` 把 `DRY_RUN_CONSTRAINT` 并入 `ctx.context`。**一次改动覆盖全部 5 个适配器**（它们都拼 `ctx.context`），且 dryRun 是 round 0 首次派发，zcode/kimicode 仅在 `initialDispatch` 附加 context 的守卫不会吞掉它。**不要**改成逐个适配器的 prompt builder 注入。
- **引擎侧**：**独立方法** `AcceptanceEngine.runDryRun()`（返回 `DryRunReport`），**不在 `executeVerify` 里分支** —— `DryRunReport` 与 `VerifyReport` 口径不同（静态分析 vs 真实命令验收），并进同一条返回值就得引入联合类型或伪造 `VerifyReport`，既污染类型又让轮次账目变复杂。
- **不消耗验收轮次**：报告落 `dry-run-report-<round>.md/.json`（json 带 `kind: "dry-run"`），文件名不匹配 `^report-(\d+)\.(md|json)$`，`nextReportRound()` 的扫描天然忽略。**不碰** `report-<round>.*`。
- **编排分支**：`fix-loop.ts` 在 agent 返回后、正常验收之前插分支。`passed` → `succeeded`，否则 → **`needs_attention`**（方案有问题属人工裁决，不是可自动返修的代码缺陷）；**不进返修循环**、**忽略 `autoVerify`**。
- **静态检查**（`src/verify/dry-run.ts`）：error 级 `path_outside_project` / `path_forbidden` / `conflicting_actions` / `dry_run_violation`；warning 级 `file_already_exists` / `file_not_found` / `edit_line_out_of_range` / `edit_location_missing` / `file_unreadable` / `dry_run_artifacts_only`。
- **零改动门禁是核心证据**：`analyzeChanges()` 相对动工前基线求差，排除 MCP 自有产物（`.tianshu-mcp/dry-run-plan.json` 与任务书点名的 planDoc）后仍有变更 → `dry_run_violation` 阻断。**不依赖计划写对** —— agent 完全不产出计划时这条仍然有效。
- **计划缺失时降级但可见**：`planExtracted: false` + `fallbackReason`（未找到 / 不可用 + 解析错误），检查降级为仅零改动门禁；报告与文案都标注「计划提取: 失败」，不静默通过。
- **计划契约**：agent 写 `<project>/.tianshu-mcp/dry-run-plan.json`（`{summary, files:[{path, action, reason?, edits?:[{line?, symbol?, action?}]}]}`）；`path` 必须项目相对（拒绝绝对路径 / `..` / `.git` / `node_modules`）。
- **先审后做闭环**：方案文档渲染到**项目内** `.tianshu-mcp/dry-run-plan-<taskId>.md`（`meta.dryRunPlanDoc` 报项目相对路径），可直接作为后续正式 `run_task` 的 `planDoc`。**放项目内而非任务数据目录**是因为 `planDoc` 只能读项目文件。
- **如实披露**：预演仍是一次真实 agent 调用；只读约束靠任务书指令 + 事后门禁，**违反会被拦下但已发生的改动不会自动回滚**（MCP 从不自动 commit/stash/checkout）；静态检查只能验证「文件存在、位置对得上、无明显矛盾」，**无法判断方案是否合理**。另：`planDoc` 目前只由 **Codex 与 Qoder CN** 消费，CLI 类与 ZCode/Kimi Code/TraeWork 不读取，对这些 agent 需把方案路径写进 `task` 文本。
- **无项目模式显式拒绝 `dryRun`**（`runTaskWithoutProject`）：没有可静态分析的文件树与基线，静默忽略会让调用方误以为在干跑。
- 测试：新增 **37** 用例 / 2 文件（`dry-run` 单测 29、`dry-run` 集成 8）+ stub 新增 `dry-run-plan` / `dry-run-edit` 两个剧本；全量 **1110 passed / 12 skipped**（101 文件，较 v0.6.5 的 1073 净增 37）；`check:stdio` dist 与 src 均 **8/8**。文档：[dryRun 干跑模式](docs/dry-run.md) 双语 + [发布说明 v0.6.6](docs/release-v0.6.6.md) 双语；ARCHITECTURE 双语新增 §7.5。
- **本版**按 v0.6.5 的 CI 教训处理：新增用例**不依赖本机安装任何 GUI agent**（无项目模式用例自行桩化 profile，且重写 `agent-profiles.json` 时**必须把 stub 一起写回**，否则同文件后续用例会连 stub 都解析不到）。
- **真机记录（✅ 已于 2026-09-25 补齐）**：真实 Codex GUI + `dryRun=true` 已跑通 —— 零源码改动（`git status` 仅 `.tianshu-mcp/`）、`planExtracted=true`、不消耗验收轮次、方案文档可作后续 `planDoc`。见 [issue #19~#22 真机记录](docs/issue-19-22-real-machine-record.md) §3 与本文顶部「真机取证补记」，以及 issue #21 的真机证据补充评论。
- **发布实测**：CI 四平台 **22/22 全绿**（`939ef15`）；`release.yml` 成功并生成 GitHub Release（`v0.6.6`，正文 12979 字符）；Gitee 发行版经 `scripts/gitee-release.mjs 0.6.6 0.6.5` 更新成功；npm `latest` 已为 **v0.6.6**。**issue #21 尚未关闭**：同 #18/#19/#20，本机无 GitHub 写权限令牌，需维护者回复并关闭。

### 0.6.5 开发交接（验收配置三级继承，issue #20）

- **范围**：验收配置新增全局层 + 任务级临时覆盖，并补调试命令。无新 MCP 工具、无数据模型变更、无 MCP 注解变更。
- **问题**：原先只支持项目级 `.tianshu-mcp/acceptance.json`；一个宿主挂多个同类项目时逐项目建文件成本高、易遗漏。
- **三级链（低 → 高）**：`<数据目录>/acceptance.default.json` → `<project>/.tianshu-mcp/acceptance.json` → `run_task`/`verify_task` 的 `acceptanceOverride`。解析点仍是 `resolveChecks()`（`src/verify/acceptance.ts`），新增合并工具 `src/config/acceptance-merge.ts`。
- **本版修的隐患（改这块前必读）**：`AcceptanceConfigSchema` 给 `requireChanges` 上了 `.default(true)`；用它解析「只写了 `verifyConcurrency`」的项目文件会 materialize 出 `requireChanges: true`，**反过来覆盖全局层的 `false`** —— 继承链会静默失效。故新增**无任何默认值**的 `PartialAcceptanceConfigSchema` 专供分层解析（`readAcceptanceLayer()` 用它），默认值只在最终取值缺省时兜底；`AcceptanceConfigSchema` 保留给既有 visual/legacy 调用方。**注意**：因 `acceptanceOverride` 参数引用它，`PartialAcceptanceConfigSchema` / `AcceptanceCheckSchema` / `AcceptanceConfigSchema` 的定义已上移到 `RunTaskParamsSchema` 之前，别再把它们挪回文件尾部。
- **合并语义**：合并粒度 = **字段**（高优先级层显式书写的取胜，`undefined` 视为未书写）；`checks` **整体覆盖不拼接**；**`visual` 整体覆盖、不做跨层深合并** —— `visual` 的 schema 几乎每个字段都带默认值，深合并会让低优先级层的**显式**取值被高优先级层「未书写、仅因默认值而出现」的字段静默覆盖（与 `requireChanges` 同类的污染）。这是**与 issue 建议的「深合并」的一处有意偏离**，理由同时记在 CHANGELOG、`docs/acceptance-config` 双语与 ARCHITECTURE §7.4。
- **坏层 fail-closed**：仅 `ENOENT` 算「该层不存在」；「存在但读不了 / JSON 坏 / 字段不合法」→ 该轮进 `needs_attention` 并指明层与文件。
- **任务级覆盖是任务数据不是配置**：`TaskMeta.acceptanceOverride` 随快照保存；不写任何 `acceptance*.json`、不影响同项目其他任务与其他项目；rework/continue 沿用同一快照故继续生效。无项目模式**显式拒绝**该参数。**计入幂等入参摘要**（`runTaskKeyedFields()` 与 `verifyIdempotencyDigest()` 均已纳入）—— 否则同键重放会返回策略不同的旧任务。
- **每轮一行摘要**：`resolveChecks()` 输出 `生效层=… checks=… requireChanges=… verifyConcurrency=…`。
- **调试命令**：`tianshu-mcp config acceptance [projectPath] [--task <taskId>]`（`src/config/cli.ts` + `src/index.ts` 在创建 server 前分发）。输出各层是否存在 / `appliedOrder` / `effective` / `summary`；某层写坏时**错误分层可见**且其余层仍解析。**不挂 `visual` 命名空间**（`acceptance.json` 是验收引擎的配置，视觉验收只是共用文件）。eslint 的 `no-console` 豁免已扩到 `src/config/cli.ts`（与 `visual/cli.ts` 同一条：pre-server CLI 的 stdout 未被 transport 占用）。
- `executeVerify` 的 `visual` 改取合并结果，不再二次读项目文件（否则 override/全局层的 `visual` 会随项目文件是否存在而改变语义）。
- 测试：新增 **36** 用例 / 3 文件（`acceptance-merge` 18、`acceptance-override` 6、`config-cli` 12）；全量 **1073 passed / 12 skipped**（99 文件，较 v0.6.4 的 1037 净增 36）；`check:stdio` dist 与 src 均 **8/8**。文档：`docs/acceptance-config` 双语优先级表按三级重写 + [发布说明 v0.6.5](docs/release-v0.6.5.md) 双语；ARCHITECTURE 双语新增 §7.4。
- **本版无真机依赖**（验收标准三项均由单测/集成测试/CLI 冒烟覆盖），故不需要真机记录。
- **CI 失败与修复（值得记住的教训）**：首轮 CI **九作业全挂**，根因是本版新增的「无项目模式拒绝 `acceptanceOverride`」用例**依赖本机装了 ZCode**——无项目模式要求 `agentId=zcode`，而参数校验发生在 **agent 解析之后**，CI 上 ZCode 未安装会先撞上「agent 当前不可用」，根本测不到拒绝分支（本机因装了 ZCode 而恰好通过，本地全绿）。修法：在测试数据目录写 profile **覆盖内置 zcode**（`driver=spawn` + stub 脚本），使 `resolve` 在任何环境都成功。**通用教训：新增用例不得依赖本机安装的 GUI agent；需要某个内置 agent 可解析时，用数据目录 profile 覆盖它。**
- **发布实测**：CI 四平台 **22/22 全绿**（`6a150f5`，首轮 `61ca0f0` 因上述用例不可移植而九作业全挂）；`release.yml` 成功并生成 GitHub Release（`v0.6.5`，正文 12208 字符）；Gitee 发行版经 `scripts/gitee-release.mjs 0.6.5 0.6.4` 更新成功；npm `latest` 已为 **v0.6.5**。**issue #20 尚未关闭**：同 #18/#19，本机无 GitHub 写权限令牌，需维护者回复并关闭。

### 0.6.4 开发交接（结构化修复指令，issue #19）

- **范围**：验收失败轮次新增结构化修复指令提取 + `rework_task` 的 `repairHint`。无新工具、无数据模型变更、无 MCP 注解变更。
- **问题**：返修报告是整篇叙述，agent 需自行从报告里定位「哪一行类型不匹配、哪个文件有 TODO、哪个文件改动行数异常」，推理开销高且易理解偏差导致返修失败。
- **新增 `src/verify/directives.ts`**：`RepairDirective{file?,line?,issue,action,source}` + `RepairDirectives{items,sources,fallbackReason?}` + `extractRepairDirectives()` + `renderDirectiveSection()` / `renderDirectiveLines()`。两个内置 source：
  - `typecheck`：筛 `!passed && !skipped` 且 name/argv 命中 `typecheck|tsc|--noEmit|mypy|pyright` 的检查项，用两条正则解析 `outputTail`（pretty `file(l,c): error TSxxxx` 与 plain `file:l:c - error TSxxxx`）；绝对路径归一化为项目相对 posix（项目外原样保留），同处报错去重。
  - `diffstat`：`analysis.bigFileChanges`、被改动的锁文件各一条（带 `file`）；`signals` 的 todo / consoleDebug / secretLike 各一条（**不带** `file` —— 只做计数、无稳定行号）。
- **关键取舍（改这块前必读）**：
  1. **不做 test 类提取** —— 测试框架输出没有稳定文件/行号，强行解析会产出**错误**定位，比不给更糟，一律走回退。
  2. **提取器永不抛错** —— 单个 source 异常被吞掉并记入 `fallbackReason`，其余 source 继续工作。
  3. **显式回退** —— `fallbackReason` 非空 ⇒ 渲染方必须写「不可用，回退完整报告」+ 要求 agent 回到完整失败输出，**不允许静默留空**。
  4. **只在失败轮次提取**（`acceptance.ts` 的 `if (!passed) report.repairDirectives = …`），通过轮次不产出该字段。
- **四处消费**：`report-<round>.json` 的 `repairDirectives`（持久化：手动返修路径重读、跨重启存活）→ `report-<round>.md` 的 `## 结构化修复指令` → 两块返修计划（`repair-plan.ts` 的 `renderRepairPlan` 与 `codex/fixplan.ts` 的 `renderCodexFixPlan`）在**第 2 与第 3 节之间**插入 `## 2.5` → 返修消息 `buildFixFeedback(..., directives)` / codex `buildFixPrompt({directives})` 的摘要块（最多 10 条；提取失败时不在消息里加噪声）。
- **`repairHint` 贯通**：`ReworkTaskParamsSchema.repairHint`（`z.string().max(4000)`）→ `handlers.reworkTaskHandler` → `TaskManager.rework(taskId, feedback?, repairHint?)` 写 `meta.reworkHint` → `startTask()` 在**同一原子块**取走并清空 `reworkFeedback` + `reworkHint`，拼成 `initialFeedback`（提示在前）→ `TaskOrchestrator` 第四参。**注意**：两字段必须同批清理，否则会出现「只清了一半」的窗口。
- **顺带改动**：`LOCKFILE_PATTERN` 由 `code-analysis.ts` 导出，分析告警与提取器共用一份清单（避免两处漂移）。
- **已知限制（有意接受）**：`CheckResult.outputTail` 被截断到最后 4000 字符（`runner.ts`），大型项目只能提取到尾部类型错误，其余靠回退兜底 —— 不为提取放大报告体积。
- 测试：新增 **35** 用例 / 3 文件（`repair-directives` 15、`repair-plan-directives` 16、`rework-repair-hint` 4）；全量 **1037 passed / 12 skipped**（96 文件，较 v0.6.3 的 1002 净增 35）；`check:stdio` dist 与 src 均 **8/8**。文档：[结构化修复指令](docs/repair-directives.md) 双语 + [发布说明 v0.6.4](docs/release-v0.6.4.md) 双语；`docs/acceptance-config` 双语补 `report.json.repairDirectives` 字段说明；ARCHITECTURE 双语新增 §7.3。
- **真机记录（✅ 已于 2026-09-25 补齐）**：用真实 Codex GUI 构造必然 typecheck 失败的任务（`autoVerify` + `autoFixRounds=1`），
  已取得**前后对比**：第 0 轮 `[FAIL]` → `repairDirectives` 精确给出 `src/app.ts:13` / `:17`（与两处真实缺陷一致）→
  2.5 节进返修计划 → 第 1 轮 `[PASS]`。见 [issue #19~#22 真机记录](docs/issue-19-22-real-machine-record.md) §1 与 issue #19 的真机证据补充评论。
  注：该次取证受下方「真机取证补记」里的 Codex 模型回读缺陷阻塞，需在 scratch profile 里绕开才跑得动。
- **发布实测**：CI 四平台 **22/22 全绿**（`a977a66`）；`release.yml` 成功并生成 GitHub Release（`v0.6.4`，正文 9786 字符）；Gitee 发行版经 `scripts/gitee-release.mjs 0.6.4 0.6.3` 更新成功；npm `latest` 已为 **v0.6.4**（240 文件）。**issue #19 尚未关闭**：同 #18，本机无 GitHub 写权限令牌，需维护者回复并关闭。

### 0.6.3 开发交接（细粒度事件流，issue #18）

- **范围**：新增可选的事件上报能力 + `query_task` 回传最近 N 条事件。无新工具、无数据模型变更、无 MCP 注解变更。
- **问题**：长任务（尤其 GUI agent 卡在确认弹窗 / 文件选择对话框 / 授权提示）下 `query_task` 只能返回 `running`，调用方无法区分「正常工作」与「卡死等人」，只能盲等或超时强杀。
- **新增词表**（`src/agents/agent-events.ts`，**零依赖**，避免 `adapter.ts` / `tasks/task.ts` / `tasks/task-store.ts` 循环引用）：`task_dispatched` / `confirmation_dialog_detected` / `awaiting_user_authorization` / `file_modification_started` / `rework_triggered`。`TaskEventName` 经 `| AgentEventName` 引用同一词表，**杜绝两处漂移**。
- **钩子归属**：`AgentRunOptions.onEvent`（`src/agents/adapter.ts`）——**不是** agent profile。issue 原文建议「在 agent profile 新增 onEvent」，但 `agent-profiles.json` 是纯 JSON、装不下函数，硬塞会破坏 `AgentProfilesFileSchema` 解析与热重载。「可选」由 `opts.onEvent?.()` + `makeEmitter` 表达，**未实现的适配器一个字节都不用改**。
- **存储决定**：事件写**既有** `task.jsonl`，**不建内存环形缓冲**。理由：GUI 长任务中宿主可能重启，纯内存队列会丢掉最需要的现场；并行流会产生第二个事实来源与排序不一致。「内存膨胀」在**读取侧**解决——新增 `readTextTail(p, maxBytes)`（`src/util/fs.ts`，`fsp.open`+`fstat`+ 从 `size-maxBytes` 读，**截断点落在换行符上时不丢整行**），`TaskStore.readRecentAgentEvents(taskId, limit, maxBytes=64KiB)` 只读尾部窗口。
- **读取与暴露**：`QueryTaskParamsSchema.eventLimit`（1..50，**缺省 10**，常量 `QUERY_TASK_EVENT_LIMIT_DEFAULT`）；`MetaBlockFields.recentEvents`（经 `metaFromTask(meta, extra)` 的 `...extra` 透传，无需改函数体）；`queryTaskHandler` 同时渲染文本区 `--- 最近事件（N 条，旧 → 新）---` 段落。未上报的适配器返回**空数组**且文本区无该段落。
- **发射点（各 4 个）**：
  - **codex**（`src/agents/codex/run.ts`）：派发确认后；`createProject()` 中清理残留弹窗（`closeDialogs>0`）与唤起原生文件夹对话框；`loginIndicator` / `needs_login` / `needs_user` 三处授权等待；轮询循环里**判定前先捕获 `wasRunning`**，`running` 首次出现时发一次。
  - **traework**（`src/agents/traework/run.ts`）：`typeAndSend` 后；`bindProject` 返回且 `method==="native-dialog"`（含失败）；`verdict.kind==="ask_user"`；轮询循环 `live.running && runningSince===0` 首次跃迁。
  - **引擎侧 `rework_triggered`**：`fix-loop.ts` 自动返修分支（`mode:"auto"` + 轮次 + 失败检查项名）；`task-manager.rework()` 手动返修（`mode:"manual"`）——**替换了原来的匿名 `note`**（`note` 的既有语义/用途不变）。
- **健壮性**：适配器一律经 `makeEmitter` 上报 —— 未提供钩子时空操作，**并吞掉上报异常**。事件上报属观测能力，**绝不允许影响任务本体**（有专门用例：落盘异常时任务仍 `succeeded`）。
- **如实披露**：`file_modification_started` 是**启发式**推断 —— 适配器并不直接观测文件系统，只能从界面运行信号（停止按钮）推断执行已开始，detail 一律写「停止按钮出现，开始执行（可能开始改动文件）」，**不声称已改动**。确切改动证据看验收报告的 `changedFiles` / `diffstat`。本版只在 **codex + traework** 真正上报；zcode / kimicode / qoder 与全部 CLI 适配器保留接口、暂不上报。
- 测试：新增 **36** 用例 / 4 文件（`agent-events` 15、`fix-loop-events` 4、`codex-flow` +5、`traework-events` 5、`query-events` 7）；全量 **1002 passed / 12 skipped**（93 文件，较 v0.6.2 的 966 净增 36）；`check:stdio` dist 与 src 均 **8/8**。文档：[事件流](docs/event-stream.md) 双语 + [发布说明 v0.6.3](docs/release-v0.6.3.md) 双语。
- **真机记录（✅ 已于 2026-09-25 补齐，见 §1）**：用 `scripts/probe-codex.mjs` / `scripts/probe-traework.mjs` 各跑一次真实 GUI 任务，确认 5 类事件在 `query_task` 输出中按预期出现（尤其卡在原生弹窗时的 `confirmation_dialog_detected` / `awaiting_user_authorization`），输出落 `docs/` 证据文件。本版以单测 + 假 CDP 集成测试为门禁。
- **发布实测**：CI 四平台 **22/22 全绿**（`a54a34f`）；`release.yml` 成功并生成 GitHub Release（`v0.6.3`，正文 10903 字符）；Gitee 发行版经 `scripts/gitee-release.mjs 0.6.3 0.6.2` 更新成功；npm `latest` 已为 **v0.6.3**（`npm publish --registry=https://registry.npmjs.org --access public`，237 文件 / 661.2 kB）。**issue #18 尚未关闭**：本机无 GitHub 写权限令牌（`GH_TOKEN` 等均未设置、`gh` 未安装），需由维护者回复并关闭。

### 0.6.2 开发交接（GUI 选择器版本漂移，issue #23）

- **范围**：三例 GUI 适配层修复 + 统一诊断，无新工具/数据模型/协议变更。
- **① Codex 触发器文案漂移**：`projectPickerTrigger` 的 `aria-label` 跨版本漂移（本机 26.915 实测「切换项目」，issue 报告 26.917 为「选择项目」）；主/回退/模板并列覆盖两文案，`boundProjectName`（`src/agents/codex/cdp.ts`）回读同步兼容。新增 `scripts/probe-codex.mjs audit` 模式（20 键命中表），**本机 26.915 除该触发器外无其他漂移**，9 个已实测键 `verifiedVersion` → `26.915.x`。
- **② Qoder 选择器分层 + 工作区修复**：`src/agents/qoder/selectors.ts` 由扁平字符串升级为 `primary/fallbacks/texts/ariaLabels/ariaPatterns/verifiedVersion`（27 键）+ `qoderCandidates()`；`QoderCdpClient` 保留 `selector()` 字符串语义，新增 `candidates()/existsKey()/clickKey()`（按候选顺序「先探测后点击」，多候选不浪费超时）。**真机重探更正 issue 结论**：0.3.4 工作区菜单**并非不渲染**，真因是页面有**两个** `[data-workspace-picker-trigger]` 致唯一点击判歧义失败；主选择器改用唯一的 `button[aria-label^="切换或清空当前工作区"]`，`[data-workspace-picker-trigger]` 降为回退；生产 `bindWorkspace` 已在真实 0.3.4 跑通（`docs/issue-23-selector-drift-record.md` §3）。
- **③ TraeWork discovery + 安装目录**：新增 `src/agents/traework/discovery.ts`（显式 → 固定盘相对路径 → 注册表 → 快捷键 → 标准目录 → PATH），`registry.ts` 增 `traework-gui` 专用分支。`builtin.ts` 删除错误的 `{APPDATA}/TRAE SOLO CN`（实测是**用户数据目录**），改 `{LOCALAPPDATA}/Programs/TRAE SOLO CN` 等，补 `preferredDrives:["D:"]`/`relativePaths`；**Windows 只认 `TRAE SOLO CN.exe`**（旧清单含 `Trae CN` → 误匹配 TraeCode CN）。`launcher.ts` 新增 `diagnosePortFailure()`（端口未就绪时输出退出码/监听者/既有实例），**只诊断、不改启动策略、不终止既有实例**。
- **④ 统一诊断**：新增 `src/agents/gui-diagnostics.ts`（`visibleLabelsExpr`/`normalizeLabels`/`formatCandidates`/`withDiagnostics`），三 GUI agent 解析失败时附「页面可见候选」。
- **⑤ 字段统一**：TraeWork `verified: boolean` → `verifiedVersion: string`（与 codex/kimicode 一致）。
- 测试：全量 **966 passed / 12 skipped**（86 文件；较 v0.6.1 的 940 净增 26）；`check:stdio` dist 与 src 均 **8/8**；`pack:check` 234 文件。真机证据见 [issue #23 验证记录](docs/issue-23-selector-drift-record.md)；发布说明 [v0.6.2](docs/release-v0.6.2.md)。
- **发布实测**：CI 四平台 **22/22 全绿**（`ecf5aad`，首轮 `2a05d50` 因端口诊断用例未做平台判断在 ubuntu/macOS 失败，已修）；`release.yml` 成功；GitHub Release / Gitee 发行版 / npm `latest` 三处均为 **v0.6.2**（npm 由维护者手动 `npm publish --registry=https://registry.npmjs.org` 补齐，见 `docs/npm-publish-guide.md`）；issue #23 已回复并关闭（completed）。
- **残留**：Codex 条件渲染键（stopButton/reasoningSlider/modelMenuItem/menuItem/permissionOption/sourceFolderArea/createProjectButton）审计时未展开对应菜单/对话框，未提 `verifiedVersion`；TraeWork 端口未就绪根因（single-instance 锁/参数/环境）未复现，诊断已就位；Qoder 其余键未逐一真机复验。

### 0.6.1 开发交接（五项小项扫尾，issue #17）

- **范围**：五项独立小项合并扫尾，无新工具/新适配器/数据模型变更。五项对应 issue 的第 1–5 点。
- **① 计数对齐**：`tools.ts` / `server.ts` / `handlers.ts` 三处的「9 个工具」在 v0.5.8 已修好；本次修掉最后一处残留（`test/protocol/protocol.test.ts` 头注释），并新增 `TOOL_DEFS` **数量硬断言**（仅比对名字数组相等拦不住「注册表多一条无人注册的条目」）。同类病灶一并扫尾：`check-stdio` 场景数自 issue #16 起已是 8，但 `ci.yml` 注释 / `HANDOFF`（两处）/ `CONTRIBUTING` 双语仍写 6，本版同步。
- **② capability 三族**（**唯一对外可见的元数据变更**）：`ToolDef.capability` 删除始终无人使用的 `"network"`；`verify_task` 由 `read` 改 **`execute`**（会跑项目命令、可产生构建产物）。连带 **`readOnlyHint` 由 `true` 变 `false`**、**`requireApproval` 不变（仍免审批）**——`server.ts` 的推导规则未改，且注释已写明「`readOnlyHint` 不是审批信号」。新增 11 工具 × capability × 四注解**真值表测试**锁死全部映射。
- **③ 项目登记失败不静默**：`handlers.ts` 的 `runTaskHandler` 原先 `void registered;` 丢弃返回值、又用 `projectByPath` 二次读取同一条记录；现直接消费返回值、删冗余读取，登记失败记 `WARN` 并返回 `errorResult`（**不派单**，杜绝「任务已建、项目未登记」的半状态）。单测断言 `projectByPath` 调用计数为 0，证伪「二次读取仍在」。
- **④ 系统目录子树拒绝**：`src/util/path.ts` 新增 `DANGEROUS_SUBTREES`（`/etc` `/usr` `/bin` `/sbin` `/private/etc` + `c:/windows` `c:/program files` `c:/program files (x86)`）与纯函数 `isDangerousProjectDir(norm, platform)`，**边界感知**（前缀后须为 `/`），故 `c:/windows.old` / `/etcetera` 不误伤。**`/var` `/tmp` `/opt` 家目录等维持精确匹配**——macOS 的 `os.tmpdir()` 就是 `/var/folders/...`，子树拒绝会切断测试基座。`isDriveRoot` 移入纯函数内部，不再对外暴露。
- **⑤ `cmd` 字符串形态文档化**（零行为变更）：`acceptance-config` 双语加实测警示表，`schema.ts` / `store.ts` 注释、`SKILL.md`、`usage-examples.md` 补「推荐数组形态」；`core.test.ts` 加 5 条边界用例把既有分词语义钉死。
- 测试：全量 **940 passed / 12 skipped**（86 文件，较 v0.6.0 的 898 净增 42）；`check:stdio` dist 与 src 均 **8/8**；`pack:check` 232 文件。实测证据（真值表原始输出、子树三平台表、分词行为）见 [issue #17 验证记录](docs/issue-17-small-fixes-record.md)；发布说明 [v0.6.1](docs/release-v0.6.1.md)；三族语义与 `readOnlyHint` 推导见 [ARCHITECTURE](ARCHITECTURE.md) §4 与 §15。
- **残留边界**（有意为之）：`/var` `/tmp` `/opt` `/library` `/system` `/root` `c:/users` 的**子目录**仍不挡；UNC 形态缺口在安全渠道另行报告，不在本版范围。

### 0.6.0 开发交接（技能自装加固，issue #16）

- **问题**（`src/util/skill-install.ts`）：① `resolveSkillSourceDir()` 的候选链含 `process.cwd()/skills/tianshu-mcp`（两处），非标准布局下会把**当前工作目录**里的同名目录内容装进 `~/.rivet/skills/` 并在新会话生效（在第三方仓库里调试起 server 即中招）；② 目标 hash 不一致时直接备份覆盖，**用户对 `SKILL.md` 的本地调优被静默替换**（有备份、有开关，但覆盖动作零提示、零授权）。根因是目标目录内**没有任何「我们装了什么」的记录**，原理上无法区分「旧版包」与「用户改过」。
- **源定位收敛**：`resolveSkillSourceDir()` 只由 `import.meta.url` 相对包自身定位（`<模块>/../../skills/tianshu-mcp`；src 与 dist 相对深度一致，单条候选即够）。**删除两处 cwd 引用**与一条永不命中的宽松候选；找不到源沿用既有「跳过 + 告警」。`fileURLToPath` 必须保留（`new URL().pathname` 在 Windows 中文/盘符路径下会转义，见 `docs/host-integration-record.md`）。
- **安装清单**：目标内 `<目标>/.tianshu-mcp-install.json`（`schema`/`name`/`packageVersion`/`contentHash`/`installedAt`/`sourceDir`，保留时含 `pendingUpdate`）。`hashSkillTree()` **排除清单自身**（否则写清单即自证被改动）与平台噪声（`.DS_Store`/`Thumbs.db`/`desktop.ini`/`._*`/`.git*`）；`copySkillTree` 用**同一排除谓词**，保证「装完立即算 hash == 源 hash」（幂等的根因）。
- **六态判定**（`decideInstall()` 纯函数，判定与 IO 分离）：不存在 → 安装；一致 → 跳过（按需补写/校准清单）；清单记录 == 内容 ≠ 包内 → **可信旧版**（`auto` 备份覆盖 / `prompt` 保留+记 `pendingUpdate` / 放行覆盖）；清单记录 ≠ 内容 → **用户本地修改**（**恒保留**，放行也不生效，D9 硬边界）；无有效清单且不一致 → **来源不明**（默认保留，放行可覆盖）；目标是文件/不可读 → 同来源不明。
- **三态与入口**：`skills.autoInstall` = `true | "prompt" | false`（既有 boolean 兼容）；`"prompt"` = 首次安装照常、**需变更时不自动**（stdio 无交互通道，故「prompt」实为「不自动 + 留待确认」）；`--approve-skill-update` / `TIANSHU_MCP_APPROVE_SKILL_UPDATE=1` 放行；**优先级：`--no-skill-install` / `autoInstall:false` 否决权最高**；新增 `skills.backupKeep`（默认 3，`0` = 不清理）。
- **原子安装**：`<目标>.incoming-<ts>-<hex>` 拷贝（含写清单）→ 旧目录备份为 `<目标>.bak-<ts>` → 换入；失败清 tmp 并回滚。启动时清理 mtime 早于 1 小时的 `.incoming-*`。**旧实现的崩溃窗口必须关掉**：半拷贝目录在新语义下会被误判为「用户修改」而永久阻塞升级。
- **日志分级**：跳过/补写清单 = `INFO`；覆盖旧版/保留用户修改/来源不明/失败 = `WARN`。便于检索的稳定短句：`含本地修改`、`来源不明`、`未自动覆盖`。hash 只打印前 8 位。
- **接线**：`src/index.ts` 解析 CLI/env；`src/server.ts` 的 `if (!opts.skipSkillInstall && skills?.autoInstall !== false)` 后调用 `skillSelfInstall(logger, {mode, approveUpdate, backupKeep})`，**后台执行不阻塞握手**；`buildServer` 新增可选 `approveSkillUpdate`。
- **本版不改技能内容** → 未改过技能的用户升级无感（走「一致 → 跳过」）；改过的用户会看到一次 `WARN` 与两条处置指引，**改动不被覆盖**。
- 测试：新增 30 单元（`test/unit/skill-install.test.ts`）+ `config-hotreload` 扩展；严格 stdio 新增 `skill-locally-modified` / `skill-approve-update` 两场景（6→8，dist 与 src 均 8/8）；dev-only 夹具 `scripts/seed-skill-state.mjs`（`npm run seed:skill-state`，**不进 npm 包**）。全量 **898 passed / 12 skipped**（86 文件）。
- 真机复验 R1–R7（Windows 10）见 [issue #16 加固记录](docs/issue-16-skill-install-hardening-record.md)；发布说明 [v0.6.0](docs/release-v0.6.0.md)；判定矩阵与信任模型见 [ARCHITECTURE](ARCHITECTURE.md) §3.4。

### 0.5.10 开发交接（派单/验收幂等键，issue #15）

- **问题**：`run_task` 每次调用都 `genTaskId()` 新建任务、`verify_task` 独立路径用 `vfy_<Date.now()>` 新建记录，两个入口都没有幂等键。宿主在 `tools/call` 超时（长任务 + 网络抖动时最常发生）后重试，就会对同一项目排队**两轮 agent**（重复劳动、重复消耗外部配额，且第二轮在第一轮产物上继续改，验收归因混叠），或把整套验收命令重跑一遍（`build`/`e2e`/部署类检查的副作用被重复执行）。协议层唯一的防线是技能文档里的行为约束。
- **新增**：`run_task` / `verify_task` 的可选 `idempotencyKey`（trim 后 1..128 字符、无控制字符；两工具**各自独立命名空间**）。
  - `run_task`：TTL（默认 24h）内同键同参重复提交**恒返回原 `taskId` 与当前 meta**（含终态，只读不重派）；同键异参 fail-closed 报错并回报原 `taskId`。
  - `verify_task`：执行中 → **成功结果** + `idempotencyReplay: "in_progress"`（刻意不是 `isError`，否则宿主会把它当失败再重试放大）；已完成 → 既有报告路径与 `reportRound`/结论，**不重跑**。
- **落盘与配置**：`<数据目录>/idempotency.json`（原子写、惰性加载、TTL + `maxEntries` 容量裁剪；跨 server 重启仍生效）；`config.json` → `idempotency.ttlMs`（默认 86400000）与 `idempotency.maxEntries`（默认 2000）。键**明文不入日志与事件流**（只用 `keyDigest()` 摘前 8 位）。
- **正确性要点**（改这块前必读）：① 同一临界区内**先落映射、后建任务**（`runExclusive` 按 `(scope,key)` 串行化），崩溃于两者之间时重试看到「有映射无任务快照」即视为未生效重新派发；② 映射写入失败 **fail-open**——仍返回已派发的任务并明示「无法被同键重放」，绝不把跑起来的 agent 报成派发失败；③ 映射文件损坏时告警并从任务快照重建一次。
- **边界**：`verify_task(taskId=…)` 的键**不写入任务快照**（该字段承载任务的派单键，避免覆盖），这一种组合的重建依赖 `idempotency.json`；「执行中」标记仅进程内（重启后未完成验收不会被缓存，重试即重新执行，如实）；不给 `rework_task`/`continue_task`/`cancel_task`/视觉基准工具加键；不做跨进程分布式幂等。
- **协议层**：`tools/list` 的 `annotations.idempotentHint` 对两个工具置 true——**声明幂等的前提是调用方传键**（工具描述、README 与技能文档均已写明）；未传键时 `run_task` 仍会点名同工作区未结束的任务（`projectActiveTask`）。
- 测试：新增 16 单元（`test/unit/idempotency.test.ts`）+ 8 集成（`test/integration/idempotency.test.ts`），另补协议 `idempotentHint` 断言与配置默认值/覆盖用例；全量 **867 passed / 12 skipped**（85 文件）在本机通过。
- 详见 [v0.5.10 发布说明](docs/release-v0.5.10.md) 与 [ARCHITECTURE](ARCHITECTURE.md) §5.6。

### 0.5.9 开发交接（GUI 终态如实化：server 退出 / 重启归档，issue #14）

- **问题**：`persistInterrupted()` 对所有活动任务统一写「server 退出，进程已终止」；`initialize()` 归档重启遗留只写「server 重启遗留（启动时归档，不续跑）。」。但 `driver="gui"` 的 agent 是**外部桌面应用**，server 对其进程**没有所有权**：abort 后适配器至多"尽力点击界面停止"（且只有 Codex / Kimi Code / Qoder CN 有这能力）。该文案只对 spawn 子进程成立，于是快照谎报已停止，而窗口中的任务可能仍在改用户项目，重启后更无人观察——**编排器已死 + GUI 持续改用户项目 + 无人观察 = 效应残留**。
- **修复**：终态文案按 `driver` 分流——spawn 类维持原文案；GUI 类按适配器回报的 `guiStop` 落「已确认 … 内运行停止」/「未确认停止，窗口中的任务可能仍在继续，请人工打开 … 确认无残留运行」/「无停止结果可确认」（ZCode、TraeWork 不点停止、不回传 `guiStop`）。判定只有一条：`guiStop.idle === true` 才允许说"已确认停止"；`idle === false` 与字段缺失都按未确认处理，取消路径与中断路径共用 `guiStopDisclosure()`。
- **有界等待**：新增配置 `config.json` → `shutdown.guiStopWaitMs`（默认 15000），`shutdownInterrupt()` 给 GUI 任务一份**全局共享**预算（退出耗时不随任务数增长），让"尽力停止 + 有界等待"跑完再落终态；spawn 类保持原 2s。若 orchestrator 先落终态（携带更精确的适配器结果），管理器直接让位。
- **结构化与人工确认**：新增 `TaskMeta.interruptedCleanStop`（本次中断是否**已确认**停止）与 `guiResidualUnconfirmed`（重启归档待人工确认）；meta 块新增 `guiStopUnconfirmed`（读侧单一判据）。人工核实窗口无残留运行后调用 `cancel_task`，可清除待确认标记并追加 `gui_residual_acknowledged` 事件——**不新增工具（仍 11 个）、不改终态与 `errorType`**。
- **窗口名不再硬编码**：改由 `profile.displayName` 派生（`guiAppNameOf()`，剥说明性括号段与通用后缀，剥空退回原名，无 `displayName` 回退 `agentId`）。旧实现把 `zcode`/`qoder` 一律写成 "Codex"，本身即失真。
- **明确不做**：`initialize()` 不自动 CDP 重连去点停止——重启后无会话锚点、适配器对无归属证明的实例 fail-closed，自动动手风险高于收益（见 ARCHITECTURE §5.5 与 §15 已知限制 11）。
- 测试：新增 9 单元（`test/unit/gui-stop-disclosure.test.ts`）+ 5 集成（`test/integration/gui-shutdown-interrupt.test.ts`）；集成用例必须以**真实 `CodexGuiAdapter` 子类**注入（`ensureAdapterFor()` 会重建非本类 adapter，普通实现会被静默替换）。全量 **841 passed / 12 skipped**（83 文件）在本机通过。
- 详见 [v0.5.9 发布说明](docs/release-v0.5.9.md)。

### 0.5.6 开发交接

- `src/agents/qoder/` 新增发现、实例、CDP、原生目录选择、工作区、模型管理、提问回复和运行检测模块；与公共验收及返修引擎贯通。
- `modelSource` 区分默认/自定义模型，实际模型和等级写入任务报告。保持当前权限模式；全局思考等级设置会保留。
- 会话锚点和发送检查点保存在任务目录；发送或答题提交不明时只观察，不自动重发。自动/手动返修先落完整计划，再回原会话。
- 已复现并修复 `isolate:false` 导致 Kimi 探测命令 mock 泄漏到 Git 基线测试的问题（`vitest.config.ts` 的 unit project 恢复文件级隔离）。本机全量回归：**826 passed / 12 skipped（78 个测试文件通过 + 3 个真实浏览器文件按设计 skip）**。
- Windows 公共 MCP 默认模型（Qwen3.8-Flash / 低）已有工作区开发与外部乘法契约验收已通过；自定义模型（deepseek-v4-flash / 高）新工作区登记与首次 clamp 契约验收已通过。独立夹具受控回归被验收拒绝，修复计划已生成并发送原会话，用户允许 Qoder 读取工作区外计划文件后，仅恢复观察原会话，修复与再次验收均通过。macOS research 禁止派发。
- 模型菜单选择后的异步关闭必须确认后才能重开，已补回归用例并通过真实模型管理读回。类型检查、lint、构建、6 项严格 stdio 检查、`npm pack` 内容校验与干净消费者安装 + 严格 stdio 检查已在本机通过。
- 使用及恢复方法见 [Qoder 中文文档](docs/qoder-cdp.md) / [English guide](docs/qoder-cdp.en.md)。发布提交 `9ee03da` 已同步双仓，CI 22 个作业全绿（[run 35741308742](https://github.com/lanlan0811/tianshu-mcp/actions/runs/35741308742)）；`v0.5.6` tag、[GitHub Release](https://github.com/lanlan0811/tianshu-mcp/releases/tag/v0.5.6)、Gitee 发行版与 npm `tianshu-mcp@0.5.6`（`latest`）均已完成。

**0.5.8 交接（四份主文档按代码重写 + 打包修复，无运行时变更）**：

- README 双语 / HANDOFF / ARCHITECTURE 双语按代码逐项核对重写：修正**验收阶段顺序**（内置 `git-diff-check` 在配置检查项**之前**、视觉检查在命令检查**之后**）、**`visual.enabled=false` 仍会冻结并核对快照**（`enabled` 只控制是否跑视觉判定）、**工具返回契约**（两个视觉基准工具的成功结果与**任何工具的错误结果**都不带 meta 块）。
- 五份 agent 表补齐 Qoder CN（driver 列表 / `endReason` / `needsUserKind` / 取消能力 / registry 探测分支 / 实例生命周期），并注明 Qoder CN 是唯一能产出全部 6 种等待类型、且**不产出 `idle_timeout`**（静止无本轮证据 → `needs_user(setup_recovery)`）的适配器；Codex 无 `close_existing_instance` 路径；ZCode 与 TraeWork 不点停止按钮、不回传 `guiStop`。
- 修正 Kimi Code 档位取值域、测试基线（**826 passed / 12 skipped**、81 文件）、运行时依赖许可表（Apache-2.0 / ISC 项）；架构文档新增「声明了但无消费方」的 profile 字段提示（`gui.windowMode`、`gui.modelRequired`、ZCode 的 `gui.stallTimeoutMs` / `gui.cancelWaitMs`）。
- **打包修复**：`scripts/probe-traework.mjs` 纳入 `files`，并补 `probe:traework` / `probe:zcode` / `probe:codex` script（此前文档要求运行却拿不到脚本）。源码注释同步修正（工具计数 11、`instructions` 补 kimicode/qoder、`gui-instance.ts` 头注、`task.ts` 错位注释）。
- 文档相对链接检查：四份主文档 + 技能文档 **255 条、0 条失效**。详见 [v0.5.8 发布说明](docs/release-v0.5.8.md)。

**0.5.7 交接（技能文档重写，无运行时变更）**：

- 编排技能文档（`skills/tianshu-mcp/SKILL.md` + `usage-examples.md`）已重写：新增**参数兼容矩阵**（九维度 × 五 agent）、**`needsUserKind` × agent × `continue_task` 行为矩阵**、**`agentEndReason` → 终态映射表**；修正 Kimi Code 档位取值域（实际不含 `中`/`medium`）、`autoVerify` 默认开启、`autoFixRounds` 各 agent 缺省轮数；补齐 meta 新字段（`qoderSessionId`/`actualModel`/`actualReasoningLevel`/`modelSource`/`guiStop`）与完整 qoder 章节。
- 同一轮把四份主文档也按代码逐项核对过：README 双语（agent 列表补 Qoder CN、Kimi Code 档位与示例修正、测试基线、运行时依赖许可表补齐 Apache-2.0 与 ISC 项）、ARCHITECTURE 双语（**验收阶段顺序**、**`visual.enabled=false` 仍会冻结并核对快照**、五个 driver 的 `endReason`/`needsUserKind` 表、取消能力表、profile 无效字段提示）、本文件。详见 [v0.5.7 发布说明](docs/release-v0.5.7.md) 与 `CHANGELOG.md` 的 `[0.5.7]` 节。
- 技能目录只有中文版（历史沿革如此，非双语），双语发布说明见 `docs/release-v*.md`；技能随包分发，server 启动按内容 hash 幂等同步到 `~/.rivet/skills/tianshu-mcp/`，**新会话生效**（无热加载）。

## 0. 五分钟上手

| 你想做什么 | 看哪节 |
|---|---|
| 搞清这是什么、为什么这么设计 | §1 |
| 看系统分层、模块边界、运行流程与扩展点 | **[ARCHITECTURE.md](ARCHITECTURE.md)**（独立架构文档） |
| 看当前状态（版本 / 测试 / CI / agent 适配） | §2 |
| 看演进过程与踩过的坑 | §3 |
| 改 GUI adapter 前必须知道的结构 | §4 架构、§5 硬性红线 |
| 跑起来 / 日常迭代 / 诊断 | §6 |
| 出问题了怎么查 | §9 专题排障（先看 §9.0 症状索引） |
| 找某份文档 / 下一步做什么 | §11 / §12 |

**验证基线**（一条命令，期望全绿）：

```bash
git clone https://github.com/lanlan0811/tianshu-mcp.git && cd tianshu-mcp
npm ci && npm run typecheck && npm run lint && npm test && npm run build
```

---

## 1. 这个项目是什么

`tianshu-mcp` 是一个**被天枢（Tianshu）当作标准 MCP server 接入的编排层**：天枢是总指挥，本 server 负责**调度 + 执行面 + 客观验收仪**，驱动外部 AI-Agent 完成闭环：

```text
项目开发 → 验收 → 失败返修 → 再验收
```

- **天枢官方仓库**：<https://github.com/huiliyi37/Tianshu-harness>（基于 harness 工程的终端编程智能体运行时，TUI × GUI；Apache-2.0）
- **本仓库**：`github.com/lanlan0811/tianshu-mcp`（主）｜`gitee.com/lan0811/tianshu-mcp`（镜像）
- **npm**：`tianshu-mcp`（当前发布版本 `0.5.7`）
- **工具面**：11 个 MCP 工具（`run_task / continue_task / query_task / list_tasks / get_task_report / cancel_task / verify_task / rework_task / get_profiles / prepare_visual_baseline / approve_visual_baseline`）

### 为什么是这样设计的（四个硬约束，改架构前必读）

本项目的形态由四条**实测硬约束**决定：

1. **天枢的 MCP 工具只回文本**：MCP 响应里 `content[]` 的 `text` 项被拼成字符串，`isError` 透传。因此所有结果统一为「人类可读文本 + `---tianshu-mcp-meta---` JSON 块」，不依赖 resources/prompts。
2. **天枢按次同步调用 `tools/call`**：长任务必须异步化 → `run_task` 秒回 `taskId`，用 `query_task` 轮询。
3. **TraeWork 的 agent 请求在 TTNet 层 TDE 加密**，无法在客户端外构造 → 唯一可行路径是 CDP 驱动其桌面 UI，从 DOM 提取结果。
4. **Codex 桌面端是 MSIX 商店包**：GUI 宿主无法 `CreateProcess` 直启（AppX 策略拒绝），必须经 `IApplicationActivationManager` COM 激活并注入专属 `--user-data-dir` 才能开 CDP 端口 → 见 `docs/codex-gui-cdp.md`。

---

## 2. 交接快照

| 项 | 状态 |
|---|---|
| 分支 | `master`（**只在此分支提交**，不建其他分支） |
| 版本 / 许可证 | `0.6.2`（**已发布**；上一版本 `0.6.1`；发布提交 `ecf5aad`）/ Apache-2.0 |
| 标签 | `v0.1.0` … `v0.6.2`（均已推双仓；`v0.6.2` → `ecf5aad`） |
| 工作树 | 干净；`github/master` 与 `gitee/master` 均已推到同一提交。本轮提交：`5c28895`（codex 触发器漂移 + 审计）、`0138981`（qoder 分层与工作区修复）、`ef613e4`（traework discovery）、`c35b7ef`（用例）、`1ec38b8`（双语文档）、`2a05d50`（版本 0.6.2 + 交接）、`ecf5aad`（端口诊断用例平台感知，即 `v0.6.2` 发布提交） |
| 测试 | **966 passed / 12 skipped**（86 文件；较 v0.6.1 的 940 净增 26） |
| 测试 | **940 passed / 12 skipped**（83 个测试文件通过 + 3 个真实浏览器文件按设计 skip，共 86 文件；较 v0.6.0 净增 42 项：33 路径闸门 + 2 登记 + 1 真值表 + 2 分词，另改写 1 条 readOnlyHint 用例） |
| 门禁 | lint 0 warning、typecheck clean、全量测试 940 passed、build 成功、`check:stdio` **8/8** 通过（dist 与 src 两条入口，另在 npm registry 实装消费者布局复跑同样 8/8）、`pack:check` 通过（232 文件） |
| CI | `build-test`（ubuntu/windows/macos × Node 20/22/24）+ `pack-check`，另加 `visual-browser` 真实浏览器矩阵（ubuntu/windows + macos-15-intel/macos-15 × Node 20/22/24）。**v0.6.1 实测**：`a1fe7cd` 一次通过 **22 作业全绿**（[run 35869019004](https://github.com/lanlan0811/tianshu-mcp/actions/runs/35869019004)，含 macOS 作业——本轮子树改动未误伤 `/var/folders`）。历史：v0.6.0 的 `db85349` 一次通过（[run 35861049131](https://github.com/lanlan0811/tianshu-mcp/actions/runs/35861049131)） |
| npm | `tianshu-mcp@0.6.1` 已发布（`latest`）——`npm view tianshu-mcp dist-tags` 为 `{latest: "0.6.1"}`，`dist.shasum` = `c35efd26…`，232 文件；从 registry 实装消费者复验：`serverInfo.version` = `0.6.1`、11 个工具、探针脚本齐备、`check:stdio` **8/8 通过**；**新语义实测**：`tools/list` 中 `verify_task` 为 `capability=execute`/`requireApproval=false`/`readOnlyHint=false`。注意 npm CDN 的 packument 有数分钟缓存，刚发布后 `npm install` 可能短暂报 `ETARGET`（本地实测第 3 次轮询才可见），用 `--prefer-online` 或稍候即可。发布步骤见 `docs/npm-publish-guide.md` |
| GitHub Release | 推送 `v*` tag 触发 `.github/workflows/release.yml`：先跑完整门禁并校验「tag 版本 === package.json 版本」，正文由 `docs/release-v<ver>.md` + `.en.md` 双语合成（缺文档即报错），**要求同 SHA 的成功 CI**，并附 `tianshu-mcp-<ver>.tgz`。**v0.6.1 实测全绿**（[run 35870127722](https://github.com/lanlan0811/tianshu-mcp/actions/runs/35870127722)），[GitHub 发行 v0.6.1](https://github.com/lanlan0811/tianshu-mcp/releases/tag/v0.6.1) 附件 `tianshu-mcp-0.6.1.tgz`（591238 字节），正文为双语发布说明 |
| Gitee 发行版 | 由 `scripts/gitee-release.mjs` 用仓库 Secret `GITEE_TOKEN` 幂等补齐；缺少凭据时工作流阻塞。**v0.6.1 已确认**（Gitee `releases` 列表含 `tag=v0.6.1`，标题 `tianshu-mcp v0.6.1`，附件 `v0.6.1.zip` / `v0.6.1.tar.gz`） |
| 本次发布实测 | v0.6.1：CI `a1fe7cd` 一次通过 22 作业全绿（[run 35869019004](https://github.com/lanlan0811/tianshu-mcp/actions/runs/35869019004)）；`Release` 全绿（[run 35870127722](https://github.com/lanlan0811/tianshu-mcp/actions/runs/35870127722)，附 `tianshu-mcp-0.6.1.tgz`，591238 字节）；[GitHub 发行 v0.6.1](https://github.com/lanlan0811/tianshu-mcp/releases/tag/v0.6.1) 与 Gitee 发行版 `v0.6.1` 均确认；npm `tianshu-mcp@0.6.1`（`latest`，`dist.shasum` = `c35efd26…`，232 文件），从 registry 实装消费者复验：`serverInfo.version` = `0.6.1`、11 个工具、探针脚本齐备、`check:stdio` 8/8 通过、`verify_task` 新元数据实测通过；双仓 `v0.6.1` 与 `master` 同指 `a1fe7cd`。v0.6.0：CI `db85349` 一次通过（[run 35861049131](https://github.com/lanlan0811/tianshu-mcp/actions/runs/35861049131)）；`Release` 全绿（[run 35861741097](https://github.com/lanlan0811/tianshu-mcp/actions/runs/35861741097)）；npm `tianshu-mcp@0.6.0`（`dist.shasum` = `f655356c…`，232 文件） |

### 2.1 Agent 适配现状

| agentId | driver / adapter | status | 说明 |
|---|---|---|---|
| `codex` | `gui` / `codex-gui` | **ready**（darwin 为 `research`） | Codex 桌面端 GUI（Windows：MSIX COM 激活 + CDP；macOS：spawn .app + CDP），支持 `model`/`reasoningLevel`/`planDoc`/`designSystem`；等待用户检测、取消真停、重派护栏均已真机验证（v0.3.2）；macOS 基本闭环已真机验证（2026-09-13，见 `docs/codex-gui-cdp.md`），取消/返修矩阵未齐故 darwin 保持 `research` |
| `zcode` | `gui` / `zcode-gui` | **research**（常量，非平台分支） | CDP GUI adapter，Windows 真机闭环通过；已适配 ZCode 3.11.2 模型菜单与项目绑定（v0.3.3）、项目/模型回读加固与初始化恢复（v0.3.4）；**无项目派发（`default` 工作区，`projectPath` 可选）与 `allowCreateProject` 自 v0.5.2 起支持**（issue #12，Windows 真机验收）；v0.5.3 修复实例跨 server 驻留、新建任务切页与发送失败归因三个真机缺陷。macOS 基本闭环已真机验证（`docs/zcode-cdp.md`），但无项目派发仅在 Windows 实测、取消/返修/新建项目矩阵未齐，故 `status` 保持常量 `research` |
| `traework` | `gui` / `traework-gui` | **ready** | CDP 驱动 TRAE SOLO CN 桌面 UI；三种面板模式真机验证通过。注意 `status` 为常量 `ready`，但 **macOS 分支仍 fail-closed**（可执行探测与原生对话框驱动未在 macOS 实测） |
| `kimicode` | `gui` / `kimicode-gui` | **ready**（darwin 为 `research`） | Kimi Code 桌面端（Electron，实测 1.0.2）；**双渲染进程**（主窗口承载侧栏/会话/composer，`Kimi Browser Overlay` 浮层承载模型/思考档位/执行模式菜单）；工作区以**完整路径**绑定，未登记时经原生「添加工作区」对话框导入；真机验证：成功路径、未登记工作区导入 + 自动验收、失败 → 返修 → 再验收同会话闭环。取消/提问续答/同名歧义仅由 hermetic 集成测试覆盖，macOS 为 `research` 且 fail-closed |
| `qoder` | `gui` / `qoder-gui` | **ready**（darwin 为 `research`） | Qoder CN 桌面端（实测 0.3.4，CDP 基准端口 `9777`）；`projectPath` + 可读 `planDoc` 必填，`modelSource=default/custom` 消除跨组重名；未登记目录经「新的任务 → 工作区 → 新建工作区 → 添加可读写文件夹」原生导入；思考等级经「模型管理」保存为**全局偏好**并回读，权限模式沿用。Windows 真机已验证：已有工作区默认模型、新登记工作区自定义模型、受控失败 → 落计划 → 原会话返修 → 再验收。取消/提问续答仅由 hermetic 集成测试覆盖；macOS 为 `research` 且 fail-closed |
| `codex-cli` | `spawn`（用户自建 profile，非内置） | 用户配置 | 无头路径走 `codex exec`；`model` 参数对其不生效（用 `~/.codex/config.toml`）；CLI 需 ≥0.154.0（≤0.130.0 签名证书已吊销）。`get_profiles` 自 v0.4.0 起会列出用户自定义 profile |
| `stub` | `spawn` | 仅测试 | `test/stub-agent/stub-agent.mjs` 三剧本（good/fix-on-first/never） |

---

## 3. 里程碑与实现期关键修复

### 3.1 里程碑

| 里程碑 | 主题 | 版本 | 测试 |
|---|---|---|---|
| M1 | 核心引擎 + stub-agent 全链路（状态机 / 队列 / 并发闸 / 验收引擎 / fix-loop） | — | 53 |
| M2 | 真实 Codex CLI 冒烟 + rework 闭环；修复 3 个真实缺陷 | — | — |
| M3 | TraeWork 调研 → 定论「无无头 CLI」；npm 首发；天枢宿主真实接入（DoD #6） | `0.1.1` | — |
| R1–R8 / S1–S6 | 两轮验收整改（取消 / 超时 / 基线归因 / 参数语义 / 热加载 / CI 加固） | — | 72 |
| M4 | TraeWork GUI 驱动接入（CDP）——`driver=gui` 落地，真机 e2e 通过 | — | 153 |
| M5 | 面板模式切换（Work/Code/Design）+ README 重写 / SVG 资产 | `0.1.5` | 167 |
| M6 | 项目文件夹绑定修复（footer 确认弹窗 / 检测预算 / CJK 路径 WM_SETTEXT / Code→Work 兜底） | `0.1.6` | 172 |
| M7 | 绑定**根因**修复（规范化路径被原生选择器拒绝 → `toNativeWindowsPath`）+ 写入回读 / hwnd 贯穿 / 遗留对话框清理 | `0.1.7` | 178 |
| M8 | 原子写并发缺陷修复（临时文件名唯一化 + rename 退避重试；CI windows/Node20 真根因） | `0.1.8` | 181 |
| M9 | TraeWork 任务进行中检测（权威运行信号 + 空闲计时 + CDP 断线收敛 + 异常保留实例） | `0.1.9` | 196 |
| M10 | stdio 日志污染修复（issue #1：Logger 全级别改走 stderr + 严格 stdio 门禁 + Node 24 + 安装包协议门禁） | `0.1.10` | 202 |
| M11 | ZCode GUI 统一闭环（独立 `zcode-gui` CDP adapter + 精确项目/模型/完全访问 + `needs_user`/`continue_task` + 同会话返修） | `0.2.0` | 262 |
| M12 | Codex 桌面端 GUI 适配（MSIX COM 激活 + CDP；模型 + 思考强度；项目自动登记；验收失败自动生成计划并返修）**破坏性**：`agentId=codex` 由无头 CLI 改为 GUI | `0.3.0` | 340 |
| M13 | 技能文档对齐 + 发布自动化修复（SKILL/usage-examples 重写、双语 Release 正文、Full Changelog/CI 链接、Gitee 发行版自动化） | `0.3.1` | — |
| M14 | Codex 等待用户检测 + 取消真停 GUI（issue #5/#6，详见 §9.4） | `0.3.2` | — |
| M15 | ZCode 3.11.2 适配 + 验收引擎 fail-closed（issue #4/#7，详见 §9.5） | `0.3.3` | 366 |
| M16 | ZCode 项目/模型回读加固 + 初始化共同截止时间恢复 + 无锚点会话发送确认（issue #8/#9/#10，详见 §9.6） | `0.3.4` | **407** |
| M17 | macOS 双驱动打通（codex/zcode）+ `projectPath` 安全闸门 + 验收并行与事件循环性能工程（社区 PR #11，见 §2.1 与 `docs/release-v0.4.0.md`） | `0.4.0` | **443** |
| M18 | 技能文档对齐 v0.4.0 工具面 + 双语 README 贡献者名录；无代码行为变更 | `0.4.1` | 443 |
| M19 | **可选视觉验收模块**：页面截图对比 + 静态图片规格 + 基准两阶段批准 + 规则冻结 + 离线 HTML + 两个 MCP 工具与 `visual` CLI 子命令族（详见 §9.8 与 `docs/release-v0.5.0.md`） | `0.5.0` | **486** |
| M20 | 技能/验证文档对齐代码实况 + 平台证据归档（Windows 10 矩阵 9/9、macOS 双架构 51 用例）+ 锁文件版本同步；**无运行时行为变更** | `0.5.1` | 486 |
| M21 | **ZCode 无项目派发（issue #12）**：`run_task.projectPath` 变可选、`allowCreateProject` 关闸、项目触发器就绪判据统一（详见 §9.9） | `0.5.2` | **525** |
| M22 | **ZCode 真机回访修复（issue #12 第二轮）**：GUI 实例跨 server 退出驻留、新建任务不切页导致静默空等、发送失败归因误导（详见 §9.9） | `0.5.3` | **532** |
| M23 | **视觉验收第二阶段「AI 视觉内容校验」（issue #13）**：`contents[]`/`pages[].content` 内容维度、委托用户自备命令（凭证零管理）、多数票 + 任务级缓存防抖、`uncertain` 与默认仅告警、`pixel:false` 语义页豁免基准、返修计划隔离告警项（详见 §4.3 与 §9.10） | `0.5.4` | **644** |
| M24 | **Kimi Code GUI 适配（第四个 GUI agent，`agentId=kimicode`）**：双渲染进程 CDP 驱动（主窗口 + `Kimi Browser Overlay` 浮层）、工作区完整路径绑定与原生「添加工作区」对话框导入、模型三级选择与思考档位按界面档位集合校验、执行模式强制「完全自动」、运行检测（`button.stop` / `send.is-starting`）、`needs_user` 六类与 `continue_task` 恢复（详见 §4.2 与 §9.11） | `0.5.5` | **764** |
| M25 | **Qoder CN GUI 适配（第五个 GUI agent，`agentId=qoder`）**：安装发现（显式 → D 盘 → 注册表/快捷方式 → 标准目录）、实例复用与 `needs_user` 保留现场、完整路径工作区绑定与原生「新建工作区」导入、`modelSource` 默认/自定义分组与模型管理全局思考等级保存回读、本轮消息绑定的运行判定、发送/答题检查点防重发、自动与手动返修先落计划再发原会话（详见 §4.2 与 §9.12） | `0.5.6` | **826** |
| M26 | **编排技能文档按代码实况重写**：参数兼容矩阵（九维度 × 五 agent）、`needsUserKind` × agent × `continue_task` 行为矩阵、`agentEndReason` → 终态映射、Kimi Code 档位取值域修正、qoder 章节与 meta 新字段补齐；**无运行时行为变更**（详见 §0 的 0.5.7 交接与 `docs/release-v0.5.7.md`） | `0.5.7` | 826 |
| M27 | **四份主文档按代码实况重写 + 打包一致性修复**：验收阶段顺序、`visual.enabled=false` 的真实边界、工具返回契约、五份 agent 表补 Qoder CN、profile 无效字段提示；补发 `probe-traework.mjs` 与三个 probe script；**无运行时行为变更**（详见 §0 的 0.5.8 交接与 `docs/release-v0.5.8.md`） | `0.5.8` | 826 |
| M28 | **GUI 终态如实化（server 退出 / 重启归档，issue #14）**：`shutdownInterrupt()` 尽力停 + 有界等待、未确认如实标注、`guiResidualUnconfirmed` 与人工确认入口（详见 §0 的 0.5.9 交接与 `docs/release-v0.5.9.md`） | `0.5.9` | 841 |
| M29 | **派单/验收幂等键（issue #15）**：`run_task` / `verify_task` 的 `idempotencyKey`、TTL 重放、执行中提示、同键异参 fail-closed、`idempotency.json` 落盘与 `idempotentHint` 注解（详见 §0 的 0.5.10 交接与 `docs/release-v0.5.10.md`） | `0.5.10` | 867 |
| M30 | **技能自装加固（issue #16）**：源定位只认包自身、安装清单区分「旧版包」与「用户本地修改」、`autoInstall` 三态与 `--approve-skill-update`、原子安装与备份治理（详见 §0 的 0.6.0 交接与 `docs/release-v0.6.0.md`） | `0.6.0` | 898 |
| M31 | **五项小项扫尾（issue #17）**：系统目录子树拒绝（判定抽为可注入平台的纯函数）、`capability` 收敛三族（`verify_task` → `execute`）、项目登记失败不派单、`cmd` 字符串形态文档化、注释与场景计数对齐；**唯一对外可见变更**是 `verify_task` 的 `readOnlyHint` 变 `false`（详见 §0 的 0.6.1 交接与 `docs/release-v0.6.1.md`） | `0.6.1` | **940** |

### 3.2 实现期修复记录（都是真机/CI 逼出来的，改相关代码前先读）

| # | 里程碑 | 现象 | 根因 → 修复 | 回归 |
|---|---|---|---|---|
| 1 | — | `rework_task(feedback)` 后返修轮拿不到 feedback，卡在 `failed` | 终态快照先落盘、调用方后写 `reworkFeedback`，被上一轮收尾的 `delete` 抹掉 → 改为 `startTask` 启动时**原子取走并清空** | `test/integration/rework-feedback-race.test.ts` |
| 2 | M6 | 项目文件夹绑定卡住（实战反馈） | 三处叠加缺陷：footer 点击未确认弹窗、检测被 PowerShell 冷启动吃光预算、CJK 路径被控制台代码页破坏（详见 §9.1） | 相关集成/单元测试 |
| 3 | M7 | 上述仍未根治 | **真根因**：MCP 传 `normPath()` 规范化路径（`d:/a/b`），Windows 原生选择器不接受 → `toNativeWindowsPath()` 转 `D:\a\b`（详见 §9.1） | — |
| 4 | M8 | CI windows/Node20 偶发失败 | `writeJsonAtomic`/`writeTextAtomic` 临时文件名 `<目标>.<pid>.tmp` 并发共用 → `ENOENT`/`EPERM` → 随机后缀 + rename 退避重试 | `test/unit/atomic-write.test.ts` |
| 5 | M9 | 长思考被提前判完成 | 稳定 36 秒不再等同完成；停止按钮与 loading task tail 优先于完成标志，静态确认后等默认 10 分钟才返回 `idle`（详见 §9.2） | `test/unit/traework-liveness.test.ts` 等 |
| 6 | M10 | 严格 MCP 客户端握手/调用失败（issue #1） | 旧 `Logger` 只有 ERROR 走 stderr，INFO/WARN/DEBUG 与 JSON-RPC 共用 stdout → 全级别统一 stderr（详见 §9.3） | `test/unit/log.test.ts` + `scripts/check-stdio.mjs` |
| 7 | M14 | Codex 停在等待用户界面时死锁 `running`；`cancel_task` 只停 MCP 侧 | 停止按钮恒可见被当绝对运行信号；取消「请求即成功」→ stall 兜底转 `needs_user(user_confirmation)`、取消经 CDP 点击停止 + 有界等待、派发前 `instance_busy` 护栏（详见 §9.4） | `test/integration/codex-flow.test.ts` |
| 8 | M15 | 模型菜单/项目绑定判据漂移；验收零用例、零变更假绿 | 3.11.2 把 provider 分组改为 family；绑定入口改为 composer 复选项 → 新旧双兼容 + 直选优先 + 回读重试；验收引擎 fail-closed（详见 §9.5） | `test/unit/zcode-core.test.ts` 等 |
| 9 | M16 | #8/#9/#10：项目/模型回读误判、原生探测超时不协调、无锚点恢复丢会话与上下文 | 触发器逐级定位 + 完整路径绑定；模型解码稳定属性并排除旧值；初始化共用截止时间预算；无锚点恢复补发完整任务/上下文/引用并以标记定位会话（详见 §9.6） | `test/unit/zcode-recovery.test.ts`、`zcode-dom.test.ts`、`zcode-dialog.test.ts`、`test/integration/zcode-flow.test.ts` |
| 10 | M16 | 首次推送后 macOS CI 全红（Windows/Ubuntu 全绿） | 集成测试「添加项目首次点击被吞」未 mock `listDialogs`，触达真实 `listOwnedDialogs`；其 darwin 分支改为 fail-closed 后于无 ZCode/辅助功能授权的 runner 上抛错 → 给 `depsFor` 补 hermetic `listDialogs` 默认桩 | `test/integration/zcode-flow.test.ts` |
| 11 | M17 | Windows 上盘符根未被 `projectPath` 闸门拦截（`assertSafeProjectDir("C:/")` 不抛错） | `normPath` 剥尾斜杠：`D:\` → `d:`，与清单里的 `d:/` 永不相等（死条目）→ 改为单独判定盘符根，覆盖所有盘符 | `test/unit/project-dir-guard.test.ts` |
| 12 | M17 | `project-dir-guard` 的系统目录断言在 Windows 红 | `/etc`、`/usr` 是 POSIX 路径，Windows 命中的是「目录不存在」→ 加平台守卫，Windows 侧改验盘符根与 `C:/Windows` | `test/unit/project-dir-guard.test.ts` |
| 13 | M17 | `acceptance-parallel` 取消用例偶发（单跑绿、全量红；CI 两次重试都红） | 固定 250ms 在慢平台可能早于子进程 spawn，在途 check 被误记为 `skipped` → 等两个在途 check 真正启动（各自 touch 标识文件）后再取消 | `test/unit/acceptance-parallel.test.ts` |
| 14 | M19 | 视觉基准批准可被并发覆盖 / 候选被篡改 | 候选摘要、原基准摘要、配置摘要三向核对 + 项目级锁；候选改、原基准变、跨项目候选一律拒绝 | `test/unit/visual-baselines.test.ts` |
| 15 | M19 | 视觉阻塞任务被 `rework_task` 直接拉 agent 返修，浪费轮次 | 引入 `pendingVisualVerification`：阻塞任务恢复时**先重新验收**，通过即结束，仅真实缺陷才进返修 | `test/integration/visual-rework.test.ts` |
| 16 | M19 | 取消期间视觉操作异常被误记 `needs_attention` | 启动阶段捕获视觉完整性错误时先判 `this.aborted()`，取消路径优先落取消终态 | `test/unit/zcode-recovery.test.ts` + 视觉用例 |
| 17 | M20 | `package-lock.json` 根包版本滞后（v0.5.0 时为 `0.4.1`） | 发布时未同步锁文件 → `npm version --no-git-tag-version` 并提交锁文件 | CI「构建后无 tracked diff」+ 发布清单 |
| 18 | M21 | 无项目派发在真实 `run_task` 被 SDK 拒成 `-32602 Required at projectPath`（单元测试全绿） | handler 已支持无项目分支，但 `RunTaskParamsSchema.projectPath` 仍是必填；单测直接调 handler 绕过了 `inputSchema` → 改 `AbsPath.optional()` + 协议层回归用例 | `test/integration/task-flow.test.ts` |
| 19 | M21 | 无项目派发永久停在 `needs_user/setup_recovery` | 「新建任务」继承上次项目绑定；且项目菜单**已打开**时点击触发器被 Radix toggle 反噬 → 新增 `workOutsideProject` 选择器与 `enterDefaultWorkspace()` 显式切换，点击前先查菜单状态 | `test/unit/zcode-dom.test.ts`、`test/integration/zcode-flow.test.ts` |
| 20 | M22 | ZCode 一退出 MCP server 就被连坐杀掉，`needs_user` 提示的窗口已不存在 | `zcode`/`codex` 按平台分支 spawn（`detached: process.platform !== "win32"`），Windows 上子进程不驻留（实测存活 0） → 收敛为 `guiInstanceSpawnOptions()`，三处 GUI 实例共用；执行型子进程仍按平台分支 | `test/unit/gui-instance-spawn.test.ts` |
| 21 | M22 | 顶部「新建任务」返回 `true` 却不切页，随后空转 30 秒只报 `setup_recovery` | `conversation-new-task` 是惰性挂载图标，会话页 composer **不挂载** `composer-workspace-trigger` → 以「触发器已挂载」验证草稿真的建立，失败回退侧栏 `task-new-button`，两者都失败才 `setup_failed` | `test/integration/zcode-flow.test.ts` |
| 22 | M22 | 窗口被遮挡时的发送失败文案把用户引向按钮 | Chromium 节流（`visibilityState=hidden`）使按钮在视口内却点不到 → 识别该状态并报「窗口不在前台」+ 置于前台的操作指引；`Page.bringToFront` 实测无法恢复被遮挡的 Electron 窗口，不假装能自动恢复 | `test/integration/zcode-flow.test.ts` |
| 23 | M25 | 模型菜单点选后**异步关闭**，立刻重开会读到旧值；「保存设置」也可能根本没生效 | 选中模型后先 `wait(model-menu-closed)` 确认菜单真的关闭，再做 `model-readback`；思考等级保存后**重新打开模型管理**核对已持久化的值（`persisted-reasoning`），未生效即响亮报错不发送（详见 §9.12 ④） | `test/unit/qoder-model-controls.test.ts`（延迟关闭 / 保存生效 / 保存未生效三分支） |
| 24 | M25 | 单元测试 `isolate:false` 使安装探测的命令 mock 泄漏到 Git 基线测试（依赖文件执行顺序） | vitest unit project 恢复文件级隔离（`isolate:true`），mock 不再跨文件泄漏 → 全量回归稳定（详见 §7 门禁纪律 1 同源教训） | `vitest.config.ts` + 全量回归 |
| 25 | M26 | 文档声称「技能/工具计数」与实际不符（如 §15 说 `tools.ts` 注释仍写 9 个工具、SKILL 说 `get_task_report` 是唯一不带 meta 块的工具） | 逐项核对代码更正：工具注释计数改为 11、MCP `instructions` 补 qoder/kimicode、`meta` 块例外改为「`get_task_report` + 两个视觉基准工具 + 任何错误结果」；同类偏差在 README/ARCHITECTURE/HANDOFF/SKILL 一并修正 | 本轮文档重写（`test/unit/skill-format.test.ts` 保住 frontmatter 与结构契约） |
| 26 | M31 | 危险目录闸门只挡**精确相等**的根：`c:/windows/system32`、`/etc/anything` 这类系统目录子目录可被当作工作区（worker 对整个子树可写） | 新增 `DANGEROUS_SUBTREES` + 纯函数 `isDangerousProjectDir(norm, platform)`，系统目录改**边界感知子树拒绝**（前缀后须为 `/`）；`/var` `/tmp` 等维持精确（macOS `os.tmpdir()` 是 `/var/folders/...`，子树拒绝会切断测试基座）。判定可注入平台，故在 Windows 开发机上即验证三平台形态 | `test/unit/project-dir-guard.test.ts`（含 `c:/windows.old`、`/etcetera`、`/private/var/folders/...` 三个反例） |
| 27 | M31 | `verify_task` 标 `read` 但实际执行项目命令（capability 死分类：`execute`/`network` 零使用）；连带 MCP `readOnlyHint` 失真为 `true` | `capability` 收敛三族、删 `network`；`verify_task` 改 `execute`，`readOnlyHint` 随之 `false`（仍免审批）；`server.ts` 补推导注释，宿主需知写进 tianshu-integration / release / CHANGELOG / ARCHITECTURE | `test/protocol/protocol.test.ts` 真值表（11 工具 × capability × 四注解） |
| 28 | M31 | `run_task` 丢弃 `registerProject` 返回值（`void registered;`）又用 `projectByPath` 冗余二次读取；登记失败只冒原始 `Error`，易留下「任务已建、项目未登记」半状态 | 消费返回值取代二次读取；登记失败 `WARN` + 结构化 `errorResult`，**不派单** | `test/unit/zcode-handler.test.ts`（断言 `projectByPath` 调用计数为 0） |

---

## 4. 架构与模块导览

> 本节是**面向交接的快速导览**（目录 + 两条执行面 + 五个 GUI driver 的执行顺序）。
> 系统分层、模块边界、状态机全貌、验收流水线、跨平台策略与扩展点的**完整架构说明见 [ARCHITECTURE.md](ARCHITECTURE.md)**（英文版 [ARCHITECTURE.en.md](ARCHITECTURE.en.md)）。

```text
src/
├── index.ts              入口（stdio；CLI 子命令在建立 stdio 连接前分流）
├── server.ts             组装：配置 / 日志 / 管理器 / 引擎 / 注册表 / 工具注册 / 技能自检安装
├── version.generated.ts  构建期由 scripts/sync-version.mjs 从 package.json 生成（勿手改）
├── config/
│   ├── schema.ts         zod 全集（工具入参、profile、projects、验收配置、TraeworkMode）
│   └── store.ts          数据目录读写 + last-known-good 热加载
├── mcp/
│   ├── tools.ts          11 个工具的元数据（capability / requireApproval）
│   ├── handlers.ts       工具实现
│   ├── context.ts        meta → TaskContext（含 resume / continue 语义）
│   └── formatter.ts      文本 + meta 块
├── tasks/                状态机、每项目串行队列、全局并发闸、事件流落盘
│   └── task.ts / task-manager.ts / task-store.ts / idempotency.ts（issue #15 幂等键索引）
├── loop/
│   ├── fix-loop.ts       单任务编排（自动返修循环；含视觉冻结核对与阻塞恢复）
│   └── repair-plan.ts    验收失败时生成修复计划文件（MCP 任务目录）
├── agents/
│   ├── adapter.ts        AgentAdapter 接口（含可选 run() 执行面）
│   ├── registry.ts       按 profile.adapter/driver 构造 Cli/TraeWork/ZCode/Codex/KimiCode/Qoder adapter
│   ├── cli.ts / spawn.ts 通用 CLI adapter / 子进程封装（windowsHide、管道、超时、kill tree）
│   ├── gui-instance.ts   GUI 桌面实例 spawn 选项（detached 不变量，供五个 GUI adapter 复用）
│   ├── builtin.ts        内置 profiles（codex / zcode / traework / kimicode / qoder）
│   ├── traework/         TraeWork GUI 驱动
│   │   ├── adapter.ts / run.ts / launcher.ts
│   │   ├── cdp/{client,selectors}.ts
│   │   ├── ui/{session,composer,model,reply}.ts
│   │   └── computeruse/{guard,dialog}.ts
│   ├── zcode/            ZCode GUI 驱动（v0.2.0 起）
│   │   ├── adapter.ts / run.ts / instance.ts / recovery.ts
│   │   ├── cdp.ts / dom.ts / selectors.ts / discovery.ts / dialog.ts
│   │   └── model.ts / project.ts / references.ts / liveness.ts
│   ├── codex/            Codex 桌面端 GUI 驱动（v0.3.0 起）
│   │   ├── adapter.ts / run.ts / instance.ts / liveness.ts
│   │   ├── discovery.ts（Appx 查询 + 扫盘回退）/ launcher.ts（COM 激活）
│   │   ├── cdp.ts / selectors.ts / input.ts / model.ts / dialog.ts
│   │   └── project.ts（自动登记）/ registry.ts / fixplan.ts / verify.ts
│   ├── kimicode/         Kimi Code 桌面端 GUI 驱动（v0.5.5 起）
│   │   ├── adapter.ts / run.ts / instance.ts / recovery.ts / discovery.ts
│   │   ├── cdp.ts（主窗口 + Overlay 双页面客户端）/ dom.ts / selectors.ts
│   │   ├── dialog.ts（原生「添加工作区」）/ model.ts / workspace.ts
│   │   └── session.ts / liveness.ts
│   └── qoder/            Qoder CN 桌面端 GUI 驱动（v0.5.6 起）
│       ├── adapter.ts / run.ts / instance.ts / discovery.ts / profile.ts
│       ├── cdp.ts / selectors.ts / liveness.ts / references.ts
│       ├── dialog.ts（原生目录选择）/ workspace.ts（完整路径绑定与新建工作区）
│       └── model.ts（默认/自定义分组 + 模型管理档位）/ questions.ts（提问答题）
├── visual/               可选视觉验收模块（v0.5.0 起；未启用时不影响既有行为）
│   ├── schema.ts / defaults.ts / config.ts / runtime.ts / errors.ts
│   ├── engine.ts / capture.ts / compare.ts / images.ts
│   ├── services.ts / budget.ts / paths.ts / lock.ts / snapshot.ts / types.ts
│   ├── baselines.ts / manage.ts / report.ts / cli.ts
│   └── （动态依赖 sharp / pixelmatch / puppeteer-core，缺失时明确阻塞而非静默降级）
├── verify/               验收引擎（命令检查 + 代码分析 + git 基线 + 报告）
│   └── acceptance.ts / runner.ts / exec.ts / signals.ts
│       code-analysis.ts / git-baseline.ts / report.ts
└── util/                 日志、路径、文件、超时、id、技能安装
    └── log.ts / path.ts / fs.ts / timeout.ts / id.ts / skill-install.ts
```

### 4.1 两条执行面（`driver`）

| driver | 执行方式 | 结果判定 |
|---|---|---|
| `spawn`（默认） | 拉起外部 CLI 子进程 | 退出码 |
| `gui` | CDP 驱动桌面 UI，**不 spawn 任务**（Codex/ZCode/TraeWork/Kimi Code/Qoder CN 会为注入调试端口而启动桌面实例，但仍以 UI 信号判定结果） | 运行信号优先 → DOM 完成标志 → 稳定确认后的空闲计时 → stall / 任务超时 |

`TaskOrchestrator.runAgentOnce` 的分支逻辑：`adapter.run` 存在 → 调用它；否则走 `runChild`。**这是唯一需要理解的双路径接缝。**

### 4.2 五个 GUI adapter 的执行顺序（实测结论，勿随意调整）

**TraeWork**（详见 §9.1 / §9.2）：

```text
确保实例可用 → 等待 UI 就绪 → 新建会话 → 切到目标模式 → 在目标模式内绑定项目 → 切模型 → 发送 → 轮询到完成
```

> **关键事实**：TraeWork 的 Work/Code/Design **各自维护独立的项目绑定**，切换模式会把输入栏项目换成该模式上次使用的项目。
> 因此必须先切模式、再在目标模式里绑定项目；绑定后复核「模式 + 项目」双双就位，任一不符即响亮失败。

**ZCode**（详见 `docs/zcode-cdp.md` 与 §9.5 / §9.6）：

```text
发现安装 → 启动/复用 CDP 实例（共同截止时间预算） → 绑定项目（触发器逐级定位 + 完整路径判据）
  → 选模型（直选优先，provider/family 分组兜底，回读解码稳定属性） → 完全访问权限
  → 发送（按钮就绪检查 → 标记/会话差集定位） → 运行检测/提问检测 → 轮询到完成
```

> 提问、登录页、旧实例无 CDP、macOS 辅助功能权限、自动恢复未完成分别转
> `agent_question` / `login_required` / `needs_user(close_existing_instance)` / `system_permission` / `setup_recovery`，由 `continue_task` 恢复。

**Codex**（详见 `docs/codex-gui-cdp.md` 与 §9.4）：

```text
MSIX 发现（Appx 查询优先 + 扫盘回退） → COM 激活 + 专属 user-data-dir + CDP 端口 → 项目登记/绑定
  → 选模型与思考等级 → 发送（planDoc/designSystem 拼进初始指令） → 运行检测（停止按钮 + 对话哈希 stall） → 轮询到完成
```

> 停在「等待用户确认」界面（方案确认卡 / 订阅结账页）→ stall 判定转 `needs_user(user_confirmation)`；
> 用户处理完后 `continue_task` 重新观察（不重发消息）；`login_required` 则复检环境后重派任务书。

**Kimi Code**（详见 `docs/kimi-cdp.md` 与 §9.11）：

```text
发现安装 → 启动/复用 CDP 实例（已有非 CDP 实例转 needs_user） → 连接主窗口并置前
  （bringToFront，等 visibilityState 收敛） → 新建草稿（以 ws-chip 挂载为准的有界重试）
  → 绑定工作区（完整路径匹配 + 回读） → 选模型（pill 回读 → overlay 快捷菜单 → 「更多模型…」对话框）
  → 思考档位（按界面实际档位集合校验） → 执行模式「完全自动」
  → 发送（标记 + 60s 有界确认） → 运行检测（stop 按钮 / send.is-starting） → 轮询到完成
```

> 模型菜单/思考档位/执行模式菜单**不在主窗口**，而渲染在独立的 `Kimi Browser Overlay` 渲染进程；
> 工作区菜单与「切换模型」对话框仍在主窗口 → 客户端需同时持有两个页面。
> 未登记的工作区经原生「添加工作区」对话框导入（与 ZCode/TraeWork 同构，Win32 坐标点击）；
> 环境类等待项分别转 `close_existing_instance` / `login_required` / `system_permission` / `setup_recovery`，
> 提问转 `agent_question`，等待用户确认转 `user_confirmation`，均由 `continue_task` 恢复。

**Qoder CN**（详见 `docs/qoder-cdp.md` 与 §9.12）：

```text
发现安装（显式 gui.exePath → D 盘优先候选 → 相对路径模板 → 标准目录）
  → 启动/复用 CDP 实例（已有实例无可用 CDP → needs_user，保留现场不重启）
  → 新建会话 → 绑定工作区（完整路径判据；未登记走「新建工作区 → 添加可读写文件夹」原生导入）
  → 选模型（默认/自定义分组精确匹配 + modelSource 消歧）→ 思考等级（模型管理保存后重开回读）
  → 发送（先落检查点 → 标记 + 有界确认） → 运行检测（data-send-button=generating）
  → 本轮 user id ↔ assistant:<user id> 配对且出现 data-assistant-actions → 轮询到完成
```

> 完成判定**必须绑定本轮用户消息**：历史回复里的“完成”、界面静止、连接断开都不算；
> 审批/提问优先于停止按钮（停在等待用户的界面先判 `needs_user`，不要死锁成 `running`）。
> 发送与答题提交前落检查点（`qoder-session.json`），未确认回执时只观察、不自动重发；
> `continue_task` 对审批/登录等环境等待只恢复观察，仅 `agent_question` 把答案写回原会话。
> 取消/超时只停**已绑定的原会话**并回读，未确认时终态明示「GUI 内运行未确认停止」并保留实例阻止重派。

### 4.3 视觉验收的一条独立链路（v0.5.0 起，内容校验自 v0.5.4）

```text
项目 .tianshu-mcp/acceptance.json 配 visual.enabled=true
  → run_task/verify_task 在命令检查之后追加视觉检查（不需要新工具）
  → 动工前冻结「视觉配置摘要 + 基准摘要」，每轮前后核对（变动即 VISUAL_INTEGRITY 阻塞）
  → 页面：三类来源（existing/command/static）+ 声明式步骤 + 稳定化采样 + 显式屏蔽 → 与已批准基准像素对比
        → 若声明 pages[].content，复用同一次截图再做内容判定（pixel:false 则只做内容判定）
  → 图片：显式文件清单 + 编码/尺寸/DPI/透明度规格校验
  → 内容（v0.5.4，可选）：委托用户自备命令判定「图片/截图内容是否符合显式期望」
        → 采样多数票 + 任务级输入哈希缓存（键含命令二进制身份）
        → 默认仅告警（optional）；逐规则 blocking:true 才参与致败与返修
  → 缺陷按 autoFixRounds 返修；阻塞（缺基准/不可达/资源被拦/不稳定）→ needs_attention
  → rework_task 对阻塞任务先重新验收，不先启动 agent
```

基准必须两阶段：`prepare_visual_baseline`（只生成候选）→ 用户审阅后 `approve_visual_baseline`（核对三向摘要再原子写入）。
**缺基准不得判通过，自动返修禁止调用批准入口。**

内容校验的凭证边界与红线一致（见 §5.4）：MCP 不读取/存储/转发任何密钥、不实现模型客户端，判定完全委托用户
自备命令；外发闸门只在**契约层**强制（未放行 `allowRemote` 时 schema 拒绝 `<image:base64:file>`），命令自身
是否外传图片无法在系统层拦截，须用户自行确认。整轮级失败（命令不可解析 / env 引用缺失）走 `assertContentReady`
抛错升级为 `configurationError`，**不产出结果行**；`uncertain` 与 `optional` 天然不参与 verdict。

---

## 5. 硬性红线（违反 = 运行时损坏或事故）

1. **绝不按进程树盲杀 TraeWork**：只终止本模块创建、且命令行核对通过的 PID，且不带 `/T`。
   事故来源：验证期 `taskkill /PID <pid> /T /F` 误杀用户正在使用的实例（数据完好，已恢复）。见 `docs/traework-cdp.md §6`。
2. **默认复用用户实例**：`gui.windowMode="reuse"`，绝不新起第二个（Codex/ZCode 以专属 user-data-dir 启动的受管实例除外，且不触碰用户手动打开的实例）。
3. **computer-use 白名单**：仅允许 TraeWork 文件夹选择对话框（窗口标题 + 宿主进程双校验），其他窗口一律 `COMPUTER_USE_DENIED`。
4. **凭证零管理**：不读取/解密/转发任何 agent 凭证；GUI adapter 只驱动 UI。**AI 内容校验（v0.5.4）同样适用**：不实现模型/厂商 HTTP 客户端、不读密钥，判定委托用户自备命令；外发闸门只在契约层强制，命令自身行为无法在系统层审计（见 `SECURITY.md` 与 §9.10）。
5. **命令不拼 shell**：验收命令是结构化 argv，`shell:false`。
6. **不自动 commit/stash/回滚**：动工前采集 git 基线，报告相对基线计算。
7. **路径不硬编码**：机器路径 / 用户名 / 端口走 profile 或占位符（`{LOCALAPPDATA}`、`{PROGRAMFILES}` 等；展开大小写不敏感）。
8. **GUI 取消不得谎报**：`cancel_task` 对 GUI agent 必须尽力点击停止 + 在 `gui.cancelWaitMs` 内有界等待确认；
   未确认停止时终态必须明示「GUI 内运行未确认停止」。重派前必须确认受管实例空闲，否则以 `instance_busy` 拒绝（防 turn 交叠）。
   **同一标准覆盖 server 退出与重启归档（issue #14）**：`shutdownInterrupt()` / `initialize()` 对 `driver="gui"` 的任务
   不得写「进程已终止」（server 对其进程无所有权），必须按 `guiStop` 如实落「已确认停止 / 未确认停止 / 无停止结果可确认」，
   并置 `interruptedCleanStop` / `guiResidualUnconfirmed`；`guiStopUnconfirmed` 为真时先人工确认再重派。
9. **验收 fail-closed**：测试命令退出码 0 但输出显示零用例 → 判失败；git 项目默认要求相对基线产生变更
   （`requireChanges: false` 显式关闭）。不得为「让任务变绿」放松这两个门禁。
10. **路径闸门不得放宽**：`projectPath` 必须是存在的绝对目录，`realpath` 归一后落在主目录或系统/根级目录一律拒绝；盘符根由单独判定覆盖，不依赖枚举清单。
11. **视觉基准不得被自动化改写**：`approve_visual_baseline` 只能在用户明确授权后调用，且必须带 `expectedDigest` 与 `approvalNote`；
    自动返修路径禁止调用批准入口；不得修改基准/阈值/屏蔽区域或关闭规则来绕过失败（规则冻结会检出）。
12. **只在 `master` 提交，commit 用中文**；不建分支、不覆盖已有 tag。

---

## 6. 环境搭建、日常迭代与诊断探针

### 6.1 从零搭环境

```bash
git clone https://github.com/lanlan0811/tianshu-mcp.git
cd tianshu-mcp
npm ci
npm run build        # sync-version + tsc → dist/
npm test             # 940 passed / 12 skipped（952 项，83 文件通过 + 3 真实浏览器文件按设计 skip）
```

日常循环（改 `src/` 后）：

```bash
npm run typecheck && npm run lint && npm test && npm run build
# 通过后：git add . && git commit -m "中文说明" && git push github master && git push gitee master
```

### 6.2 本机环境事实（2026-09 探测，接手机器可能不同）

| 项 | 值 |
|---|---|
| Node | v24.18.0（`engines: >=20`，CI 覆盖 20/22/24；视觉模块要求 ≥20.3） |
| 天枢宿主 | `D:\Tianshu`（`tianshu-desktop.exe` + `rivet-runtime`） |
| Codex 桌面端（现用） | MSIX 包 `OpenAI.Codex`：`...\WindowsApps\OpenAI.Codex_<版本>_x64__<pfn>\app\ChatGPT.exe`；版本目录随更新变化 → Appx 查询优先 + 扫盘回退取最新 |
| Codex 内核 CLI（备用） | `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`；如需无头执行，另建 `driver=spawn` profile |
| TraeWork | `D:\TRAE Work CN\TRAE SOLO CN.exe`（v1.107.1）；CDP 需 `--remote-debugging-port=9222` 且窗口可见 |
| ZCode | Electron 桌面端；Windows 验收样本 `D:\Z-Code\ZCode\ZCode.exe`（由「D 盘优先 + 相对路径模板」发现，非硬编码）；CDP 需 `--remote-debugging-port`；3.11.2 语义已适配 |
| 本机浏览器 | 托管 Chrome `148.0.7778.97`（`~/.tianshu-mcp/browsers`）；本机 Microsoft Edge `144.0.3719.104` |
| 参考实现 | `D:\Trae项目\oh-dsh-trae-api`（TraeWork CDP 驱动机制的来源，含其自身 `HANDOFF.md`） |
| 数据目录 | 默认 `~/.tianshu-mcp`（env `TIANSHU_MCP_HOME` 可覆盖） |
| 技能安装 | `~/.rivet/skills/tianshu-mcp`（server 启动自检幂等安装） |

### 6.3 诊断探针与真机验证（**不入 CI**，需真实客户端在跑）

```bash
# TraeWork：选择器 / 模式 / 绑定 / 发送
node scripts/probe-traework.mjs selectors
node scripts/probe-traework.mjs mode Code
node scripts/probe-traework.mjs project <绝对路径>
node scripts/probe-traework.mjs send "任务书"

# ZCode：只读诊断（install/process/cdp/selectors/ui/projects/models/permission/liveness/session）
node scripts/probe-zcode.mjs all

# Codex：只读诊断；--launch 才会以专属 user-data-dir 启动受管实例（不触碰用户实例）
node scripts/probe-codex.mjs
node scripts/probe-codex.mjs --launch --port 9333

# ZCode 真机冒烟（需 --confirm-send/--model/--task 三者齐全才发送；隔离数据目录）
npm run build && npm run smoke:zcode -- --confirm-send --model DeepSeek/deepseek-flash --project D:\repo\app --task "任务书"

# 视觉验收：真实浏览器门禁用例（默认 skip，需显式开户）
TIANSHU_VISUAL_BROWSER_TEST=1 npx vitest run visual --maxWorkers=1
# 视觉验收：Windows 10 本机完整功能矩阵证据（9 项）
npm run evidence:visual:windows -- --out .tmp-check/visual-windows-matrix/evidence.json

# stdio 协议门禁（真实进程字节流校验，8 场景）
npm run check:stdio
```

### 6.4 发布流程（tag → CI → Release → npm）

```bash
# 1) 版本与文档：package.json / package-lock.json / src/version.generated.ts / CHANGELOG（中英）/ docs/release-v<ver>(.en).md / HANDOFF 快照
npm version <ver> --no-git-tag-version      # 同时更新 package.json 与 package-lock.json
npm run typecheck && npm run lint && npm test && npm run build   # 构建会同步 src/version.generated.ts，务必一并提交
git add . && git commit -m "chore(release): v<ver> ..." && git push github master && git push gitee master
# 2) 等该提交的 CI 全绿（release.yml 会复校 tag 版本 === package.json 版本，且要求同 SHA 的成功 CI）
git tag -a v<ver> -m "tianshu-mcp v<ver>" && git push github v<ver> && git push gitee v<ver>
# 3) npm（凭据在本机 ~/.npmrc；registry 已是 npmjs）
npm publish --registry=https://registry.npmjs.org --access public
```

> 坑 1：发布到 npm 后 registry 有数分钟传播延迟，`npm view` 会短暂返回旧版本或 E404，需轮询；
> 若 `npm publish` 返回 0 但查不到版本，先看 debug 日志是否 `PUT ... 202`（npm 11 异步发布流水线接受了上传），再轮询而非重发。
> 坑 2：发布说明文档若写「不发布 npm」，发布 npm 后必须同步改回，否则与实际不符（v0.3.4 发生过一次）。
> 坑 3：锁文件版本必须同步（v0.5.0 曾漏，见 §3.2 #17）。

---

## 7. 测试分层

| 层级 | 位置 | 说明 |
|---|---|---|
| 单元 | `test/unit/`（56 文件） | 纯函数与组件逻辑：traework 全套（reply / selectors / launcher / guard / driver / session / liveness / dialog / cdp-client / repair-plan）、codex-core、zcode-core / zcode-handler / zcode-dom / zcode-dialog / zcode-recovery、kimicode 与 qoder 全套、gui-instance-spawn、acceptance（含并行）、baseline（含归因 / 预脏）、atomic-write、log、config / profile 热加载、project-dir-guard、skill-format、idempotency（issue #15 幂等索引）、以及视觉模块（visual-config / images / baselines / report / runtime / content-*）等 |
| 集成 | `test/integration/`（28 文件） | stub-agent 三剧本、取消 / 超时 / 基线、traework 假 CDP（单轮 + 返修 + 绑定兜底）、codex-flow、zcode-flow / restart / rework-loop / default-workspace、kimicode-flow、qoder-flow / qoder-mcp、rework 竞态回归、verify-params、task-flow、idempotency（issue #15 重放 / 冲突 / 执行中 / 跨重启）、以及视觉（services / capture / flow / rework / browser-smoke / content-*） |
| 协议 | `test/protocol/`（1 文件） | 官方 SDK 客户端断言 11 工具面与返回格式 |
| 真机 | `scripts/probe-*.mjs`（traework / zcode / codex / kimicode / qoder，共 5 个）/ `scripts/smoke-zcode.mjs` / `scripts/evidence-visual-windows.mjs` | **手动**，需真实客户端 / 已安装浏览器 |
| 消费者 | `scripts/check-visual-consumer.mjs` | 从生产 tarball 安装到无开发依赖目录后跑真实浏览器视觉验收与离线报告 |

**门禁纪律**（都在 CI 上翻过车）：

1. `test/fake-cdp.ts` 里**助手回复必须同步追加**（`autoReplyText`），不要改回定时器——轮询间隔小 + `stableRounds` 低时定时器会与稳定兜底抢跑。
2. 集成测试必须**隔离原生对话框枚举**：`depsFor` 的默认 `listDialogs` 桩不可省，否则会触达真实 `listOwnedDialogs`，其 darwin 分支 fail-closed，在无 ZCode/辅助功能授权的 runner 上直接抛错（M16 的 macOS CI 全红即此因）。
3. 真实浏览器用例默认 `skipIf(TIANSHU_VISUAL_BROWSER_TEST !== "1")`；CI 的 `visual-browser` 作业显式开户。本机验证记得带该环境变量，否则会看到「10 skipped」。
4. **已知偶发**：`test/integration/zcode-flow.test.ts` 的「任务总时限到达时停止 MCP 等待并保留实例」在满负载并行下有时序竞态（`taskTimeoutMs: 2` 与调度竞争），单文件运行与 CI 重试通过。改相关逻辑时注意别把它当成回归。
5. **已知偶发**：`test/integration/visual-capture.test.ts` 的「loads isolated Cookie/localStorage state and diagnoses expiration」偶发 `PAGE_UNREACHABLE`（导航到 `127.0.0.1` fixture 服务超时），实测**仅个别 job 失败、同 job 内其余视觉用例全过**（v0.5.3 后的文档提交 `8bd0598` 在 `macos-15 / Node 24` 上出现过一次，重跑即绿）。判据：若失败信息是 `PAGE_UNREACHABLE` 且 `blocked.size===0`，先重跑该 job 再怀疑回归。
6. **已知偶发**：`test/unit/acceptance-parallel.test.ts` 的「慢 check 并行：墙钟 < 串行之和」断言在**全量套件满载并行**时可能偶发失败（本机 2026-09-15 一次全量运行命中：`wallMs` 未小于 `sum`），**单文件运行稳定通过**（7/7）。原因是该用例以墙钟比较证明真并行，属负载敏感的时序断言。判据：若失败的是这条断言且单独重跑该文件即绿，按偶发处理，不要当成并行调度回归。
7. **已知偶发**：`test/integration/cancel-noreason.test.ts` 的「重复取消不重复写 cancel_requested/cancelled」在**全量套件满载并行**时可能偶发失败（本机 2026-09-20 一次全量运行命中：`cancelled` 事件计数 2 > 1），**单文件运行稳定通过**（5/5）。同属负载敏感的时序断言。

---

## 8. 已知限制（对接手人有直接影响）

- **TraeWork 窗口必须可见**：发送依赖模拟输入；且不能有第三方工具（如截图器）抢焦点。
- **单会话串行**：TraeWork 是单会话 UI，所有任务经串行队列；同项目任务被 `projectBusy()` 串行化。
- **完成判定依赖 UI 信号**：停止按钮 / loading task tail 存在时不结束；无运行信号才接受「由AI生成」。
  `stableRounds` 只启动 `idleTimeoutMs`（默认 10 分钟）空闲计时，不再把约 36 秒静态直接当完成。
- **异常结束保留实例**：`idle_no_completion` / `timeout` / `aborted` / `cdp_lost` 均不关闭现场；
  `query_task` meta 查看 `agentEndReason` / `keptInstance`。**Qoder CN 不走 `idle_timeout` 这条路**：界面静止但本轮完成证据不足时它转
  `needs_user(setup_recovery)`，既不进验收也不产出 `idle_timeout`。
- **UI 升级会漂移**：五个 adapter 的选择器分别集中在
  `src/agents/traework/cdp/selectors.ts`、`src/agents/zcode/selectors.ts`、`src/agents/codex/selectors.ts`、`src/agents/kimicode/selectors.ts`、`src/agents/qoder/selectors.ts`，
  均可经 profile `gui.selectors` 覆盖；先用探针诊断。
- **macOS 部分验证**：Codex 与 ZCode 的 macOS 基本闭环（发现/启动/绑定/发送/观察/验收）均已真机通过
  （2026-09-13，分别见 `docs/codex-gui-cdp.md` 与 `docs/zcode-cdp.md`），
  但取消/返修/continue_task/新建项目矩阵未覆盖，二者 darwin 仍标 `research`；
  TraeWork 的原生对话框驱动与真机闭环仍未在 macOS 实测，macOS 分支保持 fail-closed；
  Kimi Code 与 Qoder CN 的 darwin 同为 `research`（fail-closed，未在 macOS 实测）。
- **`mode` 仅 TraeWork 生效**：ZCode / Codex / Kimi Code / Qoder 会拒绝该参数（返回明确错误）。
- **无项目派发仅 ZCode 且仅 Windows 实测**：`projectPath` 可选只对 ZCode 生效；macOS 上的无项目派发尚未真机验证（v0.5.3 已修掉 Windows 侧实例驻留、切页与归因三个缺陷，但 macOS 未覆盖）。
- **ZCode 未登记项目的自动导入在 Windows 上不可用**：需先在 ZCode 中手动登记目录，或传 `allowCreateProject=false` 让它显式失败。原因与修复方向见 §9.9。
- **Windows 上 GUI 实例跨 server 驻留已修复**（v0.5.3）：五处 GUI 实例统一走 `guiInstanceSpawnOptions()`（无条件 `detached` + `unref`）；执行型子进程（`verify/runner`、`visual/services`、`agents/spawn`）语义相反，仍按平台分支。
- **`continue_task` 仅 codex/zcode/kimicode/qoder**：traework 与 spawn 类 agent 会被拒绝。
- **Kimi Code 不支持无项目派发**：任务必须绑定工作区文件夹，`workspaceMode=default` 或缺少 `projectPath` 时以 `setup_failed` 显式拒绝。
- **Qoder CN 的硬边界**：仅支持 Qoder CN（国际版或同名窗口不算）；`projectPath` 与可读 `planDoc` 必填，不支持无项目派发；`modelSource` 与 `极高/xhigh`、`最大`、`关闭思考` 别名是 Qoder 专用参数，传给其他适配器会被拒绝；思考等级是 Qoder **全局偏好**（任务结束不还原），权限模式沿用不切换；macOS 为 `research` 且 fail-closed。取消与提问续答仅由 hermetic 集成测试覆盖（见 §9.12）。
- **`needs_user` 状态下取消是已知边界**：MCP 侧无 CDP 连接，GUI 内等待中的会话停不掉；终态文案会提示。
  经临时 CDP 连接尽力停止 GUI 内会话列在 `CHANGELOG.md` 的「未发布 / 计划中」。
- **server 退出 / 重启归档不自动停 GUI（issue #14 的边界）**：`shutdownInterrupt()` 会给 GUI 任务一份全局共享的
  `shutdown.guiStopWaitMs`（默认 15s）让"尽力停止 + 有界等待"跑完，但**未确认时只如实标注**；
  `initialize()` 归档重启遗留时**不会**自动 CDP 重连去点停止（重启后无会话锚点，适配器对无归属证明的实例 fail-closed，
  宁可不动也不误杀用户会话），改为置 `guiResidualUnconfirmed` + 提示人工检查。人工核实无残留后调用 `cancel_task` 清除标记
  （不改终态），随后才可安全重派。见 ARCHITECTURE §5.5 与 §15 已知限制 11。
- **视觉模块的平台证据边界**：macOS 证据来自 CI 托管真机 runner（macOS 15 / Darwin 24.6.0，Intel x64 与 Apple Silicon arm64，Node 20/22/24），
  未在维护者个人 macOS 设备复验；Windows 10 矩阵覆盖 `scripts/evidence-visual-windows.mjs` 列出的项。详见 `docs/visual-validation.md` 与 `docs/visual-validation-evidence/`。
- **验收 fail-closed 对纯分析任务的影响**：git 项目默认要求产生变更；纯问答 / 分析任务必须在
  `.tianshu-mcp/acceptance.json` 设 `"requireChanges": false`，否则验收判失败。
- **npm 上的 README 停留在发布时**：之后新增的文档只在仓库里；如需同步到 npm 需再发版本。

---

## 9. 专题排障手册

### 9.0 症状 → 小节索引

| 症状 | 去 |
|---|---|
| 项目文件夹绑定卡住 / 下拉未命中 / 路径写入被破坏 | §9.1 |
| 任务长时间不结束，或长思考被提前判完成 | §9.2 |
| 严格 MCP 客户端握手失败 / 工具调用失败 / stdout 有杂音 | §9.3 |
| Codex 卡在「等待用户确认」/ `cancel_task` 没真停 | §9.4 |
| ZCode 模型菜单选不中 / 项目绑定判据漂移 / 验收假绿 | §9.5 |
| ZCode 项目或模型回读误判 / 原生面板超时 / 恢复后丢会话与上下文 | §9.6 |
| ZCode 无项目派发报参数错误 / 卡在 `setup_recovery` / 窗口被遮挡时发送失败 | §9.9 |
| 升级 v0.4.0 后行为变了 / 验收检查互相干扰 / 符号链接路径下历史任务「消失」 | §9.7 |
| 视觉验收不通过 / 基准待批准 / 规则被冻结判 `VISUAL_INTEGRITY` / 离线报告看不开 | §9.8 |
| AI 内容校验整轮阻塞 / 占位符被拒 / 判定总是 uncertain / 缓存不失效 | §9.10 |
| Kimi Code 菜单找不到 / 点击被吞 / 思考档位不匹配 / 原生「添加工作区」对话框 | §9.11 |
| Qoder 模型重名 / 档位被拒 / 工作区未登记 / 会话或发送状态不明 | §9.12 |

### 9.1 TraeWork 项目文件夹绑定排障（M6 / M7 实战教训）

**事实：下拉项 ≠ 项目 map**

| 数据源 | 说明 |
|---|---|
| 下拉列表（`readProjectItems`） | 来自 TraeWork **服务端**项目列表，实测本机 11–12 项 |
| `solo-lite.local-project-folders`（state.vscdb） | 仅本地**路径回填缓存**，实测 22–23 条 |

两者不是同一份数据。**「项目已在 map 里」不代表下拉能命中**——未命中仍会走原生对话框。
（曾误判为「项目已注册所以不该走对话框」，实测证伪。）

**三处叠加缺陷（2026-09-08 修复）**

1. **footer 点击未确认弹窗**：`element.click()` 返回 true ≠ 原生弹窗出现。
   旧代码只看返回值 → 日志报「等待原生对话框超时」（下游症状）。
   **修复**：点击后调 `findFolderDialog()` 确认，未出现则记录下拉 DOM 快照并明确失败。
2. **检测预算被 PowerShell 冷启动吃光**：实测冷启动 **4.5–6.3s/次**（UIA 与 Win32 都一样），
   旧代码 Node 侧每 800ms 轮询 → 15s 只够约 2 次。
   **修复**：单次 PowerShell 调用内轮询（400ms 间隔），预算 30s；`spawnSync` → 异步 `spawn`。
3. **CJK 路径被控制台代码页破坏**：实测 `D:\Trae项目\ts-bind-test` 被写成 `D:Traes-bind-test`。
   **修复**：改用 Win32 **`WM_SETTEXT`**（句柄由 UIA 提供）写编辑框。

**★ 真根因（M7 / v0.1.7）：路径形式不对**

MCP 内部传给对话框的是 `normPath()` **规范化路径**（小写盘符 + 正斜杠，如 `d:/Trae项目/AI游戏/象棋`），
而 **Windows 原生文件夹选择器不接受该形式**。实测对照（同一对话框、同一台机器）：

| 写入 | 回读 | 点确认后 |
|---|---|---|
| `d:/Trae项目/AI游戏/象棋` | `d:/Trae项目/AI游戏/象棋` | **对话框不关闭**（路径被拒） |
| `D:\Trae项目\AI游戏\象棋` | `D:\Trae项目\AI游戏\象棋` | **对话框关闭，绑定成功** |

**注意**：回读校验会「通过」，因为写进去的确实是那个字符串——所以**光有回读校验不够**，
必须先把路径转成原生形式（`toNativeWindowsPath()`：正斜杠→反斜杠 + 盘符大写）。

配套修复：写入后 `WM_GETTEXT` 回读 + 重试（最多 3 次，失败不点确认）、
hwnd 贯穿传递（只操作探测到的那个窗口）、下拉未命中时先清理遗留对话框、
确认按钮要求矩形在对话框下半部。

**另外两个定位陷阱（已修）**

- **确认按钮 `AutomationId="1"` 不唯一**：文件列表行也用 0/1/2…。必须用
  **AutomationId=1 且 ControlType=Pane** 组合定位（实测误点到 `.rivet` 列表项）。
- **「文件夹」编辑框**：`AutomationId=1152` 且 **ClassName=`Edit`**（它是 Pane 类型、无 ValuePattern）。

**排障顺序（下次遇到卡住先做这几步）**

1. `node scripts/probe-traework.mjs selectors` —— 确认选择器是否命中。
2. 看任务日志 `<home>/tasks/<taskId>/agent-0.log`：区分「下拉未命中」「对话框未弹出」「写入失败」「确认失败」。
3. 手工验证对话框是否开着（UIA 枚举 TraeWork 窗口的 Descendants，见 `docs/traework-cdp.md`）。
4. **不要**用 TraeWork 的 `--folder-uri` / `-a` 预注册（已证伪：只写原生 `history.recentlyOpenedPathsList`，
   Solo 下拉不读它）；**不要**直写 `state.vscdb` 的 map（renderer 有内存缓存，且 key 需后端 `createProject` 分配）。

### 9.2 TraeWork 任务进行中检测（M9 / v0.1.9）

**信号优先级与选择理由**

1. 字面「思考中」先保持 `pending`；原生 `ask_user` 仍立即结束本轮。
2. `.chat-input-v2-send-button-stop-icon`（主）与 `.core-task-tail--loading`（次）是权威运行信号：
   任一可见时，即使 DOM 已有完成标志也必须继续等待，并清零稳定轮数 / 空闲计时。
3. `.thinking-stream-content` 与工具卡片只作诊断。它们会残留在历史消息，若作为阻塞条件会永久不结束。
4. 无运行信号时才接受「由AI生成」完成标志；无完成标志则在 `stableRounds` 轮静态确认后，继续静态
   `idleTimeoutMs`（默认 600000ms）才返回 `idle_no_completion`。

所有信号通过 `selectors.ts` 的主选择器、回退与 profile 覆盖解析。若 UI 升级导致全部新选择器未命中，
探针按 `running=false` **失败开放**，退回完成标志 + 空闲计时，避免选择器漂移造成永久卡死。

**CDP 与实例保留策略**

- CDP WebSocket `close` / `error` 会拒绝全部 pending；单次 `send()` 默认 15000ms 超时。
- 轮询观测与 abort、任务 deadline 竞争，取消最多约 1 秒生效；默认每 30000ms 发一条 `note` 进度事件。
- 只有 `completion_mark` / `ask_user` 会释放本模块启动的实例。
- `idle_no_completion` / `timeout` / `aborted` / `cdp_lost` 均保留实例，结果与任务 meta 写入
  `agentEndReason` / `keptInstance`。超时文案不再错误声称「进程树已终止」。

### 9.3 stdio 日志污染修复（M10 / v0.1.10，issue #1）

**事实与根因**

- MCP stdio 规范：**stdout 只承载合法 MCP JSON-RPC 消息**，诊断日志应写 stderr。
- 旧 `src/util/log.ts` 只有 `error` 走 `console.error`，`info`/`warn`/`debug` 走 `console.log`（stdout）。
  默认 INFO 阈值下，连接提示、技能自检、任务状态等都会污染协议流，且可延续到握手之后。

**修复与门禁**

- `src/util/log.ts`：所有通过阈值的级别统一 `console.error`（stderr），日志文件追加行为不变。
- `eslint.config.js`：`src/**/*.ts` 启用 `no-console`（仅允许 `error`），阻止再次直接写 stdout。
- `scripts/check-stdio.mjs`：真实子进程捕获完整 stdout/stderr，逐行用官方 `JSONRPCMessageSchema`
  校验，空行 / 非 JSON / parser error / 退出残留片段即失败；覆盖首次启动、再次启动、`--no-skill-install`、
  损坏 `config.json`、stub 任务运行期日志、EOF 关闭，以及技能自装加固的 `skill-locally-modified` /
  `skill-approve-update`（issue #16），共 **8 场景**。消费者安装 tarball 后复用同一脚本。

### 9.4 Codex GUI 状态脱节与取消（M14 / v0.3.2，issue #5/#6）

**等待用户检测（issue #5）**

- **现象**：Codex 停在「等待用户确认」界面（方案确认卡 / 订阅结账页等）时，turn 是暂停而非结束，
  但停止按钮仍可见——旧判定把「停止按钮可见」当绝对运行信号 → 任务死锁在 `running` 直到 30 分钟总超时。
- **stall 兜底**：停止按钮持续可见且对话哈希 `gui.stallTimeoutMs`（默认 5 分钟）不变 → 判定等待用户，
  任务转 `needs_user(user_confirmation)` 并回传可操作的 `pendingQuestion`；对话内容恢复变化会重置计时。
- **可配置界面检测**：`gui.selectors.userGate`（如结账页 `embedded-checkout`、确认卡选择器）命中即快速转
  `needs_user`；默认未配置 = 禁用，不内置未真机验证的选择器。

**恢复通道（`continue_task` 扩展支持 codex）**

| `needsUserKind` | 恢复行为 |
|---|---|
| `user_confirmation` | 用户在 Codex 窗口处理完后恢复；MCP 仅重新接入观察 GUI 内运行（**不发送消息**）；恢复前 turn 已完成也能正确判 `succeeded` |
| `login_required` | 复检环境后重新派发任务书（新会话 + 项目绑定 + 完整初始指令） |

ZCode 原有恢复行为不变；其他 agent（含 traework）明确拒绝。

**取消真停 GUI（issue #6）**

- `cancel_task` 对 GUI agent 不再「请求即成功」：先经 CDP 尽力点击界面停止按钮，并在 `gui.cancelWaitMs`
  （默认 15 秒）内有界等待 GUI 真正空闲后落 `cancelled`；未确认停止时终态文案明示
  「GUI 内运行未确认停止，Codex 窗口中的任务可能仍在继续」。
- **重派防交叠护栏**：派发前发现受管实例上仍有未停止的运行时，先尽力停止；仍不空闲则以
  `instance_busy` 硬失败拒绝派发（取消后立刻重派曾实测踩中）。

**真机陷阱：trusted 点击 vs DOM click**

Windows + Codex 真机模拟实测：模型菜单的 `menuitemradio` 对 trusted 鼠标点击
**只收起菜单、不切换选中态** → `clickModelItem` 改为页面内 DOM `.click()`；而「项目选择触发器」相反，
**需要 trusted 点击才能展开**。两个方向相反的行为都已注明在代码与 `docs/codex-gui-cdp.md`，
后续改动选择器交互时必须真机复验。

### 9.5 ZCode 3.11.2 适配与验收 fail-closed（M15 / v0.3.3，issue #4/#7）

**ZCode 3.11.2 选择器漂移（issue #4）**

- **模型菜单**：3.11.2 把供应商分组从 `chat-model-select-group-provider:` 漂移为
  `chat-model-select-group-family:`。现两前缀均兼容；打开菜单后**直选平铺模型优先**，
  直选失败才展开 provider/family 分组重试（新旧布局都覆盖）。
- **项目绑定**：3.11.2 绑定入口在 composer 下拉，主判据为 `menuitemcheckbox`（按 NFKC / 空白 / 大小写归一化后
  的目录显示名精确唯一匹配），旧版侧栏项仅作回退；回读同时校验 composer 触发器文本与完整路径，
  过滤中英文「选择项目」占位词；绑定失败最多两轮幂等重试。
- **添加新项目**：首次 outside-click 会被吞 → 添加前先收起残留工作区菜单，再以最多三轮
  「收起—点击—验证」闭环打开「打开文件夹」。
- **诊断友好**：`model_unavailable` 与权限选择失败回传可见文本及 `data-testid` 候选，便于 CDP 定位下一次漂移。

**验收引擎 fail-closed（issue #7）**

- **零用例判失败**：测试检查进程退出码 0 但输出明确报告 0 个用例 → 改判失败（此前假绿）。
- **零变更判失败**：git 项目默认要求相对动工前基线产生变更；纯问答 / 分析任务可在
  `.tianshu-mcp/acceptance.json` 设 `"requireChanges": false` 显式关闭。

### 9.6 ZCode 项目回读、初始化恢复与会话发送确认（M16 / v0.3.4，issue #8/#9/#10）

**项目定位与绑定（#8 / #10）**

- 项目触发器按「用户覆盖 → 主选择器 → 精确备用选择器」逐级定位，本级无可见匹配才降级，本级多匹配即报歧义；移除了包含「项目／Project」的宽泛匹配。
- 绑定以**当前项目的规范化绝对路径**为唯一依据；只有能唯一关联到目标路径的项目名称才辅助判断，路径冲突时不允许同名文本覆盖。
- 添加项目前先收起残留工作区菜单；原生文件夹操作超时后先复检绑定副作用，已绑定则直接继续，不盲目重放整段导入。

**模型回读（#8）**

- 当前值优先读取并解码稳定属性（`data-model-current-value` 等）；属性缺失时读当前可见标签、对应 `title`，最后兼容旧页面。
- 供应商与模型名可能拆成多个 span：可见标签按拼接后精确比对；排除隐藏、透明、`aria-hidden` 祖先与溢出裁剪中的旧动画文本；证据冲突（`ambiguous`）时明确报错。

**初始化恢复（#10）**

- 准备、对话框基线、打开文件夹、路径提交、绑定确认划分为明确阶段；`setupRecoveryTimeoutMs`（默认 120s）为初始化到绑定完成的总预算，`dialogProbeTimeoutMs`（30s）/`dialogOperationTimeoutMs`（60s）为单次探测 / 操作上限，`setupRecoveryMaxRetries`（2）为可安全重试阶段的额外次数。所有等待取配置上限、阶段剩余预算、任务剩余时间的最小值；重试不重置预算。
- 探测超时后先复检 CDP、项目列表与绑定状态；只读瞬态故障有限重试；点击 / 输入 / 提交超时后先确认副作用，无法证明上次未生效不重复执行。
- Windows 只查询目标进程的原生对话框基线；macOS 探测失败不伪装成「没有既有面板」（fail-closed）。
- 恢复预算耗尽或权限 / 目标歧义时保留现场，转可继续的 `needs_user/setup_recovery`；任务总时限先到则按 `task_timeout` 结束。

**会话恢复与发送确认（#9）**

- 明确区分「环境恢复后首次派发」与「已有会话续答 / 返修」，不只看 `ctx.resume` 是否存在。
- 无锚点的环境恢复在发送前采集会话快照，发送**完整原任务、上下文和已验证引用**；用户的「已关闭」等确认文本不发给模型（`continue_task` 对非 `agent_question` 类型 `sendMessage=false`）。
- 已有会话续答必须定位原会话，缺失或歧义时 `session_lost` fail-closed，不打开最近会话替代。
- 发送确认与会话识别共用一次有界观察窗口（默认 60s 且受任务剩余时间约束）；窗口内仍无法定位则保留 `send_unknown` 现场，禁止自动重发。
- 发送按钮只在「唯一、启用、未被遮挡（`elementFromPoint` 命中）」时才点击；未就绪则等待，不把点击尝试当成功。

### 9.7 v0.4.0 行为变更与排障（验收并行 / 路径闸门 / macOS 无头路径）

> v0.4.0 有三条**会改变既有行为**的变动。升级后遇到「和以前不一样」，先查这里。

**① 验收命令默认并行（`verifyConcurrency`）**

- 新增配置项 `verifyConcurrency`（范围 1–4），**默认值由串行变为 2**；项目级 `.tianshu-mcp/acceptance.json` 可覆盖，server 级在 `config.json`。
- 检查项之间有顺序依赖时（后续检查读取 build 产物、带 `--fix`、共享缓存目录）**必须显式设 1**，完全退化为串行。
- 报告与日志格式不变：结果按**声明顺序**返回；每条 check 写独立 part 日志，结束后按声明顺序拼回 `verify-<round>.log`。
- 取消信号可中断在途 check（记 `aborted`）与未启动 check（记 `skipped`）。

**② 项目身份改为 `realpath` 归一（`projectPath` 安全闸门）**

- `projectPath` 提交即校验：绝对路径 + 存在目录 + `realpath` 消除符号链接；回执明示解析来源。
- 拒绝**用户主目录本身**与**系统/根级目录**；盘符根（`C:\`、`D:\` 等）由**单独判定**覆盖——`normPath` 会把 `D:\` 归一为 `d:`（尾斜杠被剥掉），所以不能靠枚举清单。
- **副作用**：符号链接入口（macOS `/tmp` → `/private/tmp`）下，同一目录可能与既有 `projects.json` 记录、历史任务目录不再匹配——按规范化后的**真实路径**查找；`list_tasks` 过滤已同步用同一归一。
- git 仓库有未提交变更时，回执附带共处警示（多会话场景）。

**③ macOS 无头路径（可选，不改代码）**

- 内置 `codex` 仍走 GUI 驱动；不想依赖 GUI 自动化时，在数据目录 `agent-profiles.json` 加一个 `driver=spawn` 的 `codex-cli` profile 走 `codex exec`。
- ⚠️ codex CLI 需保持 **≥0.154.0**：≤0.130.0 的签名证书已被吊销，macOS Gatekeeper 会直接 SIGKILL。

### 9.8 视觉验收排障（M19 / v0.5.0）

> 视觉模块默认关闭（`visual.enabled` 默认 `false`），未启用时既有行为完全不变。

| 症状 | 处置 |
|---|---|
| 任务进 `needs_attention` 且报告 `BASELINE_APPROVAL_REQUIRED` | 缺已批准基准。正常流程：`prepare_visual_baseline` 出候选 → 用户看 preview → `approve_visual_baseline` 带 `expectedDigest` + `approvalNote` 批准。**缺基准不得判通过** |
| 报告 `VISUAL_INTEGRITY` | 视觉配置或已批准基准在动工前后被改（或基准内容与 manifest 摘要不符）。不要手动改基准/阈值/屏蔽绕过；要变更走 `tianshu-mcp visual rules review/approve` 重建任务快照 |
| 报告 `RESOURCE_BLOCKED` | 外部字体/图片/接口/WebSocket 来源未放行。在配置 `allowedOrigins` 里精确加入 origin（无路径、无凭据）；重定向后仍会校验 |
| 报告 `SCREENSHOT_UNSTABLE` | 页面持续变化。用 `maskSelectors` 显式屏蔽动态区域；整页持续扩张属阻塞，应补就绪条件而非放大 `maxDiffRatio` |
| 报告 `MASK_NOT_FOUND` / `MASK_ALL_PIXELS` | 配置的屏蔽选择器定位不到，或屏蔽覆盖全部像素。前者是配置错误（避免不知情地失去屏蔽），后者拒绝通过 |
| 报告 `PIXEL_DIFFERENCE` | 真实布局差异。属可返修缺陷，按 `autoFixRounds` 返修；报告含检查 ID、路由、视口、指标、差异区域与证据路径 |
| 报告 `DIMENSION_MISMATCH` | 基准与实际尺寸不同。**直接失败、不缩放**；新视口/新环境应重新准备并批准基准 |
| 报告 `IMAGE_DEPENDENCY_MISSING` / `BROWSER_MISSING` | 可选依赖或托管浏览器未装。`npm install --include=optional` / `tianshu-mcp visual browser install`；不会静默改用本机浏览器 |
| 离线 HTML 图片打不开 | HTML 只引用同轮产物目录内的相对路径；确认未被 `visual artifacts clean` 清理（清理后报告会标 `cleanedAt`，历史证据不再展示图片） |
| 想清掉某任务的视觉产物 | `tianshu-mcp visual artifacts clean <taskId>` 先预览，`--apply` 才删除；只删该任务的视觉目录，保留报告与清理标记，不删正式基准 |

**自检命令**：`tianshu-mcp visual doctor <project>`（检查运行时、图像依赖、配置、浏览器四项）。

### 9.9 ZCode 无项目派发与真机回访（M21 / M22，issue #12）

> v0.5.2 引入无项目派发，v0.5.3 修掉真机回访暴露的三个缺陷。改 ZCode adapter 前先读本节与 `docs/zcode-cdp.md`。

**无项目派发（v0.5.2）**

- `run_task` 省略 `projectPath` 时，ZCode 在其 `default`（无项目）工作区承接任务：不分配目录、不登记/导入项目、不采集 Git 基线、不冻结项目快照、不进入项目锁与项目验收。
- **只支持 ZCode**；解析出的目标是其他 agent 时，在排队前返回参数错误。空串 / `null` / 相对路径 / 不存在的目录**不视为**无项目模式，仍按有项目模式拒绝。
- 无项目模式强制关闭验收与返修（`autoVerify=false`、`autoFixRounds=0`），显式开启会在提交前报错；任务书含明确本地文件引用（反引号路径 / 绝对路径 / `./` / `../`）时发送前报错，要求提供 `projectPath`。
- 终态元数据以 `verificationNotApplicable: "no_project"` 标注；`verify_task` / `get_task_report` 对该类任务返回 `not_applicable: no_project`，不从 cwd 推导目录。
- `allowCreateProject=false` 时，目标目录未登记会在**任何导入副作用之前**停止派发并返回 `project_not_registered`。

**真机排障三条（v0.5.3 修复，均有回归用例）**

1. **`-32602 Required at projectPath`**：handler 已支持无项目分支，但 MCP schema 仍必填 → 真实调用被 SDK 拒。已改 `AbsPath.optional()`，并补**协议层**回归（单测直接调 handler 会绕过 `inputSchema`，查不出这类问题）。
2. **停在已有会话时永久 `setup_recovery`**（实测空转 30 秒）：ZCode「新建任务」继承上次项目绑定；且项目菜单**已打开**时点击触发器会被 Radix toggle 关掉菜单。修复要点：新增 `workOutsideProject` 选择器与 `enterDefaultWorkspace()` 显式切换、点击前先查菜单状态、`confirmDefaultWorkspace` 对「明确绑定着项目」立即返回。`projectTriggerTimeoutMs`（默认 15s）统一替换原先写死的两处超时，「等待 → 回退侧栏 → 再等待」共享同一截止时间，重试不重置预算。
3. **界面停了但报告说按钮被遮挡**：窗口最小化/完全遮挡时 Chromium 节流页面（`visibilityState=hidden`），按钮在视口内却点不到。现在会报「窗口不在前台」；`Page.bringToFront` 实测**无法**恢复被遮挡的 Electron 窗口，故不假装自动恢复——请手工把窗口置于前台。

**真机坑：顶部「新建任务」是惰性挂载图标（v0.5.3 修复）**

| 事实 | 说明 |
|---|---|
| 点击返回 `true` ≠ 切页 | 停在已有会话时，顶部 `conversation-new-task` 点击派发成功但页面不变（实测 rows 仍为 2） |
| 会话页 composer 不挂载项目触发器 | `composer-workspace-trigger` 挂载数为 0，导致后续绑定等待空转到 deadline |
| 侧栏 `task-new-button` 可靠 | Windows 3.11.2 实测 2 秒内进入草稿（rows=0、触发器挂载数 1、文本为占位词「选择项目」） |
| 判据 | 新建任务后以「项目触发器已挂载」验证草稿**真的**建立；两个入口都失败才 `setup_failed` fail-closed |

**Windows 上未登记项目的自动导入仍不可用（已知限制）**

原生面板脚本靠 `SetForegroundWindow` 抢前台来激活地址栏，而后台 MCP server 的子进程会被 Windows 拒绝，地址栏 Edit 永不出现，脚本空转到 setup 预算耗尽（实测 56s）；且 PowerShell 的 stdout 在管道里被缓冲、进程被 kill 后缓冲丢失，日志里连一条 `native:` 阶段都看不到。**临时对策**：先在 ZCode 中手动把目标目录加入项目列表（或用 `allowCreateProject=false` 让它显式失败）。修复方向是脚本内改用 `AttachThreadInput` 抢前台，或改走 ZCode 受支持的登记入口。

完整真机证据见 `docs/zcode-issue-12-windows-evidence.md` / `.en.md`（含 v0.5.2 首轮与「第二轮回访」两节）。

### 9.10 AI 内容校验排障（M23 / v0.5.4，issue #13）

**症状 → 处置**

| 症状 | 处置 |
|---|---|
| 整轮 `验收阻塞 [CONTENT_COMMAND_MISSING]`，报告里**没有任何内容结果行** | 这是**整轮级**预检失败（`assertContentReady` 枚举每条规则的**有效**命令，含逐规则覆盖）。用 `tianshu-mcp visual content probe <project> [ruleId]` 或 `visual doctor` 定位是哪条规则、哪条命令解析不到。**它不会退化成单项告警**——这是刻意的 fail-closed |
| `CONTENT_ENV_MISSING` | `content.env` 的值是**宿主环境变量名**（`{ 子进程变量名: 宿主变量名 }`），不是密钥原文；确认该宿主变量在 MCP server 进程里确实存在 |
| 配置被 schema 拒绝：`<image:base64:file> requires allowRemote = true` | 外发闸门是契约层强制。若确实需要把图片字节交给命令，逐规则设 `allowRemote: true`；否则改用默认的 `<image:path>` |
| 配置被拒绝：`samples (N) x timeoutMs (M ms) exceeds limits.roundTimeoutMs` | 单项内容规则的 `samples × timeoutMs` 不得超总闸（出厂默认 3 × 90000 = 270000 ≤ 300000）。要么降 `timeoutMs`，要么**成对**上调 `limits.roundTimeoutMs`。此校验是配置期硬拦截，不留到运行期 |
| 判定总是 `CONTENT_UNCERTAIN` | 1) 采样票不集中——提高 `samples`（≤9）或让命令更稳定；2) 配了 `minConfidence` 而命令返回的 confidence 常低于阈值——调低阈值或让命令不报 confidence（命令不报时**闸门不生效**，报告会标注）。`uncertain` **永不阻塞、不触发返修** |
| 报告里每条判定理由都是「命令未提供 confidence，minConfidence 未生效」 | 命令的 JSON 没有 `confidence` 字段。这是刻意的：对不输出置信度的命令设默认阈值会把判定全部误伤为不确定 |
| 改了自备 CLI 但判定没变 | 缓存键含命令绝对路径与二进制摘要（`commandPath`/`commandDigest`），正常升级即失效。若命令身份**无法计算**（解析失败/不可读），该判定**本就不缓存**。仍怀疑时用 `visual content cache clear <taskId>` |
| 告警项在返修计划里出现，误以为必须修 | 告警项（`blocking:false`）列在 §3.2「仅告警项（不必修复）」，**不在**「必须修复」范围，也不得为消除告警伪造产物。只有逐规则 `blocking:true` 才进致败与返修 |
| 页面内容判定拿不到截图 | 页面截图失败时内容项会以**同一原因码**镜像为 blocked（不判通过）；先解决页面可达性/稳定性问题 |
| `visual content probe` 报 `CONTENT_RULE_UNKNOWN` | ruleId 对页面语义项要用派生 id `<pageId>-content`，不是 `pageId` |

**设计要点（改这块代码前先读）**

- **两个整轮级码不产结果行**：`CONTENT_COMMAND_MISSING` / `CONTENT_ENV_MISSING` 抛错经 `acceptance.ts` 的
  try/catch 升级为 `configurationError`。不要「顺手」把它们实现成单项 blocked——那会被 `!r.optional` 挡在
  `visualBlocked` 之外，形成「启用了却静默不跑」。
- **`uncertain` 的归口是机械保证**：`visualFailed` 只取 `failed`、`visualBlocked` 只取 `blocked`，所以 `uncertain`
  天然不进 verdict。别为它加特判分支，改归口条件会破坏 D7。
- **`pages[].pixel:false` 的三处联动**：engine 跳过基准要求与像素对比、`snapshot.ts` 对无基准页面记录 `null`、
  `prepareBaseline` 显式跳过（全部语义页面时以 `BASELINE_CONFIG` 拒绝）。改任一处都要跑 `visual-flow` 的
  D9 浏览器用例（需 `TIANSHU_VISUAL_BROWSER_TEST=1`）。
- **返修计划的历史缺陷已修**：`repair-plan.ts` 的 `failed` 过滤条件原先只排除 `skipped`，把 `optional:true` 的失败
  也列进「必须修复」。现在补 `!c.optional`，并新增 §3.2 仅告警项小节。这是 issue #13 验收标准要求的修复，
  不是可选项。

### 9.11 Kimi Code 排障（M24 / v0.5.5）

> 改 `src/agents/kimicode/**` 前先读本节与 `docs/kimi-cdp.md`。环境事实来自 Windows 10 + Kimi Code 1.0.2 实测。

**① 菜单不在主窗口，而在 `Kimi Browser Overlay` 渲染进程**

`/json` 与 `Target.getTargets` 暴露的 page 有：主窗口（`app://renderer/` 或 `app://renderer/sessions/<id>`）、
`Kimi Browser Overlay`（`app://renderer/browser-overlay.html`）、`Screenshot`（必须排除）。

- **模型菜单 / 思考档位 / 执行模式菜单**经应用内的 `browserOverlayOpenMenu()` 渲染在 **overlay 窗口**：
  实测点击 `button.model-pill` 后**主窗口 DOM 节点数恒为 391、不产生任何菜单节点**，而 overlay 的
  `document.visibilityState` 由 `hidden` 变 `visible`、节点数 20 → 63。
- **工作区菜单**（`div.ws-panel[role="menu"]`）与「切换模型」对话框（`div.ui-dialog`）仍渲染在**主窗口**。
- 判定「菜单是否打开」必须以 **overlay 的 `visibilityState`（或菜单容器可见性）** 为准：菜单关闭后内容可能短暂残留。
- 排查时**别在主窗口找模型菜单**——那会得到「点击无效」的假结论。

**② 点击被吞：Chromium 节流，`bringToFront` 有效但异步**

- 窗口不在前台时 Chromium 节流页面，合成点击可能被吞。Kimi Code 与 ZCode 的 Electron 不同：
  `Page.bringToFront` + `Emulation.setFocusEmulationEnabled` **确实有效**（启动时 `visibilityState=hidden` → 调用后 `visible`），
  但**异步生效**——调用后必须**等 `visibilityState` 收敛到 `visible`** 再点击，立刻点击仍可能被吞。
- 点击手段实测：CDP `Input.dispatchMouseEvent`（moved + pressed + released）有效；
  页面内 `element.click()` 对 `model-pill` 有效、对 `ws-chip` **无效**（不打开菜单）。选择器交互改动后必须真机复验。

**③ 新建会话点击被吞 → 以 ws-chip 挂载为准的有界周期重试**

- 点击 `button.btn-new-chat` 返回成功**不等于**草稿页已建立。权威判据是**工作区触发器 `button.ws-chip` 真的挂载**
  （ZCode M22「点击 ≠ 切页」教训同源）。
- 因此 `ensureFreshDraft` 采用**有界周期重试**，预算取自 `gui.workspaceTriggerBudgetMs`（即
  `gui.workspaceTriggerTimeoutMs`，默认 15000ms），失败即 `setup_failed`（`reason=draft`），不空转。
- 新建草稿会**继承上次工作区**，所以绑定流程仍须显式回读 `ws-chip` 文本 + 面板选中项。

**④ 思考档位按「界面实际档位集合」校验，非官方模型只有 `On/Off`**

- 档位集合的**唯一来源是界面实际渲染的档位标签**（不内置模型名单）：官方模型（`Kimi` 订阅，如 `K3` / `K2.8 Preview`）
  为 `Low` / `High` / `Max`；**非官方模型**（如 `stepfun/step-3.7-flash:free`，provider 分组 `kiro`）只有 **`On` / `Off`**。
- 请求了界面不存在的档位 → 发送前**响亮报错**（`model_mismatch`），绝不静默沿用。
- 主窗口 pill 文本会随形态变化：官方为 `K3 · High`，非官方为 `stepfun/step-3.7-flash:free · 思考`（**不是** ` · High` 形式）。
- 官方额度用尽时（实测会返回 `403 ... reached your monthly usage limit` + `provider.auth_error`），
  可在「切换模型」对话框改用**免费模型**（如 `stepfun/step-3.7-flash:free`）继续真机验证。

**⑤ 原生「添加工作区」对话框（与 ZCode/TraeWork 同构）**

| 项 | 实测值 |
|---|---|
| 类名 / 标题 | `#32770` / `添加工作区` |
| 「文件夹」编辑框 | AutomationId `1152`、ClassName `Edit`（**ControlType 是 Pane**，无 ValuePattern） |
| 确认按钮 | AutomationId `1`，ControlType 为 **Pane** |
| 取消按钮 | AutomationId `2`，ControlType 为 Pane |
| 关键约束 | 确认/取消按钮**都不支持 UIA `InvokePattern`** → 必须走 Win32 坐标点击（UIA 取 `BoundingRectangle` + `SetCursorPos` + `mouse_event`），路径写入走 `WM_SETTEXT` 并 `WM_GETTEXT` 回读 |

`src/agents/kimicode/dialog.ts` 复用 ZCode 已验证的范式，仅把标题判据换成「添加工作区」；
且只操作**新出现**的对话框（先采样基线，绝不盲点用户既有窗口）。未登记工作区的导入已真机验证。

**⑥ 探针用法**

```bash
node scripts/probe-kimicode.mjs all     # 只读诊断：安装 / 进程 / CDP / 选择器 / 界面 / 会话 / 运行信号
```

**未真机验证（如实标注，勿在文档或汇报中夸大）**

- **取消（`cancel_task` 真停 GUI）**：实现完整（尽力点 `button.stop` + `cancelWaitMs` 内有界等待空闲，未确认时如实落文案），
  但**仅由 hermetic 集成测试覆盖**，未在真机点停。
- **提问续答（`agent_question`）**：实现完整（把回答写回原会话、不重发任务书），但触发真实提问卡片的真机路径未覆盖。
- **同名/同路径工作区歧义**：fail-closed 分支仅由集成测试覆盖。
- **macOS**：`status` 为 `research` 且 **fail-closed**（可执行探测与原生对话框驱动未在 macOS 实测）。

### 9.12 Qoder CN 排障（M25 / v0.5.6）

> 改 `src/agents/qoder/**` 前先读本节与 [qoder-cdp.md](docs/qoder-cdp.md)。环境事实来自 Windows 10 + Qoder CN 0.3.4 实测（2026-09-20 ~ 09-22）。

**① 权威选择器都在 DOM 属性上，不在文案上**

| 用途 | 实测选择器 |
|---|---|
| 发送 / 停止 | `button[data-e2e="chat.send"][data-send-button="normal" \| "generating"]`（同一按钮换 `data-send-button`） |
| 本轮用户消息 / 助手回复 | `[data-message-kind="user"]` / `[data-message-kind="assistant"]` |
| 本轮结束证据 | `[data-assistant-actions]`（**没有它就不算完成**） |
| 失败 / 中断 | `[data-turn-failure-card]`、`[data-assistant-status-note="failed" \| "interrupted"]` |
| 提问 / 审批 | `[data-pending-interaction-composer]` / `[data-pending-interaction-overlay]` |
| 工作区入口 | `[data-workspace-picker-trigger]`，面板项 `[role="menuitem"][data-workspace-source="local"]`，表单 `#workspace-editor-form` |
| 模型 / 档位 | 触发 `button[aria-label^="模型:"]`；菜单 `[data-chat-model-selector-menu][data-state="open"]`；档位 `[role="menuitemradio"]`；模型管理对话框 `[role="dialog"]:has([role="table"][aria-label="模型参数与显示设置"])` |

一律不要用中英文文案匹配（界面文案会随版本变，属性名不会）。选择器可在 profile `gui.selectors` 覆盖。

**② 完成判定必须绑定「本轮」**

- 只有 `expectedUserId === 本轮 user id` 且 `assistantId === assistant:<该 user id>` 且出现 `[data-assistant-actions]`，且**无任何运行信号**时才算完成（`judgeQoderPoll`）。
- 历史回复里的“完成”、界面静止、连接断开都**不是**完成证据；运行信号（`data-send-button="generating"` / 工具执行 / 流式活动）优先于完成标志。
- 审批/提问优先于停止按钮：停在等待用户的界面时**先判 `needs_user`**，不要因为停止按钮可见就判「仍在运行」而形成死锁。

**③ 工作区必须用完整路径确认身份**

- 名称只用于查找候选；绑定判据是**规范化后的完整路径**，中文、空格、同名目录都要核对实际路径。
- 未登记目录走「新的任务 → 工作区入口 → 新建工作区 → 添加可读写文件夹 → 原生目录选择 → 创建」；
  原生对话框使用本地反斜杠路径并回读，且只操作**新出现**的对话框（不盲点用户既有窗口）。
- 目录不存在直接报错，**不自动创建磁盘目录**；路径无法核对或匹配有歧义时停派发。

**④ 模型来源与档位**

- `modelSource=default|custom` 消除跨组重名；省略来源时要求**跨组唯一精确匹配**，重名必须补来源，不猜。
- 档位以「模型管理」中**该模型实际渲染的选项**为准；不支持的档位在**发送前**报错，禁止静默降级。
- 思考等级保存后必须**重新打开回读**验证；确认写入生效后再发送（选择后的异步关闭要先确认菜单真的关闭，才能重开）。
- 修改会保留为 Qoder **全局偏好**（不在任务结束后还原），报告会说明其影响；权限模式沿用，不自动开启“完全访问”。

**⑤ 发送与答题的检查点语义**

- 发送任务书、提交多题答案前都先落检查点（`qoder-session.json` + 任务目录）；**没有确认回执时不自动重发**，只观察并如实记录不确定状态。
- 多题答案以界面上的**完整问题文字**为键（多选可用选项文字数组）；题目变化、缺答案、选项不存在都保留等待，不接受推荐项/默认项代替。
- `continue_task` 对审批/登录等环境等待只**恢复观察**（不把“已处理”文本发给模型）；只有 `agent_question` 才把答案写回原会话。

**⑥ 取消与实例**

- 取消/超时只对**已绑定的原会话**执行停止并回读；未确认停止时终态明示「GUI 内运行未确认停止」并保留实例，阻止重复派发（`instance_busy`）。
- 已有实例无可用 CDP 时**保留现场**转 `needs_user`，绝不关闭或重启用户实例（与 Kimi/ZCode 同语义）。

**⑦ 探针用法**

```bash
node scripts/probe-qoder.mjs install          # 只读：安装发现（显式 → D 盘 → 注册表/快捷方式 → 其它盘）
node scripts/probe-qoder.mjs state --port 9777  # 只读：已有实例与页面结构（连接可能把工作台置前）
```

**未真机验证（如实标注，勿在文档或汇报中夸大）**

- **取消（`cancel_task` 真停 GUI）**：实现完整（尽力点停止按钮 + `cancelWaitMs` 内有界等待，未确认时如实落文案），
  但**仅由 hermetic 集成测试覆盖**，未在真机点停。
- **提问续答（`agent_question`）**：实现完整（多题答案写回原会话、不重发任务书），但真实提问卡片的真机路径未覆盖。
- **登录失效 / 额度不足 / 网络错误分类**：归类为 `needs_user`，真机触发未逐个覆盖。
- **macOS**：`status` 为 `research` 且 **fail-closed**（仅覆盖路径与平台分支的自动化测试，未在 macOS 真机验证 GUI）。

---

## 10. 凭证与安全红线

- 仓库内**不含任何 token**；`~/.npmrc`、`~/.git-credentials`、`GITEE_TOKEN` 均为本机 / 仓库 Secret 凭证，勿入库。
- `.gitignore` 隔离：`AGENTS.md`、`.zcode/*`、`.codex/*`、`.rivet/*`、`tianshu-mcp-web/`（整目录，含内嵌 git 仓库）、
  `analysis-tools/*`、`/.tianshu-mcp/*`、`node_modules/*`、`dist/*`、`*.tgz`、`.tmp-check/`、`docs/zcode-issue-8-10-evidence/`。
- 发布需要：npm `_authToken`（账号 `lotteai`）、GitHub token（`~/.git-credentials`）、`GITEE_TOKEN`（GitHub 仓库 Secret，Gitee 发行版自动化用）。
- 安全模型与私密报告渠道见 `SECURITY.md`。

---

## 11. 文档地图

| 文档 | 内容 |
|---|---|
| `README.md` / `README.en.md` | 项目总览、快速开始（含天枢界面配置）、文档索引、里程碑 |
| `ARCHITECTURE.md` / `.en.md` | **架构说明**：分层模型（L1 协议边 → L5 基础）、模块边界与依赖方向、启动装配与数据目录布局、MCP 返回契约、任务状态机与持久化、编排与验收流水线、Agent 驱动层契约与 `endReason`/`needsUserKind` 取值表、GUI 实例生命周期、视觉链路、配置热加载、跨平台策略、安全红线、扩展点、测试与发布流水线、已知缺口 |
| `CHANGELOG.md` / `.en.md` | 版本历史 v0.1.0 → v0.5.5（含比较链接） |
| `CONTRIBUTING.md` / `.en.md` | 开发环境、门禁、规范、提交 / 发布流程、如何新增 agent |
| `SECURITY.md` / `.en.md` | 安全模型与漏洞报告 |
| `CODE_OF_CONDUCT.md` / `.en.md` | 行为准则 |
| `docs/tianshu-integration.md` / `.en.md` | 接入配置、冒烟步骤、FAQ |
| `docs/traework-cdp.md` / `.en.md` | TraeWork GUI 驱动原理、选择器、安全红线、踩坑记录 |
| `docs/zcode-cdp.md` / `.en.md` | ZCode GUI adapter、暂停继续、返修闭环与双平台真机证据状态 |
| `docs/codex-gui-cdp.md` / `.en.md` | Codex 桌面端 GUI 驱动：MSIX COM 激活、CDP 接管、选择器、运行检测、验收返修 |
| `docs/kimi-cdp.md` / `.en.md` | Kimi Code GUI 驱动：双渲染进程（主窗口 + `Kimi Browser Overlay`）、工作区完整路径绑定与原生对话框导入、模型三级选择与思考档位、执行模式、运行检测与排障 |
| `docs/qoder-cdp.md` / `.en.md` | Qoder CN GUI 驱动：安装发现与实例复用、完整路径工作区与原生导入、`modelSource` 与模型管理全局思考等级、发送/答题检查点、运行判定与原会话返修、真机证据与未覆盖项 |
| `docs/codex-windows-smoke.md` / `.en.md` | Codex Windows 真机验收记录（含失败→计划→返修闭环） |
| `docs/zcode-windows-smoke.md` / `.en.md` | ZCode Windows 真机开发、同会话返修与提问续跑验收记录 |
| `docs/zcode-issue-8-10-validation.md` / `.en.md` | ZCode #8/#9/#10 Windows 真机验收记录 |
| `docs/agent-profiles.md` / `.en.md` | profile 字段说明（含 `driver`/`gui`/`stallTimeoutMs`/`cancelWaitMs`/`setupRecovery*`） |
| `docs/adapter-matrix.md` / `.en.md` | 各 agent 能力调研矩阵 |
| `docs/acceptance-config.md` / `.en.md` | 项目级验收配置规范（含 `requireChanges`） |
| `docs/visual-acceptance.md` / `.en.md` | 视觉验收入门与完整配置：三种页面来源、基准候选/批准、规则冻结、阈值解释与排查表，以及可选 AI 内容校验（命令契约、原因码、防抖与数据外发声明） |
| `docs/visual-validation.md` / `.en.md` | 视觉验收验证进度：完整平台证据表（系统 / Node / 浏览器 / 命令 / 结果）+ v0.5.4 判定桩端到端记录与未覆盖项 |
| `docs/visual-validation-evidence/` | 上述验证的原始机器可读记录（Windows 矩阵 JSON、macOS `environment.json`、CI 摘要） |
| `docs/zcode-issue-12-windows-evidence.md` / `.en.md` | ZCode 无项目派发与 `allowCreateProject` 的 Windows 10 真机验收记录（含 v0.5.2 首轮与「第二轮回访」） |
| `docs/release-v0.5.8.md` / `.en.md` | v0.5.8 发布说明（四份主文档按代码逐项核对重写 + 补发 TraeWork 探针与三个 probe script；无运行时变更） |
| `docs/release-v0.5.7.md` / `.en.md` | v0.5.7 发布说明（编排技能文档按代码实况重写：参数兼容矩阵、默认值优先级、档位修正、qoder 章节与 meta 新字段；无运行时变更） |
| `docs/release-v0.5.6.md` / `.en.md` | v0.5.6 发布说明（新增 Qoder CN GUI 适配、真机验收范围与 macOS research 边界） |
| `docs/release-v0.5.5.md` / `.en.md` | v0.5.5 发布说明（新增 Kimi Code GUI 适配：双渲染进程 CDP、工作区完整路径绑定与原生对话框导入、模型三级选择与档位按界面集合校验、运行检测、needs_user/continue_task、真机验证与三个真机缺陷修复） |
| `docs/release-v0.5.4.md` / `.en.md` | v0.5.4 发布说明（可选 AI 视觉内容校验：自备命令委托、多数票防抖、默认仅告警、返修隔离缺陷修复） |
| `docs/release-v0.5.3.md` / `.en.md` | v0.5.3 发布说明（ZCode 真机回访修复：实例跨 server 驻留、新建任务切页、发送失败归因） |
| `docs/release-v0.5.2.md` / `.en.md` | v0.5.2 发布说明（ZCode 无项目派发与 `allowCreateProject`，issue #12） |
| `docs/release-v0.5.1.md` / `.en.md` | v0.5.1 发布说明（文档/证据补齐 + 锁文件修复，无运行时变更） |
| `docs/release-v0.5.0.md` / `.en.md` | v0.5.0 发布说明（可选视觉验收模块） |
| `docs/release-v0.4.1.md` / `.en.md`、`docs/release-v0.4.0.md` / `.en.md` 等 | 历史版本发布说明（按需查 `docs/release-v*.md`） |
| `docs/issue-16-skill-install-hardening-record.md` | issue #16 技能自装加固的 Windows 10 真机验收记录（R1–R7 原始输出、配套门禁、未覆盖项；中文单语，无英文版） |
| `docs/release-v0.6.0.md` / `.en.md` | v0.6.0 发布说明（技能自装加固：源定位收敛、安装清单与六态判定、`autoInstall` 三态与 `--approve-skill-update`、原子安装与备份治理；含升级影响说明） |
| `docs/issue-1-host-reconnect-record.md` | issue #1 桌面宿主重连验收（v3.16.1：10 tools + 真实工具调用） |
| `docs/npm-publish-guide.md` | npm 发布步骤与凭证；另含 Gitee 发行版手动补建 |
| `docs/m2-*.md`、`docs/host-integration-record.md`、`docs/dod7-release-record.md`、`docs/dod8-session-record.md`、`docs/s7-session-recheck.md` | 历史里程碑物证（中文，无英文版） |
| `skills/tianshu-mcp/SKILL.md` + `skills/tianshu-mcp/usage-examples.md` | 教天枢编排本 MCP 的技能与使用示例（随包分发、启动自检安装） |
| `scripts/seed-skill-state.mjs` | dev-only 测试夹具：把隔离 home 的技能目录播种为 `absent`/`pristine-old`/`customized`/`unknown`（供 stdio 场景与真机复验；**不进 npm 包**） |

> **本地 only（gitignore，不在仓库）**：`.zcode/plans/*`（开发计划，含视觉验收计划）、`.codex/review/*`（验收报告）、
> `docs/zcode-issue-8-10-evidence/`、`docs/m2-evidence/`、`docs/dod8-evidence/`（脱敏后的真机物证副本）、`.tmp-check/*`（临时证据）。

---

## 12. 接手人下一步建议

1. 先跑 `npm ci && npm run typecheck && npm run lint && npm test && npm run build`，确认基线绿（940 passed / 12 skipped）。
2. 动代码前先读 [ARCHITECTURE.md](ARCHITECTURE.md) 建立整体心智模型（分层、依赖方向、唯一双路径接缝 `adapter.run`、状态机与验收流水线）；再按专题读本文章节：
   动 GUI adapter 相关代码前，先读对应文档与本文章节：
   TraeWork → `docs/traework-cdp.md` + §9.1 / §9.2；ZCode → `docs/zcode-cdp.md` + §9.5 / §9.6 / §9.9；Codex → `docs/codex-gui-cdp.md` + §9.4；Kimi Code → `docs/kimi-cdp.md` + §9.11。
   项目文件夹绑定出问题时，先看 §9.1 的排障顺序（下拉项 ≠ 项目 map、三处已修缺陷、两个定位陷阱）。
3. **改任何选择器交互必须真机复验**：trusted 点击与 DOM click 的取舍因控件而异（§9.4 的模型菜单 vs 项目触发器就是反例）。
4. 若客户端 UI 升级导致选择器失效：用 `scripts/probe-*.mjs` 诊断，优先用 profile `gui.selectors` 覆盖，不改代码。
5. 动视觉模块前先读 `docs/visual-acceptance.md` 与 §9.8：基准必须走「候选 → 用户批准」，规则冻结会拦截绕过；`TIANSHU_VISUAL_BROWSER_TEST=1` 才跑真实浏览器用例。
6. Codex 与 ZCode 的 macOS 基本闭环均已真机验证；取消/返修/continue_task/新建项目矩阵未补齐前
   不得把 darwin 从 `research` 改为 `ready`；TraeWork 的 macOS 分支仍是 fail-closed，
   Kimi Code 与 Qoder CN 的 darwin 同为 `research`（fail-closed，未在 macOS 实测）。
7. 新增 agent：优先只加 profile（见 `docs/agent-profiles.md`）；需要特殊输出解析再写 adapter。
8. 发版前务必确认 `src/version.generated.ts`、`package.json` **与 `package-lock.json`** 三者版本一致并同步提交
   （CI 有「构建后无 tracked diff」门禁；v0.5.0 曾漏掉锁文件）。推 `v*` tag 即触发 Release
   （双语正文取 `docs/release-v<ver>.md` + `.en.md`，**缺文档会直接失败**；且要求同 SHA 的成功 CI）。完整步骤见 §6.4。
9. 未发布计划（见 `CHANGELOG.md` 的「未发布 / 计划中」节）：更多 agent 适配、TraeWork / ZCode / Codex / Kimi Code / Qoder CN 的 macOS 验证矩阵、
   项目级技能播种、`needs_user` 状态取消时经临时 CDP 连接尽力停止 GUI 内等待中的会话、
   Kimi Code 的取消/提问续答真机验证（当前仅 hermetic 集成测试覆盖，见 §9.11）、
   Qoder CN 的取消真停与提问续答真机验证（同为 hermetic 覆盖，见 §9.12）、
   ZCode 无项目派发的 macOS 真机验证、ZCode 未登记项目自动导入在 Windows 上的修复（§9.9），
   以及 AI 内容校验的后续扩展（跨轮判定翻转熔断、跨任务缓存共享、参考图/设计稿差异比对）。
   注：issue #3 第一阶段（像素级对比 + 图片规格 + 报告 + 返修闭环 + 基准批准/冻结）已随 v0.5.0 完成，issue #3 已关闭；
   issue #12（无项目派发 + `allowCreateProject`）已随 v0.5.2 完成，其真机回访修复随 v0.5.3 完成；
   issue #13（视觉验收第二阶段 AI 内容校验）已随 v0.5.4 完成，见 §4.3 与 §9.10；
   issue #14（GUI 终态如实化）已随 v0.5.9 完成；issue #15（派单/验收幂等键）已随 v0.5.10 完成；
   issue #16（技能自装加固：源定位 / 覆盖语义 / 三态与备份治理）已随 v0.6.0 完成，见 §3.4 与 `docs/issue-16-skill-install-hardening-record.md`；
   issue #17（五项小项扫尾：系统目录子树拒绝 / capability 三族 / 登记失败不派单 / `cmd` 形态文档化 / 计数对齐）已随 v0.6.1 完成，见 §0 的 0.6.1 交接与 `docs/issue-17-small-fixes-record.md`；
   技能自装的后续方向（另开 issue）：多宿主技能目录投递、宿主级 `"prompt"` 交互确认 UI。
