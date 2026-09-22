/**
 * 幂等键单测（issue #15）：
 * - 键规范（trim / 长度 / 控制字符）
 * - canonicalDigest 的键序无关与 undefined 等价
 * - 索引：命中 / 冲突 / TTL 过期 / 容量逐出 / 跨实例重启恢复 / 损坏重建
 * - runExclusive 串行化、在途标记、写失败 fail-open（内存仍命中）
 */
import { describe, it, expect } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  canonicalDigest,
  IdempotencyIndex,
  keyDigest,
  type IdempotencyEntry,
} from "../../src/tasks/idempotency.js";
import { IdempotencyKeySchema } from "../../src/config/schema.js";
import type { TaskStore } from "../../src/tasks/task-store.js";
import type { TaskMeta } from "../../src/tasks/task.js";
import { Logger } from "../../src/util/log.js";
import { makeTmpRoot, rmrf } from "../test-utils.js";

const logger = new Logger(null, "error");

function makeIndex(opts: {
  home: string;
  snapshots?: TaskMeta[];
  ttlMs?: number;
  maxEntries?: number;
}): IdempotencyIndex {
  const store = {
    scanAllSnapshots: async () => opts.snapshots ?? [],
  } as unknown as TaskStore;
  return new IdempotencyIndex({
    home: opts.home,
    store,
    logger,
    loadConfig: async () => ({
      idempotency: {
        ttlMs: opts.ttlMs ?? 24 * 60 * 60_000,
        maxEntries: opts.maxEntries ?? 2000,
      },
    }),
  });
}

