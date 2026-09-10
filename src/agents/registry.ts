/**
 * AgentAdapterRegistry：agentId → profile + adapter 解析、可执行探测与结果缓存。
 * 探测结果缓存到内存 profile；版本目录（如 Codex <hash>）变化时自动失效重探。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentAdapter, ResolvedAgent, AgentRunResult, TaskContext } from "./adapter.js";
import { CliAdapter } from "./cli.js";
import { TraeworkGuiAdapter } from "./traework/adapter.js";
import { ZcodeGuiAdapter } from "./zcode/adapter.js";
import { discoverZcode } from "./zcode/discovery.js";
import type { AgentProfile } from "../config/schema.js";
import type { SpawnResult } from "./spawn.js";
import { Logger } from "../util/log.js";
import { expandEnvPath, platformDefaultDiscoveryDirs } from "../util/path.js";

export class AgentAdapterRegistry {
  private adapters = new Map<string, AgentAdapter>();
  private resolveCache = new Map<string, ResolvedAgent>();

  constructor(
    private readonly loadProfiles: () => Promise<Record<string, AgentProfile>>,
    private readonly logger: Logger,
  ) {
    // 默认：所有 profile 都用通用 CLI adapter（按 profile.promptMode 传递 prompt）。
    // driver=gui 的 profile 会在 resolve() 时替换为 GUI adapter（见 ensureAdapterFor）。
    for (const id of ["codex", "zcode", "traework", "stub"]) {
      this.adapters.set(id, new CliAdapter(id));
    }
  }

  /**
   * 按 profile.driver 选择 adapter 实现。
   * spawn → CliAdapter（子进程）；gui → TraeworkGuiAdapter（CDP 驱动桌面 UI）。
   * 仅在实现类型变化时重建，避免每轮 resolve 都换实例；自定义 agentId 也会按需创建。
   */
  private ensureAdapterFor(agentId: string, profile: AgentProfile): void {
    const adapterType = profile.adapter ?? (profile.driver === "gui" ? "traework-gui" : undefined);
    const current = this.adapters.get(agentId);
    if (adapterType === "zcode-gui") {
      if (!(current instanceof ZcodeGuiAdapter))
        this.adapters.set(agentId, new ZcodeGuiAdapter(agentId));
    } else if (adapterType === "traework-gui") {
      if (!(current instanceof TraeworkGuiAdapter))
        this.adapters.set(agentId, new TraeworkGuiAdapter(agentId));
    } else if (
      current instanceof TraeworkGuiAdapter ||
      current instanceof ZcodeGuiAdapter ||
      !current
    ) {
      this.adapters.set(agentId, new CliAdapter(agentId));
    }
  }

  register(id: string, adapter: AgentAdapter): void {
    this.adapters.set(id, adapter);
    this.resolveCache.delete(id);
  }

  getAdapter(id: string): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  listAgentIds(): string[] {
    return Array.from(this.adapters.keys());
  }

  /** 若 adapter 需要 prompt 文件（promptMode=file），调用其 prepare */
  async prepareInvocation(id: string, ctx: TaskContext, resolved: ResolvedAgent): Promise<void> {
    const a = this.adapters.get(id);
    if (a instanceof CliAdapter) {
      await a.prepare(ctx, resolved);
    }
  }

  /** 解析并探测一个 agent。loadProfiles 按 mtime 热加载；cache 命中依赖 profile 对象引用（R5）。 */
  async resolve(agentId: string, cache = true): Promise<ResolvedAgent> {
    const profiles = await this.loadProfiles();
    const profile = profiles[agentId];
    if (!profile) {
      this.resolveCache.delete(agentId);
      return {
        id: agentId,
        displayName: agentId,
        profile: {} as AgentProfile,
        command: "",
        argsTemplate: [],
        ok: false,
        message: `未配置 agent '${agentId}'，请在 agent-profiles.json 中添加 profile`,
      };
    }
    const cached = this.resolveCache.get(agentId);
    if (cache && cached && cached.profile === profile) return cached;
    // driver 决定执行面实现（spawn/gui）——在解析前对齐 adapter 类型
    this.ensureAdapterFor(agentId, profile);
    const resolved = this.resolveProfile(agentId, profile);
    if (resolved.ok) this.resolveCache.set(agentId, resolved);
    return resolved;
  }

  /** 清空缓存（profile 改动后调用） */
  invalidate(agentId?: string): void {
    if (agentId) this.resolveCache.delete(agentId);
    else this.resolveCache.clear();
  }

  private resolveProfile(agentId: string, profile: AgentProfile): ResolvedAgent {
    if (profile.status === "unsupported") {
      return {
        id: agentId,
        displayName: profile.displayName || agentId,
        profile,
        command: "",
        argsTemplate: profile.argsTemplate,
        ok: false,
        message: profile.note || `agent '${agentId}' 被标记为 unsupported`,
      };
    }
    if (profile.status === "research") {
      if (profile.adapter === "zcode-gui") {
        const found = discoverZcode(profile);
        if (found)
          return {
            id: agentId,
            displayName: profile.displayName || agentId,
            profile,
            command: found.path,
            argsTemplate: profile.argsTemplate,
            ok: true,
            message: `探测到 ZCode 可执行: ${found.path}${found.version ? ` (v${found.version})` : ""}`,
            discovered: {
              source: found.source === "explicit" ? "explicit" : "discovery",
              version: found.version,
            },
          };
      }
      const disc = profile.executableDiscovery;
      if (disc && (disc.dirs.length > 0 || disc.fallbackCommand) && disc.fileNames.length > 0) {
        const dirs = (disc.dirs.length > 0 ? disc.dirs : platformDefaultDiscoveryDirs()).map((d) =>
          expandEnvPath(d),
        );
        const found = this.probeDiscovery(agentId, disc.fileNames, dirs, disc.fallbackCommand);
        if (found) {
          return {
            id: agentId,
            displayName: profile.displayName || agentId,
            profile,
            command: found,
            argsTemplate: profile.argsTemplate,
            ok: true,
            message: `探测到可执行: ${found}`,
            discovered: { source: "discovery" },
          };
        }
        return {
          id: agentId,
          displayName: profile.displayName || agentId,
          profile,
          command: "",
          argsTemplate: profile.argsTemplate,
          ok: false,
          message: profile.note || `agent '${agentId}' 尚处于调研/占位状态，未探测到可执行文件`,
        };
      }
      return {
        id: agentId,
        displayName: profile.displayName || agentId,
        profile,
        command: "",
        argsTemplate: profile.argsTemplate,
        ok: false,
        message: profile.note || `agent '${agentId}' 未配置 command（研究占位）`,
      };
    }

    const cmd = (profile.command ?? "").trim();
    // command 为空但配置了 discovery（ready + 自动发现）→ 走共享发现逻辑
    if (cmd === "") {
      const disc = profile.executableDiscovery;
      if (disc && disc.fileNames.length > 0) {
        const dirs = (disc.dirs.length > 0 ? disc.dirs : platformDefaultDiscoveryDirs()).map((d) =>
          expandEnvPath(d),
        );
        const found = this.probeDiscovery(agentId, disc.fileNames, dirs, disc.fallbackCommand);
        if (found) {
          return {
            id: agentId,
            displayName: profile.displayName || agentId,
            profile,
            command: found,
            argsTemplate: profile.argsTemplate,
            ok: true,
            message: `探测到可执行: ${found}`,
            discovered: { source: "discovery" },
          };
        }
      }
      return {
        id: agentId,
        displayName: profile.displayName || agentId,
        profile,
        command: "",
        argsTemplate: profile.argsTemplate,
        ok: false,
        message: profile.note || `agent '${agentId}' 未配置可执行 command 且未探测到`,
      };
    }
    // 占位符形如 <…> → 视为未配置
    if (cmd.startsWith("<")) {
      return {
        id: agentId,
        displayName: profile.displayName || agentId,
        profile,
        command: "",
        argsTemplate: profile.argsTemplate,
        ok: false,
        message:
          profile.note ||
          `agent '${agentId}' 的 command 仍是占位符，请按 docs/agent-profiles.md 配置真实路径`,
      };
    }

    // 1) 显式绝对路径且存在 → 直接使用
    if (fs.existsSync(cmd)) {
      return {
        id: agentId,
        displayName: profile.displayName || agentId,
        profile,
        command: cmd,
        argsTemplate: profile.argsTemplate,
        ok: true,
        message: "使用显式 command",
        discovered: { source: "explicit" },
      };
    }
    // 2) discovery 目录扫描（占位符展开 + 平台标准候选；源码无用户名/盘符硬编码）
    const disc = profile.executableDiscovery;
    if (disc && disc.fileNames.length > 0) {
      const dirs = (disc.dirs.length > 0 ? disc.dirs : platformDefaultDiscoveryDirs()).map((d) =>
        expandEnvPath(d),
      );
      const found = this.probeDiscovery(agentId, disc.fileNames, dirs, disc.fallbackCommand);
      if (found) {
        return {
          id: agentId,
          displayName: profile.displayName || agentId,
          profile,
          command: found,
          argsTemplate: profile.argsTemplate,
          ok: true,
          message: `探测到可执行: ${found}`,
          discovered: { source: "discovery" },
        };
      }
    }
    // 3) 路径内查找（PATH 命令）
    if (!path.isAbsolute(cmd)) {
      const inPath = this.findInPath(cmd);
      if (inPath) {
        return {
          id: agentId,
          displayName: profile.displayName || agentId,
          profile,
          command: inPath,
          argsTemplate: profile.argsTemplate,
          ok: true,
          message: "使用 PATH 中命令",
          discovered: { source: "fallback" },
        };
      }
    }
    return {
      id: agentId,
      displayName: profile.displayName || agentId,
      profile,
      command: cmd,
      argsTemplate: profile.argsTemplate,
      ok: false,
      message: `agent '${agentId}' 的可执行未找到（command='${cmd}'）。请安装对应 CLI，或在 agent-profiles.json 的 executableDiscovery 中配置真实安装目录`,
    };
  }

  private probeDiscovery(
    agentId: string,
    fileNames: string[],
    dirs: string[],
    fallback: string | undefined,
  ): string | null {
    const candidates: { p: string; mtime: number }[] = [];
    for (const d of dirs) {
      if (!d || !fs.existsSync(d)) continue;
      // 必须有明确的文件名模式才扫描目录，避免把任意文件误判为可执行
      const names = fileNames.length > 0 ? fileNames : undefined;
      if (!names) continue;
      const found = this.findFiles(d, names, 6);
      for (const f of found) {
        try {
          candidates.push({ p: f, mtime: fs.statSync(f).mtimeMs });
        } catch {
          /* ignore */
        }
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    this.logger.debug(
      `agent '${agentId}' 探测候选: ${candidates.map((c) => c.p).join(", ") || "无"}`,
    );
    if (candidates.length > 0) return candidates[0]!.p;
    if (fallback) {
      if (!path.isAbsolute(fallback)) {
        const inPath = this.findInPath(fallback);
        if (inPath) return inPath;
        return null;
      }
      if (fs.existsSync(fallback)) return fallback;
    }
    return null;
  }

  private findFiles(root: string, names: string[] | undefined, maxDepth: number): string[] {
    const out: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > maxDepth) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (e.isFile() && (!names || names.includes(e.name))) out.push(full);
      }
    };
    walk(root, 0);
    return out;
  }

  private findInPath(cmd: string): string | null {
    const isWin = process.platform === "win32";
    const whichCmd = isWin ? "where" : "which";
    const res = spawnSync(whichCmd, [cmd], { windowsHide: true, encoding: "utf8" });
    if (res.status !== 0 || !res.stdout) return null;
    const first = res.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 0);
    return first ?? null;
  }
}

/** parseExit 快捷转发：任何 adapter 都能处理 */
export function parseExitFor(adapter: AgentAdapter | undefined, res: SpawnResult): AgentRunResult {
  if (adapter) return adapter.parseExit(res);
  const r: AgentRunResult = { ...res };
  if (res.error && res.exitCode === null) r.hardFailure = true;
  return r;
}
