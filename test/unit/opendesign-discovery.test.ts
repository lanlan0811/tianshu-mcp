import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_PROFILES } from "../../src/agents/builtin.js";
import {
  discoverOpenDesign,
  openDesignAppConfigPath,
  openDesignNamespaceRoot,
  orderedDrives,
  readInstallInfo,
  validExecutable,
  type OpenDesignInstallInfo,
} from "../../src/agents/opendesign/discovery.js";
import {
  classifyLauncherExit,
  devtoolsPortsFromOutput,
  listOpenDesignProcessesAsync,
  OPEN_DESIGN_ENV_DENYLIST,
  parseProcessRows,
  probeOpenDesignPort,
  remoteDebugPort,
  rootOpenDesignProcesses,
  sanitizedSpawnEnv,
  versionGateError,
  type CdpJsonFetcher,
} from "../../src/agents/opendesign/instance.js";
import { AgentProfileSchema } from "../../src/config/schema.js";

/** 宿主平台（少数断言必须按平台分支，见各用例注释） */
const isWin = process.platform === "win32";

/**
 * 真机 UA（2026-09-25，Open Design 0.24.1 / Electron 41.3.0）：
 * /json/version 的 User-Agent 含 `Electron/`，这是「本产品是 Electron 应用」的判据的一部分，
 * 产品页面判据另见 OPEN_DESIGN 页面标题/URL 规则。
 */
const OPEN_DESIGN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) open-design/0.24.1 Chrome/142.0.7444.175 Electron/41.3.0 Safari/537.36";
const OTHER_ELECTRON_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SomeOtherApp/3.2.1 Chrome/142.0.7444.175 Electron/41.3.0 Safari/537.36";

const MAIN_TARGET = {
  type: "page",
  title: "Open Design",
  url: "od://app/index.html",
  webSocketDebuggerUrl: "ws://127.0.0.1/main",
};
const OTHER_PAGE = {
  type: "page",
  title: "Some Other Window",
  url: "app://other/index.html",
  webSocketDebuggerUrl: "ws://127.0.0.1/other",
};

/** 注入假的 /json/version 与 /json 响应，单测不触达真实端口 */
function fetcher(version: unknown, targets: unknown): CdpJsonFetcher {
  return async (_port, pathname) => {
    const payload = pathname === "/json/version" ? version : targets;
    if (payload instanceof Error) throw payload;
    return payload;
  };
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-od-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响断言 */
  }
});

/**
 * win32 风格的路径拼装（目标平台是 win32 时的候选形态）。
 * 注意：这只是**字符串**，磁盘上的真实文件用宿主分隔符创建（见 makeProbe）。
 */
function win(...parts: string[]): string {
  return path.win32.join(...parts);
}

/**
 * 造一个最小可用的安装目录：exe + resources/open-design-config.json。
 *
 * **关键**：磁盘上用**宿主**分隔符创建（POSIX 上反斜杠不是分隔符，用 win32 拼会造出
 * 名字里带反斜杠的畸形文件）；而目标平台是 win32 时生产代码会产出 win32 风格路径，
 * 两者靠 `makeProbe()` 提供的注入式 stat/readFile 对齐——这样断言与宿主平台无关，
 * CI 的 ubuntu / macOS 腿也能验证 win32 分支。
 */
function makeInstall(
  relativeExe = path.join("Open Design", "Open Design.exe"),
  config: Record<string, unknown> | null = {
    appVersion: "0.24.1",
    namespace: "release-stable-win",
  },
): string {
  const exe = path.join(tmpRoot, relativeExe);
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, "stub");
  if (config) {
    const configPath = path.join(path.dirname(exe), "resources", "open-design-config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config));
  }
  return exe;
}

/**
 * 把「目标平台的候选路径」映射回磁盘上的真实路径：
 * 仅把分隔符统一成宿主分隔符即可（win32 → 宿主）。
 */
