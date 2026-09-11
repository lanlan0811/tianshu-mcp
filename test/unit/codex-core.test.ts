/**
 * Codex GUI 适配核心单测：发现 / 项目匹配 / 模型等级 / 活性判定 / 提示词 / 修复计划 /
 * 启动参数转义 / 注册表分支。全部无真机依赖（注入假数据）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { AgentProfileSchema } from "../../src/config/schema.js";
import {
  discoverCodex,
  parseAppxPackageJson,
  globSegmentsMatch,
  scanForCodex,
  discoverAumidFromScan,
  versionFromPackageDir,
  compareVersionsDesc,
} from "../../src/agents/codex/discovery.js";
import {
  remoteDebugPort,
  remoteUserDataDir,
  rootCodexProcesses,
  normalizeDir,
  isCodexTarget,
  parseProcessRows,
  pickCodexPage,
} from "../../src/agents/codex/instance.js";
import { buildActivationArgs, ACTIVATION_CSHARP } from "../../src/agents/codex/launcher.js";
import {
  matchCodexProject,
  projectBasename,
  normalizeProjectName,
} from "../../src/agents/codex/project.js";
import {
  parseCodexModel,
  normalizeLevel,
  levelUiTexts,
  exactUiName,
  parseTriggerValue,
  levelTokenMatches,
  extractLevelToken,
} from "../../src/agents/codex/model.js";
import { judgeCodexPoll, initialCodexState } from "../../src/agents/codex/liveness.js";
import {
  buildInitialPrompt,
  buildFixPrompt,
  fixPlanFileName,
  fixPlanRelPath,
  fixPlanAbsPath,
} from "../../src/agents/codex/input.js";
import { renderCodexFixPlan, writeCodexFixPlan } from "../../src/agents/codex/fixplan.js";
import { deriveCodexVerifyBasis, extractFailureEvidence } from "../../src/agents/codex/verify.js";
import { CODEX_SELECTORS, cssCandidates, specArgs } from "../../src/agents/codex/selectors.js";
import { AgentAdapterRegistry } from "../../src/agents/registry.js";
import { CodexGuiAdapter } from "../../src/agents/codex/adapter.js";
import { CliAdapter } from "../../src/agents/cli.js";
import { Logger } from "../../src/util/log.js";
import { makeTmpRoot, rmrf } from "../test-utils.js";
import type { VerifyReport } from "../../src/tasks/task.js";

const silentLogger = new Logger(null, "error");

/** 构造一份验收报告桩（failed=true 时 test 检查失败） */
const makeReport = (failed: boolean): VerifyReport => ({
  round: 0,
  taskId: "tsk_x",
  projectPath: "/p",
  startedAt: "t0",
  finishedAt: "t1",
  passed: !failed,
  verdict: failed ? "failed" : "passed",
  message: "m",
  files: { md: "/p/report-0.md", json: "/p/report-0.json" },
  checks: [
    { name: "test", cmd: "npm test", passed: !failed, durationMs: 12, exitCode: failed ? 1 : 0, outputTail: failed ? "FAIL something" : "", timeout: false },
    { name: "git-diff-check", cmd: "git diff --check", passed: true, durationMs: 1, exitCode: 0, outputTail: "", timeout: false },
  ],
  analysis: {
    changedFiles: ["src/a.ts"],
    untrackedFiles: [],
    diffstat: { totalAdd: 3, totalDel: 1 },
    bigFileChanges: [],
    signals: { todo: 0, consoleDebug: 0, commentedBlock: 0, secretLike: 0 },
    warnings: [],
    notes: [],
  } as unknown as VerifyReport["analysis"],
});

/* ---------------- 步骤 1：安装发现 ---------------- */

