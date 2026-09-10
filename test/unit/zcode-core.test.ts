import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { AgentProfileSchema } from "../../src/config/schema.js";
import { discoverZcode, orderedDrives, normalizeDrive } from "../../src/agents/zcode/discovery.js";
import { parseZcodeModel } from "../../src/agents/zcode/model.js";
import { matchZcodeProject, normalizeProjectPath } from "../../src/agents/zcode/project.js";
import { validateTaskReferences } from "../../src/agents/zcode/references.js";
import { judgeZcodePoll } from "../../src/agents/zcode/liveness.js";
import { makeTmpRoot, rmrf } from "../test-utils.js";

describe("ZCode 安装与模型", () => {
  it("显式 gui.exePath 优先且读取真实文件", async () => {
    const root = await makeTmpRoot("zcode-discovery");
    const exe = path.join(root, process.platform === "win32" ? "ZCode.exe" : "ZCode");
    fs.writeFileSync(exe, "");
    const profile = AgentProfileSchema.parse({
      driver: "gui",
      adapter: "zcode-gui",
      status: "research",
      gui: { exePath: exe },
      executableDiscovery: {
        dirs: [root],
        fileNames: [path.basename(exe)],
        preferredDrives: ["D:"],
        relativePaths: [],
      },
    });
    expect(discoverZcode(profile)?.path).toBe(exe);
    await rmrf(root);
  });
  it("固定盘按可配置 D 优先并去重", () => {
    expect(normalizeDrive("d:")).toBe("D:");
    expect(orderedDrives(["C:", "D:", "E:", "d:"], ["D:"])).toEqual(["D:", "C:", "E:"]);
  });
  it("固定盘候选按可配置优先级发现，而不是硬编码盘符", async () => {
    const root = await makeTmpRoot("zcode-drives");
    const cRoot = path.join(root, "c-drive");
    const dRoot = path.join(root, "d-drive");
    const relative = path.join("Z-Code", "ZCode", "ZCode.exe");
    for (const driveRoot of [cRoot, dRoot]) {
      fs.mkdirSync(path.join(driveRoot, path.dirname(relative)), { recursive: true });
      fs.writeFileSync(path.join(driveRoot, relative), "");
    }
    const profile = AgentProfileSchema.parse({
      driver: "gui",
      adapter: "zcode-gui",
      status: "research",
      command: null,
      executableDiscovery: {
        dirs: [],
        fileNames: ["ZCode.exe"],
        preferredDrives: ["D:"],
        relativePaths: [relative],
      },
    });
    expect(
      discoverZcode(profile, {
        platform: "win32",
        fixedDrives: ["C:", "D:"],
        driveRoots: { "C:": cRoot, "D:": dRoot },
        registryDirs: [],
      }),
    ).toMatchObject({ path: path.win32.join(dRoot, relative), source: "fixed-drive" });
    await rmrf(root);
  });
  it("Windows 注册表安装位置和标准目录均可发现", async () => {
    const root = await makeTmpRoot("zcode-registry-standard");
    const registryRoot = path.join(root, "registry");
    const standardRoot = path.join(root, "standard");
    fs.mkdirSync(registryRoot, { recursive: true });
    fs.mkdirSync(standardRoot, { recursive: true });
    fs.writeFileSync(path.join(registryRoot, "ZCode.exe"), "");
    fs.writeFileSync(path.join(standardRoot, "ZCode.exe"), "");
    const base = {
      driver: "gui" as const,
      adapter: "zcode-gui" as const,
      status: "research" as const,
      command: null,
    };
    const registryProfile = AgentProfileSchema.parse({
      ...base,
      executableDiscovery: {
        dirs: [],
        fileNames: ["ZCode.exe"],
        preferredDrives: [],
        relativePaths: [],
      },
    });
    expect(
      discoverZcode(registryProfile, {
        platform: "win32",
        fixedDrives: [],
        registryDirs: [registryRoot],
      }),
    ).toMatchObject({ source: "registry" });
    const standardProfile = AgentProfileSchema.parse({
      ...base,
      executableDiscovery: {
        dirs: [standardRoot],
        fileNames: ["ZCode.exe"],
        preferredDrives: [],
        relativePaths: [],
      },
    });
    expect(
      discoverZcode(standardProfile, {
        platform: "win32",
        fixedDrives: [],
        registryDirs: [],
      }),
    ).toMatchObject({ path: path.win32.join(standardRoot, "ZCode.exe"), source: "standard" });
    await rmrf(root);
  });
  it("macOS 系统与用户 Applications bundle 均按顺序发现", async () => {
    const root = await makeTmpRoot("zcode-macos-bundles");
    const systemDir = path.join(root, "Applications", "ZCode.app", "Contents", "MacOS");
    const userDir = path.join(root, "Users", "tester", "Applications", "ZCode.app", "Contents", "MacOS");
    fs.mkdirSync(systemDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, "ZCode"), "");
    const profile = AgentProfileSchema.parse({
      driver: "gui",
      adapter: "zcode-gui",
      status: "research",
      command: null,
      executableDiscovery: {
        dirs: [systemDir, userDir],
        fileNames: ["ZCode"],
        preferredDrives: [],
        relativePaths: [],
      },
    });
    expect(discoverZcode(profile, { platform: "darwin" })).toMatchObject({
      path: path.posix.join(userDir, "ZCode"),
      source: "bundle",
    });
    fs.writeFileSync(path.join(systemDir, "ZCode"), "");
    expect(discoverZcode(profile, { platform: "darwin" })).toMatchObject({
      path: path.posix.join(systemDir, "ZCode"),
      source: "bundle",
    });
    await rmrf(root);
  });
  it("严格解析 供应商/模型", () => {
    expect(parseZcodeModel("DeepSeek/deepseek-flash")).toEqual({
      provider: "DeepSeek",
      model: "deepseek-flash",
    });
    expect(() => parseZcodeModel("deepseek-flash")).toThrow(/供应商\/模型/);
    expect(() => parseZcodeModel("A/B/C")).toThrow(/格式错误/);
  });
});

