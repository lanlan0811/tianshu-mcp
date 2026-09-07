/**
 * R5 回归测试：路径硬编码移除 / profile 动态发现 / 配置热加载。
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { makeTmpRoot } from "../test-utils.js";
import { expandEnvPath, platformDefaultDiscoveryDirs } from "../../src/util/path.js";
import { DataHome } from "../../src/config/store.js";
import { AgentAdapterRegistry } from "../../src/agents/registry.js";
import { Logger } from "../../src/util/log.js";
import type { AgentProfile } from "../../src/config/schema.js";

const silentLogger = new Logger(null, "error");

describe("R5 env 占位符展开", () => {
  it("展开 {LOCALAPPDATA}/{HOME} 等，未定义的原样保留", () => {
    if (process.env.LOCALAPPDATA) {
      const p = expandEnvPath("{LOCALAPPDATA}/OpenAI/Codex/bin");
      expect(p).toBe(path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin"));
      expect(p).not.toContain("{LOCALAPPDATA}");
    }
    const undef = expandEnvPath("{NO_SUCH_VAR}/x");
    // 未定义占位符原样保留（Windows 下正斜杠被统一为反斜杠）
    expect(undef).toContain("{NO_SUCH_VAR}");
    expect(undef).not.toContain(process.platform === "win32" ? "x}/" : "x}\\");
  });

  it("平台默认候选目录非空", () => {
    expect(platformDefaultDiscoveryDirs().length).toBeGreaterThan(0);
  });
});

describe("R5 源码无用户路径硬编码", () => {
  it("builtin profile discovery 不含 C:/Users/<user> 盘符硬编码", async () => {
    const { BUILTIN_PROFILES } = await import("../../src/agents/builtin.js");
    const codex = BUILTIN_PROFILES.codex!;
    expect(codex.command ?? "").not.toMatch(/^[A-Za-z]:\//); // command 不是绝对盘符路径
    const dirsText = JSON.stringify(codex.executableDiscovery?.dirs ?? []);
    expect(dirsText).not.toMatch(/C:\/Users\/[^/]+/i); // 不写死用户名
    expect(dirsText).toMatch(/\{LOCALAPPDATA\}/); // 用占位符
  });
});

describe("R5 profile 热加载", () => {
  it("修改 agent-profiles.json 后无需重启即可解析到新配置", async () => {
    const home = await makeTmpRoot("r5-home");
    const dh = new DataHome(home, silentLogger, {
      stub: {
        displayName: "stub", type: "cli", status: "ready", command: "node", argsTemplate: ["-v"], promptMode: "arg", cwd: "task", env: {}, timeoutMs: 1000, killTree: "taskkill",
      } as AgentProfile,
    });
    await dh.init();
    const reg = new AgentAdapterRegistry(() => dh.loadProfiles(), silentLogger);
    // 首次
    const first = await reg.resolve("stub", true);
    expect(first.ok).toBe(true); // node 从 PATH 解析到绝对路径
    expect(first.profile.argsTemplate).toEqual(["-v"]);
    // 修改 profiles 文件
    await fsp.writeFile(
      path.join(home, "agent-profiles.json"),
      JSON.stringify({
        profiles: {
          stub: { displayName: "stub", type: "cli", status: "ready", command: "node", argsTemplate: ["--version"], promptMode: "arg", cwd: "task", env: {}, timeoutMs: 1000, killTree: "taskkill" },
        },
      }),
    );
    // 热加载：mtime 变化 → DataHome 重建 → registry 重解析
    const second = await reg.resolve("stub", true);
    expect(second.profile.argsTemplate).toEqual(["--version"]);
  });
});
