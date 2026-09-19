# Kimi Code GUI（CDP）适配器

tianshu-mcp 的第四个 GUI agent 适配器（`agentId=kimicode`）：驱动 Kimi Code 桌面端（Moonshot AI）完成「定位安装 → 启动并开启 CDP → 绑定任务文件夹（工作区）→ 选模型与思考档位 → 强制完全自动 → 发指令开发 → 运行检测 → 自动验收 → 失败返修 → 再验收」全流程。

- 实现：`src/agents/kimicode/`（`adapter.ts`、`run.ts`、`cdp.ts`、`dom.ts`、`selectors.ts`、`instance.ts`、`session.ts`、`workspace.ts`、`dialog.ts`、`model.ts`、`liveness.ts`、`recovery.ts`、`discovery.ts`）
- profile：`src/agents/builtin.ts` 的 `kimicode`（`adapter: kimicode-gui`）
- 状态：Windows 为 `ready`；macOS 为 `research`（原生文件夹对话框 fail-closed）
- 真机冒烟：`scripts/smoke-kimicode.mjs`；只读诊断探针：`scripts/probe-kimicode.mjs`
- 关联：[adapter-matrix.md](adapter-matrix.md)、[agent-profiles.md](agent-profiles.md)、[acceptance-config.md](acceptance-config.md)

## 0. 环境事实（实测样本，代码不硬编码）

| 项 | 实测值 |
|---|---|
| 可执行（样本） | `D:\Kimi-Code\Kimi Code\Kimi Code.exe`（约 225 MB，目录内含 `chrome_100_percent.pak` / `resources.pak` / `LICENSE.electron.txt`） |
| 打包形态 | 普通 Electron 安装（**非 MSIX**） |
| 版本 | `FileVersion 1.0.2`（`ProductVersion 1.0.2.0`，`CompanyName Moonshot AI`） |
| Chromium / Electron | `Chrome/150.0.7871.114` / `Electron/43.1.1` |
| CDP `User-Agent` | `… kimi-code-app/1.0.2 Chrome/150.0.7871.114 Electron/43.1.1 …` |
| 页面 URL 前缀 | `app://renderer/` |
| CDP 端口 | 默认 `9666`（`--remote-debugging-port=9666`，实测 8 秒内监听） |
| 用户数据目录 | `%APPDATA%\kimi-code-app`（会话与登录态所在，适配器不改动） |

`D:\Kimi-Code\...` 只是本机验收样本：它由「固定盘相对路径模板 + 盘符优先顺序」发现得到，源码中没有任何用户绝对路径。

## 1. 概述：与 Codex 的关键差异

Kimi Code 是**普通 Electron 安装**，因此：

| 环节 | Codex 桌面端 | Kimi Code 桌面端 |
|---|---|---|
| 启动方式 | MSIX/AppX 包，需 `IApplicationActivationManager` COM 激活才能透传调试参数 | **直接 `spawn` 可执行文件并透传 `--remote-debugging-port`，无需 COM 激活** |
| user-data-dir | **必须**专属 profile，否则调试端口不开 | **不另起专属 profile**：会话与登录态在 `%APPDATA%\kimi-code-app`，另起 profile 会丢会话与登录态 |
| 既有实例 | 与用户手动实例互不干扰 | Electron 单实例锁生效：既有实例未开启 CDP 时无法挂 CDP，**必须由用户关闭**（`needs_user/close_existing_instance`） |
| 渲染进程 | 单窗口 | **双渲染进程**：主窗口 + `Kimi Browser Overlay` 浮层窗口（见 §4） |

驱动通道统一为本地 CDP（只连 `127.0.0.1`）：主窗口负责侧栏、会话、composer、发送/停止按钮；浮层窗口负责模型菜单、思考档位与执行模式菜单。Windows 原生自动化只用于 Kimi Code 新打开的原生「添加工作区」对话框（见 §11）。

## 2. 安装探测

`src/agents/kimicode/discovery.ts` 的 `discoverKimicode`，顺序：

1. **显式路径**：`gui.exePath` 或 `command`（存在且校验通过即用）；
2. **Windows 固定盘相对路径模板**：`executableDiscovery.preferredDrives`（默认 `["D:"]`）优先，再套用 `relativePaths`（`Kimi-Code/Kimi Code/Kimi Code.exe`、`Kimi Code/Kimi Code.exe`、`Kimi/Kimi Code/Kimi Code.exe`、`kimi-code/kimi code/kimi code.exe`）；配置盘扫不到才枚举本机固定盘（`Win32_LogicalDisk DriveType=3`）；
3. **卸载注册表**：`HKLM/HKCU` 的 `Uninstall\*` 中 `DisplayName` 匹配 `^Kimi[ -]?Code` 且有 `InstallLocation`；
4. **标准目录**：`{PROGRAMFILES}/Kimi Code`、`{PROGRAMFILES(X86)}/Kimi Code`、`{LOCALAPPDATA}/Programs/Kimi Code`、`{LOCALAPPDATA}/Kimi Code`，以及 macOS 的 `/Applications/Kimi Code.app/Contents/MacOS`、`~/Applications/Kimi Code.app/Contents/MacOS`；
5. **PATH**。

