#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { execFileSync } from "node:child_process";

const command = process.argv[2] ?? "all";
const json = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const powershell = (script) => {
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    }).trim();
  } catch {
    return "";
  }
};

function processInfo() {
  if (process.platform === "win32") {
    return powershell(
      "Get-CimInstance Win32_Process -Filter \"Name='ZCode.exe'\" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Depth 3",
    );
  }
  try {
    return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
      .split(/\r?\n/)
      .filter((line) => /ZCode/i.test(line));
  } catch {
    return [];
  }
}

function installations() {
  const candidates = [];
  if (process.platform === "win32") {
    const drives = powershell(
      "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object -ExpandProperty DeviceID",
    )
      .split(/\r?\n/)
      .filter(Boolean);
    const ordered = [
      ...drives.filter((d) => /^D:$/i.test(d)),
      ...drives.filter((d) => !/^D:$/i.test(d)),
    ];
    for (const drive of ordered)
      for (const rel of ["Z-Code/ZCode/ZCode.exe", "ZCode/ZCode.exe"])
        candidates.push(path.win32.join(`${drive}\\`, rel));
    for (const dir of [
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs"),
    ].filter(Boolean))
      candidates.push(path.join(dir, "ZCode", "ZCode.exe"));
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/ZCode.app/Contents/MacOS/ZCode",
      path.join(os.homedir(), "Applications/ZCode.app/Contents/MacOS/ZCode"),
    );
  }
  return candidates
    .filter((candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    })
    .map((candidate) => ({
      path: candidate,
      version:
        process.platform === "win32"
          ? powershell(
              `(Get-Item -LiteralPath '${candidate.replaceAll("'", "''")}').VersionInfo.FileVersion`,
            )
          : undefined,
    }));
}

async function cdpTargets() {
  const raw = JSON.stringify(processInfo());
  const ports = [...raw.matchAll(/--remote-debugging-port(?:=|\s+)(\d+)/g)].map((match) =>
    Number(match[1]),
  );
  const output = [];
  for (const port of ports) {
    output.push(
      await new Promise((resolve) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/json", timeout: 2_000 }, (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => {
            try {
              resolve({
                port,
                targets: JSON.parse(body).map(({ type, title, url }) => ({ type, title, url })),
              });
            } catch (e) {
              resolve({ port, error: e.message });
            }
          });
        });
        req.on("error", (e) => resolve({ port, error: e.message }));
        req.on("timeout", () => {
          req.destroy();
          resolve({ port, error: "timeout" });
        });
      }),
    );
  }
  return output;
}

async function uiState() {
  const endpoints = await cdpTargets();
  const endpoint = endpoints.find((item) =>
    item.targets?.some(
      (target) =>
        target.type === "page" && /z[ -]?code/i.test(`${target.title ?? ""} ${target.url ?? ""}`),
    ),
  );
  if (!endpoint) return { ok: false, message: "没有通过产品标识核验的 ZCode CDP 页面" };
  try {
    const [{ ZcodeCdpClient }, { ZCODE_SELECTORS }] = await Promise.all([
      import("../dist/agents/zcode/cdp.js"),
      import("../dist/agents/zcode/selectors.js"),
    ]);
    const client = new ZcodeCdpClient(endpoint.port, 10_000, {});
    await client.connect();
    try {
      const presence = {};
      for (const key of Object.keys(ZCODE_SELECTORS)) presence[key] = await client.exists(key);
      const visibleOptions = async (key) =>
        client.evaluate(
          `(function(){const out=[];for(const s of ${JSON.stringify([ZCODE_SELECTORS[key].primary, ...ZCODE_SELECTORS[key].fallbacks])})for(const e of document.querySelectorAll(s)){const r=e.getBoundingClientRect();const t=(e.getAttribute('data-value')||e.getAttribute('data-model')||e.getAttribute('data-provider')||e.textContent||'').trim();if(r.width&&r.height&&t&&!out.includes(t))out.push(t)}return out})()`,
        );
      return {
        ok: true,
        port: endpoint.port,
        target: endpoint.targets.find((target) => target.type === "page"),
        selectors: presence,
        project: { boundPath: await client.boundProjectPath(), items: await client.projects() },
        model: {
          selected: await client.selection("modelValue"),
          visibleProviders: await visibleOptions("providerOption"),
          visibleModels: await visibleOptions("modelOption"),
        },
        permission: {
          selected: await client.text("permissionValue"),
          visibleOptions: await visibleOptions("permissionOption"),
        },
        liveness: await client.poll(),
        session: await client.session(),
      };
    } finally {
      client.disconnect();
    }
  } catch (e) {
    return {
      ok: false,
      port: endpoint.port,
      message: `UI 诊断失败：${e.message}。请先执行 npm run build。`,
    };
  }
}

