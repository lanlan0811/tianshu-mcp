# Codex 桌面端 GUI 驱动（codex-gui-cdp.md）

tianshu-mcp 的 Codex 适配器：驱动 OpenAI Codex 桌面端（ChatGPT 桌面应用）完成「定位安装 → 启动 GUI → 绑定/新建项目 → 选模型与思考等级 → 发指令开发 → 运行检测 → 验收 → 返修」全流程。

- 实现：`src/agents/codex/**`
- 计划：`.zcode/plans/codex-gui-adapter-plan.md`
- 状态：Windows 已真机验证；macOS 标 `research`（未验证，不参与就绪判定）
- 关联：[adapter-matrix.md](adapter-matrix.md)、[agent-profiles.md](agent-profiles.md)、[acceptance-config.md](acceptance-config.md)

---

## 1. 为什么是 COM 激活而不是直接启动 exe

Codex 桌面端是**微软商店（MSIX/AppX）安装包**，GUI 宿主 `ChatGPT.exe` 位于受保护的 `C:\Program Files\WindowsApps\OpenAI.Codex_<版本>_x64__2p2nqsd0c76g0\app\`。

| 通道 | 实测结果 | 能否带调试参数 |
|---|---|---|
| 直接 `CreateProcess` / `cmd start` / PowerShell `&` | **失败**：`拒绝访问`，Win32 `0x80070005` | 否 |
| `explorer.exe shell:AppsFolder\<AUMID>` | 能激活已有实例 | 否（不可靠传参） |
| **`IApplicationActivationManager::ActivateApplication(AUMID, args, 0)`** | **成功，参数原样透传** | **能** |

失败原因：`ChatGPT.exe` 的 ACL 中 `BUILTIN\Users` 有 `RX`，但文件带 AppX 执行标签
`S-1-19-512-4096:(I)(RX,D,WDAC,WO,WA)`，要求「仅带 package identity 的激活可执行」。
普通 `CreateProcess` 创建的进程没有 package identity，故被策略层拒绝（资源管理器会笼统显示为「Windows 无法访问指定设备、路径或文件」，容易被误读为权限或路径问题）。

COM 激活走的是应用模型激活通道，具备 package identity，因此能成功；且 `arguments` 参数会被**逐字透传到进程命令行**。

## 2. 关键约束：必须使用专属 user-data-dir

CDP 调试端口只有在**专属 user-data-dir** 下才会开启：

| 配置 | 结果 |
|---|---|
| 专属 `--user-data-dir` + `--remote-debugging-port=<port>` | **成功**：端口 2s 内监听；`/json/version` 返回 `Chrome/152.x`；`/json/list` 有 `app://-/index.html` |
| 默认 profile（用户手动打开的实例）+ 调试端口 | **失败**：端口始终不开（Electron 单实例锁按 user-data-dir 生效，新进程转交参数后退出） |

**结论：MCP 无法给用户手动打开的 Codex 挂 CDP；必须自己拉起受管实例。**

独立 profile **不丢数据**：项目列表、会话、登录态存于 `~/.codex/`（`.codex-global-state.json`、`config.toml`、`auth.json`），跨 profile 共享。受管实例默认 profile 目录：

- Windows：`%LOCALAPPDATA%\tianshu-mcp\codex-gui\profile`
- macOS（未启用）：`~/.tianshu-mcp/codex-gui/profile`

## 3. 安装发现

`src/agents/codex/discovery.ts`，顺序：

1. **显式路径**：`gui.exePath` 或 `command`（存在即用）。
2. **Appx 查询（权威，自动跟版本）**：`Get-AppxPackage -Name OpenAI.Codex` → `InstallLocation`；
   在 `<InstallLocation>\app\ChatGPT.exe` 校验存在；
   `AUMID = <PackageFamilyName>!App`（实测 `OpenAI.Codex_2p2nqsd0c76g0!App`）。
3. **扫盘回退**：`{SYSTEMDRIVE}\Program Files\WindowsApps\OpenAI.Codex_*_x64__*/app/ChatGPT.exe`，
   多版本共存时**按包版本降序取最新**（本机实测存在 `26.903.8094.0` 与 `26.903.9818.0` 两个版本目录）。
4. macOS：`dirs` 下 `ChatGPT`/`Codex` 可执行（`research`）。

**绝不硬编码**：版本号、`WindowsApps` 绝对位置、内核 `bin\<hash>` 目录。全部动态获取或通配匹配。

## 4. 启动与接管

`src/agents/codex/launcher.ts`（COM 激活）+ `instance.ts`（进程/端口/就绪）：