describe("Codex 安装发现", () => {
  it("Appx JSON 解析出 InstallLocation / PackageFamilyName / 版本", () => {
    const parsed = parseAppxPackageJson(
      JSON.stringify({
        InstallLocation: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.903.9818.0_x64__2p2nqsd0c76g0",
        PackageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0",
        PackageFullName: "OpenAI.Codex_26.903.9818.0_x64__2p2nqsd0c76g0",
        Version: "26.903.9818.0",
      }),
    );
    expect(parsed).toMatchObject({
      packageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0",
      version: "26.903.9818.0",
    });
    expect(parsed?.installLocation).toContain("OpenAI.Codex_");
  });

  it("空/非法 Appx 输出返回 null（不误判）", () => {
    expect(parseAppxPackageJson("")).toBeNull();
    expect(parseAppxPackageJson("not json")).toBeNull();
    expect(parseAppxPackageJson(JSON.stringify({ InstallLocation: "x" }))).toBeNull();
  });

  it("Appx 优先：命中 InstallLocation 下的 app/ChatGPT.exe 并给出 AUMID", async () => {
    const root = await makeTmpRoot("codex-appx");
    const install = path.join(root, "OpenAI.Codex_26.903.9818.0_x64__2p2nqsd0c76g0");
    fs.mkdirSync(path.join(install, "app"), { recursive: true });
    fs.writeFileSync(path.join(install, "app", "ChatGPT.exe"), "");
    const profile = AgentProfileSchema.parse({
      driver: "gui",
      adapter: "codex-gui",
      executableDiscovery: {
        installRelativeExe: ["app/ChatGPT.exe"],
        appxPackageName: "OpenAI.Codex",
      },
    });
    const found = discoverCodex(profile, {
      platform: "win32",
      appx: {
        installLocation: install,
        packageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0",
        version: "26.903.9818.0",
      },
    });
    expect(found).toMatchObject({ source: "appx", aumid: "OpenAI.Codex_2p2nqsd0c76g0!App" });
    expect(found?.path).toBe(path.join(install, "app", "ChatGPT.exe"));
    await rmrf(root);
  });

  it("Appx 查询失败时回退扫盘，且 AUMID 由目录名推导（不写死版本）", async () => {
    const root = await makeTmpRoot("codex-scan");
    const pkg = "OpenAI.Codex_99.1.2.3_x64__2p2nqsd0c76g0";
    const install = path.join(root, pkg);
    fs.mkdirSync(path.join(install, "app"), { recursive: true });
    fs.writeFileSync(path.join(install, "app", "ChatGPT.exe"), "");
    const profile = AgentProfileSchema.parse({
      driver: "gui",
      adapter: "codex-gui",
      executableDiscovery: {
        installRelativeExe: ["app/ChatGPT.exe"],
        scanRoots: [root],
        scanPattern: "OpenAI.Codex_*_x64__*/app/ChatGPT.exe",
      },
    });
    const found = discoverCodex(profile, { platform: "win32", appx: null });
    expect(found?.source).toBe("scan");
    expect(found?.path).toBe(path.join(install, "app", "ChatGPT.exe"));
    expect(found?.aumid).toBe("OpenAI.Codex_2p2nqsd0c76g0!App"); // publisher hash 段来自目录名
    await rmrf(root);
  });

  it("glob 段匹配大小写不敏感、段数必须一致", () => {
    expect(globSegmentsMatch("OpenAI.Codex_*_x64__*/app/ChatGPT.exe", "openai.codex_26.9_x64__2p2nqsd0c76g0/app/chatgpt.exe")).toBe(true);
    expect(globSegmentsMatch("a/*/b", "a/b")).toBe(false);
    expect(globSegmentsMatch("a/*/c", "a/x/b")).toBe(false);
  });

  it("显式 exePath 优先于 Appx", async () => {
    const root = await makeTmpRoot("codex-explicit");
    const exe = path.join(root, "ChatGPT.exe");
    fs.writeFileSync(exe, "");
    const profile = AgentProfileSchema.parse({
      driver: "gui",
      adapter: "codex-gui",
      gui: { exePath: exe },
      executableDiscovery: { installRelativeExe: ["app/ChatGPT.exe"] },
    });
    expect(discoverCodex(profile, { platform: "win32", appx: null })?.source).toBe("explicit");
    await rmrf(root);
  });

  it("扫盘候选与 AUMID 推导可独立调用", () => {
    expect(discoverAumidFromScan(String.raw`C:\x\OpenAI.Codex_1.2.3.4_x64__abc123def\app\ChatGPT.exe`, "OpenAI.Codex")).toBe("OpenAI.Codex_abc123def!App");
    expect(discoverAumidFromScan(String.raw`C:\x\Other\app\ChatGPT.exe`, "OpenAI.Codex")).toBeUndefined();
  });

  it("scanForCodex 过滤不存在的候选", async () => {
    const root = await makeTmpRoot("codex-scanfn");
    fs.mkdirSync(path.join(root, "PkgX", "app"), { recursive: true });
    expect(scanForCodex([root], ["app/ChatGPT.exe"], undefined)).toEqual([]);
    fs.writeFileSync(path.join(root, "PkgX", "app", "ChatGPT.exe"), "");
    expect(scanForCodex([root], ["app/ChatGPT.exe"], "Pkg*/app/ChatGPT.exe")).toHaveLength(1);
    await rmrf(root);
  });

  it("多版本共存时扫盘取最新版本（真机实测存在两个版本目录）", async () => {
    const root = await makeTmpRoot("codex-multiver");
    for (const v of ["26.903.8094.0", "26.903.9818.0", "26.903.5000.0"]) {
      const dir = path.join(root, `OpenAI.Codex_${v}_x64__2p2nqsd0c76g0`, "app");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "ChatGPT.exe"), "");
    }
    const found = scanForCodex([root], ["app/ChatGPT.exe"], "OpenAI.Codex_*_x64__*/app/ChatGPT.exe");
    expect(found[0]).toContain("26.903.9818.0"); // 最高版本在前
    await rmrf(root);
  });

  it("版本解析与降序比较", () => {
    expect(versionFromPackageDir("OpenAI.Codex_26.903.9818.0_x64__pfn")).toEqual([26, 903, 9818, 0]);
    expect(compareVersionsDesc([26, 903, 9818, 0], [26, 903, 8094, 0])).toBeLessThan(0);
    expect(compareVersionsDesc([1, 2, 3], [1, 2, 3])).toBe(0);
    expect(compareVersionsDesc([2], [1, 99])).toBeLessThan(0);
  });
});

