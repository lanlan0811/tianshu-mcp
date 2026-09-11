import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { AgentProfileSchema } from "../../src/config/schema.js";
import { discoverZcode, orderedDrives, normalizeDrive } from "../../src/agents/zcode/discovery.js";
import {
  probeZcodePort,
  remoteDebugPort,
  rootZcodeProcesses,
} from "../../src/agents/zcode/instance.js";
import { TraeworkCdpClient } from "../../src/agents/traework/cdp/client.js";
import {
  CdpDisconnectedError,
  CdpUnavailableError,
  retryZcodeEvaluation,
} from "../../src/agents/zcode/cdp.js";
import {
  normalizeZcodeModelSelection,
  parseZcodeModel,
} from "../../src/agents/zcode/model.js";
import { matchZcodeProject, normalizeProjectPath } from "../../src/agents/zcode/project.js";
import { validateTaskReferences } from "../../src/agents/zcode/references.js";
import { judgeZcodePoll } from "../../src/agents/zcode/liveness.js";
import { parseMacSheetBaseline, validateMacSheetBaseline } from "../../src/agents/zcode/dialog.js";
import { ZCODE_SELECTORS } from "../../src/agents/zcode/selectors.js";
import { makeTmpRoot, rmrf } from "../test-utils.js";

describe("ZCode 安装与模型", () => {
  it("AskUserQuestion 使用带选项的可访问 listbox 定位且不依赖中文文案", () => {
    expect(ZCODE_SELECTORS.questionCard.primary).toBe(
      '[role="listbox"][aria-label]:has([role="option"])',
    );
    expect(ZCODE_SELECTORS.questionCard.note).not.toContain("提交");
  });
  it("只重试一次 Runtime.evaluate 瞬态超时，不重试真实断线", async () => {
    let transientCalls = 0;
    expect(
      await retryZcodeEvaluation(
        async () => {
          transientCalls++;
          if (transientCalls === 1) throw new CdpUnavailableError("renderer busy");
          return "stable";
        },
        async () => {},
      ),
    ).toBe("stable");
    expect(transientCalls).toBe(2);

    let disconnectedCalls = 0;
    await expect(
      retryZcodeEvaluation(
        async () => {
          disconnectedCalls++;
          throw new CdpDisconnectedError("closed");
        },
        async () => {},
      ),
    ).rejects.toBeInstanceOf(CdpDisconnectedError);
    expect(disconnectedCalls).toBe(1);
  });
  it("Windows 文件夹守卫不覆盖 PowerShell 只读 PID 变量", () => {
    const source = fs.readFileSync(path.resolve("src", "agents", "zcode", "dialog.ts"), "utf8");
    expect(source).not.toMatch(/\$pid\b/i);
    expect(source).toContain("$dialogOwnerPid");
  });
  it("macOS 文件夹守卫只操作全进程唯一的新 sheet", () => {
    const source = fs.readFileSync(path.resolve("src", "agents", "zcode", "dialog.ts"), "utf8");
    expect(source).not.toContain("set targetSheet to sheet 1 of window 1");
    expect(source).toContain('error "AMBIGUOUS_NEW_ZCODE_FOLDER_SHEET"');
    expect(source).toContain("set targetSheet to sheet 1 of w");
  });
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
  it("只保留 ZCode 根进程并解析等号或空格形式的 CDP 端口", () => {
    const rows = [
      { pid: 10, commandLine: "ZCode.exe --remote-debugging-port=9333" },
      { pid: 11, commandLine: "ZCode.exe --remote-debugging-port 9334" },
      { pid: 12, commandLine: "ZCode.exe --type=renderer --remote-debugging-port=9333" },
      { pid: 13, commandLine: "ZCode.exe zcode.cjs app-server --stdio" },
      { pid: 14, commandLine: "ZCode.exe --no-warnings tools/cua-helper/windows-helper.js" },
    ];
    expect(rootZcodeProcesses(rows).map((row) => row.pid)).toEqual([10, 11]);
    expect(remoteDebugPort(rows[0]!.commandLine)).toBe(9333);
    expect(remoteDebugPort(rows[1]!.commandLine)).toBe(9334);
    expect(remoteDebugPort("ZCode.exe")).toBeNull();
  });
  it("CDP 端口必须同时匹配 ZCode 根进程和产品页面", async () => {
    const rows = [{ pid: 10, commandLine: "ZCode.exe --remote-debugging-port=9333" }];
    const targets = vi.spyOn(TraeworkCdpClient, "listTargets");
    targets.mockResolvedValue([
      {
        type: "page",
        title: "Google Chrome",
        url: "https://example.com",
        webSocketDebuggerUrl: "ws://127.0.0.1/chrome",
      },
    ]);
    expect(await probeZcodePort(9333, rows)).toBeNull();
    expect(await probeZcodePort(9444, rows)).toBeNull();
    targets.mockResolvedValue([
      {
        type: "page",
        title: "ZCode",
        url: "file:///zcode/index.html",
        webSocketDebuggerUrl: "ws://127.0.0.1/zcode",
      },
    ]);
    expect(await probeZcodePort(9333, rows)).toMatchObject({ port: 9333, pid: 10, title: "ZCode" });
    targets.mockRestore();
  });
  it("配置的首选盘即使系统盘枚举失败也可发现，且不硬编码盘符", async () => {
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
        fixedDrives: [],
        driveRoots: { "C:": cRoot, "D:": dRoot },
        registryDirs: [],
      }),
    ).toMatchObject({ path: path.join(dRoot, relative), source: "fixed-drive" });
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
    ).toMatchObject({ path: path.join(standardRoot, "ZCode.exe"), source: "standard" });
    await rmrf(root);
  });
  it("macOS 系统与用户 Applications bundle 均按顺序发现", async () => {
    const root = await makeTmpRoot("zcode-macos-bundles");
    const systemDir = path.join(root, "Applications", "ZCode.app", "Contents", "MacOS");
    const userDir = path.join(
      root,
      "Users",
      "tester",
      "Applications",
      "ZCode.app",
      "Contents",
      "MacOS",
    );
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
      path: path.join(userDir, "ZCode"),
      source: "bundle",
    });
    fs.writeFileSync(path.join(systemDir, "ZCode"), "");
    expect(discoverZcode(profile, { platform: "darwin" })).toMatchObject({
      path: path.join(systemDir, "ZCode"),
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
  it("模型回读移除动态无障碍标签并优先使用当前模型属性", () => {
    expect(
      normalizeZcodeModelSelection({
        display: "DeepSeek/deepseek-flash选择模型",
        ariaLabel: "选择模型",
        currentValue: "custom:provider-id:deepseek-flash",
        legacyInternal: "stale-value",
      }),
    ).toEqual({ display: "DeepSeek/deepseek-flash", internal: "deepseek-flash" });
    expect(
      normalizeZcodeModelSelection({
        display: "Select modelDeepSeek/deepseek-flash",
        ariaLabel: "Select model",
      }),
    ).toEqual({ display: "DeepSeek/deepseek-flash", internal: "deepseek-flash" });
  });
});

