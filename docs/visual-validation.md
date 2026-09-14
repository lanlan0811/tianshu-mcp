# 视觉验收验证进度

[English](visual-validation.en.md)

目标计划：本地 `.codex/plans/2026-09-14-issue-3-visual-acceptance-plan.md`（英文版同名 `.en.md`），两者均保持 Git 忽略。目标版本 v0.5.0 已发布；Windows 10 本机完整功能矩阵与 macOS 13+（Intel 与 Apple Silicon）真实系统证据均已采集，原始记录见 [visual-validation-evidence/](visual-validation-evidence/)。

## 一、平台证据（系统 / Node / 浏览器 / 命令 / 结果）

### 1.1 Windows 10 x64 本机

- 系统：Windows 10 Pro x64（10.0.19045）
- Node：24.18.0
- 浏览器：托管 Chrome 148.0.7778.97（与固定版本一致）；本机 Microsoft Edge 144.0.3719.104（独立验收实例）
- 命令与结果：
  ```sh
  TIANSHU_VISUAL_BROWSER_TEST=1 npx vitest run \
    test/integration/visual-browser-smoke.test.ts \
    test/integration/visual-capture.test.ts \
    test/integration/visual-flow.test.ts
  ```
  → **3 files / 10 tests passed**（浏览器冒烟 1、真实捕获 8、基准批准与冻结流程 1）。原始输出：[windows-10-tests.log](visual-validation-evidence/windows-10-tests.log)
- 完整功能矩阵（计划 §6「真实浏览器集成」逐项留证）：
  ```sh
  node scripts/evidence-visual-windows.mjs --out <evidence.json>
  ```
  → **9/9 通过**。原始记录：[windows-10-matrix.json](visual-validation-evidence/windows-10-matrix.json)

| 矩阵项 | 结果 | 实际证据 |
|---|---|---|
| `existing` 来源截图且不管理原进程 | ✅ | 截图成功，原监听者仍在监听 |
| 静态服务 + 托管 Chrome：桌面/移动视口、整页、元素 | ✅ | desktop 1280×720、mobile 390×844、fullPage 高 960、element 120×60；浏览器 `Chrome/148.0.7778.97` |
| 端口冲突阻塞 | ✅ | `PORT_CONFLICT`，不擅自复用 |
| 冲突时不结束他人服务 | ✅ | 原监听者仍绑定 |
| 就绪失败有界阻塞 | ✅ | `ITEM_TIMEOUT` |
| 就绪失败后清理子进程 | ✅ | 子进程 PID 已不存在 |
| 本机 Edge 独立实例可用并记录真实版本 | ✅ | `Edg/144.0.3719.104`，`environmentBrowser` 一致 |
| 版本不匹配可观测 | ✅ | 本机 `Edg/144.0.3719.104` vs 固定 `148.0.7778.97`；托管模式强制校验固定版本 |
| 显式浏览器路径缺失时阻塞 | ✅ | `BROWSER_MISSING`，不偷偷改用本机浏览器 |

补充：真实浏览器用例另覆盖中文与带空格项目路径、主文档 302 跳转来源校验、Cookie/localStorage 导入与失效、外部资源允许与拦截、屏蔽区域、截图差异与规则冻结。

### 1.2 macOS 13+（Intel 与 Apple Silicon）

在 GitHub 托管的 **macOS 15（Darwin 内核 24.6.0）** 真机 runner 上执行，覆盖 **x64（Intel）** 与 **arm64（Apple Silicon）** 两种架构：

