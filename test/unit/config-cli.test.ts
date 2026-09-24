/**
 * 单元测试：`tianshu-mcp config acceptance` 调试命令（issue #20）。
 *
 * 该命令的价值在于「让三级继承的生效情况可查」，所以测试重点不是格式美观，
 * 而是：三层各自是否被正确识别、生效顺序、最终取值、以及**某层写坏时能指明是哪一层坏**。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { inspectAcceptance } from "../../src/config/cli.js";
import { makeTmpRoot, rmrf } from "../test-utils.js";

let home: string;
let project: string;
let prevHome: string | undefined;

beforeEach(async () => {
  home = await makeTmpRoot("config-cli-home");
  project = await makeTmpRoot("config-cli-project");
  await fsp.mkdir(path.join(project, ".tianshu-mcp"), { recursive: true });
  prevHome = process.env.TIANSHU_MCP_HOME;
  process.env.TIANSHU_MCP_HOME = home;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.TIANSHU_MCP_HOME;
  else process.env.TIANSHU_MCP_HOME = prevHome;
  await rmrf(home).catch(() => {});
  await rmrf(project).catch(() => {});
});

async function writeProject(config: unknown): Promise<void> {
  await fsp.writeFile(
    path.join(project, ".tianshu-mcp", "acceptance.json"),
    JSON.stringify(config, null, 2),
    "utf8",
  );
}

async function writeGlobal(config: unknown): Promise<void> {
  await fsp.writeFile(
    path.join(home, "acceptance.default.json"),
    JSON.stringify(config, null, 2),
    "utf8",
  );
}

async function writeTaskSnapshot(taskId: string, acceptanceOverride: unknown): Promise<void> {
  const dir = path.join(home, "tasks", taskId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, "task.json"),
    JSON.stringify({ taskId, acceptanceOverride }, null, 2),
    "utf8",
  );
}

describe("inspectAcceptance：三层识别与生效顺序", () => {
  it("三层都不存在时 ok=true，取值全为默认（缺失不等于错误）", async () => {
    const r = await inspectAcceptance([project]);
    expect(r.ok).toBe(true);
    expect(r.appliedOrder).toEqual([]);
    expect(r.effective.checks).toBe("（默认集）");
    expect(r.effective.requireChanges).toBe("（默认 true）");
    expect(r.effective.verifyConcurrency).toBe("（继承 server config）");
    expect(r.effective.visual).toBe("（未配置）");
    expect(r.layers.find((l) => l.source === "project")?.present).toBe(false);
  });

  it("只提供 projectPath 时项目层被识别并生效", async () => {
    await writeProject({ checks: [{ name: "a", cmd: ["a"] }], requireChanges: false });
    const r = await inspectAcceptance([project]);
    expect(r.appliedOrder).toEqual(["project"]);
    expect(r.effective.checks).toBe(1);
    expect(r.effective.requireChanges).toBe(false);
  });

  it("全局 + 项目两层共存时按 global > project 的顺序生效，项目胜出", async () => {
    await writeGlobal({ requireChanges: false, verifyConcurrency: 1 });
    await writeProject({ requireChanges: true });
    const r = await inspectAcceptance([project]);
    expect(r.appliedOrder).toEqual(["global", "project"]);
    // 项目层显式写的 requireChanges 取胜；全局层独有的 verifyConcurrency 保留
    expect(r.effective.requireChanges).toBe(true);
    expect(r.effective.verifyConcurrency).toBe(1);
  });

  it("全局层独有字段不被项目层清空（分层解析不 materialize 默认值）", async () => {
    await writeGlobal({ requireChanges: false });
    await writeProject({ verifyConcurrency: 3 });
    const r = await inspectAcceptance([project]);
    expect(r.effective.requireChanges).toBe(false);
    expect(r.effective.verifyConcurrency).toBe(3);
  });

  it("--task 读任务快照，override 层为最高优先级", async () => {
    await writeGlobal({ requireChanges: false });
    await writeProject({ requireChanges: true });
    await writeTaskSnapshot("tsk_cli", { requireChanges: false, verifyConcurrency: 4 });

    const r = await inspectAcceptance([project, "--task", "tsk_cli"]);
    expect(r.appliedOrder).toEqual(["global", "project", "override"]);
    expect(r.effective.requireChanges).toBe(false);
    expect(r.effective.verifyConcurrency).toBe(4);
    expect(r.layers.find((l) => l.source === "override")?.present).toBe(true);
  });

  it("--task 指向不存在的任务：如实报告且 ok=false（不假装无覆盖层）", async () => {
    await writeProject({ requireChanges: false });
    const r = await inspectAcceptance([project, "--task", "tsk_missing"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("tsk_missing");
    expect(r.layers.find((l) => l.source === "override")?.present).toBe(false);
  });

  it("未提供 --task 时明确标注「无任务级覆盖」而不是留空", async () => {
    const r = await inspectAcceptance([]);
    expect(r.layers.find((l) => l.source === "override")?.path).toContain("--task");
  });
});

describe("inspectAcceptance：错误分层可见", () => {
  it("全局层 JSON 写坏 → ok=false 且错误落在 global 层，其余层仍被解析", async () => {
    await fsp.writeFile(path.join(home, "acceptance.default.json"), "{ 坏 JSON", "utf8");
    await writeProject({ verifyConcurrency: 2 });

    const r = await inspectAcceptance([project]);
    expect(r.ok).toBe(false);
    const globalLayer = r.layers.find((l) => l.source === "global")!;
    expect(globalLayer.error?.code).toBe("CONFIG_INVALID");
    expect(globalLayer.error?.message).toContain("global");
    // 写坏的是全局层，不影响项目层的解析结果
    expect(r.appliedOrder).toEqual(["project"]);
    expect(r.effective.verifyConcurrency).toBe(2);
  });

  it("项目层字段不合法 → 错误落在 project 层", async () => {
    await writeProject({ requireChanges: "yes" });
    const r = await inspectAcceptance([project]);
    expect(r.ok).toBe(false);
    expect(r.layers.find((l) => l.source === "project")?.error?.code).toBe("CONFIG_INVALID");
  });

  it("未知选项/多余参数被拒绝，不静默忽略", async () => {
    expect((await inspectAcceptance(["--bogus"])).error).toContain("未知选项");
    expect((await inspectAcceptance([project, "extra"])).error).toContain("多余");
    expect((await inspectAcceptance(["--task"])).error).toContain("需要一个 taskId");
  });
});

describe("inspectAcceptance：摘要与 effective 一致", () => {
  it("summary 反映生效层，便于日志直接引用", async () => {
    await writeGlobal({ requireChanges: false });
    await writeProject({ checks: [{ name: "x", cmd: ["x"] }] });
    const r = await inspectAcceptance([project]);
    expect(r.summary).toContain("生效层=global>project");
    expect(r.summary).toContain("checks=1");
    expect(r.summary).toContain("requireChanges=false");
  });

  it("visual 只报告是否被覆盖（不做跨层深合并）", async () => {
    const r0 = await inspectAcceptance([]);
    expect(r0.effective.visual).toBe("（未配置）");
    await writeProject({ visual: { enabled: false } });
    const r1 = await inspectAcceptance([project]);
    expect(r1.effective.visual).toBe("已覆盖");
  });
});