校验规则：可执行名含空格，所以取 basename 后按**完整名精确匹配**（`^Kimi Code\.exe$`，不做模糊包含）；macOS 命中 `.app` 内可执行时来源记为 `bundle`。来源取值集合为 `explicit` / `fixed-drive` / `registry` / `standard` / `path` / `bundle`。

**不写死用户绝对路径**：`preferredDrives`、`relativePaths`、`dirs`、`fileNames` 全部是 profile 数据（可被 `agent-profiles.json` 覆盖），探测顺序不依赖任何本机目录常量。

只读确认（本机实测输出）：

```text
=== install：Kimi Code 安装探测 ===
  可执行路径: D:\Kimi-Code\Kimi Code\Kimi Code.exe
  来源: fixed-drive
  版本: 1.0.2
```

> 说明：`discoverKimicode` 读取版本用的是 5 秒超时的 PowerShell `Get-Item … .VersionInfo.FileVersion`；本机 PowerShell 冷启动实测需 6–10 秒，因此偶发读不到版本（不影响安装探测结果本身）。`probe-kimicode.mjs install` 会用更长超时补读一次并如实标注，便于诊断。

## 3. 启动与 CDP 前置条件

- 启动参数由 profile 提供：`gui.exeArgs = ["--remote-debugging-port=<port>"]`，基准端口 `gui.cdpPort = 9666`；`cdpPortAuto=true` 时从 9666 起在 `cdpPortRange=20` 范围内避让占用，`launchTimeoutMs=90_000`。窗口以 `windowMode: "reuse"` 复用用户登录态。
- **已有实例复用**：进程命令行里能解析出调试端口且端口上能通过产品校验时直接复用；端口页面上线前的等待受 `launchTimeoutMs` 约束。
- **已有实例未开启 CDP**：`ensureKimicodeInstance` 返回 `{ needsClose: true }`，任务进入 `needs_user/close_existing_instance`。适配器**绝不 kill 用户进程**、不复制登录数据到隔离目录、不另起专属 profile。
- **产品校验（归属判定）**：`probeKimicodePort` 只接受满足其一的端口——`/json/version` 的 `User-Agent` 含 `kimi-code-app/`，或存在 URL 以 `app://renderer/` 开头的 page。二者都不成立即拒绝，避免把别的 Electron 应用（同样有 page + CDP）误当成本产品接管。
- **进程筛选**：Electron 的渲染/GPU/工具子进程同样命中可执行名（实测 6 个进程中只有 1 个根进程，且渲染进程 argv 里也带 `--remote-debugging-port`），`rootKimicodeProcesses` 过滤 `--type=` / `crashpad` / `plugin-host` / `cua-helper` / `utility-sub-type` 后才做「是否已存在无 CDP 实例」的判断。
- **macOS**：主进程启动后会改写进程标题（`ps` 里不再显示调试端口），此时补扫配置端口段（预算收窄到 10 秒），扫不到才判 `needsClose`。

只读确认（本机实测输出，节选）：

```text
=== process：Kimi Code 进程 ===
  进程总数: 6
  根进程数: 1
  - pid=11228 角色=根进程 cdp=9666
    命令行: "D:\Kimi-Code\Kimi Code\Kimi Code.exe" --remote-debugging-port=9666
  - pid=12872 角色=子进程（渲染/GPU/工具） cdp=9666
    命令行: "…Kimi Code.exe" --type=renderer … --remote-debugging-port=9666 …
```

## 4. 双渲染进程架构（重点章节）

一个 CDP 端口上同时存在三个 page target（`/json` 与 `Target.getTargets` 均无 `other` 类型）：

| type | title | url | 角色 |
|---|---|---|---|
| page | **Kimi Code** | `app://renderer/`（草稿页）或 `app://renderer/sessions/<sessionId>` | **主窗口**：侧栏、会话列表、composer、输入框、发送/停止按钮 |
| page | **Kimi Browser Overlay** | `app://renderer/browser-overlay.html` | **浮层窗口**：模型菜单、思考档位、执行模式菜单 |
| page | Screenshot | `app://renderer/screenshot/index.html?display=<n>` | 截图窗口，**必须排除** |
| worker ×2 | — | — | 忽略 |

只读确认（`probe-kimicode.mjs cdp` 实测输出，节选）：

```text
  Browser: Chrome/150.0.7871.114
  User-Agent: … kimi-code-app/1.0.2 Chrome/150.0.7871.114 Electron/43.1.1 …
  产品标识 kimi-code-app/: 命中
  page target 数: 3
  - [主窗口（title=Kimi Code）]  mainRank=0   overlayRank=100  url: app://renderer/
  - [overlay 浮层窗口]           mainRank=100 overlayRank=0    url: app://renderer/browser-overlay.html
  - [截图窗口（适配器排除）]     mainRank=100 overlayRank=100  url: app://renderer/screenshot/index.html?display=…
  非 page target: worker、worker
```

**决定性事实**：点击 `button.model-pill` 后**主窗口 DOM 不产生任何菜单节点**（节点数恒为 391），但浮层窗口 `document.visibilityState` 由 `hidden` 变为 `visible`，节点数 20 → 63，菜单内容出现在浮层里。应用 bundle 中对应实现为：

```js
t.browserOverlayOpenMenu({ menuId, anchor, placement, offset, width, autoWidth, initialFocus, preserveFocus, items: e.items(), footerStart })
t.browserOverlayCloseMenu(menuId)
```

