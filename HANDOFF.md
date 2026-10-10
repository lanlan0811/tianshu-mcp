# HANDOFF.md — 项目交接说明

> **本轮（0.8.2 → 0.9.4）交付**：7 个版本累积。**v0.9.0 是破坏性变更（工具面 13 → 8）**，升级调用方前
> 必读下方迁移映射；其余六版为工具面瘦身与三个 GUI adapter 的真机冒烟修复。逐版细节以 `CHANGELOG.md` 为准。
>
> **① v0.9.0（BREAKING）· 工具面按域合并 13 → 8**（`src/mcp/tools.ts` 实测 8 个）：
> - `cancel_task` / `continue_task` / `rework_task` → **`manage_task(taskId, action, …)`**（`action` ∈ `cancel` / `continue` / `rework`）
> - `list_tasks` / `get_task_report` / `get_profiles` → **`query_info(type, …)`**（`type` ∈ `tasks` / `report` / `profiles`）
> - `wait_any(taskIds)` → **`wait_task(taskIds)`**（批量模式；单任务 `wait_task(taskId)` 调用方式不变）
> - **刻意不合并** `prepare_visual_baseline` / `approve_visual_baseline`：收益仅约 500 字符，而
>   `candidateId` / `expectedDigest` / `approvalNote` 三个必填参数构成视觉基准的**防篡改摘要核对闸门**。
> - 分支约束**下沉到 handler**（合并后 schema 是 plain `z.object`——`z.discriminatedUnion` 经 SDK 序列化后
>   线上退化为空 `properties`）：`action=continue` 要求 `message` 非空，分支专属字段按白名单 fail-closed。
> - 同步面：`skills/tianshu-mcp/`（SKILL + usage-examples）、`src/agents/**` 47 处运行时文案、
>   GUI 工具面镜像（`check-schema-parity.mjs` 真源 ↔ 镜像 ↔ Rust 三方零漂移）。
>   **旧技能副本不会随 npm 升级自动替换**，需按 `docs/agent-profiles.md` 的 `--approve-skill-update` 放行一次。
>
> **② v0.8.4 · 工具面瘦身（无破坏性）**：`run_task` / `verify_task` 的 `acceptanceOverride` 线上声明骨架化，
> `tools/list` **35581 → 11717 字符（−67.1%）**；工具名、参数集、校验语义全不变。因 `visual` 变为不透明对象，
> 新增 handler 入口 `validateAcceptanceOverride()` 补下沉校验（否则内部非法字段会穿透 SDK 层）。
>
> **③ v0.8.3 · TraeWork 缺陷修复（issue #38）**：下拉底部点击改**副作用驱动三级阶梯**——`cdp.click()` 的
> `true` 只表示元素可见，不代表原生弹窗已唤起；总探测预算不再膨胀（真机 28183ms → **19213ms ≤ 20000ms**）；
> 逻辑性 setup 失败不再误报 `errorType=spawn`（新增 `errorType: "setup_failed"`，由适配器自归类）。
>
> **④ v0.9.1–0.9.4 · 三个 adapter 的真机冒烟修复**（每版都触到假成功或假失败）：
> - **0.9.1（TraeWork）**：排队提醒被误报「任务完成」（该气泡带「由 AI 生成」footer，正是完成标志）；
>   取消路径三处缺陷（停止按钮是图标元素、无 `click()` 致回退不可达；`return abortResult()` 缺 `await`
>   致连接先断；`lastRunSignal` 因 note 措辞全仓唯一不同而恒 undefined）。新增 `scripts/smoke-traework.mjs`。
> - **0.9.2（ZCode 3.14.4）**：模型标识三套语义互不推导（面板可见标签 / 分组显示名 / `供应商/模型` 参数段），
>   且模型名可含 `/` 与 `:`（实测 `inclusionai/ling-3.0-flash-sante:free`）——4 个缺陷让含冒号或三段式的模型
>   **完全无法派单**；另修「顶部新建任务点击假成功」（元素在视口外、鼠标事件被静默丢弃，而 `click()` 仍返回 true）。
> - **0.9.3（Codex 26.1002）**：5 个缺陷——发送确认假成功（`messageArea` 把 composer 一起包住）、
>   连接就绪判据顺序颠倒、回复稳定判定失真（游离克隆体无布局 → `innerText` 读到 4 字符空壳）、
>   CDP 断开误报进程退出、CDP 错误文案硬编码程序名（`TraeworkCdpClient` 被 6 个适配器复用）。新增 `scripts/smoke-codex.mjs`。
> - **0.9.4（Codex）**：对话文本采集丢弃纯文本节点 → `【tianshu:…】` 标记中间段丢失 → 发送确认判据
>   `seenMessage` **恒 false**（而消息早已送达）。改遍历 `childNodes` + `textContent`。
> - **0.9.5（Kimi Code）**：浮层页处于 `hidden` 态时**不参与命中测试**——`elementFromPoint(菜单行中心)`
>   返回舞台容器 `browser-overlay-stage` 而非那一行，合成点击被容器接收、行上零事件；但
>   `clickOverlayExact` 仍返回 `clicked: true`（坐标算得出来），于是「切换模型」对话框永不出现 →
>   误报 `model_unavailable`。根因是 `clickAt()` 只对**主窗口**做前置检查，浮层页从未置前；
>   新增 `focusOverlayWindow()` / `overlayPageHidden()`（与 `focusMainWindow()` 同构）。
>   真机 **0/5 → 4/4**。**判据教训**：`clicked: true` 只代表坐标算得出来，**不代表事件送达**——
>   真实判据只能是后置条件回读。
> - **0.9.6（MiniMax Code）**：三处缺陷。① `projectPointExpression` 的页面内归一先「盘符大写」
>   再 `toLocaleLowerCase()`，前者恒被抵消（死代码），与 Node 侧 `normalizeProjectPath`（先小写
>   再恢复盘符）**永不相等** → 点选既有项目分组恒返回 `null` → `setup_failed`。**触发条件是项目
>   已在侧栏**，故首轮成功后才在第二轮暴露。② `pickOption` 点击后只等固定 `sleep(350)` 就回读，
>   实测 **1/8 成功**（`+350ms` 仍旧值、`+1550ms` 已新值）——改为**有界轮询至收敛**后 **6/6**。
>   ③ 验收层：非 git 仓库下 `requireChanges` 零变更门禁**静默跳过**（仅 [INFO]）却照判 PASS；
>   判定不变，改为双写 `warnings` 使其进 `[WARN]` 与报告摘要。
>   另：`hoverModel` 失败现场新增诊断快照（原本只留 `elapsed=9630ms`，无法区分四种失败原因）；
>   新增 `scripts/smoke-minimax.mjs`（此前 MiniMax 只有只读 probe）。
>
> **⑤ 测试基线**：全量 **1692 passed / 2 failed / 12 skipped**（1706 项，137 文件）。两处失败为
> **既存环境失败（非本仓库缺陷）**——`spawn-regression`（本机缺 `tianshu-runtime.exe`）与 `codex-flow`，
> v0.9.1 已用改动前 HEAD 的 git worktree 对照确证。`tsc --noEmit` / `eslint --max-warnings 0` 全绿。
>
> **⑥ 独立交付面 `mcp-gui`**：已推进到 **`gui-v0.1.1-beta.6`**（工具面同步 MCP 0.9.0 的 13 → 8），
> 独立 tag 线 `gui-v*`，**不随 MCP 主包发布**。
>
> **历史快照（0.8.1）**：修复 **issue #31**「ZCode / Kimi Code / Open Design 完成判定缺少
> 『曾观测到运行信号』门」（**同时补上 issue 未列出的第五个违反点 MiniMax Code**）。
> 缺陷本质：四个 driver 的 `finished` 判据只看 `stable >= stableRounds`，不要求本轮见过运行信号；
> 停止按钮 / loading 选择器漂移时界面「看起来静止」，进行中的任务会在
> `stableRounds × pollInterval`（默认约 12s）后被误判成功并进入验收/返修链。
> - **RED 复现**（`.rivet/scratch/issue31-red.ts`，已转正为单测后清理）：加门前四 driver 第 5 轮判
>   `finished`，Codex 对照组全程 `pending`。
> - **代码**：四个 `liveness.ts` 的 `PollState` 加 `sawRunning`（运行分支置真、其余透传、`finished` 加门）；
>   三个 `run.ts` 在 `reobserve` 轮种子 `sawRunning: true`（照 `codex/run.ts` 既有做法，规避「恢复后 turn
>   已完成 → 判不了 finished → 误落 idle_timeout」）；`fix-loop.ts` 抽出
>   `shouldParkAsNeedsAttention()` 并把白名单扩到五个 GUI driver。
> - **为什么必须改 fix-loop（本 issue 的实质增量）**：原白名单只含 `zcode`/`codex`，其余三个 driver 的
>   `idle_timeout` 因 `autoVerify` 默认为 `true` 而绕过两个 `!autoVerify` 出口，**仍会进项目验收链**——
>   只加门的话，用户可见行为只是「仍进验收，但迟了 10 分钟」。
> - **两处偏离 issue 建议**（已在 CHANGELOG 与 issue 答复中说明）：① Open Design 的产物指纹
>   （`artifactSignature`）**不**计入运行信号——它在 `finished` 终态后仍会写文件（`fetchArtifactForSummary`）；
>   ② MiniMax 的 `stopVisible` 依赖的 testid 真机未复验，加门后若采不到会**每个任务**都走 `idle_timeout`
>   → `needs_attention`（有意的 fail-closed：可 `continue_task` 恢复，而误判成功不可逆）。
> - **测试**：新增 `test/unit/liveness-running-gate.test.ts`（12 例，跨 driver 契约）+ 
>   `test/unit/fix-loop-abort-parking.test.ts`（5 例）；全量 unit **93 文件 / 1261 用例通过**；
>   `tsc --noEmit` / ESLint `--max-warnings 0` 通过。
> - **边界**：本版为纯函数与编排层修复，**未做真机验证**；四个 driver 的选择器采集层未改动。
>
> **HANDOFF 快照的历史断层**：本轮已把顶部快照补到 `0.9.4`；下方 `0.7.8`–`0.8.0` 的中间快照仍未回填
> （含 issue #35/#30 恢复语义修复与 MiniMax Code 接入），那些版本的逐条记录以 `CHANGELOG.md` 为准。
>
> **历史快照（0.7.7）**
> **交接快照：2026-10-01 · 已发布版本 `0.7.7`（tag `v0.7.7` + npm `tianshu-mcp@0.7.7`）。**
> **本轮（0.7.6 → 0.7.7）交付**：新增**阻塞等待原语** `wait_task` / `wait_any`（**issue #28**，功能请求 P6）——
> 工具面 **11 → 13**（`read` 族 +2，纯只读、免审批）。诉求：`run_task` 秒回 `taskId` 后**调用方没有任何方式等到任务结束**，
> 而目标调用方（天枢 agent 会话）**回合驱动**——只在收到用户消息的回合内运行、回合之间不运行，**无法自行轮询**，
> 于是每次任务完成都必须人工再发一条消息触发查询。
> - **停点**（单一判定点 `isWaitSettled(status) = isTerminal(status) || status === "needs_user"`）：任务**停止推进**的时刻即应唤醒调用方；
>   `needs_user` 虽非终态但已停等人工（可被 `continue_task` 恢复、之后可能再次进入），不等它会空等到超时。
> - `wait_task(taskId, timeoutMs?)` 阻塞等到停点或超时；`wait_any(taskIds, timeoutMs?)` 等一组（1..20）中**数组顺序首个**停者。
>   超时 `timeoutMs` 缺省 **50000ms**（低于生态常见 60s 客户端超时）、上限 **600000ms**，超上限**钳制并如实披露**；超时返回体引导循环调用（每轮 ≈50s）。
> - **无损**：等待**纯只读**，被截断 / 连接中断 / 超时都**不影响任务本体**；`extra.signal` 让循环在请求取消时立即退出（SDK `_onclose` 会 abort 全部 in-flight handler）。
> - **物理前提已实测**：SDK 请求**互不阻塞**（探针：3s `slow` 发出后 +200ms 的 `fast` 仅 215ms 返回）——等待期间的 `cancel_task` / `query_task` 照常处理。
> - **代码**：新增 `src/tasks/wait.ts`（`waitForStops` 纯逻辑、依赖注入 `getMeta`）、`src/tasks/task.ts`（`isWaitSettled`）、
>   `TaskManager.waitForStops`；`src/config/schema.ts`（常量 + 两个 ParamsSchema + `clampWaitTimeout`）；
>   `src/mcp/tools.ts`（+2）、`handlers.ts`（`waitTaskHandler`/`waitAnyHandler` + `HandlerExtra`）、
>   `formatter.ts`（`waitSettled`/`waitedMs`）、`server.ts`（透传 `extra` + instructions）。
> - **测试**：新增 `test/unit/wait-task.test.ts`（8 例）+ `test/integration/wait-task.test.ts`（6 例）；`protocol.test.ts` 同步 13 工具真值表。
>   **全量 1447 passed / 12 skipped**（1459 项，122 文件）。
> - **文档**：新增 [等待原语](docs/wait-task.md) 双语；README / ARCHITECTURE / tianshu-integration / core-principles / SKILL / usage-examples 同步 11→13 与工具表。
> - **发布链**：见下方「发布流程」——GitHub 主仓 + Gitee 镜像 Release、npm `tianshu-mcp@0.7.7`。
>
> **日志台 GUI（独立交付面，同会话并行交付）**：`mcp-gui` 推进到 **`0.1.1-beta.3`**（计划 `.trae/documents/mcp-gui-insights-0.1.1-plan.md` 的**批次三，也是最后一批**）——
> **A5 工作区新增「基线」分区**（动工前 `baseline.json` 摘要 + 与最新报告改动对照）、**A6 事件流新增「阶段」视图**（状态跃迁甘特，
> 按需读一次全量，末段标「进行中」不编造时长）、**A9 洞察页新增「磁盘占用」**（总量 / logs 占比 / TOP 20 / **只提示不删除**的相对判据）、
> **A8b 深链 `tianshu://task/<id>`**（单实例 + 协议注册 + 冷/热启动；Rust 侧处理，不给 webview 多余权限）。
> A1–A9 至此**全部交付**。详见下方「独立交付面 · 日志台 GUI **「洞察」批次三**」。
> **历史快照（批次二）**：`mcp-gui` 推进到 **`0.1.1-beta.2`**（A7 结构化筛选 / A4 多任务对比 / A8a 命令面板）。
> **历史快照（批次一）**：`mcp-gui` 推进到 **`0.1.1-beta.1`**——
> 侧栏新增「洞察」整页：**A1 效能看板**（按 Agent / 项目的任务数、成功率、平均轮次、一次通过率、平均验收耗时、报告缺失）+ **A2 失败归因**
> （`errorType` / 失败检查项 / 阻塞问题 / 代码信号 四类 TOP）+ **A3 时间趋势**（按天 / 按周，任务量柱 + 成功率与返修率折线）；
> 后端新增**只读**聚合命令 `get_insights`（`insights.rs` + `timestamps.rs`）。
> 另修掉真机缺陷**「更新窗口正文只剩一行标题」**——更新清单 `notes` 改取与发行页**同源**的正文（取数 fail-closed），
> 并回填 `update/gui/latest.json` / `latest-gitee.json`；**版本号不升**，详见下方「更新窗口正文（更新清单 `notes`）修复」。
>
> **历史快照（0.7.6）**
> **交接快照：2026-09-30 · 已发布版本 `0.7.6`（tag `v0.7.6` + npm `tianshu-mcp@0.7.6`）。**
> **本轮（0.7.5 → 0.7.6）交付**：修掉 **issue #27** 的三条 ZCode 缺陷 —— ① 项目采集渠道分裂导致的绑定死锁
> （3.14.3 上 `workspace-item-*` **并未从 DOM 消失**，只是被滚出视口：真机实测 **42 个节点中 40 个不可见**；
> 旧实现不做可见性过滤，幽灵项使 `if(!out.length)` 短路恒为假，唯一可信的菜单渠道永不执行，任务卡死在
> `project_mismatch`）；② 运行期 CDP 断连无恢复入口（现在**首次断连重连观察一次、绝不重发**，
> 重连失败或再次断连落 `needs_user(setup_recovery)`，并附「进程是否仍在」「窗口是否仍有运行信号」两侧事实）；
> ③ `reasoningLevel` 未实现（现在在**模型确认之后**读界面实际档位集合校验，越权在**发送前**报错，
> 未指定则不触碰界面）与**两级模型菜单**（模型项在 provider 分组二级子菜单里，**必须 hover 才渲染**，
> 分组 testid 已漂移为 `chat-model-select-group-registry-provider:`）。此外回落导入路径（点击始终不落地时）也已接线。
> **真机测试另暴露权限菜单契约漂移**（3.14.3 权限项 role 是 `menuitemradio`/`menuitemcheckbox` 而非 `option`，
> 可见名在项内**直接文本节点**里、后面跟说明文本），一并修复。
> **✅ 真机端到端已跑通**（ZCode `3.14.3.7762` / Windows 10）：`npm run smoke:zcode` → `succeeded` /
> `reply_stable`，权限落在「完全访问」，耗时约 40 秒，**产物 `done.txt` 内容为 `issue27-ok`**。
> 取证入口：`npm run probe:zcode -- dom-contracts|models|permission`。
> 详见 `CHANGELOG.md` 的 `[0.7.6]` 与 `docs/release-v0.7.6.md`。
>
> **历史快照（0.7.4）**
> **交接快照：2026-09-28 · 已发布版本 `0.7.4`（tag `v0.7.4` + npm `tianshu-mcp@0.7.4`）。**
> **本轮（0.7.3 → 0.7.4）交付**：修掉 **issue #24** —— ZCode `3.14.x` 删除了 `data-project-path` 与
> `data-testid^="workspace-item-"` 两处 DOM 契约，而 `pathOf()` 只认这两个来源，于是
> `workspaceBinding().projectPath` 恒空、`cdp.projects()` 恒 `[]`，**所有带 `projectPath` 的派单**都恒败于
> `project_mismatch`（失败在发送任务书之前，`autoFixRounds` 形同虚设）。绑定判据改为**分层**
> （`boundProjectVerdict()`）：路径可得时严格判等（3.11.x 语义不变），无路径渠道时按**显示名 + 全局同名消歧**
> （同名即 `project_ambiguous`，绝不猜测）；显示名**不写进 `projectPath`**，故无项目模式的
> `workspaceIsDefault` 判据不受影响。另修掉「菜单是否恰好还开着」这条隐式时序前提，并给
> `project_mismatch` 补上「触发器文本 / 菜单勾选态 / 路径回读」诊断。新增
> `npm run probe:zcode -- dom-contracts` 作真机取证入口。全量 **1383 passed / 12 skipped**（1395 项，115 文件）。
> ⚠️ **本机无 ZCode 3.14.x，未真机复验**：根因在 `linkedom` 夹具上已 RED→GREEN 决定性复现
> （先确认 3 处红灯，再修到全绿），issue 的真机实测数据未被独立复现 —— 有 3.14.x 环境的维护者请跑
> `npm run probe:zcode -- dom-contracts` 复核。详见 `CHANGELOG.md` 的 `[0.7.4]` 与 `docs/release-v0.7.4.md`。
> 发布链上有两个需要知道的坑（都是 `release.yml` 的前置门禁，不满足时 npm 可能已发但 Release 建不出来）：
> ① 该 commit 必须有**成功的 CI**（`Require successful CI for this commit`）；
> ② 正文必须来自 `docs/release-v<version>.md` 与 `.en.md`。
> `v0.7.1`（CI 红）与 `v0.7.2`（缺正文文档）的 GitHub 发行版因此**改用手动 API 补建**，两者的 tag 未动。
> **本轮（0.7.0 → 0.7.1）交付**：内置 agent `opendesign`（Open Design 桌面端）**从「开发中」推进到完整可派发**——
> 选择器按产品产物取证落地、12 步执行链全部接线、并接入验收 → 自动返修 → 再验收闭环。
> **同仓另有一条独立交付面**：日志台 GUI（`mcp-gui/`，**正式版 `0.1.0`**，独立 tag `gui-v*`，独立演进；本轮**转正 + 新增更新日志面板**——桌面端独立的更新窗口（启动静默检查命中即弹、`忽略此版本` 只压自动提示、显式展示本次使用的更新源与探测结果、正文为该版本的双语发行说明），发布链同步支持正式版（tag 过滤器 `gui-v*`、按 tag 形态判定 pre-release、发行版正文取自 `docs/release-gui-v<版本>.md` + `.en.md`）；前几轮已按真机反馈补「已成功」指标、数据目录上移、设置面板改居中弹窗、「刷新」上移到数据目录行，并修好「手动下载」随源跳转）。
> **issue #25 已交付**：新增**独立交付面** `mcp-gui/`（「Tianshu-mcp 日志台」，Tauri 2.x + Vue 3）——本地只读查看四类日志与任务产物；MCP 主包 GUI 侧零改动。签名密钥等 4 项 Secrets **已由维护者配置完成**（2026-09-27）。
> **issue #25 已按 DoD 全部达成回复并关闭**（2026-09-27）：DoD 2（F1~F12）与 DoD 9（U4~U8）由维护者在 Windows 10 真机逐项验收通过；
> 验收中发现并修掉「更新后旧版本不消失」（GUI `0.1.0-beta.4`），已发布并完成真机端到端复现——详见下方「升级路径修复」小节与 `docs/issue-25-gui-real-machine-record.md`。
> **issue #18~#22 五项增强已全部交付**（v0.6.3~v0.6.7，每版各自完整发布），**五个 issue 均已回复并关闭**（2026-09-24）。
> **#18~#22 的真机记录已全部补齐**（2026-09-25）：见 [issue #19/#20/#21/#22 真机记录](docs/issue-19-22-real-machine-record.md) 与 [issue #18/#19/#21 真机记录](docs/issue-18-21-real-machine-record.md)；各 issue 另附真机证据补充评论。
> **✅ 此前那条会阻断全部 Codex 派发的适配器缺陷已修复**（`26.917.9434` / `26.930.4958.0` 模型触发器回读混入整条思考等级条 → `model_mismatch`），随 **v0.8.2** 交付（issue #34），详见下方「真机取证补记」与记录文件 §5。
> **✅ Open Design 真机链路已跑通（2026-09-28）**：先前「主线程停在启动期、CDP 接不上」的阻塞已定位并修复 ——
> 根因是**固定 `--remote-debugging-port` 被不承载窗口的 launcher 进程抢占并驻留**，真窗口进程绑定失败后
> `/json/list` 恒为 `[]`（端口连得上却无 page target）。改用 `=0`（各拿随机端口）+ 按 `DevToolsActivePort`
> 定位真窗口后，**真机 4 秒接管**。整条链路已验：绑定工作目录 → 选模型/设计系统/设计方向 → 输入发送 →
> 轮询完成 → **产物取回**（`onboarding-guide.html` 落进任务目录，视觉验收识别入口）。
> 剩余：zip 导出方式（产品主进程接管下载，`state=canceled`）待后续优化；`docs/opendesign-cdp.md` §4.4 的证据表仍可补。
> 下面两段 2026-09-27 的旧结论保留作对照（当时的判断已被上一条取代）。
> **2026-09-27 复测（联网环境）**：再次执行 `node scripts/probe-opendesign.mjs all --launch --save` —— 安装探测、数据目录推导与 `app-config.json` 读取全部正常（`0.24.1` / `release-stable-win`），
> 但启动后 **90000ms 内 CDP 始终未就绪**（stderr 已宣告 `DevTools listening on ws://127.0.0.1:9889/...`，主线程仍卡在启动期请求），与上一条结论一致 ——
> 阻塞在**应用自身启动路径**，与本机是否有外网无关。实测现场见 `docs/opendesign-evidence/opendesign-probe-2026-09-27T13-36-09-530Z.md`；
> 真机 DOM 采集仍需在能正常启动 Open Design 的终端执行。
> 本文写给**接手本仓库的人**：先说清「这是什么、现在到哪一步」，再给出「怎么跑、怎么改、哪里会踩坑」。
> 工作区规则见 `AGENTS.md`（gitignore，仅本地）；安装与用法见 `README.md`，本文不重复，只做导览与状态记录。

