/**
 * 内置 agent profiles（开发计划 §7.2）。用户数据目录 agent-profiles.json 可整键覆盖。
 * 代码优先、profile 可配：真实路径属于机器/环境数据 → 默认只给结构与探测规则。
 */
import type { AgentProfile } from "../config/schema.js";

export const BUILTIN_PROFILES: Record<string, AgentProfile> = {
  codex: {
    displayName: "Codex (OpenAI 桌面端 CLI)",
    type: "cli",
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
      dirs: ["C:/Users/Lenovo/AppData/Local/OpenAI/Codex/bin"],
      fileNames: ["codex.exe", "codex"],
      fallbackCommand: "codex",
    },
    note: "M2 真实冒烟已定稿（见 docs/m2-smoke-record.md）：--sandbox workspace-write 非交互通过",
  },
  zcode: {
    displayName: "Zcode (ZCode 桌面)",
    type: "cli",
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
    status: "unsupported",
    command: null,
    argsTemplate: [],
    promptMode: "arg",
    cwd: "task",
    env: {},
    timeoutMs: 30 * 60_000,
    killTree: "taskkill",
    authNote: "",
    note: "T1 实测（2026-09-07）：本机 D:/TRAE Work CN = TRAE SOLO CN v1.107.1，仅有 VS Code 家族 CLI（open/serve-web/扩展管理），无 codex 风格无头 agent-exec，builtin-mcp 为 MCP 客户端扩展。无可编程无头驱动接口 → unsupported（详见 docs/adapter-matrix.md §T1）。若 Trae 未来提供 headless agent CLI 可重评",
  },
};

export const BUILTIN_PROFILE_IDS = Object.keys(BUILTIN_PROFILES);