function entry(over: Partial<IdempotencyEntry> & { key: string; taskId: string }): IdempotencyEntry {
  return {
    scope: "run_task",
    digest: "d1",
    kind: "task",
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function snapshot(over: Partial<TaskMeta> & { taskId: string }): TaskMeta {
  return {
    status: "succeeded",
    projectPath: "/p",
    displayPath: "/p",
    agentId: "stub",
    task: "t",
    autoVerify: false,
    autoFixRounds: 0,
    taskTimeoutMs: 0,
    round: 0,
    roundsUsed: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

describe("idempotencyKey 参数规范", () => {
  it("trim 后取值，首尾空白不改变键身份", () => {
    expect(IdempotencyKeySchema.parse("  build-42  ")).toBe("build-42");
  });

  it("拒绝空白键、超长键与控制字符", () => {
    expect(() => IdempotencyKeySchema.parse("   ")).toThrow(/不能为空白/);
    expect(() => IdempotencyKeySchema.parse("a".repeat(129))).toThrow(/过长/);
    expect(() => IdempotencyKeySchema.parse("bad\u0007key")).toThrow(/控制字符/);
    expect(() => IdempotencyKeySchema.parse("bad\nkey")).toThrow(/控制字符/);
  });

  it("128 字符边界可接受", () => {
    expect(IdempotencyKeySchema.parse("a".repeat(128))).toHaveLength(128);
  });

  it("keyDigest 是稳定短摘要，不回显键明文", () => {
    expect(keyDigest("build-42")).toBe(keyDigest("build-42"));
    expect(keyDigest("build-42")).toHaveLength(8);
    expect(keyDigest("build-42")).not.toContain("build");
  });
});

describe("canonicalDigest", () => {
  it("键序无关；undefined 与缺省等价；取值不同则摘要不同", () => {
    const a = canonicalDigest({ x: 1, y: { b: 2, a: 3 }, z: undefined });
    const b = canonicalDigest({ y: { a: 3, b: 2 }, x: 1 });
    expect(a).toBe(b);
    expect(canonicalDigest({ x: 1 })).not.toBe(canonicalDigest({ x: 2 }));
    expect(canonicalDigest({ arr: [1, 2] })).not.toBe(canonicalDigest({ arr: [2, 1] }));
  });
});

describe("IdempotencyIndex 判定", () => {
  it("未命中 → 记录 → 命中；异参为冲突", async () => {
    const home = await makeTmpRoot("idem-lookup");
    try {
      const idx = makeIndex({ home });
      expect((await idx.lookup("run_task", "k", "d1")).kind).toBe("miss");
      await idx.record(entry({ key: "k", taskId: "tsk_1", digest: "d1" }));
      const hit = await idx.lookup("run_task", "k", "d1");
      expect(hit.kind).toBe("hit");
      expect(hit.kind === "hit" && hit.entry.taskId).toBe("tsk_1");
      const conflict = await idx.lookup("run_task", "k", "d2");
      expect(conflict.kind).toBe("conflict");
      expect(conflict.kind === "conflict" && conflict.entry.taskId).toBe("tsk_1");
    } finally {
      await rmrf(home);
    }
  });

  it("命名空间隔离：同一键在 run_task / verify_task 下互不干扰", async () => {
    const home = await makeTmpRoot("idem-scope");
    try {
      const idx = makeIndex({ home });
      await idx.record(entry({ key: "K", taskId: "tsk_1", digest: "d1" }));
      await idx.record(
        entry({ scope: "verify_task", key: "K", taskId: "vfy_1", digest: "d2", kind: "verify" }),
      );
      const run = await idx.lookup("run_task", "K", "d1");
      const verify = await idx.lookup("verify_task", "K", "d2");
      expect(run.kind === "hit" && run.entry.taskId).toBe("tsk_1");
      expect(verify.kind === "hit" && verify.entry.taskId).toBe("vfy_1");
    } finally {
      await rmrf(home);
    }
  });

  it("TTL 过期视为未命中并清除记录", async () => {
    const home = await makeTmpRoot("idem-ttl");
    try {
      const idx = makeIndex({ home, ttlMs: 30 });
      await idx.record(
        entry({ key: "k", taskId: "tsk_1", createdAt: new Date(Date.now() - 1000).toISOString() }),
      );
      expect((await idx.lookup("run_task", "k", "d1")).kind).toBe("miss");
    } finally {
      await rmrf(home);
    }
  });

  it("容量上限逐出最旧条目", async () => {
    const home = await makeTmpRoot("idem-cap");
    try {
      const idx = makeIndex({ home, maxEntries: 2 });
      for (const [i, key] of ["old", "mid", "new"].entries()) {
        await idx.record(
          entry({
            key,
            taskId: `tsk_${i}`,
            createdAt: new Date(Date.now() - (3 - i) * 1000).toISOString(),
          }),
        );
      }
      expect((await idx.lookup("run_task", "old", "d1")).kind).toBe("miss");
      expect((await idx.lookup("run_task", "mid", "d1")).kind).toBe("hit");
      expect((await idx.lookup("run_task", "new", "d1")).kind).toBe("hit");
    } finally {
      await rmrf(home);
    }
  });

  it("落盘后可跨实例（等价 server 重启）恢复", async () => {
    const home = await makeTmpRoot("idem-restart");
    try {
      const first = makeIndex({ home });
      await first.record(entry({ key: "k", taskId: "tsk_1" }));
      const raw = await fsp.readFile(path.join(home, "idempotency.json"), "utf8");
      expect(raw).toContain("tsk_1");
      const second = makeIndex({ home });
      const hit = await second.lookup("run_task", "k", "d1");
      expect(hit.kind).toBe("hit");
      expect(hit.kind === "hit" && hit.entry.taskId).toBe("tsk_1");
    } finally {
      await rmrf(home);
    }
  });

  it("映射文件损坏时从任务快照重建", async () => {
    const home = await makeTmpRoot("idem-rebuild");
    try {
      await fsp.writeFile(path.join(home, "idempotency.json"), "{ 这不是 JSON", "utf8");
      const idx = makeIndex({
        home,
        snapshots: [
          snapshot({
            taskId: "tsk_snap",
            idempotencyKey: "k",
            idempotencyScope: "run_task",
            idempotencyDigest: "d1",
          }),
          snapshot({ taskId: "tsk_plain" }), // 无幂等字段：不参与重建
        ],
      });
      const hit = await idx.lookup("run_task", "k", "d1");
      expect(hit.kind).toBe("hit");
      expect(hit.kind === "hit" && hit.entry.taskId).toBe("tsk_snap");
      // 重建结果已落盘且是合法 JSON
      const raw = await fsp.readFile(path.join(home, "idempotency.json"), "utf8");
      expect(() => JSON.parse(raw)).not.toThrow();
    } finally {
      await rmrf(home);
    }
  });

  it("映射文件缺失时视为空索引（不报错、不重建）", async () => {
    const home = await makeTmpRoot("idem-empty");
    try {
      let scanned = 0;
      const idx = new IdempotencyIndex({
        home,
        store: {
          scanAllSnapshots: async () => {
            scanned++;
            return [];
          },
        } as unknown as TaskStore,
        logger,
        loadConfig: async () => ({ idempotency: { ttlMs: 1000, maxEntries: 10 } }),
      });
      expect((await idx.lookup("run_task", "k", "d1")).kind).toBe("miss");
      expect(scanned).toBe(0);
    } finally {
      await rmrf(home);
    }
  });

  it("落盘失败时 fail-open：返回 persisted=false，但内存仍能命中", async () => {
    const home = await makeTmpRoot("idem-writefail");
    try {
      // 把目标路径做成目录 → 原子写的 rename 必然失败（不依赖平台权限位）
      await fsp.mkdir(path.join(home, "idempotency.json"), { recursive: true });
      const idx = makeIndex({ home });
      const res = await idx.record(entry({ key: "k", taskId: "tsk_1" }));
      expect(res.persisted).toBe(false);
      expect(res.error).toBeTruthy();
      const hit = await idx.lookup("run_task", "k", "d1");
      expect(hit.kind).toBe("hit");
    } finally {
      await rmrf(home);
    }
  });
});

describe("IdempotencyIndex 并发与在途", () => {
  it("runExclusive 串行化同一键，前序失败不阻断后序", async () => {
    const home = await makeTmpRoot("idem-exclusive");
    try {
      const idx = makeIndex({ home });
      const order: string[] = [];
      const first = idx.runExclusive("run_task", "k", async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 30));
        order.push("a-end");
        return "a";
      });
      const second = idx.runExclusive("run_task", "k", async () => {
        order.push("b-run");
        return "b";
      });
      expect(await Promise.all([first, second])).toEqual(["a", "b"]);
      expect(order).toEqual(["a-start", "a-end", "b-run"]);

      const failing = idx.runExclusive("run_task", "k2", async () => {
        throw new Error("boom");
      });
      await expect(failing).rejects.toThrow("boom");
      await expect(idx.runExclusive("run_task", "k2", async () => "ok")).resolves.toBe("ok");
    } finally {
      await rmrf(home);
    }
  });

  it("不同键互不阻塞", async () => {
    const home = await makeTmpRoot("idem-exclusive2");
    try {
      const idx = makeIndex({ home });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const held = idx.runExclusive("run_task", "k1", async () => {
        await gate;
        return "k1";
      });
      await expect(idx.runExclusive("run_task", "k2", async () => "k2")).resolves.toBe("k2");
      release();
      await expect(held).resolves.toBe("k1");
    } finally {
      await rmrf(home);
    }
  });

  it("在途标记：抢占唯一、释放后可再抢占", () => {
    const home = "unused";
    const idx = makeIndex({ home });
    expect(idx.reserveInFlight("verify_task", "k", "vfy_1")).toBe(true);
    expect(idx.reserveInFlight("verify_task", "k", "vfy_2")).toBe(false);
    expect(idx.inFlightOf("verify_task", "k")?.taskId).toBe("vfy_1");
    expect(idx.inFlightOf("verify_task", "other")).toBeNull();
    idx.releaseInFlight("verify_task", "k");
    expect(idx.inFlightOf("verify_task", "k")).toBeNull();
    expect(idx.reserveInFlight("verify_task", "k", "vfy_3")).toBe(true);
  });
});
