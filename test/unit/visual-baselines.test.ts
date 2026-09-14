import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareBaseline, approveBaseline } from "../../src/visual/baselines.js";
import { loadSharp } from "../../src/visual/runtime.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "visual-baselines-")); dirs.push(root);
  const project = path.join(root, "project"), home = path.join(root, "home");
  await fs.mkdir(path.join(project, ".tianshu-mcp"), { recursive: true });
  const config = { visual: { enabled: true, viewports: [{ id: "test", width: 20, height: 20 }], pages: [{ id: "home", source: { type: "static", root: "." } }] } };
  await fs.writeFile(path.join(project, ".tianshu-mcp", "acceptance.json"), JSON.stringify(config));
  const sharp = await loadSharp();
  await sharp({ create: { width: 20, height: 20, channels: 3, background: "red" } }).jpeg().toFile(path.join(project, "reference.jpg"));
  const candidate = await prepareBaseline(home, { projectPath: project, imports: [{ caseId: "home", viewportId: "test", file: "reference.jpg" }] });
  const approval = { candidateId: candidate.candidateId, expectedDigest: candidate.digest, approvalNote: "Explicit test user approval" };
  return { project, home, config, candidate, approval };
}
it("normalizes imported references and does not adopt until explicit approval", async () => {
  const h = await fixture();
  const target = path.join(h.project, h.candidate.entries[0]!.target);
  await expect(fs.access(target)).rejects.toThrow();
  await approveBaseline(h.home, h.approval);
  const sharp = await loadSharp();
  expect((await sharp(await fs.readFile(target)).metadata()).format).toBe("png");
  const manifest = JSON.parse(await fs.readFile(`${target}.manifest.json`, "utf8"));
  expect(manifest.approval.note).toBe(h.approval.approvalNote);
  expect(manifest.normalizedDigest).toBe(h.candidate.entries[0]!.digest);
});
it("rejects candidate image tampering", async () => {
  const h = await fixture();
  await fs.appendFile(path.join(h.home, "visual-candidates", h.candidate.candidateId, "home-test.png"), "changed");
  await expect(approveBaseline(h.home, h.approval)).rejects.toMatchObject({ code: "CANDIDATE_CHANGED" });
});
it("rejects configuration changes and concurrent adoption", async () => {
  const h = await fixture();
  const results = await Promise.allSettled([approveBaseline(h.home, h.approval), approveBaseline(h.home, h.approval)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  await expect(approveBaseline(h.home, h.approval)).rejects.toMatchObject({ code: "BASELINE_CHANGED" });
  h.config.visual.viewports[0]!.width = 21;
  await fs.writeFile(path.join(h.project, ".tianshu-mcp", "acceptance.json"), JSON.stringify(h.config));
  await expect(approveBaseline(h.home, h.approval)).rejects.toMatchObject({ code: "CONFIG_CHANGED" });
});