function toHostPath(p: string): string {
  return path.sep === "/" ? p.replace(/\\/g, "/") : p.replace(/\//g, "\\");
}

/**
 * 注入给 `discoverOpenDesign` 的探测原语：让 win32 目标路径在 POSIX 宿主上也能"存在"。
 * 只做只读映射，不写盘。
 */
function makeProbe(): { statFile: (p: string) => boolean } {
  return {
    statFile: (p: string) => {
      try {
        return fs.statSync(toHostPath(p)).isFile();
      } catch {
        return false;
      }
    },
  };
}

describe("Open Design 安装发现", () => {
  it("可执行名含空格时按完整名精确匹配，不做模糊包含", () => {
    const exe = makeInstall();
    expect(validExecutable(exe, "win32")).toBe(true);
    const wrong = win(path.dirname(exe), "Open Design Beta.exe");
    fs.writeFileSync(wrong, "stub");
    expect(validExecutable(wrong, "win32")).toBe(false);
    // macOS 形态：无 .exe 后缀
    expect(validExecutable(exe, "darwin")).toBe(false);
  });

  it("版本与命名空间从 resources/open-design-config.json 读取，不硬编码", () => {
    const exe = makeInstall("Open Design/Open Design.exe", {
      appVersion: "9.9.9",
      namespace: "beta-win",
    });
    const info = readInstallInfo(exe);
    expect(info).not.toBeNull();
    expect(info!.appVersion).toBe("9.9.9");
    expect(info!.namespace).toBe("beta-win");
    expect(info!.installDir).toBe(path.dirname(exe));
    expect(info!.resourcesDir).toBe(path.join(path.dirname(exe), "resources"));
  });

  it("配置缺失或不可解析时返回 null（探测不应因版本查询失败而中断）", () => {
    const noConfig = makeInstall("A/Open Design.exe", null);
    expect(readInstallInfo(noConfig)).toBeNull();
    const broken = makeInstall("B/Open Design.exe", { appVersion: "0.24.1" });
    fs.writeFileSync(
      path.join(path.dirname(broken), "resources", "open-design-config.json"),
      "{ 不是 json",
    );
    expect(readInstallInfo(broken)).toBeNull();
  });

  it("数据目录由 APPDATA + 命名空间推导；缺命名空间时不猜（返回 null）", () => {
    const info: Pick<OpenDesignInstallInfo, "namespace"> = { namespace: "release-stable-win" };
    const root = openDesignNamespaceRoot(info, { APPDATA: "C:\\Users\\x\\AppData\\Roaming" });
    // 实现按**宿主平台**取基目录：win32 用 APPDATA；darwin 用 HOME/Library/Application Support。
    // 断言因此必须按平台分支，否则在 CI 的 macOS 腿上必然失败（这正是长期红的原因之一）。
    const base = isWin
      ? "C:\\Users\\x\\AppData\\Roaming"
      : path.join(os.homedir(), "Library", "Application Support");
    expect(root).toBe(path.join(base, "Open Design", "namespaces", "release-stable-win"));
    expect(openDesignAppConfigPath(root)).toBe(path.join(root!, "data", "app-config.json"));
    expect(openDesignNamespaceRoot({ namespace: undefined }, { APPDATA: "C:\\x" })).toBeNull();
    expect(openDesignAppConfigPath(null)).toBeNull();
  });

  it("优先探测 preferredDrives 里的相对路径（D 盘安装），并回读版本", async () => {
    const exe = makeInstall();
    const candidate = await discoverOpenDesign(BUILTIN_PROFILES.opendesign!, {
      platform: "win32",
      driveRoots: { "D:": tmpRoot },
      fixedDrives: [],
      registryDirs: [],
      ...makeProbe(),
    });
    expect(candidate).not.toBeNull();
    expect(candidate!.source).toBe("fixed-drive");
    expect(candidate!.path).toBe(exe);
    expect(candidate!.version).toBe("0.24.1");
  });

  it("固定盘相对路径未命中时回退注册表 InstallLocation", async () => {
    const exe = makeInstall("Open Design/Open Design.exe");
    const registryDir = path.dirname(exe);
    const candidate = await discoverOpenDesign(BUILTIN_PROFILES.opendesign!, {
      platform: "win32",
      driveRoots: { "D:": win(tmpRoot, "not-there") },
      ...makeProbe(),
      fixedDrives: [],
      registryDirs: [registryDir],
    });
    expect(candidate?.source).toBe("registry");
    expect(candidate?.path).toBe(exe);
  });

  it("注册表脏数据（含同名但非可执行的目录）不会误判", async () => {
    const candidate = await discoverOpenDesign(BUILTIN_PROFILES.opendesign!, {
      platform: "win32",
      driveRoots: { "D:": win(tmpRoot, "nope") },
      ...makeProbe(),
      fixedDrives: [],
      registryDirs: [tmpRoot],
    });
    expect(candidate).toBeNull();
  });

  it("显式 gui.exePath 生效，且路径不存在时不再回退（显式即权威）", async () => {
    const exe = makeInstall("Opt/Open Design.exe");
    const profile = AgentProfileSchema.parse({
      driver: "gui",
      adapter: "opendesign-gui",
      gui: { exePath: exe },
    });
    const found = await discoverOpenDesign(profile, {
      platform: "win32",
      fixedDrives: [],
      ...makeProbe(),
    });
    expect(found?.source).toBe("explicit");

    const missing = AgentProfileSchema.parse({
      driver: "gui",
      adapter: "opendesign-gui",
      gui: { exePath: win(tmpRoot, "nope", "Open Design.exe") },
    });
    expect(
      await discoverOpenDesign(missing, { platform: "win32", fixedDrives: [], ...makeProbe() }),
    ).toBeNull();
  });

  it("preferredDrives 排序：配置的盘优先，其余盘按枚举顺序跟随", () => {
    expect(orderedDrives(["C:", "D:", "E:"], ["D:"])).toEqual(["D:", "C:", "E:"]);
    expect(orderedDrives(["C:", "D:"], ["Z:"])).toEqual(["C:", "D:"]);
  });

  it("**候选路径按目标平台拼 win32 分隔符**（不随宿主 path 变化）", async () => {
    // 这是 CI ubuntu/macos 腿失败的根因：platform 是注入参数，但候选路径曾用宿主 path.join，
    // 于是「生产用反斜杠」与「夹具用正斜杠」在非 Windows 上对不上。
    // 断言本身与宿主平台无关：只要目标平台是 win32，候选就必须是 `D:\...\Open Design.exe`。
    const exe = makeInstall();
    const profile = AgentProfileSchema.parse({
      driver: "gui",
      adapter: "opendesign-gui",
      executableDiscovery: {
        preferredDrives: ["D:"],
        relativePaths: ["Open Design/Open Design.exe"],
      },
    });
    const found = await discoverOpenDesign(profile, {
      platform: "win32",
      driveRoots: { "D:": tmpRoot },
      fixedDrives: [],
      registryDirs: [],
      ...makeProbe(),
    });
    expect(found).not.toBeNull();
    // win32 目标 → 路径必然含反斜杠，且不含正斜杠（宿主是 POSIX 时这一点最容易破）
    expect(found!.path).toContain("\\");
    expect(found!.path).not.toContain("/");
    expect(found!.path).toBe(exe);
    expect(found!.source).toBe("fixed-drive");
  });
});

describe("Open Design 进程枚举与产品校验", () => {
  it("解析 pid/可执行路径/命令行的制表符行，忽略畸形行", () => {
    const rows = parseProcessRows(
      [
        '19732\tD:\\Open Design\\Open Design.exe\t"D:\\Open Design\\Open Design.exe"',
        "not-a-row",
        "",
      ].join("\r\n"),
    );
    expect(rows).toEqual([
      {
        pid: 19732,
        executable: "D:\\Open Design\\Open Design.exe",
        commandLine: '"D:\\Open Design\\Open Design.exe"',
      },
    ]);
  });

  it("只保留桌面主进程：剔除 --type= 子进程与 sidecar 监督进程（实测形态）", () => {
    const rows = parseProcessRows(
      [
        // 1) 真·桌面主进程
        '19732\tD:\\Open Design\\Open Design.exe\t"D:\\Open Design\\Open Design.exe"',
        // 2) 渲染子进程
        '25668\tD:\\Open Design\\Open Design.exe\t"D:\\Open Design\\Open Design.exe" --type=renderer --user-data-dir="C:\\Users\\x\\AppData\\Roaming\\Open Design\\namespaces\\release-stable-win\\user-data"',
        // 3) crashpad
        '13012\tD:\\Open Design\\Open Design.exe\t"D:\\Open Design\\Open Design.exe" --type=crashpad-handler --annotation=_productName=Open Design',
        // 4) daemon sidecar 监督进程（真机实测）
        '20252\tD:\\Open Design\\Open Design.exe\t"D:\\Open Design\\Open Design.exe" "D:\\Open Design\\resources\\app\\prebundled\\daemon\\daemon-sidecar.mjs"',
        // 5) web sidecar 监督进程（真机实测）
        '1684\tD:\\Open Design\\Open Design.exe\t"D:\\Open Design\\Open Design.exe" "D:\\Open Design\\resources\\app\\node_modules\\@open-design\\sidecar\\dist\\supervisor.mjs" --od-stamp-app=web',
      ].join("\r\n"),
    );
    const roots = rootOpenDesignProcesses(rows);
    expect(rows).toHaveLength(5);
    expect(roots.map((r) => r.pid)).toEqual([19732]);
  });

  it("解析 argv 里的远程调试端口；无端口返回 null", () => {
    expect(remoteDebugPort('"Open Design.exe" --remote-debugging-port=9777')).toBe(9777);
    expect(remoteDebugPort('"Open Design.exe" --remote-debugging-port 9778')).toBe(9778);
    expect(remoteDebugPort('"Open Design.exe"')).toBeNull();
  });

  it("产品校验：UA 含 electron 且存在本产品页面才算就绪", async () => {
    const ok = await probeOpenDesignPort(
      9777,
      1_000,
      fetcher({ "User-Agent": OPEN_DESIGN_UA, Browser: "Electron/41.3.0" }, [MAIN_TARGET]),
    );
    expect(ok.ready).toBe(true);
    expect(ok.version).toBe("Electron/41.3.0");
    expect(ok.title).toBe("Open Design");
  });

  it("拒绝别的 Electron 应用：UA 不含 electron 或页面不是本产品", async () => {
    const notElectron = await probeOpenDesignPort(
      9777,
      1_000,
      fetcher({ "User-Agent": "SomeApp/1.0 Chrome/142" }, [MAIN_TARGET]),
    );
    expect(notElectron.ready).toBe(false);

    const otherApp = await probeOpenDesignPort(
      9777,
      1_000,
      fetcher({ "User-Agent": OTHER_ELECTRON_UA }, [OTHER_PAGE]),
    );
    expect(otherApp.ready).toBe(false);

    // 只有非 page 目标（如 worker）同样不算就绪
    const noPage = await probeOpenDesignPort(
      9777,
      1_000,
      fetcher({ "User-Agent": OPEN_DESIGN_UA }, [{ type: "service_worker", url: "od://sw.js" }]),
    );
    expect(noPage.ready).toBe(false);
  });

  it("端口无响应时判为未就绪而不是抛错", async () => {
    const res = await probeOpenDesignPort(9777, 500, fetcher(new Error("ECONNREFUSED"), []));
    expect(res.ready).toBe(false);
  });

  it("进程枚举在查询失败时返回空数组（不把异常抛进解析链）", async () => {
    // 端口/进程枚举依赖真实系统调用，这里只验证「平台不匹配时安全返回」
    const rows = await listOpenDesignProcessesAsync();
    expect(Array.isArray(rows)).toBe(true);
  });

  it("非 Windows 目标平台也按目标平台拼路径（不被宿主 path 影响）", async () => {
    // 回归：候选路径曾用宿主 path 拼，导致 CI 的 ubuntu / macos 腿失败（Windows 腿通过）
    const exeNoExt = makeInstall("Open Design/Open Design");
    const profile = AgentProfileSchema.parse({
      driver: "gui",
      adapter: "opendesign-gui",
      gui: { exePath: exeNoExt },
    });
    // 显式路径 + darwin 目标：可执行名须为无后缀的 `Open Design`
    const found = await discoverOpenDesign(profile, { platform: "darwin", fixedDrives: [] });
    expect(found?.source).toBe("explicit");
    expect(found?.path).toBe(exeNoExt);
    // linux 目标同样走 posix 分支，且不抛错
    const linux = await discoverOpenDesign(
      AgentProfileSchema.parse({ driver: "gui", adapter: "opendesign-gui" }),
      { platform: "linux", fixedDrives: [] },
    );
    expect(linux === null || typeof linux.path === "string").toBe(true);
  });
});

describe("Open Design 版本门禁", () => {
  const supported = { win32: ["0.24.1"] };

  it("已取证版本放行；容忍带前后缀的版本串", () => {
    expect(versionGateError(supported, "0.24.1", "win32")).toBeNull();
    expect(versionGateError(supported, "0.24.1 (stable)", "win32")).toBeNull();
  });

  it("**产品版本**判据：CDP 报的 Electron 版本不能用来比对产品版本", () => {
    // 回归：曾误用 /json/version 的 Browser（Electron/41.3.0）做门禁，导致真机全部派发被阻断
    expect(versionGateError(supported, "Electron/41.3.0", "win32")).toContain("版本不匹配");
    expect(versionGateError(supported, "41.3.0", "win32")).toContain("版本不匹配");
  });

  it("未取证版本 fail-closed 并回显实测版本与已支持清单", () => {
    const error = versionGateError(supported, "0.25.0", "win32");
    expect(error).toContain("0.25.0");
    expect(error).toContain("0.24.1");
  });

  it("未配置门禁或探测不到版本时不阻塞（只影响诊断完整性）", () => {
    expect(versionGateError(undefined, "1.2.3", "win32")).toBeNull();
    expect(versionGateError({}, "1.2.3", "win32")).toBeNull();
    expect(versionGateError(supported, undefined, "win32")).toBeNull();
    expect(versionGateError(supported, "0.24.1", "darwin")).toBeNull();
  });
});

describe("Open Design 启动器退出码分类", () => {
  it("0 = 单实例锁转交；9 = 实测的「应用自身启动失败」，两者都按「无法接管」处理", () => {
    expect(classifyLauncherExit(0)).toBe("handoff");
    expect(classifyLauncherExit(9)).toBe("needs-close");
    // 回归：首版只把 0 当转交，9 落到「硬失败抛错」分支，真机上表现为「启动失败」而非「请关闭旧实例」
    expect(classifyLauncherExit(9)).not.toBe("failed");
  });

  it("其他非零退出即真实启动失败（要带 stderr 尾部抛错）", () => {
    expect(classifyLauncherExit(1)).toBe("failed");
    expect(classifyLauncherExit(127)).toBe("failed");
    expect(classifyLauncherExit(null)).toBe("failed");
  });
});

describe("Open Design 启动环境净化与端口宣告", () => {
  it("净化掉会让启动器退化成 Node 模式的变量（真机关键修复）", () => {
    const env = sanitizedSpawnEnv({
      PATH: "C:\\Windows",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "--remote-debugging-port=9889",
      ELECTRON_ENABLE_LOGGING: "1",
      KEEP_ME: "yes",
    });
    // 回归：带 ELECTRON_RUN_AS_NODE=1 时启动器报
    // `bad option: --remote-debugging-port=9889`（退出码 9），应用完全起不来
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.ELECTRON_ENABLE_LOGGING).toBeUndefined();
    expect(env.KEEP_ME).toBe("yes");
    expect(env.PATH).toBe("C:\\Windows");
    for (const key of OPEN_DESIGN_ENV_DENYLIST) expect(env[key]).toBeUndefined();
  });

  it("净化不修改调用方 process.env（只产出副本）", () => {
    const before = process.env.ELECTRON_RUN_AS_NODE;
    sanitizedSpawnEnv();
    expect(process.env.ELECTRON_RUN_AS_NODE).toBe(before);
  });

  it("从启动器输出解析宣告的调试端口（0.0.0.0/localhost/IPv6 都要认）", () => {
    expect(
      devtoolsPortsFromOutput(
        "DevTools listening on ws://127.0.0.1:9889/devtools/browser/63dd8142-fb18-4081-972c-0c8ae8f0c902\n",
      ),
    ).toEqual([9889]);
    expect(
      devtoolsPortsFromOutput("DevTools listening on ws://localhost:9222/devtools/browser/x"),
    ).toEqual([9222]);
    expect(
      devtoolsPortsFromOutput("DevTools listening on ws://[::1]:9333/devtools/browser/x"),
    ).toEqual([9333]);
    // 多行/重复只保留唯一端口，并保持出现顺序
    expect(
      devtoolsPortsFromOutput(
        "noise\nDevTools listening on ws://127.0.0.1:7000/a\nDevTools listening on ws://127.0.0.1:7001/b\nDevTools listening on ws://127.0.0.1:7000/c\n",
      ),
    ).toEqual([7000, 7001]);
  });

  it("无宣告时返回空数组（不能把噪音解析成端口）", () => {
    expect(devtoolsPortsFromOutput("")).toEqual([]);
    expect(devtoolsPortsFromOutput("bad option: --headless")).toEqual([]);
    // 非 DevTools 行的 ws:// 端口不算
    expect(devtoolsPortsFromOutput("open ws://127.0.0.1:1234")).toEqual([]);
  });
});

