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
import { CdpDisconnectedError, CdpUnavailableError } from "../../src/agents/zcode/cdp.js";
import type { ZcodeProjectItem } from "../../src/agents/zcode/project.js";

const logger = new Logger(null, "error");
const cleanup: string[] = [];
afterAll(async () => {
  for (const dir of cleanup) await rmrf(dir);
});

function resolved(guiOverrides: Record<string, unknown> = {}): ResolvedAgent {
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
      ...guiOverrides,
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
  dismissedMenus = 0;
  projectClicks = 0;
  projectClickTarget = "";
  constructor(
    private projectPath: string,
    private question?: string,
    private badProvider = false,
  ) {}
  async connect() {}
  disconnect() {}
  async dismissMenus() {
    this.dismissedMenus++;
  }
  async exists(key: string) {
    return key === "chatInput";
  }
  async click(key: string) {
    return ["newTask", "projectTrigger", "modelTrigger", "permissionTrigger"].includes(key);
  }
  async projects(): Promise<ZcodeProjectItem[]> {
    return [{ name: path.basename(this.projectPath), path: this.projectPath, id: "p1" }];
  }
  async clickProject() {
    this.projectClicks++;
    this.projectClickTarget = "menuitemcheckbox";
    return true;
  }
  async boundProjectPath() {
    return this.projectPath;
  }
  async workspaceBinding() {
    return {
      triggerText: path.basename(this.projectPath),
      projectPath: await this.boundProjectPath(),
    };
  }
  async clickExact(key: string, value: string) {
    if (key === "providerOption") {
      if (this.badProvider) return { clicked: false, count: 0 };
      this.provider = value;
    }
    if (key === "modelOption") {
      if (this.badProvider) return { clicked: false, count: 0 };
      this.model = value;
    }
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
  async sessionForMarker(marker: string) {
    return this.sent && this.conversation.includes(marker)
      ? { id: "session-1", title: "任务一" }
      : undefined;
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
  async answerQuestion(answer: string) {
    return { answered: false, count: 0, available: [answer] };
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

class ResumeQuestionZcode extends FakeZcode {
  answers: string[] = [];
  answered = false;
  override async poll() {
    if (!this.answered)
      return {
        stopVisible: false,
        loading: false,
        activeTool: false,
        question: "done.txt 应写入哪个值？",
        assistantText: "",
        inputEnabled: false,
        sendEnabled: false,
      };
    return super.poll();
  }
  override async answerQuestion(answer: string) {
    this.answers.push(answer);
    this.answered = true;
    this.sent = 1;
    return { answered: true, count: 1, available: ["PASS", "CANCEL"] };
  }
}

class AmbiguousQuestionAnswerZcode extends ResumeQuestionZcode {
  override async answerQuestion() {
    return { answered: false, count: 0, available: ["PASS", "CANCEL"] };
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

class DelayedSendAcceptanceZcode extends FakeZcode {
  checks = 0;
  override async sendMessage() {
    this.sent++;
    this.conversation = this.typed;
  }
  override async inputText() {
    this.checks++;
    return this.checks < 25 ? this.typed : "";
  }
  override async sessionForMarker(marker: string) {
    return this.checks >= 25 ? super.sessionForMarker(marker) : undefined;
  }
  override async poll() {
    if (this.checks < 25)
      return {
        stopVisible: false,
        loading: false,
        activeTool: false,
        assistantText: "",
        inputEnabled: true,
        sendEnabled: false,
      };
    return super.poll();
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
  override async sessionForMarker() {
    return undefined;
  }
}

class DelayedSessionRegistrationZcode extends FakeZcode {
  sessionChecks = 0;
  override async session() {
    return {};
  }
  override async sessions() {
    if (!this.sent) return [];
    this.sessionChecks++;
    return this.sessionChecks >= 25 ? [{ id: "delayed-session", title: "延迟任务" }] : [];
  }
  override async sessionForMarker() {
    return undefined;
  }
}

class StaleActiveSessionZcode extends FakeZcode {
  override async session() {
    return { id: "previous-session", title: "上一任务" };
  }
  override async sessions() {
    return this.sent
      ? [
          { id: "new-session", title: "当前任务" },
          { id: "previous-session", title: "上一任务" },
        ]
      : [{ id: "previous-session", title: "上一任务" }];
  }
  override async sessionForMarker() {
    return undefined;
  }
}

class AmbiguousProjectZcode extends FakeZcode {
  override async projects() {
    const name = path.basename(await this.boundProjectPath());
    return [{ name }, { name }];
  }
}

class WrongBoundProjectZcode extends FakeZcode {
  override async boundProjectPath() {
    return path.join(await super.boundProjectPath(), "wrong");
  }
  override async workspaceBinding() {
    return {
      triggerText: path.basename(await super.boundProjectPath()),
      projectPath: await this.boundProjectPath(),
    };
  }
}

class OptionFailureZcode extends FakeZcode {
  constructor(
    projectPath: string,
    private readonly failedKey: string,
  ) {
    super(projectPath);
  }
  override async clickExact(key: string, value: string) {
    if (key === this.failedKey) return { clicked: false, count: 0, available: ["other"] };
    return super.clickExact(key, value);
  }
}

class FamilyFallbackZcode extends FakeZcode {
  modelAttempts = 0;
  override async clickExact(key: string, value: string) {
    if (key === "modelOption") {
      this.modelAttempts++;
      if (!this.provider) return { clicked: false, count: 0, available: [] };
    }
    return super.clickExact(key, value);
  }
}

class DiagnosticOptionFailureZcode extends FakeZcode {
  override async clickExact(key: string, value: string) {
    if (key === "modelOption")
      return {
        clicked: false,
        count: 0,
        available: [],
        testids: ["chat-model-select-item-custom:builtin%3Abigmodel:OTHER"],
      };
    if (key === "providerOption")
      return {
        clicked: false,
        count: 0,
        available: [],
        testids: ["chat-model-select-group-family:bigmodel"],
      };
    return super.clickExact(key, value);
  }
}

class DelayedProjectBindingZcode extends FakeZcode {
  bindingReads = 0;
  override async workspaceBinding() {
    this.bindingReads++;
    if (this.projectClicks < 2) return { triggerText: "选择项目", projectPath: "" };
    return super.workspaceBinding();
  }
}

class ModelMismatchZcode extends FakeZcode {
  override async selection() {
    return { display: "deepseek-flash", internal: "another-model" };
  }
}

class PermissionMismatchZcode extends FakeZcode {
  override async text(key: string) {
    if (key === "permissionValue") return "受限访问";
    return super.text(key);
  }
}

class PresetControlsZcode extends FakeZcode {
  constructor(projectPath: string) {
    super(projectPath);
    this.model = "deepseek-flash";
    this.permission = "完全访问";
  }
  override async selection() {
    return { display: "DeepSeek/deepseek-flash", internal: "deepseek-flash" };
  }
  override async click(key: string) {
    if (["modelTrigger", "permissionTrigger"].includes(key)) return false;
    return super.click(key);
  }
}

class InputMismatchZcode extends FakeZcode {
  override async inputText() {
    return "输入被 ZCode 截断";
  }
}

class DisconnectedZcode extends FakeZcode {
  override async poll() {
    if (this.sent) throw new CdpDisconnectedError("test disconnect");
    return super.poll();
  }
}

class BusyStartupZcode extends FakeZcode {
  override async exists(_key: string): Promise<boolean> {
    throw new CdpUnavailableError("renderer busy");
  }
}

class QuestionOnlyStartupZcode extends FakeZcode {
  override async exists(key: string) {
    return key === "questionCard";
  }
}

class IdleZcode extends FakeZcode {
  override async poll() {
    if (!this.sent) return super.poll();
    return {
      stopVisible: false,
      loading: false,
      activeTool: false,
      assistantText: "回复保持静止但输入框尚未就绪",
      inputEnabled: false,
      sendEnabled: false,
    };
  }
}

class RunningForeverZcode extends FakeZcode {
  override async poll() {
    if (!this.sent) return super.poll();
    return {
      stopVisible: true,
      loading: false,
      activeTool: false,
      assistantText: "仍在运行",
      inputEnabled: false,
      sendEnabled: false,
    };
  }
}

class MissingProjectZcode extends FakeZcode {
  folderSelected = false;
  chooseFolderClicked = false;
  override async click(key: string) {
    if (key === "addProject") return true;
    return super.click(key);
  }
  override async clickExact(key: string, value: string) {
    if (key === "chooseFolder" && ["打开文件夹", "Open Folder"].includes(value)) {
      this.chooseFolderClicked = true;
      return { clicked: true, count: 1, available: [value] };
    }
    return super.clickExact(key, value);
  }
  override async projects() {
    return [];
  }
  override async boundProjectPath() {
    return this.folderSelected ? super.boundProjectPath() : "";
  }
}

class SwallowedAddProjectZcode extends MissingProjectZcode {
  addProjectClicks = 0;
  override async click(key: string) {
    if (key === "addProject") {
      this.addProjectClicks++;
      return true;
    }
    return super.click(key);
  }
  override async clickExact(key: string, value: string) {
    if (key === "chooseFolder" && this.addProjectClicks < 2)
      return { clicked: false, count: 0, available: [] };
    return super.clickExact(key, value);
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
    listProcesses: () => [{ pid: 1, commandLine: "ZCode.exe --remote-debugging-port=9333" }],
    createClient: () => fake as never,
    sleep: async () => {},
  };
}

describe("ZCode 假 CDP 单轮", () => {
  it("continue_task 在原会话问题卡片精确选项并不发送普通聊天消息", async () => {
    const project = await makeTmpRoot("zcode-resume-question");
    cleanup.push(project);
    const fake = new ResumeQuestionZcode(project);
    const resumed = {
      ...ctx(project),
      resume: {
        kind: "continue" as const,
        message: "PASS",
        sendMessage: true,
        sessionId: "session-1",
        sessionTitle: "任务一",
        boundProjectPath: project,
        provider: "DeepSeek",
        model: "deepseek-flash",
        permissionMode: "完全访问",
      },
    };
    const result = await runZcodeTask({
      ctx: resumed,
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.ok).toBe(true);
    expect(result.session?.id).toBe("session-1");
    expect(fake.answers).toEqual(["PASS"]);
    expect(fake.typed).toBe("");
  });

  it("continue_task 续答无唯一选项时保留 needs_user 现场", async () => {
    const project = await makeTmpRoot("zcode-resume-question-mismatch");
    cleanup.push(project);
    const fake = new AmbiguousQuestionAnswerZcode(project);
    const resumed = {
      ...ctx(project),
      resume: {
        kind: "continue" as const,
        message: "UNKNOWN",
        sendMessage: true,
        sessionId: "session-1",
        sessionTitle: "任务一",
      },
    };
    const result = await runZcodeTask({
      ctx: resumed,
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.endReason).toBe("needs_user");
    expect(result.needsUserKind).toBe("agent_question");
    expect(result.pendingQuestion).toMatch(/PASS、CANCEL/);
    expect(fake.sent).toBe(0);
  });

  it("AskUserQuestion 等待页可作为稳定连接入口", async () => {
    const project = await makeTmpRoot("zcode-startup-question");
    cleanup.push(project);
    const fake = new QuestionOnlyStartupZcode(project);
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.ok).toBe(true);
    expect(fake.sent).toBe(1);
  });
  it("已列出的 ZCode 页面暂时繁忙时重建连接并等待输入框稳定", async () => {
    const project = await makeTmpRoot("zcode-startup-busy");
    cleanup.push(project);
    const busy = new BusyStartupZcode(project);
    const stable = new FakeZcode(project);
    let clientsCreated = 0;
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: {
        ...depsFor(stable),
        createClient: () => (++clientsCreated === 1 ? busy : stable) as never,
      },
    });
    expect(result.ok).toBe(true);
    expect(clientsCreated).toBe(2);
    expect(stable.sent).toBe(1);
  });
  it("模型直选成功时不点击供应商，项目与完全访问回读后仅发送一次", async () => {
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
    expect(fake.provider).toBe("");
    expect(fake.model).toBe("deepseek-flash");
    expect(fake.permission).toBe("完全访问");
    expect(fake.projectClickTarget).toBe("menuitemcheckbox");
    expect(result.session?.id).toBe("session-1");
  });
  it("模型直选为 0 时展开 family/provider 分组后重试成功", async () => {
    const project = await makeTmpRoot("zcode-family-fallback");
    cleanup.push(project);
    const fake = new FamilyFallbackZcode(project);
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.ok).toBe(true);
    expect(fake.provider).toBe("DeepSeek");
    expect(fake.model).toBe("deepseek-flash");
    expect(fake.modelAttempts).toBeGreaterThan(15);
  });
  it("目标项目不存在时只操作新出现的 ZCode 文件夹对话框并回读绑定路径", async () => {
    const project = await makeTmpRoot("zcode-folder-import");
    cleanup.push(project);
    const fake = new MissingProjectZcode(project);
    let selectedPath = "";
    let baseline: string[] = [];
    let clientsCreated = 0;
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: {
        ...depsFor(fake),
        createClient: () => {
          clientsCreated++;
          return fake as never;
        },
        listDialogs: async () => ["existing-dialog"],
        selectFolder: async (folder, _pids, before) => {
          selectedPath = folder;
          baseline = before;
          fake.folderSelected = true;
          return { ok: true, message: "selected" };
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(fake.chooseFolderClicked).toBe(true);
    expect(selectedPath).toBe(project);
    expect(baseline).toEqual(["existing-dialog"]);
    expect(clientsCreated).toBe(2);
    expect(fake.sent).toBe(1);
  });
  it("添加项目首次点击被吞时收起菜单并在第二轮成功", async () => {
    const project = await makeTmpRoot("zcode-folder-import-swallowed");
    cleanup.push(project);
    const fake = new SwallowedAddProjectZcode(project);
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: {
        ...depsFor(fake),
        selectFolder: async () => {
          fake.folderSelected = true;
          return { ok: true, message: "selected" };
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(fake.addProjectClicks).toBe(2);
    expect(fake.dismissedMenus).toBeGreaterThanOrEqual(3);
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
  it("同名项目缺少路径时停止且不发送", async () => {
    const project = await makeTmpRoot("zcode-project-ambiguous");
    cleanup.push(project);
    const fake = new AmbiguousProjectZcode(project);
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.endReason).toBe("project_ambiguous");
    expect(fake.sent).toBe(0);
  });
  it("项目绑定完整路径回读不一致时停止且不发送", async () => {
    const project = await makeTmpRoot("zcode-project-mismatch");
    cleanup.push(project);
    const fake = new WrongBoundProjectZcode(project);
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.endReason).toBe("project_mismatch");
    expect(fake.sent).toBe(0);
  });
  it("项目绑定首轮回读失败时重新打开菜单并幂等重试成功", async () => {
    const project = await makeTmpRoot("zcode-project-binding-retry");
    cleanup.push(project);
    const fake = new DelayedProjectBindingZcode(project);
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.ok).toBe(true);
    expect(fake.projectClicks).toBe(2);
    expect(fake.bindingReads).toBeGreaterThan(30);
  });
  it("模型不存在或同名歧义时停止且不发送", async () => {
    const project = await makeTmpRoot("zcode-model-missing");
    cleanup.push(project);
    const fake = new OptionFailureZcode(project, "modelOption");
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.endReason).toBe("model_unavailable");
    expect(fake.sent).toBe(0);
  });
  it("模型直选与供应商兜底均失败时返回可见 testid 诊断", async () => {
    const project = await makeTmpRoot("zcode-model-diagnostic");
    cleanup.push(project);
    const fake = new DiagnosticOptionFailureZcode(project);
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.endReason).toBe("model_unavailable");
    expect(result.error).toContain("chat-model-select-item-custom:");
    expect(result.error).toContain("chat-model-select-group-family:");
    expect(fake.sent).toBe(0);
  });
  it("模型显示值或内部 ID 回读不一致时停止且不发送", async () => {
    const project = await makeTmpRoot("zcode-model-mismatch");
    cleanup.push(project);
    const fake = new ModelMismatchZcode(project);
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.endReason).toBe("model_mismatch");
    expect(fake.sent).toBe(0);
  });
  it("完全访问选项不存在时停止且不发送", async () => {
    const project = await makeTmpRoot("zcode-permission-missing");
    cleanup.push(project);
    const fake = new OptionFailureZcode(project, "permissionOption");
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.endReason).toBe("permission_unknown");
    expect(fake.sent).toBe(0);
  });
  it("完全访问回读不一致时停止且不发送", async () => {
    const project = await makeTmpRoot("zcode-permission-mismatch");
    cleanup.push(project);
    const fake = new PermissionMismatchZcode(project);
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.endReason).toBe("permission_unknown");
    expect(fake.sent).toBe(0);
  });
  it("模型与完全访问已精确匹配时复用回读值且不重复打开菜单", async () => {
    const project = await makeTmpRoot("zcode-preset-controls");
    cleanup.push(project);
    const fake = new PresetControlsZcode(project);
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.ok).toBe(true);
    expect(fake.sent).toBe(1);
  });
  it("输入框回读不一致时不发送", async () => {
    const project = await makeTmpRoot("zcode-input-mismatch");
    cleanup.push(project);
    const fake = new InputMismatchZcode(project);
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.endReason).toBe("input_mismatch");
    expect(fake.sent).toBe(0);
  });
  it("macOS Accessibility 缺失时暂停且不发送", async () => {
    const project = await makeTmpRoot("zcode-system-permission");
    cleanup.push(project);
    const fake = new MissingProjectZcode(project);
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: {
        ...depsFor(fake),
        listDialogs: async () => ["sheet-count:0"],
        selectFolder: async () => ({
          ok: false,
          needsPermission: true,
          message: "ACCESSIBILITY_PERMISSION_REQUIRED",
        }),
      },
    });
    expect(result.needsUserKind).toBe("system_permission");
    expect(result.pendingQuestion).toMatch(/Accessibility/);
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
  it("ZCode 延迟接受消息时在扩展观察窗内取得会话且不重复发送", async () => {
    const project = await makeTmpRoot("zcode-send-delayed");
    cleanup.push(project);
    const fake = new DelayedSendAcceptanceZcode(project);
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.ok).toBe(true);
    expect(result.session?.id).toBe("session-1");
    expect(fake.checks).toBeGreaterThanOrEqual(25);
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
  it("发送状态已变化但新会话延迟登记时继续观察且不重复发送", async () => {
    const project = await makeTmpRoot("zcode-session-delayed");
    cleanup.push(project);
    const fake = new DelayedSessionRegistrationZcode(project);
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.ok).toBe(true);
    expect(result.session?.id).toBe("delayed-session");
    expect(fake.sessionChecks).toBeGreaterThanOrEqual(25);
    expect(fake.sent).toBe(1);
  });
  it("新建任务期间旧会话面板仍可见时只记录发送后新增会话", async () => {
    const project = await makeTmpRoot("zcode-session-stale-pane");
    cleanup.push(project);
    const fake = new StaleActiveSessionZcode(project);
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.ok).toBe(true);
    expect(result.session?.id).toBe("new-session");
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
  it("CDP 断开时 fail-closed 并保留实例", async () => {
    const project = await makeTmpRoot("zcode-cdp-disconnect");
    cleanup.push(project);
    const fake = new DisconnectedZcode(project);
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.endReason).toBe("cdp_disconnected");
    expect(result.keptInstance).toBe(true);
    expect(fake.sent).toBe(1);
  });
  it("静态回复且 composer 未就绪达到阈值时收敛为空闲超时", async () => {
    const project = await makeTmpRoot("zcode-idle-timeout");
    cleanup.push(project);
    const fake = new IdleZcode(project);
    const result = await runZcodeTask({
      ctx: ctx(project),
      resolved: resolved({ idleTimeoutMs: 0 }),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: depsFor(fake),
    });
    expect(result.endReason).toBe("idle_timeout");
    expect(result.keptInstance).toBe(true);
  });
  it("任务总时限到达时停止 MCP 等待并保留实例", async () => {
    const project = await makeTmpRoot("zcode-task-timeout");
    cleanup.push(project);
    const fake = new RunningForeverZcode(project);
    const short = { ...ctx(project), taskTimeoutMs: 2 };
    const result = await runZcodeTask({
      ctx: short,
      resolved: resolved(),
      opts: opts(),
      logFile: path.join(project, "agent.log"),
      deps: {
        ...depsFor(fake),
        sleep: async (ms) => {
          if (ms <= 1) await new Promise((resolve) => setTimeout(resolve, 3));
        },
      },
    });
    expect(result.endReason).toBe("task_timeout");
    expect(result.timeout).toBe(true);
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

class EnvironmentPauseAdapter extends ZcodeGuiAdapter {
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
        needsUserKind: "close_existing_instance",
        pendingQuestion: "请关闭旧实例",
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

  it("环境处理确认恢复原任务，但确认文本不发送给模型", async () => {
    const project = await makeTmpRoot("zcode-confirm-project");
    cleanup.push(project);
    fs.writeFileSync(path.join(project, "README.md"), "x");
    await gitInitAndCommit(project);
    const home = await makeTmpRoot("zcode-confirm-home");
    cleanup.push(home);
    const data = new DataHome(home, logger, { zcode: resolved().profile });
    await data.init();
    const store = new TaskStore(home, logger);
    const registry = new AgentAdapterRegistry(() => data.loadProfiles(), logger);
    const adapter = new EnvironmentPauseAdapter("zcode");
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
      task: "原始开发任务",
      model: "DeepSeek/deepseek-flash",
      autoVerify: false,
      autoFixRounds: 2,
      taskTimeoutMs: 10_000,
    });
    for (let i = 0; i < 100 && (await manager.getMeta(meta.taskId))?.status !== "needs_user"; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await manager.continueTask(meta.taskId, "已关闭旧实例")).found).toBe(true);
    for (let i = 0; i < 100 && (await manager.getMeta(meta.taskId))?.status !== "succeeded"; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(adapter.calls[1]?.resume).toMatchObject({
      kind: "continue",
      message: "已关闭旧实例",
      sendMessage: false,
    });
    expect(adapter.calls[1]?.task).toBe("原始开发任务");
    await manager.shutdownInterrupt();
  });
});
