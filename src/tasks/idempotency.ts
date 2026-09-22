/**
 * 幂等键索引（issue #15）：把「宿主超时重试」从重复副作用改为幂等重放。
 *
 * 设计要点：
 * - 单一事实源：`<数据目录>/idempotency.json`（原子写、懒加载、TTL + 容量裁剪），
 *   内存 `entries` 作为读侧索引；进程重启后仍能识别重试。
 * - 命名空间隔离：`run_task` 与 `verify_task` 各自一份 key 空间，互不干扰。
 * - 冲突 fail-closed：同一 key 换了参数（digest 不同）必须报冲突，绝不静默返回错误结果。
 * - `runExclusive`：同一 (scope,key) 的「先查后写」串行化，避免并发重复建任务。
 * - `reserveInFlight` / `releaseInFlight`：`verify_task` 的**进程内**执行中标记，刻意不落盘——
 *   重启后引擎已死，若把 in_progress 落盘会永久谎报「仍在执行」。
 * - 健壮性：文件损坏时从任务快照重建一次；写失败不抛错，交调用方如实披露（fail-open）。
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  IDEMPOTENCY_MAX_ENTRIES_DEFAULT,
  IDEMPOTENCY_TTL_DEFAULT_MS,
  IdempotencyScopeSchema,
  type IdempotencyScope,
} from "../config/schema.js";
import { exists, readJsonSafe, writeJsonAtomic } from "../util/fs.js";
import type { Logger } from "../util/log.js";
import type { TaskStore } from "./task-store.js";

/* ---------------- 落盘结构（本模块私有，非外部配置） ---------------- */

export const IdempotencyEntrySchema = z.object({
  scope: IdempotencyScopeSchema,
  /** 调用方提供的键原文（仅存本地快照文件，不写日志正文） */
  key: z.string().min(1),
  /** 首次提交的入参摘要；再次提交 digest 不一致即 fail-closed 冲突 */
  digest: z.string().min(1),
  /** 该键对应的任务/验收记录 id */
  taskId: z.string().min(1),
  kind: z.enum(["task", "verify"]),
  createdAt: z.string(),
  /** 仅 kind="verify"：该次验收的轮次与结论（重放时如实回报，不重跑） */
  reportRound: z.number().int().min(0).optional(),
  verdict: z.enum(["passed", "failed"]).optional(),
  reportMd: z.string().optional(),
  reportJson: z.string().optional(),
});
export type IdempotencyEntry = z.infer<typeof IdempotencyEntrySchema>;

export const IdempotencyFileSchema = z.object({
  version: z.literal(1).default(1),
  entries: z.array(IdempotencyEntrySchema).default([]),
});

/** 命中判定结果：`hit`（同键同参）/ `conflict`（同键异参，fail-closed）/ `miss`。 */
export type IdempotencyLookup =
  | { kind: "hit"; entry: IdempotencyEntry }
  | { kind: "conflict"; entry: IdempotencyEntry }
  | { kind: "miss" };

export interface IdempotencyIndexOptions {
  /** 数据目录（`idempotency.json` 的父目录） */
  home: string;
  store: TaskStore;
  logger: Logger;
  /** 每次读配置以获得最新的 ttlMs / maxEntries（热加载） */
  loadConfig: () => Promise<{ idempotency?: { ttlMs?: number; maxEntries?: number } }>;
}

/** 键摘要（日志/事件流只用它，避免键明文外流）。 */
export function keyDigest(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 8);
}

/** 稳定序列化：对象键排序、数组保持顺序、`undefined` 一律省略（同一入参必得同一摘要）。 */
function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** 入参摘要：与字段书写顺序、`undefined` 缺省无关，保证「同一份入参 = 同一摘要」。 */
export function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function mapKey(scope: IdempotencyScope, key: string): string {
  // 用 NUL 分隔，避免 scope 与 key 的边界被拼接歧义
  return `${scope}\u0000${key}`;
}

