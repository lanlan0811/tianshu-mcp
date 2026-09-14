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

## 待完成门禁

- **macOS 13+ Intel 与 Apple Silicon** 的真实系统/Node/浏览器证据；Windows 10 的完整功能矩阵（含端口冲突、就绪失败、取消清理、中文/带空格路径、项目外符号链接、托管/本机浏览器与版本不匹配）。
- **CI**：新增 `visual-browser` 矩阵（ubuntu/windows/macos-15-intel/macos-15 × Node 20/22/24）需在目标提交上实际跑绿；本机只验证了 Windows 10 x64 与 Node 24。
- **发行**：GitHub/Gitee `master` 指向一致、v0.5.0 双仓标签、release 工作流结果与两个实际发行记录。release 要求目标提交存在成功 CI，且缺少 `GITEE_TOKEN` 时阻塞。

禁止将未执行项目标记为通过；缺少目标平台或发行凭据时保留阻塞。
