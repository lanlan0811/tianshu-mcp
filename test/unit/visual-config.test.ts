import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VisualConfigSchema } from "../../src/visual/schema.js";
import { readAcceptanceConfig } from "../../src/visual/config.js";
import { assertVisualRuntime, resolveBrowser } from "../../src/visual/runtime.js";
import { AcceptanceEngine } from "../../src/verify/acceptance.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { Logger } from "../../src/util/log.js";

const dirs: string[] = [];
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "visual-config-"));
  dirs.push(dir);
  await fs.mkdir(path.join(dir, ".tianshu-mcp"));
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
describe("visual configuration", () => {
  it("preserves omitted commands versus explicitly empty commands", async () => {
    const dir = await fixture();
    expect(await readAcceptanceConfig(dir)).toBeNull();
    const file = path.join(dir, ".tianshu-mcp", "acceptance.json");
    await fs.writeFile(file, JSON.stringify({ visual: { enabled: false } }));
    expect((await readAcceptanceConfig(dir))?.checks).toBeUndefined();
    await fs.writeFile(file, JSON.stringify({ checks: [] }));
    expect((await readAcceptanceConfig(dir))?.checks).toEqual([]);
  });
  it.each([
    { enabled: true },
    { enabled: false, typo: 1 },
    { defaults: { maxDiffRatio: 1.001 } },
    { images: [{ id: "a", files: ["../secret.png"] }] },
    {
      images: [
        { id: "a", files: ["a.png"] },
        { id: "A", files: ["b.png"] },
      ],
    },
    { pages: [{ id: "a", source: { type: "existing", url: "https://example.com" } }] },
    { allowedOrigins: ["https://example.com/path"] },
    { images: [{ id: "a", files: ["a.png"], width: { exact: 2, max: 3 } }] },
    { pages: [{ id: "a", source: { type: "static", root: "." }, steps: [{ type: "wait" }] }] },
  ])("rejects invalid rules: %j", (config) => {
    expect(VisualConfigSchema.safeParse(config).success).toBe(false);
  });
  it("accepts inclusive threshold boundaries and centralized defaults", () => {
    const parsed = VisualConfigSchema.parse({ defaults: { maxDiffRatio: 0, pixelThreshold: 1 } });
    expect(parsed.limits.concurrency).toBe(1);
    expect(parsed.viewports.map((v) => v.id)).toEqual(["desktop", "mobile"]);
  });
  it("blocks malformed config even when temporary checks replace commands", async () => {
    const dir = await fixture();
    await fs.writeFile(path.join(dir, ".tianshu-mcp", "acceptance.json"), "{");
    const logger = new Logger(null, "error");
    const store = new TaskStore(dir, logger);
    const { report, passed } = await new AcceptanceEngine(store, logger).runVerify({
      taskId: "tsk_invalid",
      projectPath: dir,
      displayPath: dir,
      round: 0,
      store,
      logger,
      checksMode: "replace",
      extraChecks: [
        {
          name: "should-not-run",
          cmd: [process.execPath, "-e", "process.exit(0)"],
          displayCmd: "node",
        },
      ],
    });
    expect(passed).toBe(false);
    expect(report.blockingIssues?.[0]?.code).toBe("CONFIG_INVALID");
    expect(report.checks.some((c) => c.name === "should-not-run")).toBe(false);
  });
  it("reports missing browser instead of falling back", async () => {
    await expect(resolveBrowser({ mode: "managed" }, await fixture())).rejects.toMatchObject({
      code: "BROWSER_MISSING",
    });
  });
  it("requires Node 20.3 only for visual runtime", () => {
    expect(() => assertVisualRuntime("20.2.0")).toThrow();
    expect(() => assertVisualRuntime("20.3.0")).not.toThrow();
    expect(() => assertVisualRuntime("24.0.0")).not.toThrow();
  });
});
