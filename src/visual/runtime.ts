import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { VisualError } from "./errors.js";
import type { VisualConfig } from "./schema.js";

export function assertVisualRuntime(version = process.versions.node): void {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 3))
    throw new VisualError("RUNTIME_UNSUPPORTED", "Visual acceptance requires Node.js >=20.3");
}
export async function loadSharp() {
  assertVisualRuntime();
  try {
    return (await import("sharp")).default;
  } catch {
    throw new VisualError(
      "IMAGE_DEPENDENCY_MISSING",
      "Install optional image dependencies: npm install --include=optional",
    );
  }
}
export async function loadBrowserTools() {
  assertVisualRuntime();
  try {
    const [puppeteer, browsers, revisions] = await Promise.all([
      import("puppeteer-core"),
      import("@puppeteer/browsers"),
      import("puppeteer-core/internal/revisions.js"),
    ]);
    return { puppeteer, browsers, revisions };
  } catch {
    throw new VisualError(
      "BROWSER_DEPENDENCY_MISSING",
      "Reinstall tianshu-mcp browser dependencies",
    );
  }
}
export async function installBrowser(home: string): Promise<string> {
  const { revisions, browsers } = await loadBrowserTools();
  const result = await browsers.install({
    browser: browsers.Browser.CHROME,
    buildId: revisions.PUPPETEER_REVISIONS.chrome,
    cacheDir: path.join(home, "browsers"),
  });
  return result.executablePath;
}
export async function resolveBrowser(
  config: VisualConfig["browser"],
  home: string,
): Promise<string> {
  const { revisions, browsers } = await loadBrowserTools();
  let candidates: string[] = [];
  if (config.mode === "managed") {
    candidates = [
      browsers.computeExecutablePath({
        browser: browsers.Browser.CHROME,
        buildId: revisions.PUPPETEER_REVISIONS.chrome,
        cacheDir: path.join(home, "browsers"),
      }),
    ];
  } else if (config.executablePath) candidates = [config.executablePath];
  else if (process.platform === "win32") {
    const suffix =
      config.mode === "edge"
        ? "Microsoft/Edge/Application/msedge.exe"
        : "Google/Chrome/Application/chrome.exe";
    candidates = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ]
      .filter((v): v is string => !!v)
      .map((v) => path.join(v, suffix));
  } else if (process.platform === "darwin") {
    const app = config.mode === "edge" ? "Microsoft Edge" : "Google Chrome";
    candidates = ["/Applications", path.join(os.homedir(), "Applications")].map((p) =>
      path.join(p, `${app}.app`, "Contents", "MacOS", app),
    );
  } else {
    candidates = (process.env.PATH ?? "")
      .split(path.delimiter)
      .map((p) => path.join(p, config.mode === "edge" ? "microsoft-edge" : "google-chrome"));
  }
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* next */
    }
  }
  throw new VisualError(
    "BROWSER_MISSING",
    config.mode === "managed"
      ? "Managed browser missing. Run: tianshu-mcp visual browser install"
      : "Selected browser missing; configure browser.executablePath",
  );
}
export async function doctor(projectPath: string, home: string) {
  const { readAcceptanceConfig } = await import("./config.js");
  const findings: { check: string; passed: boolean; detail: string }[] = [];
  const check = async (name: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      const result = await run();
      findings.push({
        check: name,
        passed: true,
        detail: typeof result === "string" ? result : "OK",
      });
    } catch (e) {
      findings.push({ check: name, passed: false, detail: String(e) });
    }
  };
  await check("runtime", async () => {
    assertVisualRuntime();
    return `${process.platform}/${process.arch}; Node ${process.versions.node}; OS ${os.release()}`;
  });
  await check("image dependency", loadSharp);
  await check("configuration", async () => {
    await readAcceptanceConfig(projectPath);
  });
  await check("browser", async () =>
    resolveBrowser(
      (await readAcceptanceConfig(projectPath))?.visual?.browser ?? { mode: "managed" },
      home,
    ),
  );
  return { passed: findings.every((f) => f.passed), findings };
}
