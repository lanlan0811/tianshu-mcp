#!/usr/bin/env node
/**
 * Open Design 只读诊断探针（与 scripts/probe-kimicode.mjs 同构）。
 *
 * 用途：在已安装 Open Design 的机器上，只读地查看安装探测结果、数据目录推导、进程与 CDP 端口、
 * CDP page target 拓扑，以及主窗口的**锚点盘点**（选择器候选命中情况 + 关键区域文本快照），
 * 以及当前写入 .tianshu-mcp 数据目录的候选选择器清单。
 * 输出为结构化文本，可直接贴进 docs/opendesign-cdp.md 作为证据。
 *
 * 前置：脚本从 dist/ 动态 import 构建产物，必须先执行 `npm run build`。
 *
 * 副作用边界（硬性）：
 * - 默认**只读**：不启动实例、不发送任何消息、不点击任何控件（本探针没有点击能力）；
 * - 只有显式传 `--launch` 才允许在无可用实例时启动 Open Design（会新开一个窗口）；
 * - 连接主窗口会把 Open Design 窗口置于前台（Chromium 会节流后台页面，不置前则 elementFromPoint
 *   与合成事件都不可靠）——**例外：`--no-focus` 跳过置前**（纯 DOM 读取不需要前台）。
 *
 * 用法：
 *   node scripts/probe-opendesign.mjs [命令] [--port <n>] [--launch] [--no-focus]
 */
import http from "node:http";

const USAGE = `用法: node scripts/probe-opendesign.mjs [命令] [选项]

命令（默认 all）：
  install     探测 Open Design 可执行文件（路径 / 来源 / 版本 / 命名空间 / 数据目录）
  process     枚举 Open Design 进程（pid / 命令行 / 解析出的 --remote-debugging-port）
  cdp         打印 /json/version 与全部 page target，并标注主窗口 / 浮层 / 其它
  anchors     连接主窗口，盘点关键锚点候选（选择器命中数 + 文本），并打印页面骨架摘要
  appconfig   只读打印 app-config.json（agentModels / designSystemId / recentLinkedDirs）
  all         依次执行上述全部只读命令

选项：
  --port <n>  CDP 端口（默认 9889）
  --launch    允许在无可用实例时启动 Open Design（默认只读，不启动；会新开一个窗口）
  --no-focus  连接主窗口后不做置前（纯 DOM 读取用；点击类诊断仍需置前）
  --help      显示本帮助

前置：先执行 npm run build（脚本从 dist/ 动态 import 构建产物）。
`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(USAGE);
  process.exit(0);
}

/** 位置参数解析：跳过 --port 的取值，避免把端口号当成子命令 */
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--port") {
    i++;
    continue;
  }
  if (argv[i].startsWith("-")) continue;
  positional.push(argv[i]);
}
const COMMANDS = ["install", "process", "cdp", "anchors", "appconfig", "all"];
const command = positional[0] ?? "all";
if (!COMMANDS.includes(command)) {
  process.stderr.write(`未知命令：${command}\n\n${USAGE}`);
  process.exit(2);
}

const portIndex = argv.indexOf("--port");
const configuredPort = Number(portIndex >= 0 && argv[portIndex + 1] ? argv[portIndex + 1] : 9889);
if (!Number.isInteger(configuredPort) || configuredPort <= 0 || configuredPort > 65535) {
  process.stderr.write(`--port 取值无效：${argv[portIndex + 1] ?? ""}\n`);
  process.exit(2);
}
const allowLaunch = argv.includes("--launch");
const noFocus = argv.includes("--no-focus");

const section = (title) => console.log(`\n=== ${title} ===`);
const line = (label, value) => console.log(`  ${label}: ${value}`);

/** 动态 import 构建产物；失败时给出「先 build」的可操作提示 */
async function load(specifier) {
  try {
    return await import(specifier);
  } catch (error) {
    throw new Error(`加载 ${specifier} 失败（${error.message}）；请先执行 npm run build`);
  }
}