describe("Codex 页面目标选择（真机实测：额外存在 avatar-overlay 页）", () => {
  it("主应用页优先于 overlay 页", () => {
    const targets = [
      { type: "page", url: "app://-/index.html?initialRoute=%2Favatar-overlay", title: "ChatGPT" },
      { type: "page", url: "app://-/index.html", title: "ChatGPT" },
      { type: "webview", url: "https://chatgpt.com/pricing", title: "ChatGPT 方案" },
    ];
    const picked = pickCodexPage(targets);
    expect(picked?.url).toBe("app://-/index.html");
  });

  it("仅有 overlay 页时也能选出（不返回 undefined）", () => {
    const picked = pickCodexPage([
      { type: "page", url: "app://-/index.html?initialRoute=%2Favatar-overlay" },
    ]);
    expect(picked).toBeDefined();
  });
});

/* ---------------- 步骤 2：启动参数与进程识别 ---------------- */

describe("Codex 启动通道", () => {
  it("激活参数含专属 user-data-dir 与调试端口；路径带引号", () => {
    const args = buildActivationArgs("C:\\Users\\a b\\codex profile", 9333);
    expect(args).toContain('--user-data-dir="C:\\Users\\a b\\codex profile"');
    expect(args).toContain("--remote-debugging-port=9333");
  });

  it("启动参数对双引号做转义（防注入）", () => {
    expect(buildActivationArgs('C:\\x"y', 9333)).toContain('\\"y');
  });

  it("内联 C# 声明 IApplicationActivationManager 且无第三方依赖", () => {
    expect(ACTIVATION_CSHARP).toContain("IApplicationActivationManager");
    expect(ACTIVATION_CSHARP).toContain("45BA127D-10A8-46EA-8AB7-56EA9078943C");
    expect(ACTIVATION_CSHARP).toContain("2e941141-7f97-4756-ba1d-9decde894a3d");
  });

  it("只保留 Codex 根进程，解析端口与 user-data-dir", () => {
    const rows = parseProcessRows(
      [
        `10\tC:\\app\\ChatGPT.exe\t"C:\\app\\ChatGPT.exe" --user-data-dir="C:\\p x" --remote-debugging-port=9333`,
        `11\tC:\\app\\ChatGPT.exe\t"C:\\app\\ChatGPT.exe" --type=renderer --user-data-dir="C:\\p x"`,
        `12\tC:\\app\\ChatGPT.exe\t"C:\\app\\ChatGPT.exe" --type=crashpad-handler`,
        `13\tC:\\app\\ChatGPT.exe\t"C:\\app\\ChatGPT.exe"`,
      ].join("\n"),
    );
    expect(rootCodexProcesses(rows).map((r) => r.pid)).toEqual([10, 13]);
    expect(remoteDebugPort(rows[0]!.commandLine)).toBe(9333);
    expect(remoteUserDataDir(rows[0]!.commandLine)).toBe("C:\\p x");
    expect(remoteDebugPort(rows[3]!.commandLine)).toBeNull();
    expect(remoteUserDataDir(rows[3]!.commandLine)).toBeNull();
  });

  it("user-data-dir 身份比较：Windows 大小写不敏感，POSIX 保留大小写", () => {
    // 显式注入 platform，避免断言依赖宿主平台（CI 的 ubuntu/macos 会因此失败）
    expect(normalizeDir("C:\\Users\\A\\Codex", "win32")).toBe(
      normalizeDir("c:/users/a/codex/", "win32"),
    );
    expect(normalizeDir("/Users/A/Codex", "darwin")).not.toBe(
      normalizeDir("/users/a/codex", "darwin"),
    );
  });

  it("Codex 页面身份：app:// 协议或 ChatGPT/Codex 标题", () => {
    expect(isCodexTarget("ChatGPT", "app://-/index.html")).toBe(true);
    expect(isCodexTarget("", "app://-/index.html")).toBe(true);
    expect(isCodexTarget("Google Chrome", "https://example.com")).toBe(false);
  });
});

/* ---------------- 步骤 3：项目匹配 ---------------- */

