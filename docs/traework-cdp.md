# TraeWork GUI 驱动接入（CDP）

本文档说明 `tianshu-mcp` 如何通过 Chrome DevTools Protocol（CDP）驱动 TraeWork（TRAE SOLO CN）完成
「派活 → 等待开发完成 → 验收 → 失败返修 → 再验收」闭环。英文版见 [traework-cdp.en.md](traework-cdp.en.md)。

---

## 1. 为什么走 GUI 而不是 CLI/HTTP

| 路线 | 结论 |
|---|---|
| 无头 CLI（`trae agent exec` 之类） | **不存在**。TraeWork 只提供 VS Code 家族 CLI（open/serve-web/扩展管理） |
| HTTP 直调网关 | **不可行**。LLM/agent 请求在 TTNet 层做 TDE 透明加密（算法在 `aha_net.dll`/`sscronet.dll` 的 Cronet OpaqueData 层），无法在客户端外构造 |
| **CDP 驱动桌面 UI** | **可行且已实测**（本文档路线） |

CDP 驱动走的是完整客户端链路：renderer → ai_agent → TDE → 网关，结果从 DOM 提取。
这与 [oh-dsh-trae-api](https://github.com/) 项目验证过的机制一致。

> 重要：旧结论「TraeWork unsupported」只证伪了**无头 CLI 路线**，未检验 GUI 路线。本方案已修正该结论。

---

## 2. 前置条件

- Windows 10/11（macOS 机制相同但**未验证**，见 §7）
- TraeWork 已安装且**已登录**
- TraeWork 以调试端口启动，且**窗口保持可见**（发送依赖模拟输入）：
  ```bat
  "D:\TRAE Work CN\TRAE SOLO CN.exe" --remote-debugging-port=9222
  ```
- 无需安装额外依赖：CDP 客户端只用 Node 内置 `http` + 全局 `WebSocket`（Node ≥ 20）

> `tianshu-mcp` 会**优先复用**已带端口的实例；仅在没有可用实例时才带端口启动新实例。
> 它**绝不会终止用户自己启动的实例**（见 §6 安全红线）。

---

## 3. 快速上手

```jsonc
// 通过 MCP 调用（天枢 / 任意 MCP 客户端）
run_task({
  "projectPath": "D:\\Trae项目\\my-app",   // 绝对路径
  "agentId": "traework",
  "task": "根据计划文档(plan.md)和设计系统(.design 目录)，实现首页",
  "model": "GLM-5.3",                      // 可选：指定 TraeWork 使用的模型
  "mode": "Code",                          // 可选：Work | Code | Design
  "autoVerify": true,
  "autoFixRounds": 2,
  "taskTimeoutMs": 1800000
})
```

执行序列（对应需求文档的 8 个步骤）：

1. **探测/启动** TraeWork（复用已带端口实例，否则带端口启动）
2. **等待 UI 就绪**（聊天输入框出现，避免端口就绪但 DOM 未渲染）
3. **新建会话**（点「新建任务」，每任务一个干净会话）
4. **确定并切换面板模式**：显式 `mode` 参数 > 任务书文本识别（「切换到 Code 模式」等）> 保持 `Work`；
   切模式失败即响亮失败
5. **在目标模式内绑定项目文件夹**：点「选择文件夹（可选）」→ 在下拉里按项目名/路径匹配；
   未命中则点下拉底部「选择文件夹」→ 经受限 computer-use 驱动 Windows 原生对话框；
   绑定后复核「模式 + 项目」双双就位
6. **（可选）切换模型**：严格验证，不一致即报错，绝不静默用错模型
7. **写入任务书**（回读校验）→ **按 Enter 发送** → 轮询 DOM 直到出现完成标志
8. **自动验收**：命令检查（typecheck/lint/test/build，缺则跳过）+ 代码分析（相对 git 基线）
9. **验收失败**：自动生成修复计划文件 `rework-<taskId>-r<N>.md`，并把文件名写进同会话的返修消息
10. **再验收**，直到通过或轮次用尽（`needs_attention`）

> **为什么第 4 步在绑定之前？** 实测（2026-09-08）：TraeWork 的 Work/Code/Design **各自维护独立的项目绑定**，
> 切换模式会把输入栏项目换成该模式上次使用的项目。因此必须先切模式、再在目标模式里绑定项目。
>
> **模式识别优先级**：显式 `mode` 参数 > 任务书文本 > `Work`。
> 文本识别支持「切换Work模式 / 切换到 Code 模式 / use design mode / 工作模式 / 代码模式 / 设计模式」等中英混写。

真机探针（诊断用，需 TraeWork 在跑）：

```bash
node scripts/probe-traework.mjs selectors          # 检查选择器是否命中
node scripts/probe-traework.mjs project <绝对路径>  # 新建会话 + 绑定项目
node scripts/probe-traework.mjs send "任务书"       # 端到端发一条并取回复
```

---

## 4. 配置项（`agent-profiles.json` 的 `traework` 段）

内置默认值见 `src/agents/builtin.ts`；用户数据目录 `~/.tianshu-mcp/agent-profiles.json` 可整键覆盖。

```jsonc
{
  "profiles": {
    "traework": {
      "displayName": "TraeWork (TRAE SOLO CN)",
      "type": "cli",
      "driver": "gui",          // spawn=子进程；gui=桌面 UI 自动化
      "status": "ready",
      "command": null,          // 留空则用 executableDiscovery 探测
      "executableDiscovery": {
        "dirs": [
          "D:/TRAE Work CN",
          "{ProgramFiles}/TRAE WORK CN",
          "{LOCALAPPDATA}/Programs/TRAE WORK CN",
          "/Applications/TraeWork.app/Contents/MacOS"
        ],
        "fileNames": ["TRAE SOLO CN.exe", "TraeWork", "TraeWork CN"]
      },
      "gui": {
        "cdpPort": 9222,             // 调试端口
        "cdpPortAuto": true,         // 占用则自动避让
        "cdpPortRange": 20,          // 避让尝试范围
        "exePath": null,             // 显式可执行路径（可选，优先于探测）
        "exeArgs": ["--remote-debugging-port=<port>"],
        "windowMode": "reuse",       // reuse=复用已有实例；launch=总是新起
        "launchTimeoutMs": 60000,    // 等待 CDP 就绪
        "pollIntervalMs": 3000,      // 回复轮询间隔
        "stableRounds": 12,          // 无完成标志时，连续多少次无变化判定结束
        "modelSwitch": true,         // 是否按任务 model 切模型
        "modeSwitch": true,          // 是否按任务 mode 切面板模式（Work/Code/Design）
        "freshSession": true,        // 每任务新建会话
        "selectors": {}              // 选择器覆盖（UI 升级漂移时热修复）
      }
    }
  }
}
```

### 4.1 选择器覆盖

UI 升级导致选择器失效时，**无需改代码**——在 `gui.selectors` 里按键覆盖：

```jsonc
"selectors": {
  "chatInput": ".my-new-input-class",
  "projectButton": "[class*='newProjectButton']"
}
```

可用语义键（见 `src/agents/traework/cdp/selectors.ts`）：`chatInput`、`newTask`、`taskListItem`、
`taskListGroupName`、`modeTab`、`modelTrigger`、`modelTriggerValue`、`modelOption`、`modelList`、
`modeSwitcher`、`projectButton`、`cascadeMenu`、`cascadeMenuItem`、`cascadeMenuItemTitle`、
`cascadeMenuItemSubtitle`、`cascadeMenuGroupHeader`、`cascadeMenuFooter`、`messageContainer`、`toolCard`。

每个键都有「主选择器 + 回退候选」，主选择器未命中会按顺序尝试回退。

---

## 5. 实测选择器清单（TraeWork 1.107.1）

| 语义键 | 选择器 | 说明 |
|---|---|---|
| chatInput | `.chat-input-v2-input-box-editable` | 聊天输入框（contenteditable） |
| newTask | `.task-list-new-task-item` | 「新建任务」按钮 |
| taskListItem | `.taskText` | 会话标题；注意 `.task-list-new-task-item` 是「新建任务/插件市场」等按钮，**不是**会话项 |
| taskListGroupName | `.task-list-group-name` | 任务列表的项目分组名（= 项目文件夹名，对应图1） |
| modeTab | `[class*="mode-switcher-btn"] [class*="tab"]` | Work/Code/Design 分段 |
| projectButton | `[class*="projectButtonPlaceholder"]` | 未绑定态「选择文件夹（可选）」；已绑定态类名消失、文本变为项目名 |
| cascadeMenu | `[class*="cascadeMenu"]` | 项目文件夹下拉浮层 |
| cascadeMenuItem | `[class*="cascadeMenuItemWithSubtitle"]` | 下拉项；内层 `cascadeMenuItemInner/Title/Subtitle` 会被前缀选择器误命中 |
| cascadeMenuItemTitle / Subtitle | `[class*="cascadeMenuItemTitle"]` / `[class*="cascadeMenuItemSubtitle"]` | 项目名 / 项目路径 |
| cascadeMenuFooter | `[class*="cascadeFooterButton"]` | 底部「选择文件夹」按钮 |
| modelTrigger / modelTriggerValue | `.core-model-select-trigger` / `-value` | 模型下拉 |
| modelOption / modelList | `.core-model-select-model-item` / `-list` | 模型项（虚拟滚动） |
| messageContainer | `.message-list-cache-container` | 消息容器（发消息后出现） |
| toolCard | `.core-toolcall-base-card,…` | Trae 原生工具卡片 |

---

## 6. 安全红线（重要）

以下约束源自一次**真实事故**：验证期间用 `taskkill /PID <pid> /T /F` 清理测试实例时，
误杀了用户正在使用的 TraeWork（数据完好，已恢复）。由此固化为硬性规则：

1. **默认复用**：`windowMode="reuse"`，已有可用实例直接复用，绝不新起第二个。
2. **绝不按进程树强杀**：`releaseInstance` 只终止**本模块创建**的 PID，且**不带 `/T`**。
3. **终止前核对命令行**：读到的命令行必须同时包含本模块注入的 `--remote-debugging-port=<port>`
   与可执行文件名，否则**放弃终止并告警**（宁可遗留窗口，不可误杀用户会话）。
4. **原生路径**：传给 GUI 进程的路径一律用 Windows 原生形式，禁止 POSIX 路径。
5. **computer-use 白名单**：内置桌面自动化**仅**允许 TraeWork 的文件夹选择对话框
   （标题匹配 `Select Project Folder` 等 + 宿主进程为 `TRAE SOLO CN.exe`），
   其他任何窗口（浏览器、终端、编辑器、系统对话框）一律拒绝并抛
   `COMPUTER_USE_DENIED`。见 `src/agents/traework/computeruse/guard.ts`。
6. **凭证零接触**：本 MCP 不读取、不解密、不转发任何 TraeWork 登录态；CDP 只驱动 UI。

---

## 7. 已知限制

- **窗口必须可见**：发送依赖模拟输入，最小化/隐藏窗口时可能失败。
- **单会话串行**：TraeWork 是单会话 UI，所有任务经串行队列；沿用「每项目串行 + 全局并发闸」。
- **完成判定为启发式**：以 DOM 完成标志「由AI生成」为主，叠加稳定兜底（默认 36s 无变化）与任务级超时。
  长回复有分段停顿时，兜底阈值可通过 `gui.stableRounds` 调整。
- **模型切换依赖下拉**：目标不在下拉（未解锁权益/名称不符）时明确失败，不会静默用错模型。
- **UI 升级会漂移**：选择器集中在 `selectors.ts`，可经 profile 覆盖；`scripts/probe-traework.mjs` 用于诊断。
- **macOS 未验证**：CDP 机制平台无关，但可执行探测与原生对话框驱动（AppleScript 路线）尚未在 macOS 实测。
  当前 macOS 下原生对话框路径 **fail-closed**（明确报错并提示手动先在 TraeWork 打开该项目一次）。
- **伪流式**：DOM 是块级重建，无法安全切增量；完成时一次性取回全文。

---

## 8. 实测踩坑记录

| 现象 | 根因 | 处理 |
|---|---|---|
| 项目按钮找不到 | 该按钮**只在 Work 模式**出现（Code/Design 没有） | `ensureMode("Work")` 先切模式 |
| 下拉项匹配到「新建任务」 | `.task-list-new-task-item` 与会话项同类名前缀 | 会话项改用 `.taskText` |
| 下拉项读成空/错乱 | `cascadeMenuItemInner/Title/Subtitle` 被前缀选择器误命中 | 主选择器要求 `WithSubtitle`，标题/副标题单独取 |
| 输入框内容为空 | `insertText` 偶发丢失 | 回读校验，为空重试一次 |
| 路径写入后变成 `D:Trae项目<TAB>s-e2e-smoke` | JS 模板字面量把 `\t` 解释成制表符 | 路径改经**环境变量**传入 PowerShell |
| 原生对话框点不动 | 第三方工具（Snipaste）抢前台焦点，SendKeys/点击落到别的窗口 | `AttachThreadInput + BringWindowToTop + SetForegroundWindow` 强制前台 |
| 原生对话框检测不到 | 它是 TraeWork 主窗口的**后代窗口**，`TreeScope.Children` 看不到 | 改用 `TreeScope.Descendants` |
| 原生对话框确认按钮找不到 | 该 Win32 选择器是 DirectUI，确认按钮是 Pane（无 InvokePattern） | 取矩形坐标后用 `mouse_event` 点击 |
| 新实例启动后元素全找不到 | CDP 端口先就绪、DOM 尚未渲染 | `waitForUi()` 等聊天输入框出现（最长 60s） |
| 已绑定项目仍走选择流程 | 已绑定时 placeholder 类名消失 | `readBoundProject()` 先读输入栏文本，命中即复用 |
| 误杀用户 TraeWork | `taskkill /T` 杀进程树波及用户实例 | 见 §6：复用优先 + 命令行核对 + 不带 `/T` |

---

## 9. 实现结构

```
src/agents/traework/
├── adapter.ts            AgentAdapter 实现（run 执行面）
├── run.ts                单轮任务编排（探测→会话→项目→模型→发送→轮询）
├── launcher.ts           端口探测/避让、复用判定、带端口启动、安全释放
├── cdp/
│   ├── client.ts         CDP 连接与 DOM/输入操作（Node 内置能力，无第三方依赖）
│   └── selectors.ts      选择器表（主选择器 + 回退 + profile 覆盖）
├── ui/
│   ├── session.ts        新建会话、模式切换、项目文件夹绑定
│   ├── composer.ts       任务书输入、回读校验、发送
│   ├── model.ts          模型下拉收集与严格切换
│   └── reply.ts          回复提取与完成判定（纯函数，全量单测）
└── computeruse/
    ├── guard.ts          白名单守卫（仅允许 TraeWork 文件夹对话框）
    └── dialog.ts         原生对话框驱动（Windows UI Automation）
```

---

## 10. 验证记录（2026-09-08）

| 项 | 结果 |
|---|---|
| CDP 连接 | ✅ `--remote-debugging-port=9222` 连通，页面目标为 `solo-lite.html` |
| 选择器命中 | ✅ 输入框/新建任务/任务列表/模式/模型下拉/项目按钮/下拉项/底部按钮均实测命中 |
| 项目绑定 | ✅ 未命中下拉时经原生对话框成功登记 `D:\Trae项目\ts-e2e-smoke`（`state.vscdb` 条目 18→19） |
| 模型切换 | ✅ 切换到 `GLM-5.3` 并严格验证 |
| **端到端** | ✅ `run_task(agentId=traework, model=GLM-5.3, autoVerify=true)` 驱动 TraeWork 创建 `result.txt`，自动验收通过（`succeeded`，changedFiles `result.txt`） |
| 单测/集成 | ✅ 153/153 通过（新增 81 项，含返修闭环与竞态回归） |
| lint / typecheck / build | ✅ 全绿 |
| **CI（GitHub Actions）** | ✅ **7/7 全绿** —— ubuntu/macos/windows × Node 20/22 + npm tarball 检查（run 34222781967，commit `e8c59cc`） |

### 10.1 实现期修复的两个既有缺陷

1. **rework 反馈竞态（预存 bug，负载下偶发、CI Windows/Node22 命中）**
   - 现象：`rework_task(feedback)` 后返修轮拿不到 feedback，任务卡在 failed。
   - 根因：终态快照先落盘，调用方看到 failed 后立即写入 `reworkFeedback`；而上一轮
     `startTask` 的**收尾**会 `delete meta.reworkFeedback`，把刚写入的新反馈一起抹掉。
   - 修复：改为在 `startTask` **启动时**原子取走并清空 feedback，不再在收尾 delete。
   - 回归：`test/integration/rework-feedback-race.test.ts`（连续 3 轮「失败→立即 rework」）。
2. **`projectBasename` 跨平台（Linux/macOS CI 失败）**
   - 现象：Linux/macOS 上 `path.basename("D:\\a\\b")` 返回整串（POSIX 不把 `\` 当分隔符）。
   - 修复：显式按 `\` 与 `/` 切分。

> 真机测试需 TraeWork 运行，**不入 CI**（见 `docs/acceptance-config.md` 的测试分层说明）。