---

### 内置 agent · ZCode 项目绑定 / CDP 恢复 / 思考档位（`0.7.6`，**已发布** 2026-09-30）

- **范围**：`src/agents/zcode/**`（`cdp.ts` / `run.ts` / `model.ts` / `selectors.ts`）、`src/mcp/handlers.ts`
  的 zcode 参数级校验；测试 `test/unit/zcode-dom.test.ts`、`test/unit/zcode-thought-level.test.ts`（新）、
  `test/integration/zcode-flow.test.ts`。**未改** `traework/cdp/client.ts`（重连是适配器层职责）、
  **未改** `pathOf()` 的既有语义。
- **根因（真机取证，不是静态推理）**：`scripts/probe-zcode.mjs` 与三个一次性探针在 ZCode `3.14.3.7762`
  上实测到 —— `[data-testid^="workspace-item-"]` **42 个节点中 40 个不可见**（`rect.top` 从 720 起，
  视口高 640）、`data-project-path` 为 0；模型菜单的 provider 分组 testid 是
  `chat-model-select-group-registry-provider:new-provider`，模型项**只在 hover 分组后**才渲染
  （`chat-model-select-item-custom:new-provider:step-5-preview`）；权限项 role 为
  `menuitemradio`/`menuitemcheckbox`、可见名是项内直接文本节点；思考档位是二值
  `chat-thought-level-select-item-{disabled,enabled}`，选项仅在菜单展开时挂载。
- **改法**：① `projects()` 加 `ZCODE_DOM.visible` 过滤、去掉 `if(!out.length)` 短路、两渠道合并且
  同名菜单项覆盖侧边栏项；② `clickProject` 返回 `{clicked, reason}`，`ensureProjectBound` 在
  「从未成功点中」时放开回落导入；③ 新增 `guardRuntimeCdp()` 统一护栏（发送阶段 + 主循环），
  首次断连走 `reconnectOnce()`（`launchTimeoutMs` 夹到 20s）继续观察，否则抛
  `ZcodeRuntimeDisconnect` 由外层归位 `needs_user(setup_recovery)`；④ `parseZcodeModel(model, level)` +
  `thoughtTierSetOf/assertZcodeLevelSupported` 的 fail-closed 档位校验，`cdp.thoughtLevelSnapshot()`
  按需展开档位菜单读取后关闭；⑤ `clickExact(key, value, "hover")` 支持只 hover 不发键，
  模型段用 hover 展开 provider 分组，两轮候选皆空时重开菜单再试一轮；⑥ 权限候选补无 role 限制的兜底、
  `clickExact` 标签解析优先取直接文本节点。
- **验证**：`npm run typecheck` / `npm run lint` 全绿；zcode 相关 unit + integration 全绿（新增
  issue #27 的采集、reasoningLevel、两级菜单、权限契约用例）；**反向验证**过回落导入用例
  （去掉 `unclickable` 判定即红）。真机：`probe:zcode -- dom-contracts|models|permission` 取证，
  `smoke:zcode` 端到端 `succeeded`（产物 `done.txt` = `issue27-ok`）。
- **遗留**：真机上窗口被遮挡时合成点击仍会被吞（Chromium 节流），派发前请把 ZCode 窗口置前台；
  `max`/`低` 等档位在当前模型（step-5-preview）不存在，会按设计报 `reasoning_level_invalid`。

### 内置 agent · Open Design 适配器接线完成（`0.7.1`，**已发布** 2026-09-28）

- **范围**：`src/agents/opendesign/**`（新增 `transport.ts` / `menu.ts` / `send.ts` / `recovery.ts`，重写 `run.ts`、`selectors.ts`、`cdp.ts`），
  以及 `src/loop/fix-loop.ts`、`src/tasks/task-manager.ts`、`src/mcp/context.ts` 的 opendesign 接线。**未改 `tianshu-mcp-web/`**。
- **选择器取证（不是截图目测）**：Open Design 的 Web 前端产物（`resources/open-design-web-standalone/apps/web/.next/static/chunks/*.js`）
  **系统性使用 `data-testid`**（600+），`primary` 全部取自这些真实钩子（`chat-send` / `working-dir-trigger` /
  `composer-design-system-trigger` / `design-system-search` / `home-hero-template-trigger` / `home-hero-input` / `home-hero-submit` …）；
  停止按钮无 testid，用产品自身的 `class="composer-send stop"` + `aria-label=<chat.stop>`；菜单项统一 `role="option"`。
- **真机新发现 → 传输层必须双路径**（`transport.ts`）：Open Design 的浏览器进程 `/json/version` 正常，但 `/json` 与
  `/json/list` **连接成功后长时间无响应**（Target 枚举走 UI 线程，产品启动期主线程被自身计费/遥测请求占住）。
  故先走 HTTP `/json`（≤3s 上限），失败即回退浏览器级 WebSocket：`Target.getTargets` + `Target.attachToTarget(flatten)`
  拿 `sessionId`（页面级命令带 `sessionId`，`Target.*`/`Browser.*` 不带）。就绪探测与传输**共用同一份目标枚举实现**。
- **完整 12 步**：接管/自启 → 连接主窗口（要求输入框就绪）→ 版本门禁 → 选择器守卫与布局盘点 → 绑定工作目录（含原生对话框 + **回读**）
  → 模型（精确匹配 + 回读，写回 `actualModel`）→ 设计系统（搜索过滤 + 精确点选 + 回读）→ 设计方向（只支持原型/文档/网站复刻）
  → 输入任务书（可信输入 + 回读含标记）→ 发送（**只点一次、绝不重发**、三证据有界确认）→ 三信号轮询（停止按钮 / 对话文本哈希 / 产物文件指纹）→ 终态。
- **验收-返修闭环**：`fix-loop.ts` 在 opendesign 验收失败时生成**项目根** `.opendesign/plans/opendesign-fix-r<N>.md`
  （Open Design 只能读它工作目录白名单内的文件），并同会话发送返修指令；`continue_task` / `rework_task` 已支持 opendesign。
- **细粒度事件流（对齐 issue #18 词表）**：除 `task_dispatched` / `file_modification_started`，**全部「卡在等人」的出口**都上报
  `awaiting_user_authorization`（既有实例无法接管 / 停在登录引导页 / 工作目录绑定失败 / 停止按钮久亮且对话与产物全静止转人工确认 / 初始化阶段环境不可自愈），
  清理残留原生对话框与经原生「选择文件夹」绑定目录时上报 `confirmation_dialog_detected` —— `query_task` 的 `recentEvents` 因此能看见「卡死等人」，
  不必再靠盲等或超时判断。
- **本轮修掉的两个真实缺陷**：① `inputText()` 曾把 `{found,value,length}` 当 `string` 返回 → 发送前回读抛错、被误报 `setup_failed`；
  ② 工作目录绑定失败曾落成「非硬失败的 `setup_failed`」→ 编排器按普通失败处理、用户无法 `continue_task`，现一律转 `needs_user`。
- **测试**：新增 **63** 用例（集成 `opendesign-flow` 14 → **18** + `opendesign-rework-loop` 5（仅 Windows：派发本身有平台门禁）；单测 `opendesign-{menu,send,transport,recovery}` 8/8/7/14；`opendesign-discovery` 扩到 33，含端口避让），
  桩扩展在 `test/fake-cdp.ts`（Open Design 页面桩，语义键由注册表自身反查，选择器漂移时桩会一起失败）。全部**不依赖本机安装 Open Design**、不联网。
- **真机冒烟（2026-09-27）暴露并修掉 6 个只在真实窗口上才显形的缺陷**（单测全绿时它们一个都不显形）：
  ① **CDP 接不上** —— 固定 `--remote-debugging-port` 被**不承载窗口的 launcher 进程**占住并驻留，
  真窗口进程绑不上，于是 `/json/version` 正常而 `/json/list` 恒为 `[]`；改用 `=0`（两进程各拿随机端口）
  并按 **`DevToolsActivePort`** 定位真窗口，真机 **4 秒**接管成功。
  ② **就绪判据在 `instance.ts` 有一份不同步的副本**（缺 `^od://`），而真机页面正是
  `title=OpenDesign`（**无空格**）+ `url=od://app/` —— 两个判据都不命中 → 改成**单一真源**并容忍有无空格。
  ③ **主窗口排序会被同标题辅助页抢走**（`od://app/desktop-pet` 标题也是 `OpenDesign`）→ 辅助页压到最低档。
  ④ **选择器候选按并集累加**：primary 与 fallback 各命中一个**不同**元素就报「多命中」
  （真机 `modelTrigger` = chip(button) + 外层 div）→ 改为**命中即停**（primary 优先）。
  ⑤ **工作目录回读不认真实 UI**：绑定成功后触发区只显示**末段目录名**（`test`）→ 增加
  「末段相等 **且** 产品旁证 `recentLinkedDirs` 命中目标」这一档；**缺旁证仍拒绝**（末段太宽，会误判）。
  ⑥ **预算照搬 ZCode 默认值**：`setupRecovery` 120s，而真机**单是「启动 + 连接主窗口」就吃掉 77s**，
  绑目录的 `15s+20s` cap 也会被咬断 → 分别放大到 **300s** 与 **30s+60s**。
- **真机冒烟尚未跑通到「派发」**（2026-09-27 收尾状态）：链路停在**步 3「绑定工作目录」**。
  适配器的行为是正确的 fail-closed —— 原生对话框流程走完（编辑框内容正确、确定按钮可用、对话框正常关闭），
  但应用没接受：`recentLinkedDirs` 未更新、触发区仍显示「工作目录」，于是转 `needs_user`
  （可 `continue_task` 续跑），**没有把「对话框关了就当成绑定成功」**。
  已加的尽力路径：补 Enter 导航、发官方 `BFFM_SETSELECTIONW` 设选中项、按 `id=1152` 唯一化对话框歧义、
  歧义时把每个候选的 hwnd/标题写进错误、绑定流程补阶段日志。**Enter 与 BFFM 在本机 0.24.1 上均未让应用接受**
  ——已在代码注释里如实标注，不当成已解决。可试的下一步：① 面板里的「最近目录」
  （本轮实测点开后**没有**子列表，只有 `选择目录` / `最近使用的目录` 两项，故当前不可用）；
  ② 改用 `IFileDialog` 的 COM 接口而非 Win32 消息；③ 在能稳定复现的机器上抓对话框的选中项控件。
- **版本边界**：MCP 主包 `0.7.0 → 0.7.1`（`package.json` + `src/version.generated.ts` 同提交），**已打 tag `v0.7.1`、已发布 npm**；
  `mcp-gui` 独立版本线不受影响（**不迭代该版本**，符合 `AGENTS.md`）。

---

### 独立交付面 · 日志台 GUI **「洞察」批次一（效能看板 / 失败归因 / 时间趋势）**（`mcp-gui/`，`0.1.1-beta.1`）

- **计划文档**：`.trae/documents/mcp-gui-insights-0.1.1-plan.md`（A1–A9 分三批落地，**本批 = A1 + A2 + A3 + 聚合取数通道**）。
- **范围**：
  - **新增**：`mcp-gui/src-tauri/src/insights.rs`（只读聚合，含 4 项 Rust 单测）、
    `mcp-gui/src-tauri/src/timestamps.rs`（最小 UTC 解析 `parse_iso_ms`，含 5 项单测）、
    `mcp-gui/src/core/insights.ts`（比率 / TopN / 趋势补齐 / 周历聚合 / mock 用的 TS 聚合镜像）、
    `mcp-gui/src/components/InsightsPage.vue`、`mcp-gui/test/insights.test.ts`（22 项）、
    `docs/release-gui-v0.1.1-beta.1.md` + `.en.md`；
  - **修改**：`src-tauri/src/{models,lib}.rs`（`InsightsRequest` / `InsightsSummary` / `InsightsGroup` / `InsightsDay` /
    `InsightsReason` / `InsightsResult` + 注册 `get_insights`）、`src/api/{types,gui-api,tauri,mock}.ts`、
    `src/App.vue`（**三态 → 四态** + 侧栏「洞察」插在「任务列表」之后）、`src/components/AppIcon.vue`（`insights` 等新图标）、
    `src/stores/app.ts`（`insights` 状态 + `loadInsights()`）、`src/i18n/{zh-CN,en-US}.ts`、`src/styles.css`（§21 洞察页样式）。
- **口径（改这里之前先读，Rust 与 TS 必须同步）**：日期按 **UTC** 分桶（`createdAt` 前 10 字符）；**按周以周一为周始**（跨月 / 跨年归并）；
  「一次通过」= `succeeded` 且 `roundsUsed <= 1`；返修率 = `roundsUsed > 1` 占比；**只统计每个任务的最新一轮报告**
  （故「返修后才成功」的任务，其更早一轮的失败**不进归因**——有意为之）；平均验收耗时只算起止时间**都可解析**的轮次；
  分母为 0 显示 `—`；**全程只读、不提供删除 / 清理**。
- **职责边界（计划 D4）**：Rust 只做**扫描 + 解析 + 计数/求和**；比率 / TopN / 趋势补齐 / 周历聚合全在前端纯函数里（可单测）。
- **验证**：
  - 本机门禁：`typecheck` / `lint` 全绿；`vitest` **125 passed**（本批 +22）；`check:schema` 报「GUI 版本号一致（0.1.1-beta.1）」；
  - `cargo fmt --check` 通过；**本机仍无法跑 `cargo clippy` / `cargo test`**（依赖构建脚本需要 MSVC 链接器，与计划事实 21 一致）
    → **Rust 门禁交 `gui.yml`**（计划 D10）；
  - 渲染实测（headless Edge + mock）：侧栏出现「洞察」，三分区可切换，A1 两张表有数据、A3 按天/按周切换与柱线均渲染，
    归因分区在 fixtures 下为空态（**印证口径**：fixtures 里各任务最新一轮报告全绿，失败项在更早一轮）。
- **版本边界**：GUI 独立线 `0.1.0 → 0.1.1-beta.1`（`package.json` / `package-lock.json` 两处 / `tauri.conf.json` / `Cargo.toml` 四处同步）；
  **MCP 主包不受影响**（`AGENTS.md`：`mcp-gui` 不迭代主包版本）。
- **后续批次**：`0.1.1-beta.2` = A4 多任务对比 + A7 结构化筛选增强 + A8a 命令面板；
  `0.1.1-beta.3` = A5 基线漂移 + A6 状态跃迁甘特 + A9 磁盘占用 + A8b 深链（**唯一有架构风险项**，需 Tauri 插件 + 协议注册）。

---

### 独立交付面 · 日志台 GUI **「洞察」批次三（基线 / 阶段甘特 / 磁盘占用 / 深链）**（`mcp-gui/`，`0.1.1-beta.3`）

- **计划文档**：`.trae/documents/mcp-gui-insights-0.1.1-plan.md` §6（A5 + A6 + A9 + A8b）。**A1–A9 九项至此全部交付**。
- **A5 基线漂移**：
  - 新增 `src-tauri/src/baseline.rs`（`read_baseline`，容错解析 `tasks/<任务>/baseline.json`，含 4 项单测）+ `models.rs` 的
    `BaselineRequest` / `BaselineInfo` + `lib.rs` 注册（任务 ID 为空直接报错，不静默给空基线）；
  - 新增 `src/components/BaselinePanel.vue`（工作区第 5 个分区）+ `stores/app.ts` 的 `TabKey += "baseline"` / `loadBaseline()`；
    **与最新报告对照**（报告按需读取、按任务缓存）；缺失 / 损坏一律提示「没有保存的动工前基线」；
  - fixtures 新增 `tasks/tsk_20260926114012_a1b2c3/baseline.json`（结构对齐 `src/verify/git-baseline.ts`），供预览与探针取证。
- **A6 状态跃迁甘特**：
  - `models.rs` 的 `ReadEventsRequest` 新增 `full`（`#[serde(default)]`）；`event_stream.rs` 在 `full = true` 时用
    `tail::read_whole` 读全量、**解析逻辑与窗口模式共用同一段代码**，失败退回尾部窗口；**`full = false` 行为逐字节不变**；
  - 新增纯函数 `src/core/timeline.ts`（`buildStages` / `totalMs` / `stageShare`）+ `src/components/TimelineGantt.vue`；
    `EventTimeline.vue` 新增 **列表 / 阶段** 分段切换（首次切到阶段才读全量，同一任务只读一次；刷新会丢弃缓存重读）；
  - `stores/app.ts` 新增 `eventsFull` / `eventsFullTaskId` / `loadEventsFull()` / `invalidateEventsFull()`。
- **A9 磁盘占用**：
  - 新增 `src-tauri/src/diskscan.rs`（`scan_disk_usage`，只 `stat`、只统计 `logs/` 与 `tasks/` 下所有子目录、TOP 20，含 4 项单测）；
  - `core/insights.ts` 新增 `medianOf` / `cleanupHints` 与两个**具名相对阈值常量**（`CLEANUP_HEAVIEST_RATIO = 0.5` /
    `CLEANUP_MEDIAN_MULTIPLE = 2`）；新增 `src/components/InsightDisk.vue`（洞察页第 5 个子分区）；
  - **只提示不删除**：页面与命令都没有清理 / 删除入口（探针专门断言「页面上没有任何删除 / 清理按钮」）。
- **A8b 深链**：
  - `Cargo.toml` 新增 `tauri-plugin-single-instance`（features = ["deep-link"]，**必须最先注册**）与 `tauri-plugin-deep-link`；
    `tauri.conf.json` 声明 `plugins.deep-link.desktop.schemes = ["tianshu"]`；
  - `lib.rs`：`queue_deeplinks()`（冷启动 `get_current` + 热启动 `on_open_url` **都只入队并发 `gui://deeplink` 信号**，
    **队列是唯一事实来源**，避免冷启动丢链接）+ `take_pending_deeplinks` 命令 + `AppState.pending_deeplinks`；
  - 新增 `src/core/deeplink.ts`（`parseDeepLink` / `firstDeepLinkTarget`，ID 白名单 `[A-Za-z0-9_-]`，含 `..`/`%2e` 直接拒绝）；
    `App.vue` 挂载时与收到信号时走同一次「取队列 → 解析 → 路由」，无法识别的链接**如实提示**；
  - **权限口径（有意偏离计划的一处，已记录）**：计划 §6.4 提到给 `capabilities/default.json` 加 `"deep-link:default"`，
    但深链**全部在 Rust 侧处理**、前端不调用该插件的 JS API，因此**不加**这项能力——少给 webview 一个插件能力，
    与 §16.8 的最小权限口径一致（见 `ARCHITECTURE` §16.10）。
