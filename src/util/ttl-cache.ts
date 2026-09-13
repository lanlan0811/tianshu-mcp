/**
 * 进程级短 TTL 异步缓存（单例、不持久化）。
 * 用途：轮询环内对系统状态枚举（进程列表等）去重——同一 tick 多次调用与相邻 tick
 * 共享同一快照，避免每 500ms 重复 spawn powershell/ps 造成的开销与抖动。
 * key 由调用方给出，必须包含全部调用参数（无参枚举用固定常量即可）。
 */

interface Entry<V> {
  at: number;
  value: Promise<V>;
}

export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();

  constructor(private readonly ttlMs: number) {}

  /**
   * 命中（未过期）直接返回缓存 promise；否则调用 loader 并缓存。
   * 缓存的是 promise 本身：在途调用期间并发调用方共享同一次枚举。
   * loader 拒绝时立即逐出，下一调用重试（不滞留失败结果）。
   * 逐出带身份比较：旧 promise 的迟到 reject 不得误删同 key 已换入的新 entry。
   */
  get(key: string, loader: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = loader();
    this.entries.set(key, { at: Date.now(), value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }

  /** 主动逐出（如杀实例后旧快照在 TTL 内仍命中，需立即失效） */
  delete(key: string): void {
    this.entries.delete(key);
  }
}