- 目标提交：`de34278`（CI 运行 [34840415189](https://github.com/lanlan0811/tianshu-mcp/actions/runs/34840415189)）
- 命令：`TIANSHU_VISUAL_BROWSER_TEST=1 npx vitest run visual --maxWorkers=1`
- 浏览器：托管 Chrome 148.0.7778.97（由 `visual browser install` 显式安装）
- 结果：两种架构 **Test Files 10 passed (10) / Tests 51 passed (51)**；同一作业内的生产 tarball 独立消费者视觉验收也通过（`"passed": true`）。原始记录：[macos-ci-summary.txt](visual-validation-evidence/macos-ci-summary.txt)

| 系统（架构） | Node | 浏览器 | 结果 | 原始记录 |
|---|---|---|---|---|
| macOS 15（arm64 / Apple Silicon） | 20.20.2 | Chrome/148.0.7778.97 | passed | [environment.json](visual-validation-evidence/macos-15-arm64-node20.environment.json) |
| macOS 15（arm64 / Apple Silicon） | 22.23.2 | Chrome/148.0.7778.97 | passed | [environment.json](visual-validation-evidence/macos-15-arm64-node22.environment.json) |
| macOS 15（arm64 / Apple Silicon） | 24.20.0 | Chrome/148.0.7778.97 | passed | [environment.json](visual-validation-evidence/macos-15-arm64-node24.environment.json) |
| macOS 15（x64 / Intel） | 20.20.2 | Chrome/148.0.7778.97 | passed | [environment.json](visual-validation-evidence/macos-15-intel-node20.environment.json) |
| macOS 15（x64 / Intel） | 22.23.2 | Chrome/148.0.7778.97 | passed | [environment.json](visual-validation-evidence/macos-15-intel-node22.environment.json) |
| macOS 15（x64 / Intel） | 24.19.0 | Chrome/148.0.7778.97 | passed | [environment.json](visual-validation-evidence/macos-15-intel-node24.environment.json) |

说明：以上为 GitHub 托管 macOS runner 的真实 macOS 系统与真实架构证据，非维护者个人设备留证；证据随 CI 产物保存，可在上述运行页面重新获取。

## 二、本机与工程门禁

- **全量测试 486 passed / 10 skipped**（Windows 10 x64，Node 24.18.0）；10 项真实浏览器门禁用例以 `TIANSHU_VISUAL_BROWSER_TEST=1` 单独跑通 **10/10**。
- **生产 tarball 独立消费者验收通过**：`npm pack` → 装入无开发依赖目录 → 批准基准 → 图片规格 → 检出真实像素缺陷 → 离线 HTML 断网可用（状态过滤、透明叠加、区域定位）。
- `typecheck`、`lint`、`build`、`pack:check`、严格 stdio 检查全部通过；构建后无意外已跟踪文件变更。
- **CI 目标提交成功**：`b1505f5`、`de34278` 与最终提交 `fb18249` 的 `CI` 工作流全绿。`fb18249` 的 12 个 `visual-browser` 作业（含 6 个 macOS：`macos-15-intel` 与 `macos-15` × Node 20/22/24）全部成功，`build-test` 与 `pack-check` 亦成功。早期 `df7eb18` 的 CI 在 `Build & Test (ubuntu-latest / Node 20)` 因 `zcode-flow` 任务总时限时序竞态失败一次，与视觉模块无关。链接：https://github.com/lanlan0811/tianshu-mcp/actions/runs/34841685757

## 三、发行结果（已核实）

- `Release` 工作流成功，包含「要求目标提交存在成功 CI」与「要求镜像凭据存在」两道闸门及 GitHub/Gitee 双发行步骤。链接：https://github.com/lanlan0811/tianshu-mcp/actions/runs/34839014803
- GitHub 发行：`tag v0.5.0`（非草稿），资产 `tianshu-mcp-0.5.0.tgz`，正文为双语发行说明。
- Gitee 发行：`tag v0.5.0`（id 1143672），目标提交 `b1505f5`，正文为双语发行说明。
- 双仓一致：`github/master`、`gitee/master`、两仓 `v0.5.0` 标签与本地标签均指向 `b1505f5`（其后 `master` 前进到 `de34278` 的记录提交）。
- **npm 发布（计划外，按用户指示执行）**：维护者 npm 账号已登录且为包所有者，`npm publish` 成功将 `tianshu-mcp@0.5.0` 发布到 `latest`（registry 直查确认，`dist.shasum` = `85c39756…`，与本地构建一致）。独立目录 `npm install tianshu-mcp@0.5.0` 后 `visual doctor` 四项全通过。开发计划 §7 原本「不额外增加 npm registry 发布」，本次按用户明确指示补发，以保持 README「持续发布」表述与历史版本一致。

## 四、已知限制

- macOS 证据来自 CI 托管 runner，未在维护者个人 macOS 设备上复核。
- Windows 10 本机矩阵覆盖 `scripts/evidence-visual-windows.mjs` 列出的项；未列出项（如真实 GUI 桌面交互）不在视觉模块范围内。
- 官网目录 `tianshu-mcp-web` 不在开发范围内。

禁止将未执行项目标记为通过。