describe("Open Design 内置 profile", () => {
  it("profile 通过 schema 校验，端口与既有 GUI agent 不冲突", () => {
    const profile = BUILTIN_PROFILES.opendesign!;
    const parsed = AgentProfileSchema.parse(profile);
    expect(parsed.adapter).toBe("opendesign-gui");
    expect(parsed.driver).toBe("gui");
    expect(parsed.gui?.cdpPort).toBe(9889);
    expect(parsed.gui?.exeArgs).toEqual(["--remote-debugging-port=<port>"]);
    // 不宣称「专属 userData」——产品会强制覆盖，写进去是假承诺
    expect(parsed.gui?.userDataDir).toBeUndefined();
    expect(parsed.opendesign?.supportedVersions).toEqual({ win32: ["0.24.1"] });
  });

  it("端口基准 9889 与既有全部 GUI agent 的端口区段都不重叠", () => {
    const base = 9889;
    const range = BUILTIN_PROFILES.opendesign!.gui!.cdpPortRange;
    const others = Object.entries(BUILTIN_PROFILES)
      .filter(([id]) => id !== "opendesign")
      .flatMap(([, p]) => {
        if (!p.gui) return [];
        const start = p.gui.cdpPort;
        return Array.from({ length: p.gui.cdpPortRange }, (_, i) => start + i);
      });
    const mine = Array.from({ length: range }, (_, i) => base + i);
    expect(mine.some((port) => others.includes(port))).toBe(false);
    // 回归：qoder 基准 9777 且区段 9777-9796，曾误把 Open Design 也设成 9777
    expect(others).not.toContain(base);
  });
});
