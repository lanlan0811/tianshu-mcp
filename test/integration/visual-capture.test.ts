import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { VisualBrowser } from "../../src/visual/capture.js";
import { VisualServices } from "../../src/visual/services.js";
import { VisualBudget } from "../../src/visual/budget.js";
import { VisualConfigSchema, PageSchema } from "../../src/visual/schema.js";
import { resolveDataHome } from "../../src/config/store.js";
import { loadSharp } from "../../src/visual/runtime.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(html: string, overrides: Record<string, unknown> = {}) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "visual-capture-"));
  cleanup.push(() => fs.rm(project, { recursive: true, force: true }));
  await fs.writeFile(path.join(project, "index.html"), html);
  const config = VisualConfigSchema.parse({
    limits: { itemTimeoutMs: 20000, navigationTimeoutMs: 10000 },
    ...overrides,
  });
  const budget = new VisualBudget(config.limits);
  const services = new VisualServices(project, budget);
  const browser = new VisualBrowser(config, resolveDataHome(), budget);
  cleanup.push(async () => {
    await browser.close();
    await services.close();
    budget.dispose();
  });
  await browser.start();
  const source = { type: "static" as const, root: "." };
  const url = await services.get(source);
  const viewport = { id: "test", width: 240, height: 160, deviceScaleFactor: 1 };
  const capture = (rule: Record<string, unknown> = {}) =>
    browser.capture(
      project,
      PageSchema.parse({ id: "page", source, route: "/index.html", ...rule }),
      viewport,
      url,
    );
  return { capture, project, url, closeBrowser: () => browser.close() };
}
describe.skipIf(process.env.TIANSHU_VISUAL_BROWSER_TEST !== "1")("real visual capture", () => {
  it("records blocked WebSockets even before the document root exists", async () => {
    const h = await fixture(
      `<script>try { new WebSocket('ws://127.0.0.1:1'); } catch {} document.documentElement.removeAttribute('data-tianshu-blocked-ws');</script><main>Socket policy</main>`,
    );
    await expect(h.capture()).rejects.toMatchObject({ code: "RESOURCE_BLOCKED" });
  });
  it("executes input, click, hover, tab selection and readiness before element capture", async () => {
    const h = await fixture(
      `<style>#result{width:100px;height:50px;background:red}#hover:hover{color:blue}</style><input id="name"><button id="tab" onclick="document.querySelector('#result').textContent=document.querySelector('#name').value;document.querySelector('#result').hidden=false">Tab</button><span id="hover">Hover</span><main id="result" hidden></main>`,
    );
    const captured = await h.capture({
      capture: "element",
      selector: "#result",
      readySelector: "#result",
      steps: [
        { type: "input", selector: "#name", value: "Hello" },
        { type: "click", selector: "#tab" },
        { type: "hover", selector: "#hover" },
        { type: "wait", selector: "#result", state: "visible" },
      ],
    });
    const sharp = await loadSharp();
    const metadata = await sharp(captured.image).metadata();
    expect([metadata.width, metadata.height]).toEqual([100, 50]);
  });
  it("captures full-page lazy images with bounded scrolling", async () => {
    const h = await fixture(
      `<style>body{margin:0}main{height:450px;background:red}</style><main></main><img loading="lazy" width="20" height="20" src="image.png">`,
    );
    const sharp = await loadSharp();
    await sharp({ create: { width: 20, height: 20, channels: 3, background: "blue" } })
      .png()
      .toFile(path.join(h.project, "image.png"));
    const captured = await h.capture({ capture: "fullPage" });
    expect((await sharp(captured.image).metadata()).height).toBeGreaterThan(450);
  });
  it("stabilizes only explicit masks and rejects missing or complete masks", async () => {
    const h = await fixture(
      `<style>html,body{margin:0;width:100%;height:100%}main{width:50px;height:40px}</style><main></main><script>let n=0;setInterval(()=>document.querySelector('main').style.background='rgb('+(n++%255)+',0,0)',10)</script>`,
    );
    await expect(h.capture()).rejects.toMatchObject({ code: "SCREENSHOT_UNSTABLE" });
    expect((await h.capture({ maskSelectors: ["main"] })).masks).toHaveLength(1);
    await expect(h.capture({ maskSelectors: [".missing"] })).rejects.toMatchObject({
      code: "MASK_NOT_FOUND",
    });
    await expect(h.capture({ maskSelectors: ["body"] })).rejects.toMatchObject({
      code: "MASK_ALL_PIXELS",
    });
  });
  it("loads isolated Cookie/localStorage state and diagnoses expiration", async () => {
    const h = await fixture(
      `<main hidden>Authenticated</main><script>if(document.cookie.includes('test=ok')&&localStorage.getItem('test')==='ok')document.querySelector('main').hidden=false</script>`,
    );
    const state = {
      cookies: [{ name: "test", value: "ok", domain: "127.0.0.1", path: "/" }],
      origins: [{ origin: h.url, localStorage: [{ name: "test", value: "ok" }] }],
    };
    await fs.writeFile(path.join(h.project, "state.json"), JSON.stringify(state));
    const captured = await h.capture({ storageState: "state.json", readySelector: "main" });
    expect(captured.environment.storageStateLoaded).toBe(true);
    await expect(h.capture({ readySelector: "main" })).rejects.toMatchObject({
      code: "PAGE_NOT_READY",
    });
    await fs.writeFile(
      path.join(h.project, "state.json"),
      JSON.stringify({ ...state, cookies: [{ ...state.cookies[0], expires: 1 }] }),
    );
    await expect(h.capture({ storageState: "state.json" })).rejects.toMatchObject({
      code: "LOGIN_STATE_EXPIRED",
    });
  });
  it("blocks unapproved resource origins and accepts explicit allowlisting", async () => {
    const external = http.createServer((_req, res) => {
      res.setHeader("Content-Type", "text/css");
      res.end("main{background:red}");
    });
    await new Promise<void>((resolve) => external.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => {
      external.closeAllConnections();
      await new Promise<void>((resolve) => external.close(() => resolve()));
    });
    const origin = `http://127.0.0.1:${(external.address() as AddressInfo).port}`;
    const html = `<link rel="stylesheet" href="${origin}/style.css"><main>Resource policy</main>`;
    const blocked = await fixture(html);
    await expect(blocked.capture()).rejects.toMatchObject({ code: "RESOURCE_BLOCKED" });
    await blocked.closeBrowser();
    const allowed = await fixture(html, { allowedOrigins: [origin] });
    expect((await allowed.capture()).image.length).toBeGreaterThan(0);
  });
});
