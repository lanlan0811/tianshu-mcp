#!/usr/bin/env node
/**
 * Kimi Code 只读诊断探针（与 scripts/probe-zcode.mjs 同构）。
 *
 * 用途：在已安装 Kimi Code 的机器上，只读地查看安装探测结果、进程与 CDP 端口、CDP page target 拓扑、
 * 工作区下拉面板、会话列表、模型/思考档位/执行模式候选、运行信号快照，以及原生「添加工作区」对话框。
 * 输出为结构化文本，可直接贴进 docs/kimi-cdp.md 作为证据。
 *
 * 前置：脚本从 dist/ 动态 import 构建产物，必须先执行 `npm run build`。
 *
 * 副作用边界（硬性）：
 * - 默认**只读**：不启动实例、不发送任何消息（本探针没有发送能力）；
 * - 只有显式传 `--launch` 才允许在无可用实例时启动 Kimi Code（会新开一个窗口）；
 * - 连接主窗口会把 Kimi Code 窗口置于前台（Chromium 会节流后台页面，不置前则点击与 elementFromPoint
 *   都不可靠），这是 CDP 只读诊断的必要条件，脚本会在输出里提示；
 * - workspaces / models 会短暂打开对应菜单并读取候选，随后按 toggle 语义收起（与 probe-zcode 一致）。
 *
 * 用法：
 *   node scripts/probe-kimicode.mjs [命令] [--port <n>] [--launch]
 */
import http from "node:http";
import { execFile } from "node:child_process";