export class IdempotencyIndex {
  private readonly entries = new Map<string, IdempotencyEntry>();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  /** 同一 (scope,key) 的串行尾链（沿用 TaskStore.statusWriteTails 范式） */
  private readonly tails = new Map<string, Promise<void>>();
  /** 进程内「验收执行中」标记：key → taskId */
  private readonly inFlight = new Map<string, string>();
  private filePathValue: string | null = null;

  constructor(private readonly opts: IdempotencyIndexOptions) {}

  /** 懒计算路径：构造期不做任何 fs/path 操作（测试用假上下文可能没有 home）。 */
  private get filePath(): string {
    if (this.filePathValue === null) {
      this.filePathValue = path.join(this.opts.home ?? "", "idempotency.json");
    }
    return this.filePathValue;
  }

  private async limits(): Promise<{ ttlMs: number; maxEntries: number }> {
    let cfg: { idempotency?: { ttlMs?: number; maxEntries?: number } } = {};
    try {
      cfg = await this.opts.loadConfig();
    } catch {
      cfg = {};
    }
    const ttlMs = cfg.idempotency?.ttlMs ?? IDEMPOTENCY_TTL_DEFAULT_MS;
    const maxEntries = cfg.idempotency?.maxEntries ?? IDEMPOTENCY_MAX_ENTRIES_DEFAULT;
    return { ttlMs, maxEntries };
  }

  private expired(entry: IdempotencyEntry, ttlMs: number): boolean {
    const at = Date.parse(entry.createdAt);
    if (!Number.isFinite(at)) return true; // 时间戳不可解析 = 视为过期，陈旧键不得永久占用
    return Date.now() - at >= ttlMs;
  }