describe("Codex 项目匹配", () => {
  it("按目录名 basename 匹配，Windows 大小写不敏感", () => {
    const items = [{ name: "tianshu-mcp" }, { name: "ReproCore" }];
    expect(matchCodexProject(items, "D:\\Trae项目\\tianshu-mcp", "win32").item?.name).toBe("tianshu-mcp");
    expect(matchCodexProject(items, "D:\\Trae项目\\TIANSHU-MCP", "win32").item?.name).toBe("tianshu-mcp");
  });

  it("同名多命中 → 歧义，不猜", () => {
    const items = [{ name: "demo" }, { name: "Demo" }];
    expect(matchCodexProject(items, "/x/demo", "win32").ambiguous).toBe(true);
  });

  it("未命中 → 非歧义且无 item（触发新建流程）", () => {
    const r = matchCodexProject([{ name: "other" }], "/x/newproj", "linux");
    expect(r.item).toBeUndefined();
    expect(r.ambiguous).toBe(false);
  });

  it("basename 兼容两种分隔符（跨平台单测）", () => {
    expect(projectBasename("D:\\a\\b\\demo")).toBe("demo");
    expect(projectBasename("/a/b/demo/")).toBe("demo");
  });

  it("项目名归一化处理全角与空白", () => {
    expect(normalizeProjectName("  Demo  ", "win32")).toBe("demo");
    expect(normalizeProjectName("Ｄｅｍｏ", "win32")).toBe("demo"); // NFKC 全角转半角
  });
});

/* ---------------- 步骤 4：模型与思考等级 ---------------- */

describe("Codex 模型与思考等级", () => {
  it("model + reasoningLevel 双字段：中英等级归一", () => {
    expect(parseCodexModel("GPT-5.6 Sol", "高")).toEqual({ model: "GPT-5.6 Sol", level: "high" });
    expect(parseCodexModel("GPT-5.6 Sol", "high")).toEqual({ model: "GPT-5.6 Sol", level: "high" });
    expect(parseCodexModel("GPT-5.6 Sol", "低")).toEqual({ model: "GPT-5.6 Sol", level: "low" });
    expect(parseCodexModel("GPT-5.6 Sol")).toEqual({ model: "GPT-5.6 Sol", level: undefined });
  });

  it("缺 model 报错", () => {
    expect(() => parseCodexModel("")).toThrow(/必须指定 model/);
    expect(() => parseCodexModel(undefined)).toThrow(/必须指定 model/);
  });

  it("等级候选文案中英双语", () => {
    expect(levelUiTexts("high")).toEqual(["高", "High"]);
    expect(levelUiTexts("low")).toEqual(["轻度", "低", "Low", "Light"]);
    expect(normalizeLevel("中")).toBe("medium");
    expect(normalizeLevel("unknown")).toBeUndefined();
  });

  it("等级文案必须精确匹配，避免「高」误命中「极高」（真机实测滑块含 极高 档）", () => {
    expect(levelTokenMatches("高", "high")).toBe(true);
    expect(levelTokenMatches("极高", "high")).toBe(false);
    expect(levelTokenMatches("中度", "medium")).toBe(false);
    expect(levelTokenMatches("中", "medium")).toBe(true);
    expect(extractLevelToken("GPT-5.6 Sol 高")).toBe("高");
    expect(extractLevelToken("GPT-5.6 Sol 极高")).toBe("极高");
  });

  it("触发器回读解析「模型 + 等级」", () => {
    expect(parseTriggerValue("GPT-5.6 Sol 高")).toEqual({ model: "GPT-5.6 Sol", level: "high" });
    expect(parseTriggerValue("GPT-5.6 Sol\n高")).toEqual({ model: "GPT-5.6 Sol", level: "high" });
    expect(parseTriggerValue("GPT-5.6 Sol High")).toEqual({ model: "GPT-5.6 Sol", level: "high" });
    expect(parseTriggerValue("GPT-5.6 Sol")).toEqual({ model: "GPT-5.6 Sol", level: undefined });
  });

  it("UI 文本归一比较容忍空白与大小写", () => {
    expect(exactUiName("完全访问", "完全访问")).toBe(true);
    expect(exactUiName("GPT-5.6  Sol", "gpt-5.6 sol")).toBe(true);
    expect(exactUiName("完全访问", "只读")).toBe(false);
  });
});

/* ---------------- 步骤 6：活性判定 ---------------- */