→ 凡是走 `browserOverlayOpenMenu` 的菜单（模型 / 思考档位 / 更多模型 / 执行模式）都**必须连接浮层 target 才能读写**；而工作区下拉面板、附件菜单、会话头部菜单渲染在**主窗口**内，两套并存。

实现要点：

- `kimicodeMainTargetRank`：title 恰为 `Kimi Code` → 0；其它 `app://renderer/` 页面 → 1；含 `browser-overlay` / `screenshot` → 100。
- `kimicodeOverlayTargetRank`：只认 `browser-overlay` 页面 → 0，其余 100。
- `KimicodeCdpClient` 内部持有两个页面客户端：主窗口连接后立即置前；浮层**惰性连接**，且连接后用 `location.href` 二次确认（端口上没有浮层页面时 CDP 会把主窗口交给它，必须拒绝），确认失败即 `overlayReady=false`，所有浮层读取返回空集 → 调用方 fail-closed，绝不猜档位。
- **菜单是否打开的唯一权威判据是浮层窗口的 `visibilityState`**：菜单关闭时浮层变 `hidden`，但内容可能短暂残留，只看 DOM 存在会把「已关闭」误判成「已打开」（toggle 语义下会直接把菜单点关）。
- 主窗口 URL 在草稿页 ↔ 会话页之间变化**不会**改变 target id，WebSocket 连接可长期保持。

## 5. 选择器表（实测版本 1.0.2）

全页 `data-testid` 数量为 **0**（没有 testid 可依赖）；class 名**语义化**（非构建哈希）可稳定依赖；Vue scoped 属性 `data-v-*` 随构建变化，**不可依赖**。所有键都可用 `gui.selectors`（`agent-profiles.json`）按语义键热覆盖，用于 UI 版本漂移时的热修复。

### 5.1 主窗口（`KIMICODE_SELECTORS`）

| 语义键 | 选择器 | 备注 |
|---|---|---|
| `newSession` | `button.btn-new-chat` | 侧栏「新建会话 Ctrl N」；点击后 URL 由 `/sessions/<id>` 变为 `app://renderer/` |
| `search` | `button.search` | 侧栏搜索（诊断保留） |
| `workspaceSectionToggle` | `button.side-section-toggle[aria-label="折叠全部工作区"]` | 会话分组折叠开关 |
| `workspaceMore` | `button.gh-more[aria-label="选项"]` | 工作区分组「…」菜单（诊断保留） |
| `workspaceAddSession` | `button.gh-add[aria-label="在此工作区新建会话"]` | 分组内新建会话，比全局入口更精确（草稿重试的备用入口） |
| `workspaceChip` | `button.ws-chip` | 草稿页工作区触发器；**发送后从 composer 消失** |
| `workspaceChipName` | `span.ws-chip-name` | 触发器上的工作区名（新建会话会继承上次工作区） |
| `workspacePanel` | `div.ws-panel[role="menu"]` | 工作区下拉面板（**主窗口内渲染**，含「最近的文件夹」） |
| `workspaceRow` | `button.ws-row[role="menuitem"]` | 文件夹项；当前选中项带 class `on` |
| `workspaceName` | `span.ws-name` | 文件夹显示名 |
| `workspacePath` | `span.ws-path` | **文件夹完整绝对路径** → 绑定主判据 |
| `chooseFolder` | `button.ws-action[role="menuitem"]`（文本「选择文件夹…」） | 触发原生「添加工作区」对话框，只认 trusted 点击 |
| `sessionItem` | `div.se[data-session-id]` | **`data-session-id` 即会话 id**（也可从 URL 读取） |
| `sessionTitle` | `div.se span.t` | 会话标题文本 |
| `sessionMore` | `button.ch-act-more[aria-label="选项"]` | 会话头部「…」菜单（诊断/清理保留） |
| `chatInput` | `div.ProseMirror[contenteditable="true"][aria-label="消息输入框"]` | ProseMirror 富文本；必须走 `Input.insertText`，不能设 value |
| `attachButton` | `button.composer-attach[aria-label="添加"]` | 附件入口（菜单在主窗口内） |
| `permissionPill` | `span.perm-pill` | 执行模式触发器（`.open` 表示菜单展开）；菜单在浮层 |
| `modelPill` | `button.model-pill` | 模型+档位触发器（`aria-haspopup=menu`）；菜单在浮层 |
| `modelName` | `span.mp-name` | 触发器上的模型名（`K3`、`stepfun/step-3.7-flash:free`） |
| `thinkSuffix` | `span.think-suffix` | 档位后缀，形如 ` · High` / ` · Max`；非官方模型为 ` · 思考` |
| `sendButton` | `button.send` | 空输入时 disabled；发送中 class 变为 `send is-starting` |
| `stopButton` | `button.stop`（aria「中断」） | **权威运行信号**：生成期间出现，完成后消失 |
| `userMenu` | `button.user-menu-trigger` | 左下角用户菜单（登录态诊断保留） |
| `settingsButton` | `button.side-footer-settings[aria-label="设置"]` | 设置入口（诊断保留） |
| `gitBranch` | `button.ch-git` | 会话头部分支 chip，发送后出现 |
| `openInMain` | `button.open-in-main`（aria「用 File Explorer 打开」） | 会话头部入口（诊断保留） |
| `messageArea` | `div.panes` | 对话正文容器；稳定判定与错误文案都取它（**不要用 body**，会混入侧栏） |
| `modelDialog` | `div.ui-dialog[role="dialog"]` | 「切换模型」对话框（在主窗口） |
| `modelDialogSearch` | `div.ui-dialog input.ui-input` | 对话框搜索框（placeholder「搜索模型或提供商…」） |
| `modelDialogRow` | `div.ui-dialog div.model-row[role="option"]` | 候选行；**`.is-current` 才是当前模型**（`.is-selected` 只是推荐项） |
| `modelDialogRowName` | `div.model-row span.model-name` | 模型名（精确匹配用 NFKC + 折叠空白） |
| `assistantCopyButton` | `button.a-cpbtn` | 助手回复复制按钮（辅助证据，不作完成判据） |
| `userCopyButton` | `button.u-copy` | 用户消息复制按钮（发送确认辅助证据） |
| `errorRetryButton` | `button.ui-button--secondary`（文本「继续」） | 失败态判据（伴随「模型请求失败，本轮对话已中断」） |
| `userGate` | **默认空**（未内置） | 「等待用户」检测默认禁用；只有 `gui.selectors.userGate` 显式配置后才参与判定 |

