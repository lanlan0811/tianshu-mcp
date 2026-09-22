# agent-profiles.md — Agent 适配与 Profiles 说明

外部 AI-Agent 通过 **profile** 接入 tianshu-mcp：每个 agent 是一段声明式数据（可执行/参数模板/工作目录/env/超时/登录方式），**新增 agent 无需改代码**——在数据目录 `agent-profiles.json` 加一个 profile 即可（需要特殊输出解析的再补一个 adapter 子类）。

## 存储位置

| 级别 | 文件 | 说明 |
|---|---|---|
| 内置 | `src/agents/builtin.ts` | 代码内置默认 profiles（codex/zcode/traework/kimicode）；随版本更新 |
| 用户级 | `~/.tianshu-mcp/agent-profiles.json`（`TIANSHU_MCP_HOME` 可覆盖） | 整键覆盖内置同名 profile |

合并规则：先内置，再用户级覆盖（同 `id` 用户级胜出）。

## Profile 字段

```jsonc
{
  "profiles": {
    "<agentId>": {
      "displayName": "Codex (OpenAI 桌面端 CLI)",   // 展示名
      "type": "cli",                                  // 目前仅 cli
      "driver": "spawn",                              // spawn=外部子进程（默认）；gui=桌面 UI 自动化
      "adapter": "zcode-gui",                         // GUI 可选：traework-gui | zcode-gui | codex-gui | kimicode-gui | qoder-gui；旧缺省按 TraeWork 兼容
      "status": "ready",                              // ready | research | unsupported
      "command": null,                                // 可执行；null + discovery 则自动探测
      "argsTemplate": ["exec", "<prompt:arg>", "--skip-git-repo-check"],
      "promptMode": "arg",                            // arg | stdin | file
      "cwd": "task",                                  // task=项目目录, home=用户主目录
      "env": {},                                      // 追加环境变量（敏感值本机自填）
      "timeoutMs": 1800000,
      "killTree": "taskkill",                         // taskkill | group
      "authNote": "复用 ~/.codex 登录态",              // 仅说明，不落密钥
      "executableDiscovery": {                        // 可执行自动发现（选填）
        "dirs": ["C:/Users/<你>/AppData/Local/OpenAI/Codex/bin"],
        "fileNames": ["codex.exe", "codex"],          // 无 fileNames 则目录不扫描
        "fallbackCommand": "codex",                   // 最后回退：PATH 查找
        "preferredDrives": ["D:"],                    // Windows 固定盘优先级
        "relativePaths": ["Z-Code/ZCode/ZCode.exe"]   // 相对盘根候选
      },
      "gui": {                                        // 仅 driver="gui" 使用（如 traework）
        "cdpPort": 9222, "cdpPortAuto": true, "cdpPortRange": 20,
        "exeArgs": ["--remote-debugging-port=<port>"], "windowMode": "reuse",
        "launchTimeoutMs": 60000, "pollIntervalMs": 3000, "stableRounds": 12,
        "idleTimeoutMs": 600000, "cdpSendTimeoutMs": 15000, "progressIntervalMs": 30000,
        "modelSwitch": true, "modeSwitch": true, "freshSession": true, "selectors": {},
        "modelRequired": false, "defaultPermissionMode": "完全访问", "defaultAutoFixRounds": 2
      }
    }
  }
}
```

### driver（执行面）

| 值 | 说明 |
|---|---|
| `spawn`（默认） | 拉起外部 CLI 子进程（`argsTemplate` + `promptMode`），结果按退出码判定 |
| `gui` | 通过 CDP 驱动桌面 UI（当前为 `traework` / `zcode` / `codex` / `kimicode`）；不 spawn 子进程，`run_task` 可传 `model` 指定其模型 |

> `driver=gui` 时 `argsTemplate`/`promptMode` 不生效。显式 `adapter` 用于隔离各 GUI 实现；旧 profile 缺失该字段时仍按 TraeWork 行为兼容。分别见 [traework-cdp.md](traework-cdp.md)、[zcode-cdp.md](zcode-cdp.md)、[codex-gui-cdp.md](codex-gui-cdp.md)、[kimi-cdp.md](kimi-cdp.md) 与 [qoder-cdp.md](qoder-cdp.md)。

