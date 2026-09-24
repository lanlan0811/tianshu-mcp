/**
 * 单元测试：三级验收配置继承的合并语义与分层读取（issue #20）。
 *
 * 重点覆盖本次要修的**隐患**：带 `.default()` 的 schema 会在分层解析时 materialize 默认值，
 * 从而把低优先级层的显式取值反向覆盖掉（`requireChanges` 是重灾区）。
 */
import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import {
  mergeAcceptanceConfig,
  resolveAcceptanceLayers,
  summarizeResolved,
} from "../../src/config/acceptance-merge.js";
import {
  AcceptanceConfigSchema,
  PartialAcceptanceConfigSchema,
  type PartialAcceptanceConfig,
} from "../../src/config/schema.js";
import { readAcceptanceLayer } from "../../src/visual/config.js";
import { VisualError } from "../../src/visual/errors.js";
import { makeTmpRoot, rmrf } from "../test-utils.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rmrf(root)));
});

async function tmpDir(tag: string): Promise<string> {
  const dir = await makeTmpRoot(tag);
  roots.push(dir);
  return dir;
}

describe("mergeAcceptanceConfig", () => {
  it("标量按「高优先级层书写即取胜」覆盖", () => {
    const merged = mergeAcceptanceConfig({ requireChanges: false }, { requireChanges: true });
    expect(merged.requireChanges).toBe(true);
  });

  it("低优先级层独有的字段被保留", () => {
    const merged = mergeAcceptanceConfig({ requireChanges: false }, { verifyConcurrency: 3 });
    expect(merged.requireChanges).toBe(false);
    expect(merged.verifyConcurrency).toBe(3);
  });

  it("checks 数组整体覆盖而非拼接", () => {
    const base = { checks: [{ name: "a", cmd: ["a"] }, { name: "b", cmd: ["b"] }] };
    const over = { checks: [{ name: "c", cmd: ["c"] }] };
    const merged = mergeAcceptanceConfig(base, over);
    expect(merged.checks?.map((c) => c.name)).toEqual(["c"]);
  });

  it("visual 整体覆盖（不做深合并 —— 深度合并会被 .default() 污染）", () => {
    const base = { visual: { enabled: true, baselineRoot: "custom/base" } } as PartialAcceptanceConfig;
    const over = { visual: { enabled: false } } as PartialAcceptanceConfig;
    const merged = mergeAcceptanceConfig(base, over);
    // 若做深合并，base 的 baselineRoot 会残留；本版语义是整段取胜
    expect(merged.visual?.baselineRoot).not.toBe("custom/base");
  });

  it("undefined 视为「本层未书写」，不覆盖下层取值", () => {
    const merged = mergeAcceptanceConfig(
      { requireChanges: false, verifyConcurrency: 2 },
      { requireChanges: undefined, verifyConcurrency: undefined },
    );
    expect(merged.requireChanges).toBe(false);
    expect(merged.verifyConcurrency).toBe(2);
  });

  it("两层都空时返回空对象（消费方负责兜底默认值）", () => {
    expect(mergeAcceptanceConfig(undefined, undefined)).toEqual({});
  });
});

describe("resolveAcceptanceLayers", () => {
  it("按低 → 高优先级合并，并只登记存在的层", () => {
    const r = resolveAcceptanceLayers([
      { source: "global", path: "/g", config: { requireChanges: false, verifyConcurrency: 1 } },
      { source: "project", path: "/p" }, // 缺失
      { source: "override", path: "（调用参数）", config: { verifyConcurrency: 4 } },
    ]);
    expect(r.applied.map((a) => a.source)).toEqual(["global", "override"]);
    expect(r.config.requireChanges).toBe(false);
    expect(r.config.verifyConcurrency).toBe(4);
  });

  it("全部缺失时产出空配置与空 applied", () => {
    const r = resolveAcceptanceLayers([
      { source: "global", path: "/g" },
      { source: "project", path: "/p" },
    ]);
    expect(r.config).toEqual({});
    expect(r.applied).toEqual([]);
  });

  it("summarizeResolved 输出可读摘要（不泄漏凭证，只报层与取值）", () => {
    const r = resolveAcceptanceLayers([
      { source: "global", path: "/g", config: { requireChanges: false } },
      { source: "project", path: "/p", config: { checks: [{ name: "x", cmd: ["x"] }] } },
    ]);
    const s = summarizeResolved(r);
    expect(s).toContain("生效层=global>project");
    expect(s).toContain("checks=1");
    expect(s).toContain("requireChanges=false");
  });
});

