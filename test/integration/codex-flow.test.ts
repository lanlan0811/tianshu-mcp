/**
 * Codex GUI 集成测试：以假 CDP 客户端 + 注入 deps 驱动真实 runCodexTask 全流程，
 * 并验证 fix-loop 的 Codex 分支（自动生成 codex-fix-r<N>.md 并引用它返修）。
 * 不依赖真机（Windows MSIX / 原生对话框均以假实现注入）。
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { runCodexTask, type CodexRunDeps } from "../../src/agents/codex/run.js";
import { AgentProfileSchema } from "../../src/config/schema.js";
import type { AgentRunOptions, ResolvedAgent, TaskContext } from "../../src/agents/adapter.js";
import { makeTmpRoot, rmrf, gitInitAndCommit } from "../test-utils.js";
import { Logger } from "../../src/util/log.js";
import { CdpDisconnectedError } from "../../src/agents/codex/cdp.js";

const logger = new Logger(null, "error");
const cleanup: string[] = [];
afterAll(async () => {
  for (const dir of cleanup) await rmrf(dir);
});

function resolved(guiOverrides: Record<string, unknown> = {}): ResolvedAgent {
  const profile = AgentProfileSchema.parse({
    displayName: "Codex test",
    driver: "gui",
    adapter: "codex-gui",
    status: "ready",
    command: process.execPath,
    executableDiscovery: { installRelativeExe: ["app/ChatGPT.exe"] },
    gui: {
      pollIntervalMs: 1,
      stableRounds: 2,
      idleTimeoutMs: 1000,
      progressIntervalMs: 1,
      activation: "msix-com",
      permissionMode: "完全访问",
      defaultPermissionMode: "完全访问",
      fixPlanDir: ".zcode/plans",
      ...guiOverrides,
    },
  });
  return {
    id: "codex",
    displayName: "Codex test",
    profile,
    command: process.execPath,
    argsTemplate: [],
    ok: true,
    message: "test",
  };
}

function ctx(projectPath: string, extra: Partial<TaskContext> = {}): TaskContext {
  return {
    taskId: "tsk_codex",
    projectPath,
    displayPath: projectPath,
    agentId: "codex",
    task: "完成开发",
    model: "GPT-5.6 Sol",
    reasoningLevel: "high",
    round: 0,
    taskDir: path.join(projectPath, "task-data"),
    workDir: projectPath,
    taskTimeoutMs: 10_000,
    ...extra,
  };
}
function opts(): AgentRunOptions {
  return { logger, onProgress: () => {} };
}

/** 假 Codex CDP：内存状态机，所有选择器键按语义响应 */
class FakeCodex {
  sent = 0;
  typed = "";
  conversation = "";
  model = "GPT-5.6 Sol";
  level = "high";
  permission = "完全访问";
  boundProject = "";
  clicked: string[] = [];
  /** 是否已点开「源文件夹」（用于模拟原生选择器回填） */
  sourceFolderClicked = false;
  /**
   * 剩余「生成中」轮数：>0 时返回 stopVisible=true（权威运行信号）。
   * 用递减计数而非轮次判断，因为发送确认循环也会消耗一次 poll。
   */
  stopRemaining = 0;
  /** 每次 sendMessage 后设置的生成持续轮数 */
  constructor(
    protected readonly projectPath: string,
    private readonly projectExists = true,
    private readonly generatingRounds = 3,
  ) {}

