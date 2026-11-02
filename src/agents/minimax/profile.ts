import { AgentProfileSchema } from '../../config/schema.js';

/**
 * MiniMax Code 安装探测与运行参数（第七个 GUI agent）。
 *
 * 真机取证（2026-10-05，MiniMax Code 3.1.0 / Electron 42.8.0 / Chromium 148.0.7778.280，Windows 10.0.19045）：
 * - 普通 Electron 安装（非 MSIX）：`--remote-debugging-port=9999` 直启即生效（实测 /json/version 返回 200）；
 * - 实测安装于 `D:\MiniMax-Code\MiniMax Code\MiniMax Code.exe`（232MB）；
 * - **双渲染进程**：主窗口 `MiniMax Code`（`app://./archon`）承载侧栏/会话/composer；
 *   模型弹层在独立的 `Model menu` 窗口（`.../dist/model-menu/index.html`）；
 *   另有无关的 `Rsbuild App` 截图页必须过滤掉；
 * - 推理等级/上下文窗口**不是平铺项**，而是悬停模型项后展开的**二级子菜单**（见 minimax/selectors.ts）。
 *
 * 端口基准 9999（区段 9999–10008），与既有 9222/9333/9666/9777/9889 均不重叠。
 * 不设版本门禁（无 `resources/*-config.json` 版本文件，版本号只能从 CDP UA 读，
 * 而 UA 在驱动失败时恰恰读不到），改用 `selector_drift` 兜底——失败可诊断。
 *
 * Installation roots and timing are profile data, overridable in agent-profiles.json.
 */
export const MINIMAX_PROFILE = AgentProfileSchema.parse({
  displayName: 'MiniMax Code',
  type: 'cli',
  driver: 'gui',
  adapter: 'minimax-gui',
  status: process.platform === 'win32' ? 'ready' : 'research',
  command: null,
  argsTemplate: [],
  promptMode: 'arg',
  cwd: 'task',
  env: {},
  timeoutMs: 30 * 60_000,
  killTree: 'taskkill',
  authNote:
    '复用本机 MiniMax Code 登录态；检测到未开启 CDP 的既有实例时需用户先关闭该实例（不自动结束用户进程）。',
  executableDiscovery: {
    dirs: [
      '{PROGRAMFILES}/MiniMax Code',
      '{PROGRAMFILES(X86)}/MiniMax Code',
      '{LOCALAPPDATA}/Programs/MiniMax Code',
      '{LOCALAPPDATA}/MiniMax Code',
      '/Applications/MiniMax Code.app/Contents/MacOS',
      '{HOME}/Applications/MiniMax Code.app/Contents/MacOS',
    ],
    fileNames: process.platform === 'darwin' ? ['MiniMax Code'] : ['MiniMax Code.exe'],
    fallbackCommand: undefined,
    // 真机实测安装在 D 盘（`D:\MiniMax-Code\MiniMax Code\`），D 盘相对路径优先。
    preferredDrives: ['D:'],
    relativePaths: [
      'MiniMax-Code/MiniMax Code/MiniMax Code.exe',
      'MiniMax Code/MiniMax Code.exe',
    ],
    installRelativeExe: [],
    scanRoots: [],
  },
  gui: {
    setupRecoveryTimeoutMs: 300_000,
    projectTriggerTimeoutMs: 15_000,
    dialogProbeTimeoutMs: 30_000,
    dialogOperationTimeoutMs: 60_000,
    setupRecoveryMaxRetries: 2,
    // 端口基准 9999：与 zcode·codex 9333 / kimicode 9666 / opendesign 9889 不重叠（9777 已随 Qoder CN 移除而空出）。
    cdpPort: 9999,
    cdpPortAuto: true,
    cdpPortRange: 10,
    exeArgs: ['--remote-debugging-port=<port>'],
    windowMode: 'reuse',
    // Electron 冷启动 + 主窗口渲染，实测中等偏慢；给 120s 留足余量。
    launchTimeoutMs: 120_000,
    pollIntervalMs: 3_000,
    // 停止按钮为权威运行信号（产物实测 `stop-button`），稳定轮用于文本稳定兜底。
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
    activation: 'spawn',
    permissionMode: '始终授权',
    defaultPermissionMode: '始终授权',
    fixPlanDir: '.minimax/plans',
    defaultAutoFixRounds: 2,
  },
  minimax: {
    submenuOpenTimeoutMs: 8_000,
    modelMenuTimeoutMs: 10_000,
    sendReadyTimeoutMs: 20_000,
    levelLabels: {},
    planDir: '.minimax/plans',
  },
  note: 'MiniMax Code 桌面端（Electron，官方安装包，实测 3.1.0）：普通安装、--remote-debugging-port 直启即生效。模型弹层渲染在独立的 `Model menu` 窗口，且推理等级/上下文窗口是**悬停模型项后展开的二级子菜单**（不是平铺项）。详见 docs/minimax-cdp.md',
});
