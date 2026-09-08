/**
 * 单元测试：driver 驱动的 adapter 选择 + model 参数贯通（开发计划 §4.2/§4.3）。
 */
import { describe, it, expect } from "vitest";
import { AgentAdapterRegistry } from "../../src/agents/registry.js";
import { CliAdapter } from "../../src/agents/cli.js";
import { TraeworkGuiAdapter } from "../../src/agents/traework/adapter.js";
import { AgentProfileSchema, RunTaskParamsSchema } from "../../src/config/schema.js";
import type { AgentProfile } from "../../src/config/schema.js";
import { Logger } from "../../src/util/log.js";

const silentLogger = new Logger(null, "error");

function profile(over: Record<string, unknown> = {}): AgentProfile {
  return AgentProfileSchema.parse({
    displayName: "x",
    command: process.execPath,
    ...over,
  });
}

describe("AgentProfileSchema driver/gui 字段", () => {
  it("driver 默认 spawn", () => {
    expect(profile().driver).toBe("spawn");
  });

  it("driver=gui 时 gui 配置可解析并带默认值", () => {
    const p = profile({ driver: "gui", gui: {} });
    expect(p.driver).toBe("gui");
    expect(p.gui?.cdpPort).toBe(9222);
    expect(p.gui?.cdpPortAuto).toBe(true);
    expect(p.gui?.windowMode).toBe("reuse");
    expect(p.gui?.stableRounds).toBe(12);
    expect(p.gui?.freshSession).toBe(true);
    expect(p.gui?.exeArgs).toEqual(["--remote-debugging-port=<port>"]);
  });

  it("gui 字段可覆盖", () => {
    const p = profile({ driver: "gui", gui: { cdpPort: 9333, windowMode: "launch", stableRounds: 5, selectors: { chatInput: ".x" } } });
    expect(p.gui?.cdpPort).toBe(9333);
    expect(p.gui?.windowMode).toBe("launch");
    expect(p.gui?.stableRounds).toBe(5);
    expect(p.gui?.selectors.chatInput).toBe(".x");
  });
});

describe("RunTaskParamsSchema model / mode 字段", () => {
  it("model 可选且可为空", () => {
    const r = RunTaskParamsSchema.parse({ projectPath: "/tmp", task: "t" });
    expect(r.model).toBeUndefined();
  });
  it("model 透传", () => {
    const r = RunTaskParamsSchema.parse({ projectPath: "/tmp", task: "t", model: "GLM-5.3" });
    expect(r.model).toBe("GLM-5.3");
  });
  it("mode 可选，合法值透传", () => {
    expect(RunTaskParamsSchema.parse({ projectPath: "/tmp", task: "t" }).mode).toBeUndefined();
    for (const m of ["Work", "Code", "Design"] as const) {
      expect(RunTaskParamsSchema.parse({ projectPath: "/tmp", task: "t", mode: m }).mode).toBe(m);
    }
  });
  it("mode 非法值被拒绝", () => {
    expect(() => RunTaskParamsSchema.parse({ projectPath: "/tmp", task: "t", mode: "Agent" })).toThrow();
    expect(() => RunTaskParamsSchema.parse({ projectPath: "/tmp", task: "t", mode: "work" })).toThrow();
  });
  it("gui.modeSwitch 默认 true，可覆盖", () => {
    expect(profile({ driver: "gui", gui: {} }).gui?.modeSwitch).toBe(true);
    expect(profile({ driver: "gui", gui: { modeSwitch: false } }).gui?.modeSwitch).toBe(false);
  });
});

describe("registry 按 driver 选择 adapter", () => {
  it("driver=gui → TraeworkGuiAdapter（具备 run 执行面）", async () => {
    const reg = new AgentAdapterRegistry(async () => ({ traework: profile({ driver: "gui", gui: {} }) }), silentLogger);
    await reg.resolve("traework");
    const a = reg.getAdapter("traework");
    expect(a).toBeInstanceOf(TraeworkGuiAdapter);
    expect(typeof a!.run).toBe("function");
  });

  it("driver=spawn → CliAdapter（无 run 执行面）", async () => {
    const reg = new AgentAdapterRegistry(async () => ({ codex: profile({ driver: "spawn" }) }), silentLogger);
    await reg.resolve("codex");
    const a = reg.getAdapter("codex");
    expect(a).toBeInstanceOf(CliAdapter);
    expect(a!.run).toBeUndefined();
  });

  it("driver 变更后热切换 adapter 类型", async () => {
    let p: AgentProfile = profile({ driver: "spawn" });
    const reg = new AgentAdapterRegistry(async () => ({ x: p }), silentLogger);
    await reg.resolve("x");
    expect(reg.getAdapter("x")).toBeInstanceOf(CliAdapter);
    p = profile({ driver: "gui", gui: {} });
    reg.invalidate("x");
    await reg.resolve("x", false);
    expect(reg.getAdapter("x")).toBeInstanceOf(TraeworkGuiAdapter);
  });
});

describe("TraeworkGuiAdapter", () => {
  it("buildInvocation 明确报错（GUI 不走 spawn）", () => {
    const a = new TraeworkGuiAdapter("traework");
    expect(() => a.buildInvocation({} as never, {} as never)).toThrow(/driver=gui/);
  });

  it("isInfraError 识别 CDP/可执行缺失类错误", async () => {
    const { isInfraError } = await import("../../src/agents/traework/adapter.js");
    expect(isInfraError("CDP_UNAVAILABLE: 无法连接端口 9222")).toBe(true);
    expect(isInfraError("未找到 TraeWork 可执行文件")).toBe(true);
    expect(isInfraError("ECONNREFUSED")).toBe(true);
    expect(isInfraError("模型切换失败：下拉中未找到")).toBe(false);
  });
});