  async connect() {}
  disconnect() {}
  async dismissMenus() {}
  async exists(key: string) {
    if (key === "chatInput") return true;
    if (key === "permissionTrigger") return true;
    if (key === "projectPickerTrigger") return true;
    // 新建项目弹层/创建项目对话框固定「可解析」，供 waitFor 立即通过
    if (key === "newProjectMenuItem" || key === "sourceFolderArea" || key === "createProjectButton") return true;
    if (key === "loginIndicator") return false;
    return false;
  }
  async click(key: string) {
    this.clicked.push(key);
    if (key === "newChat") {
      this.conversation = "";
      return true;
    }
    if (key === "modelTrigger" || key === "permissionTrigger" || key === "projectPickerTrigger") return true;
    if (key === "sourceFolderArea") return true;
    return true;
  }
  async clickByAriaLabel(label: string) {
    this.clicked.push(`aria:${label}`);
    const m = /在 (.+?) 中开始新聊天/.exec(label);
    if (m) {
      this.boundProject = m[1]!;
      return true;
    }
    return false;
  }
  /** trusted 点击：与 click 等价（假客户端无真实鼠标事件），但记录「源文件夹已点开」 */
  async clickTrusted(key: string) {
    if (key === "sourceFolderArea") this.sourceFolderClicked = true;
    return this.click(key);
  }
  /** 创建项目对话框全文（源文件夹由原生选择器回填后才有内容） */
  async createProjectDialogText() {
    // 真实流程：点开源文件夹 → 原生对话框选目录 → 对话框回填目标目录
    if (!this.sourceFolderClicked) return "创建项目 名称 源文件夹 添加 Codex 可读取和编辑的文件夹 取消 创建项目";
    return `创建项目 名称 源文件夹 ${path.basename(this.projectPath)} 添加文件夹 取消 创建项目`;
  }
  async projects() {
    return this.projectExists ? [{ name: path.basename(this.projectPath), actionsLabel: `${path.basename(this.projectPath)} 的项目操作` }] : [];
  }
  async boundProjectName() {
    return this.boundProject;
  }
  async clickExact(key: string, value: string) {
    if (key === "newProjectMenuItem") return { clicked: true, count: 1, available: [value] };
    if (key === "createProjectButton") {
      this.boundProject = path.basename(this.projectPath);
      return { clicked: true, count: 1, available: [value] };
    }
    if (key === "menuItem") {
      // 模型项与等级项共用 menuItem：按文案归类
      if (/低|中|高|Low|Medium|High/i.test(value) && !/GPT/i.test(value)) {
        this.level = /低|Low/i.test(value) ? "low" : /中|Medium/i.test(value) ? "medium" : "high";
      } else {
        this.model = value;
        this.level = "high";
      }
      return { clicked: true, count: 1, available: [value] };
    }
    if (key === "permissionOption") {
      this.permission = value;
      return { clicked: true, count: 1, available: [value] };
    }
    return { clicked: false, count: 0, available: [] };
  }
  async text(key: string) {
    if (key === "modelTrigger") return this.level === "high" ? `${this.model} 高` : `${this.model} ${this.level}`;
    if (key === "permissionTrigger") return this.permission;
    if (key === "chatInput") return this.typed;
    if (key === "sourceFolderArea") return path.basename(this.projectPath);
    return "";
  }
  async modelTriggerText() {
    return this.level === "high" ? `${this.model} 高` : `${this.model} ${this.level}`;
  }
  async permissionText() {
    return this.permission;
  }
  async focusComposer() {
    return true;
  }
  async typeText(text: string) {
    this.typed = text;
  }
  async inputText() {
    return this.typed;
  }
  async sendMessage() {
    this.sent++;
    this.conversation = this.typed;
    this.typed = "";
    this.stopRemaining = this.generatingRounds;
  }
  async poll() {
    if (!this.sent)
      return { stopVisible: false, sendVisible: false, composerText: "", conversationText: "", loginVisible: false };
    if (this.stopRemaining > 0) {
      this.stopRemaining--;
      return {
        stopVisible: true,
        sendVisible: false,
        composerText: "",
        conversationText: `${this.conversation}Codex开发中`,
        loginVisible: false,
      };
    }
    return {
      stopVisible: false,
      sendVisible: false,
      composerText: "",
      conversationText: `${this.conversation}Codex已完成开发`,
      loginVisible: false,
    };
  }
}