describe("Codex 运行判定", () => {
  const base = { stopVisible: false, composerText: "", conversationText: "reply", loginVisible: false };

  it("停止按钮出现 → running，且标记已观测运行", () => {
    const v = judgeCodexPoll({ ...base, stopVisible: true }, initialCodexState(), 2, 1000, 10);
    expect(v.kind).toBe("running");
    expect(v.state.sawRunning).toBe(true);
  });

  it("曾运行 → 停止钮消失 → 文本稳定 → finished", () => {
    let state = judgeCodexPoll({ ...base, stopVisible: true }, initialCodexState(), 2, 1000, 10).state;
    let v = judgeCodexPoll(base, state, 2, 1000, 20);
    state = v.state;
    expect(v.kind).toBe("pending");
    for (let i = 0; i < 3 && v.kind === "pending"; i++) {
      v = judgeCodexPoll(base, state, 2, 1000, 30 + i * 10);
      state = v.state;
    }
    expect(v.kind).toBe("finished");
    expect(v.evidence).toContain("stop_button_gone");
  });

  it("从未观测到运行信号 → 永不误判完成，最终 idle_timeout（失败开放）", () => {
    let state = initialCodexState();
    // 文本一直不变且无停止钮：多轮稳定后不判 finished
    let sawFinished = false;
    for (let i = 0; i < 10; i++) {
      const v = judgeCodexPoll(base, state, 2, 1000, 10_000 + i * 100);
      state = v.state;
      if (v.kind === "finished") sawFinished = true;
    }
    expect(sawFinished).toBe(false);
    const late = judgeCodexPoll(base, state, 2, 1000, 60_000);
    expect(late.kind).toBe("idle_timeout");
  });

  it("登录指示优先 → needs_login", () => {
    const v = judgeCodexPoll({ ...base, loginVisible: true, stopVisible: true }, initialCodexState(), 2, 1000, 10);
    expect(v.kind).toBe("needs_login");
  });

  it("文本变化会重置稳定计数", () => {
    const s1 = judgeCodexPoll({ ...base, stopVisible: true }, initialCodexState(), 2, 1000, 10).state;
    const s2 = judgeCodexPoll(base, s1, 2, 1000, 20).state;
    const s3 = judgeCodexPoll({ ...base, conversationText: "reply-growing" }, s2, 2, 1000, 30).state;
    expect(s3.stable).toBe(0);
  });
});

/* ---------------- 步骤 4/8：提示词与修复计划 ---------------- */

describe("Codex 提示词与修复计划", () => {
  it("计划文档 + 设计系统拼进初始指令", () => {
    const p = buildInitialPrompt({
      task: "开发登录模块",
      planDoc: "plan/login.md",
      designSystem: ".design",
    });
    expect(p).toContain("根据计划文档(plan/login.md)和设计系统(.design)，进行项目开发");
    expect(p).toContain("开发登录模块");
  });

  it("只给其一/都没有时不编造引用", () => {
    expect(buildInitialPrompt({ task: "t", planDoc: "a.md" })).toContain("根据计划文档(a.md)，进行项目开发");
    expect(buildInitialPrompt({ task: "t", designSystem: ".d" })).toContain("根据设计系统(.d)，进行项目开发");
    expect(buildInitialPrompt({ task: "t" })).toBe("t");
  });

  it("返修轮：feedback 直接作为指令（不重发原任务书）", () => {
    const p = buildInitialPrompt({ task: "原始任务", feedback: "修复指令X" });
    expect(p).toBe("修复指令X");
  });

  it("修复计划文件名含轮次号、每轮独立（决策 12）", () => {
    expect(fixPlanFileName(1)).toBe("codex-fix-r1.md");
    expect(fixPlanFileName(5)).toBe("codex-fix-r5.md");
    expect(fixPlanRelPath(undefined, 3)).toBe(".zcode/plans/codex-fix-r3.md");
    expect(fixPlanRelPath("docs/plans/", 2)).toBe("docs/plans/codex-fix-r2.md");
  });

  it("修复指令引用 MCP 生成的计划文档路径", () => {
    const p = buildFixPrompt({
      summary: "未通过检查: test",
      planRelPath: ".zcode/plans/codex-fix-r1.md",
      reportPath: "/data/report-0.md",
      evidence: "$ npm test\nexit=1",
    });
    expect(p).toContain(".zcode/plans/codex-fix-r1.md");
    expect(p).toContain("未通过检查: test");
    expect(p).toContain("$ npm test");
  });

  it("fixPlanAbsPath 落在项目内约定目录", () => {
    const abs = fixPlanAbsPath(path.join("C:", "proj"), undefined, 1);
    expect(abs).toBe(path.join("C:", "proj", ".zcode", "plans", "codex-fix-r1.md"));
  });

  const report = makeReport;

  it("自动生成的修复计划包含失败证据与轮次号（决策 11）", async () => {
    const root = await makeTmpRoot("codex-fixplan");
    const res = await writeCodexFixPlan({
      taskId: "tsk_x",
      round: 0,
      projectPath: root,
      displayPath: root,
      taskText: "原始任务书",
      report: report(true),
      logger: silentLogger,
    });
    expect(res.relPath).toBe(".zcode/plans/codex-fix-r1.md");
    expect(fs.existsSync(res.absPath)).toBe(true);
    const md = fs.readFileSync(res.absPath, "utf8");
    expect(md).toContain("第 1 轮返修");
    expect(md).toContain("FAIL something");
    expect(md).toContain("原始任务书");
    await rmrf(root);
  });

  it("每轮独立文件不覆盖历史（决策 12）", async () => {
    const root = await makeTmpRoot("codex-fixplan-multi");
    const mk = (round: number) =>
      writeCodexFixPlan({
        taskId: "tsk_x",
        round,
        projectPath: root,
        displayPath: root,
        taskText: "t",
        report: report(true),
        logger: silentLogger,
      });
    const r1 = await mk(0);
    const r2 = await mk(1);
    expect(r1.absPath).not.toBe(r2.absPath);
    expect(fs.existsSync(r1.absPath) && fs.existsSync(r2.absPath)).toBe(true);
    await rmrf(root);
  });

  it("渲染正文含章节结构与修复要求", () => {
    const md = renderCodexFixPlan({
      taskId: "t",
      round: 1,
      projectPath: "/p",
      displayPath: "/p",
      taskText: "任务",
      report: report(true),
      logger: silentLogger,
    });
    expect(md).toContain("## 2. 失败项（必须修复）");
    expect(md).toContain("## 5. 修复要求");
    expect(md).toContain("第 2 轮返修");
  });
});