TraeWork 存活检测相关字段：`stableRounds` 仅确认 DOM 已稳定；随后还需持续 `idleTimeoutMs` 无变化且无运行信号才返回
`idle`。`cdpSendTimeoutMs` 限制单次 CDP 命令等待，`progressIntervalMs` 控制 `query_task` 可见的进度事件频率。
空闲、超时、取消与 CDP 断开会保留实例，并在 meta 中返回 `agentEndReason` / `keptInstance`。

### promptMode

| 模式 | 说明 |
|---|---|
| `arg` | prompt 内联进参数：`argsTemplate` 中的 `<prompt:arg>` 被替换 |
| `stdin` | prompt 经 stdin 传入（stdio 管道），**最通用** |
| `file` | 先写 `<任务目录>/prompt-<round>.txt`，参数里 `<prompt:file>` 指向它 |

### 探测顺序（resolve）

`executableDiscovery.dirs` 支持 `{LOCALAPPDATA}`、`{APPDATA}`、`{HOME}`、`{USERPROFILE}`、`{PROGRAMFILES}`、`{PROGRAMFILES(X86)}`、`{SYSTEMDRIVE}` 与 `{XDG_DATA_HOME}`。占位符大小写不敏感，文档和内置 profile 统一使用全大写；未知或当前环境未定义的占位符保留原样。

1. `command` 是存在的绝对路径 → 直接使用
2. `executableDiscovery.dirs` 里找 `fileNames`（**必须有 fileNames 才扫目录**），取修改时间最新的
3. `fallbackCommand` / 相对 command 在 PATH 中查找
4. 全失败 → `ok:false`，`get_profiles` 会显示原因

> Codex 桌面端为 MSIX 应用：自 2026-09-11 起用 `codex-gui`（GUI 驱动，见 [codex-gui-cdp.md](codex-gui-cdp.md)），**不再走 `codex exec`**。早期内核 CLI 的 `<hash>` 目录探测结论保留于 adapter-matrix 的 C1 节。

## 本机真实样例

### Codex 桌面端（GUI 驱动，2026-09-11 Windows 真机已验证）

```jsonc
// ~/.tianshu-mcp/agent-profiles.json （Windows 示例）
{
  "profiles": {
    "codex": {
      "displayName": "Codex (ChatGPT 桌面端 GUI)",
      "type": "cli",
      "driver": "gui",
      "adapter": "codex-gui",
      "status": "ready",
      "command": null,
      "argsTemplate": [],
      "promptMode": "arg",
      "cwd": "task",
      "timeoutMs": 1800000,
      "killTree": "taskkill",
      "authNote": "复用 ~/.codex 登录态（与用户手动打开的实例共享；受管实例使用专属 user-data-dir）",
      "executableDiscovery": {
        // Appx 查询优先（自动跟版本），失败回退扫盘；均动态，不含版本号/绝对路径
        "appxPackageName": "OpenAI.Codex",
        "installRelativeExe": ["app/ChatGPT.exe"],
        "scanRoots": ["{SYSTEMDRIVE}/Program Files/WindowsApps"],
        "scanPattern": "OpenAI.Codex_*_x64__*/app/ChatGPT.exe"
      },
      "gui": {
        "activation": "msix-com",
        "userDataDir": "{LOCALAPPDATA}/tianshu-mcp/codex-gui/profile",
        "appxPackageName": "OpenAI.Codex",
        "cdpPort": 9333,
        "cdpPortAuto": true,
        "permissionMode": "完全访问",
        "fixPlanDir": ".zcode/plans",
        "defaultAutoFixRounds": 5,
        "launchTimeoutMs": 60000,
        "pollIntervalMs": 3000,
        "stableRounds": 4,
        "idleTimeoutMs": 600000,
        "selectors": {}
      }
    }
  }
}
```

> **要点**：`activation: "msix-com"` 与 `userDataDir` 缺一不可——GUI 宿主 `ChatGPT.exe` 无法直启（策略拒绝），且复用默认 profile 时调试端口不会开启。详见 [codex-gui-cdp.md](codex-gui-cdp.md)。

### Kimi Code（GUI 驱动，2026-09-20 Windows 真机已验证）

