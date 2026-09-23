import { afterAll, describe, expect, it } from "vitest";
import { makeHandlers, type AppContext } from "../../src/mcp/handlers.js";
import { BUILTIN_PROFILES } from "../../src/agents/builtin.js";
import { Logger } from "../../src/util/log.js";
import { makeTmpRoot, rmrf } from "../test-utils.js";

const logger = new Logger(null, "error");
let projectPath = "";
const submissions: Record<string, unknown>[] = [];
const registerCalls: string[] = [];
/** projectByPath 调用计数：用于证明 run_task 不再做冗余的二次读取（issue #17） */
let projectByPathCalls = 0;

afterAll(async () => {
  if (projectPath) await rmrf(projectPath);
});

interface HandlerOpts {
  /** registerProject 抛错（模拟 projects.json 写盘失败） */
  registerThrows?: string;
  /** registerProject 返回值里 record.defaultAgentId */
  registerDefaultAgentId?: string;
  /** 若仍有人调用 projectByPath，返回与之**不同**的 defaultAgentId 以便暴露误用 */
  projectByPathDefaultAgentId?: string;
}

function handlers(metaOverride?: Record<string, unknown>, opts: HandlerOpts = {}) {
  const manager = {
    submit: async (input: Record<string, unknown>) => {
      submissions.push(input);
      const now = new Date().toISOString();
      return {
        ...input,
        taskId: `tsk_handler_${submissions.length}`,
        status: "queued",
        round: 0,
        roundsUsed: 0,
        createdAt: now,
        updatedAt: now,
      };
    },
    getMaxRunning: () => 1,
    // issue #15：run_task 未传幂等键时也会探测「同工作区未结束任务」用于重复派单提示
    activeTaskOfWorkspace: () => undefined,
    getMeta: async () =>
      metaOverride ? ({ taskId: "tsk_default", ...metaOverride } as never) : null,
  };
  const dataHome = {
    // 形状与真实 DataHome.registerProject 一致：{ hash, record }
    registerProject: async (p: string, defaultAgentId?: string) => {
      registerCalls.push(p);
      if (opts.registerThrows) throw new Error(opts.registerThrows);
      return {
        hash: "deadbeefdeadbeef",
        record: {
          path: p,
          displayPath: p,
          firstSeenAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          defaultAgentId: opts.registerDefaultAgentId ?? defaultAgentId,
        },
      };
    },
    projectByPath: async () => {
      projectByPathCalls += 1;
      return {
        record: opts.projectByPathDefaultAgentId
          ? { defaultAgentId: opts.projectByPathDefaultAgentId }
          : undefined,
      };
    },
    loadConfig: async () => ({}),
  };
  const registry = {
    resolve: async () => ({
      id: "zcode",
      displayName: "ZCode test",
      profile: BUILTIN_PROFILES.zcode,
      command: process.execPath,
      argsTemplate: [],
      ok: true,
      message: "test",
    }),
  };
  return makeHandlers(
    {
      manager,
      dataHome,
      registry,
      logger,
      store: { baselinePath: (id: string) => `/nonexistent/${id}/baseline.json` },
      engine: {},
    } as unknown as AppContext,
    { defaultAgentId: "codex", defaultAutoVerify: true, defaultAutoFixRounds: 0 },
  );
}

