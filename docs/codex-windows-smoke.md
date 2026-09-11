# Codex 桌面端 GUI 真机验收记录（codex-windows-smoke.md）

- 日期：2026-09-11
- 平台：Windows 10 x64
- Codex：`OpenAI.Codex` 26.903.9818.0（MSIX / `2p2nqsd0c76g0`）
- 适配器：`codex-gui`（`driver=gui`，`activation=msix-com`）
- 关联：[codex-gui-cdp.md](codex-gui-cdp.md)、[adapter-matrix.md](adapter-matrix.md)
- 复现入口：`node scripts/probe-codex.mjs --launch`

## 1. 环境事实

| 项目 | 值 |
|---|---|
| 安装位置 | `C:\Program Files\WindowsApps\OpenAI.Codex_26.903.9818.0_x64__2p2nqsd0c76g0` |
| GUI 宿主 | `<安装位置>\app\ChatGPT.exe` |
| AUMID | `OpenAI.Codex_2p2nqsd0c76g0!App` |
| 受管 profile | `%LOCALAPPDATA%\tianshu-mcp\codex-gui\profile` |
| 同机其他版本 | 存在 `26.903.8094.0` 目录（扫盘回退时须取最新） |

## 2. 逐项验收

| # | 验收项 | 结果 | 证据摘要 |
|---|---|---|---|
| 1 | 安装发现（Appx 优先） | ✅ | `Get-AppxPackage -Name OpenAI.Codex` → InstallLocation/AUMID 正确 |
| 2 | 受管实例启动（COM 激活） | ✅ | 激活返回 pid；进程命令行含专属 `--user-data-dir` 与 `--remote-debugging-port=9333` |
| 3 | CDP 就绪 | ✅ | `/json/version` = `Chrome/152.x`；`/json/list` 主页 `app://-/index.html` |
| 4 | 页面收敛 | ✅ | 正确避开 `app://-/index.html?initialRoute=%2Favatar-overlay` 次级窗口 |
| 5 | 复用已有受管实例 | ✅ | 第二轮起日志「复用受管实例 pid=…，CDP 端口 9333」 |
| 6 | 既有项目绑定 | ✅ | 「已选择既有项目：tianshu-mcp」「项目绑定回读通过」 |
| 7 | 模型 + 思考等级 | ✅ | 触发器回读 `GPT-5.6 Sol 高`；选择器已排除菜单栏与模式切换器 |
| 8 | 强制权限 | ✅ | 回读「完全访问」 |
| 9 | 输入与发送 | ✅ | 「指令已确认发送（对话区=true，输入清空=true）」 |
| 10 | 运行检测 | ✅ | `pending → running(stop_button) → finished(stop_button_gone+text_stable)` |
| 11 | 端到端任务 | ✅ | Codex 实际创建文件，内容 `OK`；任务终态 `succeeded` |
| 12 | 隔离性 | ✅ | 受管实例独立 profile，不影响用户手动打开的实例 |

## 3. 验收 + 返修回环（决策 9/10/11/12）

对**已绑定项目**（本仓库）执行真实闭环：

1. 临时验收配置要求 `scratch 文件内容 === PASS`；初始任务只要求写入 `OK`。
2. 第 0 轮验收**失败**（2 项检查）→ 日志「已生成修复计划：`.zcode/plans/codex-fix-r1.md`」。
3. 返修指令引用该计划：「第 1 轮返修指令已引用修复计划 `.zcode/plans/codex-fix-r1.md`」，
   并向**同一会话**发送。
4. 第 1 轮验收**通过** → 任务终态 `succeeded`；文件内容变为 `PASS`。

结论：**验收失败 → MCP 自动生成项目内独立修复计划（含轮次号、不覆盖）→ 引用并返修 → 再验收通过**
的闭环已在真机跑通（`docs/codex-gui-cdp.md` §9）。

## 4. 实施期在真机发现并修复的缺陷

单测与集成测试（含假 CDP）**未能**发现以下问题，均由真机暴露，现已修复并加测试守护：

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | `__codexResolve` 参数错位（单数组 vs 5 位置参数）导致 `texts.length` 抛错 | 双形式兼容 + 单测 |
| 2 | 模型触发器误命中顶部菜单栏（同带 `aria-haspopup`） | 选择器 `excludes` + 作用域 + 单测 |
| 3 | 项目选择触发器漏「切换项目：<名>」形态 | 精确文案/模式匹配 + 单测 |
| 4 | `boundProjectName` 命中整页文本致绑定校验形同虚设 | 改读 `aria-label="切换项目：<名>"` |
| 5 | 对话区选择器用裸 `main`/`#root` 混入导航壳 | 改 `MainContentSurface`；发送确认放宽为任一直接证据 |
| 6 | 「源文件夹」是 `<label>` 不可点，`element.click()` 又不 trusted | 改 trusted 鼠标事件 + `elementFromPoint` 命中校验，目标改 drop zone 按钮 |
| 7 | 「创建项目」标题 `<h2>` 与按钮同名造成歧义 | `clickExact` 优先可交互元素 + 单测 |
| 8 | 原生对话框经 UIA 顶层枚举找不到 | 改 Win32 `EnumWindows` + `FromHandle` |
| 9 | 跨轮残留原生对话框阻塞后续运行 | 新增 `closeStrayDialogs` 启动清理 |
| 10 | PowerShell 冷启动 `Add-Type` 超时过短 | 放宽超时；基线枚举失败非致命 |

## 5. 已知限制

- **新建项目整链路依赖窗口前台**：原生文件夹选择器只在应用窗口前台时弹出。真机上各步骤已分步验证
  （对话框确实弹出 `#32770 Select Project Root`、键盘自动化提交成功、创建项目对话框正确回填源文件夹），
  但完全无人值守下若系统前台策略阻止窗口置前，可能返回 `project_create_failed`。
  **既有项目**绑定与验收/返修闭环不受影响。
- **macOS 未验证**：内置状态 `research`，不参与就绪判定。
- `stopButton` 文案若随版本变化需重测；未命中时按失败开放路径（`idle_timeout`），不会误判完成。