async function profileOf() {
  const { BUILTIN_PROFILES } = await load("../dist/agents/builtin.js");
  const profile = BUILTIN_PROFILES.opendesign;
  if (!profile) throw new Error("dist/agents/builtin.js 里没有 opendesign profile");
  return profile;
}

/** 读取 CDP 只读 JSON 端点（127.0.0.1） */
function httpJson(port, pathname, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathname, timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`${pathname} 响应无法解析：${error.message}`));
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`${pathname} 超时`));
    });
    req.on("error", (error) => reject(error));
  });
}

async function openDesignProcesses() {
  const instance = await load("../dist/agents/opendesign/instance.js");
  const all = await instance.listOpenDesignProcesses();
  return { instance, all, roots: instance.rootOpenDesignProcesses(all) };
}

/* ------------------------------ install ------------------------------ */

async function commandInstall() {
  section("install：Open Design 安装探测");
  const [
    { discoverOpenDesign, readInstallInfo, openDesignNamespaceRoot, openDesignAppConfigPath },
    profile,
  ] = await Promise.all([load("../dist/agents/opendesign/discovery.js"), profileOf()]);
  const found = await discoverOpenDesign(profile);
  if (!found) {
    line("结果", "未探测到 Open Design 可执行文件");
    line("建议", "确认已安装 Open Design，或在 profile 中配置 gui.exePath / command");
    return { found: null };
  }
  line("可执行路径", found.path);
  line("来源", found.source);
  line("版本（安装配置 appVersion）", found.version ?? "未读取到");
  const info = readInstallInfo(found.path);
  line("安装目录", info?.installDir ?? "（安装配置不可读）");
  line("命名空间", info?.namespace ?? "（安装配置不可读）");
  const namespaceRoot = info ? openDesignNamespaceRoot(info) : null;
  line("数据目录（Electron userData 根）", namespaceRoot ?? "（无法推导）");
  line("app-config.json", openDesignAppConfigPath(namespaceRoot) ?? "（无法推导）");
  console.log(
    "  说明: 来源取值 explicit / fixed-drive / registry / standard / path / bundle；" +
      "路径由「显式配置 → 固定盘相对路径模板（preferredDrives 优先）→ 卸载注册表 → 标准目录 → PATH」推导，" +
      "代码不硬编码用户绝对路径；版本与命名空间一律从 <安装目录>/resources/open-design-config.json 读取",
  );
  return { found };
}

/* ------------------------------ process ------------------------------ */

async function commandProcess() {
  section("process：Open Design 进程");
  const { instance, all, roots } = await openDesignProcesses();
  line("进程总数", String(all.length));
  line("根进程数", String(roots.length));
  if (!all.length) {
    line("结果", "未发现 Open Design 进程（应用可能未运行）");
    return { all, roots };
  }
  const rootPids = new Set(roots.map((proc) => proc.pid));
  for (const proc of all) {
    const cdp = instance.remoteDebugPort(proc.commandLine);
    console.log(
      `  - pid=${proc.pid} 角色=${rootPids.has(proc.pid) ? "根进程" : "子进程（渲染/GPU/工具）"} cdp=${cdp ?? "无"}`,
    );
    console.log(`    可执行: ${proc.executable ?? "（未读取到）"}`);
    console.log(`    命令行: ${proc.commandLine || "（空）"}`);
  }
  console.log(
    "  说明: 本产品有进程级单实例锁，第二实例会转交参数后退出；" +
      "根进程 argv 中没有有效调试端口 = 无法接管，适配器会转 needs_user(close_existing_instance)",
  );
  return { all, roots };
}

/* -------------------------------- cdp -------------------------------- */

async function candidatePorts() {
  const { instance, roots } = await openDesignProcesses();
  const fromArgv = roots
    .map((proc) => instance.remoteDebugPort(proc.commandLine))
    .filter((value) => value !== null);
  return { ports: [...new Set([...fromArgv, configuredPort])], roots };
}

