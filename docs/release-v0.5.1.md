# tianshu-mcp v0.5.1 发布说明

**核心主题**：**文档与验证证据补齐**。把编排技能文档对齐 v0.5.0 的实际工具面，归档视觉验收的 Windows 10 完整功能矩阵与 macOS 双架构平台证据，并修正一处版本元数据滞后。

本版本为 **PATCH**：**无运行时行为变更**，工具参数、报告字段与验收配置格式与 v0.5.0 完全一致，升级无需改动调用方。

## 新增

- **Windows 10 完整功能矩阵证据脚本**（`scripts/evidence-visual-windows.mjs`，`npm run evidence:visual:windows`）：在本机采集计划要求的真实浏览器矩阵证据，覆盖 —— `existing` / 静态 / 命令三种页面来源、端口冲突时阻塞且不结束他人服务、就绪失败时在预算内阻塞并清理子进程、托管 Chrome 的桌面/移动/整页/元素截图、本机 Edge 独立验收实例与真实版本回显、版本不匹配可观测、显式浏览器路径缺失时阻塞。实测 **9/9 通过**。
- **验证证据归档**（`docs/visual-validation-evidence/`）：原样入库 Windows 10 矩阵 JSON 与测试输出、macOS 双架构的 `environment.json`（含系统内核、架构、Node、浏览器版本与结果）以及 CI 摘要。证据随包分发，可独立核验。

## 修复

- **`package-lock.json` 版本号滞后**：v0.5.0 发布时锁文件的根包版本仍停留在 `0.4.1`（与 `package.json` 的 `0.5.0` 不一致）。本版本同步为 `0.5.1`，消除锁文件与清单的版本漂移。

## 文档

- **技能文档对齐代码实况**（`skills/tianshu-mcp/SKILL.md` + `usage-examples.md`）：逐项核对 `src/` 的工具定义、入参 schema、枚举与 meta 构造后修正偏差 ——
  - 补齐 11 个工具表（含能力/审批列，此前 `description` 声称 11 个却只列 9 个）；
  - 视觉验收独立成节（阻塞不触发 agent 返修、`rework_task` 先重新验收、基准必须用户批准、规则冻结 `VISUAL_INTEGRITY`、禁止绕过）；
  - 错误码表补 `setup_recovery`，单列 `errorType` 全部取值；
  - 修正 agent 状态语义（`traework` 恒为 `ready`、`codex` 平台相关、`zcode` 为 `research`）；
  - 澄清 `get_task_report` 直接返回报告原文、不带 meta 块，并移除 meta 表里误列的 `reasoningLevel`（仅入参、不回显）；
  - 按 agent 区分自动修复计划落盘位置（codex 写项目内 `.zcode/plans/`，其余写 MCP 任务目录）；
  - 补 `continue_task` 仅支持 codex/zcode、`list_tasks` 实际输出列与视觉 CLI 命令。
- **验证进度重写**（`docs/visual-validation{,.en}.md`）：改为完整平台证据表（系统 / Node / 浏览器版本 / 命令 / 结果），不再是笼统的「待完成门禁」清单。
- **双语 README 与 CHANGELOG** 同步至 v0.5.1；`HANDOFF.md` 按当前代码与提交历史重写。

## 测试与验证

- 全量测试 **486 passed / 10 skipped**（Windows 10 x64，Node 24）；10 项真实浏览器门禁用例以 `TIANSHU_VISUAL_BROWSER_TEST=1` 单独跑通 **10/10**。
- **Windows 10 x64 本机矩阵 9/9 通过**；**macOS 15 真机 runner** 上 Intel x64 与 Apple Silicon arm64（Node 20/22/24）各 **10 文件 51 用例通过**。
- `typecheck` / `lint` / `build` / `pack:check` / 严格 stdio 检查（11 工具、6 场景）全部通过；构建后无意外已跟踪文件变更。
- CI 新增的 `visual-browser` 矩阵（ubuntu/windows/macos-15-intel/macos-15 × Node 20/22/24）随 v0.5.0 及本提交全绿。

> 已知偶发：`test/integration/zcode-flow.test.ts` 的「任务总时限到达时停止 MCP 等待并保留实例」用例在满负载并行下存在时序竞态（`taskTimeoutMs: 2` 的真实时限与调度竞争），单文件运行与 CI 重试均能通过。该用例早于本版本存在，v0.5.1 未改其语义。

## 分发与兼容性

- GitHub 为主仓库，Gitee 为代码、标签与发行版镜像；npm 同步发布 `tianshu-mcp@0.5.1`（`latest`）。
- **无破坏性变更**：调用方 API、工具参数、meta 块字段、报告格式与验收配置与 v0.5.0 一致。
- 视觉模块要求 Node.js ≥20.3；非视觉功能保留 Node.js ≥20。

相关文档：[视觉验收指南](visual-acceptance.md)｜[验证进度](visual-validation.md)｜[项目 README](../README.md)｜[CHANGELOG](../CHANGELOG.md)｜[交接文档 HANDOFF](../HANDOFF.md)
