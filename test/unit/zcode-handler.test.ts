import { afterAll, describe, expect, it } from "vitest";
import { makeHandlers, type AppContext } from "../../src/mcp/handlers.js";
import { BUILTIN_PROFILES } from "../../src/agents/builtin.js";
import { Logger } from "../../src/util/log.js";
import { makeTmpRoot, rmrf } from "../test-utils.js";

const logger = new Logger(null, "error");
let projectPath = "";
const submissions: Record<string, unknown>[] = [];

afterAll(async () => {
  if (projectPath) await rmrf(projectPath);
});

function handlers() {
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
  };
  const dataHome = {
    registerProject: async () => ({ created: false }),
    projectByPath: async () => ({ record: undefined }),
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
      store: {},
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
});