  /** 首次使用时加载映射文件（缺失 = 空索引；损坏 = warn + 从任务快照重建一次）。 */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.doLoad()
      .catch((e) => {
        // 加载失败（IO 异常等）不得阻断派发：退化为空索引并告警
        this.opts.logger.warn(`幂等映射加载失败，退化为空索引：${String(e)}`);
      })
      .finally(() => {
        this.loaded = true;
        this.loadPromise = null;
      });
    return this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    if (!(await exists(this.filePath))) return; // 首次使用：空索引
    const raw = await readJsonSafe<unknown>(this.filePath);
    if (raw == null) {
      this.opts.logger.warn(`idempotency.json 损坏（JSON 不可解析），尝试从任务快照重建`);
      await this.rebuildFromSnapshots();
      return;
    }
    const parsed = IdempotencyFileSchema.safeParse(raw);
    if (!parsed.success) {
      this.opts.logger.warn(
        `idempotency.json 校验失败，尝试从任务快照重建：${parsed.error.message}`,
      );
      await this.rebuildFromSnapshots();
      return;
    }
    const { ttlMs } = await this.limits();
    for (const entry of parsed.data.entries) {
      if (this.expired(entry, ttlMs)) continue;
      this.entries.set(mapKey(entry.scope, entry.key), entry);
    }
  }

  /**
   * 从任务快照重建（映射文件损坏时的兜底）：只认带 `idempotencyKey` 的快照。
   * 快照里的键是本进程历史写入的明文键，足以恢复「同键重放/同键异参冲突」两项判定。
   */
  async rebuildFromSnapshots(): Promise<void> {
    this.entries.clear();
    try {
      const metas = await this.opts.store.scanAllSnapshots();
      for (const meta of metas) {
        if (!meta.idempotencyKey || !meta.idempotencyScope) continue;
        if (!meta.idempotencyDigest) continue;
        const entry: IdempotencyEntry = {
          scope: meta.idempotencyScope,
          key: meta.idempotencyKey,
          digest: meta.idempotencyDigest,
          taskId: meta.taskId,
          kind: meta.idempotencyScope === "verify_task" ? "verify" : "task",
          createdAt: meta.createdAt,
          reportRound: meta.reportRound,
          verdict: meta.latestVerificationVerdict,
          reportMd: meta.reportMd,
          reportJson: meta.reportJson,
        };
        this.entries.set(mapKey(entry.scope, entry.key), entry);
      }
      this.opts.logger.warn(`幂等映射已从任务快照重建：${this.entries.size} 条`);
    } catch (e) {
      this.opts.logger.warn(`幂等映射重建失败（退化为空索引）：${String(e)}`);
    }
    await this.persist().catch((e) => {
      this.opts.logger.warn(`重建后的幂等映射落盘失败：${String(e)}`);
    });
  }

  /** 按 TTL 剔除过期条目（返回是否发生剔除） */
  private async prune(ttlMs: number, maxEntries: number): Promise<void> {
    for (const [k, entry] of [...this.entries]) {
      if (this.expired(entry, ttlMs)) this.entries.delete(k);
    }
    if (this.entries.size <= maxEntries) return;
    // 超限逐出最旧：createdAt 升序，丢弃前面的
    const sorted = [...this.entries.entries()].sort((a, b) =>
      a[1].createdAt < b[1].createdAt ? -1 : 1,
    );
    for (const [k] of sorted.slice(0, this.entries.size - maxEntries)) this.entries.delete(k);
  }

  private async persist(): Promise<void> {
    const entries = [...this.entries.values()];
    await writeJsonAtomic(this.filePath, { version: 1, entries });
  }

  /**
   * 键判定：命中（同键同参）/ 冲突（同键异参）/ 未命中（含已过期的键）。
   * 过期条目会顺手清除（惰性清理，落盘失败仅告警）。
   */
  async lookup(scope: IdempotencyScope, key: string, digest: string): Promise<IdempotencyLookup> {
    await this.ensureLoaded();
    const k = mapKey(scope, key);
    const entry = this.entries.get(k);
    if (!entry) return { kind: "miss" };
    const { ttlMs, maxEntries } = await this.limits();
    if (this.expired(entry, ttlMs)) {
      this.entries.delete(k);
      await this.prune(ttlMs, maxEntries);
      await this.persist().catch((e) => {
        this.opts.logger.warn(`幂等映射过期条目清理落盘失败：${String(e)}`);
      });
      return { kind: "miss" };
    }
    return entry.digest === digest ? { kind: "hit", entry } : { kind: "conflict", entry };
  }

  /**
   * 记录映射（内存先行，落盘失败**不抛错**，返回 `persisted=false` 交调用方如实披露）。
   * 先写内存的意义：即使落盘失败，本进程内的并发调用仍能命中同一键。
   */
  async record(entry: IdempotencyEntry): Promise<{ persisted: boolean; error?: string }> {
    await this.ensureLoaded();
    this.entries.set(mapKey(entry.scope, entry.key), entry);
    const { ttlMs, maxEntries } = await this.limits();
    await this.prune(ttlMs, maxEntries);
    try {
      await this.persist();
      return { persisted: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.opts.logger.error(`幂等映射落盘失败（keyDigest=${keyDigest(entry.key)}）：${msg}`);
      return { persisted: false, error: msg };
    }
  }

  /**
   * 同一 (scope,key) 串行化：调用方在临界区内完成「二次判定 + 落映射 + 建任务」，
   * 并发同名请求会排队而不是各自建一个任务。
   */
  async runExclusive<T>(scope: IdempotencyScope, key: string, fn: () => Promise<T>): Promise<T> {
    const k = mapKey(scope, key);
    const previous = this.tails.get(k);
    const run = (async () => {
      // 前序失败不得阻断后续（前序自己的错误由它自己的调用方看到）
      if (previous) await previous.catch(() => {});
      return fn();
    })();
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(k, tail);
    try {
      return await run;
    } finally {
      if (this.tails.get(k) === tail) this.tails.delete(k);
    }
  }

  /** 抢占「验收执行中」标记；返回 false 表示已有同键验收在执行。 */
  reserveInFlight(scope: IdempotencyScope, key: string, taskId: string): boolean {
    const k = mapKey(scope, key);
    if (this.inFlight.has(k)) return false;
    this.inFlight.set(k, taskId);
    return true;
  }

  releaseInFlight(scope: IdempotencyScope, key: string): void {
    this.inFlight.delete(mapKey(scope, key));
  }

  inFlightOf(scope: IdempotencyScope, key: string): { taskId: string } | null {
    const taskId = this.inFlight.get(mapKey(scope, key));
    return taskId ? { taskId } : null;
  }
}
