import { ZCODE_SETUP_DEFAULTS } from "../config/schema.js";
import { MINIMAX_PROFILE } from "./minimax/profile.js";
/**
 * 内置 agent profiles（开发计划 §7.2）。用户数据目录 agent-profiles.json 可整键覆盖。
 * 代码优先、profile 可配：真实路径属于机器/环境数据 → 默认只给结构与探测规则。
 */
import type { AgentProfile } from "../config/schema.js";

export const BUILTIN_PROFILES: Record<string, AgentProfile> = {
  minimax: MINIMAX_PROFILE,
  codex: {
    displayName: "Codex (ChatGPT 桌面端 GUI)",
    type: "cli",
    driver: "gui",
    adapter: "codex-gui",
    // Windows 实测通过（COM 激活 + CDP）后置 ready；macOS 未验证前不启用其就绪判定。
    status: process.platform === "darwin" ? "research" : "ready",
    command: null,
    argsTemplate: [],
    promptMode: "arg",
    cwd: "task",
    env: {},
    timeoutMs: 30 * 60_000,
    killTree: "taskkill",
    authNote:
      "复用 ~/.codex 登录态（与用户手动打开的 Codex 共享；受管实例使用专属 user-data-dir）；需本机已安装 Codex 桌面端",
    executableDiscovery: {
      // MSIX(AppX) 优先查询，失败再扫盘；版本号与 WindowsApps 位置均动态获取，绝不硬编码
      dirs: [],
      fileNames: [],
      fallbackCommand: undefined,
      preferredDrives: ["C:"],
      relativePaths: [],
      appxPackageName: "OpenAI.Codex",
      installRelativeExe: ["app/ChatGPT.exe"],
      scanRoots: ["{SYSTEMDRIVE}/Program Files/WindowsApps"],
      scanPattern: "OpenAI.Codex_*_x64__*/app/ChatGPT.exe",
    },
    gui: {
      ...ZCODE_SETUP_DEFAULTS,
      cdpPort: 9333,
      cdpPortAuto: true,
      cdpPortRange: 30,
      exeArgs: [],
      windowMode: "reuse",
      // Codex 冷启动（MSIX 首帧 + 渲染）可能超过 60s；实测约 60-90s，放宽到 150s
      launchTimeoutMs: 150_000,
      pollIntervalMs: 3_000,
      stableRounds: 4,
      idleTimeoutMs: 10 * 60_000,
      stallTimeoutMs: 5 * 60_000,
      cancelWaitMs: 15_000,
      cdpSendTimeoutMs: 15_000,
      progressIntervalMs: 30_000,
      modelSwitch: true,
      modeSwitch: false,
      freshSession: true,
      selectors: {},
      modelRequired: true,
      // macOS 无 MSIX：直接 spawn .app 包内可执行文件（Electron 同样接受 --user-data-dir/--remote-debugging-port）
      activation: process.platform === "darwin" ? "spawn" : "msix-com",
      userDataDir:
        process.platform === "darwin"
          ? "{HOME}/.tianshu-mcp/codex-gui/profile"
          : "{LOCALAPPDATA}/tianshu-mcp/codex-gui/profile",
      appxPackageName: "OpenAI.Codex",
      permissionMode: "完全访问",
      defaultPermissionMode: "完全访问",
      fixPlanDir: ".zcode/plans",
      defaultAutoFixRounds: 5,
    },
    note: "Codex 桌面端为 MSIX 商店包：GUI 宿主 ChatGPT.exe 无法 CreateProcess 直启（策略拒绝），须经 IApplicationActivationManager COM 激活并注入专属 user-data-dir + --remote-debugging-port；macOS 无 MSIX，直接 spawn ChatGPT.app 包内可执行（activation=spawn）。详见 docs/codex-gui-cdp.md",
  },
  zcode: {
    displayName: "Zcode (ZCode 桌面)",
    type: "cli",
    driver: "gui",
    adapter: "zcode-gui",
    // macOS 真机证据完成前必须保持非 ready；research 仍允许已安装机器执行诊断/任务。
    status: "research",
    command: null,
    argsTemplate: [],
    promptMode: "arg",
    cwd: "task",
    env: {},
    timeoutMs: 30 * 60_000,
    killTree: "taskkill",
    authNote: "复用本机 ZCode 登录态",
    executableDiscovery: {
      dirs: [
        "{PROGRAMFILES}/ZCode",
        "{PROGRAMFILES(X86)}/ZCode",
        "{LOCALAPPDATA}/Programs/ZCode",
        "{LOCALAPPDATA}/ZCode",
        "/Applications/ZCode.app/Contents/MacOS",
        "{HOME}/Applications/ZCode.app/Contents/MacOS",
      ],
      fileNames: ["ZCode.exe", "ZCode"],
      preferredDrives: ["D:"],
      relativePaths: ["Z-Code/ZCode/ZCode.exe", "ZCode/ZCode.exe"],
      installRelativeExe: [],
      scanRoots: [],
    },
    gui: {
      ...ZCODE_SETUP_DEFAULTS,
      cdpPort: 9333,
      cdpPortAuto: true,
      cdpPortRange: 30,
      exeArgs: ["--remote-debugging-port=<port>"],
      windowMode: "reuse",
      launchTimeoutMs: 60_000,
      pollIntervalMs: 3_000,
      stableRounds: 4,
      idleTimeoutMs: 10 * 60_000,
      stallTimeoutMs: 5 * 60_000,
      cancelWaitMs: 15_000,
      cdpSendTimeoutMs: 15_000,
      progressIntervalMs: 30_000,
      modelSwitch: true,
      modeSwitch: false,
      freshSession: true,
      selectors: {},
      modelRequired: true,
      activation: "spawn",
      permissionMode: "完全访问",
      defaultPermissionMode: "完全访问",
      defaultAutoFixRounds: 2,
    },
    note: "ZCode Electron CDP GUI adapter。macOS 真机闭环证据完成前保持 research；已安装环境可探测和执行。",
  },
  kimicode: {
    displayName: "Kimi Code (Kimi Code 桌面端)",
    type: "cli",
    driver: "gui",
    adapter: "kimicode-gui",
    status: process.platform === "darwin" ? "research" : "ready",
    command: null,
    argsTemplate: [],
    promptMode: "arg",
    cwd: "task",
    env: {},
    timeoutMs: 30 * 60_000,
    killTree: "taskkill",
    authNote: "复用本机 Kimi Code 登录态；检测到未开启 CDP 的既有实例时需用户先关闭该实例",
    executableDiscovery: {
      dirs: [
        "{PROGRAMFILES}/Kimi Code",
        "{PROGRAMFILES(X86)}/Kimi Code",
        "{LOCALAPPDATA}/Programs/Kimi Code",
        "{LOCALAPPDATA}/Kimi Code",
        "/Applications/Kimi Code.app/Contents/MacOS",
        "{HOME}/Applications/Kimi Code.app/Contents/MacOS",
      ],
      fileNames: ["Kimi Code.exe", "Kimi Code"],
      preferredDrives: ["D:"],
      relativePaths: [
        "Kimi-Code/Kimi Code/Kimi Code.exe",
        "Kimi Code/Kimi Code.exe",
        "Kimi/Kimi Code/Kimi Code.exe",
        "kimi-code/kimi code/kimi code.exe",
      ],
      installRelativeExe: [],
      scanRoots: [],
    },
    gui: {
      ...ZCODE_SETUP_DEFAULTS,
      cdpPort: 9666,
      cdpPortAuto: true,
      cdpPortRange: 20,
      exeArgs: ["--remote-debugging-port=<port>"],
      windowMode: "reuse",
      launchTimeoutMs: 90_000,
      pollIntervalMs: 3_000,
      stableRounds: 4,
      idleTimeoutMs: 10 * 60_000,
      stallTimeoutMs: 5 * 60_000,
      cancelWaitMs: 15_000,
      cdpSendTimeoutMs: 15_000,
      progressIntervalMs: 30_000,
      modelSwitch: true,
      modeSwitch: false,
      freshSession: true,
      selectors: {},
      modelRequired: true,
      activation: "spawn",
      permissionMode: "完全自动",
      defaultPermissionMode: "完全自动",
      defaultAutoFixRounds: 2,
    },
    note: "Kimi Code（Moonshot AI，实测 1.0.2）为普通 Electron 安装：以 --remote-debugging-port 注入后经 CDP 驱动，无需 MSIX COM 激活。模型菜单/思考档位/执行模式菜单渲染在独立的 Kimi Browser Overlay 渲染进程；任务以「会话文件夹（工作区）」组织。详见 docs/kimi-cdp.md",
  },
  opendesign: {
    displayName: "Open Design (Open Design 桌面端)",
    type: "cli",
    driver: "gui",
    adapter: "opendesign-gui",
    // macOS 无真机证据前保持 research（registry 会拒绝派发）。
    status: process.platform === "darwin" ? "research" : "ready",
    command: null,
    argsTemplate: [],
    promptMode: "arg",
    cwd: "task",
    env: {},
    timeoutMs: 30 * 60_000,
    killTree: "taskkill",
    authNote:
      "复用本机 Open Design 登录态与数据目录（%APPDATA%\\Open Design\\namespaces\\<namespace>；不接受 --user-data-dir）；检测到未开启 CDP 的既有实例时需用户先关闭该实例",
    executableDiscovery: {
      // 普通安装（非 MSIX）：D 盘相对路径优先（实测安装于 D:\\Open Design），
      // 再回退注册表卸载信息与标准目录。可执行名含空格，按完整名精确匹配。
      dirs: [
        "{PROGRAMFILES}/Open Design",
        "{PROGRAMFILES(X86)}/Open Design",
        "{LOCALAPPDATA}/Programs/Open Design",
        "{LOCALAPPDATA}/Open Design",
        "/Applications/Open Design.app/Contents/MacOS",
        "{HOME}/Applications/Open Design.app/Contents/MacOS",
      ],
      fileNames: process.platform === "darwin" ? ["Open Design"] : ["Open Design.exe"],
      fallbackCommand: undefined,
      preferredDrives: ["D:"],
      relativePaths: ["Open Design/Open Design.exe"],
      installRelativeExe: [],
      scanRoots: [],
    },
    gui: {
      ...ZCODE_SETUP_DEFAULTS,
      // 端口基准 9889：实测已占用的基准为 zcode 9333 / codex 9333 / kimicode 9666，
      // 9889-9898 与它们均不重叠（9777-9796 区段已随 Qoder CN 移除而空出）。
      cdpPort: 9889,
      cdpPortAuto: true,
      cdpPortRange: 10,
      // **随机端口**（`=0`），不是固定端口：真机实测（2026-09-27，0.24.1）固定端口会被
      // **不承载窗口的 launcher 进程**抢占——launcher 先绑住端口并驻留，真窗口进程随后绑定失败，
      // 结果 CDP 端点活着 (`/json/version` 正常) 却一个 page target 都没有（`/json/list` 恒为 `[]`），
      // 表现为「端口连得上、却永远判不出就绪」。改成 `=0` 让 launcher 与真窗口进程各拿一个随机端口，
      // 再按 DevToolsActivePort 定位承载窗口的那个（见 opendesign/instance.ts 的 activeDebugPorts）。
      exeArgs: ["--remote-debugging-port=0"],
      windowMode: "reuse",
      // Electron 冷启动 + 内置 151 个设计系统与 sidecar 进程启动，实测偏慢：
      // 真机（2026-09-27）从 spawn 到「输入框真正就绪」实测 45~77s，原来的 90s 只是勉强压线。
      launchTimeoutMs: 120_000,
      // 初始化阶段总预算（接管实例 → 连接主窗口 → 绑目录 → 选模型/设计系统/方向 → 发送）。
      // 缺省沿用 ZCode 的 120_000，但真机实测**单是「启动 + 连接主窗口」就吃掉 77s**，
      // 再叠上原生对话框绑定目录与三个菜单交互，120s 必然中途抛 setup_recovery
      // ——表现为「一切看起来都正常，却报环境需要人工恢复」。这里给足 5 分钟；
      // 该预算是**截止时间**不是每步额度，重试不重置（见 recovery.ts 的 remaining()）。
      setupRecoveryTimeoutMs: 300_000,
      pollIntervalMs: 3_000,
      stableRounds: 4,
      idleTimeoutMs: 10 * 60_000,
      stallTimeoutMs: 5 * 60_000,
      cancelWaitMs: 15_000,
      cdpSendTimeoutMs: 15_000,
      progressIntervalMs: 30_000,
      modelSwitch: true,
      // modeSwitch 走 Open Design 自己的「设计方向」菜单（与已废弃的面板模式参数无关）
      modeSwitch: true,
      freshSession: true,
      selectors: {},
      modelRequired: true,
      activation: "spawn",
      defaultAutoFixRounds: 2,
    },
    opendesign: {
      // 只对接已真机取证的版本；其他版本 fail-closed（见 instance.versionGateError）
      supportedVersions: { win32: ["0.24.1"] },
      // 绑定工作目录的**分步预算**：真机实测（2026-09-27）这一整段要过「展开面板 → 点『选择目录』
      // → Win32 原生对话框填路径 / UIA 回读 / 确认 / 等关闭」四小段，实测 24~35s+ 且波动大。
      // 缺省 15s+20s=35s 的 cap 会在中途被咬断并报成 `operation_timeout`——那是**预算不足**，
      // 不是任何一步真的失败，却会被读成「环境有问题」要求人工恢复。
      workingDirPanelTimeoutMs: 30_000,
      nativeDialogTimeoutMs: 60_000,
      directionLabels: {
        prototype: "原型",
        document: "文档",
        clone: "网站复刻",
      },
      // 修复/优化计划落**项目根下**：Open Design 只能读它工作目录白名单内的文件
      planDir: ".opendesign/plans",
    },
    note: "Open Design 桌面端（Electron，官方安装包，实测 0.24.1）：主进程强制把 Electron userData 设到 %APPDATA%\\Open Design\\namespaces\\<namespace>\\user-data，且 --user-data-dir 开关会被覆盖，因此不做「专属 userData 实例」；进程级单实例锁意味着用户已开着实例时无法另起受管实例，策略为「复用优先 → 自启 → 转 needs_user 请用户关闭旧实例」。设计方向只支持原型/文档/网站复刻。详见 docs/opendesign-cdp.md",
  },
};

export const BUILTIN_PROFILE_IDS = Object.keys(BUILTIN_PROFILES);