```jsonc
// ~/.tianshu-mcp/agent-profiles.json （Windows 示例；下列即内置默认值）
{
  "profiles": {
    "kimicode": {
      "displayName": "Kimi Code (Kimi Code 桌面端)",
      "type": "cli",
      "driver": "gui",
      "adapter": "kimicode-gui",
      "status": "ready",                 // darwin 为 "research"（fail-closed）
      "command": null,
      "argsTemplate": [],
      "promptMode": "arg",
      "cwd": "task",
      "timeoutMs": 1800000,
      "killTree": "taskkill",
      "authNote": "复用本机 Kimi Code 登录态；检测到未开启 CDP 的既有实例时需用户先关闭该实例",
      "executableDiscovery": {
        "dirs": [
          "{PROGRAMFILES}/Kimi Code",
          "{PROGRAMFILES(X86)}/Kimi Code",
          "{LOCALAPPDATA}/Programs/Kimi Code",
          "{LOCALAPPDATA}/Kimi Code",
          "/Applications/Kimi Code.app/Contents/MacOS",
          "{HOME}/Applications/Kimi Code.app/Contents/MacOS"
        ],
        "fileNames": ["Kimi Code.exe", "Kimi Code"],
        "preferredDrives": ["D:"],
        "relativePaths": [
          "Kimi-Code/Kimi Code/Kimi Code.exe",
          "Kimi Code/Kimi Code.exe",
          "Kimi/Kimi Code/Kimi Code.exe",
          "kimi-code/kimi code/kimi code.exe"
        ]
      },
      "gui": {
        "cdpPort": 9666,                 // CDP 基准端口；被占用时按 cdpPortRange 自动顺延
        "cdpPortAuto": true,
        "cdpPortRange": 20,
        "exeArgs": ["--remote-debugging-port=<port>"],
        "windowMode": "reuse",
        "launchTimeoutMs": 90000,        // 冷启动首帧 + 渲染实测偏慢，放宽到 90s
        "pollIntervalMs": 3000,
        "stableRounds": 4,
        "idleTimeoutMs": 600000,
        "stallTimeoutMs": 300000,
        "cancelWaitMs": 15000,
        "cdpSendTimeoutMs": 15000,
        "progressIntervalMs": 30000,
        "modelSwitch": true,
        "modeSwitch": false,             // 不支持 mode 参数
        "freshSession": true,
        "modelRequired": true,
        "activation": "spawn",           // 普通 Electron 安装，直启即可（无 MSIX COM）
        "permissionMode": "完全自动",
        "defaultPermissionMode": "完全自动",
        "defaultAutoFixRounds": 2,
        "workspaceTriggerTimeoutMs": 15000, // 可选：等待 ws-chip 挂载（草稿页判据）的上限
        "selectors": {}
      }
    }
  }
}
```

> **要点**：Kimi Code 是**普通 Electron 安装**（实测 1.0.2），`--remote-debugging-port` 注入即可，**不需要** MSIX COM 激活。
> **双渲染进程**：模型 / 思考档位 / 执行模式菜单渲染在 `Kimi Browser Overlay` 浮层窗口，工作区菜单与「切换模型」对话框在主窗口。
> 任务以**工作区**（任务文件夹）组织，**不支持无项目派发**：必须提供 `projectPath`，未登记的工作区经原生「添加工作区」对话框导入。
> 默认权限为「完全自动」、默认自动返修 2 轮。详见 [kimi-cdp.md](kimi-cdp.md)。

### Qoder CN（GUI 驱动，2026-09-22 Windows 真机已验证）

```jsonc
// ~/.tianshu-mcp/agent-profiles.json （Windows 示例；下列即内置默认值）
{
  "profiles": {
    "qoder": {
      "displayName": "Qoder CN",
      "type": "cli",
      "driver": "gui",
      "adapter": "qoder-gui",
      "status": "ready",                 // darwin 为 "research"（fail-closed，禁止派发）
      "command": null,
      "argsTemplate": [],
      "promptMode": "arg",
      "cwd": "task",
      "authNote": "复用 Qoder CN 登录态；无法连接的已有实例须用户处理，不自动重启。",
      "executableDiscovery": {
        "preferredDrives": ["D:"],
        "relativePaths": ["Qoder CN/Qoder CN.exe", "Program Files/Qoder CN/Qoder CN.exe"],
        "fileNames": ["Qoder CN.exe"],   // macOS 为 ["Qoder CN"]
        "dirs": [
          "{LOCALAPPDATA}/Programs/Qoder CN",
          "{PROGRAMFILES}/Qoder CN",
          "{PROGRAMFILES(X86)}/Qoder CN"
        ]
      },
      "gui": {
        "cdpPort": 9777,                 // CDP 基准端口；被占用时按 cdpPortRange 自动顺延
        "cdpPortRange": 20,
        "launchTimeoutMs": 90000,
        "cdpSendTimeoutMs": 30000,
        "stableRounds": 2,
        "defaultAutoFixRounds": 3,
        "modeSwitch": false,             // 不支持 mode 参数
        "modelRequired": false,          // 模型与等级可省略，沿用界面当前值
        "selectors": {}
      }
    }
  }
}
```

