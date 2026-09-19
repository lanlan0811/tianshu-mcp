# tianshu-mcp v0.5.5 发布说明

[English](release-v0.5.5.en.md)

**核心主题**：**新增第四个 GUI agent —— Kimi Code 适配（`agentId=kimicode`）**。这是第四次「调教式训练」的交付：让本 MCP 能驱动 Kimi Code 桌面端完成「定位安装 → 启动 → 定位/新建任务文件夹 → 选模型与思考档位 → 派活 → 运行检测 → 客观验收 → 失败返修 → 再验收」的完整闭环。

本版本为 **PATCH**：新增一个 agent 接入面，**既有三个 GUI agent（TraeWork / ZCode / Codex）与全部既有工具签名保持不变**。唯一需要消费方注意的是一处**枚举扩展**——`run_task.reasoningLevel` 的取值域新增 `max` / `on` / `off`（原 `低/中/高/low/medium/high` 全部保留）。

## 为什么 Kimi Code 需要单独一套驱动

Kimi Code（Moonshot AI，实测版本 1.0.2）是**普通 Electron 安装**，因此**不需要** Codex 那套 MSIX `IApplicationActivationManager` COM 激活通道，直接 `--remote-debugging-port` 注入即可接管 CDP。但它与既有三个 agent 有四处实质差异，决定了本次的实现形态：

| 差异 | 实测事实 | 本版本的应对 |
|---|---|---|
| **双渲染进程** | 模型菜单 / 思考档位 / 执行模式菜单经应用内 `browserOverlayOpenMenu()` 渲染在**独立的 `Kimi Browser Overlay` 渲染进程**：点击 `model-pill` 后主窗口 DOM 节点数不变、**不产生任何菜单节点** | CDP 客户端同时持有主窗口与浮层两个页面；菜单开关以浮层的 `visibilityState` 为唯一权威判据（关闭后 DOM 可能短暂残留） |
| **任务以「会话文件夹」组织** | 侧栏 →「会话」→ 文件夹分组（如 `tianshu-mcp`）→ 会话项；输入框上方有工作区触发器 `button.ws-chip` | 以**归一化完整路径**为唯一绑定判据（工作区菜单项含 `span.ws-path` 完整路径），名称仅作辅助；同名不同目录一律 fail-closed |
| **思考档位不是三档** | 官方模型为 `Low / High / Max`；非官方模型（如 kiro 的 `stepfun/step-3.7-flash:free`）只有 `On / Off` | **不内置模型名单**，改为按**界面实际渲染的档位集合**校验请求值；请求界面不存在的档位在发送前响亮失败，绝不静默沿用 |
| **模型有二级入口** | 快捷菜单仅列官方模型；非官方模型必须走「更多模型…」→ 主窗口「切换模型」对话框 | 三级选择：pill 回读 → 浮层快捷菜单直选 → 「更多模型…」对话框搜索 + 精确匹配选行 |

## 新增能力

### 安装探测

顺序为：显式 `gui.exePath` / `command` → **固定盘相对路径模板**（`preferredDrives` 默认 D 盘优先）→ 卸载注册表 → 标准安装目录 → `PATH`。候选文件名必须精确匹配 `Kimi Code.exe`（大小写不敏感），并在命中后读取文件版本。**代码中不出现任何用户绝对路径**——`D:\Kimi-Code\Kimi Code\Kimi Code.exe` 只是本机的探测样本。

### 实例生命周期

- 已有受管实例且 CDP 端口有效 → 复用。
- 已有实例但**未开启 CDP**（Electron 单实例锁会让带端口的新进程转交参数后退出）→ 转 `needs_user(close_existing_instance)`，**绝不自动关闭用户进程**，也**不另起专属 `user-data-dir`**（会丢会话文件夹与登录态）。
- 端口探测做**产品校验**（UA 含 `kimi-code-app/`、页面 URL 前缀 `app://renderer/`），避免误连其他 Electron 应用。

### 模型与档位

```jsonc
// 官方模型：档位为 Low / High / Max
{ "agentId": "kimicode", "model": "K3", "reasoningLevel": "High" }

// 非官方模型（官方额度用尽时的可用路径）：档位只有 on / off
{ "agentId": "kimicode", "model": "stepfun/step-3.7-flash:free", "reasoningLevel": "on" }
```

- `model` 直接填**界面模型名**（`K3`、`K2.8 Preview`、`stepfun/step-3.7-flash:free` …），必填。
- 档位校验以**界面档位集合**为准：官方模型收到「中」、非官方模型收到「高」都在发送前报参数错误。
- 省略 `reasoningLevel` 时：官方模型沿用界面当前值；非官方模型强制 `on`。
- 不支持 `mode` 参数（与 ZCode / Codex 一致）；`allowCreateProject` 不适用。

