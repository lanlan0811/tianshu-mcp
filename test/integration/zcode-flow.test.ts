import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { runZcodeTask, type ZcodeRunDeps } from "../../src/agents/zcode/run.js";
import { ZcodeGuiAdapter } from "../../src/agents/zcode/adapter.js";
import type {
  AgentRunOptions,
  AgentRunResult,
  ResolvedAgent,
  TaskContext,
} from "../../src/agents/adapter.js";
import { AgentProfileSchema } from "../../src/config/schema.js";
import { makeTmpRoot, rmrf, gitInitAndCommit } from "../test-utils.js";
import { Logger } from "../../src/util/log.js";
import { DataHome } from "../../src/config/store.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { AgentAdapterRegistry } from "../../src/agents/registry.js";
import { AcceptanceEngine } from "../../src/verify/acceptance.js";
import { TaskManager } from "../../src/tasks/task-manager.js";
import { makeBuildCtx } from "../../src/mcp/context.js";
import { normPath } from "../../src/util/path.js";

const logger = new Logger(null, "error");
const cleanup: string[] = [];
afterAll(async () => {
  for (const dir of cleanup) await rmrf(dir);
});

function resolved(): ResolvedAgent {
  const profile = AgentProfileSchema.parse({
    displayName: "ZCode test",
    driver: "gui",
    adapter: "zcode-gui",
    status: "ready",
    command: process.execPath,
    gui: {
      pollIntervalMs: 1,
      stableRounds: 2,
      idleTimeoutMs: 1000,
      progressIntervalMs: 1,
      defaultPermissionMode: "完全访问",
    },
  });
  return {
    id: "zcode",
    displayName: "ZCode test",
    profile,
    command: process.execPath,
    argsTemplate: [],
    ok: true,
    message: "test",
  };
}

class FakeZcode {
  sent = 0;
  typed = "";
  conversation = "";
  provider = "";
  model = "";
  permission = "";
  polls = 0;
  constructor(
    private projectPath: string,
    private question?: string,
    private badProvider = false,
  ) {}
  async connect() {}
  disconnect() {}
  async exists() {
    return false;
  }
  async click(key: string) {
    return ["newTask", "projectTrigger", "modelTrigger", "permissionTrigger"].includes(key);
  }
  async projects() {
    return [{ name: path.basename(this.projectPath), path: this.projectPath, id: "p1" }];
  }
  async clickProject() {
    return true;
  }
  async boundProjectPath() {
    return this.projectPath;
  }
  async clickExact(key: string, value: string) {
    if (key === "providerOption") {
      if (this.badProvider) return { clicked: false, count: 0 };
      this.provider = value;
    }
    if (key === "modelOption") this.model = value;
    if (key === "permissionOption") this.permission = value;
    return { clicked: true, count: 1 };
  }
  async text(key: string) {
    if (key === "modelValue") return this.model;
    if (key === "permissionValue") return this.permission;
    if (key === "chatInput") return this.typed;
    return "";
  }
  async selection() {
    return { display: this.model, internal: this.model };
  }
  async session() {
    return this.sent ? { id: "session-1", title: "任务一" } : {};
  }
  async sessions() {
    return this.sent ? [{ id: "session-1", title: "任务一" }] : [];
  }
  async selectSession() {
    return true;
  }
  async conversationText() {
    return this.conversation;
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
  }
  async poll() {
    if (!this.sent)
      return {
        stopVisible: false,
        loading: false,
        activeTool: false,
        assistantText: "",
        inputEnabled: true,
        sendEnabled: true,
      };
    this.polls++;
    return {
      stopVisible: this.polls === 1,
      loading: false,
      activeTool: false,
      question: this.question,
      assistantText: "开发完成",
      inputEnabled: true,
      sendEnabled: true,
    };
  }
}

class NoEvidenceZcode extends FakeZcode {
  override async sendMessage() {
    this.sent++;
  }
  override async poll() {
    return {
      stopVisible: false,
      loading: false,
      activeTool: false,
      assistantText: "",
      inputEnabled: true,
      sendEnabled: true,
    };
  }
}

class AmbiguousSessionZcode extends FakeZcode {
  override async session() {
    return {};
  }
  override async sessions() {
    return this.sent
      ? [
          { id: "session-a", title: "任务 A" },
          { id: "session-b", title: "任务 B" },
        ]
      : [];
  }
}

function ctx(projectPath: string): TaskContext {
  return {
    taskId: "tsk_zcode",
    projectPath,
    displayPath: projectPath,
    agentId: "zcode",
    task: "完成开发",
    model: "DeepSeek/deepseek-flash",
    round: 0,
    taskDir: path.join(projectPath, "task-data"),
    workDir: projectPath,
    taskTimeoutMs: 10_000,
  };
}
function opts(): AgentRunOptions {
  return { logger, onProgress: () => {} };
}
function depsFor(fake: FakeZcode): Partial<ZcodeRunDeps> {
  return {
    ensureInstance: async () => ({ ready: { port: 9333, pid: 1, title: "ZCode" } }),
    createClient: () => fake as never,
    sleep: async () => {},
  };
}

