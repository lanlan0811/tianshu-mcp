import { expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { VisualConfigSchema } from "../../src/visual/schema.js";
import { assertVisualRuntime, doctor, loadBrowserTools } from "../../src/visual/runtime.js";

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

/** F 组：doctor 的 content command / content budget 两项 finding */
async function doctorFixture(
  content: Record<string, unknown>,
  rules: unknown[],
  visualEnabled = true,
): Promise<{ project: string; home: string }> {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "visual-doctor-proj-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "visual-doctor-home-"));
  await fs.mkdir(path.join(project, ".tianshu-mcp"), { recursive: true });
  await fs.writeFile(
    path.join(project, ".tianshu-mcp", "acceptance.json"),
    JSON.stringify({
      visual: { enabled: visualEnabled, content, contents: rules },
    }),
  );
  return { project, home };
}

it("doctor reports content rules as disabled when there are none", async () => {
  // 顶层 visual 未启用（无任何规则时启用会被 schema 拒绝）
  const { project, home } = await doctorFixture({ enabled: false }, [], false);
  const result = await doctor(project, home);
  const byName = Object.fromEntries(result.findings.map((f) => [f.check, f]));
  expect(byName["content command"]!.passed).toBe(true);
  expect(byName["content command"]!.detail).toContain("disabled");
  expect(byName["content budget"]!.passed).toBe(true);
});

it("doctor resolves each effective content command and lists allowRemote", async () => {
  const { project, home } = await doctorFixture(
    {
      enabled: true,
      command: process.execPath,
      argsTemplate: ["-e", "0", "<image:path>"],
      samples: 2,
      timeoutMs: 30_000,
    },
    [{ id: "logo", files: ["assets/logo.png"], expect: "blue logo" }],
  );
  const result = await doctor(project, home);
  const command = result.findings.find((f) => f.check === "content command")!;
  expect(command.passed).toBe(true);
  expect(command.detail).toContain("allowRemote=false");
  const budget = result.findings.find((f) => f.check === "content budget")!;
  expect(budget.passed).toBe(true);
  expect(budget.detail).toContain("60000ms");
});

it("doctor fails the content command finding when a rule command cannot resolve", async () => {
  const { project, home } = await doctorFixture(
    { enabled: true, command: "definitely-missing-vision-cli-xyz", argsTemplate: ["x"] },
    [{ id: "logo", files: ["assets/logo.png"], expect: "blue logo" }],
  );
  const result = await doctor(project, home);
  const command = result.findings.find((f) => f.check === "content command")!;
  expect(command.passed).toBe(false);
  expect(command.detail).toContain("logo");
  expect(result.passed).toBe(false);
});

it("doctor reports an advisory when the total content budget exceeds roundTimeoutMs", async () => {
  // 每条规则自身自洽（3 × 90000 = 270000 ≤ 300000），但两条叠加 540000 > 300000 → 只给建议值，不自动改配置
  const { project, home } = await doctorFixture(
    {
      enabled: true,
      command: process.execPath,
      argsTemplate: ["-e", "0", "<image:path>"],
      samples: 3,
      timeoutMs: 90_000,
    },
    [
      { id: "logo", files: ["assets/logo.png"], expect: "blue logo" },
      { id: "hero", files: ["assets/hero.png"], expect: "flat illustration" },
    ],
  );
  const result = await doctor(project, home);
  const budget = result.findings.find((f) => f.check === "content budget")!;
  expect(budget.passed).toBe(true); // 建议而非阻塞
  expect(budget.detail).toContain("advisory");
  expect(budget.detail).toContain("540000ms");
  expect(budget.detail).toContain("300000ms");
});