1. **复用优先**：枚举 `ChatGPT.exe` 根进程（排除 `--type=`/`crashpad`）；若某实例的 `--user-data-dir`
   属于本 MCP 且其端口上确有 Codex 页面 → 直接接管。
2. **端口避让**：`gui.cdpPort` 起，`cdpPortAuto` 时向后探测空闲端口。
3. **COM 激活**：`ActivateApplication(AUMID, "--user-data-dir=<专属> --remote-debugging-port=<port>", 0)`。
   内联 C# 经 `Add-Type` 注入，无第三方依赖。
4. **就绪等待**：轮询 `/json/list` 直到出现 Codex 页面（`app://` 协议或标题 ChatGPT/Codex），
   超时 `gui.launchTimeoutMs`（默认 60s）。
5. **页面收敛**：Codex 会额外暴露次级窗口（实测有 `app://-/index.html?initialRoute=%2Favatar-overlay`
   与 `type=webview` 的定价页）；`pickCodexPage` 排除 `overlay`、优先 `index.html`，避免连错窗口。

> 受管实例启动后**不会**自动关闭；任务结束保留现场，便于排查（`keptInstance: true`）。

## 5. 界面选择器与约束

**关键事实**：Codex 前端几乎不用 `data-testid`（全页实测仅 2 个），class 名含构建哈希
（如 `_ComposerLayout_kbwao_2`，跨版本必变）。因此定位以 `aria-label` + 可见文本为主，CSS 结构兜底。

| 语义键 | 主选择器 | 备注 |
|---|---|---|
| `chatInput` | `div.ProseMirror[contenteditable="true"]` | ProseMirror 富文本；必须走 CDP 输入，不能设 `value` |
| `sendButton` | `button[aria-label="发送"]` | **条件渲染**：输入框为空时不存在，出现即可发送 |
| `stopButton` | `button[aria-label*="停止"]` | 权威运行信号（生成期间替代发送按钮） |
| `newChat` | `button.sidebar-item` + 文案「新对话」 | |
| `projectPickerTrigger` | `button[aria-haspopup="dialog"][aria-label^="切换项目"]` | 真机实测文案为「切换项目：<名>」；侧栏另有「添加新项目」需排除 |
| `sourceFolderArea` | `[role="dialog"] button[class*="drop" i]` | 点是「添加 Codex 可读取和编辑的文件夹」按钮；**「源文件夹」是 label，不可点** |
| `createProjectButton` | `[role="dialog"] form button:last-of-type` | 标题 `<h2>` 同名，须优先可交互元素 |
| `projectItem` | `button[aria-label$="的项目操作"]` | 按前缀提取项目名 |
| `modelTrigger` | `button[aria-haspopup="menu"]`，**作用域=输入框容器 + 排除菜单栏** | 见下 |
| `permissionTrigger` | `button[aria-label="更改权限"]` | 文本如「完全访问」 |
| `messageArea` | `[class*="MainContentSurface"]` | 用于文本稳定兜底；**不可用裸 `main`/`#root`**（会混入导航壳） |

**真机踩坑（已修复）**：顶部菜单栏（文件/编辑/视图/帮助）同样带 `aria-haspopup="menu"`，
若不做排除，`modelTrigger` 会误命中菜单栏。故选择器支持 `excludes`（`[role="menubar"]`、`header`），
并在 CDP 层再按「文本含模型特征」挑选底部触发器。真机验证：解析结果为 `GPT-5.6 Sol 高`。

多语言：每个键提供中英双语候选（`texts` / `ariaLabels`）+ 结构选择器兜底；
运行期可用 `gui.selectors`（语义键 → 选择器）热修复 UI 漂移。

## 6. 模型与思考等级

`src/agents/codex/model.ts`。任务参数为**双字段**：

- `model`：如 `GPT-5.6 Sol`
- `reasoningLevel`：`低/中/高` 或 `low/medium/high`（内部归一为 `low|medium|high`）

交互：点开 `modelTrigger` → 在 `[role="menu"]` 内精确选模型 → 选思考等级 → 回读触发器文本校验
（期望 `<模型> <等级>`，不符则重试 ≤3 次，仍不符中止上报 `model_mismatch`）。

## 7. 项目绑定与新建

`src/agents/codex/project.ts` + `run.ts`。

- **匹配规则（决策 2）**：按目标目录的 **basename** 匹配 Codex 项目显示名，Windows 大小写不敏感；
  同名多命中 → 报 `project_ambiguous`，绝不猜。
- **已有项目**：点 `在 <名> 中开始新聊天`（回退点「<名> 的项目操作」）→ 回读底部工作区标识二次确认。
- **新建项目**（对齐截图流程）：点项目选择触发器 → 「新建项目」→ 点「源文件夹」中心空白区（**不要**直接点「创建项目」）→ 弹出 Windows **原生**文件夹对话框 → 键盘自动化填入**反斜杠**绝对路径并确认 → 确认源文件夹已回填 → 点「创建项目」。