describe("ZCode macOS 文件夹面板基线", () => {
  it("只接受 listOwnedDialogs 产生的单一非负 sheet 计数", () => {
    expect(parseMacSheetBaseline(["sheet-count:0"])).toBe(0);
    expect(parseMacSheetBaseline(["sheet-count:2"])).toBe(2);
    expect(parseMacSheetBaseline([])).toBeNull();
    expect(parseMacSheetBaseline(["sheet-count:-1"])).toBeNull();
    expect(parseMacSheetBaseline(["sheet-count:0", "sheet-count:1"])).toBeNull();
  });
  it("存在任何既有 sheet 时 fail-closed，只有零基线可继续", () => {
    expect(validateMacSheetBaseline(["sheet-count:0"])).toEqual({ ok: true, count: 0 });
    expect(validateMacSheetBaseline(["sheet-count:1"])).toMatchObject({ ok: false });
    expect(validateMacSheetBaseline(["bad-baseline"])).toMatchObject({ ok: false });
  });
});

describe("ZCode 项目路径与引用", () => {
  it("Windows 路径大小写、斜杠和尾分隔符归一化", () => {
    expect(normalizeProjectPath("D:\\项目\\Demo\\", "win32")).toBe("d:/项目/demo");
    expect(
      matchZcodeProject([{ name: "Demo", path: "d:/项目/demo" }], "D:\\项目\\Demo", "win32").item,
    ).toBeDefined();
  });
  it("macOS 路径保留大小写语义并清理尾分隔符", () => {
    expect(normalizeProjectPath("/Users/Test/Demo/", "darwin")).toBe("/Users/Test/Demo");
    expect(
      matchZcodeProject([{ name: "Demo", path: "/Users/Test/Demo" }], "/Users/Test/demo", "darwin")
        .item,
    ).toBeUndefined();
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
  it("回复连续稳定且空输入框可编辑时完成，不要求禁用的发送按钮可用", () => {
    const completed = { ...base, sendEnabled: false };
    const first = judgeZcodePoll(completed, { hash: "", stable: 0, idleSince: 0 }, 2, 1000, 10);
    const second = judgeZcodePoll(completed, first.state, 2, 1000, 20);
    const third = judgeZcodePoll(completed, second.state, 2, 1000, 30);
    expect(third.kind).toBe("finished");
  });
});