### 5.2 浮层窗口（`KIMICODE_OVERLAY_SELECTORS`，键名对外加 `overlay.` 前缀）

| 语义键 | 选择器 | 备注 |
|---|---|---|
| `overlayStage` | `main.browser-overlay-stage` | 浮层菜单舞台 |
| `menuList` | `div.browser-overlay-list` | 菜单列表容器 |
| `menuRow` | `button.overlay-menu-row` | 通用菜单行（模型/权限/更多模型共用，语义靠菜单时机区分） |
| `menuRowTitle` | `span.overlay-menu-title` | 行标题（「完全自动」「更多模型…」） |
| `menuRowDescription` | `span.overlay-menu-description` | 行说明（执行模式菜单有） |
| `modelOption` | `button.overlay-menu-row[role="menuitemradio"]` | 模型候选；**当前项带 `.is-active`** |
| `thinkingSegment` | `button.ui-seg__item[role="tab"]` | 思考档位分段控件；**当前档带 `.is-on`** |
| `moreModelsItem` | `button.overlay-menu-row[role="menuitem"]`（文本「更多模型…」） | 点后浮层立即隐藏，主窗口弹出「切换模型」对话框 |
| `permissionOption` | `button.overlay-menu-row[role="menuitemradio"]` | 执行模式候选；**当前项带 `.is-active`** |

## 6. 任务文件夹（工作区）绑定

Kimi Code 以「工作区（任务文件夹）」组织会话，任务必须绑定到某个已登记目录（**不支持无项目模式**：`workspaceMode=default` 或空 `projectPath` 在派发前直接拒绝）。

- **主判据是完整路径**：面板条目含 `span.ws-path` 的绝对路径（实测 `D:\Trae项目\tianshu-mcp` 这类原生形式）。`normalizeWorkspacePath` 做盘符大写 + 反斜杠统一 + 去尾部分隔符 + Windows 大小写不敏感比较，再与 `projectPath` 对齐；**名称（`span.ws-name`）只作回退**。
- **同名歧义 fail-closed**：路径命中 0 条且名称命中多条 → 停止（`ambiguous`），**绝不猜一个点**（会把任务派到错误目录）。
- **草稿页建立**：点「新建会话」→ 以「`button.ws-chip` 已挂载」为后置条件确认；点击被节流吞掉时有界周期重试（全局入口与「在此工作区新建会话」交替），超时即 fail-closed，不发送。「点击返回成功」不等于「已切到草稿页」。
- **新建会话会继承上次工作区**，因此进入草稿后仍必须显式核对/绑定，不能靠「没点过工作区按钮」当作未绑定。
- **未登记的工作区**：先采样原生对话框基线，再点「选择文件夹…」，只操作**新出现**且属于目标进程的 `#32770` 窗口（见 §11）。
- **绑定回读**：重新打开面板，要求当前选中项**唯一**、其完整路径与 `projectPath` 归一化后一致，且 `ws-chip` 文本非空；任一不成立即按 `readback` fail-closed（失败文案会带期望路径与实际值）。
- **发送后 `ws-chip` 从 composer 消失**，因此绑定状态无法在发送后回读——恢复轮以会话锚点（URL/侧栏 id）为复检判据。

## 7. 模型与思考档位

`model` **必填**（Kimi Code 没有「默认模型」概念，界面当前值不能代表任务语义；`gui.modelRequired=true`）。`reasoningLevel` 可选，取值域 `低/low`、`高/high`、`max`、`on`、`off`；`中/medium` 之类越界值在参数校验阶段即报错（`describeLevelValueError`）。

- **不内置模型名单**：档位集合的唯一来源是**界面实际渲染出的档位标签**，`tierSetOf` 归类为：
  - `official`：官方模型（Kimi 订阅，如 `K3` / `K2.8 Preview` / `K3-256k`）→ `Low / High / Max`；
  - `onoff`：非官方模型（如 kiro 的 `stepfun/step-3.7-flash:free`）→ `On / Off`，默认 `On`；
  - `unknown`：读不到档位标签 → **fail-closed 报错**，不按内置名单猜。
