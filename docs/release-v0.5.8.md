# tianshu-mcp v0.5.8 发布说明

[English](release-v0.5.8.en.md)

**文档版本 + 打包一致性修复**：把 README 双语、HANDOFF、ARCHITECTURE 双语四份主文档按当前代码逐项核对重写，并修掉一处**分发缺口**（`scripts/probe-traework.mjs` 未随包发布，而文档要求用户运行它）。**无运行时行为变更**，升级无需改动调用方。

## 文档重写（按代码逐项核对）

核对范围为 `src/mcp/`、`src/tasks/`、`src/loop/`、`src/agents/`（五个 GUI 适配器全部）、`src/verify/`、`src/visual/`、`src/config/`、`src/util/`，逐条改了下列**与代码不符**的陈述：

- **验收阶段顺序**：内置 `git-diff-check` 在**配置的检查项之前**执行，视觉检查在**命令检查之后**执行（页面常需要先 build）。旧文档把顺序写反了。
- **`visual.enabled=false` 的真实边界**：快照冻结与完整性核对**恒定执行**，与 `enabled` 无关；`enabled` 只决定是否真的跑截图/规格/内容判定。因此「视觉未启用」不等于「没有任何视觉动作」——这条正是检出「有人改了验收配置或基准」的机制。
- **工具返回契约**：除 `get_task_report` 外，`prepare_visual_baseline` / `approve_visual_baseline` 的成功结果同样**不带 meta 块**，任何工具的**错误**结果也不带。旧文档称「只有 `get_task_report` 例外」。
- **五份 agent 表补齐 Qoder CN**：README 的 agent 列表、driver 列表、`endReason` 表、`needsUserKind` 表、取消能力表、registry 特殊探测分支、GUI 实例生命周期表、单元/集成测试分层说明全部从「四个 driver」更正为「五个」，并把 Qoder CN 的执行顺序与完成判定写入架构文档。
- **`endReason` / `needsUserKind` 逐值核对**：补上 Kimi Code 的 `system_permission` 与 `setup_recovery`；注明 **Qoder CN 是唯一能产出全部 6 种 `needsUserKind` 的适配器**，且它**不产出 `idle_timeout`**（界面静止而无本轮完成证据时转 `needs_user(setup_recovery)`）；注明 Codex 因 `ensureInstance` 从不返回 `needsClose` 而**没有** `close_existing_instance` 路径；注明 ZCode 与 TraeWork **不点界面停止按钮、也不回传 `guiStop`**。
- **取消语义**：改为按适配器能力分列（Codex / Kimi Code / Qoder CN 点停止并有界等待；ZCode / TraeWork 只停 MCP 侧观察）。
- **检查点与防重发**：明确 `qoder-session.json` 是**唯一持久化检查点**（phase 取值 `sending` / `sent` / `completed` / `answer_sending`，写点与读点），其余适配器的防重发是内存态判断；旧技能文档把「检查点」写成了所有 agent 的通用机制。
- **Kimi Code 档位取值域**：README 首页示例与里程碑文字从 `Low`/`High`/`Max` 更正为代码实际接受的 `低/low`、`高/high`、`max`、`on`、`off`（刻意不含 `中`/`medium`）。
- **测试基线与文件数**：README 与 HANDOFF 的「776 项 / 73 文件」「37 + 20 文件」更正为 **826 passed / 12 skipped（838 项，81 个测试文件）**，并列出单元 54 / 集成 26 / 协议 1 的实际构成。
- **运行时依赖许可**：旧文称「运行时依赖均为 MIT」，实际 `puppeteer-core` 与 `@puppeteer/browsers` 为 Apache-2.0、`pixelmatch` 为 ISC、可选依赖 `sharp` 为 Apache-2.0；许可表已按 `package.json` 重写。
- **profile 无效字段提示**：架构文档新增提示框，列出**声明了但当前无消费方**的字段（`gui.windowMode`、`gui.modelRequired`、ZCode 的 `gui.stallTimeoutMs` / `gui.cancelWaitMs`），避免接手人误以为「配了就有用」。
- **已知缺口更新**：删掉「`tools.ts`/`handlers.ts`/`server.ts` 注释仍写 9 个工具」这条已修项，替换为两条真实技术债（执行型子进程 spawn 选项四处重复无共用 helper；上述无效 profile 字段）。

## 打包一致性修复

- `scripts/probe-traework.mjs` 此前**不在 `package.json` 的 `files` 里**，而 README / HANDOFF 都要求用户运行 TraeWork 探针——装 npm 包的用户拿不到该脚本。现已纳入分发。
- 补齐 `probe:traework` / `probe:zcode` / `probe:codex` 三个 npm script（此前只有 `probe:kimicode` / `probe:qoder`，而 `scripts/probe-zcode.mjs`、`scripts/probe-codex.mjs` 早已随包发布）。现在五个探针都能用 `npm run probe:<agent>` 运行。

## 源码注释修正（无行为变更）

- `src/mcp/handlers.ts`、`src/server.ts` 头部注释的「9 个工具」更正为 11。
- MCP server `instructions` 字符串补上 `kimicode` 与 `qoder`（原仅列 codex/zcode/traework）。
- `src/agents/gui-instance.ts` 头注补全五个使用者；`src/tasks/task.ts` 修正一处**贴在 Qoder 字段上的 Kimi Code 注释**（并注明 `qoderTurnId` 当前无写入方）。

## 门禁与证据

- 全量回归 **826 passed / 12 skipped**（Windows 10 x64，Node 24.18.0）；类型检查、lint 全通过。
- `npm pack`（231 文件）已核验包含五个探针脚本；相对链接检查覆盖四份主文档与技能文档共 **255 条相对链接、0 条失效**。
- 本版本为 **PATCH**：无运行时行为变更，既有调用方签名、报告字段与错误码语义**保持向后兼容**。

相关文档：[项目 README](../README.md)｜[CHANGELOG](../CHANGELOG.md)｜[架构说明](../ARCHITECTURE.md)｜[交接文档](../HANDOFF.md)