> **要点**：`projectPath` 与 `planDoc` 必填；`modelSource` 选填，用于消除“默认/自定义”跨组重名。
> 显式 `gui.exePath` 无效时直接报错，不会偷偷换用另一份安装；已有实例无可用 CDP 时保留现场并转
> `needs_user`，绝不关闭或重启。未登记目录经「新的任务 → 工作区 → 新建工作区 → 添加可读写文件夹」导入。
> 思考等级经「模型管理」保存为**全局偏好**（不自动还原），权限模式沿用不切换。详见 [qoder-cdp.md](qoder-cdp.md)。

### 历史：Codex 内核 CLI（`codex exec`，已被 GUI 驱动取代）

```jsonc
{
  "profiles": {
    "codex": {
      "displayName": "Codex (桌面端 CLI)",
      "type": "cli",
      "status": "ready",
      "command": "C:/Users/<你>/AppData/Local/OpenAI/Codex/bin/<hash>/codex.exe",
      "argsTemplate": ["exec", "<prompt:arg>", "--skip-git-repo-check", "--sandbox", "workspace-write"],
      "promptMode": "arg",
      "cwd": "task",
      "killTree": "taskkill",
      "executableDiscovery": { "dirs": ["{LOCALAPPDATA}/OpenAI/Codex/bin"], "fileNames": ["codex.exe"] }
    }
  }
}
```

> 历史实测见 [m2-smoke-record.md](m2-smoke-record.md)；`<hash>` 目录随 Codex 更新，用 `executableDiscovery` 自动取最新。该路径已不作为内置默认。

## 状态与轮询语义

| status | 含义 | run_task 行为 |
|---|---|---|
| `ready` | 已配 command / discovery 可解析 | 可跑 |
| `research` | 实现已存在，但真机证据尚未完整（当前为 zcode） | 安装探测成功时可跑；否则立即失败并说明原因 |
| `unsupported` | 明确不支持（见 adapter-matrix.md） | 同上 |

> `traework` 已于 2026-09-08 由 `unsupported` 改为 `ready` + `driver=gui`（CDP 驱动桌面 UI，见 [traework-cdp.md](traework-cdp.md)）。

> `zcode` 使用 `driver=gui` + `adapter=zcode-gui`。`model` 必须是 `供应商/模型`，默认权限为“完全访问”、默认自动返修 2 轮。Windows 真机闭环已完成；macOS 真机证据完成前内置状态保持 `research`。

> `codex` 使用 `driver=gui` + `adapter=codex-gui` + `activation=msix-com`。任务参数含 `model`（如 `GPT-5.6 Sol`）、`reasoningLevel`（低/中/高 或 low/medium/high）、`planDoc`、`designSystem`；默认权限“完全访问”、默认自动返修 5 轮。Windows 真机已验证；macOS 内置状态为 `research`。详见 [codex-gui-cdp.md](codex-gui-cdp.md)。

> `kimicode` 使用 `driver=gui` + `adapter=kimicode-gui` + `activation=spawn`（普通 Electron 安装，实测 1.0.2）。`model` 必填且直接填界面模型名（如 `K3`、`K2.8 Preview`、`stepfun/step-3.7-flash:free`），**不支持 `mode`**；CDP 基准端口 `9666`（`cdpPortAuto` 时按 `cdpPortRange` 顺延），`launchTimeoutMs` 90000，默认权限「完全自动」、默认自动返修 2 轮。Windows 真机已验证（成功路径 / 未登记工作区导入 + 自动验收 / 失败→返修→再验收同会话闭环）；macOS 为 `research` 且 fail-closed。详见 [kimi-cdp.md](kimi-cdp.md)。