原生对话框 CDP 无法触达，由 `src/agents/codex/dialog.ts` 用 UIA + `SendInput` 驱动，**fail-closed**：

- 只操作**基线中不存在**的新 `#32770` 对话框（基线由 `listCodexDialogs` 采集），绝不碰用户既有窗口。
- 只认属于 `ChatGPT.exe` 根进程、类名 `#32770`、标题匹配选择类的窗口。
- **对话框句柄用 Win32 `EnumWindows` 查找**：真机实测 Codex 的 `Select Project Root` 通过 UIA 顶层枚举会漏掉，`EnumWindows` + `AutomationElement::FromHandle` 才能稳定拿到。
- 地址栏无法唯一定位 / 未导航到目标路径 / 确认按钮未就绪 / 提交后未关闭 → 抛错中止，不猜。
- 启动时用 `closeStrayDialogs` 清理上一轮残留的原生对话框（否则会遮挡界面并阻塞本轮）。

**两个真机关键点**：

1. **必须 trusted 点击**：`element.click()` 是 untrusted 事件，应用会忽略而不弹原生选择器；
   必须用 CDP `Input.dispatchMouseEvent` 打真实鼠标事件，且落点要经 `elementFromPoint` 校验命中目标
   （「源文件夹」是 `<label>` 不可点击，真正可点的是文字为「添加 Codex 可读取和编辑的文件夹」的按钮）。
2. **应用窗口必须在前台**：原生选择器只在应用窗口处于前台时弹出。Windows 前台锁会拒绝后台进程的
   `SetForegroundWindow`，因此本适配器用**应用模型激活**（COM，与启动同一通道的受支持前台请求）
   把窗口带到前台再点击。

> **已知限制（诚实标注）**：新建项目整链路依赖窗口前台状态。真机上各步骤均已分步验证通过
> （对话框确实弹出、键盘自动化提交成功、创建项目对话框正确回填源文件夹），但在**完全无人值守**
> 的环境下，若系统前台策略阻止窗口置前，可能失败并返回 `project_create_failed`。
> **既有项目**的绑定与后续全流程（含验收/返修）不受此限制，已稳定真机闭环。

## 8. 运行检测

`src/agents/codex/liveness.ts`（决策 7/8）：

1. **停止按钮为权威运行信号**：出现即 `running`，绝不在此时判完成。
2. **文本稳定仅在曾观测到运行信号后才作为完成证据**——避免停止钮选择器漂移时，
   把「其实还在生成、只是 DOM 恰好静止」误判为完成（这是 TraeWork 早期误判的教训，见
   [traework-task-liveness-plan](../.zcode/plans/traework-task-liveness-plan.md)）。
3. 若**始终未观测到**运行信号 → 不判完成，转入空闲计时，最终 `idle_timeout`：
   结束本轮但**不终止实例**（失败开放，不比现状更糟）。
4. 总超时 `taskTimeoutMs`（默认 30 分钟）+ 空闲超时 `idleTimeoutMs`（默认 10 分钟）。

> 停止按钮已真机确认有效：生成期间 `button[aria-label*="停止"]` 出现，实测运行判定日志为
> `pending → running(stop_button) → finished(stop_button_gone+text_stable)`。
> 若某版本文案变化导致未命中，则按上述第 3 条失败开放，不会误判完成。

## 9. 验收与返修

- **验收（决策 9/20）**：复用既有 `AcceptanceEngine`（`src/verify/acceptance.ts`），
  优先级 `extraChecks` > 项目 `.tianshu-mcp/acceptance.json` > `projects.json` 补录 > **默认集**；
  默认集读 `package.json` 的 `scripts` 推导 `typecheck/lint/test/build`。
  无可执行命令 → 标注为**弱验收**（`src/agents/codex/verify.ts`）。
- **修复计划（决策 11/12）**：验收不通过时由 **MCP 自动生成**计划文档，落在**项目内**
  `gui.fixPlanDir`（默认 `.zcode/plans/`），文件名为 `codex-fix-r<N>.md`（**含轮次号、每轮独立、不覆盖**）。
  因文件名在发送前已知，可直接写进修复指令，无需从回复回读。
- **返修循环（决策 10）**：最多 `autoFixRounds` 轮（Codex 默认 **5**）；每轮向**同一会话**发送修复指令
  （引用该 md + 失败命令原始输出），再验收。轮次用尽 → `needs_attention`。

## 10. 任务参数