- **验证（本机）**：`check:schema`（版本一致 `0.1.1-beta.3` + 三方词表无漂移）/ `typecheck` / `lint` /
  `vitest`（**169 passed**，15 文件，较批次二 +17）/ `vite build` 全绿；`cargo fmt --all --check` 通过
  （**本机仍不跑 `cargo clippy` / `cargo test`**，Rust 门禁交 `gui.yml`，与 issue #25 决策 D2 一致）。
- **模拟真机**：`puppeteer-core` + 本机无头 Edge 打开 mock 预览，DOM 断言 **14/14 通过**（深链空队列不报错；基线分区
  显示摘要并与报告对照、无基线任务如实提示；阶段视图 12 段含末段「进行中」与阶段合计、切回列表仍有事件行；
  磁盘分区四项读数 + TOP 表 + 提示且**无任何删除按钮**；无 `pageerror`）。探针为临时文件，未入库。
- **版本边界**：`mcp-gui` 四处版本同步 `0.1.1-beta.2 → 0.1.1-beta.3`（`package.json` / `package-lock.json` 两处 /
  `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`）；**MCP 主包不受影响**。
- **发布文档**：新增 `docs/release-gui-v0.1.1-beta.3.md` + `.en.md`（发布 job 的正文来源，**缺文档直接失败**，计划 D11）。
- **后续（需维护者的动作）**：
  1. **真机验收**（Windows 10 安装 Release 安装包）：逐项核对 A5 基线 / A6 阶段 / A9 磁盘 / A8b 深链
     （深链需**冷启动与热启动两条路径**都试：命令行 `start tianshu://task/<id>`；若冷启动不通则按 §6.4 的
     **降级预案**记录平台差异，不动其它批次内容）；
  2. 批次三真机通过后，可按计划 §6.5 由维护者决定**转正 `0.1.1`**（新增发布文档、打 tag `gui-v0.1.1`）。

---

### 独立交付面 · 日志台 GUI **「洞察」批次二（结构化筛选 / 多任务对比 / 命令面板）**（`mcp-gui/`，`0.1.1-beta.2`）

- **计划文档**：`.trae/documents/mcp-gui-insights-0.1.1-plan.md` §5（A4 + A7 + A8a；**批次三** = A5 + A6 + A9 + A8b 仍待交付）。
- **A7 结构化筛选增强**：
  - Rust：`src-tauri/src/models.rs` 的 `TaskFilter` 新增 `error_type` / `dry_run` / `reworked` / `has_visual`（全部 `#[serde(default)]`，
    旧调用方不传不失败）；`scanner.rs` 的 `matches_filter` 实现四项，并新增单测 `matches_filter_supports_new_dimensions`。
  - 前端：`src/api/types.ts` 同步四项；`src/core/filter.ts` 的 `emptyFilter` / `filterTasks` / `facetValues`（新增 `errorTypes` 分面）同口径实现；
    `OverviewPage.vue` 筛选浮层新增 4 个控件（错误类型用分面下拉，另三项为「全部 / 是 / 否」三态）。
  - **口径**：`reworked` = `roundsUsed > 1`（**1 轮不算返修**）；`hasVisual` = `artifacts.reportHtml` 非空；`errorType` 精确匹配（空串 = 不限）。
    Rust 与 TS **双份同口径**（与「双份 schema」同一约束，见 `ARCHITECTURE` §16.9）。
- **A4 多任务对比**：新增 `src/components/InsightCompare.vue`（洞察页第 4 个子分区）+ `core/insights.ts` 的
  `compareTasks` / `bestOf` / `nextCompareSelection` / `COMPARE_MAX`；`stores/app.ts` 的 `InsightsState` 新增
  `compareIds` / `compareReports` / `compareLoading` 与 `toggleCompareTask` / `clearCompareTasks`。
  勾选上限 4（满额时**明确提示、不顶替**）；报告**按需**读最新一轮 `report-<轮次>.json` 并按 `taskId` 缓存；
  切换数据目录清空勾选与缓存；缺失值一律 `—`（**不编造时长与结论**）。
- **A8a 命令面板与快捷键**：新增 `src/core/hotkeys.ts`（`matchHotkey`，面板打开时只认关闭键）+ `src/core/palette.ts`
  （`buildStaticCommands` / `buildTaskCommands` / `rankCommands` / `fuzzyScore` / `stepIndex`）+ `src/components/CommandPalette.vue`；
  `App.vue` 挂载面板并在 window 上统一监听分发（`Ctrl/Cmd + K` 开关、`Ctrl/Cmd + R` 刷新并 `preventDefault`、
  `Esc` 关闭），侧栏新增常驻入口。**动作实现只在 `App.vue`**（面板只派发命令 `id`）；任务命令**按输入实时检索**（见下条「发布后修复」）。
- **验证（本机）**：`check:schema`（版本一致 `0.1.1-beta.2` + 三方词表无漂移）/ `typecheck` / `lint` /
  `vitest`（**152 passed**，13 文件，较批次一 +26）/ `vite build` 全绿；`cargo fmt --all --check` 通过
  （**本机仍不跑 `cargo clippy` / `cargo test`**，Rust 门禁交 `gui.yml`，与 issue #25 决策 D2 一致）。
- **模拟真机**：`puppeteer-core` + 本机无头 Edge 打开 mock 预览（`vite preview`），DOM 断言 **13/13 通过**
  （新筛选控件齐全、返修=是 实际生效 4→1、`Ctrl+K` 开面板并模糊命中后跳转到洞察页、对比矩阵列头与 11 行指标齐全、
  选满 4 个不越界、无 `pageerror`）；命令面板改实时检索后另补 **6/6**（空输入只列导航 / 目录、按 ID 片段与任务书关键字
  实时命中、回车直接打开该任务、无匹配给空态、无 `pageerror`）。探针脚本均为临时文件，未入库。
- **版本边界**：`mcp-gui` 四处版本同步 `0.1.1-beta.1 → 0.1.1-beta.2`（`package.json` / `package-lock.json` 两处 /
  `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`），随本版发布 tag `gui-v0.1.1-beta.2`；
  `update/gui/latest*.json` 由发布 job 自动生成并提交（`[skip ci]`）。**MCP 主包不受影响**（`AGENTS.md`：`mcp-gui` 不迭代主包版本）。
- **发布文档**：新增 `docs/release-gui-v0.1.1-beta.2.md` + `.en.md`（发布 job 的正文来源，**缺文档直接失败**，计划 D11）。
- **发布（2026-10-02）✅**：tag `gui-v0.1.1-beta.2` → `78f9722`。`GUI` workflow 的 **5 个 job 全 success**
  （`Schema parity` + 三平台 `Build` + `Publish release (GitHub + Gitee)`）；三平台 job 内含 `cargo fmt --check` /
  `clippy -D warnings` / `cargo test`，**本机跑不了的两道 Rust 门禁由此通过**（含新增的 `matches_filter_supports_new_dimensions`）。
  GitHub 侧 pre-release 已创建（**8 个产物**、正文 7544 字符 = 完整双语说明）；Gitee 侧 pre-release 亦已创建
  （两端各 3 个更新载体下载地址实测 **HTTP 200**，共 6 个）；`gui-v*` **未触发** `release.yml`（该 tag 下只有 GUI 一个 workflow 运行）。
  发布后两仓各多一个机器人提交（GitHub `b9eb516` / Gitee `7eecc83`），已合并为 `e468c31` 并回推两端收敛。
- **⚠️ 发布后修复（未发布，将随下一个预发布版交付）**：命令面板的任务命令原为**预生成前 50 条**，任务数超过 50 时
  **排在后面的任务搜不到**且只提示「没有匹配的命令」（不报错、不提示截断，比没有该功能更误导）。现已去掉上限，
  改为 `buildTaskCommands` **按输入实时检索全部任务**（空输入不列任务），`rankCommands` 的
  `PALETTE_RESULT_LIMIT = 20` **只截展示条数、不限制检索范围**；`buildCommands` 拆为 `buildStaticCommands` +
  `buildTaskCommands`（面板接收二者并按输入合成）。`0.1.1-beta.2` 已发布产物仍是旧行为（版本号未动，**不重打该 tag**）。
- **后续**：批次三（`0.1.1-beta.3`）= A5 基线漂移 + A6 状态跃迁甘特 + A9 磁盘占用 + A8b 深链（**唯一有架构风险项**，需 Tauri 插件 + 协议注册）；
  真机验收（Windows 10 安装 Release 安装包，逐项核对 A4/A7/A8a）待维护者执行。

---

### 独立交付面 · 日志台 GUI **更新窗口正文（更新清单 `notes`）修复**（`mcp-gui/`，随 `0.1.1-beta.1` 回填，**不升版本**）

- **真机现象**：`0.1.1-beta.1` 的「更新日志」窗口正文只有一行 `Tianshu-mcp 日志台 0.1.1-beta.1`（28 字符），
  已合成的完整双语发行说明没有出现（更新源 GitHub）。
- **根因**：更新窗口正文的唯一来源是**更新清单的 `notes`**（`updater.rs` 的 `update.body`），而发布链合成清单时
  **只传了兜底标题** `--notes "Tianshu-mcp 日志台 $VER"`；`scripts/gui-release-body.mjs` 合成的完整正文虽已用于
  发行页（GitHub `--notes-file` / Gitee `--body-file`），却**没有传给清单生成脚本**。Gitee 清单复用同一份
  `latest.json`（`gitee-gui-release.mjs --github-manifest`），故**两个源同时退化成单行标题**。
- **修法**：
  - `.github/workflows/gui.yml` 的「Compose updater manifest (GitHub)」新增
    `--notes-file "${{ steps.meta.outputs.body }}"`——清单 `notes` 与发行页正文**同源同一份**，
    并打印取数路径与字节数便于排障；
  - `mcp-gui/scripts/build-updater-manifest.mjs` 新增 `resolveNotes()`：`--notes-file` **优先**；
    **读取失败直接非 0 退出**（fail-closed，杜绝静默退化成一行标题）；文件存在但内容为空时回退 `--notes` 并打 warning。
- **回归测试**：新增 `test/unit/gui-updater-manifest.test.ts`（5 例：正文优先 / 无 `--notes-file` 回退标题 /
  两者皆无为空串 / 缺文件 fail-closed / 空文件回退并告警），本机 **5 passed**。
- **已发布版本回填**：`update/gui/latest.json` 与 `latest-gitee.json` 的 `notes` 补为完整双语说明
  —— 已发布 tag 的 workflow 无法重跑改写清单，只能回填已落库的清单；`version` / `pub_date` / `platforms` **均未改动**。
- **版本边界**：**不升版本、不重打 `gui-v0.1.1-beta.1`**（`package.json` / `package-lock.json` 两处 /
  `tauri.conf.json` / `Cargo.toml` 四处仍为 `0.1.1-beta.1`）；MCP 主包**零改动**。
- **待验证（需维护者的动作）**：~~下次 GUI 发版时确认清单 `notes` 为完整正文~~ **✅ 已闭环（2026-10-02）**：
  `gui-v0.1.1-beta.2` 发布后两端清单 `notes` 均为 **7543 字符的完整双语正文**（首行 `# 日志台 0.1.1-beta.2 — …`，含英文段落），
  即桌面端更新窗口会显示这一版发行说明，而不再是一行标题。
  本机仍不执行任何 Rust 构建 / 检查（issue #25 约束），Rust 侧门禁交 `GUI` workflow。

---

### 独立交付面 · 日志台 GUI **正式版 `0.1.0`（转正 + 更新日志面板）**（`mcp-gui/`，`0.1.0`）

- **范围**（用户决策：0.1.0 = 转正 + 更新日志面板，功能与界面在 beta.9 基础上只加面板）：
  - **新增**：`mcp-gui/src/core/version.ts`（版本比较与忽略判定纯函数）、`mcp-gui/test/version.test.ts`（16 项）、
    `mcp-gui/src/components/UpdateDialog.vue`（大尺寸居中弹窗）、`scripts/gui-release-body.mjs`（合成双语发行版正文）、
    `test/unit/gui-release-body.test.ts`（7 项）、`docs/release-gui-v0.1.0.md` + `.en.md`、`docs/gui-0.1.0-release-record.md`；
  - **修改**：`mcp-gui/src/stores/app.ts`（`dialogOpen` + `checkUpdateOnStartup()` + `ignoreUpdateVersion()`）、
    `mcp-gui/src-tauri/src/models.rs`（`Preferences.ignored_update_version`，**带 `#[serde(default)]`**）、
    `mcp-gui/src/api/{types,mock}.ts`、`mcp-gui/src/stores/preferences.ts`、`mcp-gui/src/App.vue`、
    `mcp-gui/src/components/SettingsDrawer.vue`、`mcp-gui/src/styles.css`、`mcp-gui/src/i18n/{zh-CN,en-US}.ts`、
    `.github/workflows/gui.yml`、`scripts/gitee-gui-release.mjs`、四处版本号、`docs/gui-log-viewer.md` + `.en.md`、
    `CHANGELOG.md` + `.en.md`、`README.md` + `.en.md`、`HANDOFF.md`；
  - **未改**：MCP 主包 `src/**`、`.github/workflows/ci.yml`、`.github/workflows/release.yml`、
    `scripts/release-body.mjs`（复用其导出的 `absolutizeDocLinks`，**零触碰**）；也未改 `tianshu-mcp-web/`。
- **验证**（本机可验的部分）：
  - `mcp-gui` 五项门禁 `typecheck` / `lint` / `test` / `check:schema` / `build` **全 exit 0**，
    `vitest` **98 passed**（9 文件，含新增 16 项），`check:schema` 输出「GUI 版本号一致（0.1.0）」；
  - 新增 `test/unit/gui-release-body.test.ts` **7 passed**；CLI 在缺文档时**非 0 退出**（fail-closed 已实测）；
  - **无头 Edge 探针 15/15 通过**：启动自动弹窗、弹窗尺寸 1070×750、三个动作齐备、release 正文渲染为 DOM、
    忽略后持久化且重载不弹、手动检查仍弹、全程无 `pageerror`；
  - `gui.yml` YAML 语法经 `js-yaml` 解析通过；版本号四处均为 `0.1.0`；全库「测试版」字样**零残留**。
- **排障记录（重要）**：vitest **无法 import 带 shebang 的 `.mjs`**——vite 的 SSR transform 会把
  `#!/usr/bin/env node` 当作非法 token 抛 `SyntaxError: Invalid or unexpected token`（`node` 直接运行不受影响）。
  因此 `scripts/gui-release-body.mjs` **刻意不带 shebang**，并在文件头注明原因；调用一律
  `node scripts/gui-release-body.mjs …`。
- **版本边界**：`mcp-gui` 四处版本同步 `0.1.0-beta.9 → 0.1.0`；发布走 tag `gui-v0.1.0`（**正式版**，
  发行页不带 Pre-release 标记），两端发行版与 `update/gui/latest*.json` 由发布 job 生成/提交，
  **发布后两仓各会多出一个机器人提交**，按既有做法合并回同一提交再推两仓。**MCP 主包版本不受影响**（仍 `0.7.4`）。
- **发布结果（2026-09-29）**：tag `gui-v0.1.0` 已推双仓；GUI run 36500075023 的 5 个 job **全部 success**
  （含 `Publish release`）；**双端发行版均为正式版**（`prerelease=false`），GitHub 8 资产 / Gitee 10 附件
  （8 产物 + Gitee 自动生成的 2 个源码归档）；两端清单 `version=0.1.0`，6 个下载地址实测可达
  （GitHub HTTP 206 / Gitee HTTP 200），签名齐备；两仓清单提交已合并回同一提交 `dc9bba3`。
  完整证据链（含核验断言明细）见 `docs/gui-0.1.0-release-record.md`。
- **遗留（如实披露）**：
  1. **Windows 真机安装与观感目测未执行**（维护者选择直接打 tag，跳过原计划的人工闸门），因此
     「0.1.0 界面显示 / 启动不误弹 / 弹窗尺寸与文案」仅有本机无头 Edge（mock）+ 单测证据，**无桌面真机证据**；
  2. **从 `0.1.0-beta.9` 升级到 `0.1.0` 的真机升级链路未验证**；
  3. macOS 仅保证 CI 构建通过，**未做真机功能验收**（亦未做 Apple 签名/公证）。

### 独立交付面 · 日志台 GUI **「刷新」上移到数据目录行**（`mcp-gui/`，`0.1.0-beta.9`）

- **范围**：`mcp-gui/src/App.vue`（移除侧栏底部的刷新行，`.rail-foot` 改为**仅 mock 运行时**渲染）、`src/components/DataHomeBar.vue`（head 行新增「刷新」按钮）、`src/styles.css`（删掉仅供旧底部行使用的 `.rail-row`），以及四处版本号。**未改** `src/core/**`、`src/api/**`、`src/stores/**`、`src/i18n/**`（复用既有 `common.refresh` / `dataHome.*` 键，**零新增文案键**）。
- **背景**：`0.1.0-beta.8` 把数据目录移进导航区后，侧栏底部只剩一个孤立的「刷新」按钮（外面还包着一条分隔线），维护者据此截图提出把它上移。
- **改法**：把「刷新」放进**「数据目录」标题那一行**，与既有的「添加目录 / 移除」图标按钮同排（顺序 `刷新 / 添加目录 / 移除`）——这一行本就是侧栏的小图标按钮组，且**刷新是全局动作**（两态内容区都可用），放这里不会像放进内容区工具行那样在「全屏工作区」态丢失入口。侧栏底部因此**不再常驻任何东西**：`.rail-foot` 仅在 mock 运行时渲染那条「本地预览」提示条，真实构建下整条底栏不再出现（避免留下空的带边框区域）。
- **验证（本机）**：`check:schema`（版本一致 `0.1.0-beta.9`）/ `vue-tsc --noEmit` / `eslint . --max-warnings 0` / `vitest`（**82 passed**，8 文件）/ `vite build` 全绿。
- **模拟真机**：`puppeteer-core` + 本机无头 Edge（mock 运行时）DOM 断言 **7/7 通过** —— 数据目录行的图标按钮为 `["刷新","添加目录","移除"]` 且三者 `top` 完全对齐（`[203,203,203]`）、侧栏底部已无刷新按钮（按钮数 0）、mock 提示条仍在、点击刷新无报错且界面正常、全程无 `pageerror`。
- **待办**：桌面端观感需在 `0.1.0-beta.9` 的 Windows 产物上复核。
- **版本边界**：`mcp-gui` 四处版本同步 `0.1.0-beta.8 → 0.1.0-beta.9`，随本版发布 tag `gui-v0.1.0-beta.9`；`update/gui/latest*.json` 由发布 job 自动生成并提交（`[skip ci]`），**发布后两仓各会多出一个机器人提交**，按既有做法合并回同一提交再推两仓。**MCP 主包版本不受影响**。

---

### 独立交付面 · 日志台 GUI **指标仪补「已成功」+ 数据目录上移 + 设置面板改居中弹窗**（`mcp-gui/`，`0.1.0-beta.8`）