describe("ZCode 项目路径与引用", () => {
  it("Windows 路径大小写、斜杠和尾分隔符归一化", () => {
    expect(normalizeProjectPath("D:\\项目\\Demo\\", "win32")).toBe("d:/项目/demo");
    expect(
      matchZcodeProject([{ name: "Demo", path: "d:/项目/demo" }], "D:\\项目\\Demo", "win32").item,
    ).toBeDefined();
  });
  it("只有同名无路径时判歧义", () => {
    expect(
      matchZcodeProject([{ name: "demo" }, { name: "demo" }], "/tmp/demo", "linux").ambiguous,
    ).toBe(true);
  });
  it("验证中文、空格目录引用并拒绝越界/不存在", async () => {
    const root = await makeTmpRoot("zcode refs 中文");
    const dir = path.join(root, "设计 系统");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(root, "plan.md"), "x");
    const refs = validateTaskReferences("读取 `./plan.md` 和 `./设计 系统`", undefined, root);
    expect(refs).toHaveLength(2);
    expect(refs.some((r) => r.directory)).toBe(true);
    expect(() => validateTaskReferences("读取 `../outside.md`", undefined, root)).toThrow(
      /越出项目范围/,
    );
    expect(() => validateTaskReferences("读取 `./missing.md`", undefined, root)).toThrow(/不存在/);
    await rmrf(root);
  });
});

describe("ZCode 运行信号", () => {
  const base = {
    stopVisible: false,
    loading: false,
    activeTool: false,
    assistantText: "完成",
    inputEnabled: true,
    sendEnabled: true,
  };
  it("权威运行信号覆盖回复静止", () => {
    const v = judgeZcodePoll(
      { ...base, stopVisible: true },
      { hash: "abc", stable: 99, idleSince: 1 },
      2,
      100,
      1000,
    );
    expect(v.kind).toBe("running");
  });
  it("问题优先进入 needs_user", () => {
    const v = judgeZcodePoll(
      { ...base, question: "请选择方案" },
      { hash: "", stable: 0, idleSince: 0 },
      2,
      100,
    );
    expect(v.kind).toBe("needs_user");
    expect(v.question).toBe("请选择方案");
  });
  it("回复连续稳定且输入可用才完成", () => {
    const first = judgeZcodePoll(base, { hash: "", stable: 0, idleSince: 0 }, 2, 1000, 10);
    const second = judgeZcodePoll(base, first.state, 2, 1000, 20);
    const third = judgeZcodePoll(base, second.state, 2, 1000, 30);
    expect(third.kind).toBe("finished");
  });
});
