import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: native }),
}));
// unit project 以 isolate:false 共享模块注册表：若其他测试文件（zcode-core 等）先静态 import
// 了 dialog.js，其顶层 promisify(execFile) 绑定的就是真实 execFile，本文件的 vi.mock 无法回改，
// 测试会真实外呼 powershell.exe/osascript（曾按分片调度概率性失败）。
// 清模块缓存后动态 import，确保 dialog.ts 恒在本 mock 下求值（与文件执行顺序无关）；
// 用完再清一次，避免把 mock 绑定的 dialog.js 留在共享缓存里影响后续文件。
let listOwnedDialogs: typeof import("../../src/agents/zcode/dialog.js").listOwnedDialogs;
let selectZcodeFolder: typeof import("../../src/agents/zcode/dialog.js").selectZcodeFolder;
beforeAll(async () => {
  vi.resetModules();
  const mod = await import("../../src/agents/zcode/dialog.js");
  listOwnedDialogs = mod.listOwnedDialogs;
  selectZcodeFolder = mod.selectZcodeFolder;
});
afterAll(() => {
  vi.resetModules();
});
beforeEach(() => {
  native.mockReset();
});

describe("ZCode native dialog budgets and unknown baselines", () => {
  it("passes the probe budget and abort signal to Windows", async () => {
    native.mockResolvedValue({ stdout: "123,456" });
    const controller = new AbortController();
    expect(
      await listOwnedDialogs([7], {
        platform: "win32",
        timeoutMs: 1234,
        signal: controller.signal,
      }),
    ).toEqual(["123", "456"]);
    expect(native.mock.calls[0]?.[2]).toMatchObject({
      timeout: 1234,
      signal: controller.signal,
      windowsHide: true,
      env: { TIANSHU_ZCODE_PIDS: "7" },
    });
  });
  it("does not convert macOS permission failure or malformed output to an empty baseline", async () => {
    native.mockRejectedValueOnce(new Error("not authorized -1743"));
    await expect(listOwnedDialogs([], { platform: "darwin" })).rejects.toThrow(/1743/);
    native.mockResolvedValueOnce({ stdout: "" });
    await expect(listOwnedDialogs([], { platform: "darwin" })).rejects.toThrow(/基线未知/);
  });
  it("refuses an existing macOS sheet without executing input", async () => {
    expect(
      await selectZcodeFolder("/tmp/project", [], ["sheet-count:1"], { platform: "darwin" }),
    ).toMatchObject({ ok: false });
    expect(native).not.toHaveBeenCalled();
  });
  it("uses a shared absolute Windows deadline for all native phases", async () => {
    native.mockResolvedValue({ stdout: "" });
    const started = Date.now();
    expect(
      await selectZcodeFolder("D:/测试 项目", [7], ["123"], { platform: "win32", timeoutMs: 4321 }),
    ).toMatchObject({ ok: true });
    const options = native.mock.calls[0]?.[2];
    expect(options.timeout).toBe(4321);
    expect(Number(options.env.TIANSHU_DIALOG_DEADLINE)).toBeGreaterThanOrEqual(started + 4321);
    expect(native.mock.calls[0]?.[1][2]).not.toMatch(/AddSeconds/);
  });
  it("preserves abort errors rather than treating cancelled input as retryable selection", async () => {
    const controller = new AbortController();
    controller.abort();
    native.mockRejectedValue(new Error("aborted"));
    await expect(
      selectZcodeFolder("D:/project", [7], [], { platform: "win32", signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
  });
});