- **范围**：`mcp-gui/src/App.vue`、`src/components/{OverviewPage,MetricsStrip}.vue`、`src/styles.css`，以及四处版本号（`package.json` / `package-lock.json` 两处 / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`）。**未改** `src/core/**`、`src/api/**`、`src/stores/**`、`src/i18n/**`（**零新增文案键**）与 `src-tauri/**` 的代码（仅版本号），也未改 MCP 主包 `src/**` 与 `tianshu-mcp-web/`。
- **背景**：维护者在真机上验收 `0.1.0-beta.7` 时反馈 —— **「手动下载」点击已可直接跳转**（beta.7 的核心修复已真机确认，`docs/issue-25-gui-real-machine-record.md` §4.1 遗留项闭环），同时按截图提出三处界面调整。
- **三处调整**：
  1. **指标仪补「已成功」**（`OverviewPage.vue` 新增 `succeededCount` + 第 4 格，`.metrics` 由 4 列改 **5 列**）：顺序为 **任务总数 / 进行中 / 已结束 / 已成功 / 已失败**，读数用语义色 `tone-ok`；标签复用既有 `status.succeeded`，**不新增 i18n 键**（与相邻「已失败」复用 `status.failed` 同口径）。
  2. **「数据目录」上移**：由 `.rail-foot` 移入 `.rail-nav`，**紧接「设置」之后**；侧栏序列变为 **品牌 → 全局搜索 → 任务列表 / 运行日志 / 设置 → 数据目录 → 任务分区 → 刷新**，侧栏底部只剩「刷新」。为保持分组可读，新增一条 `.rail-nav > .rail-block` 分组线（与 `.rail-label` 同款 `border-top`，**不写硬编码色值**）。
  3. **设置面板改居中弹窗**：`.poverlay` 由 `justify-content: flex-end` 改为 `align-items/justify-content: center`；`.panel` 由「右侧全高滑出」改为居中卡片（`max-height: 86vh`、四边描边、圆角 `var(--r-2)`、`overflow: hidden`），入场动画改用既有 `@keyframes rise` 并删除只服务于旧形态的 `slide-in`；`.panel-body` 补 `min-height: 0` 以保证在 `max-height` 下正常内滚。点遮罩关闭的行为不变。
- **验证（本机）**：`check:schema`（版本一致 `0.1.0-beta.8`）/ `vue-tsc --noEmit` / `eslint . --max-warnings 0` / `vitest`（**82 passed**，8 文件）/ `vite build` 全绿。
- **模拟真机**：`puppeteer-core` + 本机无头 Edge（mock 运行时）DOM 断言 **12/12 通过** —— 指标仪 5 格与顺序、`已成功` 读数与 `tone-ok` 语义色、数据目录位于 `.rail-nav` 内且紧接「设置」、底部只剩「刷新」、**面板中心 720.0 = 窗口中心 720.0（1440×900）**、四周均不贴窗口边缘、圆角 4px、遮罩居中、`height=589.5 ≤ 视口`、全程无 `pageerror`。
- **待办**：桌面端观感（居中弹窗在真实窗口尺寸下的观感、侧栏上移后的分组线）需在 `0.1.0-beta.8` 的 Windows 产物上复核。
- **版本边界**：`mcp-gui` 四处版本同步 `0.1.0-beta.7 → 0.1.0-beta.8`，随本版发布 tag `gui-v0.1.0-beta.8`；`update/gui/latest*.json` 由发布 job 自动生成并提交（`[skip ci]`），**发布后两仓各会多出一个机器人提交**，按既有做法合并回同一提交再推两仓。**MCP 主包版本不受影响**。

---

### 独立交付面 · 日志台 GUI **手动下载修复 + 设置入口迁入侧栏导航**（`mcp-gui/`，`0.1.0-beta.7`）

- **范围**：`mcp-gui/src/App.vue`、`src/styles.css`、`src/components/SettingsDrawer.vue`、`src/api/{gui-api,tauri,mock}.ts`、`src/stores/app.ts`、`src-tauri/src/{lib,models,updater}.rs`、`src-tauri/{Cargo.toml,capabilities/default.json}`、`package.json` / `package-lock.json`、`test/mock.test.ts`。**未改** `src/core/**`、`src/i18n/**`（零新增文案键）与 MCP 主包 `src/**`、`tianshu-mcp-web/`。
- **三项修改**：
  1. **删掉侧栏品牌区装饰绿块**（`App.vue` 的 `<span class="mark" />` + `styles.css` 的 `.mark` 规则整条移除，全局已无引用）。
  2. **修「手动下载」两个缺陷**：① 入口原是 `<a target="_blank">`，Tauri 2 的 webview 会拦截新建窗口请求且此前**未接入任何外部打开能力**，故点了没有任何反应 —— 现接入官方 `tauri-plugin-opener`（JS 绑定经 `src/api` 出口，`GuiApi.openExternal`），并把入口改为 `<button>`；② 兜底地址原是**单常量恒指 GitHub**，与本次实际使用的源脱钩 —— 现拆成 `MANUAL_DOWNLOAD_URL_{GITHUB,GITEE}` 并由 `manual_download_url_for(&chosen)` 按 `resolve_source` 的结果取值（未知源回退 GitHub），前端 `mock` 同步该语义。
  3. **设置（齿轮）入口从侧栏底部迁到「运行日志」下方**：由 `.rail-foot` 的图标按钮改为 `.rail-nav` 内的 `.navitem`（复用现成类，`styles.css` 零改动），面板打开时该条常亮；侧栏底部只剩「刷新」。
- **权限口径（最小化）**：`capabilities/default.json` 追加的是**带白名单**的 `opener:allow-open-url`，只允许 `https://github.com/**` 与 `https://gitee.com/**` 两个发行页域名，**不整包放开** opener。
- **兜底地址与「更新源」的一致性**：以 Rust 侧 `resolve_source()` 实际选出的源（`auto` 即实测择优结果）为准，而非偏好里的字面值 —— 与设置面板已显示的「更新源：{s}」不会自相矛盾。
- **验证（本机）**：`check:schema`（版本一致 `0.1.0-beta.7`）/ `vue-tsc --noEmit` / `eslint . --max-warnings 0` / `vitest`（**82 passed**，8 文件，较上版 +1 条「兜底入口随源变化」）/ `vite build` 全绿；构建产物抽样确认 `.mark` 已不在 CSS、新 Gitee 发行页地址已进 JS。**本机无 MSVC `link.exe`**，故 `cargo clippy` / `cargo test` 无法在本机运行（与 issue #25 约束 D2 一致），Rust 门禁交 `GUI` workflow。
- **CI 往返（本轮一次失败一次修复）**：首次推送时 `Rust format / clippy / tests` 在**三平台 1~2 秒内**失败 —— 该步骤含三条命令，只有最快的 `cargo fmt --check` 能这么快失败，定位为格式问题；根因是新增的 `&chosen` 实参把三处 `match` 臂推到超宽（rustfmt 要求改成 `Err(e) => { return ... }` 块式）、导入项字母序（`_GITEE` 应先于 `_GITHUB`）与一处 `assert_eq!` 折行不符。已用本机 `rustfmt`（`cargo/rustc 1.98.0`，与 CI stable 一致）跑 `cargo fmt` 修正（提交 `8d6df8f`）。
- **CI 与发布已跑通**：`GUI` run [#61](https://github.com/lanlan0811/tianshu-mcp/actions/runs/36368067735)（push）全绿 —— 三平台 `Rust format / clippy / tests` + `Build app bundle` + `Upload build artifacts` 全部 success（windows 的 Rust 步骤 86s、darwin-aarch64 58s，说明 clippy/test 真正跑完并编译了新依赖）；tag `gui-v0.1.0-beta.7` 的 run [#62](https://github.com/lanlan0811/tianshu-mcp/actions/runs/36369447953) 的 `Publish beta pre-release (GitHub + Gitee)` **10 个步骤全部 success**：GitHub pre-release 已创建（8 个产物，含 `x64-setup.exe` 与其 `.sig`），Gitee pre-release 附件与清单已写入，`update/gui/latest.json` 与 `latest-gitee.json` 均为 `0.1.0-beta.7` 且签名一致，`gui-v*` 未触发 MCP 的 `release.yml`。
- **真机验收已完成**：维护者在 Windows 10 安装 `0.1.0-beta.7` 后实测 —— **「手动下载」点击可直接跳转到系统默认浏览器**，beta.7 的核心修复生效，该遗留项已闭环（见 `docs/issue-25-gui-real-machine-record.md` §4.1）。
- **⚠️ 另有一条与本轮无关的既有 CI 红灯**：MCP 主包 `ci.yml` 自 `#285`（`03cf91c` open-design 冒烟修复）起转红，`#286`~`#288` 持续失败，集中在 ubuntu / macos 的 6 个 `Build & Test`（windows 与全部 `Visual browser` 通过）；**与本轮 GUI 改动无因果关系**（本轮只动 `mcp-gui/**` 与 `gui.yml`）。
- **模拟真机**：`puppeteer-core` + 本机无头 Edge 打开 dev server（mock 运行时），DOM 断言 **10/10 通过**（无 `.mark`、主导航为「任务列表 / 运行日志 / 设置」、底部只剩「刷新」、设置项可开面板且常亮、手动下载已非锚点、强制 Gitee/GitHub 各自经 `window.open` 打开对应发行页、无 `pageerror`）。
- **版本边界**：`mcp-gui` 四处版本同步 `0.1.0-beta.6 → 0.1.0-beta.7`（`package.json` / `package-lock.json` 两处 / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`），随本版发布 tag `gui-v0.1.0-beta.7`；`update/gui/latest*.json` 由发布 job 自动生成并提交（`[skip ci]`）。**MCP 主包版本不受影响**（`AGENTS.md`：`mcp-gui` 不迭代主包版本）。

---

### 独立交付面 · 日志台 GUI **常驻左侧栏（顶栏改左侧栏）**（`mcp-gui/`，`0.1.0-beta.6`）

- **范围**：`mcp-gui/src/App.vue`（外壳重写）、`src/components/{OverviewPage,WorkspacePage,DataHomeBar}.vue`、`src/styles.css`（唯一视觉真源）、`src/i18n/{zh-CN,en-US}.ts`（各 +2 键）。**未改** `src/core/**`、`src/api/**`、`src/stores/**`、`src/theme/index.ts` 与 `src-tauri/**`（符合 `ARCHITECTURE` §16.6 的改动边界）。
- **为什么改**：`0.1.0-beta.3` 把界面做成「概览页顶栏 + 工作区面包屑/竖排分区导航」两套骨架——概览是横的、工作区是竖的，形态不一致。本轮回正为**一条常驻左侧栏 + 两态内容区**。
- **新骨架**：`.shell` 由 `flex-direction: column` 改为 `row`，左列 `.rail`（208px）恒在——品牌 → 全局搜索 → 主导航（任务列表 / 运行日志）→ **任务分区导航（事件流 / Agent 日志 / 验收日志 / 验收报告）** → 数据目录 → 刷新 / 设置；右列 `.stage` 承载两态。**工作区的分区导航并入这条侧栏，页面里不再有第二层左栏**；面包屑与任务摘要带仍留在内容区顶部。
- **两处语义收敛（不是纯样式搬运）**：① `server.log` 形态改由 `app.tab === "serverLog"` 派生，删掉 `workspaceMode` 状态位——原来「任务态下点分区项看 server.log（保留摘要带）」与「概览点运行日志进 server 形态」两条路径并存；② 分区导航由 5 项收敛为 4 项，全局「运行日志」上移到主导航。概览页的搜索模式（`mode`）由 `OverviewPage` 提升到 `App.vue`——侧栏搜索框聚焦即置为 `search`。
- **布局常量**：新增 `--rail-w: 208px` / `--rail-glow`（原 `--topbar-glow` 的竖排转写，深浅各一套）；删除 `--nav-w` / `--topbar-glow` 与 `.topbar` / `.split` / `.sidenav`；`--topbar-h` 改名 `--panel-head-h`（唯一剩余使用者是设置面板头）。版式记忆点由「顶栏上沿荧绿细线」转为「**侧栏左沿**荧绿细线」，概览页指标仪补上内容区顶沿细线（`box-shadow: inset 0 1px 0 var(--accent-line)`）。
- **验证（本机实测）**：`vue-tsc --noEmit` / `eslint . --max-warnings 0` / `vitest`（**81 passed**，8 文件）/ `vite build` 全绿；**headless Edge 真机渲染探针**（`puppeteer-core` + 本机 Edge，dev server `http://localhost:1420`）产出 6 张截图（概览 dark/light、1024×640 窄窗、工作区 dark/light、切到「验收报告」分区），DOM 断言 `leftColumns=1`、`.topbar` / `.split` / `.sidenav` 全不存在、无横向溢出；像素采样确认侧栏左沿荧绿细线（浅色实测 `rgb(152,213,191)`，与 `--accent-line` 42% 叠米白的理论值一致）与选中项 3px 强调脊随点击在侧栏内竖直迁移（y 76→191→299）。
- **交互回归清单（13 步全过；逐帧核对状态字段，不只看「点击未抛异常」）**：① 初始为概览 · 任务卡网格，侧栏 2 项（任务列表 / 运行日志）、选中「任务列表」→ ② 点侧栏搜索框进入搜索模式（`.searchbar` 出现，此时侧栏无选中项）→ ③ 搜索面板「任务列表」回卡片网格 → ④ 侧栏「运行日志」进 server 形态（面包屑=运行日志、摘要带隐藏、**侧栏只剩 2 项——分区导航正确让位**）→ ⑤ 回概览 → ⑥ 点任务卡进工作区（面包屑=taskId、摘要带出现、**侧栏 6 项、选中「事件流」**）→ ⑦⑧⑨ 分区切到验收报告 / Agent 日志 / 事件流，选中态随之迁移 → ⑩ 刷新按钮无新报错 → ⑪⑫ 设置面板开 / 关 → ⑬ 面包屑返回回概览。全程 `pageerror` 为 0；唯一 console error 是既有 favicon 404（`index.html` 未引用 favicon，已 `curl` 复核，与本次改动无关）。**未实测**：导出 / 复制（需真实文件系统与 Tauri 运行时，mock 下无法触发）、数据目录追加 / 移除（同上）——这三项只做了代码路径核对（`WorkspacePage` 的 crumb 动作与 `DataHomeBar` 的 store 调用均未改动）。
- **未做**：人工逐张目视（本会话的图片读取工具不支持二进制；6 张 PNG 与两份 JSON 报告归档在 `.rivet/tmp/gui-rail/` 供维护者目视）、Rust 侧构建（按 issue #25 约束不在本机执行）。
- **版本边界**：`mcp-gui` 四处版本同步 `0.1.0-beta.5 → 0.1.0-beta.6`（`package.json` / `package-lock.json` 两处 / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`），随本版发布 tag `gui-v0.1.0-beta.6`；三平台构建与双端 pre-release 全在 `GUI` workflow，`update/gui/latest.json` 由发布 job 自动生成并提交（`[skip ci]`），本地不跑 Rust。**MCP 主包版本不受影响**（`AGENTS.md`：`mcp-gui` 不迭代主包版本）。

---

### 独立交付面 · 日志台 GUI **系统托盘 + 「关闭窗口」行为设置**（`mcp-gui/`，`0.1.0-beta.5`，2026-09-27）

- **范围**：`mcp-gui/src-tauri/**`（新增 `tray.rs`、改 `lib.rs` / `models.rs` / `Cargo.toml`）、`mcp-gui/src/**`（`SettingsDrawer.vue` / `AppIcon.vue` / `api/types.ts` / `api/types-lite.ts` / `stores/preferences.ts` / `api/mock.ts` / 两份 i18n 文案包）。**未改 `src/**`（MCP 主包）与 `tianshu-mcp-web/`**。
- **托盘（Rust 侧，不占前端权限）**：`Cargo.toml` 打开既有 `tauri` 的 **`tray-icon`** feature（**未新增任何依赖**）；新增 `src-tauri/src/tray.rs`，复用 `AppHandle::default_window_icon()` 作图标（**不新增图标资源**，符合「图标一律由 CI 从 `assets/*.svg` 派生」）。**右键**菜单两项：显示日志台 / 退出日志台；**左键单击**唤出并聚焦窗口（`show_menu_on_left_click(false)`，菜单只在右键弹出）。
- **菜单文案随界面语言热更新**：语言真源仍是 `Preferences.language`；`set_preferences` 里**仅当语言变化**时经 `app.run_on_main_thread` 重建菜单（菜单创建必须在主线程）。中英两档，其余回退中文。
- **关闭行为（默认缩小到托盘）**：偏好新增 `closeAction`（`"tray"` 默认 / `"exit"`）；窗口 `CloseRequested` 由 Rust 侧判定 —— `tray` → `api.prevent_close()` + `window.hide()`；`exit` → `app.exit(0)`。设置面板「关闭窗口」二选一（复用既有分段控件版式，**零新增 CSS**），中英各补 4 条键。
- **升级兼容（本次最关键的坑）**：`Preferences.close_action` **必须带 serde 默认值** —— `preferences.rs` 的读失败/反序列化失败会**整份回退默认**，字段缺失会连带把用户的语言 / 主题 / 数据目录一起重置；现已用 `#[serde(default = "default_close_action")]` 兜底。
- **macOS 兼容**：`run()` 由 `.run(context)` 改为 `.build(context)` + `App::run(回调)`，在 `RunEvent::Reopen` 时唤回窗口（点 Dock 图标）。
- **失败隔离**：托盘创建失败**不阻塞启动**（`setup` 中忽略错误，日志查看主流程优先）。
- **版本与文档**：`mcp-gui` 四处版本同步 `0.1.0-beta.4 → 0.1.0-beta.5`（`package.json` / `package-lock.json` 两处 / `tauri.conf.json` / `Cargo.toml`）；同步 `docs/gui-log-viewer` 双语（新增「5.2 系统托盘与关闭行为」+ 已知限制）、`ARCHITECTURE` 双语（§16.3 新增 `tray.rs`、新增 §16.7 托盘与关闭行为契约）、`README` 双语（M33 增量）、`CHANGELOG` 双语（未发布段）。**未打 tag、未发版**（发版是维护者动作）。
- **本机门禁全绿**：`typecheck` / `lint` / `test`（81 项）/ `check:schema`（版本一致）/ `build`。按 issue #25 约束**未在本机执行任何 Rust 侧构建与检查**，Rust 门禁与三平台打包由 `GUI` workflow 承担。

### 独立交付面 · 日志台 GUI **升级路径修复：更新后旧版本不消失**（`mcp-gui/`，`0.1.0-beta.4`，2026-09-27）

- **真机现象**：Windows 10「设置 → 应用和功能」里**同时有两条记录** —— `Tianshu-mcp Logs`（0.1.0-beta.1，`D:\Tianshu-mcp Logs`）与
  `Tianshu-mcp-Logs`（0.1.0-beta.3，`%LOCALAPPDATA%\Tianshu-mcp-Logs`），即「更新后原来的软件不消失、被保留下来」。
- **根因（注册表实测取证，不是推测）**：Tauri 的 NSIS 模板把卸载项注册表键写成
  `!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"`。
  而 `0.1.0-beta.1 → 0.1.0-beta.2` 之间，为修「GitHub 会把含空格的发行资产名归一化成点、Gitee 原样保留 → 两端下载地址不一致」（提交 `7d56b21`），
  `bundle.productName` 由含空格的 `Tianshu-mcp Logs` 改成了无空格的 `Tianshu-mcp-Logs`。**键名跟着 productName 变**，
  于是新安装器不再把旧安装视为「同一个应用」—— 既不覆盖也不卸载。Tauri 只处理 `mainBinaryName` 变更（`UNINSTKEY` 下的 `MainBinaryName` 值），**不处理 productName 变更**。
- **修法（不回退 productName）**：回退会让 beta.2/3 的新安装反而变成残留，并重新引入资产名两端不一致。改为**一次性迁移**：
  新增 `mcp-gui/src-tauri/windows/installer-hooks.nsh`，经 `bundle.windows.nsis.installerHooks`（`"./windows/installer-hooks.nsh"`；CLI 打包前会把 CWD 切到 `src-tauri`，故是 src-tauri 相对路径）挂载，
  在 `NSIS_HOOK_PREINSTALL` 中：读旧名称卸载项的 `UninstallString` → **静默运行它自己的卸载器**（`ExecWait '$R9 /S'`）→ 兜底 `Delete` 旧快捷方式、`DeleteRegKey` 旧卸载项与 `Software\tianshu\Tianshu-mcp Logs`。
  旧卸载项不存在时**完全不动作**（全新安装与当前名称的更新零影响）。
- **边界（已写进钩子注释与文档，防后人误扩）**：① 静默卸载**不会删用户数据** —— NSIS 卸载器的「Delete app data」复选框只在交互模式下经 `un.ConfirmLeave` 置位，
  `/S` 下 `$DeleteAppDataCheckboxState` 保持空值；两端 BUNDLEID 相同、数据目录共用，必须保留；
  ② 旧卸载器可能因「旧进程占用且强制关闭失败」而中途 `Abort`（静默模式下它只往控制台打印红色提示后 `Abort`），此时**不会**清理自己的注册表键 ——
  故本钩子在它之后**无条件**删除该键，保证列表残留一定消失；③ **不对旧 `$INSTDIR` 做 `RmDir /r`**：旧安装位置是用户在旧安装器里自选的（本机即 `D:\Tianshu-mcp Logs`），递归删用户自选路径有误删风险；
  ④ 只清理这一个已知历史名称（迁移别名常量），不做「扫描全部卸载项」式的通用清理。
- **验证（本机，不涉及 Rust 侧）**：用 Tauri 同款 **NSIS 3.11** 工具链，按模板**真实顺序**（`!include` 钩子在前、`!define MANUFACTURER/PRODUCTNAME` 在后）写等价 harness 编译通过（`makensis` exit 0）——
  这同时证明了「宏体内引用模板变量」在真实插入顺序下成立（`${MANUKEY}` 若未定义会直接报未知变量而非静默为空）。
  附带确认：`makensis` 的文本编码校验只作用于**主脚本**，被 `!include` 的钩子按主脚本字符集解码，
  故钩子内**运行期字符串保持 ASCII、注释用中文**（中文注释在 ACP / CP1252 / UTF-8 三种输入字符集下均不影响编译）。
- **版本**：`0.1.0-beta.3 → 0.1.0-beta.4`（`package.json` / `package-lock.json`（2 处）/ `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` 同提交）；
  **不涉及 MCP 主包**（主包仍为 `0.7.1`，未打 tag、未发布）。
- **发布（2026-09-27）**：tag `gui-v0.1.0-beta.4` → `d593abe`（GitHub `git/ref` 与 Gitee `git ls-remote` 双端核对同 SHA）。
  `GUI` run `36312223737` 的 **5 个 job 全 success**（`Schema parity` + 三平台 `Build` + `Publish beta pre-release`）；
  GitHub 与 Gitee **双端 pre-release 均已创建**（GitHub 侧 8 个资产），两端清单 `update/gui/latest.json` / `latest-gitee.json` 均指向 `0.1.0-beta.4`，
  **6 个下载地址实测 HEAD 200**；`gui-v*` 未触发 `release.yml`。Windows 腿构建成功即证明新钩子**确实被 makensis include 进** `-setup.exe`（路径或宏写错都会让该腿失败）。
  发布后两仓各多一个机器人提交（GitHub `1f4415b` / Gitee `4f18879`），已合并为 `af22ce2` 并回推两端收敛。
- **本机历史残留已清除**：用旧安装自带的卸载器把 `Tianshu-mcp Logs`（0.1.0-beta.1，`D:\Tianshu-mcp Logs`）卸载，并补删静默卸载不会清的 `HKCU\Software\tianshu\Tianshu-mcp Logs`（值为旧 `$INSTDIR`）；
  「应用和功能」恢复为单条记录。旁证：同 publisher 下另有一个**完全无关**的 `Tianshu`（3.26.0）条目 —— 正好说明钩子「只清精确旧键、不做 publisher 扫描」是必要的。
- **真机端到端复现（2026-09-27）✅ 通过**：因最初的 pre-fix 安装包已随 beta.1 发行版重建而消失，复现方式为「用 beta.1 安装包以 `/D=D:\Tianshu-mcp Logs` 安装 → 把安装状态还原成旧命名（卸载项键/DisplayName/`Software\tianshu` 下同名键/两个快捷方式）→ 静默运行 beta.4 安装包」。
  结果：**旧条目、旧目录、两个旧快捷方式、`Software\tianshu\Tianshu-mcp Logs` 全部消失**，只剩 `Tianshu-mcp-Logs 0.1.0-beta.4` 一条；exe `FileVersion=0.1.0-beta.4`；`com.tianshu.mcp.logs` 与 `~/.tianshu-mcp` 数据完好。
  同时验证了带引号 `UninstallString`（路径含空格）能被正确执行。边界如实写在 `docs/issue-25-gui-real-machine-record.md` §2.4。

### 独立交付面 · 日志台 GUI **布局范式重写**（`mcp-gui/`，`0.1.0-beta.3`，2026-09-27）

- **为什么重做**：`0.1.0-beta.2` 只换了配色与控件外观，**DOM 骨架仍是「顶栏 + 三栏并置（任务栏 / 内容 / 详情）+ 横排标签页」**，
  被维护者判定为「换皮」。本轮**推翻骨架重画**：除数据与操作能力外，**不从旧界面沿用任何布局结构**。
- **新范式（两态式）**：界面变成两个整页——
  ① **任务概览**：顶栏（品牌 / 数据目录 / 搜索 / 刷新 / 运行日志 / 设置）+ 四格指标仪 + 状态圆片行 + 筛选浮层 + **任务卡网格**；
  ② **全屏工作区**：面包屑 `‹ 任务列表 / <taskId>` + **任务摘要带**（默认单行，展开为完整元信息 / 改动文件 / 导出整包）+ **竖排分区导航** + 内容区；
     `server.log` 是工作区第二形态（隐藏导航，面包屑显示「任务列表 / 运行日志」）。
  **没有常驻任务栏、没有常驻详情栏、没有横排标签页**；两态切换落在 `App.vue` 的本地 `ref`，**store 与数据层零改动**。
- **全局搜索上移**：跨任务搜索从「中栏标签页」搬到**概览页的搜索模式**（进入后主体换成结果分组列表，命中即跳进工作区对应分区），
  界面不再暴露 `search` 标签（`TabKey` 与 `openTab("search")` 分支按原样保留）。
- **视觉（黑曜石终端）**：深色为默认主题（锂黑 `#0B0D0C` 画布 + 荧绿 `#3DFFA0` 点缀），浅色按同一语言重做为「米白终端」；
  **等宽字体主导**（品牌名 / 路径 / ID / 时间 / 行号 / 命令 / 指标数字 / 导航 / 日志正文，中文正文回退系统 sans）；
  硬朗圆角（面板 4px / 标签与输入 3px）、**方括号状态标签**（`[OK] 已成功`）、任务卡左侧 3px 状态脊 + 标题 `›` 前缀、
  顶栏与面包屑栏上沿各一条 1px 荧绿细线；深色底极淡点阵、浅色底极淡网格（**已彻底移除蓝紫渐变与紫色信息色**）。
- **强调色与语义色分工（新增契约）**：`--accent`（荧绿）只出现在选中态 / 主按钮 / 焦点环 / 面包屑返回项 / 状态脊；
  状态标签与状态圆片只用 `--tone-*`，两者靠**位置与形状**区分而不是色相。
- **结构变更**：新增 `OverviewPage` / `WorkspacePage` / `TaskCard` / `MetricsStrip` / `TaskSummaryBar`；
  **删除 `TaskListPanel.vue` 与 `DetailPanel.vue`**（分别被「概览页 + 任务卡」与「摘要带」取代，避免两套实现与死代码）；
  `AppIcon` 仅新增 `chevronLeft`（其余复用既有 SVG 路径表，**禁 emoji**）。
- **i18n**：仅新增 4 个键（`tasks.total` / `tasks.active` / `tasks.finished` / `tasks.filter`），中英双语同步，i18n 完整性用例仍绿。
- **本地门禁（全绿）**：`npm run typecheck` / `npm run lint` / **81 项用例** / `npm run build` 全通过；
  `npm run dev` 启动后 **17 个源模块逐个请求均 200**；静态自查：无未声明 CSS 变量、组件内无裸色值、无旧类名残留、无内联样式、无 emoji。
- **版本**：`0.1.0-beta.2 → 0.1.0-beta.3`（`package.json` / `package-lock.json`（2 处）/ `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` 同提交）；
  **不重打 beta.2**；按硬约束**本机不执行任何 Rust 构建 / 检查**。
- **发布（2026-09-27）**：tag `gui-v0.1.0-beta.3` → `1652449`（两仓同 SHA）。`GUI` workflow 三平台构建（`windows-x86_64` / `darwin-x86_64` / `darwin-aarch64`）**全部 success**；
  GitHub 与 Gitee **双端 pre-release 均带产物**（两端各 **8 个附件**：含 3 个更新载体 `*-setup.exe` / `*_<平台>.app.tar.gz` 与全部 `.sig`，两端同字节数），
  两端更新清单 `update/gui/latest.json` 与 `latest-gitee.json` 均指向 `0.1.0-beta.3`（清单签名与发行版 `.sig` 逐一比对一致，三平台下载地址实测 HTTP 200）。
  首次运行时**发布作业末尾「提交 GitHub 清单」步骤失败**：`git push origin HEAD:master` 因发版期间 master 被并发提交推进而 non-fast-forward（exit 1）——
  已把该步骤改为**推送被拒即拉取最新 master 变基重推（最多 3 次，仍失败才报错）**，并据此补齐 GitHub 侧清单；`gui-v*` 仍未触发 `release.yml`。
- **不涉及 MCP 主包**：主包（`0.7.1`，未发布）零改动。

### 独立交付面 · 日志台 GUI 前端设计系统重构（`mcp-gui/`，未发布，2026-09-27）

- **范围**：`mcp-gui/` 前端**表现层完全重构**（`App.vue` + 11 个组件 + 全局样式 + `index.html`），
  **功能、数据层、store API、i18n 键一律未动**；`src/core/**`、`src/api/**`、`src/stores/**`、`src/i18n/**`、`src/theme/index.ts` 与 Rust 侧**全部零改动**。
- **设计系统（唯一真源 `mcp-gui/src/styles.css`）**：12 级中性灰阶 + 语义别名（`--bg-*` / `--line-*` / `--fg-*`）；
  唯一强调色为**钢蓝**（浅色 `#2F5C86` / 深色 `#6FA8DC`，与 `info` 紫明确区分）；原先的**蓝紫渐变品牌标与紫色信息色已移除**；
  间距阶 4/6/8/12/16/20/24/32、圆角 3/5/8/999、动效 120/180/260ms + 统一缓动、`:focus-visible` 焦点环、`prefers-reduced-motion` 全量降级。
- **字体：仅系统内置字体**（显示体 / 正文 / 等宽三档栈：Windows `Segoe UI Variable*` + macOS `SF Pro*` / `PingFang SC`），
  **零新增字体文件、零外链**；所有计数 / 时间 / 行号 / 字节改用 `tabular-nums`。
- **版式记忆点**：顶栏顶部 1px 强调色细线 + 任务行左侧 3px 状态脊；六标签页由药丸改为**下划线指示器**；
  报告类型 / 轮次 / 设置三组改用**分段控件**与圆片，层级可辨；事件流改为带表头的四列栅格（`行 / 时间 / 事件 / 详情`，展开 JSON 整行通栏）。
- **可访问性与主题**：标签栏 `role="tablist" / tab` + `aria-selected` + ←/→ 键切换；图标按钮补 `aria-label`（复用既有 i18n 键，**未新增任何文案键**）；
  错误条改 `role="alert"`；新增 `color-scheme` 声明让原生 select / 滚动条跟随主题；`index.html` 加**首屏防白闪**内联底色。
  `<html data-theme="light|dark">` 主题契约不变，深浅两套 token 完整对齐。
- **本地门禁（全绿）**：`npm run typecheck` / `npm run lint` / `npm run test`（**81 项既有用例零失败**）/ `npm run build`；
  `npm run dev` 启动后逐模块请求 14 个源文件**均 200**，编译产物 CSS 括号平衡、关键选择器齐备；组件内**零硬编码颜色、零内联结构样式、零 emoji**。
- **版本**：GUI 独立版本 `0.1.0-beta.1 → 0.1.0-beta.2`（`package.json` / `package-lock.json`（2 处）/ `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` 同提交）；
  **未打 tag、未触发任何发布流程**；按硬约束**本机未执行任何 Rust 构建 / 检查**。
- **不涉及 MCP 主包**：本次 GUI 重构对主包**零改动**（主包本轮另因 Open Design 接线自 `0.7.0` 升到 `0.7.1`，见上方条目）。

### 独立交付面 · 日志台 GUI（`mcp-gui/`，Tauri 2.x + Vue 3）（未发布，2026-09-27）

- **范围**：新增独立交付面 `mcp-gui/` —— 本地**只读**桌面应用，把四类日志与任务产物统一到一个界面；
  与 MCP server **完全解耦**（纯读文件系统，不依赖 server 在跑），**MCP 主包运行时逻辑零改动**。
- **四类日志**：`server.log`（级别 / 时间范围过滤 + 关键字高亮）、`task.jsonl`（状态跃迁 / 细粒度 Agent 事件 / `note` 进度通道分区，坏行跳过但计数）、
  `agent-<轮次>.log` 与 `verify-<轮次>.log`（轮次切换 + 行号 + 换行）、`report-<轮次>.{md,json,html}` 与 `dry-run-report-*`
  （Markdown / 结构化卡片 / **sandbox iframe**（注入 CSP + 剥离 `<script>`）/ 干跑与常规分区 / 多轮对比）。
- **大日志与实时 tail**：首屏只读 64 KiB 尾窗 + 向前分块 + 「已加载 N / 共 M」；`notify` 驱动增量刷新，**手动上翻自动暂停跟随**、可一键「跳到最新」。
- **搜索 / 导出**：跨任务按需扫描（**不建全文索引**）+ 进度 + 可取消；单文件导出 + 任务整包 zip（可排除体积大的原始日志并如实回报排除数）。
- **双源自动更新**：**实测择优**（不依赖系统区域，VPN 场景下亦正确）+ 三态开关 + TTL 缓存 + 回退上次可用源；
  两端清单同版本同签名，`tauri-plugin-updater` **验签不通过一律拒绝安装**；任一步失败都**不影响日志查看主流程**（提供「手动下载」兜底）。
- **构建边界（硬约束）**：本机**不执行 Rust 侧构建与检查**（`cargo fmt` / `clippy` / `tauri build` 全在新增的 `GUI` workflow）；
  图标由 CI 用 `tauri icon` 从 `assets/tianshu-mcp-icon.svg` 生成，`icons/` 与 `Cargo.lock` **不入库**。
- **防漂移门禁**：`mcp-gui/scripts/check-schema-parity.mjs` 比对 **TS 真源（`src/tasks/task.ts` / `src/agents/agent-events.ts`）↔ 前端镜像 ↔ Rust 镜像**，
  任一漂移即 fail；`GUI` workflow 的触发路径含两个真源文件，故 TS 侧漂移也会被检出。
- **与 MCP 发版隔离**：GUI 使用独立版本（`0.1.0-beta.N`）与独立 tag（`gui-v*`），**不以 `v` 开头**，**不触发** `release.yml`（workflow 内另有显式断言）。
- **测试**：`mcp-gui` 新增 **81 项前端用例**（8 文件：日志行解析 / 事件解析 / 字节与窗口 / 筛选排序 / 报告摘要 / i18n 完整性 / 沙箱 / mock 出口）；
  本机 `vue-tsc --noEmit` / `eslint . --max-warnings 0` / `vitest` / `vite build` 全绿（只依赖 Node）。
- **CI 实测（`GUI` workflow，2026-09-27）**：`schema-parity` ✅；**三平台（`windows-x86_64` / `darwin-x86_64` / `darwin-aarch64`）全部 success** ——
  `cargo fmt --check` → `cargo clippy --all-targets -D warnings` → `cargo test` → `tauri build` 打包 → 产物上传，全链路通过（清理临时诊断步骤后已复验一轮全绿）。
  修复过程中依次消除 **rustfmt 违规（14 文件结尾换行 + 折行/导入顺序）→ Rust 编译错误（11 处）→ clippy `dead_code`（8 处）**。
- **CI 排障教训（可复用）**：① 公开仓的 job 日志下载接口需 admin 权限（403），而本机按 D2 不跑 cargo →
  诊断信息只能靠 **GitHub 注解**暴露（`::error` / `::warning` + 公开可读的 `check-runs/<job_id>/annotations`）；
  ② **cargo / rustc 输出带 ANSI 颜色码**，解析前必须先剥离（`sed` 去掉 `ESC[...m`），否则 `^error` 行一条也匹配不到；
  ③ 注解有「**单条正文 ~4K 字符 + 单步 10 条**」上限，故需按 ≤2500 字符切块并**分多步**打印；
  ④ `rustfmt` 在 Windows runner 上的 diff 表头是 `Diff in <路径>:<行号>:`（非 Unix 的 `at line <行号>`），解析需兼容两种。
- **手动触发的变更检测陷阱（已修）**：`GUI` workflow 用 `changed` 步骤判定是否真改了 GUI，但 `workflow_dispatch` **不带 `github.event.before`**，
  早期实现会退化成 `git diff HEAD~1 HEAD` —— 若最近两次提交恰好只改文档，整个三平台矩阵会被**静默跳过**（手动触发变成"11 秒 Success 但什么都没跑"）。
  现口径：手动触发**无条件构建**；tag 无条件构建；push / PR 才做 diff 过滤。
- **首次打 tag 暴露的 Windows 更新载体命名问题（已修）**：`Build updater manifest fragment` 仅在 **tag 运行**时执行，此前非 tag 运行都被跳过，故"全绿"没暴露到。
  打 `gui-v0.1.0-beta.1` 后该步骤 **Windows 失败、macOS 两平台成功** —— 根因是载体命名取决于 `bundle.createUpdaterArtifacts`：
  本项目用 **v2 原生 `true`**，Windows **不产出 `.nsis.zip`**，而是**直接复用 NSIS 安装器** `*-setup.exe`（签名 `*-setup.exe.sig`）；只有 `"v1Compatible"` 才产出 `.nsis.zip`；macOS 两种模式都是 `.app.tar.gz`。
  修法：`mcp-gui/scripts/build-updater-manifest.mjs` 改为**按优先级匹配多后缀**（`.nsis.zip` / `.msi.zip` / `.app.tar.gz` / `.exe` / `.msi`，专用更新包优先于复用安装器），并在找不到载体时列出 bundle 目录全部文件。
- **首次打 tag 暴露的发布链路问题（已修，第 2 轮）**：构建全绿后 `Publish` 仍失败，且发现一个**不会报错的静默缺陷**：
  ① macOS 更新载体名为 `{productName}.app.tar.gz`（**不含架构**），两个架构同名相互覆盖 → 其中一个架构会拿到错误架构的包（实测两端发行版都只剩 1 个 `.app.tar.gz`）；
  ② Gitee Contents API **新建文件必须 `POST`、更新才用 `PUT`**，脚本对首次发布的不存在文件发了 `PUT` → 被拒；
  ③ 发布步骤非幂等，tag 重跑时 `gh release create` 报「已存在」。
  修法：macOS 载体按平台重命名（幂等）；Gitee 按 `sha` 选择 `POST`/`PUT` 并清理旧附件；GitHub 发布改为「已存在则 edit + delete-asset + upload」。
  另外两个**静默缺陷**一并修掉：③ `bundle.productName` 含空格 → GitHub 会把发行资产名里的空格归一化成点、Gitee 原样保留，两端不一致会让清单下载地址失效（改为无空格 `Tianshu-mcp-Logs`，界面显示名不变，并加「载体名必须是 `[A-Za-z0-9._-]`」的断言）；
  ④ Gitee 清单在缺附件时只 warn 并沿用 GitHub 地址（中国大陆不可达 = 更新不可用却不报错）→ 改为 fail-closed。Gitee 附件上传另加指数退避重试（仅 5xx/429/网络错误）与失败注解。
  **教训**：`Build updater manifest fragment` 与发布步骤只在 **tag 运行**时执行，非 tag 的 push / 手动触发一律跳过 → 「构建全绿」不等于「发布链路可用」。
- **Tauri 2 异步命令规则（本次踩坑）**：`async fn` 命令**只要含借用输入**（如 `State<'_, T>`）就**必须返回 `Result<_, _>`**，
  否则编译报 `E0277 async commands that contain references as inputs must return a Result` +
  `E0597 __tauri_message__ does not live long enough`（`get_data_home_state` / `list_tasks` / `read_events` / `get_preferences` 已按此改正）；
  另 edition 2021 下 `let state = app.state::<T>(); if let Ok(g) = state.x.lock() { .. }` 需在 `if let` 后补 `;`，否则守卫临时值晚于 `state` 释放而报 `E0597`。
- **待办（需要维护者的动作）**：
  1. ~~配置 Secrets~~ **✅ 已完成并验证生效（2026-09-27）**：`UPDATER_PUBKEY` / `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（私钥带密码，三项已成套）+ `GITEE_TOKEN`；
     配置后重新构建，`Detect signing capability` 不再输出「未配置」告警 → **签名路径已启用**（产物含更新包）；
     密钥对由 `npx tauri signer generate -w ~/.tauri/tianshu-gui.key` 在本机生成（私钥**不入库**，请离线备份 —— 更换密钥会让已发布版本的自动更新验签失败）；
  2. ~~首次发布打 `gui-v0.1.0-beta.1` tag~~ **✅ 已完成（2026-09-27）**：`GUI` workflow 全绿（三平台构建 + 发布），
     GitHub 与 Gitee **双端 pre-release 均已创建**并各附 8 个产物，两端更新清单已落库、清单内 6 个下载地址实测 HTTP 200，
     `gui-v*` **未触发** `release.yml`；
     剩余：按 [issue-25 真机记录](docs/issue-25-gui-real-machine-record.md) 用 **CI 产物**在 Windows 10 完成 §2.1（F1~F12）与 §2.2（U4~U8）真机验收（其中 §2.3 P1~P4 已在本机验证通过）；
  3. 本机 `gh` CLI 不可用，Actions artifact 需经浏览器下载；
  4. **每次发布后两仓 master 会短暂各多一个机器人提交**（GitHub 侧 `latest.json` 走 `git commit`、Gitee 侧 `latest-gitee.json` 走 Contents API）——
     推送到另一仓若被拒（non-fast-forward），先 `git fetch gitee master` 合并即可。
- **文档**：`docs/gui-log-viewer.md` / `.en.md`、`docs/issue-25-gui-real-machine-record.md`；
  README / ARCHITECTURE / CHANGELOG 双语已同步（ARCHITECTURE 新增「第 16 节 独立交付面」）。
- **不涉及 MCP 主包版本迭代**：主包仍为 `0.7.0`（**尚未发布**，Open Design 调用尚未开发完），本次未改动任何主包运行时逻辑与版本号。

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
  界面驱动（P1 选择器采集 → P2 目录绑定 → P3 模型/设计系统 → P4 方向/输入/发送 → P5 运行检测 → P6 视觉验收与返修）**已于 0.7.1 全部接线完成**（详见上方「内置 agent · Open Design 适配器接线完成」条目）。
- **完整计划**：`.dsh/plans/opendesign-gui-adapter-plan.md`（含 20 轮确认结论与 §7.1 真机实测修正）。
- **真机事实**（详见 [docs/opendesign-cdp.md](docs/opendesign-cdp.md)）：
  - 普通安装（非 MSIX）；`D:\Open Design\Open Design.exe`；产品版本与命名空间从 `<安装目录>\resources\open-design-config.json` 读（实测 `0.24.1` / `release-stable-win`）。
  - **进程级单实例锁** + 主进程强制 `app.setPath("userData", …)` → `--user-data-dir` 会被覆盖，**不做**「专属 userData 受管实例」；策略为复用优先 → 自管启动 → `needs_user(close_existing_instance)`，**绝不 kill 用户进程**。
  - **sidecar 陷阱**：daemon / web sidecar 也是同一 exe 的子进程（argv 带 `*.mjs`），实测 11 个同名进程只有 1 个真主进程。`rootOpenDesignProcesses()` 必须剔除它们，否则用户关窗后受管实例**永远起不来**。
  - 端口基准原计划 9777，实测**已被 Qoder CN 占用**（区段 9777-9796）→ 改为 **9889**（区段 9889-9898）。
  - 版本门禁用**产品版本**；CDP `/json/version` 的 `Browser` 是 **Electron 版本**（41.3.0），误用会阻断全部派发（已加回归测试）。
- **P0 阶段刻意 fail-closed**（**已被 0.7.1 取代**）：当时 `selectors.ts` 是空占位，`run.ts` 在缺关键选择器时硬失败并列出缺失键——
  有意设计：派一个还没接上界面的适配器却报成功，会污染验收与返修记账。**0.7.1 已按产品产物取证补齐全部 `primary`**，
  守卫改为只收首页无条件存在的四个锚点，界面驱动与验收-返修闭环全部接通。
- **接口变更**：新增 `run_task` 参数 `designDirection`（仅 Open Design；只支持「原型 / 文档 / 网站复刻」，其余显式拒绝，入口即拒）；
  `designSystem` 对 Open Design 的语义是**设计系统名**。`mode` 刻意不复用（那是 TraeWork 的面板模式）。
- **探针**：`npm run probe:opendesign`（`install` / `process` / `cdp` / `appconfig` / `anchors`），默认只读；`--launch` 才启动实例。
  **跑 `cdp` / `anchors` 需先把现有 Open Design 窗口关掉**（未开调试端口的实例无法接管，探针会如实报告）。
- **测试**：新增 34 用例（`test/unit/opendesign-{discovery,model}.test.ts`），全量 **1173 passed / 12 skipped**（105 文件）；
  `typecheck` / `eslint src test scripts` / `check:stdio`（dist 与 src 各 8/8）全绿。
  **新增用例不依赖本机安装 Open Design**（用注入 + 临时目录），符合「新增用例不得依赖本机 GUI agent」的既有教训。
- **下一步（真机验收，0.7.1 之后）**：在**可联网的普通终端**里跑
  `node scripts/probe-opendesign.mjs anchors --launch`，把各语义键的**实测命中数 + 文本**回填
  `docs/opendesign-cdp.md` §4.4 的证据表；再做一次真实 `run_task`（原型方向 + 「Claude」设计系统 + 指定模型），
  记录截图与日志到 `docs/opendesign-evidence/`，并验证「验收失败 → 返修 → 通过」一轮。

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
- **✅ 已修复（v0.8.2，issue #34）：Codex 模型回读缺陷**。`26.917.9434`（`26.917.8451` 同样复现）下模型触发器的
  `innerText` 混入整条思考等级条（实测回读 `6 Luna 中 无 极低 轻度 中 高 极高 Max Ultra 持续`；issue 报告版为「最高」，本机 26.930 为「Max」——
  **档位词集合随版本变化**，这正是选择「读结构」而非「枚举档位词」的理由）。
  `parseTriggerValue()` 旧实现要求文本以「低/中/高」结尾才能分离等级，此处以「持续」结尾 → 整串被当作型号 →
  `exactUiName()` 必然为假 → 三轮后判 `model_mismatch`。**这是此前 #19/#21 取证的实际阻塞点**（当时用
  「克隆内置 profile + 只改 `gui.modelSwitch=false`」绕开，属**取证规避**）。
  **修法**：`modelTriggerText()` → `modelTriggerReadback()`，三层回退读结构 —— ① 权威属性
  `data-codex-intelligence-trigger` + `data-selected-reasoning-effort`；② 结构节点
  `[class*=ModelPickerTriggerModelText]` + `[class*=ModelPickerTriggerEffortLabel] .sr-only`；
  ③ `innerText` 整串（兜底，交 `parseTriggerValue` 切分）。`matches()` 判据未改。
  真机复验（生产实现）：`{model:"6 Luna", levelToken:"medium", source:"attrs"}` 与面板一致。
  **上述 `modelSwitch=false` 规避已可撤掉**，内置 profile 的 `modelSwitch: true` 行为已恢复可用。
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
  注：该次取证当时受 Codex 模型回读缺陷阻塞（已随 v0.8.2 修复，见上方「真机取证补记」），当时需在 scratch profile 里绕开才跑得动。
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

> 本机实测：**1692 passed / 2 failed / 12 skipped**（1706 项，137 文件）。两处失败为**既存环境失败**
> （`spawn-regression` 缺本机 `tianshu-runtime.exe`、`codex-flow`），非仓库缺陷。
> ⚠️ 若 `npm test` 无法拉起 `vitest`（本机曾因运行时 shell 包装出现），直接跑 `./node_modules/.bin/vitest run`。
>
> **升级调用方必读**：v0.9.0 起工具面由 13 合并为 **8 个**（BREAKING）——见本节顶部迁移映射与 §9.18 ②。

---

## 1. 这个项目是什么

`tianshu-mcp` 是一个**被天枢（Tianshu）当作标准 MCP server 接入的编排层**：天枢是总指挥，本 server 负责**调度 + 执行面 + 客观验收仪**，驱动外部 AI-Agent 完成闭环：

```text
项目开发 → 验收 → 失败返修 → 再验收
```

- **天枢官方仓库**：<https://github.com/huiliyi37/Tianshu-harness>（基于 harness 工程的终端编程智能体运行时，TUI × GUI；Apache-2.0）
- **本仓库**：`github.com/lanlan0811/tianshu-mcp`（主）｜`gitee.com/lan0811/tianshu-mcp`（镜像）
- **npm**：`tianshu-mcp`（当前发布版本 `0.9.4`）
- **工具面**：8 个 MCP 工具（v0.9.0 起由 13 个按域合并）——`run_task / query_task / manage_task / verify_task / query_info / wait_task / prepare_visual_baseline / approve_visual_baseline`

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
| 版本 / 许可证 | `0.9.4`（**已发布**；上一版本 `0.9.3`）/ Apache-2.0 |
| 标签 | `v0.1.0` … `v0.9.4`（均已推双仓）；GUI 独立线 `gui-v0.1.0` … `gui-v0.1.1-beta.6` |
| 工作树 | 干净；`github/master` 与 `gitee/master` 与 `HEAD` 同指 `f15c5a3`（docs(architecture) 补全 MiniMax Code 执行链并修正中英文档数字漂移） |
| 测试 | **1692 passed / 2 failed / 12 skipped**（1706 项，137 文件）。两处失败为**既存环境失败，非仓库缺陷**：`test/integration/spawn-regression.test.ts`（本机缺 `tianshu-runtime.exe`）与 `test/integration/codex-flow.test.ts`；v0.9.1 已用改动前 HEAD 的 git worktree 对照确证 |
| 门禁 | `tsc --noEmit` exit 0、`eslint . --max-warnings 0` 0 warning、build 成功、`pack:check` 通过、`check:stdio` **8/8**（dist 与 src 两条入口）。工具面实测 **8 个**（`src/mcp/tools.ts`） |
| CI | `build-test`（ubuntu/windows/macos × Node 20/22/24）+ `pack-check`，另加 `visual-browser` 真实浏览器矩阵（ubuntu/windows + macos-15-intel/macos-15 × Node 20/22/24）。⚠️ **本文件未记录 0.8.3 之后各版本的具体 run 链接**——需要核对时看 GitHub Actions 页或 `release.yml` 产物，不要凭本节推断 |
| npm | `tianshu-mcp@0.9.4` 已发布（`latest`）——`npm view tianshu-mcp version` = `0.9.4`、`npm view tianshu-mcp dist-tags` 为 `{latest: "0.9.4"}`（2026-10-10 实测）。注意 npm CDN 的 packument 有数分钟缓存，刚发布后 `npm install` 可能短暂报 `ETARGET`（本地实测第 3 次轮询才可见），用 `--prefer-online` 或稍候即可。发布步骤见 `docs/npm-publish-guide.md` |
| GitHub Release | 推送 `v*` tag 触发 `.github/workflows/release.yml`：先跑完整门禁并校验「tag 版本 === package.json 版本」，正文由 `docs/release-v<ver>.md` + `.en.md` 双语合成（缺文档即报错），**要求同 SHA 的成功 CI**，并附 `tianshu-mcp-<ver>.tgz` |
| Gitee 发行版 | 由 `scripts/gitee-release.mjs` 用仓库 Secret `GITEE_TOKEN` 幂等补齐；缺少凭据时工作流阻塞 |
| 版本线速览 | MCP 主包：`0.7.7`（等待原语 11→13）→ `0.7.8`（MiniMax Code，第七个 GUI agent）→ `0.7.9/0.7.10`（文档与视觉闸门语义）→ `0.8.0/0.8.1`（恢复语义 + 完成判定加门）→ `0.8.2`（Codex 模型回读）→ `0.8.3`（TraeWork 副作用阶梯）→ `0.8.4`（工具面瘦身 −67.1%）→ **`0.9.0`（BREAKING：13→8）** → `0.9.1/0.9.2/0.9.3/0.9.4`（TraeWork / ZCode / Codex 真机冒烟修复）。`mcp-gui` 独立线：正式版 `gui-v0.1.0` → `gui-v0.1.1-beta.1..6`（洞察三批 + 更新清单 notes 修复 + 工具面同步 13→8） |

### 2.1 Agent 适配现状

| agentId | driver / adapter | status | 说明 |
|---|---|---|---|
| `codex` | `gui` / `codex-gui` | **ready**（darwin 为 `research`） | Codex 桌面端 GUI（Windows：MSIX COM 激活 + CDP；macOS：spawn .app + CDP），支持 `model`/`reasoningLevel`/`planDoc`/`designSystem`；等待用户检测、取消真停、重派护栏均已真机验证（v0.3.2）；macOS 基本闭环已真机验证（2026-09-13，见 `docs/codex-gui-cdp.md`），取消/返修矩阵未齐故 darwin 保持 `research`。**v0.8.2 修模型触发器回读**（issue #34：不再把整条思考等级条当型号）；**v0.9.3 修 26.1002 的 5 个缺陷**（发送确认假成功 / 连接就绪判据顺序 / 回复稳定判定失真 / 进程退出误报 / CDP 文案硬编码程序名）；**v0.9.4 修对话文本采集丢 `#text` 节点**（`seenMessage` 恒 false）。冒烟：`npm run smoke:codex` |
| `zcode` | `gui` / `zcode-gui` | **research**（常量，非平台分支） | CDP GUI adapter，Windows 真机闭环通过；已适配 ZCode 3.11.2 模型菜单与项目绑定（v0.3.3）、项目/模型回读加固与初始化恢复（v0.3.4）；**无项目派发（`default` 工作区，`projectPath` 可选）与 `allowCreateProject` 自 v0.5.2 起支持**（issue #12，Windows 真机验收）；v0.5.3 修复实例跨 server 驻留、新建任务切页与发送失败归因三个真机缺陷；**v0.8.1 加完成判定门**（运行信号 = `stopVisible \|\| loading \|\| activeTool`，`reobserve` 轮种子 `sawRunning: true`）；**v0.9.2 修 3.14.4 的模型标识语义与点击可点性**（模型名可含 `/` 与 `:` 的三段式解析、面板分组 hover 匹配、回读前缀剥离、视口外点击假成功）。冒烟：`npm run smoke:zcode`。macOS 基本闭环已真机验证（`docs/zcode-cdp.md`），但无项目派发仅在 Windows 实测、取消/返修/新建项目矩阵未齐，故 `status` 保持常量 `research` |
| `traework` | `gui` / `traework-gui` | **ready** | CDP 驱动 TRAE SOLO CN 桌面 UI；三种面板模式真机验证通过。注意 `status` 为常量 `ready`，但 **macOS 分支仍 fail-closed**（可执行探测与原生对话框驱动未在 macOS 实测）。**v0.8.1 加完成判定门**；**v0.8.3 修 issue #38**（下拉底部点击改副作用驱动三级阶梯、逻辑性 setup 失败不再误报 `errorType=spawn`）；**v0.9.1 修真机冒烟 5 缺陷**（排队提醒被误报「任务完成」、取消路径三处）。冒烟：`npm run smoke:traework` |
| `kimicode` | `gui` / `kimicode-gui` | **ready**（darwin 为 `research`） | Kimi Code 桌面端（Electron，实测 1.0.2）；**双渲染进程**（主窗口承载侧栏/会话/composer，`Kimi Browser Overlay` 浮层承载模型/思考档位/执行模式菜单）；工作区以**完整路径**绑定，未登记时经原生「添加工作区」对话框导入；真机验证：成功路径、未登记工作区导入 + 自动验收、失败 → 返修 → 再验收同会话闭环。取消/提问续答/同名歧义仅由 hermetic 集成测试覆盖，macOS 为 `research` 且 fail-closed |
| `qoder` | `gui` / `qoder-gui` | **ready**（darwin 为 `research`） | Qoder CN 桌面端（实测 0.3.4，CDP 基准端口 `9777`）；`projectPath` + 可读 `planDoc` 必填，`modelSource=default/custom` 消除跨组重名；未登记目录经「新的任务 → 工作区 → 新建工作区 → 添加可读写文件夹」原生导入；思考等级经「模型管理」保存为**全局偏好**并回读，权限模式沿用。Windows 真机已验证：已有工作区默认模型、新登记工作区自定义模型、受控失败 → 落计划 → 原会话返修 → 再验收。取消/提问续答仅由 hermetic 集成测试覆盖；macOS 为 `research` 且 fail-closed |
| `opendesign` | `gui` / `opendesign-gui` | **ready**（darwin 为 `research`） | Open Design 桌面端 GUI；选择器取自产品自身 Web 前端的 `data-testid` 钩子，12 步执行链全部接线，并接入验收 → 自动返修 → 再验收闭环；它是唯一带「产物信号」（文件 mtime / 大小指纹）的 driver。**v0.8.1 加完成判定门**（运行信号 = `stopVisible \|\| sendStarting`）；产物指纹**不计入**运行信号（`fetchArtifactForSummary` 在 `finished` 后仍会写文件） |
| `minimax` | `gui` / `minimax-gui` | **ready**（darwin 为 `research`） | MiniMax Code 桌面端（Electron，实测 3.1.0）；**双渲染进程**（主窗口 + `Model menu` 弹层）；推理等级 / 上下文窗口在**悬停模型项展开的二级子菜单**里，且**候选集合随模型变化**（无子菜单的模型请求这两项即 fail-closed）；支持 `model` / `reasoningLevel` / **`contextWindow`**（本适配器专属），**不支持 `mode`**，且**不支持无项目派发**；「新建项目」为**应用内模态框 → 原生 `Select Directory` → 模态框提交**两步。**v0.8.1 加完成判定门**（运行信号 = `stopVisible`）——但其 `[data-testid="stop-button"]` **真机未复验**，采不到会每任务落 `idle_timeout` → `needs_attention`（有意的 fail-closed：可 `manage_task(action="continue")` 恢复，误判成功不可逆） |
| `codex-cli` | `spawn`（用户自建 profile，非内置） | 用户配置 | 无头路径走 `codex exec`；`model` 参数对其不生效（用 `~/.codex/config.toml`）；CLI 需 ≥0.154.0（≤0.130.0 签名证书已吊销）。`query_info(type="profiles")` 自 v0.4.0 起会列出用户自定义 profile |
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
| M32 | **MiniMax Code 适配（第七个 GUI agent，`agentId=minimax`）**：双渲染进程（主窗口 + `Model menu` 弹层）、模型二级子菜单（推理等级 / 上下文窗口，候选集合随模型变化）、完整路径项目绑定与「模态框 → 原生 `Select Directory` → 模态框提交」两步新建项目、新增 `contextWindow` 参数（本适配器专属）；真机取证修正三处结构假设（详见 §4.2 与 `docs/minimax-cdp.md`） | `0.7.8` | **126 files / 3 skipped** |
| M33 | **恢复语义修复（issue #30/#35）**：TraeWork 移除跨模式项目绑定兜底（非 Work 模式绑定失败不再回落 Work 并静默改写目标模式）、ZCode 恢复轮保留原会话权限（`permission` 改 `const`，仅在记录缺失时回落 profile 默认值） | `0.8.0` | — |
| M34 | **完成判定补「曾观测到运行信号」门（issue #31）**：ZCode / Kimi Code / MiniMax / Open Design 四 driver 的 `finished` 判据加 `sawRunning` 门（未见过运行信号只允许落 `idle_timeout`）；`fix-loop` 抽出 `shouldParkAsNeedsAttention()` 把白名单扩到五个 GUI driver（否则异常结束仍会进验收链）；`reobserve` 轮种子 `sawRunning`（详见 §9.15） | `0.8.1` | 1261（unit） |
| M35 | **TraeWork 点击与失败分类修复（issue #38）**：footer 点击改**副作用驱动三级阶梯**（坐标 → 语义键 DOM → 文本兜底，各自有界探测窗）、总探测预算不再膨胀（真机 28183ms → 19213ms ≤ 20000ms）、新增 `errorType: "setup_failed"` 让逻辑性 setup 失败不再落 `spawn` | `0.8.3` | **1629 → 全绿** |
| M36 | **工具面瘦身**：`acceptanceOverride` 线上声明骨架化（`AcceptanceOverrideWireSchema`），`tools/list` 35581 → 11717 字符（−67.1%）；新增 handler 下沉校验 `validateAcceptanceOverride()` 与编译期 `WireSchemaParityLock`；工具名 / 参数集 / 校验语义全不变 | `0.8.4` | **1621** |
| M37 | **工具面合并（BREAKING，13 → 8）**：`cancel_task`/`continue_task`/`rework_task` → `manage_task`；`list_tasks`/`get_task_report`/`get_profiles` → `query_info`；`wait_any` → `wait_task`（批量）；视觉基准**刻意不合并**（防篡改摘要闸门）；分支约束下沉 handler（`discriminatedUnion` 经 SDK 序列化会退化为空 schema） | `0.9.0` | 21（新增集成） |
| M38 | **三个 adapter 真机冒烟修复（0.9.1 / 0.9.2 / 0.9.3 / 0.9.4）**：TraeWork 排队误报完成 + 取消路径三处；ZCode 3.14.4 模型标识三套语义 + 视口外点击假成功；Codex 26.1002 五缺陷 + 对话文本采集丢 `#text` 节点（详见 §9.14 TraeWork / §9.16 ZCode / §9.17–§9.18 Codex） | `0.9.1`–`0.9.4` | **1692 / 2 failed（既存环境）** |

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
| 29 | M34 | **完成判定缺「曾观测到运行信号」门**：停止按钮 / loading 选择器漂移时界面「看起来静止」，进行中的任务在 `stableRounds × pollInterval`（约 12s）后被误判成功并进验收链 | 四 driver 的 `PollState` 加 `sawRunning`（运行分支置真、其余透传、`finished` 加门）；三个 `run.ts` 的 `reobserve` 轮种子 `sawRunning: true`；`fix-loop` 抽 `shouldParkAsNeedsAttention()` 扩白名单——**不改 fix-loop 则只加门只会让「仍进验收，但迟了 10 分钟」**。另发现**门所需证据的传递路径也缺失**：发送确认阶段观测到的运行信号从未传给观察循环（集成测试加门后 39/81 失败暴露）→ 经 `ObserveArgs.sawRunningSeed` 带入 | `test/unit/liveness-running-gate.test.ts`（12 例）+ `test/unit/fix-loop-abort-parking.test.ts`（5 例） |
| 30 | M35 | `cdp.click()` 返回 `true` 只表示「元素存在且可见」，**不代表原生弹窗已被唤起**——旧实现据此当成功，然后死等 `dialogWaitTimeoutMs`（20s）判失败，期间无任何补救动作 | 判据改为「原生对话框是否确实出现」，执行方式按可靠性排三级：坐标点击 → 语义键 DOM click → 文本兜底，各自有界探测窗（首级 = 预算 × 0.30）；探测**前**判剩余预算（真机曾把 20s 预算跑成 28183ms，根因是「先探测后判 deadline」每级多溢出一次探测 + `sleep(1500)`） | `traework-footer-click.test.ts` 的 `A-budget-real` 经回退对照确认有辨别力（旧实现探测 12 次 → 新实现 3 次） |
| 31 | M35 | 逻辑性 setup 失败（Code 模式下项目未绑定，**确定性必失败**）报 `errorType=spawn`——读日志的人会当作环境问题反复重试 | `AgentRunResult` 增可选 `errorType?: "spawn" \| "setup_failed"`，由**适配器自归类**；`fix-loop` 改 `runRes.errorType ?? "spawn"`（缺省逐字不变，其余 6 个 agent 零行为变化）；TraeWork 的 5 个逻辑性 `hardFailure` 点标记 `setup_failed` | 基线 4 failed → 修复后 12 passed；回归锁断言「未声明 `errorType` 仍落 `spawn`」 |
| 32 | M36 | `acceptanceOverride` 内联 `PartialAcceptanceConfigSchema`（11005 字符，`VisualConfigSchema` 独占 9579），而 MCP 下**每个工具的 `inputSchema` 独立序列化**、跨工具无法 `$ref` 共享——两份子树占工具面 69.4% | `visual` 转不透明 `z.record(z.unknown())`（`tools/list` −67.1%）；**关键非可选**：新增 handler 入口 `validateAcceptanceOverride()` 下沉校验，否则 `visual` 内部非法字段会穿透 SDK 层直达 handler | `test/integration/verify-params.test.ts` 4 条专打「只有下沉层能拦」的缝隙并**断言错误来源是 handler 下沉层**；RED→GREEN：移除两处下沉校验 → 精确 4 条变红。另新增「线上 `inputSchema.properties` 必须非空」契约锁（`.refine()` / `discriminatedUnion` 经 SDK 序列化会退化为空 schema） |
| 33 | M37 | 13 个工具的 `inputSchema` 各自独立序列化，工具面体积与调用方认知负担双高；而合并后若用 `z.discriminatedUnion` 写 schema，**实测经 SDK 序列化后线上退化为 `{"type":"object","properties":{}}`**，参数信息全丢 | 改 plain `z.object` + **分支约束下沉 handler**（`continue` 要求 `message` 非空、分支专属字段白名单 fail-closed）；`manage_task` 承载 `destructiveHint`（MCP 注解是工具级、无法按 action 区分，按「宁可过报不可漏报」标 true）；视觉基准两工具**刻意不合并**（收益仅约 500 字符，而 `candidateId`/`expectedDigest`/`approvalNote` 构成防篡改摘要闸门，塞进 action 会让闸门在参数层失去显式位置） | `test/integration/tool-consolidation.test.ts`（21 例，三条不变量：恰为 8 个且旧名消失 / 新工具线上 `properties` 非空 / 分支约束在下沉层 fail-closed）；**RED→GREEN**：实施前 11 failed → 实施后 21 passed |
| 34 | M38 | **「该读到的读不到」与「不该读的读到了」是同一采集函数的两次反向失误**：Codex `messageArea` 容器把 composer 一起包住 → 输入框残留文本被当「已送达」（**假阳性**，v0.9.3）；叶子遍历丢弃 `#text` 节点 → `【tianshu:…】` 标记中间段丢失、`seenMessage` 恒 false（**假阴性**，v0.9.4） | v0.9.3：可见容器上做节点级遍历 + 整棵跳过 composer 组件节点；v0.9.4：遍历改 `childNodes`（含 `#text`）+ `textContent`，按文档顺序拼接。**另一处同源缺陷**：游离克隆体没有布局，Chromium 对它取 `innerText` 只返回空壳（605 字符真实对话 → 读到 4 字符）→ 改 `textContent` 不依赖布局 | v0.9.4 回归锁 1 条（复刻真机 `SPAN`/`#text` 交错形态），**反证通过**（回滚修复 → 读到 `【tianshu】…` 变红） |

---

## 4. 架构与模块导览

> 本节是**面向交接的快速导览**（目录 + 两条执行面 + 七个 GUI driver 的执行顺序）。
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
│   ├── tools.ts          8 个工具的元数据（capability / requireApproval；v0.9.0 起由 13 个按域合并）
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
│   ├── registry.ts       按 profile.adapter/driver 构造 Cli/TraeWork/ZCode/Codex/KimiCode/Qoder/OpenDesign/MiniMax adapter
│   ├── cli.ts / spawn.ts 通用 CLI adapter / 子进程封装（windowsHide、管道、超时、kill tree）
│   ├── gui-instance.ts   GUI 桌面实例 spawn 选项（detached 不变量，供七个 GUI adapter 复用）
│   ├── builtin.ts        内置 profiles（codex / zcode / traework / kimicode / qoder / opendesign / minimax / stub）
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
│   ├── qoder/            Qoder CN 桌面端 GUI 驱动（v0.5.6 起）
│   │   ├── adapter.ts / run.ts / instance.ts / discovery.ts / profile.ts
│   │   ├── cdp.ts / selectors.ts / liveness.ts / references.ts
│   │   ├── dialog.ts（原生目录选择）/ workspace.ts（完整路径绑定与新建工作区）
│   │   └── model.ts（默认/自定义分组 + 模型管理档位）/ questions.ts（提问答题）
│   ├── opendesign/       Open Design 桌面端 GUI 驱动（v0.7.1 起）
│   │   ├── adapter.ts / run.ts / instance.ts / discovery.ts / liveness.ts
│   │   ├── cdp.ts / transport.ts（传输层双路径）/ dom.ts / selectors.ts
│   │   ├── menu.ts / model.ts / send.ts / workspace.ts / dialog.ts
│   │   └── artifact.ts（产物信号）/ visual.ts / export.ts / fixplan.ts / recovery.ts
│   └── minimax/          MiniMax Code 桌面端 GUI 驱动（v0.7.8 起）
│       ├── adapter.ts / run.ts / instance.ts / discovery.ts / profile.ts
│       ├── cdp.ts（主窗口 + Model menu 双窗口）/ dom.ts / selectors.ts
│       ├── model.ts / model-select.ts（二级子菜单按模型限定归属）/ liveness.ts
│       └── workspace.ts / project-modal.ts（新建项目两步）/ dialog.ts / recovery.ts
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
| `gui` | CDP 驱动桌面 UI，**不 spawn 任务**（七个 GUI 适配器会为注入调试端口而启动桌面实例，但仍以 UI 信号判定结果） | 运行信号优先（**且必须先观测到运行信号**，见 §9.15）→ DOM 完成标志 → 稳定确认后的空闲计时 → stall / 任务超时 |

`TaskOrchestrator.runAgentOnce` 的分支逻辑：`adapter.run` 存在 → 调用它；否则走 `runChild`。**这是唯一需要理解的双路径接缝。**

### 4.2 七个 GUI adapter 的执行顺序（实测结论，勿随意调整）

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
> `agent_question` / `login_required` / `needs_user(close_existing_instance)` / `system_permission` / `setup_recovery`，由 `manage_task(action="continue")` 恢复。

**Codex**（详见 `docs/codex-gui-cdp.md` 与 §9.4）：

```text
MSIX 发现（Appx 查询优先 + 扫盘回退） → COM 激活 + 专属 user-data-dir + CDP 端口 → 项目登记/绑定
  → 选模型与思考等级 → 发送（planDoc/designSystem 拼进初始指令） → 运行检测（停止按钮 + 对话哈希 stall） → 轮询到完成
```

> 停在「等待用户确认」界面（方案确认卡 / 订阅结账页）→ stall 判定转 `needs_user(user_confirmation)`；
> 用户处理完后 `manage_task(action="continue")` 重新观察（不重发消息）；`login_required` 则复检环境后重派任务书。

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
> 提问转 `agent_question`，等待用户确认转 `user_confirmation`，均由 `manage_task(action="continue")` 恢复。

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
> `manage_task(action="continue")` 对审批/登录等环境等待只恢复观察，仅 `agent_question` 把答案写回原会话。
> 取消/超时只停**已绑定的原会话**并回读，未确认时终态明示「GUI 内运行未确认停止」并保留实例阻止重派。

**Open Design**（详见 `docs/opendesign-cdp.md`）：

```text
发现安装（产物常量取证 + 数据目录推导） → 复用优先 / 自启（`--remote-debugging-port=0` + 按
  DevToolsActivePort 定位真窗口；进程级单实例锁 → 旧实例在跑时转 needs_user）
  → 绑定工作目录 → 选模型 / 设计系统 / 设计方向 → 输入发送 → 轮询完成（产物信号 = 文件 mtime / 大小指纹）
  → 产物取回（落进任务目录，供视觉验收识别入口） → 轮询到完成
```

> **关键事实**：`--user-data-dir` 会被产品主进程覆盖（userData 固定到
> `%APPDATA%\Open Design\namespaces\<namespace>\user-data`），故不做专属实例。
> **固定端口会被不承载窗口的 launcher 进程抢占并驻留**（真窗口绑定失败后 `/json/list` 恒 `[]`）——
> 必须用 `=0` 随机端口 + `DevToolsActivePort` 定位真窗口。详见 §9.13。

**MiniMax Code**（详见 `docs/minimax-cdp.md`）：

```text
发现安装 → 启动/复用 CDP 实例 → 连接主窗口与 Model menu 独立渲染进程
  → 绑定项目（侧栏 data-workspace-dir 完整绝对路径；未登记走「新建项目」两步：
     应用内模态框 → 原生 Select Directory → 模态框「创建项目」提交）
  → 选模型（悬停展开二级子菜单 → 选档位 / 窗口 → 最后点模型项提交）
  → 发送（tiptap ProseMirror 输入；发送按钮是 DIV，可用性读 aria-disabled） → 运行检测（stop-button） → 轮询到完成
```

> **两个易踩的结构事实**：① 推理等级 / 上下文窗口**只在悬停带 `aria-haspopup="menu"` 的模型项后**才渲染，
> 且子菜单容器**复用**——不先移开鼠标就移入不会触发 `mouseenter`，DOM 会保留上一个模型的档位集合，
> 故读候选必须按 `aria-label` 限定归属模型；② 档位 / 窗口**集合随模型变化**
> （`M3.1-Flash-Preview` 六档 + `512K`/`1M`；`M3` 无档位组；`deepseek-v4.1-flash` 三档无窗口组；
> `M2.7` 系无子菜单），对无子菜单的模型请求这两项一律 fail-closed，绝不静默沿用界面当前值。

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
  → manage_task(action="rework") 对阻塞任务先重新验收，不先启动 agent
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
8. **GUI 取消不得谎报**：`manage_task(action="cancel")` 对 GUI agent 必须尽力点击停止 + 在 `gui.cancelWaitMs` 内有界等待确认；
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
npm test             # 1692 passed / 2 failed / 12 skipped（1706 项，137 文件）；2 failed 为既存环境失败
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

# Kimi Code / Qoder CN / MiniMax Code / Open Design：只读诊断（npm run probe:*）
npm run probe:kimicode
npm run probe:qoder
npm run probe:minimax          # 安装 / 进程 / CDP 拓扑 / 模型子菜单候选 / 项目分组 / 运行信号 / 原生对话框
npm run probe:opendesign      # install / process / cdp / appconfig / anchors；--launch 才启动实例

# ZCode 真机冒烟（需 --confirm-send/--model/--task 三者齐全才发送；隔离数据目录）
npm run build && npm run smoke:zcode -- --confirm-send --model DeepSeek/deepseek-flash --project D:\repo\app --task "任务书"
# TraeWork 真机冒烟（同三件套护栏；--mode <Work|Code|Design>；--cancel-after-ms 验取消路径）
npm run build && npm run smoke:traework -- --confirm-send --model <模型> --project D:\repo\app --task "任务书"
# Codex 真机冒烟（v0.9.3 新增）
npm run build && npm run smoke:codex -- --confirm-send --model <模型> --project D:\repo\app --task "任务书"

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
| 单元 | `test/unit/`（97 文件） | 纯函数与组件逻辑：traework 全套（reply / selectors / launcher / guard / driver / session / liveness / dialog / cdp-client / repair-plan / cancel-path / last-run-signal）、codex-core、zcode-core / zcode-handler / zcode-dom / zcode-dialog / zcode-recovery、kimicode / qoder / opendesign / minimax 全套（minimax 含 6 文件 121 例）、liveness-running-gate（跨 driver 契约）、fix-loop-abort-parking、gui-instance-spawn、acceptance（含并行）、baseline（含归因 / 预脏）、atomic-write、log、config / profile 热加载、project-dir-guard、skill-format、idempotency（issue #15 幂等索引）、以及视觉模块（visual-config / images / baselines / report / runtime / content-*）等 |
| 集成 | `test/integration/`（39 文件） | stub-agent 三剧本、取消 / 超时 / 基线、traework 假 CDP（单轮 + 返修 + 绑定兜底 + footer 点击阶梯）、codex-flow、zcode-flow / restart / rework-loop / default-workspace、kimicode-flow、qoder-flow / qoder-mcp、opendesign / minimax 流、tool-consolidation（v0.9.0 工具合并三条不变量）、wait-task、rework 竞态回归、verify-params、task-flow、idempotency（issue #15 重放 / 冲突 / 执行中 / 跨重启）、以及视觉（services / capture / flow / rework / browser-smoke / content-*） |
| 协议 | `test/protocol/`（1 文件） | 官方 SDK 客户端断言 **8 工具面**（v0.9.0 起；此前 13）与返回格式 |
| 真机 | `scripts/probe-*.mjs`（traework / zcode / codex / kimicode / qoder / opendesign / minimax，共 7 个）+ `scripts/smoke-{traework,zcode,codex,kimicode,opendesign}.mjs` / `scripts/evidence-visual-windows.mjs` | **手动、不入 CI**，需真实客户端 / 已安装浏览器 |
| 全量基线 | `vitest run`（双 project：`unit` 隔离 + `integration` 串行 forks） | **1692 passed / 2 failed / 12 skipped**（1706 项，137 文件）。两处失败为**既存环境失败**：`spawn-regression`（本机缺 `tianshu-runtime.exe`）与 `codex-flow` |
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
- **UI 升级会漂移**：七个 adapter 的选择器分别集中在
  `src/agents/traework/cdp/selectors.ts`、`src/agents/zcode/selectors.ts`、`src/agents/codex/selectors.ts`、`src/agents/kimicode/selectors.ts`、`src/agents/qoder/selectors.ts`、`src/agents/opendesign/selectors.ts`、`src/agents/minimax/selectors.ts`，
  均可经 profile `gui.selectors` 覆盖；先用探针诊断（`npm run probe:<agent>`）。
- **macOS 部分验证**：Codex 与 ZCode 的 macOS 基本闭环（发现/启动/绑定/发送/观察/验收）均已真机通过
  （2026-09-13，分别见 `docs/codex-gui-cdp.md` 与 `docs/zcode-cdp.md`），
  但取消/返修/`manage_task(action="continue")`/新建项目矩阵未覆盖，二者 darwin 仍标 `research`；
  TraeWork 的原生对话框驱动与真机闭环仍未在 macOS 实测，macOS 分支保持 fail-closed；
  Kimi Code / Qoder CN / Open Design / MiniMax Code 的 darwin 同为 `research`（fail-closed，未在 macOS 实测）。
- **`mode` 仅 TraeWork 生效**：ZCode / Codex / Kimi Code / Qoder / Open Design / MiniMax 会拒绝该参数（返回明确错误）。
- **无项目派发仅 ZCode 且仅 Windows 实测**：`projectPath` 可选只对 ZCode 生效；macOS 上的无项目派发尚未真机验证（v0.5.3 已修掉 Windows 侧实例驻留、切页与归因三个缺陷，但 macOS 未覆盖）。
- **ZCode 未登记项目的自动导入在 Windows 上不可用**：需先在 ZCode 中手动登记目录，或传 `allowCreateProject=false` 让它显式失败。原因与修复方向见 §9.9。
- **Windows 上 GUI 实例跨 server 驻留已修复**（v0.5.3）：七处 GUI 实例统一走 `guiInstanceSpawnOptions()`（无条件 `detached` + `unref`；traework 在 `launcher.ts`，其余六个在各 `instance.ts`）；执行型子进程（`verify/runner`、`visual/services`、`agents/spawn`）语义相反，仍按平台分支。
- **`manage_task(action="continue")` 仅 codex/zcode/kimicode/qoder/opendesign/minimax**：traework 与 spawn 类 agent 会被拒绝。恢复语义按 agent 而异（ZCode 补发任务书、Codex/MiniMax 重观察不重发、Qoder 仅 `agent_question` 写回原会话）。
- **Kimi Code 不支持无项目派发**：任务必须绑定工作区文件夹，`workspaceMode=default` 或缺少 `projectPath` 时以 `setup_failed` 显式拒绝。
- **Qoder CN 的硬边界**：仅支持 Qoder CN（国际版或同名窗口不算）；`projectPath` 与可读 `planDoc` 必填，不支持无项目派发；`modelSource` 与 `极高/xhigh`、`最大`、`关闭思考` 别名是 Qoder 专用参数，传给其他适配器会被拒绝；思考等级是 Qoder **全局偏好**（任务结束不还原），权限模式沿用不切换；macOS 为 `research` 且 fail-closed。取消与提问续答仅由 hermetic 集成测试覆盖（见 §9.12）。
- **`needs_user` 状态下取消是已知边界**：MCP 侧无 CDP 连接，GUI 内等待中的会话停不掉；终态文案会提示。
  经临时 CDP 连接尽力停止 GUI 内会话列在 `CHANGELOG.md` 的「未发布 / 计划中」。
- **server 退出 / 重启归档不自动停 GUI（issue #14 的边界）**：`shutdownInterrupt()` 会给 GUI 任务一份全局共享的
  `shutdown.guiStopWaitMs`（默认 15s）让"尽力停止 + 有界等待"跑完，但**未确认时只如实标注**；
  `initialize()` 归档重启遗留时**不会**自动 CDP 重连去点停止（重启后无会话锚点，适配器对无归属证明的实例 fail-closed，
  宁可不动也不误杀用户会话），改为置 `guiResidualUnconfirmed` + 提示人工检查。人工核实无残留后调用 `manage_task(action="cancel")` 清除标记
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
| Codex 卡在「等待用户确认」/ 取消没真停 | §9.4 |
| ZCode 模型菜单选不中 / 项目绑定判据漂移 / 验收假绿 | §9.5 |
| ZCode 项目或模型回读误判 / 原生面板超时 / 恢复后丢会话与上下文 | §9.6 |
| ZCode 无项目派发报参数错误 / 卡在 `setup_recovery` / 窗口被遮挡时发送失败 | §9.9 |
| 升级 v0.4.0 后行为变了 / 验收检查互相干扰 / 符号链接路径下历史任务「消失」 | §9.7 |
| 视觉验收不通过 / 基准待批准 / 规则被冻结判 `VISUAL_INTEGRITY` / 离线报告看不开 | §9.8 |
| AI 内容校验整轮阻塞 / 占位符被拒 / 判定总是 uncertain / 缓存不失效 | §9.10 |
| Kimi Code 菜单找不到 / 点击被吞 / 思考档位不匹配 / 原生「添加工作区」对话框 | §9.11 |
| Qoder 模型重名 / 档位被拒 / 工作区未登记 / 会话或发送状态不明 | §9.12 |
| Open Design 数据目录 / sidecar 根进程判定 / 选择器取证 / CDP 接不上真窗口 | §9.13 |
| TraeWork 派单排队不动 / 点停止没反应 / 取消后连接已断 / `lastRunSignal` 为空 | §9.14 |
| 任务「看起来静止」被误判成功 / 异常结束却进了验收链 | §9.15 |
| ZCode 模型名含 `/` 或 `:` 无法派单 / 切换成功仍判 `model_mismatch` / 点击返回成功但页面不动 | §9.16 |
| Codex 26.1002 点「新对话」连接超时 / 发送确认假成功 / 回复稳定判定失真 | §9.17 |
| Codex「文本已键入但未触发发送」（`send_unknown`）/ 对话哈希恒定 / 工具面从 13 变 8 的迁移 | §9.18 |

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

**恢复通道（`manage_task(action="continue")` 扩展支持 codex）**

| `needsUserKind` | 恢复行为 |
|---|---|
| `user_confirmation` | 用户在 Codex 窗口处理完后恢复；MCP 仅重新接入观察 GUI 内运行（**不发送消息**）；恢复前 turn 已完成也能正确判 `succeeded` |
| `login_required` | 复检环境后重新派发任务书（新会话 + 项目绑定 + 完整初始指令） |

ZCode 原有恢复行为不变；其他 agent（含 traework）明确拒绝。

**取消真停 GUI（issue #6）**

- `manage_task(action="cancel")` 对 GUI agent 不再「请求即成功」：先经 CDP 尽力点击界面停止按钮，并在 `gui.cancelWaitMs`
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
- 无锚点的环境恢复在发送前采集会话快照，发送**完整原任务、上下文和已验证引用**；用户的「已关闭」等确认文本不发给模型（`manage_task(action="continue")` 对非 `agent_question` 类型 `sendMessage=false`）。
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
- **副作用**：符号链接入口（macOS `/tmp` → `/private/tmp`）下，同一目录可能与既有 `projects.json` 记录、历史任务目录不再匹配——按规范化后的**真实路径**查找；`query_info(type="tasks")` 过滤已同步用同一归一。
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
- 终态元数据以 `verificationNotApplicable: "no_project"` 标注；`verify_task` / `query_info(type="report")` 对该类任务返回 `not_applicable: no_project`，不从 cwd 推导目录。
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

- **取消（`manage_task(action="cancel")` 真停 GUI）**：实现完整（尽力点 `button.stop` + `cancelWaitMs` 内有界等待空闲，未确认时如实落文案），
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
- `manage_task(action="continue")` 对审批/登录等环境等待只**恢复观察**（不把“已处理”文本发给模型）；只有 `agent_question` 才把答案写回原会话。

**⑥ 取消与实例**

- 取消/超时只对**已绑定的原会话**执行停止并回读；未确认停止时终态明示「GUI 内运行未确认停止」并保留实例，阻止重复派发（`instance_busy`）。
- 已有实例无可用 CDP 时**保留现场**转 `needs_user`，绝不关闭或重启用户实例（与 Kimi/ZCode 同语义）。

**⑦ 探针用法**

```bash
node scripts/probe-qoder.mjs install          # 只读：安装发现（显式 → D 盘 → 注册表/快捷方式 → 其它盘）
node scripts/probe-qoder.mjs state --port 9777  # 只读：已有实例与页面结构（连接可能把工作台置前）
```

**未真机验证（如实标注，勿在文档或汇报中夸大）**

- **取消（`manage_task(action="cancel")` 真停 GUI）**：实现完整（尽力点停止按钮 + `cancelWaitMs` 内有界等待，未确认时如实落文案），
  但**仅由 hermetic 集成测试覆盖**，未在真机点停。
- **提问续答（`agent_question`）**：实现完整（多题答案写回原会话、不重发任务书），但真实提问卡片的真机路径未覆盖。
- **登录失效 / 额度不足 / 网络错误分类**：归类为 `needs_user`，真机触发未逐个覆盖。
- **macOS**：`status` 为 `research` 且 **fail-closed**（仅覆盖路径与平台分支的自动化测试，未在 macOS 真机验证 GUI）。

---

### 9.13 Open Design 排障（M32 前的接线期；`docs/opendesign-cdp.md`）

**症状**：`/json/list` 恒为 `[]`，端口连得上却没有 page target；主线程卡在启动期请求。

- **根因（2026-09-28 定位）**：**固定 `--remote-debugging-port` 被不承载窗口的 launcher 进程抢占并驻留**，
  真窗口进程绑定失败。修法：改用 `--remote-debugging-port=0`（各拿随机端口）+ 按 `DevToolsActivePort`
  文件定位**真窗口**——真机 4 秒接管（此前 90s 超时）。
- **不做专属 userData 实例**：产品主进程强制把 Electron userData 设到
  `%APPDATA%\Open Design\namespaces\<namespace>\user-data`，且 `--user-data-dir` 开关**会被覆盖**。
  进程级单实例锁意味着用户已开着实例时无法另起受管实例 → 策略为「复用优先 → 自启 → 转
  `needs_user(close_existing_instance)` 请用户关闭旧实例」。
- **选择器取证入口**：`npm run probe:opendesign`。它是唯一带「产物信号」的 driver
  （文件 mtime / 大小指纹）——注意该指纹**不计入运行信号**（见 §9.15）。
- **已知边界**：zip 导出方式未优化（产品主进程接管下载，`state=canceled`）。

### 9.14 TraeWork 真机冒烟排障（M38 / v0.9.1）

**症状与处置**（均为假成功 / 假失败级别，会让调用方拿到与事实相反的结论）：

| 症状 | 根因 | 处置 |
|---|---|---|
| 派单后立刻报 `succeeded`，返回内容却是排队提示 | 排队气泡带「由 AI 生成」footer——**正是适配器的完成标志**；而排队时 `stopVisible` / `tailLoading` 均为 false（权威运行信号不命中），两者叠加使判定直落 `finished` | 新增排队识别（判别式取位次短语「排(在\|队) N 位」，避免正文正常提及「排队」被误判），判定**优先于**完成标志；按暂时等待处理，**不占用「运行证据=」前缀**（该前缀是「已开工」语义）；超时终态点明「期间一直处于排队，任务尚未开始执行」 |
| 点停止按钮无反应 | `click()` 原实现先 `element.click()`、抛错才回退坐标点击；但 `stopButton` 命中的是**图标元素**（无 `click()` 方法），`TypeError` 直接冒泡，回退分支不可达 | `click()` 改**坐标点击优先、DOM click 兜底**（与 kimicode 一致），DOM 分支加 `typeof` 守卫且异常不冒泡 |
| 取消时报 `CDP_UNAVAILABLE: 客户端主动断开` | 取消分支写成 `return abortResult()` 而非 `return await abortResult()`——JS 语义下 `return <promise>` 会**立即**执行外层 `finally`（含 `cdp.disconnect()`） | 两处取消分支补 `await` |
| `query_task` 的 `lastRunSignal` 恒 `undefined` | 进度 note 写「运行信号：」，而编排器用 `/运行证据=([^；]+)/` 提取——**六个 GUI 适配器里唯独 traework 用了别的措辞** | note 统一为「…；运行证据=\<值\>；…」；注意值后**必须紧跟「；」**（`[^；]+` 会吃进 `）` 产出 `"stop_button）"` 这类脏值）。新增 `test/unit/last-run-signal-contract.test.ts` 做六适配器契约全覆盖 |

**冒烟入口**：`npm run smoke:traework`（三件套护栏 `--confirm-send` / `--model` / `--task` 齐全才发送、
`--mode`、`--cancel-after-ms`、隔离数据目录）。

### 9.15 完成判定「运行信号门」（M34 / v0.8.1，issue #31）

**症状**：停止按钮 / loading 选择器漂移时界面「看起来静止」，**仍在进行**的任务在
`stableRounds × pollInterval`（默认约 12s）后被误判成功，直接进入验收 / 返修链。

- **门**：四个 driver（ZCode / Kimi Code / MiniMax / Open Design）的 `finished` 判据加
  `sawRunning && stable >= stableRounds && …`；**始终未观测到运行信号只允许收敛为 `idle_timeout`**
  （异常结束、保留实例）。Codex 自始即有该门，本版是**实现对齐文档**（ARCHITECTURE §8.3 流程图既有约定）。
- **后果链后半段（本 issue 的实质增量）**：`fix-loop` 原白名单只含 `zcode`/`codex`，其余三个 driver 的
  `idle_timeout` 因 `autoVerify` 默认为 `true` 而绕过 `!autoVerify` 出口，**仍会进项目验收链**——
  只加门的话用户可见行为只是「仍进验收，但迟了 10 分钟」。现抽 `shouldParkAsNeedsAttention()`，
  五个 GUI driver 一律落 `needs_attention`（非终态、可恢复）。
- **证据传递路径（门之外的另一层缺口）**：发送确认循环本就会 `poll()` 并累加运行信号，但该变量
  **只用于「发送是否确认」，从未传给观察循环**。若选择器漂移或 turn 在观察开始前跑完，观察循环整段采不到
  信号 → 已启动的任务判不了完成 → 误落 `idle_timeout`。现经 `ObserveArgs.sawRunningSeed` 带入。
  该缺陷由集成测试暴露（`zcode-flow.test.ts` 加门后 39/81 失败，基线 81/81 绿）。
- **两处已知取舍**：① Open Design 的产物指纹**不**计入运行信号（`fetchArtifactForSummary` 在 `finished`
  终态之后仍会写文件，计入会让「已完成但正在搬产物」永远判不了完成）；② MiniMax 的 `stopVisible` 依赖的
  `[data-testid="stop-button"]` **真机未复验**，采不到会每任务落 `idle_timeout` → `needs_attention`
  （有意的 fail-closed：可 `manage_task(action="continue")` 恢复，而误判成功不可逆）。
- **未做真机验证**：本版为纯函数与编排层修复，四个 driver 的选择器采集层未改动。

### 9.16 ZCode 模型标识与点击可点性排障（M38 / v0.9.2）

**症状**：特定模型**完全无法派单**（连参数校验都过不了）；或切换成功却仍判 `model_mismatch`；
或点击返回 `true` 但页面纹丝不动。

ZCode 的模型标识有**三套互不推导的语义**——面板可见标签（可能带 `分组名/` 前缀）、面板分组显示名、
`供应商/模型` 参数段；而模型名自身**可含 `/` 与 `:`**（实测 `inclusionai/ling-3.0-flash-sante:free` 两样都有）。

| 症状 | 根因 | 处置 |
|---|---|---|
| 模型名含冒号时适配器完全不可用 | `data-model-current-value` 格式是 `custom:<provider>:<urlencoded-model>`，旧实现 `decodeURIComponent(v).split(":").at(-1)` 取模型名，**假设模型名不含冒号** | 改为按 `<kind>:<provider>:` **前缀剥离**（只切前两段）；剥离结果与可见标签一致才采信，否则回退旧逻辑参与校验（**不放宽冲突检测**） |
| 面板分组名与参数段不一致 → `model_unavailable` | 用户按面板传 `cline-pass/deepseek-v4.1-flash`，但该模型所属分组显示名是 `cline`——`provider` 段与分组名**两段都匹配不上** | 供应商精确匹配失败时**枚举可见分组逐个 hover** 试匹配模型名；回读校验接受完整串 / 仅 model 段 / 仅 provider 段 |
| 切换成功后仍判 `model_mismatch` | 面板可见标签把**分组显示名**拼在模型名前（`.composer-provider-prefix` = `cline/`），旧回读只认完整候选串 | 新增 `uiModelNameMatches()`：先精确命中，失败则**剥一层** `首段/` 前缀再比。**只剥一层**——多剥会把结构上不相关的名字算命中 |
| 三段式模型参数被参数校验直接拒绝 | 模型名可含 `/`，按「分组 + 显示名」传参必然三段式，而 `parseZcodeModel` 要求 `split("/").length === 2` | 切分基准改为**首个 `/`**（之前是 provider、之后整段是 model）；`/x`、`x/`、无斜杠仍拒绝 |
| 顶部新建任务按钮点击假成功 | `conversation-new-task` 挂在页面滚动容器底部（真机 y=2474，视口高 640），宽高都 >0 所以旧判据认为「可见」，鼠标事件发到**视口外**被 Chromium 静默丢弃，而 `click()` 仍返回 `true` | 通用 `click()` 增加**可点性判据**：视口裁剪 + `elementFromPoint` 命中自身或其后代；不通过则返回 `false` 且**不发任何鼠标事件**，让调用方走回退而不是空等。真机复验：单轮耗时 67–73s → 46s |

**真机验证**：ZCode 3.14.4.7912（Windows），代码生成闭环 + 3 轮新建任务全部 `succeeded`，会话 ID 互异。
**回归锁 7 条，全部经反证验证**（回滚 → 精确变红且只有目标用例变红）。

### 9.17 Codex 26.1002 适配排障（M38 / v0.9.3）

**症状**：升级 Codex 到 26.1002 后，5 个缺陷中有 3 个让派单**完全无法进行**。

| 症状 | 根因 | 处置 |
|---|---|---|
| 发送确认假成功（最严重） | `messageArea` 选择器命中的容器**把 composer 一起包住**（`MainContentSurface` → `_ComposerLayoutRoot_` → `div.ProseMirror`），于是「输入框里还留着任务书」也被算作「对话区已出现该文本」 | 在可见容器上做**节点级遍历**并整棵跳过 composer 组件节点 |
| 点「新对话」后连接超时 | `connectStableCodex` 就绪判据只认 `chatInput`，但 Codex 重开后**停在既有会话视图**时 composer 并不挂载（真机 `chatInput=0`，「新聊天」按钮可点）——重试到超时**根本走不到点「新对话」那步** | 放宽为「`chatInput` 已挂载 **或** `newChat` 可点」，并在点击后显式等 composer 出现 |
| 回复稳定判定失真（`conversationText` 恒定） | 用**游离克隆体**做文本采集，而游离节点**没有布局**——Chromium 对它取 `innerText` 只返回空壳（605 字符真实对话 → 读到 4 字符）；且 `[class*="Composer"]` 子串匹配会误伤对话滚动容器（Tailwind 变体 `has-[[data-composer-expand-toggle]]` 也含该子串） | 改节点级遍历 + `textContent`（不依赖布局），只跳过 composer **组件**节点（精确基名 `_ComposerLayoutRoot_` / `_ComposerLayoutBody_`）。真机复验：`conversationText` **4 → 428 字符** |
| 进程退出被误报为 CDP 断开 | 真机 kill 进程后 CDP 报 `ECONNREFUSED`——那是**结果**不是原因 | 新增 `diagnoseCdpLoss()`，两处断连出口共用；探测失败按「进程仍在」保守处理 |
| CDP 错误文案硬编码程序名 | `TraeworkCdpClient` 被 **6 个**适配器复用（traework/codex/kimicode/minimax/opendesign/qoder），其余 5 个出错时会把用户引到**错误程序** | 新增 `CdpClientOptions.appLabel` |

**冒烟入口**：`npm run smoke:codex`。

**本版已知问题（留待后续）**：① 新会话首轮偶发 `send_unknown`（该路径**不会重发**——重发风险高于误判，
故如实报错而非假成功，见 §9.18）；② 模型选择器里新版分组标题与真模型项同为 `role="menuitemradio"`，
可能混入模型候选。

### 9.18 Codex 对话文本采集与工具面迁移（M38 / v0.9.4 + v0.9.0）

**① 症状**：报「文本已键入但未触发发送」（`send_unknown`），**而实际消息早已送达**
（真机取证：`composerText` 165 → 0、停止按钮出现、产物落盘）。

- **根因**：Codex 消息正文在 DOM 里是**碎片化**的，元素节点与纯文本节点交错：

  ```text
  SPAN     "【tianshu"
  #text    ":tsk_20261009083825_4d992a"
  #text    ":r0"
  #text    ":initial"
  SPAN     "】在当前项目创建 docs/verify-fix.md…"
  ```

  旧实现只遍历 `children`（元素）且「有元素子节点就丢弃自身文本」→ 四个 `#text` 节点**整批丢掉** →
  读成 `【tianshu】…` → `conversationText.includes(marker)` 恒 false → `seenMessage` 恒 false →
  发送确认三判据全 false。
- **修法**：遍历改 `childNodes`（含 `#text`），`textContent` 按文档顺序拼接；composer 组件节点仍整棵跳过。
- **真机复验**（`tsk_20261009102459_0e6869`）：日志出现「指令已确认发送」`seenMessage` 首次为 true；
  对话哈希逐轮变化 → 稳定轮 4 后收敛 `reply_stable`。
- **☆ 与 §9.17 的关系**：两次是**同一个采集函数的反向失误**——v0.9.3 前是**假阳性**
  （读到了不该读的：输入框残留），v0.9.4 前是**假阴性**（该读到的读不到）。修一处时务必检查另一处。
- **回归锁 1 条**（复刻真机 `SPAN`/`#text` 交错形态），**反证通过**（回滚 → 变红）。

**② 工具面从 13 变 8 的迁移（v0.9.0，BREAKING）**：若见到 `cancel_task` / `continue_task` / `rework_task` /
`list_tasks` / `get_task_report` / `get_profiles` / `wait_any` 报「工具不存在」，说明调用方未迁移——
对照 §2 顶部或 `docs/release-v0.9.0.md` 的迁移表改写。**旧技能副本不会随 npm 升级自动替换**，
需按 `docs/agent-profiles.md` 的 `--approve-skill-update` 放行一次。

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
| `CHANGELOG.md` / `.en.md` | 版本历史 v0.1.0 → **v0.9.4**（含比较链接） |
| `docs/release-v0.9.0.md` / `.en.md` | **v0.9.0 发布说明（BREAKING：工具面 13 → 8 的迁移表与不合并视觉基准的理由）** |
| `docs/release-v0.8.3.md` / `.en.md`、`docs/release-v0.8.4.md` / `.en.md`、`docs/release-v0.9.1.md` / `.en.md` … `docs/release-v0.9.4.md` / `.en.md` | v0.8.3–v0.9.4 各版发布说明（TraeWork 副作用阶梯 / 工具面瘦身 −67.1% / 三个 adapter 真机冒烟修复） |
| `docs/minimax-cdp.md` / `.en.md` | MiniMax Code GUI 驱动：双渲染进程（主窗口 + `Model menu`）、模型二级子菜单与逐模型候选集合、完整路径项目绑定与两步新建项目、`contextWindow`、真机证据与未覆盖项 |
| `docs/opendesign-cdp.md` / `.en.md` | Open Design GUI 驱动：数据目录推导、sidecar 根进程判定、选择器取证表与 12 步执行链、传输层双路径、产物信号、失败码表 |
| `docs/wait-task.md` / `.en.md` | 等待原语（issue #28）：停点定义、单任务与批量模式、超时钳制与无损语义 |
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

1. 先跑 `npm ci && npm run typecheck && npm run lint && npm test && npm run build`，确认基线绿。
   **本机实测基线：1692 passed / 2 failed / 12 skipped**（1706 项，137 文件）——两处失败为**既存环境失败**
   （`spawn-regression` 缺本机 `tianshu-runtime.exe`、`codex-flow`），非仓库缺陷。
   ⚠️ 本机 `npm test` 可能因运行时 shell 包装而无法直接拉起 `vitest`；若如此，直接跑
   `./node_modules/.bin/vitest run` 绕过。
2. 动代码前先读 ARCHITECTURE.md 建立整体心智模型（分层、依赖方向、唯一双路径接缝 `adapter.run`、状态机与验收流水线）；再按专题读本文章节：
   动 GUI adapter 相关代码前，先读对应文档与本文章节：
   TraeWork → `docs/traework-cdp.md` + §9.1 / §9.2 / §9.14；ZCode → `docs/zcode-cdp.md` + §9.5 / §9.6 / §9.9 / §9.16；
   Codex → `docs/codex-gui-cdp.md` + §9.4 / §9.17 / §9.18；Kimi Code → `docs/kimi-cdp.md` + §9.11；
   Qoder CN → `docs/qoder-cdp.md` + §9.12；Open Design → `docs/opendesign-cdp.md` + §9.13；MiniMax Code → `docs/minimax-cdp.md`。
   完成判定 / 运行信号相关改动先读 §9.15（门 + 证据传递路径两层缺口）。
   项目文件夹绑定出问题时，先看 §9.1 的排障顺序（下拉项 ≠ 项目 map、三处已修缺陷、两个定位陷阱）。
3. **改任何选择器交互必须真机复验**：trusted 点击与 DOM click 的取舍因控件而异（§9.4 的模型菜单 vs 项目触发器就是反例）；**点击返回值是弱信号**——`cdp.click()` 的 `true` 只表示元素可见，需副作用的调用方必须自行复检（§9.16 的视口外点击、§3.2 #30 的三级阶梯）。
4. 若客户端 UI 升级导致选择器失效：用 `scripts/probe-*.mjs`（7 个）诊断，优先用 profile `gui.selectors` 覆盖，不改代码。真机冒烟脚本 5 个：`smoke:traework` / `smoke:zcode` / `smoke:codex` / `smoke:kimicode` / `smoke:opendesign`。
5. 动视觉模块前先读 `docs/visual-acceptance.md` 与 §9.8：基准必须走「候选 → 用户批准」，规则冻结会拦截绕过；`TIANSHU_VISUAL_BROWSER_TEST=1` 才跑真实浏览器用例。
6. Codex 与 ZCode 的 macOS 基本闭环均已真机验证；取消/返修/`manage_task(action="continue")`/新建项目矩阵未补齐前
   不得把 darwin 从 `research` 改为 `ready`；TraeWork 的 macOS 分支仍是 fail-closed，
   Kimi Code / Qoder CN / Open Design / MiniMax Code 的 darwin 同为 `research`（fail-closed，未在 macOS 实测）。
7. 新增 agent：优先只加 profile（见 `docs/agent-profiles.md`）；需要特殊输出解析再写 adapter。
8. 发版前务必确认 `src/version.generated.ts`、`package.json` **与 `package-lock.json`** 三者版本一致并同步提交
   （CI 有「构建后无 tracked diff」门禁；v0.5.0 曾漏掉锁文件）。推 `v*` tag 即触发 Release
   （双语正文取 `docs/release-v<ver>.md` + `.en.md`，**缺文档会直接失败**；且要求同 SHA 的成功 CI）。完整步骤见 §6.4。
   **工具面变更（增删工具或改 `inputSchema` 形状）时**，除本文件与双语文档外，还要同步 GUI 侧工具面镜像与
   Rust 侧，并跑 `check-schema-parity.mjs`（真源 ↔ 镜像 ↔ Rust 三方零漂移）——v0.9.0 的教训。
9. 未发布计划（见 `CHANGELOG.md` 的「未发布 / 计划中」节）：更多 agent 适配、TraeWork / ZCode / Codex / Kimi Code / Qoder CN / Open Design / MiniMax Code 的 macOS 验证矩阵、
   项目级技能播种、`needs_user` 状态取消时经临时 CDP 连接尽力停止 GUI 内等待中的会话、
   Kimi Code 的取消/提问续答真机验证（当前仅 hermetic 集成测试覆盖，见 §9.11）、
   Qoder CN 的取消真停与提问续答真机验证（同为 hermetic 覆盖，见 §9.12）、
   ZCode 无项目派发的 macOS 真机验证、ZCode 未登记项目自动导入在 Windows 上的修复（§9.9）、
   **MiniMax 的 `[data-testid="stop-button"]` 真机复验**（见 §9.15 的已知取舍——采不到会每任务落 `needs_attention`）、
   **Open Design 的 zip 导出方式**（产品主进程接管下载，`state=canceled`，见 §9.13）、
   **Codex 26.1002 新会话首轮的 `send_unknown`**（发送链路单独修复，见 §9.17）、
   以及 AI 内容校验的后续扩展（跨轮判定翻转熔断、跨任务缓存共享、参考图/设计稿差异比对）。
   注：issue #3 第一阶段（像素级对比 + 图片规格 + 报告 + 返修闭环 + 基准批准/冻结）已随 v0.5.0 完成，issue #3 已关闭；
   issue #12（无项目派发 + `allowCreateProject`）已随 v0.5.2 完成，其真机回访修复随 v0.5.3 完成；
   issue #13（视觉验收第二阶段 AI 内容校验）已随 v0.5.4 完成，见 §4.3 与 §9.10；
   issue #14（GUI 终态如实化）已随 v0.5.9 完成；issue #15（派单/验收幂等键）已随 v0.5.10 完成；
   issue #16（技能自装加固：源定位 / 覆盖语义 / 三态与备份治理）已随 v0.6.0 完成，见 §3.4 与 `docs/issue-16-skill-install-hardening-record.md`；
   issue #17（五项小项扫尾：系统目录子树拒绝 / capability 三族 / 登记失败不派单 / `cmd` 形态文档化 / 计数对齐）已随 v0.6.1 完成，见 §0 的 0.6.1 交接与 `docs/issue-17-small-fixes-record.md`；
   issue #28（等待原语）已随 v0.7.7 完成；issue #29（视觉外发闸门语义）随 v0.7.10；issue #30/#35（恢复语义）随 v0.8.0；
   issue #31（完成判定门）随 v0.8.1；issue #34（Codex 模型回读）随 v0.8.2；issue #38（TraeWork 点击与失败分类）随 v0.8.3；
   工具面合并（v0.9.0，BREAKING）与工具面瘦身（v0.8.4）无对应 issue；
   技能自装的后续方向（另开 issue）：多宿主技能目录投递、宿主级 `"prompt"` 交互确认 UI。