function targetRole(target, mainRank, overlayRank) {
  if (mainRank === 0) return "主窗口（title=Open Design）";
  if (mainRank === 1) return "主窗口（URL 含 open-design）";
  if (overlayRank === 0) return "浮层窗口（无标题/about:blank）";
  return "其它页面";
}

async function commandCdp() {
  section("cdp：CDP 端点与 page target");
  const [{ openDesignMainTargetRank, openDesignOverlayTargetRank }, { ports }] = await Promise.all([
    load("../dist/agents/opendesign/cdp.js"),
    candidatePorts(),
  ]);
  line("端口候选", ports.join("、"));
  for (const port of ports) {
    console.log(`\n  --- 127.0.0.1:${port} ---`);
    const version = await httpJson(port, "/json/version").catch((error) => ({
      __error: error.message,
    }));
    if (version.__error) {
      line("连接", `失败：${version.__error}`);
      continue;
    }
    const ua = String(version["User-Agent"] ?? "");
    line("Browser", version.Browser ?? "（空）");
    line("User-Agent", ua || "（空）");
    line("产品标识 electron", /electron/i.test(ua) ? "命中" : "未命中");
    const targets = await httpJson(port, "/json").catch(() => []);
    const pages = (Array.isArray(targets) ? targets : []).filter(
      (target) => target.type === "page",
    );
    line("page target 数", String(pages.length));
    for (const target of pages) {
      const mainRank = openDesignMainTargetRank(target);
      const overlayRank = openDesignOverlayTargetRank(target);
      console.log(`  - [${targetRole(target, mainRank, overlayRank)}]`);
      console.log(`    mainRank=${mainRank} overlayRank=${overlayRank}`);
      console.log(`    title: ${target.title ?? ""}`);
      console.log(`    url:   ${target.url ?? ""}`);
    }
    const others = (Array.isArray(targets) ? targets : []).filter(
      (target) => target.type !== "page",
    );
    if (others.length) line("非 page target", others.map((target) => target.type).join("、"));
  }
  return { ports };
}

/* ------------------------------ appconfig ------------------------------ */

async function commandAppConfig() {
  section("appconfig：只读打印 app-config.json");
  const [{ discoverOpenDesign, readInstallInfo, openDesignNamespaceRoot }, profile] =
    await Promise.all([load("../dist/agents/opendesign/discovery.js"), profileOf()]);
  const found = await discoverOpenDesign(profile);
  if (!found) {
    line("结果", "未探测到 Open Design，跳过");
    return { ok: false };
  }
  const info = readInstallInfo(found.path);
  const namespaceRoot = info ? openDesignNamespaceRoot(info) : null;
  const { readAppConfig } = await load("../dist/agents/opendesign/instance.js");
  const config = readAppConfig(namespaceRoot);
  if (!config) {
    line("结果", "app-config.json 不存在或不可解析（应用可能从未运行过）");
    return { ok: false };
  }
  line("agentId", String(config.agentId ?? "（空）"));
  line("designSystemId", String(config.designSystemId ?? "（空）"));
  line("appVersion（配置内）", String(config.appVersion ?? "（空）"));
  line("agentModels", JSON.stringify(config.agentModels ?? {}));
  line("recentLinkedDirs", JSON.stringify(config.recentLinkedDirs ?? []));
  line("projectLocations", JSON.stringify(config.projectLocations ?? []));
  line("defaultProjectLocationId", String(config.defaultProjectLocationId ?? "（空）"));
  console.log(
    "  说明: 这些字段只作**旁证**（界面回读才是权威）；recentLinkedDirs 可用于诊断「上次绑定的项目目录」",
  );
  return { ok: true, config };
}

/* -------------------------------- anchors -------------------------------- */

