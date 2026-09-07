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
    argsTemplate: ["exec", "<prompt:arg>", "--skip-git-repo-check"],
    promptMode: "arg",
    cwd: "task",
    env: {},
    timeoutMs: 30 * 60_000,
    killTree: "taskkill",
    authNote: "复用 ~/.codex 登录态（与桌面端同账号）；需本机已装 Codex 桌面端",
    executableDiscovery: {
      dirs: ["C:/Users/Lenovo/AppData/Local/OpenAI/Codex/bin"],
      fileNames: ["codex.exe", "codex"],
      fallbackCommand: "codex",
    },
    note: "精确 flags 以 `codex exec --help` 最终确认为准（profile 数据可改，无需改代码）",
  },
  zcode: {
    displayName: "Zcode (本机 CLI)",
    type: "cli",
    status: "research",
    command: null,
    argsTemplate: [],
    promptMode: "arg",
    cwd: "task",
    env: {},
    timeoutMs: 30 * 60_000,
    killTree: "taskkill",
    authNote: "复用本机 Zcode 登录态",
    note: "M2 前置调研（开发计划 §13 Z1）确认真实无头入口后再填 command/argsTemplate；当前不自动探测，避免误判",
  },
  traework: {
    displayName: "TraeWork",
    type: "cli",
    status: "research",
    command: null,
    argsTemplate: [],
    promptMode: "arg",
    cwd: "task",
    env: {},
    timeoutMs: 30 * 60_000,
    killTree: "taskkill",
    authNote: "",
    note: "M3 调研（§13 T1）：Trae CN / TRAE SOLO CN 是否提供可编程 CLI/接口；无接口则标 unsupported",
  },
};

export const BUILTIN_PROFILE_IDS = Object.keys(BUILTIN_PROFILES);