- **档位校验在发送前**：请求档位不在界面集合内即报错（`模型 X 的思考等级仅支持 Low/High/Max，收到「中」（medium）`），绝不静默沿用界面当前档。
- **默认策略**：省略 `reasoningLevel` 时，官方模型沿用界面当前档；非官方模型强制切到 `On`（已是 `On` 则不切换）。
- **三级选择流程**：
  1. 回读 `button.model-pill` 全文（实测 `K3 · High`；非官方模型为 `stepfun/step-3.7-flash:free · 思考`）——已匹配则复用，不做多余点击；
  2. 浮层快捷菜单直选：`overlay.modelOption` 按可见文本精确点击（多命中/未命中都不点击，并回报可见候选），点击后回读触发器收敛；
  3. 「更多模型…」对话框：浮层点 `overlay.moreModelsItem` → 主窗口「切换模型」对话框 → 搜索框写入（先 `Ctrl+A` + `Backspace` 清空，再 `Input.insertText`，等候选收敛）→ 按 `span.model-name` **全等**点击候选行。含 `/` 的模型名 0 命中时退化为按 provider（`/` 前半段）再搜一次，但**命中判定始终用完整名**。
- **精确区分前缀**：`K3` 与 `K3-256k` 必须全等匹配，前缀命中会误判成「已选中 K3」从而跳过切换。
- **`.is-current` 才是对话框里的当前模型**：实测 `.is-selected` 指向 `K2.8 Preview`，而当前模型是 `K3`；非官方模型行同时带 `is-current is-selected`。
- **失败分型**：三级都没切成功时先关闭残留对话框（残留对话框会吞掉后续键盘注入），再按「是否点中过候选行」区分 `model_mismatch`（点了没生效）与 `model_unavailable`（没有这个模型），错误文案带快捷菜单与对话框两侧候选。

## 8. 执行模式

适配器强制执行模式为「**完全自动**」（`gui.permissionMode` / `defaultPermissionMode`，可被恢复轮的 `resume.permissionMode` 覆盖），并在发送前回读确认：

- 触发器 `span.perm-pill` 文本已等于目标值 → 复用；否则打开浮层执行模式菜单，按可见文本精确点击 `overlay.permissionOption`；
- 三档实测为 `始终询问` / `必要时询问` / `完全自动`（当前项带 `.is-active`），点击后必须回读触发器文本一致，否则 `permission_unknown` 硬失败、不发送；
- Kimi Code 不支持 TraeWork 的 `mode` 参数，显式传入即参数错误（`gui.modeSwitch=false`）。

## 9. 运行检测

判定纪律（`liveness.ts`）：

1. **权威运行信号**：`button.stop`（aria「中断」）存在且可见 → `running`；发送后 0.5–1.2 秒内出现，完成后消失。
2. **次权威运行信号**：`button.send` 的 class 含 `is-starting`（实测与停止按钮同现）。
3. **失败态不得判完成**：`button.ui-button--secondary`（「继续」）可见，或 `div.panes` 内出现「模型请求失败，本轮对话已中断」/`provider.auth_error` 等文案 → `failed`（终态 `agent_error`）。返修轮会用发送前的基线文案过滤掉上一轮残留的失败文案（「继续」按钮属于当前失败态强信号，不做基线过滤）。
4. **无信号时**才进入文本稳定判定：`div.panes` 文本哈希连续 `stableRounds`（默认 4）轮不变且非空才判 `finished`；达到 `stableRounds` 后才开始 `idleTimeoutMs`（默认 10 分钟）空闲计时，文本一变立刻清零。**「文本静止 N 秒」永远不能单独作为完成判据。**
5. **停滞兜底**：停止按钮恒可见且文本停滞超过 `stallTimeoutMs`（默认 5 分钟）→ `needs_user/user_confirmation`（可 `continue_task` 恢复），打破「恒可见 → 恒 running」死锁。
6. **输入框清空陷阱**：ProseMirror 清空后 `innerText` 长度仍为 **1**（保留空 `<p>`），空态判定必须用 NFKC + trim 后的空串，不能用 `length === 0`。
7. `poll()` 是**单次 evaluate** 采集的完整快照（`stopVisible` / `sendStarting` / `assistantText` / `errorText` / `retryVisible` / `inputText` / `sendEnabled` / `pageHidden` 等），减少轮询期间的页面往返。提问检测默认关闭（见 §12）。

发送确认：点击发送后 60 秒有界观察，要求「会话 id（URL）+ 用户消息落地」为必需锚点，且「输入框已清空 / 运行信号 / 用户消息复制按钮」至少一项成立；**只点击一次发送，绝不重发**，无法确认即 `send_unknown`。

## 10. 窗口前台与点击被吞（真机踩坑，重点）

Chromium 会节流被遮挡/不可见页面，导致**合成鼠标事件被吞**：表现为「点新建会话毫无反应」「点工作区触发器 5 秒无任何反应」，很容易被误诊成选择器失效。

