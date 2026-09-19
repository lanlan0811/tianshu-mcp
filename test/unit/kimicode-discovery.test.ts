import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentProfileSchema } from "../../src/config/schema.js";
import {
  discoverKimicode,
  normalizeDrive,
  orderedDrives,
} from "../../src/agents/kimicode/discovery.js";
import { makeTmpRoot, rmrf } from "../test-utils.js";

/**
 * 本文件只校验探测顺序与命中来源，不校验文件版本号。
 * 宿主 PowerShell 冷启动实测可超过 5s，fileVersion 会为每个命中候选各起一次进程，
 * 把单测拖到分钟级；注入 fixedDrives/registryDirs/driveRoots 已避开系统查询，
 * 这里再把 exec 层替换为空结果，确保整份单测不触达真实系统且保持秒级。
 */
vi.mock("../../src/verify/exec.js", () => ({
  execFileAsync: async () => ({
    status: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    durationMs: 0,
  }),
}));

/** Windows 文件名含空格：只在测试里造真实文件，探测端按 basename 精确匹配。 */
const WIN_EXE = "Kimi Code.exe";
const MAC_EXE = "Kimi Code";
/** 与内置 profile 一致的固定盘相对路径模板（两种真实安装布局） */
const REL_NESTED = "Kimi-Code/Kimi Code/Kimi Code.exe";
const REL_FLAT = "Kimi Code/Kimi Code.exe";

function writeFile(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
}

interface ProfileInput {
  exePath?: string;
  dirs?: string[];
  fileNames?: string[];
  preferredDrives?: string[];
  relativePaths?: string[];
}

function profileOf(input: ProfileInput) {
  return AgentProfileSchema.parse({
    driver: "gui",
    adapter: "kimicode-gui",
    status: "research",
    command: null,
    ...(input.exePath ? { gui: { exePath: input.exePath } } : {}),
    executableDiscovery: {
      dirs: input.dirs ?? [],
      fileNames: input.fileNames ?? [WIN_EXE, MAC_EXE],
      preferredDrives: input.preferredDrives ?? [],
      relativePaths: input.relativePaths ?? [],
    },
  });
}

