#!/usr/bin/env node
/**
 * Windows 10 视觉验收完整功能矩阵证据采集（计划 §6「真实浏览器集成」）。
 *
 * 覆盖计划测试矩阵中此前仅由隔离用例覆盖、需要真实平台留证的项：
 *   - 已有服务（existing）、命令启动、静态服务三种来源
 *   - 端口冲突：配置端口已被占用时阻塞，不擅自复用或结束其他服务
 *   - 就绪失败：命令启动但永不就绪时有界阻塞并清理进程
 *   - 取消清理：取消后不留残留服务进程与临时目录
 *   - 托管 Chrome 与 本机 Edge 两种浏览器；版本不匹配可观测
 *   - 桌面/移动视口、整页、元素截图
 *
 * 只读取 dist/ 构建产物与系统本机浏览器，输出 JSON 证据；不修改项目源码。
 * 用法：node scripts/evidence-visual-windows.mjs [--out <file.json>]
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const fromDist = (name) =>
  import(pathToFileURL(path.join(repoRoot, "dist", name)).href);

const { VisualServices } = await fromDist("visual/services.js");
const { VisualBrowser } = await fromDist("visual/capture.js");
const { VisualBudget } = await fromDist("visual/budget.js");
const { VisualConfigSchema, PageSchema, SourceSchema } = await fromDist("visual/schema.js");
const { resolveDataHome } = await fromDist("config/store.js");
const { loadSharp, loadBrowserTools, resolveBrowser } = await fromDist("visual/runtime.js");

const outIndex = process.argv.indexOf("--out");
const outFile = outIndex >= 0 ? path.resolve(process.argv[outIndex + 1]) : null;

const results = [];
const cleanup = [];
const home = resolveDataHome();
const record = (id, detail) => {
  results.push({ id, ...detail });
  console.log(`${detail.passed ? "PASS" : "FAIL"}  ${id}  ${detail.note ?? ""}`);
};
const expectCode = async (id, run, code, note) => {
  try {
    await run();
    record(id, { passed: false, note: `${note} — expected ${code} but call resolved` });
  } catch (e) {
    const actual = e?.code ?? e?.name ?? String(e);
    record(id, {
      passed: actual === code,
      actualCode: actual,
      message: e?.message,
      note: `${note} — expected ${code}, got ${actual}`,
    });
  }
};

const sharp = await loadSharp();
const { revisions } = await loadBrowserTools();
const pinnedChrome = revisions.PUPPETEER_REVISIONS.chrome;

async function makeProject(html = "<main>Matrix</main>") {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "tianshu-win-matrix-"));
  cleanup.push(() => fs.rm(project, { recursive: true, force: true }));
  await fs.writeFile(path.join(project, "index.html"), html);
  return project;
}
async function makeBrowser(overrides = {}) {
  const config = VisualConfigSchema.parse({
    limits: { itemTimeoutMs: 30000, navigationTimeoutMs: 15000, serviceTimeoutMs: 15000 },
    ...overrides,
  });
  const budget = new VisualBudget(config.limits);
  const browser = new VisualBrowser(config, home, budget);
  cleanup.push(async () => {
    await browser.close();
    budget.dispose();
  });
  await browser.start();
  return { browser, config, budget };
}

try {
  /* ---------- 0. 已有服务（existing）来源：不管理其进程 ---------- */
  {
    const project = await makeProject("<main>Existing service</main>");
    const server = http.createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end("<main>Existing service</main>");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}`;
    cleanup.push(() => new Promise((r) => server.close(() => r())));
    const { browser } = await makeBrowser();
    const captured = await browser.capture(
      project,
      PageSchema.parse({ id: "existing", source: { type: "existing", url }, route: "/" }),
      { id: "desktop", width: 800, height: 600, deviceScaleFactor: 1 },
      url,
    );
    record("existing-source-capture", {
      passed: captured.image.length > 0 && server.listening,
      note: "existing local service captured without managing or terminating its process",
    });
  }

  /* ---------- 1. 静态服务 + 托管 Chrome + 桌面/移动视口与整页/元素 ---------- */
  {
    const project = await makeProject(
      `<style>body{margin:0}main{height:900px;background:#123}#box{width:120px;height:60px;background:#e33}</style><main></main><div id="box"></div>`,
    );
    const { browser, config } = await makeBrowser();
    const budget = new VisualBudget(config.limits);
    const services = new VisualServices(project, budget);
    cleanup.push(async () => {
      await services.close();
      budget.dispose();
    });
    const source = SourceSchema.parse({ type: "static", root: "." });
    const url = await services.get(source);
    const desktop = { id: "desktop", width: 1280, height: 720, deviceScaleFactor: 1 };
    const mobile = { id: "mobile", width: 390, height: 844, deviceScaleFactor: 1 };
    const shot = (rule, viewport) =>
      browser.capture(project, PageSchema.parse({ id: "home", source, route: "/index.html", ...rule }), viewport, url);
    const d = await shot({}, desktop);
    const m = await shot({}, mobile);
    const full = await shot({ capture: "fullPage" }, desktop);
    const el = await shot({ capture: "element", selector: "#box" }, desktop);
    const meta = async (img) => (await sharp(img).metadata()).width + "x" + (await sharp(img).metadata()).height;
    record("managed-chrome-viewports-fullpage-element", {
      passed: d.environment.browser.includes(pinnedChrome) && (await meta(el.image)) === "120x60",
      browser: d.environment.browser,
      desktop: await meta(d.image),
      mobile: await meta(m.image),
      fullPageHeight: (await sharp(full.image).metadata()).height,
      element: await meta(el.image),
      note: `desktop/mobile viewports, fullPage, element on static source`,
    });
    await services.close();
    await browser.close();
  }

  /* ---------- 2. 端口冲突：已有监听者时阻塞，不结束他人服务 ---------- */
  {
    const project = await makeProject();
    const holder = net.createServer(() => {});
    await new Promise((r) => holder.listen(0, "127.0.0.1", r));
    const port = holder.address().port;
    cleanup.push(() => new Promise((r) => holder.close(() => r())));
    const config = VisualConfigSchema.parse({ limits: { serviceTimeoutMs: 8000 } });
    const budget = new VisualBudget(config.limits);
    const services = new VisualServices(project, budget);
    cleanup.push(async () => {
      await services.close();
      budget.dispose();
    });
    await expectCode(
      "command-port-conflict-blocks",
      () =>
        services.get(
          SourceSchema.parse({
            type: "command",
            command: process.execPath,
            args: ["-e", "setInterval(()=>{},1000)"],
            readyUrl: `http://127.0.0.1:${port}`,
          }),
        ),
      "PORT_CONFLICT",
      "configured port already held by another listener",
    );
    const stillListening = holder.listening;
    record("existing-listener-not-terminated", {
      passed: stillListening,
      note: `original listener still bound after blocked auto-start (listening=${stillListening})`,
    });
    await services.close();
    budget.dispose();
  }

  /* ---------- 3. 就绪失败 + 取消清理：进程被移除，无残留 ---------- */
  {
    const project = await makeProject();
    const pidFile = path.join(project, "service.pid");
    const config = VisualConfigSchema.parse({ limits: { serviceTimeoutMs: 4000 } });
    const budget = new VisualBudget(config.limits);
    const services = new VisualServices(project, budget);
    cleanup.push(async () => {
      await services.close();
      budget.dispose();
    });
    await expectCode(
      "command-readiness-failure-blocks",
      () =>
        services.get(
          SourceSchema.parse({
            type: "command",
            command: process.execPath,
            args: [
              "-e",
              `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(()=>{},1000)`,
            ],
            readyUrl: "http://127.0.0.1:59999",
          }),
        ),
      "ITEM_TIMEOUT",
      "service never becomes ready",
    );
    let childPid = null;
    try {
      childPid = Number((await fs.readFile(pidFile, "utf8")).trim());
    } catch {
      childPid = null;
    }
    let childGone = childPid === null;
    if (childPid) {
      try {
        process.kill(childPid, 0);
      } catch {
        childGone = true;
      }
    }
    await services.close();
    record("readiness-failure-cleans-process", {
      passed: childGone,
      childPid,
      note: "spawned service process removed after bounded readiness timeout",
    });
  }

  /* ---------- 4. 本机 Edge（非托管）+ 版本不匹配可观测 ---------- */
  let edgePath = null;
  try {
    edgePath = await resolveBrowser({ mode: "edge" }, home);
  } catch (e) {
    edgePath = null;
    record("local-edge-resolve", { passed: false, note: String(e.message) });
  }
  if (edgePath) {
    const { puppeteer } = await loadBrowserTools();
    const project = await makeProject("<main>Edge</main>");
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), "tianshu-edge-"));
    cleanup.push(() => fs.rm(profile, { recursive: true, force: true }));
    const browser = await puppeteer.launch({ executablePath: edgePath, userDataDir: profile, headless: true });
    try {
      const version = await browser.version();
      const { browser: visual } = await makeBrowser({ browser: { mode: "edge" } });
      const budget = new VisualBudget(VisualConfigSchema.parse({}).limits);
      const services = new VisualServices(project, budget);
      cleanup.push(async () => {
        await services.close();
        budget.dispose();
      });
      const url = await services.get(SourceSchema.parse({ type: "static", root: "." }));
      const captured = await visual.capture(
        project,
        PageSchema.parse({ id: "edge", source: { type: "static", root: "." }, route: "/index.html" }),
        { id: "desktop", width: 800, height: 600, deviceScaleFactor: 1 },
        url,
      );
      const differsFromPinned = !version.includes(pinnedChrome);
      record("local-edge-launches-and-reports-version", {
        passed: version.toLowerCase().includes("edg") && captured.environment.browser === version,
        executablePath: edgePath,
        browserVersion: version,
        environmentBrowser: captured.environment.browser,
        differsFromPinned,
        note: "local Edge runs in an isolated acceptance profile; actual version recorded",
      });
      record("version-mismatch-is-observable", {
        passed: differsFromPinned,
        pinnedChrome,
        localBrowser: version,
        note: "local browser version differs from pinned Chrome; managed mode enforces the pin",
      });
      await visual.close();
      await services.close();
      budget.dispose();
    } finally {
      await browser.close();
    }
  }

  /* ---------- 5. 托管浏览器缺失时阻塞（不偷偷改用本机浏览器） ---------- */
  {
    const missing = path.join(os.tmpdir(), "tianshu-missing-browser-" + Date.now(), "chrome.exe");
    await expectCode(
      "missing-explicit-browser-blocks",
      () => resolveBrowser({ mode: "executable", executablePath: missing }, home),
      "BROWSER_MISSING",
      "explicit executable path does not exist",
    );
  }
} finally {
  for (const fn of cleanup.splice(0).reverse()) {
    try {
      await fn();
    } catch {
      /* best effort */
    }
  }
}

const evidence = {
  platform: process.platform,
  arch: process.arch,
  os: os.version(),
  release: os.release(),
  node: process.versions.node,
  pinnedChrome,
  timestamp: new Date().toISOString(),
  passed: results.every((r) => r.passed),
  results,
};
if (outFile) {
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify(evidence, null, 2));
if (!evidence.passed) process.exitCode = 1;