/** 运行信号始终不出现（模拟停止钮选择器漂移）：消息已进入对话但无停止钮 */
class NoRunningSignalCodex extends FakeCodex {
  override async poll() {
    if (!this.sent)
      return { stopVisible: false, sendVisible: false, composerText: "", conversationText: "", loginVisible: false };
    return {
      stopVisible: false,
      sendVisible: false,
      composerText: "",
      conversationText: `${this.conversation}静止回复`,
      loginVisible: false,
    };
  }
}

class SendUnknownCodex extends FakeCodex {
  override async sendMessage() {
    this.sent++;
  }
  override async inputText() {
    return this.typed; // 输入框未清空 → 发送无法确认
  }
  override async poll() {
    return { stopVisible: false, sendVisible: false, composerText: "", conversationText: "", loginVisible: false };
  }
}
class AmbiguousProjectCodex extends FakeCodex {
  override async projects() {
    const name = path.basename(this.projectPath);
    return [
      { name, actionsLabel: `${name} 的项目操作` },
      { name, actionsLabel: `${name} 的项目操作` },
    ];
  }
}

class WrongBoundCodex extends FakeCodex {
  override async boundProjectName() {
    return "some-other-project";
  }
}

class LoginCodex extends FakeCodex {
  override async exists(key: string) {
    return key === "loginIndicator" || key === "chatInput";
  }
}

class DisconnectedCodex extends FakeCodex {
  override async poll() {
    if (this.sent) throw new CdpDisconnectedError("test disconnect");
    return super.poll();
  }
}

function depsFor(fake: FakeCodex, over: Partial<CodexRunDeps> = {}): Partial<CodexRunDeps> {
  return {
    discover: () =>
      ({ path: process.execPath, aumid: "OpenAI.Codex_test!App", source: "appx" as const }),
    ensureInstance: async () => ({ ready: { port: 9333, pid: 1, title: "ChatGPT", url: "app://-/index.html" } }),
    listProcesses: () => [{ pid: 1, commandLine: `ChatGPT.exe --remote-debugging-port=9333` }],
    createClient: () => fake as never,
    listDialogs: async () => [],
    selectFolder: async () => ({ ok: true, message: "selected" }),
    focusApp: async () => true,
    closeDialogs: async () => 0,
    sleep: async () => {},
    ...over,
  };
}

