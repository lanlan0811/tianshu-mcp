import { afterEach, describe, expect, it, vi } from "vitest";
import { ZcodeBudget } from "../../src/agents/zcode/recovery.js";
import { GuiProfileSchema } from "../../src/config/schema.js";
import { execFile } from "node:child_process";

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
afterEach(() => vi.useRealTimers());

describe("ZCode shared recovery budget", () => {
  it("provides backward-compatible defaults and rejects invalid settings", () => {
    expect(GuiProfileSchema.parse({})).toMatchObject({
      setupRecoveryTimeoutMs: 120000,
      dialogProbeTimeoutMs: 30000,
      dialogOperationTimeoutMs: 60000,
      setupRecoveryMaxRetries: 2,
    });
    expect(() => GuiProfileSchema.parse({ setupRecoveryTimeoutMs: 0 })).toThrow();
    expect(() => GuiProfileSchema.parse({ setupRecoveryMaxRetries: -1 })).toThrow();
  });
  it("caps each operation by remaining setup time and never resets the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onProgress = vi.fn();
    const budget = new ZcodeBudget(1000, 120, { logger, onProgress }, 30);
    const caps: number[] = [];
    await budget.run(async (_signal, cap) => {
      caps.push(cap);
    }, 50);
    await vi.advanceTimersByTimeAsync(80);
    const pending = budget
      .run(async (_signal, cap) => {
        caps.push(cap);
        return new Promise(() => {});
      }, 60)
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(40);
    expect(await pending).toMatchObject({ reason: "setup_recovery" });
    expect(caps).toEqual([50, 40]);
    expect(onProgress.mock.calls.length).toBeGreaterThan(1);
    budget.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("enforces task timeout before the longer setup deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const budget = new ZcodeBudget(20, 120, { logger }, 10);
    const pending = budget.run(async () => new Promise(() => {})).catch((e) => e);
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({ reason: "task_timeout" });
    budget.close();
  });
  it("stops the setup timer after binding but still enforces task timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const budget = new ZcodeBudget(100, 20, { logger }, 10);
    budget.finishSetup();
    await vi.advanceTimersByTimeAsync(30);
    expect(await budget.run(async () => "ok")).toBe("ok");
    const pending = budget.run(async () => new Promise(() => {}), 10).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ reason: "operation_timeout" });
    budget.close();
  });
  it("aborts an actual helper process and waits for its close event", async () => {
    const controller = new AbortController();
    const budget = new ZcodeBudget(
      Date.now() + 10000,
      Date.now() + 10000,
      { logger, signal: controller.signal },
      1000,
    );
    let closed!: Promise<void>;
    const pending = budget
      .run(
        async (signal) =>
          new Promise<void>((resolve, reject) => {
            const child = execFile(
              process.execPath,
              ["-e", "setInterval(()=>{},1000)"],
              { windowsHide: true, signal },
              (error) => (error ? reject(error) : resolve()),
            );
            closed = new Promise((done) => child.once("close", () => done()));
            child.once("spawn", () => controller.abort());
          }),
      )
      .catch((e) => e);
    expect(await pending).toMatchObject({ reason: "aborted" });
    await closed;
    budget.close();
  });
});