> `qoder` 使用 `driver=gui` + `adapter=qoder-gui`（仅 Qoder CN）。`projectPath` 与可读 `planDoc` 必填；`modelSource` 选填（`default` / `custom`）；CDP 基准端口 `9777`（`cdpPortAuto` 时按 `cdpPortRange` 顺延），`launchTimeoutMs` 90000，`stableRounds` 2，默认自动返修 3 轮。思考等级经「模型管理」保存为**全局偏好**并回读，权限模式沿用不切换（不自动开启“完全访问”）。Windows 真机已验证（已有工作区默认模型、新登记工作区自定义模型、受控失败 → 落计划 → 原会话返修 → 再验收）；macOS 为 `research` 且 fail-closed。详见 [qoder-cdp.md](qoder-cdp.md)。

### reasoningLevel 取值域与适用档位

`run_task.reasoningLevel` 的取值域自 v0.5.5 起扩展，v0.5.6 再补 Qoder 档位：

| 取值 | 说明 |
|---|---|
| `low` / `medium` / `high`（别名：`低` / `中` / `高`） | 通用三档，供 Codex 使用 |
| `max` / `on` / `off` | Kimi Code 的界面档位：官方模型为 `Low` / `High` / `Max`，非官方模型只有 `On` / `Off` |
| `xhigh` / `极高`、`最大`、`关闭思考` | Qoder CN 档位别名（`最大`/`关闭思考` 复用 `max`/`off`）；仅 `qoder-gui` 接受别名，其他适配器传入即报错 |

各 agent 的适用档位与语义：

| agent | 适用档位 | 行为 |
|---|---|---|
| `codex` | `low` / `medium` / `high` | 不传沿用 Codex 面板当前等级 |
| `kimicode` | 官方模型 `low` / `high` / `max`；非官方模型 `on` / `off` | 档位集合以**界面实际渲染的档位标签**为准（不内置模型名单）；不传时官方档位沿用界面当前值、非官方档位强制 `on`；请求界面不存在的档位在**发送前**以 `model_mismatch` 响亮报错，绝不静默沿用 |
| `qoder` | 低 / 中 / 高 / 极高（`xhigh`）/ 最大（`max`）/ 关闭思考（`off`） | 可用档位以**该模型在「模型管理」中实际渲染的选项**为准；不支持的档位在**发送前**报错，禁止静默降级。不传时沿用界面当前值并记录；保存后重新打开回读验证，修改会保留为全局偏好 |
| `traework` / `zcode` / spawn 类 | 不适用 | 传入会被忽略或按各 adapter 语义拒绝 |

## 常见问题

- **探测到错误文件**：检查 `fileNames` 只写合法可执行名。ZCode 只探测桌面程序 `ZCode.exe`/macOS bundle，不把 `db.sqlite`、运行时数据或未公开的 app-server 当作入口。
- **profile 改动不生效**：server 每次 resolve 会重读 profiles 文件并缓存结果；`get_profiles` 会触发一次新探测。改完 profile 建议重启 server。
- **env 有敏感值**：仅本机可见，不会写入 task.jsonl/日志；属于自担风险字段。
- **driver=gui 的 agent 找不到可执行**：`get_profiles` 会显示探测结果；可在 profile 里直接配 `gui.exePath` 指定绝对路径。

## ZCode / Kimi Code 初始化自动恢复

以下 `gui` 字段可在数据目录的 `agent-profiles.json` 中覆盖；旧配置自动采用默认值，其他驱动不使用这些恢复字段。

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `setupRecoveryTimeoutMs` | 120000 | 从开始初始化到项目绑定完成的总预算（毫秒） |
| `projectTriggerTimeoutMs` | 15000 | 等待并确认 ZCode 项目触发器就绪的上限（含点击后确认菜单打开的预算） |
| `workspaceTriggerTimeoutMs` | 15000 | **可选**（Kimi Code 专用）：等待工作区触发器（`button.ws-chip`）挂载的上限，即「草稿页是否真的建立」的判据；ZCode 不使用该字段。刻意声明为可选而非带默认值，以免既有 profile 字面量被迫改动 |
| `dialogProbeTimeoutMs` | 30000 | 单次原生对话框探测上限（毫秒） |
| `dialogOperationTimeoutMs` | 60000 | 单次文件夹操作上限（毫秒） |
| `setupRecoveryMaxRetries` | 2 | 可安全重试阶段的额外重试次数（0–10） |

各次等待使用配置上限、初始化剩余预算与任务剩余时间中的最小值；重试不重置总预算。绑定完成后仅保留任务总时限。初始化中的周期进度沿用 `progressIntervalMs`。