### 执行模式与发送

- 强制「完全自动」并在切换后**回读确认**（三档为 始终询问 / 必要时询问 / 完全自动），无法确认即 `permission_unknown` 硬失败。
- 任务书沿用既有组装逻辑（`task` + 上下文 + 已验证项目引用 + 返修反馈）与任务标记机制。
- 发送确认的**必需锚点**是会话 id 与标记落地，辅以「输入框已清空 / 运行信号出现 / 用户消息复制按钮」；60 秒有界窗口内拿不到任一证据即 `send_unknown` 并保留现场，**绝不重发**。

### 运行检测

- **权威运行信号**：`button.stop`（`aria-label="中断"`）与 `button.send` 的 `is-starting` class。实测发送后 0.5–1.2 秒出现、完成后消失。
- 无运行信号时要求回复连续 `stableRounds` 轮不变**才开始**空闲计时；长思考不会被提前判完成。
- 失败态（界面出现「继续」按钮 + 「模型请求失败，本轮对话已中止」文案）不判完成。

### 用户介入与恢复

| `needsUserKind` | 触发 | `continue_task` 恢复行为 |
|---|---|---|
| `close_existing_instance` | 有进程但无有效 CDP 端口 | 复检环境后**补发完整任务书** |
| `login_required` | 停在登录/引导页 | 复检环境后补发完整任务书 |
| `setup_recovery` | 工作区绑定失败 / 原生对话框不可用 / 预算耗尽 | 复检后继续，**不向其它工作区发送任务** |
| `agent_question` | 界面出现提问 | 把回答**写回原会话**（不重发任务书） |
| `user_confirmation` | 等待用户确认（`gui.selectors.userGate` 或 stall 判定） | **仅重连观察**，用户确认文本绝不发给模型 |
| `system_permission` | 原生对话框需要辅助功能权限 | 复检后继续 |

定位不到原会话一律 `session_lost` fail-closed，**绝不退化为「打开最近会话」**。

### 取消与超时

- `cancel_task` 照 Codex M14 语义：尽力点击 `button.stop` 并在 `gui.cancelWaitMs`（默认 15s）内有界等待界面空闲；**未确认停止时终态如实明示**「Kimi Code 窗口中的任务可能仍在继续」。
- 派发前若受管实例仍有运行信号，先尽力停止；仍不空闲则以 `instance_busy` 硬失败，防 turn 交叠。
- `task_timeout` / `idle_timeout` / `cdp_timeout` / `cdp_disconnected` 一律保留实例，写 `agentEndReason` + `keptInstance`，不关窗、不伪造「进程树已终止」。

### 原生「添加工作区」对话框

未登记的工作区经原生对话框导入：`#32770` + 标题「添加工作区」，编辑框 `AutomationId=1152` + `ClassName=Edit`，确认按钮 `AutomationId=1`。要点：

- 路径以**原生形式**（`D:\a\b`：盘符大写 + 反斜杠）经 `WM_SETTEXT` 写入并 `WM_GETTEXT` 回读，回读不一致**绝不点确认**。
- 路径只经**环境变量**进入 PowerShell 脚本，不拼进脚本源码（规避转义与 CJK 代码页破坏）。
- 只操作**新出现**且标题/类名/属主进程三重校验通过的窗口；确认/取消按钮**不支持 UIA `InvokePattern`**，必须 Win32 坐标点击。
- 启动时清理本进程残留的 `#32770`（模态框会吞掉主窗口点击）。

### 诊断探针

```sh
npm run build
node scripts/probe-kimicode.mjs all        # 只读诊断：install / process / cdp / workspaces / session / models / liveness / dialogs
node scripts/probe-kimicode.mjs install    # 单跑某一项
```

默认**只读**；只有显式 `--launch` 才会启动实例（会打印醒目提示）。探针无发送能力。UI 升级导致选择器漂移时，先用它定位，再用 `gui.selectors` 覆盖热修复。

## 真机验证（Windows 10 x64 + Kimi Code 1.0.2）

