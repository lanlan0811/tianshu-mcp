/**
 * DataHome：数据目录（~/.tianshu-mcp，env TIANSHU_MCP_HOME 覆盖）下的
 * config.json / agent-profiles.json / projects.json 读写与内存缓存。
 */
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import {
  AgentProfilesFileSchema,
  ProjectsFileSchema,
  type AcceptanceCheckDef,
  type AgentProfile,
  type ProjectRecord,
  type ServerConfig,
  ServerConfigSchema,
  type AcceptanceCheck,
} from "./schema.js";
import { writeJsonAtomic, mkdirp, readDirSafe, exists } from "../util/fs.js";
import { createHash } from "node:crypto";
import { Logger } from "../util/log.js";
import { projectHash, normPath } from "../util/path.js";
import { nowIso } from "../util/id.js";

export function resolveDataHome(): string {
  const env = process.env.TIANSHU_MCP_HOME;
  if (env && env.trim()) return path.resolve(env.trim());
  return path.join(os.homedir(), ".tianshu-mcp");
}

/** 把 task.jsonl 等事件里的字符串命令转成规范化 argv */
export function splitCmd(cmd: string): string[] {
  // 极简 argv 分词：支持引号包裹（"..." 与 '...'），不执行 shell
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}

export function toAcceptanceDef(c: AcceptanceCheck): AcceptanceCheckDef {
  const cmd = Array.isArray(c.cmd) ? [...c.cmd] : splitCmd(c.cmd);
  return {
    name: c.name,
    cmd,
    displayCmd: cmd.join(" "),
    timeoutMs: c.timeoutMs,
    optional: c.optional,
  };
}

export class DataHome {
  readonly dir: string;
  private configCache: ServerConfig | null = null;
  private configCacheStamp = "";
  private projectsCache: Record<string, ProjectRecord> | null = null;
  private projectsCacheStamp = "";
  private _profilesCache: Record<string, AgentProfile> | null = null;
  private _profilesCacheStamp = "";

  constructor(
    dir: string,
    private readonly logger: Logger,
    private readonly builtinProfiles: Record<string, AgentProfile> = {},
  ) {
    this.dir = dir;
  }

  get configPath(): string {
    return path.join(this.dir, "config.json");
  }
  get profilesPath(): string {
    return path.join(this.dir, "agent-profiles.json");
  }
  get projectsPath(): string {
    return path.join(this.dir, "projects.json");
  }
  get logsDir(): string {
    return path.join(this.dir, "logs");
  }
  get tasksRoot(): string {
    return path.join(this.dir, "tasks");
  }
  taskDir(taskId: string): string {
    return path.join(this.tasksRoot, taskId);
  }

  async init(): Promise<void> {
    await mkdirp(this.dir);
    await mkdirp(this.tasksRoot);
    await mkdirp(this.logsDir);
  }

  /* ---------- config ---------- */

  /**
   * 内容失效签名（S5）：文件内容 sha256。能检测同一 mtime tick 内的同长度修改；
   * 无法读文件时回退 "0"（每次重读）。
   */
  private async fileStamp(p: string): Promise<string> {
    try {
      const buf = await fsp.readFile(p);
      return createHash("sha256").update(buf).digest("hex");
    } catch {
      return "0";
    }
  }

  async loadConfig(): Promise<ServerConfig> {
    const stamp = await this.fileStamp(this.configPath);
    if (this.configCache && this.configCacheStamp === stamp) return this.configCache;
    const { raw, exists: fileExists } = await this.readJsonWithExists(this.configPath);
    // 文件不存在 → 首次默认
    if (!fileExists) {
      const def = ServerConfigSchema.parse({});
      if (!this.configCache) {
        this.configCache = def;
        this.configCacheStamp = stamp;
      }
      return this.configCache;
    }
    if (raw == null) {
      // 文件存在但 JSON 损坏 → 保留上一有效配置（S5 last-known-good）
      this.logger.warn(`config.json JSON 损坏，保留上一有效配置`);
      if (this.configCache) return this.configCache;
      return ServerConfigSchema.parse({});
    }
    const r = ServerConfigSchema.safeParse(raw);
    if (r.success) {
      this.configCache = r.data;
      this.configCacheStamp = stamp;
      return r.data;
    }
    // schema 校验失败 → 保留上一有效配置
    this.logger.warn(`config.json schema 校验失败，保留上一有效配置: ${r.error.message}`);
    return this.configCache ?? ServerConfigSchema.parse({});
  }

  /** 读 JSON 且区分"文件不存在"与"JSON 损坏" */
  private async readJsonWithExists(p: string): Promise<{ raw: unknown | null; exists: boolean }> {
    try {
      const text = await fsp.readFile(p, "utf8");
      try {
        return { raw: JSON.parse(text), exists: true };
      } catch {
        return { raw: null, exists: true };
      }
    } catch {
      return { raw: null, exists: false };
    }
  }

  async saveConfig(cfg: ServerConfig): Promise<void> {
    await writeJsonAtomic(this.configPath, cfg);
    this.configCache = cfg;
    this.configCacheStamp = await this.fileStamp(this.configPath);
  }

  /* ---------- agent-profiles ---------- */

