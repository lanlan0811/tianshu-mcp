/**
 * 内置 agent profiles（开发计划 §7.2）。用户数据目录 agent-profiles.json 可整键覆盖。
 * 代码优先、profile 可配：真实路径属于机器/环境数据 → 默认只给结构与探测规则。
 */
import type { AgentProfile } from "../config/schema.js";

export const BUILTIN_PROFILES: Record<string, AgentProfile> = {
  codex: {
    displayName: "Codex (OpenAI 桌面端 CLI)",
    type: "cli",
    driver: "spawn",
    status: "ready",
    command: null,
    argsTemplate: ["exec", "<prompt:arg>", "--skip-git-repo-check", "--sandbox", "workspace-write"],
    promptMode: "arg",
    cwd: "task",
    env: {},
    timeoutMs: 30 * 60_000,
    killTree: "taskkill",
    authNote: "复用 ~/.codex 登录态（与桌面端同账号）；需本机已装 Codex 桌面端；勿与 --approve-for-me 同用（实测互斥）",
    executableDiscovery: {
      dirs: ["{LOCALAPPDATA}/OpenAI/Codex/bin", "{USERPROFILE}/AppData/Local/OpenAI/Codex/bin", "/Applications/Codex.app/Contents/Resources/app/bin"],
      fileNames: ["codex.exe", "codex"],
      fallbackCommand: "codex",
    },
    note: "M2 真实冒烟已定稿（见 docs/m2-smoke-record.md）：--sandbox workspace-write 非交互通过",
  },
  zcode: {
    displayName: "Zcode (ZCode 桌面)",
    type: "cli",
    driver: "spawn",
    status: "unsupported",
    command: null,
    argsTemplate: [],
    promptMode: "arg",
    cwd: "task",
    env: {},
    timeoutMs: 30 * 60_000,
    killTree: "taskkill",
    authNote: "复用本机 ZCode 登录态",
    note: "Z1 实测（2026-09-07）：ZCode = Electron 桌面（D:/Z-Code/ZCode/ZCode.exe），无随包 headless agent-exec CLI，打包 tools 仅 cua-helper/ripgrep/ugrep → 无法无头 spawn → unsupported（详见 docs/adapter-matrix.md §Z1）",
  },
  traework: {
    displayName: "TraeWork (TRAE SOLO CN)",
    type: "cli",
    driver: "gui",
    status: "ready",
    command: null,
    argsTemplate: [],
    promptMode: "arg",
    cwd: "task",
    env: {},
    timeoutMs: 30 * 60_000,
    killTree: "taskkill",
    authNote: "复用 TraeWork 桌面端登录态；窗口需保持可见（发送依赖模拟输入）",
    executableDiscovery: {
      dirs: [
        "D:/TRAE Work CN",
        "{ProgramFiles}/TRAE WORK CN",
        "{ProgramFiles(x86)}/TRAE WORK CN",
        "{LOCALAPPDATA}/Programs/TRAE WORK CN",
        "{LOCALAPPDATA}/TRAE WORK CN",
        "{APPDATA}/TRAE SOLO CN",
        "/Applications/TraeWork.app/Contents/MacOS",
        "/Applications/Trae CN.app/Contents/MacOS",
      ],
      fileNames: ["TRAE SOLO CN.exe", "TraeWork", "TraeWork CN", "Trae CN"],
      fallbackCommand: undefined,
    },
    gui: {
      cdpPort: 9222,
      cdpPortAuto: true,
      cdpPortRange: 20,
      exeArgs: ["--remote-debugging-port=<port>"],
      windowMode: "reuse",
      launchTimeoutMs: 60_000,
      pollIntervalMs: 3_000,
      stableRounds: 12,
      modelSwitch: true,
      freshSession: true,
      selectors: {},
    },
    note: "GUI 驱动（CDP）：T1 旧结论（无头 CLI 不存在）成立，但实测 --remote-debugging-port 可驱动聊天 UI（v1.107.1 已验证连接与关键选择器）。详见 docs/traework-cdp.md",
  },
};

export const BUILTIN_PROFILE_IDS = Object.keys(BUILTIN_PROFILES);
