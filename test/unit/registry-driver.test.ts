/**
 * 单元测试：driver 驱动的 adapter 选择（开发计划 §4.2/§4.3）。
 */
import { describe, it, expect } from "vitest";
import { AgentAdapterRegistry } from "../../src/agents/registry.js";
import { CliAdapter } from "../../src/agents/cli.js";
import { CodexGuiAdapter } from "../../src/agents/codex/adapter.js";
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
    const p = profile({ driver: "gui", adapter: "codex-gui", gui: {} });
    expect(p.driver).toBe("gui");
    expect(p.gui?.cdpPort).toBe(9222);
    expect(p.gui?.cdpPortAuto).toBe(true);
    expect(p.gui?.windowMode).toBe("reuse");
    expect(p.gui?.stableRounds).toBe(12);
    expect(p.gui?.idleTimeoutMs).toBe(10 * 60_000);
    expect(p.gui?.cdpSendTimeoutMs).toBe(15_000);
    expect(p.gui?.progressIntervalMs).toBe(30_000);
    expect(p.gui?.freshSession).toBe(true);
    expect(p.gui?.exeArgs).toEqual(["--remote-debugging-port=<port>"]);
  });

  it("gui 字段可覆盖", () => {
    const p = profile({ driver: "gui", adapter: "codex-gui", gui: { cdpPort: 9333, windowMode: "launch", stableRounds: 5, selectors: { chatInput: ".x" } } });
    expect(p.gui?.cdpPort).toBe(9333);
    expect(p.gui?.windowMode).toBe("launch");
    expect(p.gui?.stableRounds).toBe(5);
    expect(p.gui?.selectors.chatInput).toBe(".x");
  });

  it("driver=gui 但缺 adapter → fail-closed，且报错给出可照做的迁移路径", () => {
    let issue: string | undefined;
    try {
      AgentProfileSchema.parse({ displayName: "custom", driver: "gui" });
    } catch (e) {
      issue = (e as { issues?: { message: string }[] }).issues?.[0]?.message;
    }
    expect(issue, "driver=gui 缺 adapter 必须被 schema 拒绝").toBeTruthy();
    expect(issue).toContain("未指定 adapter");
    expect(issue).toContain("该默认已取消");
    // 迁移路径必须可照做：把可选 adapter 都列出来
    for (const a of ["codex-gui", "zcode-gui", "kimicode-gui", "opendesign-gui", "minimax-gui"]) {
      expect(issue).toContain(a);
    }
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
  it("gui.modeSwitch 默认 true，可覆盖", () => {
    expect(profile({ driver: "gui", adapter: "codex-gui", gui: {} }).gui?.modeSwitch).toBe(true);
    expect(profile({ driver: "gui", adapter: "codex-gui", gui: { modeSwitch: false } }).gui?.modeSwitch).toBe(false);
  });
});

describe("registry 按 driver 选择 adapter", () => {
  it("driver=gui + adapter=codex-gui → CodexGuiAdapter（具备 run 执行面）", async () => {
    const reg = new AgentAdapterRegistry(async () => ({ codex: profile({ driver: "gui", adapter: "codex-gui" }) }), silentLogger);
    await reg.resolve("codex");
    const a = reg.getAdapter("codex");
    expect(a).toBeInstanceOf(CodexGuiAdapter);
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
    p = profile({ driver: "gui", adapter: "codex-gui" });
    reg.invalidate("x");
    await reg.resolve("x", false);
    expect(reg.getAdapter("x")).toBeInstanceOf(CodexGuiAdapter);
  });
});

describe("CodexGuiAdapter 契约", () => {
  it("buildInvocation 明确报错（GUI 不走 spawn）", () => {
    const a = new CodexGuiAdapter("codex");
    expect(() => a.buildInvocation()).toThrow(/spawn/);
  });
});