const USAGE = `用法: node scripts/probe-kimicode.mjs [命令] [选项]

命令（默认 all）：
  install     探测 Kimi Code 可执行文件（路径 / 来源 / 版本）
  process     枚举 Kimi Code 进程（pid / 命令行 / 解析出的 --remote-debugging-port）
  cdp         打印 /json/version 与全部 page target，并标注主窗口 / overlay / 截图窗口
  workspaces  连接主窗口，打印工作区下拉面板条目（名称 + 完整路径 + 当前选中）与 ws-chip 文本
  session     打印主窗口 URL 解析出的会话 id 与侧栏会话列表
  models      打开模型菜单（overlay），打印模型候选 / 思考档位 / 执行模式候选
  liveness    打印一次运行信号快照（stopVisible / sendStarting / 文本哈希 / pageHidden 等）
  dialogs     枚举 Kimi Code 进程拥有的原生「添加工作区」对话框（标题 / 类名 / 是否可见）
  all         依次执行上述全部只读命令

选项：
  --port <n>  CDP 端口（默认 9666）
  --launch    允许在无可用实例时启动 Kimi Code（默认只读，不启动；会新开一个窗口）
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
const COMMANDS = [
  "install",
  "process",
  "cdp",
  "workspaces",
  "session",
  "models",
  "liveness",
  "dialogs",
  "all",
];
const command = positional[0] ?? "all";
if (!COMMANDS.includes(command)) {
  process.stderr.write(`未知命令：${command}\n\n${USAGE}`);
  process.exit(2);
}

const portIndex = argv.indexOf("--port");
const configuredPort = Number(portIndex >= 0 && argv[portIndex + 1] ? argv[portIndex + 1] : 9666);
if (!Number.isInteger(configuredPort) || configuredPort <= 0 || configuredPort > 65535) {
  process.stderr.write(`--port 取值无效：${argv[portIndex + 1] ?? ""}\n`);
  process.exit(2);
}
const allowLaunch = argv.includes("--launch");

const section = (title) => console.log(`\n=== ${title} ===`);
const line = (label, value) => console.log(`  ${label}: ${value}`);
const item = (label, value) => console.log(`  - ${label}${value === undefined ? "" : `: ${value}`}`);

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
  const profile = BUILTIN_PROFILES.kimicode;
  if (!profile) throw new Error("dist/agents/builtin.js 里没有 kimicode profile");
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

async function kimicodeProcesses() {
  const instance = await load("../dist/agents/kimicode/instance.js");
  const all = await instance.listKimicodeProcesses();
  return {
    instance,
    all,
    roots: instance.rootKimicodeProcesses(all),
  };
}

/* ------------------------------ install ------------------------------ */

/**
 * 探针侧补读文件版本：探测模块的版本查询只给 5s，而本机 PowerShell 冷启动实测需 6–10s，
 * 冷启动慢时 install 会打印「未读取到」。这里用更宽的超时补一次，只为诊断可读性，
 * 不改动 adapter 的探测逻辑（版本缺失不影响安装探测结果）。
 */
async function fileVersionFallback(exePath) {
  if (process.platform !== "win32") return undefined;
  const escaped = exePath.replace(/'/g, "''");
  try {
    const stdout = await runPowerShell(
      `(Get-Item -LiteralPath '${escaped}').VersionInfo.FileVersion`,
      {},
      30_000,
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function commandInstall() {
  section("install：Kimi Code 安装探测");
  const [{ discoverKimicode }, profile] = await Promise.all([
    load("../dist/agents/kimicode/discovery.js"),
    profileOf(),
  ]);
  const found = await discoverKimicode(profile);
  if (!found) {
    line("结果", "未探测到 Kimi Code 可执行文件");
    line("建议", "确认已安装 Kimi Code，或在 profile 中配置 gui.exePath / command");
    return { found: null };
  }
  line("可执行路径", found.path);
  line("来源", found.source);
  if (found.version) line("版本", found.version);
  else {
    const version = await fileVersionFallback(found.path);
    line("版本", version ?? "未读取到");
    console.log(
      "  说明: 探测模块的版本查询超时（本机 PowerShell 冷启动较慢），上面是探针侧用更长超时补读的结果",
    );
  }
  console.log(
    "  说明: 来源取值 explicit / fixed-drive / registry / standard / path / bundle；" +
      "路径由「显式配置 → 固定盘相对路径模板（preferredDrives 优先）→ 卸载注册表 → 标准目录 → PATH」推导，" +
      "代码不硬编码用户绝对路径",
  );
  return { found };
}

/* ------------------------------ process ------------------------------ */

async function commandProcess() {
  section("process：Kimi Code 进程");
  const { instance, all, roots } = await kimicodeProcesses();
  line("进程总数", String(all.length));
  line("根进程数", String(roots.length));
  if (!all.length) {
    line("结果", "未发现 Kimi Code 进程（应用可能未运行）");
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
  return { all, roots };
}

/* -------------------------------- cdp -------------------------------- */

/** 端口候选：进程 argv 里的调试端口优先，其次探针配置端口 */
async function candidatePorts() {
  const { instance, roots } = await kimicodeProcesses();
  const fromArgv = roots
    .map((proc) => instance.remoteDebugPort(proc.commandLine))
    .filter((value) => value !== null);
  return { ports: [...new Set([...fromArgv, configuredPort])], roots };
}

function targetRole(target, mainRank, overlayRank) {
  const url = target.url ?? "";
  if (/screenshot/i.test(url)) return "截图窗口（适配器排除）";
  if (overlayRank === 0) return "overlay 浮层窗口";
  if (mainRank === 0) return "主窗口（title=Kimi Code）";
  if (mainRank === 1) return "主窗口（app://renderer/）";
  return "其它页面";
}

async function commandCdp() {
  section("cdp：CDP 端点与 page target");
  const [{ kimicodeMainTargetRank, kimicodeOverlayTargetRank }, { ports }] = await Promise.all([
    load("../dist/agents/kimicode/cdp.js"),
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
    line("产品标识 kimi-code-app/", /kimi-code-app\//i.test(ua) ? "命中" : "未命中");
    const targets = await httpJson(port, "/json").catch(() => []);
    const pages = (Array.isArray(targets) ? targets : []).filter(
      (target) => target.type === "page",
    );
    line("page target 数", String(pages.length));
    for (const target of pages) {
      const mainRank = kimicodeMainTargetRank(target);
      const overlayRank = kimicodeOverlayTargetRank(target);
      console.log(`  - [${targetRole(target, mainRank, overlayRank)}]`);
      console.log(`    mainRank=${mainRank} overlayRank=${overlayRank}`);
      console.log(`    title: ${target.title ?? ""}`);
      console.log(`    url:   ${target.url ?? ""}`);
    }
    const others = (Array.isArray(targets) ? targets : []).filter(
      (target) => target.type !== "page",
    );
    if (others.length)
      line("非 page target", others.map((target) => target.type).join("、"));
  }
  return { ports };
}

/* ---------------------------- CDP 客户端 ---------------------------- */

/**
 * 解析可用的 Kimi Code CDP 端口并连接主窗口。
 * 复用顺序与 adapter 一致：先认进程 argv 里的端口 + 配置端口，并用 probeKimicodePort 做产品校验；
 * 都没有时只有显式 --launch 才启动新实例（否则如实报告「无可用实例」）。
 */
async function resolveEndpoint() {
  const { instance, roots } = await kimicodeProcesses();
  const ports = [
    ...new Set([
      ...roots
        .map((proc) => instance.remoteDebugPort(proc.commandLine))
        .filter((value) => value !== null),
      configuredPort,
    ]),
  ];
  for (const port of ports) {
    const probe = await instance.probeKimicodePort(port);
    if (probe.ready) return { port, probe, roots, launched: false };
  }
  if (!allowLaunch)
    return { port: undefined, roots, message: "未发现带 CDP 的 Kimi Code 实例（未传 --launch，不启动）" };

  console.log(
    "\n!!! --launch：将新开一个 Kimi Code 窗口（注入 --remote-debugging-port）；" +
      "既有实例若已存在且未开启 CDP，Electron 单实例锁会转交参数后让启动器退出",
  );
  const [profile, { discoverKimicode }] = await Promise.all([
    profileOf(),
    load("../dist/agents/kimicode/discovery.js"),
  ]);
  const found = await discoverKimicode(profile);
  if (!found) return { port: undefined, roots, message: "未探测到 Kimi Code 可执行文件，无法启动" };
  const logger = {
    info: (message) => console.log(`  [launch] ${message}`),
    warn: (message) => console.log(`  [launch][warn] ${message}`),
    error: (message) => console.log(`  [launch][error] ${message}`),
    debug: () => {},
  };
  const launched = await instance.ensureKimicodeInstance(found.path, profile.gui, logger);
  if (launched.needsClose)
    return {
      port: undefined,
      roots,
      message: "既有 Kimi Code 实例未开启 CDP：adapter 会转 needs_user(close_existing_instance)，请用户先关闭",
    };
  return { port: launched.ready.port, probe: launched.ready, roots, launched: true };
}

/** 连接主窗口执行只读读取；连接会把窗口置前（CDP 需要），结束统一断开 */
async function withMainClient(fn) {
  const endpoint = await resolveEndpoint();
  if (!endpoint.port) {
    line("结果", endpoint.message ?? "无可用 CDP 端点");
    return { ok: false, message: endpoint.message };
  }
  const { KimicodeCdpClient } = await load("../dist/agents/kimicode/cdp.js");
  line("CDP 端口", String(endpoint.port));
  line("目标页面", `${endpoint.probe?.title ?? ""} ${endpoint.probe?.url ?? ""}`.trim());
  console.log("  提示: 连接会把 Kimi Code 主窗口置于前台（后台页面被节流，合成点击与坐标判定不可靠）");
  const client = new KimicodeCdpClient(endpoint.port, 15_000, {});
  await client.connect();
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

/* ----------------------------- workspaces ----------------------------- */

async function commandWorkspaces() {
  section("workspaces：工作区（任务文件夹）下拉面板");
  return withMainClient(async (client) => {
    const href = await client.evaluate("location.href");
    line("主窗口 URL", String(href ?? ""));
    const chip = await client.workspaceChipText();
    line("ws-chip 文本", chip || "（空：已不在草稿页，发送后 ws-chip 会从 composer 消失）");
    const opened = await client.openWorkspacePanel(5_000);
    line("面板是否打开", opened ? "是" : "否（点击被吞或窗口未置前；面板渲染在主窗口内）");
    if (!opened) return { ok: false };
    const items = await client.workspaceItems();
    line("条目数", String(items.length));
    for (const entry of items) {
      console.log(`  - ${entry.active ? "[当前选中]" : "[        ]"} 名称=${entry.name}`);
      console.log(`    完整路径: ${entry.path ?? "（界面未暴露，只能回退名称匹配）"}`);
    }
    console.log("  说明: 绑定判据以 span.ws-path 的完整路径为主，名称仅作回退；同名不同目录 fail-closed");
    await client.dismissMenus();
    return { ok: true, items };
  });
}

/* ------------------------------- session ------------------------------- */

async function commandSession() {
  section("session：当前会话与侧栏会话列表");
  return withMainClient(async (client) => {
    const href = await client.evaluate("location.href");
    line("主窗口 URL", String(href ?? ""));
    const current = await client.currentSessionId();
    line("当前会话 id", current.id ?? "（无：草稿页 app://renderer/）");
    line("id 来源", current.source);
    line("是否存在歧义", current.ambiguous ? "是" : "否");
    const sessions = await client.sessions();
    line("侧栏会话数", String(sessions.length));
    for (const entry of sessions) {
      console.log(`  - id=${entry.id}`);
      console.log(`    标题: ${entry.title ?? "（空）"}`);
    }
    console.log(
      "  说明: 会话 id 有两条独立来源（主窗口 URL 与侧栏 div.se[data-session-id]）；" +
        "恢复时只允许唯一定位原会话，定位不到一律 session_lost，绝不打开「最近会话」",
    );
    return { ok: true, current, sessions };
  });
}

/* -------------------------------- models -------------------------------- */

async function commandModels() {
  section("models：模型 / 思考档位 / 执行模式（overlay 浮层窗口）");
  return withMainClient(async (client) => {
    const { tierSetOf, tierLabels } = await load("../dist/agents/kimicode/model.js");
    const pill = await client.modelTriggerText();
    line("model-pill 文本", pill || "（空）");
    line("perm-pill 文本", (await client.permissionText()) || "（空）");

    console.log("\n  --- 模型菜单 ---");
    const modelOpened = await client.openModelMenu(5_000);
    line("overlay 是否可见", modelOpened ? "是" : "否");
    if (modelOpened) {
      const models = await client.overlayModels();
      line("模型候选数", String(models.length));
      for (const entry of models)
        console.log(`  - ${entry.current ? "[当前 .is-active]" : "[              ]"} ${entry.label}`);
      const tiers = await client.reasoningTiers();
      line("思考档位数", String(tiers.length));
      for (const entry of tiers)
        console.log(`  - ${entry.current ? "[当前 .is-on]" : "[          ]"} ${entry.label}`);
      const set = tierSetOf(tiers.map((entry) => entry.label));
      line("档位形态", `${set.kind}（${tierLabels(set)}）`);
      console.log(
        "  说明: 官方模型为 Low/High/Max，非官方模型只有 On/Off；档位集合以界面实际渲染为准，" +
          "适配器不内置模型名单，不支持即发送前报错",
      );
      await client.dismissMenus();
    }

    console.log("\n  --- 执行模式菜单 ---");
    const permissionOpened = await client.openPermissionMenu(5_000);
    line("overlay 是否可见", permissionOpened ? "是" : "否");
    if (permissionOpened) {
      const permissions = await client.overlayPermissions();
      line("执行模式候选数", String(permissions.length));
      for (const entry of permissions)
        console.log(`  - ${entry.current ? "[当前 .is-active]" : "[              ]"} ${entry.label}`);
      console.log("  说明: 适配器强制「完全自动」并回读；三档实测为 始终询问 / 必要时询问 / 完全自动");
      await client.dismissMenus();
    }
    return { ok: true, pill };
  });
}

/* ------------------------------- liveness ------------------------------- */

async function commandLiveness() {
  section("liveness：运行信号快照（单次 poll）");
  return withMainClient(async (client) => {
    const { hashText } = await load("../dist/agents/kimicode/liveness.js");
    const poll = await client.poll();
    line("stopVisible（button.stop，权威运行信号）", String(poll.stopVisible));
    line("sendStarting（button.send 含 is-starting）", String(poll.sendStarting));
    line("retryVisible（「继续」按钮 → 失败态）", String(poll.retryVisible));
    line("errorText", poll.errorText || "（无）");
    line("userGateVisible", String(poll.userGateVisible ?? false));
    line("question", poll.question || "（无）");
    line("assistantText 长度", String(poll.assistantText.length));
    line("assistantText 哈希", hashText(poll.assistantText));
    line("inputText 长度", String(poll.inputText.length));
    line("sendEnabled", String(poll.sendEnabled));
    line("pageHidden（窗口不在前台 → 点击可能被吞）", String(poll.pageHidden));
    const preview = poll.assistantText.trim().slice(0, 300);
    console.log(`  assistantText 预览: ${preview || "（空）"}`);
    console.log(
      "  说明: 输入框清空后 innerText 长度仍为 1（ProseMirror 保留空 <p>），空态判定不能用 length === 0",
    );
    return { ok: true, poll };
  });
}

/* -------------------------------- dialogs -------------------------------- */

/** 只读枚举：目标进程拥有的 #32770 窗口（与 dialog.ts 的守卫同源，额外回报可见性用于诊断） */
const DIALOG_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class TianshuKimicodeProbe {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
'@
$ids=($env:TIANSHU_KIMICODE_PROBE_PIDS -split ',' | Where-Object { $_ -ne '' })
$script:rows=@()
[TianshuKimicodeProbe]::EnumWindows({param($h,$l)
  [uint32]$owner=0
  [void][TianshuKimicodeProbe]::GetWindowThreadProcessId($h,[ref]$owner)
  if($ids -contains [string]$owner){
    $cls=New-Object Text.StringBuilder 256
    [void][TianshuKimicodeProbe]::GetClassName($h,$cls,$cls.Capacity)
    if($cls.ToString() -eq '#32770'){
      $t=New-Object Text.StringBuilder 512
      [void][TianshuKimicodeProbe]::GetWindowText($h,$t,$t.Capacity)
      $visible=[TianshuKimicodeProbe]::IsWindowVisible($h)
      $script:rows += "dialog:$($h.ToInt64()):$($cls.ToString()):$($t.ToString()):$visible"
    }
  }
  return $true
},[IntPtr]::Zero)|Out-Null
$script:rows -join [Environment]::NewLine
`;