  /** 用户级 profiles（数据目录）叠加内置 profiles，用户键覆盖内置；按内容 stamp 热加载（S5） */
  async loadProfiles(): Promise<Record<string, AgentProfile>> {
    const stamp = await this.fileStamp(this.profilesPath);
    if (this._profilesCache && this._profilesCacheStamp === stamp) return this._profilesCache;
    const merged: Record<string, AgentProfile> = {};
    // 先内置，再数据目录覆盖（clone 防串改缓存）
    for (const [k, v] of Object.entries(this.builtinProfiles)) {
      merged[k] = { ...v, id: k };
    }
    const { raw, exists: fileExists } = await this.readJsonWithExists(this.profilesPath);
    if (fileExists && raw == null) {
      // JSON 损坏 → 保留上一有效（若有）；否则仅内置
      this.logger.warn(`agent-profiles.json JSON 损坏，保留上一有效 profiles`);
      if (this._profilesCache) return this._profilesCache;
      this._profilesCache = merged;
      this._profilesCacheStamp = stamp;
      return merged;
    }
    if (raw != null) {
      const r = AgentProfilesFileSchema.safeParse(raw);
      if (r.success) {
        for (const [k, v] of Object.entries(r.data.profiles)) {
          merged[k] = { ...v, id: k };
        }
      } else {
        this.logger.warn(`agent-profiles.json 校验失败，保留上一有效 profiles: ${r.error.message}`);
        if (this._profilesCache) return this._profilesCache;
      }
    }
    this._profilesCache = merged;
    this._profilesCacheStamp = stamp;
    return merged;
  }

  async saveProfiles(profiles: Record<string, AgentProfile>): Promise<void> {
    // 只持久化用户自定义部分与覆盖项，不含内置（内置由代码演进）
    const user = { ...profiles };
    for (const key of Object.keys(this.builtinProfiles)) {
      const b = this.builtinProfiles[key];
      const u = profiles[key];
      if (u && JSON.stringify(u) === JSON.stringify(b)) delete user[key];
    }
    await writeJsonAtomic(this.profilesPath, { profiles: user });
    this._profilesCache = null;
  }

  /** 供 get_profiles / adapter resolve 使用：返回一份 profile（含内置合并） */
  async getProfile(id: string): Promise<AgentProfile | undefined> {
    const all = await this.loadProfiles();
    return all[id];
  }

  /* ---------- projects 自动登记 ---------- */

  /** 解析 projects.json：Zod 校验（S5），解析/校验失败保留上一有效值 */
  private async loadProjectsRaw(): Promise<{ ok: boolean; map: Record<string, ProjectRecord>; error?: string; missing?: boolean }> {
    const { raw, exists: fileExists } = await this.readJsonWithExists(this.projectsPath);
    if (!fileExists) return { ok: true, map: {}, missing: true }; // 文件不存在 = 空（首次）
    if (raw == null) return { ok: false, map: {}, error: "JSON 损坏" };
    const r = ProjectsFileSchema.safeParse(raw);
    if (!r.success) {
      return { ok: false, map: {}, error: r.error.message };
    }
    return { ok: true, map: r.data };
  }

  async loadProjects(): Promise<Record<string, ProjectRecord>> {
    const stamp = await this.fileStamp(this.projectsPath);
    if (this.projectsCache && this.projectsCacheStamp === stamp) return this.projectsCache;
    const { ok, map, error } = await this.loadProjectsRaw();
    if (!ok) {
      this.logger.warn(`projects.json 解析失败，保留上一有效 projects: ${error}`);
      if (this.projectsCache) return this.projectsCache;
      return {}; // 首次即非法：给空 map（不写入覆盖磁盘）
    }
    this.projectsCache = map;
    this.projectsCacheStamp = stamp;
    return map;
  }

  async registerProject(p: string, defaultAgentId?: string): Promise<{ hash: string; record: ProjectRecord }> {
    const norm = normPath(p);
    const hash = projectHash(norm);
    const projects = await this.loadProjects();
    const now = nowIso();
    const existing = projects[hash];
    const record: ProjectRecord = existing
      ? { ...existing, path: norm, lastSeenAt: now, defaultAgentId: defaultAgentId ?? existing.defaultAgentId }
      : { path: norm, displayPath: norm, firstSeenAt: now, lastSeenAt: now, defaultAgentId };
    projects[hash] = record;
    this.projectsCache = projects;
    await writeJsonAtomic(this.projectsPath, projects);
    this.projectsCacheStamp = await this.fileStamp(this.projectsPath);
    return { hash, record };
  }

  async updateProjectVerify(hash: string, verify: AcceptanceCheckDef[]): Promise<void> {
    const projects = await this.loadProjects();
    const rec = projects[hash];
    if (!rec) return;
    rec.verify = verify.map((v) => ({ name: v.name, cmd: v.cmd }));
    this.projectsCache = projects;
    await writeJsonAtomic(this.projectsPath, projects);
    this.projectsCacheStamp = await this.fileStamp(this.projectsPath);
  }

  async projectByPath(p: string): Promise<{ hash: string; record?: ProjectRecord }> {
    const norm = normPath(p);
    const hash = projectHash(norm);
    const projects = await this.loadProjects();
    return { hash, record: projects[hash] };
  }

  /* ---------- 遗留任务扫描（启动归档用） ---------- */

  async listTaskDirs(): Promise<string[]> {
    const dirs = await readDirSafe(this.tasksRoot);
    return dirs.filter((d) => d.startsWith("tsk_"));
  }

  async dataDirHasJson(): Promise<boolean> {
    return (await exists(this.configPath)) || (await exists(this.projectsPath));
  }
}
