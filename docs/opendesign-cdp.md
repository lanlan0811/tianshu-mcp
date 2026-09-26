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

> **当前状态**：`selectors.ts` 仍为空占位，选择器采集（计划 P1）尚未完成。
> 因此 `run.ts` 在关键选择器缺失时**硬失败 `not_implemented`**——派一个还没接上界面的适配器却报成功，
> 会污染验收与返修记账，比一条清晰的错误危险得多。

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
node scripts/probe-opendesign.mjs install      # 安装/版本/命名空间/数据目录
node scripts/probe-opendesign.mjs process      # 进程与根进程判定
node scripts/probe-opendesign.mjs appconfig    # app-config.json 旁证
node scripts/probe-opendesign.mjs cdp          # 端口与 page target（需实例带调试端口）
node scripts/probe-opendesign.mjs anchors      # 界面锚点盘点（需实例带调试端口）
```

**要跑 `cdp` / `anchors` 必须先让 Open Design 带调试端口启动**：先关闭现有窗口，再
`node scripts/probe-opendesign.mjs anchors --launch`（会新开一个窗口）。
若现有实例在运行且未开端口，探针与适配器都会如实报告 `needs_user(close_existing_instance)`。