describe("Codex 假 CDP 单轮流程", () => {
  it("既有项目：绑定 → 选模型/等级 → 强制权限 → 发送一次 → 完成", async () => {
    const project = await makeTmpRoot("codex-existing");
    cleanup.push(project);
    const fake = new FakeCodex(project, true);
    const result = await runCodexTask({
      ctx: ctx(project, { planDoc: "plan/dev.md", designSystem: ".design" }),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.ok).toBe(true);
    expect(result.endReason).toBe("reply_stable");
    expect(fake.sent).toBe(1);
    expect(fake.model).toBe("GPT-5.6 Sol");
    expect(fake.level).toBe("high");
    expect(fake.permission).toBe("完全访问");
    // 初始指令包含计划文档与设计系统引用
    expect(fake.conversation).toContain("根据计划文档(plan/dev.md)和设计系统(.design)，进行项目开发");
    expect(fake.conversation).toContain("【tianshu:tsk_codex:r0:initial】");
  });

  it("项目不存在：走新建流程（原生对话框键盘驱动）后绑定成功", async () => {
    const project = await makeTmpRoot("codex-newproject");
    cleanup.push(project);
    const fake = new FakeCodex(project, false);
    let selectedPath = "";
    let baseline: string[] = [];
    const result = await runCodexTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake, {
        listDialogs: async () => ["existing-dialog"],
        selectFolder: async (folder, _pids, before) => {
          selectedPath = folder;
          baseline = before;
          return { ok: true, message: "selected" };
        },
      }),
    });
    expect(result.ok).toBe(true);
    expect(fake.sent).toBe(1);
    expect(selectedPath).toBe(project);
    expect(baseline).toEqual(["existing-dialog"]);
    expect(fake.clicked).toContain("projectPickerTrigger");
    expect(fake.clicked).toContain("sourceFolderArea");
  });

  it("同名项目歧义 → 不发送、fail-closed", async () => {
    const project = await makeTmpRoot("codex-ambiguous");
    cleanup.push(project);
    const fake = new AmbiguousProjectCodex(project);
    const result = await runCodexTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.ok).toBe(false);
    expect(result.endReason).toBe("project_ambiguous");
    expect(fake.sent).toBe(0);
  });

  it("绑定回读不一致 → fail-closed，不发送", async () => {
    const project = await makeTmpRoot("codex-wrongbound");
    cleanup.push(project);
    const fake = new WrongBoundCodex(project);
    const result = await runCodexTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake, { sleep: async () => {} }),
    });
    expect(result.ok).toBe(false);
    expect(result.endReason).toBe("project_mismatch");
    expect(fake.sent).toBe(0);
  });

  it("登录页 → needs_user(login_required)", async () => {
    const project = await makeTmpRoot("codex-login");
    cleanup.push(project);
    const fake = new LoginCodex(project);
    const result = await runCodexTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.endReason).toBe("needs_user");
    expect(result.needsUserKind).toBe("login_required");
    expect(fake.sent).toBe(0);
  });

  it("发送无法确认 → send_unknown，不重复发送", async () => {
    const project = await makeTmpRoot("codex-sendunknown");
    cleanup.push(project);
    const fake = new SendUnknownCodex(project);
    const result = await runCodexTask({
      ctx: ctx(project, { taskTimeoutMs: 1_500 }),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.ok).toBe(false);
    expect(result.endReason).toBe("send_unknown");
    expect(fake.sent).toBe(1);
  });

  it("停止钮选择器未命中 → 不误判完成，最终 idle_timeout 且保留实例", async () => {
    const project = await makeTmpRoot("codex-norunning");
    cleanup.push(project);
    const fake = new NoRunningSignalCodex(project);
    const result = await runCodexTask({
      ctx: ctx(project),
      resolved: resolved({ stableRounds: 2, idleTimeoutMs: 50, pollIntervalMs: 1 }),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.ok).toBe(false);
    expect(result.endReason).toBe("idle_timeout");
    expect(result.keptInstance).toBe(true);
  });

  it("CDP 断线 → cdp_disconnected 硬失败", async () => {
    const project = await makeTmpRoot("codex-disconnect");
    cleanup.push(project);
    const fake = new DisconnectedCodex(project);
    const result = await runCodexTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.endReason).toBe("cdp_disconnected");
    expect(result.hardFailure).toBe(true);
  });

  it("缺少 AUMID 时拒绝以 msix-com 启动", async () => {
    const project = await makeTmpRoot("codex-noaumid");
    cleanup.push(project);
    const fake = new FakeCodex(project);
    const result = await runCodexTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake, { discover: () => ({ path: process.execPath, source: "explicit" as const }) }),
    });
    expect(result.ok).toBe(false);
    expect(result.endReason).toBe("setup_failed");
    expect(result.error).toMatch(/AUMID/);
    expect(fake.sent).toBe(0);
  });

  it("返修轮复用同一会话，发送 feedback 指令（引用修复计划）", async () => {
    const project = await makeTmpRoot("codex-rework");
    cleanup.push(project);
    const fake = new FakeCodex(project, true);
    fake.boundProject = path.basename(project);
    const feedback = "【上一轮验收失败】\n修复/优化计划文档：`.zcode/plans/codex-fix-r1.md`（请按计划修复）";
    const result = await runCodexTask({
      ctx: ctx(project, {
        round: 1,
        feedback,
        resume: { kind: "rework", sendMessage: true, boundProjectPath: project, model: "GPT-5.6 Sol", permissionMode: "完全访问" },
      }),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.ok).toBe(true);
    expect(fake.sent).toBe(1);
    expect(fake.conversation).toContain("codex-fix-r1.md");
    // 返修轮不点「新对话」
    expect(fake.clicked).not.toContain("newChat");
  });
});