/**
 * 候选选择器：真机采集用。键与 selectors.ts 的 OpenDesignSelectorKey 对齐，
 * 值是**候选 CSS**（多个用逗号分隔 = querySelectorAll 的并集语义，仅用于盘点，不等同最终选择器）。
 * 这里刻意写得宽（包含 aria/placeholder/语义候选），靠实跑结果收敛到稳定选择器。
 */
const ANCHOR_CANDIDATES = {
  openDesignTitle: "h1,header,main h1,[class*=title i]",
  composer: "[class*=composer i],[class*=prompt i],main form,[class*=input i]",
  inputBox: "textarea,[contenteditable=true],[role=textbox]",
  workingDirTrigger: "[aria-haspopup],[class*=working i],[class*=dir i],[class*=folder i]",
  workingDirValue: "[class*=path i],code,[class*=value i]",
  modelTrigger: "[class*=model i],[aria-label*=model i]",
  designSystemTrigger: "[class*=design-system i],[aria-label*=design i]",
  designDirectionTrigger: "[class*=direction i],[aria-label*=direction i]",
  sendButton: "button[type=submit],[aria-label*=send i],[class*=send i]",
  stopButton: "[class*=stop i],[aria-label*=stop i]",
  conversationText: "[class*=message i],[class*=conversation i],[class*=thread i],main",
  designSystemSearch: "input[placeholder],[role=searchbox],[type=search]",
  modelMenuItem: "[role=menuitem],[role=option],li,button",
  designSystemItem: "[role=option],[role=menuitem],li,button",
  designDirectionItem: "[role=option],[role=menuitem],li,button",
  selectDirItem: "[role=menuitem],[role=option],li,button",
  recentDirItem: "[role=menuitem],[role=option],li,button",
};

async function withMainClient(fn) {
  const endpoint = await resolveEndpoint();
  if (!endpoint.port) {
    line("结果", endpoint.message ?? "无可用 CDP 端点");
    return { ok: false, message: endpoint.message };
  }
  const { createOpenDesignPageClient } = await load("../dist/agents/opendesign/cdp.js");
  line("CDP 端口", String(endpoint.port));
  line("目标页面", `${endpoint.probe?.title ?? ""} ${endpoint.probe?.url ?? ""}`.trim());
  const client = createOpenDesignPageClient("main", endpoint.port, 15_000);
  await client.connect();
  if (!noFocus) {
    console.log(
      "  提示: 使用 --no-focus 可跳过置前；点击类诊断必须置前（后台页面会被 Chromium 节流）",
    );
    try {
      await client.send("Page.bringToFront");
    } catch {
      /* 置前失败不影响只读读取 */
    }
  }
  try {
    return await fn(client, endpoint);
  } finally {
    try {
      client.disconnect();
    } catch {
      /* 已断开 */
    }
  }
}

/**
 * 解析可用的 Open Design CDP 端口并连接主窗口。
 * 复用顺序与 adapter 一致：先认进程 argv 里的端口 + 配置端口，并用 probeOpenDesignPort 做产品校验；
 * 都没有时只有显式 --launch 才启动新实例（否则如实报告「无可用实例」）。
 */
