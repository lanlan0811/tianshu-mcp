import path from "node:path";
import fs from "node:fs/promises";
import { resolveDataHome } from "../config/store.js";
import { readAcceptanceConfig } from "./config.js";
import { doctor, installBrowser } from "./runtime.js";
import { VISUAL_DEFAULTS } from "./defaults.js";

/** Called before creating the MCP server. CLI output never enters protocol stdout. */
export async function runVisualCli(args: string[]): Promise<void> {
  const controller = new AbortController();
  const cancellable = args[0] === "baseline" && args[1] === "prepare";
  const cancel = (): void => {
    controller.abort();
  };
  if (cancellable) {
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
  }
  try {
    await dispatchVisualCli(args, controller.signal);
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

async function dispatchVisualCli(args: string[], signal: AbortSignal): Promise<void> {
  const home = resolveDataHome();
  const [command, ...rest] = args;
  if (command === "baseline" && rest.length === 2 && ["prepare", "approve"].includes(rest[0]!)) {
    const { prepareBaseline, approveBaseline, PrepareBaselineSchema, ApproveBaselineSchema } =
      await import("./baselines.js");
    const input: unknown = JSON.parse(await fs.readFile(path.resolve(rest[1]!), "utf8"));
    console.log(
      JSON.stringify(
        rest[0] === "prepare"
          ? await prepareBaseline(home, PrepareBaselineSchema.parse(input), signal)
          : await approveBaseline(home, ApproveBaselineSchema.parse(input)),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "rules") {
    const { reviewRules, approveRules } = await import("./manage.js");
    if (rest[0] === "review" && rest.length === 2) {
      console.log(JSON.stringify(await reviewRules(home, rest[1]!), null, 2));
      return;
    }
    if (rest[0] === "approve" && rest.length === 5) {
      console.log(
        JSON.stringify(await approveRules(home, rest[1]!, rest[2]!, rest[3]!, rest[4]!), null, 2),
      );
      return;
    }
  }
  if (
    command === "artifacts" &&
    rest[0] === "clean" &&
    (rest.length === 2 || (rest.length === 3 && rest[2] === "--apply"))
  ) {
    const { cleanArtifacts } = await import("./manage.js");
    console.log(
      JSON.stringify(await cleanArtifacts(home, rest[1]!, rest[2] === "--apply"), null, 2),
    );
    return;
  }
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
    "Usage: tianshu-mcp visual init [project] | doctor [project] | browser install | baseline prepare/approve <request.json> | rules review <taskId> | rules approve <taskId> <reviewId> <digest> <approval-note> | artifacts clean <taskId> [--apply]",
  );
}