function runPowerShell(script, env, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", script],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: timeoutMs },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

async function commandDialogs() {
  section("dialogs：原生「添加工作区」对话框");
  if (process.platform !== "win32") {
    line("结果", `当前平台 ${process.platform} 不支持该枚举（macOS 分支 fail-closed）`);
    return { ok: false };
  }
  const { all } = await kimicodeProcesses();
  if (!all.length) {
    line("结果", "未发现 Kimi Code 进程，跳过枚举");
    return { ok: false };
  }
  line("参与枚举的 pid", all.map((proc) => proc.pid).join("、"));
  const stdout = await runPowerShell(DIALOG_SCRIPT, {
    TIANSHU_KIMICODE_PROBE_PIDS: all.map((proc) => proc.pid).join(","),
  });
  const rows = stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  line("匹配窗口数", String(rows.length));
  if (!rows.length) {
    line("结果", "当前没有 #32770 窗口（对话框只在点「选择文件夹…」后出现）");
    return { ok: true, rows };
  }
  for (const row of rows) {
    const parsed = /^dialog:(\d+):([^:]*):(.*):(True|False)$/.exec(row);
    if (!parsed) {
      item("原始", row);
      continue;
    }
    console.log(`  - hwnd=${parsed[1]}`);
    console.log(`    类名: ${parsed[2]}`);
    console.log(`    标题: ${parsed[3] || "（空）"}`);
    console.log(`    可见: ${parsed[4] === "True" ? "是" : "否"}`);
  }
  console.log(
    "  说明: 「添加工作区」为 #32770 + 标题「添加工作区」；编辑框 AutomationId=1152 且 ControlType 为 Pane" +
      "（无 ValuePattern），确认(1)/取消(2) 均不支持 UIA InvokePattern，只能 WM_SETTEXT 写入 + 回读 + 坐标点击",
  );
  return { ok: true, rows };
}

/* --------------------------------- all --------------------------------- */

const READ_ONLY_COMMANDS = [
  ["install", commandInstall],
  ["process", commandProcess],
  ["cdp", commandCdp],
  ["workspaces", commandWorkspaces],
  ["session", commandSession],
  ["models", commandModels],
  ["liveness", commandLiveness],
  ["dialogs", commandDialogs],
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