describe("Kimi Code 安装探测", () => {
  it("显式 gui.exePath 优先；该路径不存在时降到下一层（固定盘相对路径）", async () => {
    const root = await makeTmpRoot("kimicode-explicit");
    const dRoot = path.join(root, "d-drive");
    const relativeExe = path.join(dRoot, REL_NESTED);
    writeFile(relativeExe);
    const input = {
      platform: "win32" as const,
      fixedDrives: [],
      registryDirs: [],
      driveRoots: { "D:": dRoot },
    };
    const explicit = profileOf({
      exePath: relativeExe,
      preferredDrives: ["D:"],
      relativePaths: [REL_NESTED],
    });
    expect(await discoverKimicode(explicit, input)).toMatchObject({
      path: relativeExe,
      source: "explicit",
    });
    // 显式路径指向不存在的文件：不得占用 explicit 结果，必须继续按探测顺序下探。
    const missing = profileOf({
      exePath: path.join(root, "not-installed", WIN_EXE),
      preferredDrives: ["D:"],
      relativePaths: [REL_NESTED],
    });
    expect(await discoverKimicode(missing, input)).toMatchObject({
      path: relativeExe,
      source: "fixed-drive",
    });
    await rmrf(root);
  });

  it("preferredDrives（D:）优先于其他固定盘，盘符归一并去重", async () => {
    const root = await makeTmpRoot("kimicode-drives");
    const cRoot = path.join(root, "c-drive");
    const dRoot = path.join(root, "d-drive");
    for (const driveRoot of [cRoot, dRoot]) writeFile(path.join(driveRoot, REL_FLAT));
    const base = { platform: "win32" as const, fixedDrives: ["C:", "D:"], registryDirs: [] };
    // 两个盘都有安装：配置的 D: 必须胜出，且不依赖真实 WMI 枚举。
    expect(
      await discoverKimicode(profileOf({ preferredDrives: ["D:"], relativePaths: [REL_FLAT] }), {
        ...base,
        driveRoots: { "C:": cRoot, "D:": dRoot },
      }),
    ).toMatchObject({ path: path.join(dRoot, REL_FLAT), source: "fixed-drive" });
    // 无偏好时按注入的固定盘枚举顺序取第一个。
    expect(
      await discoverKimicode(profileOf({ preferredDrives: [], relativePaths: [REL_FLAT] }), {
        ...base,
        driveRoots: { "C:": cRoot, "D:": dRoot },
      }),
    ).toMatchObject({ path: path.join(cRoot, REL_FLAT), source: "fixed-drive" });
    expect(normalizeDrive("d:")).toBe("D:");
    expect(orderedDrives(["C:", "D:", "E:", "d:"], ["D:"])).toEqual(["D:", "C:", "E:"]);
    await rmrf(root);
  });

  it("固定盘相对路径模板的两种真实布局均命中", async () => {
    const nestedRoot = await makeTmpRoot("kimicode-layout-nested");
    const flatRoot = await makeTmpRoot("kimicode-layout-flat");
    writeFile(path.join(nestedRoot, REL_NESTED));
    writeFile(path.join(flatRoot, REL_FLAT));
    const profile = profileOf({ preferredDrives: ["D:"], relativePaths: [REL_NESTED, REL_FLAT] });
    const input = { platform: "win32" as const, fixedDrives: [], registryDirs: [] };
    expect(
      await discoverKimicode(profile, { ...input, driveRoots: { "D:": nestedRoot } }),
    ).toMatchObject({ path: path.join(nestedRoot, REL_NESTED), source: "fixed-drive" });
    expect(
      await discoverKimicode(profile, { ...input, driveRoots: { "D:": flatRoot } }),
    ).toMatchObject({ path: path.join(flatRoot, REL_FLAT), source: "fixed-drive" });
    await rmrf(nestedRoot);
    await rmrf(flatRoot);
  });

  it("注册表卸载信息里的安装目录命中（含直接安装与子目录布局）", async () => {
    const root = await makeTmpRoot("kimicode-registry");
    const nestedDir = path.join(root, "nested");
    const directDir = path.join(root, "direct");
    writeFile(path.join(nestedDir, MAC_EXE, WIN_EXE));
    writeFile(path.join(directDir, WIN_EXE));
    const profile = profileOf({ preferredDrives: [], relativePaths: [] });
    const input = { platform: "win32" as const, fixedDrives: [] };
    expect(await discoverKimicode(profile, { ...input, registryDirs: [nestedDir] })).toMatchObject({
      path: path.join(nestedDir, MAC_EXE, WIN_EXE),
      source: "registry",
    });
    expect(await discoverKimicode(profile, { ...input, registryDirs: [directDir] })).toMatchObject({
      path: path.join(directDir, WIN_EXE),
      source: "registry",
    });
    await rmrf(root);
  });

  it("标准目录命中：注入 dirs 与 {HOME} 占位符展开", async () => {
    const root = await makeTmpRoot("kimicode-standard");
    const standardDir = path.join(root, "standard");
    writeFile(path.join(standardDir, WIN_EXE));
    writeFile(path.join(standardDir, MAC_EXE));
    const names = [WIN_EXE, MAC_EXE];
    const input = { fixedDrives: [], registryDirs: [] };
    // 注入 dirs（无占位符）：按宿主平台取对应可执行名。
    expect(
      await discoverKimicode(profileOf({ dirs: [standardDir], fileNames: names }), input),
    ).toMatchObject({
      path: path.join(standardDir, process.platform === "win32" ? WIN_EXE : MAC_EXE),
      source: "standard",
    });

    const home = path.join(root, "home");
    const bundleDir = path.join(home, "Applications", "Kimi Code.app", "Contents", "MacOS");
    writeFile(path.join(bundleDir, WIN_EXE));
    writeFile(path.join(bundleDir, MAC_EXE));
    const spy = vi.spyOn(os, "homedir").mockReturnValue(home);
    try {
      const homeProfile = profileOf({
        dirs: ["{HOME}/Applications/Kimi Code.app/Contents/MacOS"],
        fileNames: names,
      });
      // .app 目录在 macOS 记为 bundle，其他平台仍按 standard 归类。
      expect(await discoverKimicode(homeProfile, input)).toMatchObject({
        source: process.platform === "darwin" ? "bundle" : "standard",
      });
      expect(await discoverKimicode(homeProfile, { ...input, platform: "darwin" })).toMatchObject({
        path: path.join(bundleDir, MAC_EXE),
        source: "bundle",
      });
    } finally {
      spy.mockRestore();
    }
    await rmrf(root);
  });

  it("可执行名必须精确匹配 Kimi Code.exe，近似名不命中", async () => {
    const root = await makeTmpRoot("kimicode-strict-name");
    const standardDir = path.join(root, "standard");
    // 近似名文件真实存在：若校验退化成 includes/前缀匹配就会被误判为 Kimi Code。
    writeFile(path.join(standardDir, "KimiCode.exe"));
    writeFile(path.join(standardDir, "Kimi-Code.exe"));
    const savedPath = process.env.PATH;
    // 隔离 PATH 层：宿主机器若真装了 Kimi Code 并加入 PATH，会让「不命中」断言失效。
    process.env.PATH = "";
    const input = { platform: "win32" as const, fixedDrives: [], registryDirs: [] };
    try {
      expect(
        await discoverKimicode(
          profileOf({
            dirs: [standardDir],
            fileNames: ["KimiCode.exe", "Kimi-Code.exe"],
          }),
          input,
        ),
      ).toBeNull();
      // 目标名文件不存在（目录里只有近似名）同样不命中。
      expect(
        await discoverKimicode(profileOf({ dirs: [standardDir], fileNames: [WIN_EXE] }), input),
      ).toBeNull();
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
    await rmrf(root);
  });

  it("探测顺序：固定盘相对路径优先于标准目录", async () => {
    const root = await makeTmpRoot("kimicode-order");
    const dRoot = path.join(root, "d-drive");
    const standardDir = path.join(root, "standard");
    writeFile(path.join(dRoot, REL_FLAT));
    writeFile(path.join(standardDir, WIN_EXE));
    const profile = profileOf({
      dirs: [standardDir],
      fileNames: [WIN_EXE, MAC_EXE],
      preferredDrives: ["D:"],
      relativePaths: [REL_FLAT],
    });
    expect(
      await discoverKimicode(profile, {
        platform: "win32",
        fixedDrives: [],
        registryDirs: [],
        driveRoots: { "D:": dRoot },
      }),
    ).toMatchObject({ path: path.join(dRoot, REL_FLAT), source: "fixed-drive" });
    await rmrf(root);
  });
});