describe("ZCode 假 CDP 单轮", () => {
  it("项目、供应商、模型、完全访问回读成功后仅发送一次", async () => {
    const project = await makeTmpRoot("zcode-fake");
    cleanup.push(project);
    const fake = new FakeZcode(project);
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.ok).toBe(true);
    expect(fake.sent).toBe(1);
    expect(fake.provider).toBe("DeepSeek");
    expect(fake.model).toBe("deepseek-flash");
    expect(fake.permission).toBe("完全访问");
    expect(result.session?.id).toBe("session-1");
  });
  it("供应商不存在时不发送", async () => {
    const project = await makeTmpRoot("zcode-provider");
    cleanup.push(project);
    const fake = new FakeZcode(project, undefined, true);
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.ok).toBe(false);
    expect(result.endReason).toBe("model_unavailable");
    expect(fake.sent).toBe(0);
  });
  it("发送证据不完整时 fail-closed 且不重复发送", async () => {
    const project = await makeTmpRoot("zcode-send-evidence");
    cleanup.push(project);
    const fake = new NoEvidenceZcode(project);
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.endReason).toBe("send_unknown");
    expect(result.error).toMatch(/用户消息=false.*输入状态变化=false.*运行信号=false/);
    expect(fake.sent).toBe(1);
  });
  it("任务已发送但新会话无法唯一识别时保留现场且不重复发送", async () => {
    const project = await makeTmpRoot("zcode-session-ambiguous");
    cleanup.push(project);
    const fake = new AmbiguousSessionZcode(project);
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.endReason).toBe("session_lost");
    expect(result.error).toMatch(/无法唯一取得 ZCode 新会话 ID/);
    expect(result.keptInstance).toBe(true);
    expect(fake.sent).toBe(1);
  });
  it("模型提问返回 needs_user 和原会话", async () => {
    const project = await makeTmpRoot("zcode-question");
    cleanup.push(project);
    const fake = new FakeZcode(project, "请选择数据库");
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.needsUserKind).toBe("agent_question");
    expect(result.pendingQuestion).toBe("请选择数据库");
    expect(result.session?.id).toBe("session-1");
  });
  it("已有非 CDP 实例只请求用户关闭，不连接或终止", async () => {
    const project = await makeTmpRoot("zcode-existing");
    cleanup.push(project);
    let created = false;
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: {
        ensureInstance: async () => ({ needsClose: true }),
        createClient: () => {
          created = true;
          throw new Error("unexpected");
        },
        sleep: async () => {},
      },
    });
    expect(result.needsUserKind).toBe("close_existing_instance");
    expect(created).toBe(false);
    expect(result.keptInstance).toBe(true);
  });
});

class PausingAdapter extends ZcodeGuiAdapter {
  calls: TaskContext[] = [];
  override async run(
    ctx: TaskContext,
    _resolved: ResolvedAgent,
    _opts: AgentRunOptions,
  ): Promise<AgentRunResult> {
    this.calls.push(structuredClone(ctx));
    const common = {
      exitCode: 0,
      timeout: false,
      killed: false,
      durationMs: 1,
      logFile: path.join(ctx.taskDir, `agent-${ctx.round}.log`),
      keptInstance: true,
    };
    if (this.calls.length === 1)
      return {
        ok: false,
        ...common,
        needsUserKind: "agent_question",
        pendingQuestion: "选择 A 或 B",
        session: {
          id: "stable-session",
          title: "原任务",
          boundProjectPath: ctx.projectPath,
          provider: "DeepSeek",
          model: "deepseek-flash",
          permissionMode: "完全访问",
        },
      };
    return { ok: true, ...common };
  }
}

describe("needs_user → continue_task", () => {
  it("释放后复用同一任务和会话继续，回答只进入恢复上下文", async () => {
    const project = await makeTmpRoot("zcode-continue-project");
    cleanup.push(project);
    fs.writeFileSync(path.join(project, "README.md"), "x");
    await gitInitAndCommit(project);
    const home = await makeTmpRoot("zcode-continue-home");
    cleanup.push(home);
    const data = new DataHome(home, logger, { zcode: resolved().profile });
    await data.init();
    const store = new TaskStore(home, logger);
    const registry = new AgentAdapterRegistry(() => data.loadProfiles(), logger);
    const adapter = new PausingAdapter("zcode");
    registry.register("zcode", adapter);
    const manager = new TaskManager(
      store,
      data,
      registry,
      new AcceptanceEngine(store, logger),
      logger,
      makeBuildCtx({ store, dataHome: data }),
    );
    await manager.initialize(1);
    const meta = await manager.submit({
      projectPath: normPath(project),
      displayPath: project,
      agentId: "zcode",
      task: "开发",
      model: "DeepSeek/deepseek-flash",
      autoVerify: false,
      autoFixRounds: 2,
      taskTimeoutMs: 10_000,
    });
    const wait = async (status: string) => {
      for (let i = 0; i < 100; i++) {
        const m = await manager.getMeta(meta.taskId);
        if (m?.status === status) return m;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`未到 ${status}`);
    };
    const paused = await wait("needs_user");
    expect(paused.zcodeSessionId).toBe("stable-session");
    for (let i = 0; i < 100 && manager.activeCount !== 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(manager.activeCount).toBe(0);
    expect((await manager.continueTask(meta.taskId, "选择 A")).found).toBe(true);
    await wait("succeeded");
    expect(adapter.calls[1]?.resume).toMatchObject({
      kind: "continue",
      message: "选择 A",
      sendMessage: true,
      sessionId: "stable-session",
    });
    expect((await store.readEvents(meta.taskId)).map((event) => event.event)).toContain(
      "continued",
    );
    expect(await manager.continueTask(meta.taskId, "重复")).toMatchObject({ found: false });
  });
});