/* ---------------- 步骤 7/9：验收基座 ---------------- */

describe("Codex 验收基座（决策 9/20）", () => {
  it("package.json 有脚本 → 非弱验收，推导出命令", async () => {
    const root = await makeTmpRoot("codex-verify");
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run", build: "tsc" } }),
    );
    const basis = await deriveCodexVerifyBasis(root);
    expect(basis.weak).toBe(false);
    expect(basis.checks.map((c) => c.name).sort()).toEqual(["build", "test"]);
    await rmrf(root);
  });

  it("无脚本/非 Node 项目 → 弱验收并显式标注", async () => {
    const root = await makeTmpRoot("codex-verify-weak");
    const basis = await deriveCodexVerifyBasis(root);
    expect(basis.weak).toBe(true);
    expect(basis.notes.join(" ")).toContain("弱验收");
    await rmrf(root);
  });

  it("失败证据抽取含命令/退出码/输出", () => {
    const ev = extractFailureEvidence(makeReport(true));
    expect(ev).toContain("npm test");
    expect(ev).toContain("exit=1");
    expect(ev).toContain("FAIL something");
  });
});

/* ---------------- 选择器规范 ---------------- */

describe("Codex 选择器规范", () => {
  it("输入框与发送按钮有中英双语候选 + 结构兜底", () => {
    expect(CODEX_SELECTORS.chatInput.primary).toContain("ProseMirror");
    expect(CODEX_SELECTORS.chatInput.ariaLabels).toEqual(expect.arrayContaining(["随心输入"]));
    const send = cssCandidates("sendButton");
    expect(send.some((s) => s.includes("发送"))).toBe(true);
    expect(send.some((s) => /Send/i.test(s))).toBe(true);
  });

  it("项目项与权限触发器靠 aria 定位（无 data-testid 依赖）", () => {
    expect(CODEX_SELECTORS.projectItem.primary).toContain("aria-label");
    expect(JSON.stringify(CODEX_SELECTORS.projectItem)).not.toContain("data-testid");
    expect(CODEX_SELECTORS.permissionTrigger.ariaLabels).toEqual(expect.arrayContaining(["更改权限"]));
  });

  it("profile 覆盖可热修复选择器", () => {
    const css = cssCandidates("sendButton", { sendButton: "#my-send" });
    expect(css[0]).toBe("#my-send");
  });

  it("specArgs 输出 [css, texts, ariaLabels, patterns, excludes, scope]", () => {
    const args = JSON.parse(specArgs("newChat")) as unknown[];
    expect(args).toHaveLength(6);
    expect(Array.isArray(args[0])).toBe(true);
    expect(JSON.stringify(args)).toContain("新对话");
    expect(JSON.stringify(args)).toContain("New chat");
  });

  it("模型触发器限定输入框作用域且排除菜单栏（真机实测）", () => {
    expect(CODEX_SELECTORS.modelTrigger.excludes?.length).toBeGreaterThan(0);
    expect(CODEX_SELECTORS.modelTrigger.scope).toContain("ComposerLayout");
    const args = JSON.parse(specArgs("modelTrigger")) as unknown[];
    expect(JSON.stringify(args[4])).toContain("menubar");
    expect(String(args[5])).toContain("ComposerLayout");
  });

  it("对话区选择器不使用裸 main/#root（真机实测会混入导航壳）", () => {
    expect(CODEX_SELECTORS.messageArea.primary).toContain("MainContentSurface");
    expect(CODEX_SELECTORS.messageArea.fallbacks).not.toContain("main");
    expect(CODEX_SELECTORS.messageArea.fallbacks).not.toContain("#root");
  });

  it("项目选择触发器靠「切换项目」文案（真机实测：侧栏另有「添加新项目」需避免误点）", () => {
    const spec = CODEX_SELECTORS.projectPickerTrigger;
    expect(spec.primary).toContain("切换项目");
    // 不能把侧栏「添加新项目」或「不在项目中工作」混入本键（后者是独立动作按钮）
    expect(JSON.stringify(spec)).not.toContain("添加新项目");
    expect(JSON.stringify(spec.ariaLabels ?? [])).not.toContain("不在项目中工作");
    expect((spec.ariaPatterns ?? []).join(" ")).toContain("切换项目");
  });

  it("源文件夹点击目标必须是按钮而非「源文件夹」label（真机实测点 label 不弹对话框）", () => {
    const spec = CODEX_SELECTORS.sourceFolderArea;
    expect((spec.fallbacks ?? []).join(" ")).toContain("button");
    expect(JSON.stringify(spec.texts ?? [])).toContain("添加 Codex 可读取和编辑的文件夹");
    expect(JSON.stringify(spec.texts ?? [])).not.toContain('"源文件夹"');
  });

  it("创建项目按钮限定在对话框内（真机实测标题 h2 同名会造成歧义）", () => {
    expect((CODEX_SELECTORS.createProjectButton.fallbacks ?? []).length).toBeGreaterThan(0);
    expect(specArgs("createProjectButton")).toContain("创建项目");
  });

  it("模型触发器用 :not([aria-label]) 锁定（真机实测：同组权限/分支/本地 chip 也带 aria-haspopup）", () => {
    // 真机踩坑：输入框工具条同组 4 个 chip 都有 aria-haspopup=menu，
    // 只有「模型+等级」没有 aria-label；用通用选择器会先命中「完全访问」导致点错。
    expect(CODEX_SELECTORS.modelTrigger.primary).toContain(':not([aria-label])');
    expect(CODEX_SELECTORS.modelTrigger.excludes).toEqual(
      expect.arrayContaining(['[aria-label="更改权限"]', '[aria-label="选择聊天的运行位置"]', '[aria-label="切换分支"]']),
    );
  });

  it("思考强度是滑块选择器，模型候选是 menuitemradio（真机实测菜单结构）", () => {
    expect(CODEX_SELECTORS.reasoningSlider.primary).toContain('[role="slider"]');
    expect(CODEX_SELECTORS.modelMenuItem.primary).toContain("menuitemradio");
  });

  it("resolve 函数接受 specArgs 单数组形式（真机曾因参数错位抛 length 错）", async () => {
    // 真机教训：cdp.ts 以 __codexResolve(specArgs(...)) 单数组调用，
    // 若函数只接受 5 个位置参数，texts 为 undefined → 抛 TypeError。
    // 这里用 jsdom 不可用，改为在新 Function 作用域注入最小 document 桩验证解构逻辑。
    const { resolveFnSource } = await import("../../src/agents/codex/selectors.js");
    const fn = new Function(
      `const document={querySelectorAll:()=>[]};${resolveFnSource()};return __codexResolve;`,
    )() as (...a: unknown[]) => unknown[];
    // 单数组形式（specArgs 产物）不得抛错
    expect(() => fn(JSON.parse(specArgs("chatInput")))).not.toThrow();
    // 位置参数形式同样可用
    expect(() => fn([], [], [], [], [])).not.toThrow();
    // 数组内缺省段位也不得抛错（防御性）
    expect(() => fn([])).not.toThrow();
  });
});

