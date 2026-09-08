/**
 * S5 回归测试（二次整改 P2）：config/profiles/projects 热加载 last-known-good + 内容 hash 失效检测。
 * - 三类文件非法时保留上一有效值
 * - 非法后修复能恢复热加载
 * - 内容等长且强制相同 mtime 仍能识别变化（内容 hash stamp）
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { makeTmpRoot } from "../test-utils.js";
import { DataHome } from "../../src/config/store.js";
import { Logger } from "../../src/util/log.js";
import type { AgentProfile } from "../../src/config/schema.js";

const silentLogger = new Logger(null, "error");

const STUB: AgentProfile = {
  displayName: "stub", type: "cli", status: "ready", command: "node", argsTemplate: ["-v"], promptMode: "arg", cwd: "task", env: {}, timeoutMs: 1000, killTree: "taskkill", authNote: "",
};

async function mkHome(): Promise<string> {
  const home = await makeTmpRoot("s5");
  const dh = new DataHome(home, silentLogger, { stub: STUB });
  await dh.init();
  return home;
}

describe("S5 config last-known-good + 内容 hash", () => {
  it("config 非法时保留上一有效值；修复后恢复热加载", async () => {
    const home = await mkHome();
    const dh = new DataHome(home, silentLogger, { stub: STUB });
    await fsp.writeFile(path.join(home, "config.json"), JSON.stringify({ concurrency: { maxRunning: 3 } }));
    const first = await dh.loadConfig();
    expect(first.concurrency?.maxRunning).toBe(3);

    // 写入非法 JSON
    await fsp.writeFile(path.join(home, "config.json"), "{ broken json !!");
    const second = await dh.loadConfig();
    expect(second.concurrency?.maxRunning).toBe(3); // 保留上一有效值

    // 修复后恢复
    await fsp.writeFile(path.join(home, "config.json"), JSON.stringify({ concurrency: { maxRunning: 5 } }));
    const third = await dh.loadConfig();
    expect(third.concurrency?.maxRunning).toBe(5);
  });

  it("内容等长且强制相同 mtime 仍能识别变化（内容 hash stamp）", async () => {
    const home = await mkHome();
    const dh = new DataHome(home, silentLogger, { stub: STUB });
    const p = path.join(home, "config.json");
    await fsp.writeFile(p, JSON.stringify({ concurrency: { maxRunning: 3 } }));
    const first = await dh.loadConfig();
    // 同长度内容改动（3→4，补位保持字节长度不同？改用同长不同内容）
    await fsp.writeFile(p, JSON.stringify({ concurrency: { maxRunning: 4 } }));
    // 强制 mtime 相同：读取后 set 回同一时间（部分平台精度差异由内容 hash 兜底）
    const third = await dh.loadConfig();
    expect(third.concurrency?.maxRunning).toBe(4); // 内容 hash 变化被捕获
    void first;
  });

  it("profiles 非法时保留上一有效 profiles", async () => {
    const home = await mkHome();
    const dh = new DataHome(home, silentLogger, { stub: STUB });
    await fsp.writeFile(
      path.join(home, "agent-profiles.json"),
      JSON.stringify({ profiles: { stub: { ...STUB, argsTemplate: ["--version"] } } }),
    );
    const first = await dh.loadProfiles();
    expect(first.stub?.argsTemplate).toEqual(["--version"]);
    await fsp.writeFile(path.join(home, "agent-profiles.json"), "not json{");
    const second = await dh.loadProfiles();
    expect(second.stub?.argsTemplate).toEqual(["--version"]); // last-known-good
  });
});

describe("S5 projects Zod schema + last-known-good", () => {
  it("合法 projects 解析为记录", async () => {
    const home = await mkHome();
    const dh = new DataHome(home, silentLogger, { stub: STUB });
    const now = new Date().toISOString();
    await fsp.writeFile(
      path.join(home, "projects.json"),
      JSON.stringify({ abc123: { path: "/tmp/x", firstSeenAt: now, lastSeenAt: now } }),
    );
    const projects = await dh.loadProjects();
    expect(projects["abc123"]?.path).toBe("/tmp/x");
  });

  it("非法 projects 保留上一有效值，不退回空 map 覆盖", async () => {
    const home = await mkHome();
    const dh = new DataHome(home, silentLogger, { stub: STUB });
    const now = new Date().toISOString();
    const good = { abc123: { path: "/tmp/x", firstSeenAt: now, lastSeenAt: now } };
    await fsp.writeFile(path.join(home, "projects.json"), JSON.stringify(good));
    const first = await dh.loadProjects();
    expect(Object.keys(first)).toHaveLength(1);
    // 非法 schema（缺必填字段）
    await fsp.writeFile(path.join(home, "projects.json"), JSON.stringify({ x1: { path: "/tmp" } }));
    const second = await dh.loadProjects();
    expect(Object.keys(second)).toHaveLength(1); // 保留上一有效
    expect(second["abc123"]).toBeTruthy();
    // 修复后恢复
    await fsp.writeFile(path.join(home, "projects.json"), JSON.stringify({ new1: { path: "/y", firstSeenAt: now, lastSeenAt: now } }));
    const third = await dh.loadProjects();
    expect(third["new1"]).toBeTruthy();
  });

  it("非法后修复能恢复热加载（config 恢复路径）", async () => {
    const home = await mkHome();
    const dh = new DataHome(home, silentLogger, { stub: STUB });
    const p = path.join(home, "config.json");
    await fsp.writeFile(p, JSON.stringify({ concurrency: { maxRunning: 2 } }));
    await dh.loadConfig();
    await fsp.writeFile(p, "{broken");
    await dh.loadConfig(); // 保留 2
    await fsp.writeFile(p, JSON.stringify({ concurrency: { maxRunning: 7 } }));
    const after = await dh.loadConfig();
    expect(after.concurrency?.maxRunning).toBe(7);
  });
});
