/**
 * 单元测试：TraeWork 启动器安全逻辑（开发计划 §4.4 / §9）。
 * 重点覆盖「误杀用户实例」事故后的安全红线：只终止自建且命令行核对通过的进程。
 * 另含 issue #23 C3 的「端口未就绪诊断」。
 */
import { describe, it, expect, vi } from "vitest";
import { isPortFree, findFreePort, releaseInstance, diagnosePortFailure, type SpawnedInstance } from "../../src/agents/traework/launcher.js";

// diagnosePortFailure 在 win32 下会枚举进程：替换 exec 层为空结果，避免触达真实系统。
vi.mock("../../src/verify/exec.js", () => ({
  execFileAsync: async () => ({ status: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }),
}));

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function inst(over: Partial<SpawnedInstance> = {}): SpawnedInstance {
  return {
    pid: 4242,
    port: 9222,
    exePath: "D:\\TRAE Work CN\\TRAE SOLO CN.exe",
    commandLine: "D:\\TRAE Work CN\\TRAE SOLO CN.exe --remote-debugging-port=9222",
    ...over,
  };
}

describe("端口探测", () => {
  it("isPortFree 对已监听端口返回 false", async () => {
    const net = await import("node:net");
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    expect(await isPortFree(port)).toBe(false);
    await new Promise<void>((r) => srv.close(() => r()));
    expect(await isPortFree(port)).toBe(true);
  });

  it("findFreePort 从起点向后找空闲端口", async () => {
    const port = await findFreePort(39000, 50);
    expect(port).not.toBeNull();
    expect(port!).toBeGreaterThanOrEqual(39000);
  });

  it("range 为 0 时找不到端口", async () => {
    expect(await findFreePort(39000, 0)).toBeNull();
  });
});

describe("releaseInstance 安全红线", () => {
  it("pid 无效 → 不终止", async () => {
    const r = await releaseInstance(inst({ pid: -1 }), silentLogger, { alive: () => true });
    expect(r.released).toBe(false);
  });

  it("进程已退出 → 不终止", async () => {
    const kill = vi.fn();
    const r = await releaseInstance(inst(), silentLogger, { alive: () => false, kill });
    expect(r.released).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("读不到命令行 → 放弃终止（避免误杀）", async () => {
    const kill = vi.fn();
    const r = await releaseInstance(inst(), silentLogger, { alive: () => true, readCmd: () => null, kill });
    expect(r.released).toBe(false);
    expect(r.reason).toContain("放弃终止");
    expect(kill).not.toHaveBeenCalled();
  });

  it("命令行不含端口参数 → 放弃终止（用户实例）", async () => {
    const kill = vi.fn();
    const r = await releaseInstance(inst(), silentLogger, {
      alive: () => true,
      readCmd: () => "D:\\TRAE Work CN\\TRAE SOLO CN.exe", // 用户手动启动，无调试端口
      kill,
    });
    expect(r.released).toBe(false);
    expect(r.reason).toContain("命令行核对失败");
    expect(kill).not.toHaveBeenCalled();
  });

  it("命令行是别的程序 → 放弃终止", async () => {
    const kill = vi.fn();
    const r = await releaseInstance(inst(), silentLogger, {
      alive: () => true,
      readCmd: () => "C:\\Windows\\notepad.exe --remote-debugging-port=9222",
      kill,
    });
    expect(r.released).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("命令行完全吻合 → 允许终止", async () => {
    const kill = vi.fn();
    const r = await releaseInstance(inst(), silentLogger, {
      alive: () => true,
      readCmd: () => "D:\\TRAE Work CN\\TRAE SOLO CN.exe --remote-debugging-port=9222",
      kill,
    });
    expect(r.released).toBe(true);
    expect(kill).toHaveBeenCalledWith(4242);
  });

  it("端口不匹配（另一个自建实例）→ 放弃终止", async () => {
    const kill = vi.fn();
    const r = await releaseInstance(inst({ port: 9333 }), silentLogger, {
      alive: () => true,
      readCmd: () => "D:\\TRAE Work CN\\TRAE SOLO CN.exe --remote-debugging-port=9222",
      kill,
    });
    expect(r.released).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("diagnosePortFailure（issue #23 C3）", () => {
  it("子进程以 code=0 退出 → 提示单实例交接", async () => {
    const msg = await diagnosePortFailure(inst({ exit: { code: 0, signal: null } }), 9222, silentLogger);
    expect(msg).toContain("已退出");
    expect(msg).toContain("单实例锁");
    // 不得包含任何「终止既有实例」的动作语义
    expect(msg).not.toMatch(/已终止|taskkill/i);
  });

  it("子进程有非 0 退出码 → 只报告退出码，不误判单实例", async () => {
    const msg = await diagnosePortFailure(inst({ exit: { code: 1, signal: null } }), 9222, silentLogger);
    expect(msg).toContain("code=1");
    expect(msg).not.toContain("单实例锁");
  });

  it("未启动新实例（复用既有）→ 明确说明", async () => {
    const msg = await diagnosePortFailure(null, 9222, silentLogger);
    expect(msg).toContain("未由本模块启动新实例");
  });

  it("诊断串始终包含端口监听者枚举口径", async () => {
    const msg = await diagnosePortFailure(inst({ pid: process.pid }), 9222, silentLogger);
    expect(msg).toContain("--remote-debugging-port=9222");
  });
});