/* ---------------- 注册表分支 ---------------- */

describe("Codex 注册表接入", () => {
  it("driver=gui + adapter=codex-gui 解析为 CodexGuiAdapter", async () => {
    const reg = new AgentAdapterRegistry(
      async () => ({
        codex: AgentProfileSchema.parse({ driver: "gui", adapter: "codex-gui", status: "ready" }),
      }),
      silentLogger,
    );
    await reg.resolve("codex");
    expect(reg.getAdapter("codex")).toBeInstanceOf(CodexGuiAdapter);
  });

  it("切回 spawn profile 时回退到 CliAdapter", async () => {
    let profile = AgentProfileSchema.parse({ driver: "gui", adapter: "codex-gui", status: "ready" });
    const reg = new AgentAdapterRegistry(async () => ({ codex: profile }), silentLogger);
    await reg.resolve("codex");
    expect(reg.getAdapter("codex")).toBeInstanceOf(CodexGuiAdapter);
    profile = AgentProfileSchema.parse({ driver: "spawn", command: "node", status: "ready" });
    await reg.resolve("codex", false);
    expect(reg.getAdapter("codex")).toBeInstanceOf(CliAdapter);
  });

  it("builtin codex profile 为 codex-gui + msix-com + 专属 user-data-dir", async () => {
    const { BUILTIN_PROFILES } = await import("../../src/agents/builtin.js");
    const codex = BUILTIN_PROFILES.codex!;
    expect(codex.driver).toBe("gui");
    expect(codex.adapter).toBe("codex-gui");
    expect(codex.gui?.activation).toBe("msix-com");
    expect(codex.gui?.permissionMode).toBe("完全访问");
    expect(codex.gui?.fixPlanDir).toBe(".zcode/plans");
    expect(codex.gui?.defaultAutoFixRounds).toBe(5);
    expect(codex.executableDiscovery?.appxPackageName).toBe("OpenAI.Codex");
  });
});