describe("分层解析：绝不 materialize 默认值", () => {
  it("PartialAcceptanceConfigSchema 不给 requireChanges 补默认值", () => {
    const parsed = PartialAcceptanceConfigSchema.parse({ verifyConcurrency: 3 });
    expect(parsed.requireChanges).toBeUndefined();
    expect("requireChanges" in parsed).toBe(false);
  });

  it("对比：带默认的 AcceptanceConfigSchema 会补出 true（这正是本版要绕开的坑）", () => {
    const parsed = AcceptanceConfigSchema.parse({ verifyConcurrency: 3 });
    expect(parsed.requireChanges).toBe(true);
  });

  it("只写 verifyConcurrency 的项目层不会覆盖全局层的 requireChanges=false", () => {
    // 模拟真实链路：两层都用分层 schema 解析后再合并
    const global = PartialAcceptanceConfigSchema.parse({ requireChanges: false });
    const project = PartialAcceptanceConfigSchema.parse({ verifyConcurrency: 2 });
    const merged = resolveAcceptanceLayers([
      { source: "global", path: "/g", config: global },
      { source: "project", path: "/p", config: project },
    ]).config;
    expect(merged.requireChanges).toBe(false);
    expect(merged.verifyConcurrency).toBe(2);
  });

  it("verifyConcurrency 越界被 clamp 到 1..4（分层 schema 保留该 transform）", () => {
    expect(PartialAcceptanceConfigSchema.parse({ verifyConcurrency: 99 }).verifyConcurrency).toBe(4);
    expect(PartialAcceptanceConfigSchema.parse({ verifyConcurrency: 0 }).verifyConcurrency).toBe(1);
  });
});

describe("readAcceptanceLayer", () => {
  it("文件缺失 → null（不报错，与「该层不存在」语义一致）", async () => {
    const dir = await tmpDir("layer-missing");
    expect(await readAcceptanceLayer(path.join(dir, "nope.json"), "global")).toBeNull();
  });

  it("正常文件 → 解析为分层配置，且不补默认值", async () => {
    const dir = await tmpDir("layer-ok");
    const f = path.join(dir, "acceptance.default.json");
    await fsp.writeFile(f, JSON.stringify({ verifyConcurrency: 3 }), "utf8");
    const cfg = await readAcceptanceLayer(f, "global");
    expect(cfg).toEqual({ verifyConcurrency: 3 });
    expect(cfg?.requireChanges).toBeUndefined();
  });

  it("JSON 写坏 → CONFIG_INVALID（fail-closed，消息含层名与路径）", async () => {
    const dir = await tmpDir("layer-broken");
    const f = path.join(dir, "acceptance.default.json");
    await fsp.writeFile(f, "{ 这不是 JSON", "utf8");
    await expect(readAcceptanceLayer(f, "global")).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    await expect(readAcceptanceLayer(f, "global")).rejects.toThrow(/global/);
  });

  it("字段不合法 → CONFIG_INVALID", async () => {
    const dir = await tmpDir("layer-invalid");
    const f = path.join(dir, "acceptance.default.json");
    await fsp.writeFile(f, JSON.stringify({ requireChanges: "yes" }), "utf8");
    const err = await readAcceptanceLayer(f, "global").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VisualError);
    expect((err as VisualError).code).toBe("CONFIG_INVALID");
  });

  it("目录被当成文件读 → CONFIG_UNREADABLE（不是静默当空配置）", async () => {
    const dir = await tmpDir("layer-unreadable");
    const sub = path.join(dir, "as-dir.json");
    await fsp.mkdir(sub, { recursive: true });
    const err = await readAcceptanceLayer(sub, "global").catch((e: unknown) => e);
    // Windows 上读目录同样是错误码；只要求「不是 ENOENT 就报错」这条语义
    expect(err).toBeInstanceOf(VisualError);
    expect((err as VisualError).code).toBe("CONFIG_UNREADABLE");
  });
});
