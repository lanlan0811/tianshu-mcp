import { describe, expect, it } from "vitest";
import { GuiProfileSchema, ZCODE_SETUP_DEFAULTS } from "../../src/config/schema.js";
import {
  parseProcessRows,
  probeKimicodePort,
  remoteDebugPort,
  rootKimicodeProcesses,
  type CdpJsonFetcher,
} from "../../src/agents/kimicode/instance.js";
import {
  KimicodeBudget,
  KimicodeBudgetError,
  KimicodeSetupPause,
  permissionError,
  transientSetupError,
  workspaceTriggerBudgetMs,
  kimicodeBudgetFor,
} from "../../src/agents/kimicode/recovery.js";
import { Logger } from "../../src/util/log.js";

/**
 * 真机 UA（2026-09-20，Kimi Code 1.0.2）：/json/version 的 User-Agent 含 `kimi-code-app/`，
 * 这是与「别的 Electron 应用同样开了 CDP」区分的唯一产品标志。
 */
const KIMICODE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) kimi-code-app/1.0.2 Chrome/150.0.7871.114 Electron/43.1.1 Safari/537.36";
const OTHER_ELECTRON_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SomeOtherApp/3.2.1 Chrome/150.0.7871.114 Electron/43.1.1 Safari/537.36";

const MAIN_TARGET = {
  type: "page",
  title: "Kimi Code",
  url: "app://renderer/",
  webSocketDebuggerUrl: "ws://127.0.0.1/main",
};
const OVERLAY_TARGET = {
  type: "page",
  title: "Kimi Browser Overlay",
  url: "app://renderer/browser-overlay.html",
  webSocketDebuggerUrl: "ws://127.0.0.1/overlay",
};
const SCREENSHOT_TARGET = {
  type: "page",
  title: "Screenshot",
  url: "app://renderer/screenshot/index.html?display=1",
  webSocketDebuggerUrl: "ws://127.0.0.1/screenshot",
};

/** 注入假的 /json/version 与 /json 响应，单测不触达真实端口 */
function fetcher(version: unknown, targets: unknown): CdpJsonFetcher {
  return async (_port, pathname) => {
    const payload = pathname === "/json/version" ? version : targets;
    if (payload instanceof Error) throw payload;
    return payload;
  };
}

describe("Kimi Code 进程枚举", () => {
  it("解析 pid/可执行路径/命令行的制表符行，忽略畸形行", () => {
    const rows = parseProcessRows(
      ["4321\tD:\\Kimi-Code\\Kimi Code.exe\t\"D:\\Kimi-Code\\Kimi Code.exe\" --remote-debugging-port=9666", "not-a-row", ""].join(
        "\r\n",
      ),
    );
    expect(rows).toEqual([
      {
        pid: 4321,
        executable: "D:\\Kimi-Code\\Kimi Code.exe",
        commandLine:
          '"D:\\Kimi-Code\\Kimi Code.exe" --remote-debugging-port=9666',
      },
    ]);
  });

  it("只保留根进程：Electron 渲染/工具子进程不参与端口归属判定", () => {
    const rows = [
      { pid: 10, commandLine: "Kimi Code.exe --remote-debugging-port=9666" },
      { pid: 11, commandLine: "Kimi Code.exe --type=renderer --remote-debugging-port=9666" },
      { pid: 12, commandLine: "Kimi Code.exe --type=crashpad-handler" },
      { pid: 13, commandLine: "Kimi Code.exe --no-warnings tools/cua-helper/helper.js" },
      { pid: 14, commandLine: "Kimi Code.exe --type=utility --utility-sub-type=network" },
    ];
    expect(rootKimicodeProcesses(rows).map((row) => row.pid)).toEqual([10]);
  });

  it("CDP 端口支持等号与空格两种写法；没有端口返回 null", () => {
    expect(remoteDebugPort("Kimi Code.exe --remote-debugging-port=9666")).toBe(9666);
    expect(remoteDebugPort("Kimi Code.exe --remote-debugging-port 9667")).toBe(9667);
    expect(remoteDebugPort("Kimi Code.exe")).toBeNull();
  });
});

