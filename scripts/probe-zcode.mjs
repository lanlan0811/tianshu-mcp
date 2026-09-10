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

if (command === "install") json(installations());
else if (command === "process") json(processInfo());
else if (command === "cdp") json(await cdpTargets());
else if (command === "selectors")
  json({
    source: "src/agents/zcode/selectors.ts",
    note: "可通过 agent-profiles.json 的 gui.selectors 热覆盖",
  });
else if (command === "all")
  json({ install: installations(), processes: processInfo(), cdp: await cdpTargets() });
else {
  process.stderr.write("用法: probe-zcode.mjs [all|install|process|cdp|selectors]\n");
  process.exitCode = 2;
}