async function resolveEndpoint() {
  const { instance, roots } = await openDesignProcesses();
  const ports = [
    ...new Set([
      ...roots
        .map((proc) => instance.remoteDebugPort(proc.commandLine))
        .filter((value) => value !== null),
      configuredPort,
    ]),
  ];
  for (const port of ports) {
    const probe = await instance.probeOpenDesignPort(port);
    if (probe.ready) return { port, probe, roots, launched: false };
  }
  if (!allowLaunch)
    return {
      port: undefined,
      roots,
      message: "未发现带 CDP 的 Open Design 实例（未传 --launch，不启动）",
    };

  console.log(
    "\n!!! --launch：将新开一个 Open Design 窗口（注入 --remote-debugging-port）；" +
      "既有实例若已存在且未开启 CDP，单实例锁会转交参数后让启动器退出",
  );
  const [profile, { discoverOpenDesign }] = await Promise.all([
    profileOf(),
    load("../dist/agents/opendesign/discovery.js"),
  ]);
  const found = await discoverOpenDesign(profile);
  if (!found)
    return { port: undefined, roots, message: "未探测到 Open Design 可执行文件，无法启动" };
  const logger = {
    info: (message) => console.log(`  [launch] ${message}`),
    warn: (message) => console.log(`  [launch][warn] ${message}`),
    error: (message) => console.log(`  [launch][error] ${message}`),
    debug: () => {},
  };
  const launched = await instance.ensureOpenDesignInstance(found.path, profile.gui, logger);
  if (launched.needsClose)
    return {
      port: undefined,
      roots,
      message:
        "既有 Open Design 实例未开启 CDP：adapter 会转 needs_user(close_existing_instance)，请用户先关闭",
    };
  return { port: launched.ready.port, probe: launched.ready, roots, launched: true };
}

async function commandAnchors() {
  section("anchors：主窗口锚点盘点（只读，不点击）");
  return withMainClient(async (client) => {
    const href = await client.evaluate("location.href");
    line("主窗口 URL", String(href ?? ""));
    const probe = await client.evaluate(
      `(() => ({
        title: document.title,
        href: location.href,
        bodyTextLength: (document.body.innerText ?? "").length,
        controls: document.querySelectorAll("button,[role=button],a,select,textarea,input,[contenteditable=true]").length,
        menus: document.querySelectorAll("[role=menu],[role=listbox],[role=option],[role=menuitem]").length,
        dialogs: document.querySelectorAll("[role=dialog],[class*=modal i],[class*=dialog i]").length,
      }))()`,
    );
    line("document.title", String(probe.title ?? ""));
    line("可见文本长度", String(probe.bodyTextLength));
    line("控件数", String(probe.controls));
    line("菜单/选项数", String(probe.menus));
    line("对话框数", String(probe.dialogs));

    const { probeDocumentAnchors } = await load("../dist/agents/opendesign/cdp.js");
    const report = await probeDocumentAnchors(client, ANCHOR_CANDIDATES);
    console.log("\n  --- 候选锚点命中情况（count 为并集匹配数；-1 = 选择器语法错误）---");
    for (const [key, value] of Object.entries(report.anchors)) {
      console.log(
        `  - ${key}: count=${value.count}${value.text ? ` text="${value.text.replace(/\s+/g, " ").slice(0, 120)}"` : ""}`,
      );
    }
    console.log(
      "\n  说明: 这些是**候选**选择器（宽匹配）。把真正稳定的选择器写回 src/agents/opendesign/selectors.ts，" +
        "并同步 docs/opendesign-cdp.md；适配器在关键选择器缺失时硬失败 selector_drift，不做盲点坐标点击",
    );
    const bodyPreview = await client.evaluate(
      `(() => (document.body.innerText ?? "").slice(0, 1200))()`,
    );
    console.log("\n  --- 页面可见文本前 1200 字符 ---");
    console.log(
      String(bodyPreview ?? "")
        .split(/\r?\n/)
        .map((l) => `    ${l}`)
        .join("\n"),
    );
    return { ok: true, report };
  });
}

/* --------------------------------- all --------------------------------- */

const READ_ONLY_COMMANDS = [
  ["install", commandInstall],
  ["process", commandProcess],
  ["cdp", commandCdp],
  ["appconfig", commandAppConfig],
  ["anchors", commandAnchors],
];

async function commandAll() {
  for (const [name, run] of READ_ONLY_COMMANDS) {
    try {
      await run();
    } catch (error) {
      section(`${name}：失败`);
      line("错误", error instanceof Error ? error.message : String(error));
    }
  }
}

const runners = Object.fromEntries(READ_ONLY_COMMANDS);
runners.all = commandAll;

try {
  await runners[command]();
} catch (error) {
  process.stderr.write(`探针执行失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
