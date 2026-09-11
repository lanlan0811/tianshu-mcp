#!/usr/bin/env node
/**
 * Codex 真机诊断脚本（仿 probe-zcode.mjs）。
 *
 * 用途：在真实 Windows + 已安装 Codex 桌面端的机器上，分步验证：
 *   1) 安装发现（Get-AppxPackage 查询 → InstallLocation / AUMID；失败回退扫盘）
 *   2) 受管实例启动（COM 激活 + 专属 user-data-dir + 调试端口）
 *   3) CDP 接管（/json/list → Codex 页面）
 *   4) 关键选择器实测（输入框 / 发送按钮 / 模型触发器 / 权限 / 新对话 / 项目项）
 *   5) 运行信号观察（停止按钮，需真实发送任务时手动确认）
 *
 * 用法：
 *   node scripts/probe-codex.mjs                 # 只读诊断（不启动新实例，不发送）
 *   node scripts/probe-codex.mjs --launch        # 允许启动受管实例并连 CDP
 *   node scripts/probe-codex.mjs --launch --port 9333
 *
 * 安全：--launch 只使用专属 user-data-dir（%LOCALAPPDATA%/tianshu-mcp/codex-gui/profile），
 * 不会触碰用户手动打开的 Codex 实例；脚本结束不杀实例（保留现场供排查）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
const LAUNCH = args.includes("--launch");
const portArgIdx = args.indexOf("--port");
const PORT = portArgIdx >= 0 ? Number(args[portArgIdx + 1]) : 9333;
const AUMID = "OpenAI.Codex_2p2nqsd0c76g0!App";

const line = (s = "") => process.stdout.write(`${s}\n`);
const ok = (s) => line(`  \u2713 ${s}`);
const bad = (s) => line(`  \u2717 ${s}`);

function userDataDir() {
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "tianshu-mcp", "codex-gui", "profile");
}

/* ---------- 步骤 1：安装发现 ---------- */
function discover() {
  line("== 步骤 1：安装发现 ==");
  let install = null;
  let aumid = null;
  let version = null;
  try {
    const raw = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "$p = Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1; if ($p) { $p | Select-Object InstallLocation,PackageFamilyName,PackageFullName,Version | ConvertTo-Json -Compress }",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 25_000 },
    ).trim();
    if (raw) {
      const info = JSON.parse(raw);
      install = info.InstallLocation;
      aumid = `${info.PackageFamilyName}!App`;
      version = info.Version;
      ok(`Appx 查询：${install} (v${version})`);
      ok(`AUMID：${aumid}`);
    }
  } catch (e) {
    bad(`Appx 查询失败：${e.message}（回退扫盘）`);
  }
  if (install) {
    const exe = path.join(install, "app", "ChatGPT.exe");
    (fs.existsSync(exe) ? ok : bad)(`GUI 宿主：${exe}`);
    if (fs.existsSync(exe)) return { exe, aumid };
  }
  // 回退扫盘：多版本共存时取最新（与 discovery.ts 的 scanForCodex 行为一致）
  line("  回退扫盘（取最新版本）…");
  const root = path.join(process.env.SystemDrive ?? "C:", "Program Files", "WindowsApps");
  const candidates = [];
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || !/^OpenAI\.Codex_/i.test(e.name)) continue;
      const exe = path.join(root, e.name, "app", "ChatGPT.exe");
      if (!fs.existsSync(exe)) continue;
      const m = /^OpenAI\.Codex_(\d+(?:\.\d+)*)_/i.exec(e.name);
      const ver = m ? m[1].split(".").map(Number) : [0];
      candidates.push({ exe, name: e.name, ver });
    }
  } catch (e) {
    bad(`扫盘失败：${e.message}`);
  }
  candidates.sort((a, b) => {
    for (let i = 0; i < Math.max(a.ver.length, b.ver.length); i++) {
      const d = (b.ver[i] ?? 0) - (a.ver[i] ?? 0);
      if (d) return d;
    }
    return 0;
  });
  if (candidates.length) {
    for (const c of candidates) line(`    候选：${c.name}${c === candidates[0] ? "  ← 选中(最新)" : ""}`);
    ok(`扫盘命中：${candidates[0].exe}`);
    return { exe: candidates[0].exe, aumid: AUMID };
  }
  bad("未发现 Codex 桌面端");
  return { exe: null, aumid: null };
}

/* ---------- 步骤 2：进程/端口现状 ---------- */
function processes() {
  line("\n== 步骤 2：进程与端口现状 ==");
  try {
    const raw = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 10_000 },
    ).trim();
    if (!raw) {
      line("  无 ChatGPT.exe 进程");
      return;
    }
    const roots = raw.split(/\r?\n/).filter((l) => !/--type=|crashpad/.test(l));
    line(`  根进程 ${roots.length} 个：`);
    for (const l of roots) line(`    ${l.slice(0, 200)}`);
    const managed = roots.filter((l) => l.includes(userDataDir()));
    ok(`受管实例（专属 profile）：${managed.length} 个 → ${userDataDir()}`);
  } catch (e) {
    bad(`进程枚举失败：${e.message}`);
  }
}