| 字段 | 说明 |
|---|---|
| `model` | 模型名，如 `GPT-5.6 Sol` |
| `reasoningLevel` | `低/中/高` 或 `low/medium/high` |
| `planDoc` | 计划文档路径（相对项目根或绝对），拼进初始指令 |
| `designSystem` | 设计系统目录路径，拼进初始指令 |
| `autoVerify` / `autoFixRounds` | 自动验收 / 返修轮数（上限 10，Codex 默认 5） |

初始指令形如：`根据计划文档(<planDoc>)和设计系统(<designSystem>)，进行项目开发`。
`planDoc`/`designSystem` 会先经引用校验（必须在项目内且存在），越界/缺失直接拒绝。

## 11. profile 配置要点

```jsonc
"codex": {
  "driver": "gui",
  "adapter": "codex-gui",
  "executableDiscovery": {
    "appxPackageName": "OpenAI.Codex",                 // Appx 优先查询
    "installRelativeExe": ["app/ChatGPT.exe"],
    "scanRoots": ["{SYSTEMDRIVE}/Program Files/WindowsApps"],  // 扫盘回退
    "scanPattern": "OpenAI.Codex_*_x64__*/app/ChatGPT.exe"
  },
  "gui": {
    "activation": "msix-com",                          // 必须：COM 激活
    "userDataDir": "{LOCALAPPDATA}/tianshu-mcp/codex-gui/profile",  // 必须：专属 profile
    "cdpPort": 9333, "cdpPortAuto": true,
    "permissionMode": "完全访问",
    "fixPlanDir": ".zcode/plans",
    "defaultAutoFixRounds": 5,
    "launchTimeoutMs": 60000, "pollIntervalMs": 3000,
    "stableRounds": 4, "idleTimeoutMs": 600000,
    "selectors": {}                                     // UI 漂移热修复
  }
}
```

## 12. 排障

先跑真机诊断脚本：

```bash
node scripts/probe-codex.mjs            # 只读：安装发现 + 进程/端口现状
node scripts/probe-codex.mjs --launch   # 完整：激活受管实例 + 连 CDP + 实测选择器
```

| 现象 | 可能原因 | 处理 |
|---|---|---|
| Appx 查询超时/失败 | PowerShell 慢或执行策略受限 | 脚本自动回退扫盘；确认可运行 `Get-AppxPackage` |
| 激活成功但端口不开 | 复用了默认 profile（单实例锁吞掉参数） | 确认 `gui.userDataDir` 是专属目录 |
| `拒绝访问` 直启 exe | AppX 策略禁止无 identity 执行 | 走 COM 激活（本适配器默认）；勿改为直接 spawn |
| 找不到输入框 | 仍在渲染/未登录 | 加大 `launchTimeoutMs`；检查是否登录页（会返回 `needs_user`） |
| `model_mismatch` | 模型名或等级文案不符 | 核对 `model`/`reasoningLevel`；必要时 `gui.selectors` 热修 |
| 长时间不结束 | 停止钮选择器未命中 | 属失败开放路径，最终 `idle_timeout`；用 `--launch` 实测真实停止钮文案 |
| 项目绑定失败 | 原生对话框被拦截/路径含特殊字符 | 看 `agent-N.log` 的 `[codex]` 行；确认键盘自动化权限 |
| `project_create_failed` 且日志「窗口置前：未确认」 | Windows 前台锁阻止窗口置前，原生选择器未弹 | 保持受管 Codex 窗口可见并置前（勿被其他窗口遮挡）；或改用**已有项目**（在 Codex 侧先建一次项目）后重试 |
| 点击源文件夹后无原生对话框 | 用了 untrusted 点击或点到了「源文件夹」label | 确认走 `clickTrusted`（trusted 事件 + 命中校验）且目标是 drop zone 按钮 |

## 13. 已知限制

- macOS 全流程未验证（`status: research`），相关代码不参与就绪判定。
- **新建项目依赖窗口前台**：原生文件夹选择器只在应用前台时弹出。各步骤已分步真机验证通过，
  但完全无人值守下若系统阻止窗口置前，可能返回 `project_create_failed`。既有项目绑定与
  验收/返修闭环不受影响（已稳定真机通过）。
- Codex 前端文案/选择器随版本漂移；已用中英双语 + 结构兜底 + `selectors` 热修缓解。
- 原生文件夹对话框依赖 UIA 控件结构（`AutomationId 1001/41477/1`），系统更新可能变化；
  失败时 fail-closed，不会误操作既有窗口。
- 受管实例与用户手动打开的实例互不干扰；但**同一时刻只应有一个受管实例**（adapter 内置串行门）。
- 本适配器取代了早期 `codex exec` CLI 无头路径（见计划决策 19）；如需无头执行需另立 profile。