- **`Page.bringToFront` 对 Kimi Code 有效**（与 ZCode 的 Electron 不同）：`connect()` 后立即置前，并开启 `Emulation.setFocusEmulationEnabled`。
- **置前是异步生效的（实测需数百毫秒）**：只调一次就立刻派发点击，事件仍会被吞。`focusMainWindow()` 以 `visibilityState` 收敛为准（上限 `FOCUS_SETTLE_MS = 1500ms`），而不是盲等固定时长；置前失败不抛错，正确性判据始终是点击后的回读。
- **点击一律优先 trusted 坐标点击**（`Input.dispatchMouseEvent`：moved + pressed + released），拿不到唯一可见目标才回退 DOM `element.click()`：实测 `button.ws-chip` 只认 trusted 点击，而 `button.model-pill` 两者皆可，所以 trusted 必须是首选路径。
- **有界周期重试**：`openWorkspacePanel` / `openOverlayMenu` / `ensureFreshDraft` 都以「后置条件是否成立」（面板打开 / 浮层可见 / `ws-chip` 已挂载）为准做 `TRIGGER_RECLICK_MS = 1500ms` 的重复点击，且**不重置调用方给的截止时间**；toggle 语义下每轮都先查后点，避免把已打开的菜单点关。
- 发送按钮点不到时，若 `pageHidden` 为真，错误文案会直接指出「Kimi Code 窗口不在前台（页面被节流，合成点击不可靠）」，而不是笼统报「按钮不可点击」。

## 11. 原生「添加工作区」对话框（Windows）

触发路径：草稿页 `button.ws-chip` → 工作区面板 `button.ws-action`（「选择文件夹…」）→ 原生对话框。实测事实：

| 项 | 实测值 |
|---|---|
| 类名 | `#32770`（标准 Windows 对话框） |
| 标题 | `添加工作区` |
| 宿主进程 | Kimi Code |
| 「文件夹:」标签 | AutomationId `1090`、Class `Static` |
| **「文件夹」编辑框** | **AutomationId `1152` + Class `Edit`，ControlType 是 Pane（无 ValuePattern）** |
| 确认按钮「选择文件夹」 | **AutomationId `1`**，ControlType 为 **Pane** |
| 取消按钮 | AutomationId `2` |

实现纪律（`dialog.ts`）：

- **只操作新出现的窗口**：点击前先 `listOwnedDialogs(pids)` 采样基线（身份格式 `dialog:<hwnd>:<title>`），随后只认「不在基线里 + 属于目标进程 + 类名 `#32770`」的窗口；新窗口多于 1 个直接抛 `AMBIGUOUS_…`，绝不盲点用户既有窗口。标题只作诊断（不符时如实报 `native:title-mismatch`，不据此放弃真实对话框）。
- **确认/取消按钮都不支持 UIA `InvokePattern`**（实测报「不支持的模式」）→ 只能取 `BoundingRectangle` 后 `SetCursorPos` + `mouse_event` 坐标点击；确认按钮额外要求「AutomationId=1 唯一 + 已启用 + 矩形中心落在对话框下半部」（上半部是列表区，命中说明控件结构已漂移）。
- **路径写入用 `WM_SETTEXT` + `WM_GETTEXT` 回读**：写前把路径转成原生形式（盘符大写 + 反斜杠，`toNativeDialogPath`；原生选择器拒绝正斜杠形式），写后立即回读并做 `GetFullPath` 比较，**回读不一致绝不点确认**（最多重试 3 次）。
- **路径只经环境变量进入 PowerShell 脚本**（`TIANSHU_KIMICODE_FOLDER` 等），脚本源码里没有任何路径字面量或插值，避免 CJK 被命令行代码页破坏。
- 提交后确认对话框句柄已销毁；随后仍必须回到界面回读完整路径（§6），原生提交成功不等于绑定成功。
- **macOS fail-closed**：`selectKimicodeFolder` 在 darwin 直接返回 `macOS 原生文件夹选择未实现（Kimi Code macOS 适配仍为 research）`，不做未验证的 osascript 流程。

只读确认：`node scripts/probe-kimicode.mjs dialogs` 会枚举目标进程拥有的全部 `#32770` 窗口（hwnd / 类名 / 标题 / 是否可见），对话框只在点「选择文件夹…」后出现。

## 12. `needs_user` 与 `continue_task`

五类暂停与恢复语义：

| `needsUserKind` | 触发 | 恢复语义（`continue_task`） |
|---|---|---|
| `close_existing_instance` | 检测到未开启 CDP 的既有 Kimi Code 实例 | 用户手动关闭所有 Kimi Code 窗口后确认；恢复时做**环境复检**并补发完整任务书（含上下文与已验证引用）。**确认文本不发给模型**，绝不 kill 用户进程 |
| `login_required` | 主窗口可连但 composer 在观察期内始终未挂载（通常停在登录/引导页） | 用户在 Kimi Code 内完成登录/引导后确认；按无锚点恢复补发任务书，确认文本不发给模型 |
| `setup_recovery` | 工作区绑定失败（草稿/面板/歧义/点击/回读）、自动恢复未完成 | 用户在 Kimi Code 中处理提示项后确认；按无锚点恢复补发任务书，明示「不会向其它工作区发送任务」 |
| `system_permission` | 原生对话框需要辅助功能权限（macOS 分支） | 授予 Accessibility 权限后确认 |
| `agent_question` | 提问检测命中（或配置了 `gui.selectors.userGate` 时命中等待用户界面） | `continue_task(taskId, message=回答内容)`：回答**只发到精确定位的原会话**，不重发任务书 |
| `user_confirmation` | 停止按钮恒可见且文本停滞（`stall`），或 `userGate` 命中 | **重连观察**（`reobserve`）：用户确认文本绝不发给模型，也不改模型/执行模式，只重连原会话观察到终态 |

