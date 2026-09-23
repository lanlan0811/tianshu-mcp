/**
 * 单元测试：TraeWork 安装发现（issue #23 C3）。
 * 只校验探测顺序与命中来源；exec 层替换为空结果，避免触达真实系统与拖慢进程。
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentProfileSchema } from "../../src/config/schema.js";
import {
  discoverTraework,
  validExecutable,
  normalizeDrive,
  orderedDrives,
} from "../../src/agents/traework/discovery.js";
import { makeTmpRoot, rmrf } from "../test-utils.js";

vi.mock("../../src/verify/exec.js", () => ({
  execFileAsync: async () => ({ status: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }),
}));

const WIN_EXE = "TRAE SOLO CN.exe";
const MAC_EXE = "TRAE SOLO CN";
const REL = "TRAE Work CN/TRAE SOLO CN.exe";

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
    adapter: "traework-gui",
    status: "ready",
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

describe("TraeWork 安装探测（issue #23 C3）", () => {
  it("Windows 只认 TRAE SOLO CN.exe（避免误匹配 TraeCode CN）", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "traework-name-"));
    try {
      const solo = path.join(root, "TRAE SOLO CN.exe");
      const traeCn = path.join(root, "Trae CN.exe");
      const traework = path.join(root, "TraeWork.exe");
      for (const f of [solo, traeCn, traework]) fs.writeFileSync(f, "");
      expect(validExecutable(solo, "win32")).toBe(true);
      // TraeCode CN 属于另一个产品，绝不能命中
      expect(validExecutable(traeCn, "win32")).toBe(false);
      expect(validExecutable(traework, "win32")).toBe(false);
      // 前缀/包含式近似名也不命中
      expect(validExecutable(path.join(root, "TRAE SOLO CN Beta.exe"), "win32")).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("显式 gui.exePath 优先；不存在时下探固定盘相对路径", async () => {
    const root = await makeTmpRoot("traework-explicit");
    const dRoot = path.join(root, "d-drive");
    const relativeExe = path.join(dRoot, REL);
    writeFile(relativeExe);
    const input = {
      platform: "win32" as const,
      fixedDrives: [],
      registryDirs: [],
      driveRoots: { "D:": dRoot },
    };
    expect(
      await discoverTraework(
        profileOf({ exePath: relativeExe, preferredDrives: ["D:"], relativePaths: [REL] }),
        input,
      ),
    ).toMatchObject({ path: relativeExe, source: "explicit" });
    // 显式路径指向不存在的文件：仍按顺序下探到固定盘
    expect(
      await discoverTraework(
        profileOf({ exePath: path.join(root, "not-installed", WIN_EXE), preferredDrives: ["D:"], relativePaths: [REL] }),
        input,
      ),
    ).toMatchObject({ path: relativeExe, source: "fixed-drive" });
    await rmrf(root);
  });

  it("preferredDrives（D:）优先于其他固定盘", async () => {
    const root = await makeTmpRoot("traework-drives");
    const cRoot = path.join(root, "c-drive");
    const dRoot = path.join(root, "d-drive");
    writeFile(path.join(cRoot, REL));
    writeFile(path.join(dRoot, REL));
    const base = { platform: "win32" as const, fixedDrives: ["C:", "D:"], registryDirs: [] };
    expect(
      await discoverTraework(profileOf({ preferredDrives: ["D:"], relativePaths: [REL] }), {
        ...base,
        driveRoots: { "C:": cRoot, "D:": dRoot },
      }),
    ).toMatchObject({ path: path.join(dRoot, REL), source: "fixed-drive" });
    expect(
      await discoverTraework(profileOf({ preferredDrives: [], relativePaths: [REL] }), {
        ...base,
        driveRoots: { "C:": cRoot, "D:": dRoot },
      }),
    ).toMatchObject({ path: path.join(cRoot, REL), source: "fixed-drive" });
    expect(normalizeDrive("d:")).toBe("D:");
    expect(orderedDrives(["C:", "D:", "E:", "d:"], ["D:"])).toEqual(["D:", "C:", "E:"]);
    await rmrf(root);
  });

  it("注册表安装目录命中（直接安装与子目录两种布局）", async () => {
    const root = await makeTmpRoot("traework-registry");
    const directDir = path.join(root, "direct");
    const nestedDir = path.join(root, "nested");
    writeFile(path.join(directDir, WIN_EXE));
    writeFile(path.join(nestedDir, "TRAE Work CN", WIN_EXE));
    const profile = profileOf({ preferredDrives: [], relativePaths: [] });
    const input = { platform: "win32" as const, fixedDrives: [] };
    expect(await discoverTraework(profile, { ...input, registryDirs: [directDir] })).toMatchObject({
      path: path.join(directDir, WIN_EXE),
      source: "registry",
    });
    expect(await discoverTraework(profile, { ...input, registryDirs: [nestedDir] })).toMatchObject({
      path: path.join(nestedDir, "TRAE Work CN", WIN_EXE),
      source: "registry",
    });
    await rmrf(root);
  });

  it("标准目录命中（{LOCALAPPDATA}/Programs 修正后布局）", async () => {
    const root = await makeTmpRoot("traework-standard");
    const standardDir = path.join(root, "standard");
    writeFile(path.join(standardDir, WIN_EXE));
    expect(
      await discoverTraework(profileOf({ dirs: [standardDir], fileNames: [WIN_EXE] }), {
        platform: "win32",
        fixedDrives: [],
        registryDirs: [],
      }),
    ).toMatchObject({ path: path.join(standardDir, WIN_EXE), source: "standard" });
    await rmrf(root);
  });

  it("快捷键目标命中（.lnk 解析出的可执行）", async () => {
    const root = await makeTmpRoot("traework-shortcut");
    const target = path.join(root, "TRAE SOLO CN.exe");
    writeFile(target);
    expect(
      await discoverTraework(profileOf({ preferredDrives: [], relativePaths: [] }), {
        platform: "win32",
        fixedDrives: [],
        registryDirs: [],
        shortcuts: [target],
      }),
    ).toMatchObject({ path: target, source: "shortcut" });
    await rmrf(root);
  });

  it("探测顺序：固定盘相对路径优先于标准目录", async () => {
    const root = await makeTmpRoot("traework-order");
    const dRoot = path.join(root, "d-drive");
    const standardDir = path.join(root, "standard");
    writeFile(path.join(dRoot, REL));
    writeFile(path.join(standardDir, WIN_EXE));
    expect(
      await discoverTraework(
        profileOf({ dirs: [standardDir], fileNames: [WIN_EXE], preferredDrives: ["D:"], relativePaths: [REL] }),
        { platform: "win32", fixedDrives: [], registryDirs: [], driveRoots: { "D:": dRoot } },
      ),
    ).toMatchObject({ path: path.join(dRoot, REL), source: "fixed-drive" });
    await rmrf(root);
  });
});
