/**
 * Codex 项目登记（解决「新建项目依赖原生对话框」的脆弱路径）。
 *
 * 背景（真机实测）：Codex 桌面端的项目列表来自 `~/.codex/.codex-global-state.json` 的
 * `local-projects` + `project-order`。项目若未登记：
 *  - 通过界面「新建项目 → 源文件夹」需要应用窗口处于前台并驱动 Windows 原生文件夹对话框，
 *    无人值守下不稳定（前台锁）；
 *  - 因此这里提供**直接登记**的确定性路径：把目标目录写入 Codex 的项目状态，等价于用户
 *    在 Codex 里手动创建过一次。
 *
 * 安全约束（fail-closed → 失败即回退到界面路径，绝不破坏用户状态）：
 *  - 仅在 Windows 且状态文件存在、可解析时生效；
 *  - **幂等**：已存在同路径登记则直接返回，不写文件；
 *  - 写入前**备份**（`.tianshu-mcp-backup.json`，只在不存在时创建，避免覆盖良好备份）；
 *  - **原子写**（临时文件 + rename），只改 `local-projects` / `project-order` 两个键，
 *    其余键原样保留；
 *  - 只在**本 MCP 受管实例停止**时写入，避免运行中的 Codex 用内存态覆盖；
 *    绝不停止/触碰用户手动打开的默认实例。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentRunLogger } from "../adapter.js";
import { listCodexProcesses, normalizeDir, remoteUserDataDir, resolveUserDataDir } from "./instance.js";
import { execFileAsync } from "../../verify/exec.js";
import type { GuiProfile } from "../../config/schema.js";

/** Codex 全局状态文件路径 */
export function codexStatePath(): string {
  return path.join(os.homedir(), ".codex", ".codex-global-state.json");
}

/** 备份文件路径（不覆盖已有备份） */
export function codexStateBackupPath(): string {
  return `${codexStatePath()}.tianshu-mcp-backup.json`;
}

interface LocalProjectEntry {
  id?: string;
  name?: string;
  rootPaths?: string[];
  createdAt?: number;
  updatedAt?: number;
  [k: string]: unknown;
}

interface CodexGlobalState {
  "local-projects"?: Record<string, LocalProjectEntry>;
  "project-order"?: string[];
  [k: string]: unknown;
}

/** 是否已在 Codex 项目列表中登记该目录（按当前平台语义归一：Windows 大小写不敏感，POSIX 保留大小写） */
export function isProjectRegistered(
  state: CodexGlobalState,
  projectPath: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const want = normalizeDir(projectPath, platform);
  const projects = state["local-projects"] ?? {};
  for (const [id, entry] of Object.entries(projects)) {
    if (!entry || !Array.isArray(entry.rootPaths)) continue;
    if (entry.rootPaths.some((rp) => typeof rp === "string" && normalizeDir(rp, platform) === want)) {
      return entry.id ?? id;
    }
  }
  return null;
}

/** 停止本 MCP 的受管 Codex 实例（绝不触碰默认 profile 实例） */
async function stopManagedInstances(gui: GuiProfile): Promise<void> {
  const wanted = normalizeDir(resolveUserDataDir(gui));
  const rows = (await listCodexProcesses()).filter((p) => {
    if (/--type=|crashpad/i.test(p.commandLine)) return false;
    const udd = remoteUserDataDir(p.commandLine);
    return udd ? normalizeDir(udd) === wanted : false;
  });
  if (!rows.length) return;
  for (const p of rows) {
    try {
      if (process.platform === "win32") {
        // eslint-disable-next-line no-await-in-loop
        await execFileAsync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { timeoutMs: 15_000 });
      } else {
        // POSIX（macOS）：受管实例是独立 profile 的子进程，SIGTERM 即可（Electron 会自行带走 Helper）
        process.kill(p.pid, "SIGTERM");
      }
    } catch {
      /* 已退出或权限不足：忽略，后续 ensureInstance 会重探 */
    }
  }
}

export interface RegisterResult {
  /** performed=实际写入了登记；already=已登记；skipped=条件不满足（回退界面路径） */
  status: "performed" | "already" | "skipped";
  projectId?: string;
  message: string;
}

/**
 * 确保目标目录已在 Codex 项目列表中登记。
 * 返回 skipped 时调用方应回退到界面「新建项目」路径。
 */
export async function ensureProjectRegistered(
  projectPath: string,
  gui: GuiProfile,
  logger: AgentRunLogger,
  opts: { stateFile?: string; platform?: NodeJS.Platform; stopInstances?: (gui: GuiProfile) => void | Promise<void> } = {},
): Promise<RegisterResult> {
  const platform = opts.platform ?? process.platform;
  // 状态文件位于 ~/.codex（跨平台同构），Windows 与 macOS 均可直接登记
  if (platform !== "win32" && platform !== "darwin")
    return { status: "skipped", message: "非 Windows/macOS，跳过 Codex 项目登记" };
  const stateFile = opts.stateFile ?? codexStatePath();
  if (!fs.existsSync(stateFile))
    return { status: "skipped", message: `未找到 Codex 状态文件：${stateFile}` };

  let state: CodexGlobalState;
  let original: string;
  try {
    original = fs.readFileSync(stateFile, "utf8");
    state = JSON.parse(original) as CodexGlobalState;
  } catch (e) {
    return { status: "skipped", message: `Codex 状态文件不可解析：${e instanceof Error ? e.message : String(e)}` };
  }

  const existingId = isProjectRegistered(state, projectPath, platform);
  if (existingId) return { status: "already", projectId: existingId, message: `已在 Codex 项目列表：${existingId}` };

  // 写入前先停受管实例，避免运行中的 Codex 覆盖本次修改
  await (opts.stopInstances ?? stopManagedInstances)(gui);

  const id = randomUUID();
  const now = Date.now();
  const name = path.basename(projectPath) || projectPath;
  const projects = state["local-projects"] ?? {};
  projects[id] = { id, name, rootPaths: [projectPath], createdAt: now, updatedAt: now };
  state["local-projects"] = projects;
  const order = Array.isArray(state["project-order"]) ? state["project-order"] : [];
  state["project-order"] = [id, ...order.filter((x) => x !== id)];

  try {
    // 备份只在不存在时创建，保留最初的良好副本
    const backup = `${stateFile}.tianshu-mcp-backup.json`;
    if (!fs.existsSync(backup)) fs.copyFileSync(stateFile, backup);
    const tmp = `${stateFile}.tianshu-mcp-tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), "utf8");
    fs.renameSync(tmp, stateFile);
  } catch (e) {
    return { status: "skipped", message: `写入 Codex 状态失败：${e instanceof Error ? e.message : String(e)}` };
  }

  logger.info(`[codex] 已登记项目到 Codex 列表：${name}（${id}）；备份：${stateFile}.tianshu-mcp-backup.json`);
  return { status: "performed", projectId: id, message: `已登记项目：${name}` };
}
