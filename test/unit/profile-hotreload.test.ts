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

  it("ProgramFiles 占位符大小写不敏感，未知占位符保留原样", () => {
    const original = process.env.PROGRAMFILES;
    process.env.PROGRAMFILES = path.join(path.parse(process.cwd()).root, "Program Files");
    try {
      expect(expandEnvPath("{ProgramFiles}/ZCode")).toBe(expandEnvPath("{PROGRAMFILES}/ZCode"));
      expect(expandEnvPath("{UnknownPlaceholder}/ZCode")).toContain("{UnknownPlaceholder}");
    } finally {
      if (original === undefined) delete process.env.PROGRAMFILES;
      else process.env.PROGRAMFILES = original;
    }
  });
});

describe("R5 源码无用户路径硬编码", () => {
  it("builtin profile discovery 不含 C:/Users/<user> 盘符硬编码", async () => {
    const { BUILTIN_PROFILES } = await import("../../src/agents/builtin.js");
    const codex = BUILTIN_PROFILES.codex!;
    expect(codex.command ?? "").not.toMatch(/^[A-Za-z]:\//); // command 不是绝对盘符路径
    const discoveryText = JSON.stringify(codex.executableDiscovery ?? {});
    expect(discoveryText).not.toMatch(/C:\/Users\/[^/]+/i); // 不写死用户名
    expect(discoveryText).not.toMatch(/OpenAI\.Codex_\d/); // 不写死版本号
    // Codex 为 MSIX 应用：Appx 查询优先，扫盘用 {SYSTEMDRIVE} 占位符回退
    expect(codex.executableDiscovery?.appxPackageName).toBe("OpenAI.Codex");
    expect(JSON.stringify(codex.executableDiscovery?.scanRoots ?? [])).toMatch(/\{SYSTEMDRIVE\}/);
    // 受管实例的 user-data-dir 用占位符，不写死用户名/盘符
    expect(codex.gui?.userDataDir ?? "").toMatch(/\{LOCALAPPDATA\}|\{HOME\}/);
    expect(codex.gui?.userDataDir ?? "").not.toMatch(/C:\/Users\/[^/]+/i);
  });
});

describe("R5 profile 热加载", () => {
  it("修改 agent-profiles.json 后无需重启即可解析到新配置", async () => {
    const home = await makeTmpRoot("r5-home");
    const dh = new DataHome(home, silentLogger, {
      stub: {
        displayName: "stub",
        type: "cli",
        status: "ready",
        command: "node",
        argsTemplate: ["-v"],
        promptMode: "arg",
        cwd: "task",
        env: {},
        timeoutMs: 1000,
        killTree: "taskkill",
      } as AgentProfile,
    });
    await dh.init();
    const reg = new AgentAdapterRegistry(() => dh.loadProfiles(), silentLogger);
    // 首次
    const first = await reg.resolve("stub", true);
    expect(first.ok).toBe(true); // node 从 PATH 解析到绝对路径
    expect(first.profile.argsTemplate).toEqual(["-v"]);
    // 修改 profiles 文件（内容与大小均不同 → stamp 必然变化）
    await fsp.writeFile(
      path.join(home, "agent-profiles.json"),
      JSON.stringify({
        profiles: {
          stub: {
            displayName: "stub",
            type: "cli",
            status: "ready",
            command: "node",
            argsTemplate: ["--version"],
            promptMode: "arg",
            cwd: "task",
            env: {},
            timeoutMs: 1000,
            killTree: "taskkill",
          },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20)); // 确保 FS 落盘
    // 热加载：stamp(mtime+size) 变化 → DataHome 重建 → registry 重解析
    const second = await reg.resolve("stub", true);
    expect(second.profile.argsTemplate).toEqual(["--version"]);
  });
});
