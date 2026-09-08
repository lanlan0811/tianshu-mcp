/**
 * 单元测试：原子写（writeJsonAtomic / writeTextAtomic）的并发安全。
 *
 * 背景（实测 CI 偶发失败 → 定位为真实缺陷）：旧实现临时文件名是 `<目标>.<pid>.tmp`，
 * 同进程内并发写同一目标时共用同一个临时文件——先完成的一方 rename 走后，
 * 后完成的一方 rename 抛 ENOENT，表现为「rework_task 返回 undefined meta」等偶发断言失败。
 * 修复：临时文件名加入随机后缀，保证每次唯一。
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { makeTmpRoot } from "../test-utils.js";
import { writeJsonAtomic, writeTextAtomic } from "../../src/util/fs.js";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpRoot("atomic");
});

describe("原子写并发安全", () => {
  it("同一目标并发 8 次 JSON 写，全部成功且最终文件合法", async () => {
    const target = path.join(dir, "task.json");
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => writeJsonAtomic(target, { n: i })),
    );
    const failed = results.filter((r) => r.status === "rejected");
    expect(failed, `并发写失败 ${failed.length} 次`).toHaveLength(0);
    const parsed = JSON.parse(await fs.readFile(target, "utf8")) as { n: number };
    expect(typeof parsed.n).toBe("number");
  });

  it("同一目标并发 8 次文本写，全部成功", async () => {
    const target = path.join(dir, "note.md");
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => writeTextAtomic(target, `content-${i}`)),
    );
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
    expect(await fs.readFile(target, "utf8")).toMatch(/^content-\d$/);
  });

  it("不残留临时文件", async () => {
    const target = path.join(dir, "x.json");
    await Promise.all(Array.from({ length: 5 }, (_, i) => writeJsonAtomic(target, { i })));
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toHaveLength(0);
  });
});