/* ---------- 步骤 3：COM 激活 ---------- */
function activate(aumid) {
  line("\n== 步骤 3：受管实例启动（COM 激活）==");
  if (!LAUNCH) {
    line("  跳过（未加 --launch）。将使用：");
    line(`    AUMID=${aumid}`);
    line(`    profile=${userDataDir()}`);
    line(`    port=${PORT}`);
    return false;
  }
  const cs = `
using System; using System.Runtime.InteropServices;
public static class ProbeAct {
  [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IApplicationActivationManager { int ActivateApplication([In] string a,[In] string b,[In] int c,[Out] out uint p); }
  [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")] class ApplicationActivationManager {}
  public static uint Activate(string a,string b,int c){ var m=(IApplicationActivationManager)new ApplicationActivationManager(); uint p; int hr=m.ActivateApplication(a,b,c,out p); if(hr<0) Marshal.ThrowExceptionForHR(hr); return p; }
}`;
  const q = (s) => `'${s.replace(/'/g, "''")}'`;
  const script = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${cs}\n'@\n$p=[ProbeAct]::Activate(${q(aumid)},${q(`--user-data-dir="${userDataDir()}" --remote-debugging-port=${PORT}`)},0)\nWrite-Output ("pid=" + $p)`;
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    }).trim();
    ok(`激活返回 ${out}`);
    return true;
  } catch (e) {
    bad(`激活失败：${e.message}`);
    return false;
  }
}

/* ---------- 步骤 4/5：CDP 与选择器 ---------- */
async function cdpProbe() {
  line("\n== 步骤 4：CDP 就绪与页面 ==");
  let targets = null;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      targets = await res.json();
      if (Array.isArray(targets) && targets.length) break;
    } catch {
      /* 未就绪 */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!targets) {
    bad(`端口 ${PORT} 未就绪（未加 --launch 时属正常）`);
    return false;
  }
  const page = targets.find((t) => t.type === "page");
  if (!page) {
    bad(`端口 ${PORT} 无页面目标：${JSON.stringify(targets).slice(0, 200)}`);
    return false;
  }
  ok(`页面：${page.title || "(无标题)"} → ${page.url}`);

  line("\n== 步骤 5：关键选择器实测 ==");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  });
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const ev = (expr) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
    });

  const probe = [
    ["输入框 chatInput", `document.querySelectorAll('div.ProseMirror[contenteditable="true"]').length`],
    ["发送按钮 sendButton(空输入应为0)", `document.querySelectorAll('button[aria-label="发送"]').length`],
    ["停止按钮 stopButton(空闲应为0)", `document.querySelectorAll('button[aria-label*="停止"]').length`],
    ["模型触发器(生产解析器)", `(function(){const excl=['[role="menubar"]','header','[class*="menubar" i]'];const vis=(e)=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0};const cands=[...document.querySelectorAll('button[aria-haspopup="menu"],[aria-haspopup="menu"]')].filter(e=>!excl.some(s=>{try{return e.closest(s)}catch(_){return false}})&&vis(e));const modelish=(t)=>/GPT|Sol|Claude|o\\d|模型|model/i.test(t)&&t.length<=60;const hit=cands.find(e=>modelish((e.innerText||'').trim()));const el=hit||cands[cands.length-1];return el?(el.innerText||'').trim().replace(/\\n/g,' '):'<none>'}())`],
    ["菜单栏 aria-haspopup(应被排除)", `[...document.querySelectorAll('header button[aria-haspopup], [role="menubar"] button')].map(b=>b.innerText.trim()).join('|')||'<none>'`],
    ["权限触发器 permissionTrigger", `[...document.querySelectorAll('button[aria-label*="权限"],[aria-label*="permission" i]')].map(b=>b.innerText.trim()).join('|')||'<none>'`],
    ["新对话 newChat", `[...document.querySelectorAll('button.sidebar-item')].some(b=>b.innerText.includes('新对话'))`],
    ["项目项 projectItem", `[...document.querySelectorAll('[aria-label]')].map(e=>e.getAttribute('aria-label')).filter(a=>/的项目操作$/.test(a)).slice(0,5).join('|')||'<none>'`],
    ["data-testid 数量", `document.querySelectorAll('[data-testid]').length`],
    ["button 总数", `document.querySelectorAll('button').length`],
  ];

  // SPA 首次渲染需要时间：先等到输入框（ProseMirror）出现，再逐项探测
  line("\n  等待 SPA 渲染（输入框就绪）…");
  let rendered = false;
  for (let i = 0; i < 45; i++) {
    try {
      const r = await ev(`document.querySelectorAll('div.ProseMirror[contenteditable="true"]').length`);
      if (Number(r.result?.value) > 0) {
        rendered = true;
        ok(`已渲染（第 ${i + 1} 次探测）`);
        break;
      }
    } catch {
      /* 继续等 */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!rendered) bad("超时未渲染输入框；后续结果可能为空（可加大等待或检查登录页）");

  for (const [label, expr] of probe) {
    try {
      const r = await ev(expr);
      ok(`${label} = ${JSON.stringify(r.result?.value)}`);
    } catch (e) {
      bad(`${label} 求值失败：${e.message}`);
    }
  }
  ws.close();
  return true;
}

async function main() {
  line("tianshu-mcp · Codex 真机诊断");
  line(`平台=${process.platform}  模式=${LAUNCH ? "启动" : "只读"}  端口=${PORT}\n`);
  if (process.platform !== "win32") {
    bad("Codex MSIX 通道仅支持 Windows");
    process.exit(1);
  }
  const { aumid } = discover();
  if (!aumid) {
    line("\n结论：本机未发现 Codex 桌面端，先安装后再运行本脚本。");
    process.exit(1);
  }
  processes();
  const launched = activate(aumid);
  if (launched || LAUNCH) await cdpProbe();
  else {
    line("\n提示：加 --launch 可启动受管实例并连 CDP 实测选择器。");
  }
  line("\n诊断结束（未杀实例；如需清理请手动关闭受管 profile 窗口）。");
}

main().catch((e) => {
  bad(`诊断异常：${e.message}`);
  process.exit(1);
});
