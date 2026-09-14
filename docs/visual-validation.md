# 视觉验收验证进度

[English](visual-validation.en.md)

目标计划：本地 `.codex/plans/2026-09-14-issue-3-visual-acceptance-plan.md`，保持 Git 忽略。目标版本 v0.5.0 尚未发布，完整验收尚未完成。

## 已执行

- 2026-09-14 Windows 10 Pro x64（10.0.19045），Node 24.18.0，托管 Chrome 148.0.7778.97：独立临时浏览器启动、390×844 PNG 截图与完整解码通过。
- 命令：`TIANSHU_VISUAL_BROWSER_TEST=1 npx vitest run test/integration/visual-browser-smoke.test.ts`（PowerShell 使用 `$env:` 设置）。原始截图和环境记录本地保存在 `.tmp-check/visual-windows`，不纳入 Git。
- 配置与旧验收定向回归 34 项通过；视觉配置、图片和真实浏览器基准流程 23 项通过。

## 待完成门禁

- 全量测试、完整浏览器交互/网络/取消/返修矩阵以及发行包独立消费者验证。
- macOS 13+ Intel 与 Apple Silicon 的真实系统/Node/浏览器证据；Windows 10 的完整功能矩阵。
- 三系统 Node 20/22/24 CI，以及视觉专用工作流的目标提交结果。
- GitHub/Gitee master 一致性、v0.5.0 双仓标签、release 工作流与两个实际发行记录。

禁止将未执行项目标记为通过；缺少目标平台或发行凭据时保留阻塞。
