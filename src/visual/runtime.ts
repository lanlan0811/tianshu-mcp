import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { VisualError } from "./errors.js";
import { projectFile } from "./paths.js";
import { contentCommandParts, hasContentRules, contentRulesOf } from "./content.js";
import { resolveCommandPath } from "./content-command.js";
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
  // 内容校验诊断（issue #13 F 组）：逐条有效命令的解析结果 + allowRemote 声明清单、
  // 规则数 × samples × timeoutMs 与 roundTimeoutMs 的预算对比（超预算给出建议值，不自动改配置）
  await check("content command", async () => {
    const visual = (await readAcceptanceConfig(projectPath))?.visual;
    if (!visual?.content.enabled || !hasContentRules(visual)) return "disabled (no content rules)";
    const lines: string[] = [];
    const unresolved: string[] = [];
    for (const rule of contentRulesOf(visual)) {
      const effective = contentCommandParts(visual, rule.check);
      const cwd = await projectFile(projectPath, effective.cwd);
      const resolved = await resolveCommandPath(effective.command, cwd);
      if (!resolved) unresolved.push(rule.label);
      lines.push(
        `${rule.label}: ${effective.command} -> ${
          resolved ?? "UNRESOLVED (will block the whole round)"
        }; allowRemote=${effective.allowRemote}`,
      );
    }
    // 有效命令不可解析会让整轮配置错误（assertContentReady 抛错），诊断必须据实报失败
    if (unresolved.length)
      throw new VisualError(
        "CONTENT_COMMAND_MISSING",
        `unresolved content judge command for: ${unresolved.join(", ")}; ${lines.join("; ")}`,
      );
    return lines.join("; ");
  });
  await check("content budget", async () => {
    const visual = (await readAcceptanceConfig(projectPath))?.visual;
    if (!visual?.content.enabled || !hasContentRules(visual)) return "disabled (no content rules)";
    const rules = contentRulesOf(visual);
    const totalMs = rules.reduce(
      (sum, r) => sum + (r.check.samples ?? visual.content.samples) * visual.content.timeoutMs,
      0,
    );
    const limit = visual.limits.roundTimeoutMs;
    if (totalMs > limit)
      return `advisory: worst case ${totalMs}ms across ${rules.length} content rule(s) exceeds limits.roundTimeoutMs ${limit}ms; raise limits.roundTimeoutMs if rules regularly run uncached`;
    return `${rules.length} rule(s) x samples x ${visual.content.timeoutMs}ms = ${totalMs}ms <= roundTimeoutMs ${limit}ms`;
  });
  return { passed: findings.every((f) => f.passed), findings };
}
