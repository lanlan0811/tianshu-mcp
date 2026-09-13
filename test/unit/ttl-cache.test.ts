/**
 * TtlCache 单测：delete 主动逐出 + 拒绝逐出的身份比较
 * （旧 promise 的迟到 reject 不得误删同 key 已换入的新 entry——杀实例后缓存失效路径依赖此语义）。
 */
import { describe, it, expect } from "vitest";
import { TtlCache } from "../../src/util/ttl-cache.js";

describe("TtlCache", () => {
  it("delete 主动逐出：下一调用重新执行 loader", async () => {
    const cache = new TtlCache<string>(10_000);
    let calls = 0;
    const loader = async () => `v${++calls}`;
    expect(await cache.get("k", loader)).toBe("v1");
    expect(await cache.get("k", loader)).toBe("v1"); // TTL 内命中
    cache.delete("k");
    expect(await cache.get("k", loader)).toBe("v2");
  });

  it("当前 entry 拒绝时逐出：下一调用重试（不滞留失败结果）", async () => {
    const cache = new TtlCache<string>(10_000);
    let calls = 0;
    const first = cache.get("k", async () => {
      calls++;
      throw new Error("boom");
    });
    await expect(first).rejects.toThrow("boom");
    const second = await cache.get("k", async () => {
      calls++;
      return "ok";
    });
    expect(second).toBe("ok");
    expect(calls).toBe(2);
  });

  it("旧 promise 迟到 reject 不误删同 key 新 entry（身份比较）", async () => {
    const cache = new TtlCache<string>(10_000);
    let rejectFirst!: (e: Error) => void;
    const first = cache.get(
      "k",
      () =>
        new Promise<string>((_, rej) => {
          rejectFirst = rej;
        }),
    );
    // 第一笔仍在途时被主动逐出并换入新 entry（杀实例 → invalidate → 重新枚举的形态）
    cache.delete("k");
    const second = cache.get("k", async () => "fresh");
    rejectFirst(new Error("late failure"));
    await expect(first).rejects.toThrow("late failure");
    // 旧 entry 的迟到 reject 不得逐出新 entry：loader 不应再执行
    expect(await cache.get("k", async () => "should-not-run")).toBe("fresh");
    await expect(second).resolves.toBe("fresh");
  });
});
