import { expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { loadBrowserTools, loadSharp, resolveBrowser } from "../../src/visual/runtime.js";
import { resolveDataHome } from "../../src/config/store.js";

it.skipIf(process.env.TIANSHU_VISUAL_BROWSER_TEST !== "1")(
  "launches isolated pinned Chrome and decodes a real screenshot",
  async () => {
    const { puppeteer, revisions } = await loadBrowserTools();
    const executablePath = await resolveBrowser({ mode: "managed" }, resolveDataHome());
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tianshu-visual-smoke-"));
    const browser = await puppeteer.launch({ executablePath, userDataDir, headless: true });
    try {
      expect(await browser.version()).toContain(revisions.PUPPETEER_REVISIONS.chrome);
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await page.setContent(
        '<main style="width:100px;height:100px;background:rgb(255,0,0)">visual acceptance</main>',
      );
      const image = await page.screenshot({ type: "png" });
      const sharp = await loadSharp();
      const { info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
      expect([info.width, info.height]).toEqual([390, 844]);
      if (process.env.TIANSHU_VISUAL_EVIDENCE) {
        await fs.mkdir(process.env.TIANSHU_VISUAL_EVIDENCE, { recursive: true });
        await fs.writeFile(path.join(process.env.TIANSHU_VISUAL_EVIDENCE, "screenshot.png"), image);
        await fs.writeFile(
          path.join(process.env.TIANSHU_VISUAL_EVIDENCE, "environment.json"),
          JSON.stringify(
            {
              platform: process.platform,
              arch: process.arch,
              os: os.version(),
              release: os.release(),
              node: process.versions.node,
              browser: await browser.version(),
              executablePath,
              timestamp: new Date().toISOString(),
              result: "passed",
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await browser.close();
      await fs.rm(userDataDir, { recursive: true, force: true });
    }
  },
  60_000,
);
