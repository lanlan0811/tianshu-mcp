/** Production-package smoke test. Uses only Node built-ins and the installed package. */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const index = process.argv.indexOf("--package-dir");
if (index < 0 || !process.argv[index + 1])
  throw new Error("Usage: node check-visual-consumer.mjs --package-dir <installed tianshu-mcp>");
const packageDirectory = await fs.realpath(process.argv[index + 1]);
const moduleFromPackage = (name) =>
  import(pathToFileURL(path.join(packageDirectory, "dist", name)).href);
const { AcceptanceEngine } = await moduleFromPackage("verify/acceptance.js");
const { TaskStore } = await moduleFromPackage("tasks/task-store.js");
const { Logger } = await moduleFromPackage("util/log.js");
const { resolveDataHome } = await moduleFromPackage("config/store.js");
const { prepareBaseline, approveBaseline } = await moduleFromPackage("visual/baselines.js");
const { loadSharp } = await moduleFromPackage("visual/runtime.js");
const { loadBrowserTools, resolveBrowser } = await moduleFromPackage("visual/runtime.js");
const project = await fs.mkdtemp(path.join(os.tmpdir(), "tianshu-consumer-visual-"));
const home = resolveDataHome();
const taskId = `tsk_consumer_${randomUUID()}`;
const logger = new Logger(null, "error"),
  store = new TaskStore(home, logger),
  engine = new AcceptanceEngine(store, logger);
let candidateId;
try {
  await fs.mkdir(path.join(project, ".tianshu-mcp"));
  await fs.writeFile(
    path.join(project, "index.html"),
    '<main style="width:100px;height:50px;background:red">Consumer</main>',
  );
  const sharp = await loadSharp();
  await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } })
    .png()
    .toFile(path.join(project, "image.png"));
  await fs.writeFile(
    path.join(project, ".tianshu-mcp", "acceptance.json"),
    JSON.stringify({
      checks: [],
      requireChanges: false,
      visual: {
        enabled: true,
        viewports: [{ id: "consumer", width: 200, height: 150 }],
        pages: [
          {
            id: "home",
            source: { type: "static", root: "." },
            route: "/index.html",
            readySelector: "main",
          },
        ],
        images: [{ id: "image", files: ["image.png"], width: { exact: 4 } }],
      },
    }),
  );
  const candidate = await prepareBaseline(home, { projectPath: project });
  candidateId = candidate.candidateId;
  await approveBaseline(home, {
    candidateId,
    expectedDigest: candidate.digest,
    approvalNote: "Explicit approval of isolated consumer test fixture",
  });
  const request = { taskId, projectPath: project, displayPath: project, round: 0, store, logger };
  const passed = await engine.runVerify(request);
  if (!passed.passed || passed.report.visual?.results.length !== 2)
    throw new Error(JSON.stringify(passed.report));
  await fs.writeFile(
    path.join(project, "index.html"),
    '<main style="width:100px;height:50px;background:blue">Consumer</main>',
  );
  const failed = await engine.runVerify(request);
  if (
    failed.passed ||
    failed.report.visual?.results.find((r) => r.kind === "page")?.code !== "PIXEL_DIFFERENCE"
  )
    throw new Error("Changed consumer screenshot did not fail");
  const html = await fs.readFile(failed.report.files.html, "utf8");
  if (!html.includes("Actual opacity") || !html.includes("Region 1"))
    throw new Error("Consumer report is missing visual controls");
  const { puppeteer } = await loadBrowserTools();
  const browser = await puppeteer.launch({
    executablePath: await resolveBrowser({ mode: "managed" }, home),
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setOfflineMode(true);
    await page.goto(pathToFileURL(failed.report.files.html).href);
    if (
      !(await page.evaluate(() =>
        [...document.images].every((image) => image.complete && image.naturalWidth > 0),
      ))
    )
      throw new Error("Offline report image failed to load");
    await page.select("#filter", "failed");
    if (
      !(await page.evaluate(() =>
        [...document.querySelectorAll("article")]
          .filter((article) => !article.hidden)
          .every((article) => article.dataset.status === "failed"),
      ))
    )
      throw new Error("Report status filter failed");
    await page.$eval(".opacity", (input) => {
      input.value = "0.25";
      input.dispatchEvent(new Event("input"));
    });
    if ((await page.$eval(".actual", (image) => image.style.opacity)) !== "0.25")
      throw new Error("Report opacity control failed");
    await page.click("button.region");
    if (
      (await page.$eval("rect[data-region='0']", (region) => region.getAttribute("stroke"))) !==
      "blue"
    )
      throw new Error("Report region selection failed");
    if (process.env.TIANSHU_VISUAL_REPORT_EVIDENCE) {
      await fs.mkdir(path.dirname(path.resolve(process.env.TIANSHU_VISUAL_REPORT_EVIDENCE)), {
        recursive: true,
      });
      await page.screenshot({
        path: path.resolve(process.env.TIANSHU_VISUAL_REPORT_EVIDENCE),
        fullPage: true,
      });
    }
  } finally {
    await browser.close();
  }
  console.log(
    JSON.stringify(
      {
        passed: true,
        packageDirectory,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        checks: [
          "approved screenshot",
          "image specification",
          "real screenshot defect",
          "offline report",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await engine.close();
  await fs.rm(project, { recursive: true, force: true });
  await fs.rm(store.dir(taskId), { recursive: true, force: true });
  if (candidateId)
    await fs.rm(path.join(home, "visual-candidates", candidateId), {
      recursive: true,
      force: true,
    });
}