describe("Codex fix-loop 分支", () => {
  it("验收失败时自动生成项目内 codex-fix-r1.md 并写进修复指令（决策 11/12）", async () => {
    const { TaskManager } = await import("../../src/tasks/task-manager.js");
    const { TaskStore } = await import("../../src/tasks/task-store.js");
    const { DataHome } = await import("../../src/config/store.js");
    const { AgentAdapterRegistry } = await import("../../src/agents/registry.js");
    const { AcceptanceEngine } = await import("../../src/verify/acceptance.js");
    const { makeBuildCtx } = await import("../../src/mcp/context.js");
    const { normPath } = await import("../../src/util/path.js");
    const { CodexGuiAdapter } = await import("../../src/agents/codex/adapter.js");

    // 项目：有 package.json 的 test 脚本（首轮失败，返修后通过）
    const project = await makeTmpRoot("codex-fixloop-proj");
    cleanup.push(project);
    fs.writeFileSync(
      path.join(project, "package.json"),
      JSON.stringify({ name: "p", version: "1.0.0", scripts: { test: "node -e \"process.exit(require('fs').existsSync('ok.txt')?0:1)\"" } }),
    );
    await gitInitAndCommit(project);

    const home = await makeTmpRoot("codex-fixloop-home");
    cleanup.push(home);
    const dh = new DataHome(home, logger, { codex: resolved().profile });
    await dh.init();
    const store = new TaskStore(home, logger);
    const reg = new AgentAdapterRegistry(() => dh.loadProfiles(), logger);

    const fake = new FakeCodex(project, true);
    fake.boundProject = path.basename(project);
    // 仅在第 2 轮（返修后）写入 ok.txt，使第 1 轮验收失败、第 2 轮通过
    const originalSend = fake.sendMessage.bind(fake);
    fake.sendMessage = async () => {
      const before = fake.sent;
      await originalSend();
      if (before >= 1) fs.writeFileSync(path.join(project, "ok.txt"), "fixed");
    };

    const adapter = new CodexGuiAdapter("codex");
    adapter.run = (c, r, o) =>
      runCodexTask({
        ctx: c,
        resolved: r,
        opts: o,
        logFile: path.join(c.taskDir, `agent-${c.round}.log`),
        deps: depsFor(fake),
      });
    reg.register("codex", adapter);

    const engine = new AcceptanceEngine(store, logger);
    const manager = new TaskManager(
      store,
      dh,
      reg,
      engine,
      logger,
      makeBuildCtx({ store, dataHome: dh }),
    );
    await manager.initialize(1);

    const meta = await manager.submit({
      projectPath: normPath(project),
      displayPath: project,
      agentId: "codex",
      task: "创建 ok.txt",
      model: "GPT-5.6 Sol",
      reasoningLevel: "high",
      autoVerify: true,
      autoFixRounds: 5,
      taskTimeoutMs: 20_000,
    });

    // 等待终态
    const deadline = Date.now() + 40_000;
    let final = await manager.getMeta(meta.taskId);
    while (final && !["succeeded", "failed", "needs_attention", "cancelled", "interrupted"].includes(final.status)) {
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 200));
      final = await manager.getMeta(meta.taskId);
    }
    expect(final?.status).toBe("succeeded");

    // 第 1 轮失败后应生成 codex-fix-r1.md，且第 2 轮指令引用它
    const planPath = path.join(project, ".zcode", "plans", "codex-fix-r1.md");
    expect(fs.existsSync(planPath)).toBe(true);
    expect(fs.readFileSync(planPath, "utf8")).toContain("第 1 轮返修");
    expect(fake.conversation).toContain("codex-fix-r1.md");
    expect(fake.sent).toBe(2); // 初始 + 返修
  }, 60_000);
});