describe("Kimi Code 端口产品校验", () => {
  it("UA 含 kimi-code-app/ 时通过，并收敛到主窗口（排除 overlay 与截图窗口）", async () => {
    const result = await probeKimicodePort(
      9666,
      1_500,
      fetcher(
        { Browser: "Chrome/150.0.7871.114", "User-Agent": KIMICODE_UA },
        [SCREENSHOT_TARGET, OVERLAY_TARGET, MAIN_TARGET],
      ),
    );
    expect(result).toEqual({
      ready: true,
      version: "Chrome/150.0.7871.114",
      title: "Kimi Code",
      url: "app://renderer/",
    });
  });

  it("会话页 URL 也算主窗口（草稿页 ↔ 会话页只换 URL 不换 target）", async () => {
    const result = await probeKimicodePort(
      9666,
      1_500,
      fetcher(
        { "User-Agent": KIMICODE_UA },
        [{ ...MAIN_TARGET, url: "app://renderer/sessions/abc-123" }],
      ),
    );
    expect(result.ready).toBe(true);
    expect(result.url).toBe("app://renderer/sessions/abc-123");
  });

  it("别的 Electron 应用（UA 与页面都不属于本产品）一律拒绝", async () => {
    const result = await probeKimicodePort(
      9666,
      1_500,
      fetcher(
        { "User-Agent": OTHER_ELECTRON_UA },
        [{ type: "page", title: "Some App", url: "https://example.com/", webSocketDebuggerUrl: "ws://x" }],
      ),
    );
    expect(result).toEqual({ ready: false });
  });

  it("UA 缺失但页面 URL 以 app://renderer/ 开头时按 URL 兜底通过", async () => {
    const result = await probeKimicodePort(9666, 1_500, fetcher({}, [MAIN_TARGET]));
    expect(result).toMatchObject({ ready: true, title: "Kimi Code", url: "app://renderer/" });
  });

  it("两个端点都不可达时视为非本产品端口", async () => {
    const result = await probeKimicodePort(
      9666,
      1_500,
      fetcher(new Error("ECONNREFUSED"), new Error("ECONNREFUSED")),
    );
    expect(result).toEqual({ ready: false });
  });
});

describe("Kimi Code 预算与新增配置项", () => {
  const logger = new Logger(null, "error");

  it("workspaceTriggerTimeoutMs 是可选项（不改既有键），缺省回落到 15_000", () => {
    const profile = GuiProfileSchema.parse({});
    expect("workspaceTriggerTimeoutMs" in profile).toBe(false);
    expect(workspaceTriggerBudgetMs(profile)).toBe(ZCODE_SETUP_DEFAULTS.workspaceTriggerTimeoutMs);
    expect(workspaceTriggerBudgetMs(GuiProfileSchema.parse({ workspaceTriggerTimeoutMs: 300 }))).toBe(
      300,
    );
  });

  it("初始化预算取自 gui.setupRecoveryTimeoutMs，超时抛 setup_recovery", () => {
    const budget = kimicodeBudgetFor(
      GuiProfileSchema.parse({ setupRecoveryTimeoutMs: 60_000 }),
      Date.now() + 60_000,
      { logger, onProgress: () => {} },
    );
    budget.finishSetup();
    budget.close();
    const expired = new KimicodeBudget(
      Date.now() - 1,
      Date.now() + 60_000,
      { logger, onProgress: () => {} },
      60_000,
    );
    expect(() => expired.check()).toThrow(KimicodeBudgetError);
    expect(() => expired.check()).toThrow(/Kimi Code .*: task_timeout/);
    expired.close();
  });

  it("错误分类：瞬态 setup 错误与权限错误各自可判别", () => {
    expect(transientSetupError(new KimicodeBudgetError("setup_recovery", "准备项目连接"))).toBe(true);
    expect(transientSetupError(new KimicodeBudgetError("task_timeout", "准备项目连接"))).toBe(false);
    expect(transientSetupError(Object.assign(new Error("x"), { killed: true }))).toBe(true);
    expect(permissionError(new Error("ACCESSIBILITY_PERMISSION_REQUIRED"))).toBe(true);
    expect(new KimicodeSetupPause("请确认工作区").needsPermission).toBe(false);
  });
});