两条硬性纪律：

- **定位不到原会话一律 `session_lost` fail-closed**：恢复轮必须有会话锚点（`kimicodeSessionId` / `kimicodeSessionTitle`），缺失、命中 0 条或多条、切页后 URL 回读不一致都直接硬失败，**绝不打开「最近会话」**。
- 暂停会释放项目运行槽与 Kimi Code 全局串行锁，但保存任务 ID、Git 基线、会话锚点、项目路径、模型与执行模式；服务重启不会把它归档为 `interrupted`。

提问检测（`detectQuestion`）默认**关闭**：只有 profile 显式配置 `gui.selectors.userGate` 才启用启发式判据（无运行信号 + 输入框为空 + 文本已变化 + 以问句结尾）。Kimi Code 的提问卡片选择器**未真机验证**（账号额度受限，无法造出提问场景），因此绝不内置猜测型选择器——误配会把正常运行误判成 `needs_user`，并在恢复时把用户确认文本当成回答发给模型。

## 13. 取消与超时

- **取消**（`cancel_task` / abort）：经 CDP 尽力点击 `button.stop`，并在 `gui.cancelWaitMs`（默认 15 秒）内有界等待「停止按钮消失且发送按钮恢复」；结果经 `guiStop { clicked, idle }` 上报。
- **未确认停止时不谎报**：`idle=false` 时终态文案明示「GUI 内运行未确认停止，Kimi Code 窗口中的任务可能仍在继续」；未连上 CDP 时明示「无法确认界面停止」。
- **取消/超时/断线一律保留实例**（`keptInstance: true`）：不关窗、不 kill 用户进程。`task_timeout` 停止 MCP 等待并保留现场；`cdp_disconnected` 保留现场交由人工裁决。
- **重派护栏**：派发前若实例上仍有运行信号，先尽力停止；仍未空闲则 `instance_busy` 硬失败，避免新旧任务交叠（`reobserve` 轮例外——停止按钮可见正是被观察 turn 暂停的表现）。
- 所有等待都受「任务总时限 / setup 预算 / 阶段预算」的最小值夹住（`KimicodeBudget`），重试不重置预算；取消与护栏使用**未被预算包裹**的原始 CDP 客户端，否则 abort 后连一次停止点击都发不出去。

## 14. 真机验证记录

环境：Windows 10 x64，Kimi Code `1.0.2`（Chromium 150 / Electron 43.1.1），CDP 端口 9666。

**本轮真机已验证**

| 项 | 结果 |
|---|---|
| 安装探测 | 自动发现 `D:\Kimi-Code\Kimi Code\Kimi Code.exe`，来源 `fixed-drive`，版本 `1.0.2` |
| 启动与 CDP | `--remote-debugging-port=9666` 启动后 8 秒内端口监听；`/json/version` 产品标识命中 |
| 双渲染进程 | 主窗口（`app://renderer/`）、`Kimi Browser Overlay`、截图窗口三 target 并存；模型菜单只改浮层可见性 |
| 工作区绑定 | 已登记工作区按完整路径点选并回读通过；**未登记工作区经原生「添加工作区」对话框导入**后回读通过 |
| 模型与档位 | 官方模型 `K3` + `High`→`Max` 切换并回读通过；非官方 `stepfun/step-3.7-flash:free` 档位 `On/Off` 与触发器后缀「思考」实测一致 |
| 执行模式 | 「完全自动」回读通过 |
| 发送与运行 | 发送后 `button.send` → `is-starting`、`ws-chip` 从 composer 消失、`button.stop` 出现；回复稳定后判完成 |
| 开发与验收 | 成功路径完成真实文件开发并通过自动验收 **2/2** |
| 失败返修闭环 | 受控首轮失败 → 自动返修 → **同一会话**再验收通过 |
| 免费模型可用 | 官方模型额度受限时以 `stepfun/step-3.7-flash:free` 走完「发送 → 运行 → 完成」链路 |

**未在真机覆盖（不得据此声称已验证）**

| 项 | 覆盖方式 |
|---|---|
| 取消真停（`cancel_task` → `guiStop.idle`） | 仅 hermetic 集成测试（`test/integration/kimicode-flow.test.ts`）覆盖 |
| `agent_question` 提问与续答 | 仅 hermetic 集成测试覆盖（真机提问场景未能构造） |
| 同名工作区歧义 | 仅 hermetic 集成测试覆盖 |
| macOS 全流程 | 未验证：profile 状态为 `research`，原生文件夹对话框 fail-closed |
| `gui.selectors.userGate` 等待用户界面 | 选择器未内置，未验证 |

**已知阻塞**：本轮侦察期间官方模型额度用尽（服务端返回 `403 You've reached your monthly usage limit for this billing cycle.` / `provider.auth_error`，界面显示「模型请求失败，本轮对话已中断」+「继续」按钮）。这不影响适配器判定（该形态被如实判为失败态而非完成），但意味着官方模型下的真实开发任务需要额度刷新或改用免费非官方模型。

## 15. 已知限制与排障

**限制**