describe("ZCode run_task 参数与 profile 默认值", () => {
  it("拒绝 TraeWork 专属 mode，且不提交任务", async () => {
    projectPath ||= await makeTmpRoot("zcode-handler");
    submissions.length = 0;
    const result = await handlers().run_task({
      projectPath,
      agentId: "zcode",
      task: "开发",
      model: "DeepSeek/deepseek-flash",
      mode: "Code",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/ZCode 不支持 mode/);
    expect(submissions).toHaveLength(0);
  });

  it("缺少供应商/模型时拒绝，且不提交任务", async () => {
    projectPath ||= await makeTmpRoot("zcode-handler");
    submissions.length = 0;
    const result = await handlers().run_task({
      projectPath,
      agentId: "zcode",
      task: "开发",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/必须指定 model.*供应商\/模型/);
    expect(submissions).toHaveLength(0);
  });

  it("缺省采用 ZCode profile 的两轮自动返修，显式 0 仍优先", async () => {
    projectPath ||= await makeTmpRoot("zcode-handler");
    submissions.length = 0;
    const run = handlers().run_task;
    await run({
      projectPath,
      agentId: "zcode",
      task: "开发",
      model: "DeepSeek/deepseek-flash",
    });
    await run({
      projectPath,
      agentId: "zcode",
      task: "开发",
      model: "DeepSeek/deepseek-flash",
      autoFixRounds: 0,
      autoVerify: false,
    });
    expect(submissions[0]).toMatchObject({ autoVerify: true, autoFixRounds: 2 });
    expect(submissions[1]).toMatchObject({ autoVerify: false, autoFixRounds: 0 });
  });

  it("allowCreateProject 是 ZCode 专用参数：其他 agent 显式传入即拒绝，不提交任务", async () => {
    projectPath ||= await makeTmpRoot("zcode-handler");
    submissions.length = 0;
    const result = await handlers().run_task({
      projectPath,
      agentId: "codex",
      task: "开发",
      allowCreateProject: false,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/allowCreateProject/);
    expect(result.content[0]?.text).toMatch(/ZCode/);
    expect(submissions).toHaveLength(0);
  });

  it("ZCode 接受 allowCreateProject 并随任务元数据提交", async () => {
    projectPath ||= await makeTmpRoot("zcode-handler");
    submissions.length = 0;
    await handlers().run_task({
      projectPath,
      agentId: "zcode",
      task: "开发",
      model: "DeepSeek/deepseek-flash",
      allowCreateProject: false,
    });
    expect(submissions[0]).toMatchObject({ allowCreateProject: false });
  });

  it("省略 allowCreateProject 时不写入策略，保留既有自动导入语义", async () => {
    projectPath ||= await makeTmpRoot("zcode-handler");
    submissions.length = 0;
    await handlers().run_task({
      projectPath,
      agentId: "zcode",
      task: "开发",
      model: "DeepSeek/deepseek-flash",
    });
    expect(submissions[0]?.allowCreateProject).toBeUndefined();
  });
});

describe("run_task 的项目登记（issue #17：消费返回值 + 失败不派单）", () => {
  it("登记失败即返回 isError 且不提交任务，不走半状态", async () => {
    projectPath ||= await makeTmpRoot("zcode-handler");
    submissions.length = 0;
    registerCalls.length = 0;
    const result = await handlers(undefined, {
      registerThrows: "EPERM: 写 projects.json 失败",
    }).run_task({
      projectPath,
      task: "开发",
      model: "DeepSeek/deepseek-flash",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/项目登记失败/);
    expect(result.content[0]?.text).toMatch(/EPERM/);
    expect(result.content[0]?.text).toMatch(/未派单/);
    expect(submissions).toHaveLength(0);
    // 登记确实被尝试过（证明失败发生在登记这一步，而非更早被别的校验挡下）
    expect(registerCalls).toHaveLength(1);
  });

  it("登记返回值被真正消费：finalAgentId 取自 registerProject，且不再二次读取 projectByPath", async () => {
    projectPath ||= await makeTmpRoot("zcode-handler");
    submissions.length = 0;
    registerCalls.length = 0;
    projectByPathCalls = 0;
    // registerProject 说该项目默认 agent 是 zcode；若代码仍走 projectByPath 二次读取，
    // 它会拿到 codex（不同值）——因此断言提交的 agentId 就能证伪「二次读取仍在」。
    const result = await handlers(undefined, {
      registerDefaultAgentId: "zcode",
      projectByPathDefaultAgentId: "codex",
    }).run_task({
      projectPath,
      task: "开发",
      model: "DeepSeek/deepseek-flash",
    });
    expect(result.isError).toBeFalsy();
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.agentId).toBe("zcode");
    // 关键断言：冗余的二次读取必须已移除
    expect(projectByPathCalls).toBe(0);
  });
});

describe("run_task 无项目模式（省略 projectPath）", () => {
  it("ZCode 省略 projectPath 时以 default 模式提交，且强制关闭验收与返修", async () => {
    submissions.length = 0;
    registerCalls.length = 0;
    const result = await handlers().run_task({
      agentId: "zcode",
      task: "做点事",
      model: "DeepSeek/deepseek-flash",
    });
    expect(result.isError).toBeFalsy();
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      workspaceMode: "default",
      autoVerify: false,
      autoFixRounds: 0,
      projectPath: "",
    });
    // 无项目模式不得做项目登记。
    expect(registerCalls).toHaveLength(0);
  });

  it("省略 projectPath 时缺省 agent 解析出的 agent 不支持无项目即报错，且在排队之前", async () => {
    submissions.length = 0;
    const result = await handlers().run_task({ agentId: "codex", task: "做点事" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/projectPath/);
    expect(submissions).toHaveLength(0);
  });

  it("无项目模式显式开启验收即报错（没有目录可验）", async () => {
    submissions.length = 0;
    const result = await handlers().run_task({
      agentId: "zcode",
      task: "做点事",
      model: "DeepSeek/deepseek-flash",
      autoVerify: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/projectPath/);
    expect(submissions).toHaveLength(0);
  });

  it("无项目模式显式要求自动返修即报错", async () => {
    submissions.length = 0;
    const result = await handlers().run_task({
      agentId: "zcode",
      task: "做点事",
      model: "DeepSeek/deepseek-flash",
      autoFixRounds: 2,
    });
    expect(result.isError).toBe(true);
    expect(submissions).toHaveLength(0);
  });

  it("无项目模式接受冗余的 allowCreateProject，不改变行为", async () => {
    submissions.length = 0;
    const result = await handlers().run_task({
      agentId: "zcode",
      task: "做点事",
      model: "DeepSeek/deepseek-flash",
      allowCreateProject: false,
    });
    expect(result.isError).toBeFalsy();
    expect(submissions[0]).toMatchObject({ workspaceMode: "default" });
  });

  it("空字符串 projectPath 不视为无项目模式，仍按有项目模式拒绝", async () => {
    submissions.length = 0;
    const result = await handlers().run_task({
      projectPath: "",
      agentId: "zcode",
      task: "做点事",
      model: "DeepSeek/deepseek-flash",
    });
    expect(result.isError).toBe(true);
    expect(submissions).toHaveLength(0);
  });

  it("相对路径 projectPath 同样不视为无项目模式", async () => {
    submissions.length = 0;
    const result = await handlers().run_task({
      projectPath: "relative/dir",
      agentId: "zcode",
      task: "做点事",
      model: "DeepSeek/deepseek-flash",
    });
    expect(result.isError).toBe(true);
    expect(submissions).toHaveLength(0);
  });
});

describe("无项目任务的验收入口语义", () => {
  const defaultMeta = { workspaceMode: "default", projectPath: "", displayPath: "" };

  it("verify_task 对无项目任务返回 not_applicable，不从 cwd 推导目录", async () => {
    const result = await handlers(defaultMeta).verify_task({ taskId: "tsk_default" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/no_project/);
  });

  it("get_task_report 对无项目任务说明不产生项目验收报告", async () => {
    const result = await handlers(defaultMeta).get_task_report({ taskId: "tsk_default" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/no_project/);
  });

  it("有项目任务不落入 no_project 分流", async () => {
    const result = await handlers({
      workspaceMode: "project",
      projectPath: "D:/nonexistent-project",
      displayPath: "D:/nonexistent-project",
    }).verify_task({ taskId: "tsk_project" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toMatch(/no_project/);
  });
});