/* ---------------- run.ts 归一配置 ---------------- */

describe("Codex run 配置归一", () => {
  it("guiOf 提供 msix-com 与默认权限/修复目录", async () => {
    const { codexGuiOf } = await import("../../src/agents/codex/run.js");
    const profile = AgentProfileSchema.parse({ driver: "gui", adapter: "codex-gui", status: "ready" });
    const gui = codexGuiOf({
      id: "codex",
      displayName: "c",
      profile,
      command: "",
      argsTemplate: [],
      ok: true,
      message: "",
    });
    expect(gui.activation).toBe("msix-com");
    expect(gui.permissionMode).toBe("完全访问");
    expect(gui.defaultAutoFixRounds).toBe(5);
    expect(gui.fixPlanDir).toBe(".zcode/plans");
  });
});

/* ---------------- 项目登记（解决新建项目依赖原生对话框） ---------------- */

describe("Codex 项目登记", () => {
  const stateWith = (entries: Record<string, { id: string; name: string; rootPaths: string[] }>) => ({
    "local-projects": entries,
    "project-order": Object.keys(entries),
    "unrelated-key": { keep: true },
  });

  it("已登记同路径（Windows 大小写不敏感）→ 识别为已存在", async () => {
    const { isProjectRegistered } = await import("../../src/agents/codex/registry.js");
    const st = stateWith({
      abc: { id: "abc", name: "切水果小游戏", rootPaths: ["D:\\切水果小游戏"] },
    });
    expect(isProjectRegistered(st, "d:\\切水果小游戏")).toBe("abc");
    expect(isProjectRegistered(st, "D:\\其它")).toBeNull();
  });

  it("非 Windows 直接 skipped（不写文件）", async () => {
    const { ensureProjectRegistered } = await import("../../src/agents/codex/registry.js");
    const r = ensureProjectRegistered("D:PROJX", { activation: "msix-com" } as never, silentLogger, {
      platform: "linux",
    });
    expect(r.status).toBe("skipped");
  });

  it("登记新项目：写入 local-projects/project-order 且保留其它键、创建备份", async () => {
    const { ensureProjectRegistered, isProjectRegistered } = await import("../../src/agents/codex/registry.js");
    const root = await makeTmpRoot("codex-register");
    const stateFile = path.join(root, "state.json");
    const before = stateWith({
      existing: { id: "existing", name: "已有项目", rootPaths: ["D:\\已有"] },
    });
    fs.writeFileSync(stateFile, JSON.stringify(before), "utf8");
    let stopped = 0;
    const r = ensureProjectRegistered("D:\\切水果小游戏", {} as never, silentLogger, {
      stateFile,
      platform: "win32",
      stopInstances: () => {
        stopped += 1;
      },
    });
    expect(r.status).toBe("performed");
    expect(stopped).toBe(1);
    const after = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    expect(after["unrelated-key"]).toEqual({ keep: true });
    expect(isProjectRegistered(after, "D:\\切水果小游戏")).toBeTruthy();
    expect(after["project-order"][0]).toBe(r.projectId);
    expect(after["project-order"]).toContain("existing");
    expect(fs.existsSync(`${stateFile}.tianshu-mcp-backup.json`)).toBe(true);
    await rmrf(root);
  });

  it("已登记时不重复写入（幂等）", async () => {
    const { ensureProjectRegistered } = await import("../../src/agents/codex/registry.js");
    const root = await makeTmpRoot("codex-register-idempotent");
    const stateFile = path.join(root, "state.json");
    fs.writeFileSync(
      stateFile,
      JSON.stringify(stateWith({ x: { id: "x", name: "p", rootPaths: ["D:\\切水果小游戏"] } })),
      "utf8",
    );
    const before = fs.readFileSync(stateFile, "utf8");
    let stopped = 0;
    const r = ensureProjectRegistered("D:\\切水果小游戏", {} as never, silentLogger, {
      stateFile,
      platform: "win32",
      stopInstances: () => { stopped += 1; },
    });
    expect(r.status).toBe("already");
    expect(stopped).toBe(0);
    expect(fs.readFileSync(stateFile, "utf8")).toBe(before);
    await rmrf(root);
  });

  it("状态文件不可解析 → skipped（回退界面路径，不破坏文件）", async () => {
    const { ensureProjectRegistered } = await import("../../src/agents/codex/registry.js");
    const root = await makeTmpRoot("codex-register-badjson");
    const stateFile = path.join(root, "state.json");
    fs.writeFileSync(stateFile, "{ not json", "utf8");
    const r = ensureProjectRegistered("D:PROJX", {} as never, silentLogger, {
      stateFile,
      platform: "win32",
      stopInstances: () => {},
    });
    expect(r.status).toBe("skipped");
    expect(fs.readFileSync(stateFile, "utf8")).toBe("{ not json");
    await rmrf(root);
  });
});
