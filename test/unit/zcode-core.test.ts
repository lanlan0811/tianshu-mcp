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