async function menuControls(kind) {
  const endpoints = await cdpTargets();
  const endpoint = endpoints.find((item) =>
    item.targets?.some(
      (target) =>
        target.type === "page" && /z[ -]?code/i.test(`${target.title ?? ""} ${target.url ?? ""}`),
    ),
  );
  if (!endpoint) return { ok: false, message: "没有通过产品标识核验的 ZCode CDP 页面" };
  const triggerKey = { model: "modelTrigger", permission: "permissionTrigger", project: "projectTrigger" }[
    kind
  ];
  if (!triggerKey) return { ok: false, message: `未知菜单：${kind}` };
  try {
    const { ZcodeCdpClient } = await import("../dist/agents/zcode/cdp.js");
    const client = new ZcodeCdpClient(endpoint.port, 10_000, {});
    await client.connect();
    try {
      const pressEscape = async () => {
        await client.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
          nativeVirtualKeyCode: 27,
        });
        await client.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
          nativeVirtualKeyCode: 27,
        });
      };
      for (let i = 0; i < 4; i++) await pressEscape();
      if (!(await client.click(triggerKey)))
        return { ok: false, message: `找不到 ${kind} 菜单入口` };
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (kind === "model") {
        const providerPoint = await client.evaluate(
          `(function(){const e=document.querySelector('[data-testid^="chat-model-select-group-provider:"]');if(!e)return null;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.left+r.width/2,y:r.top+r.height/2}:null})()`,
        );
        if (providerPoint) {
          await client.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: providerPoint.x,
            y: providerPoint.y,
          });
          await new Promise((resolve) => setTimeout(resolve, 700));
        }
      }
      const controls = await client.evaluate(
        `(function(){const clean=s=>(s||'').replace(/\\s+/g,' ').trim().slice(0,160);const leaf=e=>[...e.querySelectorAll('*')].filter(n=>n.children.length===0).map(n=>clean(n.textContent)).filter(Boolean);const roles=new Set(['menu','listbox','menuitem','menuitemradio','menuitemcheckbox','option']);const nodes=[...document.querySelectorAll('body *')].filter(function(e){const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&roles.has(e.getAttribute('role'));});return nodes.slice(-100).map(function(e){return {role:e.getAttribute('role')||undefined,testid:e.getAttribute('data-testid')||undefined,text:clean(e.textContent),labels:leaf(e)};});})()`,
      );
      for (let i = 0; i < 4; i++) await pressEscape();
      return controls;
    } finally {
      client.disconnect();
    }
  } catch (e) {
    return { ok: false, port: endpoint.port, message: `菜单诊断失败：${e.message}` };
  }
}

async function modelState() {
  const state = await uiState();
  if (!state.ok) return state;
  const controls = await menuControls("model");
  if (!Array.isArray(controls)) return controls;
  return {
    selected: state.model.selected,
    providers: controls
      .filter((item) => item.testid?.startsWith("chat-model-select-group-provider:"))
      .map((item) => ({ display: item.labels?.[0] ?? item.text, id: item.testid.split(":").at(-1) })),
    models: controls
      .filter((item) => item.testid?.startsWith("chat-model-select-item-"))
      .map((item) => ({
        display: item.labels?.[0] ?? item.text,
        id: item.testid.split(":").at(-1),
      })),
  };
}

async function permissionState() {
  const state = await uiState();
  if (!state.ok) return state;
  const controls = await menuControls("permission");
  if (!Array.isArray(controls)) return controls;
  return {
    selected: state.permission.selected,
    options: controls
      .filter((item) => item.testid?.startsWith("chat-mode-select-item-"))
      .map((item) => ({
        display: item.labels?.[0] ?? item.text,
        id: item.testid.slice("chat-mode-select-item-".length),
      })),
  };
}

if (command === "install") json(installations());
else if (command === "process") json(processInfo());
else if (command === "cdp") json(await cdpTargets());
else if (command === "models") json(await modelState());
else if (command === "permission") json(await permissionState());
else if (command === "selectors")
  json({
    source: "src/agents/zcode/selectors.ts",
    state: (await uiState()).selectors,
    note: "可通过 agent-profiles.json 的 gui.selectors 热覆盖",
  });
else if (["ui", "projects", "liveness", "session"].includes(command)) {
  const state = await uiState();
  const key = {
    projects: "project",
    liveness: "liveness",
    session: "session",
  }[command];
  json(key && state.ok ? state[key] : state);
} else if (command === "all")
  json({
    install: installations(),
    processes: processInfo(),
    cdp: await cdpTargets(),
    ui: await uiState(),
  });
else {
  process.stderr.write(
    "用法: probe-zcode.mjs [all|install|process|cdp|selectors|ui|projects|models|permission|liveness|session]\n",
  );
  process.exitCode = 2;
}