| 场景 | 结果 |
|---|---|
| 自启动实例（无既有进程） | 通过：`spawn` + 端口 9666，产品校验命中，主窗口与 composer 就绪 |
| 复用受管实例 | 通过 |
| 已登记工作区绑定 | 通过：以完整路径命中并回读 `ws-chip` |
| **未登记工作区导入** | 通过：原生对话框全阶段（`initialize` → `find-new-dialog` → `title-ok` → `find-folder-edit` → `input-path` → `find-confirm-button` → `submit-once` → `done`）后绑定回读通过 |
| 模型与档位（非官方模型） | 通过：快捷菜单未命中 → 自动转「更多模型…」对话框搜索选中 → 回读一致；档位 `On` 回读一致 |
| 模型与档位（官方模型） | 通过：`K3` 的 `Low/High/Max` 三档实测切换与回读（`K3 · Max` → `K3 · High`） |
| 执行模式 | 通过：回读「完全自动」 |
| **自动验收** | 通过：`2/2` 项命令检查通过（含 `git-diff-check`） |
| **失败 → 返修 → 再验收** | 通过：第 0 轮验收失败 → 生成返修计划（含失败项、命令、退出码）→ **同会话**（会话 id 一致）回读模型/档位/模式后发送返修 → 第 1 轮验收通过 → `succeeded` |
| 工作区无污染 | 通过：验证产物落在 gitignore 目录，`git status` 无额外变更 |

**未在真机覆盖（如实标注）**：取消（`cancel_task` 点停 GUI）、提问续答（`agent_question`）、同名工作区歧义——这三项**仅由 hermetic 集成测试覆盖**；macOS 为 `research` 且 fail-closed（可执行探测与原生对话框驱动未在 macOS 实测）。另外，本轮真机验证使用**非官方免费模型**完成（官方模型额度在验证期间用尽），官方模型的档位切换在侦察阶段单独验证过。

## 实现期发现并修复的真机缺陷

| # | 现象 | 根因 → 修复 |
|---|---|---|
| 1 | 工作区下拉面板打不开（点击被吞） | 客户端只**检测** `pageHidden` 却从不置前；Kimi Code 启动后窗口常在后台，Chromium 节流页面吞掉合成鼠标事件。→ 连接后主动 `Page.bringToFront` + 焦点模拟，并**等 `visibilityState` 收敛**（实测异步生效需数百毫秒）；每次点击前若发现隐藏则先恢复 |
| 2 | 新建会话点击被吞后直接 fail-closed | 原先只点一次全局入口、再点一次分组入口。→ 改为以「`ws-chip` 已挂载」为准的**有界周期重试**，交替使用两个入口（与 `openWorkspacePanel` 同一思路） |
| 3 | **停在会话页时新建会话必然失败**（间歇性，极易误判为 UI 漂移） | `newSession` 曾配宽泛回退 `aside.side button`：草稿页侧栏按钮少（侥幸命中 1 个）能成功，停在会话页时侧栏按钮变多（实测命中 **26 个**）→ `click()` 的坐标点击要求唯一匹配，退化到 DOM click，而该按钮只认 trusted 点击，两条路同时失效。→ 回退选择器收窄为锚定 `btn-new-chat`；新增 `clickFirst` 供「任取一个都成立」的语义键（工作区分组的新建入口天然多命中）使用；新增 `kimicode-selectors` 回归用例把「窄回退」固化成断言 |
| 4 | 草稿失败只剩「选择器未挂载」，无法定位 | → 失败诊断附「当前页面 + 窗口是否在前台」 |

## 升级指引

1. **既有配置无需改动**，TraeWork / ZCode / Codex 行为与之前完全一致。
2. 想用 Kimi Code：确保已安装并登录，然后在 `run_task` 传 `agentId="kimicode"` + `model`。首次派发时**建议先关闭手动打开的 Kimi Code 窗口**（否则会得到 `needs_user(close_existing_instance)`，这是刻意设计：不关闭用户进程、也不另起 profile 丢登录态）。
3. 目标目录未登记为工作区时，会经原生「添加工作区」对话框导入（需要窗口可被前台激活）。
4. 若对 `reasoningLevel` 做穷举校验，需补 `max` / `on` / `off` 三个取值。
5. 官方模型额度用尽时可用非官方模型（如 `stepfun/step-3.7-flash:free`），注意其档位只有 `on` / `off`。

## 测试与验证

- 全量 **768 passed / 12 skipped**（74 个测试文件；Windows 10 x64，Node 24.18.0），较 v0.5.4 净增约 120 项用例。
- 新增测试：安装探测、模型与档位、工作区匹配、运行检测、选择器规范回归（单元）；实例接管与绑定、模型三级选择、发送确认、needs_user/continue_task 恢复、取消与重派护栏、失败返修闭环（集成）。
- 门禁：`typecheck` / `lint`（`--max-warnings 0`）/ `build` / `check:stdio`（6/6 场景）/ `pack:check` 全部通过；构建后无未预期的受跟踪文件变更。
- 已知偶发（与本版无关，见 `HANDOFF.md` §7）：`acceptance` / `baseline-predirty` / `visual-content-command` / `profile-hotreload` / `visual-baselines` / `acceptance-parallel` 在**全量满载并行**时可能偶发失败，单独运行均通过。
