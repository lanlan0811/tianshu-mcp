# Open Design GUI（CDP）适配器：真机事实与设计依据

[English](opendesign-cdp.en.md)

本文记录 `opendesign-gui` 适配器的**真机取证结果**与由此得出的实现约束。适配器目标是让 Open Design 桌面端
（「让我们创建原型」那套面向设计稿生成的 AI 客户端）成为 tianshu-mcp 可派活、可观察、可验收的 GUI agent。

> 取证机器：Windows 10 Pro 19045；Open Design 0.24.1（Electron 41.3.0，官方安装包）；
> 安装目录 `D:\Open Design`；取证日期 2026-09-25 ~ 2026-09-26。

## 1. 安装与数据目录

| 事实 | 取值 / 依据 |
|---|---|
| 安装形态 | **普通安装**（非 MSIX 商店包），`<安装目录>\Open Design.exe` |
| 安装配置 | `<安装目录>\resources\open-design-config.json` → `appVersion` / `namespace` |
| 实测取值 | `appVersion=0.24.1`，`namespace=release-stable-win` |
| Electron userData | `%APPDATA%\Open Design\namespaces\<namespace>\user-data` |
| 应用数据 | `%APPDATA%\Open Design\namespaces\<namespace>\data\`（`app-config.json`、`app.sqlite`） |
| 日志 | `%APPDATA%\Open Design\namespaces\<namespace>\logs\{daemon,desktop,launcher,web}` |

**不硬编码**：安装路径由 `executableDiscovery`（`preferredDrives:["D:"]` + `relativePaths:["Open Design/Open Design.exe"]`
→ 注册表卸载信息 → 标准目录 → PATH）推导；版本与命名空间一律从安装配置读。
**命名空间取不到时不猜**（`openDesignNamespaceRoot` 返回 `null`），因为猜错命名空间会导致
「绑定了目录却读不到 `app-config.json`」这类静默误判，而不是响亮报错。

## 2. 实例接管：单实例锁与 `--user-data-dir` 的真相

这是本适配器与 ZCode / Kimi Code / Qoder 最关键的差异，直接决定实例策略。

### 2.1 ⚠️ `ELECTRON_RUN_AS_NODE`：启动失败的真正根因（真机实测）

`Open Design.exe` 是「**内嵌 Node 的 Electron**」外层启动器。若启动它的进程带着
`ELECTRON_RUN_AS_NODE=1`（本机 DSH harness 就会注入该变量），启动器会被强行置为 **Node 模式**：

```
D:\Open Design\Open Design.exe: bad option: --remote-debugging-port=9889   （退出码 9）
D:\Open Design\Open Design.exe: bad option: --headless                     （退出码 9）
```

表现为「无窗口、无新日志、无崩溃转储」——**极易误判成应用本身损坏**。清除该变量后同一命令立刻生效：

```
DevTools listening on ws://127.0.0.1:9889/devtools/browser/63dd8142-…
```

`NODE_OPTIONS` 同样必须清除：Node 明确禁止 `--remote-debugging-port` 出现在其中，
残留时会报 `--remote-debugging-port= is not allowed in NODE_OPTIONS`。

**因此受管启动一律净化环境**（`OPEN_DESIGN_ENV_DENYLIST` + `sanitizedSpawnEnv()`），
且**不改命令行**——命令行仍是 profile 的 `exeArgs`（`--remote-debugging-port=<port>`），
即官方启动器本来就支持的形态。

### 2.2 启动器是「分离子进程形态」

实测：启动器接受调试端口后会打印 `DevTools listening on …`，**然后自己以退出码 0 退出**，
真正的 Electron 主进程是它 spawn 的分离子进程。因此：

- **退出码 0 绝不等于失败**：必须从 stderr 解析宣告端口（`devtoolsPortsFromOutput()`）并继续轮询；
- 首版直接把退出码 0 判成「请用户关闭旧实例」，真机上表现为「明明起来了却说要关旧实例」——已修。
- 退出码 9 归类为「无法接管 → `needs_user`」，其他非零才是真实启动失败（带 stderr 尾部抛错）。

| 事实 | 依据（`resources/app/prebundled/packaged-main.mjs`） |
|---|---|
| 有**进程级单实例锁**；第二实例只把 deeplink 转交给首实例然后退出 | `claimPackagedSingleInstanceLock`（:34250-34259）、`createPackagedSecondInstanceHandoff`（:34260-34283） |
| 主进程**强制** `app.setPath("userData", <namespaceRoot>/user-data)` | `applyPackagedElectronPathOverrides`（:34245-34248） |
| 因此 `--user-data-dir` 开关**会被覆盖** | 同上；`resolvePackagedNamespacePaths`（:32578-32598） |
| 支持 `--headless`（无窗口，起 daemon/web sidecar，可 `--mcp-install codex`） | `parsePackagedHeadlessRequest`（:33471-33484）、`runPackagedHeadless`（:33510+） |

### 由此确定的策略（复用优先 → 自启 → 请用户关闭）

1. **复用优先**：已有实例且根进程 argv 带有效调试端口 → 直接接管（`probeOpenDesignPort` 做产品校验）。
2. **自启受管实例**：无实例时 `spawn(exe, ["--remote-debugging-port=<port>"])`。
3. **`needs_user(close_existing_instance)`**：有实例但没开调试端口 → 子进程被单实例锁转交后退出，
   此时**明确要求用户手动关闭**，绝不 kill 用户进程。

**不做「专属 userData 受管实例」**：主进程会覆盖该开关，写进 profile 是假承诺。因此
`opendesign` profile 的 `gui.userDataDir` 保持未设置，`exeArgs` 只注入调试端口。

### 根进程判定的坑（真机踩到并修复）

本产品把 daemon / web 两条 sidecar 也做成同一个可执行文件的子进程，实测命令行形如：

```
"D:\Open Design\Open Design.exe" "D:\Open Design\resources\app\prebundled\daemon\daemon-sidecar.mjs"
"D:\Open Design\Open Design.exe" "...\@open-design\sidecar\dist\supervisor.mjs" --od-stamp-app=web
```

它们**没有窗口、不参与单实例锁**，但会长期驻留。若把它们算作「已运行的实例」，
用户关掉界面后仍会被判 `needsClose`，导致受管实例**永远起不来**。故
`rootOpenDesignProcesses()` 在剔除 `--type=` / crashpad 之外，还剔除 argv 里出现 `.mjs` 脚本的进程。
实测该机器 11 个同名进程 → 只剩 1 个真·桌面主进程。

## 3. CDP 端点

| 项 | 取值 |
|---|---|
| 调试端口基准 | **9889**（区段 9889-9898） |
| 为何不用 9777 | 该端口已被 **Qoder CN** 占用（基准 9777，区段 9777-9796）——真机实测后改档 |
| 既有占用 | traework 9222 / zcode 9333 / codex 9333 / kimicode 9666 / qoder 9777 |
| 产品校验 | `/json/version` 的 `User-Agent` 含 `electron` **且**存在标题以 `Open Design` 开头（或 URL 含 `open-design`）的 page target |
| 版本判据 | **产品版本**取自 `resources/open-design-config.json`；CDP `/json/version` 的 `Browser` 是 **Electron 版本**（实测 `Electron/41.3.0`），**不可**用于产品版本比对 |

> 版本判据踩坑记录：首版误用 `/json/version` 的 `Browser` 做版本门禁，导致真机上必定
> `version_mismatch` 而阻断全部派发；已改读安装配置并加回归测试（`opendesign-discovery.test.ts`）。

## 4. 界面结构与选择器采集

Open Design 是**打包过的 React 应用**（`resources/app/prebundled/*` 为压缩产物，无源码可读），
选择器必须真机采集。采集入口：

```sh
npm run build
node scripts/probe-opendesign.mjs anchors --no-focus   # 只读盘点；连接不置前
node scripts/probe-opendesign.mjs all                  # install + process + cdp + appconfig + anchors
```

探针从 `dist/` 动态 import 构建产物，**只读**：不点击、不输入、不发送；只有显式 `--launch` 才允许启动实例。
`anchors` 会把 `ANCHOR_CANDIDATES` 里每个候选选择器的命中数与首个文本打印出来，并把页面可见文本前
1200 字符贴出，供人工收敛为稳定选择器写回 `src/agents/opendesign/selectors.ts`。

> **当前状态（P1）**：**选择器/DOM 层已实现**，`selectors.ts` 的 `primary` 仍为**空占位**——
> 即「代码就绪、取值待采集」。因此 `run.ts` 的**布局守卫**会在任何点击之前硬失败 `selector_drift`
> 并列出缺失键；选择器一旦采集写回，该门禁自动解除，无需改代码。
>
> **选择器采集被环境限制阻塞（2026-09-26 实测）**：本机 DSH harness 会话**无外网**，
> Open Design 启动期会先做版本/遥测/计费请求（`releases.open-design.ai`、`amr-api.open-design.ai` 等），
> 这些请求在本会话下不可达，导致**主线程在启动期被阻塞**：进程与窗口都在、`DevTools listening` 已打印、
> 但 `/json` 与 `/json/version` **连上后不响应**（curl 连接成功、0 字节、超时）。
> 因此本轮无法完成真实 DOM 采集。**在能联网的普通终端里**按 §9 执行采集即可。

### 已实现的选择器/DOM 层（P1 交付）

| 文件 | 内容 |
|---|---|
| `selectors.ts` | 16 个语义键的注册表（`primary` + 语义化 `fallbacks`）、`cssCandidates`、`specArgs`、`selectorSpec`、页面内 `resolveFnSource`、**布局守卫键集** `OPEN_DESIGN_LAYOUT_GUARD_KEYS` 与 `missingSelectorKeys()` |
| `dom.ts` | 页面内表达式：`exists` / `text` / `singlePoint` / `firstPoint` / `exactMatch` / `listLabels` / `count` / `inputValue` / `conversationText` / `triggerText` / `layoutProbe` / `dismiss` / `directionItemVisible`，标记前缀 `od:` |

设计约束（与 `kimicode/dom.ts` 同构）：
- 点击类表达式**只返回坐标**，鼠标事件由 `cdp.ts` 统一发出；不产生副作用；
- 布局守卫**只收「初始页面就存在」的锚点**（标题/输入区/各触发器/发送按钮/对话区），
  刻意不含 `stopButton`、各菜单项、设计系统搜索框等运行期才出现的键——否则适配器永远无法启动；
- 回退候选**不得是宽泛容器型**（`button`/`div[class]`/`li`…）：多命中会让坐标点击失效，
  且错误信息只会说「选择器未挂载」，极难定位（已固化成断言）。
- 候选匹配**精确全等**，未命中报错并回显可见候选；**绝不退化成模糊匹配**。

### 已知的界面锚点（截图证据，待真机 DOM 校对）

| 控件 | 视觉位置（1366×705 视口） | 备注 |
|---|---|---|
| 「工作目录」触发器 | 约 (455, 297) | 展开后含「选择目录」/「最近使用的目录」 |
| 「选择目录」菜单项 | 约 (455, 346) | 点击后弹 **Windows 原生「选择文件夹」** 对话框 |
| 模型触发器 | 约 (1081, 242) | 菜单分「本机 CLI」与「API 供应商」两组，后者项带锁图标 |
| 设计系统触发器 | 约 (521, 242) | 面板含搜索框 + 长列表（内置 151 个设计系统包） |
| 设计方向触发器 | 约 (658, 242) | 菜单：原型 / 幻灯片 / 文档 / 图片 / 网站复刻 / HyperFrames |
| 发送按钮 | 约 (1163, 242) | 圆形按钮 |

## 5. 原生「选择文件夹」对话框

图 2 的对话框是 Windows 原生 `#32770`（由 Electron `dialog.showOpenDialog` 拉起），
带「文件夹:」编辑框与「选择文件夹」/「取消」按钮。适配器据此约定：

- **归属核对优先**：先取受管实例的进程 pid 集合，用 `EnumWindows` + `GetWindowThreadProcessId`
  递归父进程匹配（与 `kimicode/dialog.ts` 同源实现），只操作命中的窗口；
- 路径写入与确认走 UIA / 键盘（实现细节在 P2 落地并补证据）；
- 归属不明或对话框未出现 → 关闭自己拉起的对话框并转 `needs_user(system_permission)`，**绝不误伤用户窗口**。

## 6. `app-config.json` 旁证字段

`%APPDATA%\Open Design\namespaces\<namespace>\data\app-config.json` 实测内容（节选）：

```json
{
  "agentId": "amr",
  "designSystemId": "default",
  "agentModels": { "amr": { "model": "deepseek-v4.1-flash" } },
  "recentLinkedDirs": ["D:\\Trae项目\\tianshu-mcp"],
  "defaultProjectLocationId": "default"
}
```

用途：**只作旁证与诊断**（退出码为 `agentModels`/`recentLinkedDirs` 可佐证「上次选了哪个模型 / 绑了哪个目录」），
**界面回读才是权威判据**——直接改这个文件绕开点击不属于本适配器的行为边界。

探针 `appconfig` 子命令只读打印这些字段。

## 7. 设计系统与模型取值来源

| 项 | 来源 |
|---|---|
| 设计系统清单 | `<安装目录>\resources\open-design\design-systems\<slug>\manifest.json` 的 `name`（如 `claude` → `Claude (Anthropic)`），内置 151 个包 |
| 模型 ID | 打包产物中的模型注册表；实测存在 `deepseek-v4-flash` / `deepseek-v4-pro` / `claude-fable-5` |
| 设计方向 | UI 提供 6 项，**适配器只支持**「原型 / 文档 / 网站复刻」，其余显式拒绝 |

模型与设计系统一律**精确匹配 + 命中后回读**：未命中即报错并回显当前可见候选
（见 `model.ts` 的 `matchMenuCandidate`），不做模糊匹配——选错模型比报错更糟。

## 8. 失败码表

| 失败码（`endReason`） | 触发条件 | 编排侧动作 |
|---|---|---|
| `setup_failed` | 入口校验失败（设计方向非法/任务书为空/未找到可执行） | 硬失败，不进验收 |
| `version_mismatch` | 产品版本不在 `opendesign.supportedVersions` | 硬失败并回显实测版本 |
| `selector_drift` / `not_implemented` | 关键选择器缺失或界面驱动未接完 | 硬失败，附缺失键清单 |
| `model_mismatch` | 模型菜单里精确匹配不到目标名 | 硬失败并回显候选 |
| `needs_user` | 已有实例未开调试端口 / 需人工处理 | 任务转 `needs_user`，`continue_task` 恢复 |

## 9. 复现要点

```sh
npm run build
# ⚠️ 先清掉会让启动器退化成 Node 的变量（见 §2.1）；受管启动已自动净化，手工排查时需自行清除
unset ELECTRON_RUN_AS_NODE; unset NODE_OPTIONS      # Windows PowerShell: Remove-Item Env:\ELECTRON_RUN_AS_NODE

node scripts/probe-opendesign.mjs install      # 安装/版本/命名空间/数据目录
node scripts/probe-opendesign.mjs process      # 进程与根进程判定
node scripts/probe-opendesign.mjs appconfig    # app-config.json 旁证
node scripts/probe-opendesign.mjs cdp          # 端口与 page target（需实例带调试端口）
node scripts/probe-opendesign.mjs anchors      # 界面锚点盘点（需实例带调试端口）
```

**采集选择器的完整步骤**（需要外网可达，否则主线程会卡在启动期请求）：

1. 关闭所有 Open Design 窗口（未开调试端口的实例无法接管）；
2. `node scripts/probe-opendesign.mjs anchors --launch`：启动受管实例 → 打印
   `/json/version`、page target 拓扑、每个语义键的候选命中数与文本、页面可见文本前 1200 字符；
3. 把收敛出的稳定 CSS 写回 `src/agents/opendesign/selectors.ts` 的 `primary`
   （或在 `agent-profiles.json` 的 `gui.selectors` 里按语义键覆盖，不必发版）；
4. 重新 `anchors`，确认「布局守卫」一节显示**全部命中**；
5. 把证据贴进本文 §4 的锚点表。

`--no-focus`：连接后不置前（纯 DOM 读取用）。点击类诊断**必须置前**——
后台页面会被 Chromium 节流，合成事件不可靠。
