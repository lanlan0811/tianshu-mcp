import path from "node:path";
import fs from "node:fs/promises";
import { resolveDataHome } from "../config/store.js";
import { readAcceptanceConfig } from "./config.js";
import { doctor, installBrowser } from "./runtime.js";
import { VISUAL_DEFAULTS } from "./defaults.js";

/** Called before creating the MCP server. CLI output never enters protocol stdout. */
export async function runVisualCli(args: string[]): Promise<void> {
  const home = resolveDataHome();
  const [command, ...rest] = args;
  if (command === "browser" && rest[0] === "install" && rest.length === 1) {
    console.log(await installBrowser(home));
    return;
  }
  if ((command === "doctor" || command === "init") && rest.length <= 1) {
    const project = path.resolve(rest[0] ?? process.cwd());
    if (command === "doctor") {
      const result = await doctor(project, home);
      console.log(JSON.stringify(result, null, 2));
      if (!result.passed) process.exitCode = 1;
      return;
    }
    await readAcceptanceConfig(project);
    const filename = path.join(project, ".tianshu-mcp", "acceptance.json");
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(await fs.readFile(filename, "utf8")) as Record<string, unknown>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (raw.visual !== undefined)
      throw new Error("Visual configuration already exists; edit it explicitly");
    raw.visual = {
      enabled: false,
      browser: { mode: "managed" },
      baselineRoot: VISUAL_DEFAULTS.baselineRoot,
      viewports: VISUAL_DEFAULTS.viewports,
      allowedOrigins: [],
      pages: [],
      images: [],
    };
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const { writeJsonAtomic } = await import("../util/fs.js");
    await writeJsonAtomic(filename, raw);
    console.log(
      `Created disabled visual template: ${filename}\nAdd pages or images before enabling. Baselines require explicit user approval.`,
    );
    return;
  }
  throw new Error(
    "Usage: tianshu-mcp visual init [project] | doctor [project] | browser install",
  );
}
