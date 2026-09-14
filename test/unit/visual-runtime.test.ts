import { expect, it } from "vitest";
import { VisualConfigSchema } from "../../src/visual/schema.js";
import { assertVisualRuntime, loadBrowserTools } from "../../src/visual/runtime.js";

it("centralizes visual defaults and rejects invalid enabled configurations", () => {
  expect(VisualConfigSchema.parse({}).enabled).toBe(false);
  expect(VisualConfigSchema.parse({}).defaults.maxDiffRatio).toBe(0.001);
  expect(VisualConfigSchema.safeParse({ enabled: true }).success).toBe(false);
  expect(VisualConfigSchema.safeParse({ unknownSetting: true }).success).toBe(false);
  expect(VisualConfigSchema.safeParse({ limits: { concurrency: 5 } }).success).toBe(false);
});
it("loads the browser revision from the installed pinned dependency", async () => {
  const { revisions } = await loadBrowserTools();
  expect(revisions.PUPPETEER_REVISIONS.chrome).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  expect(() => assertVisualRuntime("20.2.0")).toThrow();
  expect(() => assertVisualRuntime("20.3.0")).not.toThrow();
});