- macOS 为 `research`：安装探测与 CDP 复用可用，但原生文件夹选择未实现（fail-closed），端到端未验证。
- 不支持无项目模式（必须提供 `projectPath`）；不支持 TraeWork 的 `mode` 参数；`allowCreateProject` 是 ZCode 专用参数，Kimi Code 传入即报错。
- 提问（等待用户）界面未真机验证，`userGate` 默认关闭，只能靠停滞兜底收敛。
- 官方模型额度用尽时可改用非官方免费模型（如 `stepfun/step-3.7-flash:free`）：其思考档位只有 `On`/`Off`，触发器后缀显示「思考」，`reasoningLevel` 只接受 `on`/`off`。
- **会话标题会被任务标记污染（已知外观副作用）**：Kimi Code 用首条用户消息生成会话标题，而本适配器按既有约定把 `【tianshu:<taskId>:r<round>:<attempt>】` 标记**前置**在任务书之前（标记是会话定位与「不重发」判据的必需锚点，与 ZCode/Codex 同一机制）。因此侧栏会显示形如 `【tianshu:tsk_…:r0:initial】<任务书开头>` 的标题。这是可靠性换来的代价，不影响功能；若需干净标题，请在 Kimi Code 中手动重命名会话（重命名会改变标题，`session_lost` 时请改用新建任务）。

**排障**

| 现象 | 处理 |
|---|---|
| `close_existing_instance` | 保存 Kimi Code 工作并手动退出全部窗口，再调 `continue_task` |
| 点击无反应 / `send_unknown` | 确认 Kimi Code 窗口在前台（后台页面被节流，合成点击不可靠）；`liveness` 快照里的 `pageHidden` 会直接指出这一点 |
| `model_unavailable` / `model_mismatch` | 用 `node scripts/probe-kimicode.mjs models` 看两侧候选（快捷菜单与「切换模型」对话框）；UI 漂移时用 `gui.selectors` 热覆盖 |
| 档位报错 | 档位集合以界面为准：官方模型 `Low/High/Max`、非官方模型 `On/Off`；`中/medium` 永远非法 |
| 工作区绑定失败 | 用 `workspaces` 子命令看面板是否暴露 `span.ws-path` 完整路径；同名不同目录必须手工消歧 |
| 原生对话框未完成 | `dialogs` 子命令确认窗口形态（`#32770` + 「添加工作区」）；确认/取消不支持 UIA InvokePattern，只能坐标点击 |
| 登录/引导页 | 在 Kimi Code 中完成登录后 `continue_task` |
| `session_lost` | 原会话已被删除或标题被改写；请新建任务，适配器不会打开「最近会话」 |
| `cdp_disconnected` | 保留现场，确认实例仍在及端口归属后人工裁决 |

**诊断探针**

```powershell
npm run build
node scripts/probe-kimicode.mjs install        # 安装探测（路径 / 来源 / 版本）
node scripts/probe-kimicode.mjs process        # 进程与 --remote-debugging-port
node scripts/probe-kimicode.mjs cdp            # /json/version 与 page target 归属
node scripts/probe-kimicode.mjs workspaces     # 工作区面板（名称 + 完整路径 + 当前选中）
node scripts/probe-kimicode.mjs session        # 会话 id 与侧栏列表
node scripts/probe-kimicode.mjs models         # 模型候选 / 思考档位 / 执行模式候选
node scripts/probe-kimicode.mjs liveness       # 一次运行信号快照
node scripts/probe-kimicode.mjs dialogs        # 原生「添加工作区」对话框枚举
node scripts/probe-kimicode.mjs all            # 依次执行上述只读命令
```

`--port <n>` 覆盖 CDP 端口（默认 9666）。**默认只读**：不启动实例、不发送任何消息（探针没有发送能力）；只有显式 `--launch` 才允许启动 Kimi Code（会新开一个窗口）。连接主窗口会把 Kimi Code 置于前台——这是 CDP 只读诊断的必要条件（后台页面被节流）。

**真机冒烟（会真实发送任务，需显式确认）**

```powershell
npm run build
node scripts/smoke-kimicode.mjs --confirm-send --model "K3" --project D:\repo\app --task "只检查 package.json，不修改文件，并回复检查结果"
```

`--confirm-send`、`--model`、`--task` 三者齐全才会发送；脚本使用隔离的数据目录（不污染 `~/.tianshu-mcp`），输出任务 ID、状态变化与证据目录，并保留 Kimi Code 窗口。

**调用示例**

```text
run_task(
  projectPath=D:/repo/app,
  agentId=kimicode,
  model=K3,
  reasoningLevel=High,
  task=根据 `.tianshu-mcp/plans/feature.md` 完成开发,
  autoVerify=true
)
```

- `model` 必填且必须是界面上的精确模型名（如 `K3`、`stepfun/step-3.7-flash:free`）；不存在、同名歧义或切换回读不一致时发送前失败。
- 每次初始调用新建会话；自动返修、`rework_task` 与续答只允许恢复已记录的原会话。
- 发送前必须精确绑定工作区、回读模型与档位、强制「完全自动」；任一状态不明确都 fail-closed。
- 默认 `autoVerify=true`，未显式指定时 `autoFixRounds=2`；验收失败时返修计划写在 `<TIANSHU_MCP_HOME>/tasks/<taskId>/rework-<taskId>-r<round>.md`（复用统一验收引擎，见 [acceptance-config.md](acceptance-config.md)）。
