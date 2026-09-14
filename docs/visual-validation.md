# 视觉验收验证进度

[English](visual-validation.en.md)

目标计划：本地 `.codex/plans/2026-09-14-issue-3-visual-acceptance-plan.md`（英文版同名 `.en.md`），两者均保持 Git 忽略。目标版本 v0.5.0 的代码、文档与本地门禁已完成；发行门禁与 macOS 真机证据尚未完成。

## 已执行

**本机环境**：Windows 10 Pro x64（10.0.19045），Node 24.18.0，托管 Chrome 148.0.7778.97。

- 独立临时浏览器启动、390×844 PNG 截图与完整解码通过（`TIANSHU_VISUAL_BROWSER_TEST=1`）。原始截图和环境记录本地保存在 `.tmp-check/visual-windows`，不纳入 Git。
- **全量测试 486 passed / 8 skipped**（跳过的 8 项为真实浏览器门禁用例，已用 `TIANSHU_VISUAL_BROWSER_TEST=1` 单独跑通 8/8）：
  - 真实浏览器：托管浏览器启动与解码、三种页面来源、输入/点击/悬停/选项/滚动、整页懒加载、Cookie/localStorage 导入与失效诊断、外部资源允许与拦截、截图差异与规则冻结。
  - 非浏览器：视觉配置严格校验、图片规格与边界、基准候选/批准/篡改拒绝、规则冻结快照、任务级轮次互斥、阻塞恢复先验收、两类返修计划含视觉证据、历史与协议回归。
- **生产 tarball 独立消费者验收通过**：`npm pack` → 安装到不含开发依赖的目录 → 批准基准 → 图片规格检查 → 检出真实像素缺陷 → 离线 HTML 断网可用（状态过滤、透明叠加、区域定位）。命令：
  ```sh
  TIANSHU_VISUAL_REPORT_EVIDENCE=.tmp-check/visual-evidence/report.png \
    node scripts/check-visual-consumer.mjs --package-dir <消费目录>/node_modules/tianshu-mcp
  ```
- `typecheck`、`lint`、`build`、`pack:check`、严格 stdio 检查全部通过；构建后无意外已跟踪文件变更。
- **CI 目标提交成功**：`b1505f5` 的 `CI` 工作流全绿（`visual-browser` 四系统 × Node 20/22/24 全部成功，`build-test`、`pack-check` 成功）。早期 `df7eb18` 的 CI 在 `Build & Test (ubuntu-latest / Node 20)` 因 `zcode-flow` 任务总时限时序竞态失败一次，与视觉模块无关；该用例在本机与后续 CI 均通过。
  - 链接：https://github.com/lanlan0811/tianshu-mcp/actions/runs/34838565104
- **v0.5.0 发布完成并核实**：
  - `Release` 工作流成功：包含「要求目标提交存在成功 CI」「镜像凭据存在」两道闸门与 GitHub/Gitee 双发行步骤。链接：https://github.com/lanlan0811/tianshu-mcp/actions/runs/34839014803
  - GitHub 发行：`tag v0.5.0`（非草稿），资产 `tianshu-mcp-0.5.0.tgz`，正文为双语发行说明。
  - Gitee 发行：`tag v0.5.0`（id 1143672）已创建，目标提交 `b1505f5`，正文为双语发行说明。
  - 双仓一致：`github/master`、`gitee/master`、两仓 `v0.5.0` 标签与本地标签均指向 `b1505f5`。
- **npm registry 未在本次范围内**：按计划「不额外增加 npm registry 发布」，npm 包仍停留在 `0.4.1`。

## 待完成门禁

- **macOS 13+ Intel 与 Apple Silicon** 的真实系统/Node/浏览器证据；Windows 10 的完整功能矩阵（含端口冲突、就绪失败、取消清理、中文/带空格路径、项目外符号链接、托管/本机浏览器与版本不匹配）。CI 的 macOS runner 结果不能替代维护者在真实 macOS 设备上的验证记录。

禁止将未执行项目标记为通过；缺少目标平台证据时保留阻塞。
