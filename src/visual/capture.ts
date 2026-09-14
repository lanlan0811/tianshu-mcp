import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Browser, Page } from "puppeteer-core";
import { loadBrowserTools, resolveBrowser, loadSharp } from "./runtime.js";
import { VisualError } from "./errors.js";
import { projectFile } from "./paths.js";
import type { VisualConfig, VisualPage, VisualViewport } from "./schema.js";
import type { VisualBudget } from "./budget.js";
import type { Rectangle } from "./types.js";
import { killTree } from "../agents/spawn.js";

const StateSchema = z
  .object({
    cookies: z
      .array(
        z
          .object({
            name: z.string(),
            value: z.string(),
            domain: z.string(),
            path: z.string().default("/"),
            expires: z.number().optional(),
            httpOnly: z.boolean().optional(),
            secure: z.boolean().optional(),
            sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
          })
          .strict(),
      )
      .default([]),
    origins: z
      .array(
        z
          .object({
            origin: z.string().url(),
            localStorage: z.array(z.object({ name: z.string(), value: z.string() }).strict()),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export class VisualBrowser {
  private browser?: Browser;
  private profile?: string;
  private closing?: Promise<void>;
  private readonly abort = (): void => {
    void this.close();
  };
  constructor(
    private readonly config: VisualConfig,
    private readonly home: string,
    private readonly budget: VisualBudget,
  ) {}
  async start(): Promise<void> {
    this.budget.check();
    const { puppeteer, revisions } = await loadBrowserTools();
    const executablePath = await resolveBrowser(this.config.browser, this.home);
    this.profile = await fs.mkdtemp(path.join(os.tmpdir(), "tianshu-visual-"));
    try {
      this.browser = await puppeteer.launch({
        executablePath,
        userDataDir: this.profile,
        headless: true,
        timeout: this.budget.timeout(this.config.limits.navigationTimeoutMs),
        args: [`--lang=${this.config.defaults.locale}`, "--disable-background-networking"],
      });
      this.budget.signal.addEventListener("abort", this.abort, { once: true });
      this.budget.check();
      if (
        this.config.browser.mode === "managed" &&
        !(await this.browser.version()).endsWith(revisions.PUPPETEER_REVISIONS.chrome)
      )
        throw new VisualError(
          "BROWSER_VERSION",
          "Managed browser version does not match pinned revision",
        );
    } catch (e) {
      await this.close();
      throw e;
    }
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.budget.signal.removeEventListener("abort", this.abort);
      const process = this.browser?.process();
      try {
        await this.browser?.close();
      } finally {
        if (process?.pid && process.exitCode === null && process.signalCode === null)
          await killTree(process.pid, "auto");
        if (this.profile)
          await fs.rm(this.profile, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 100,
          });
      }
    })();
    return this.closing;
  }
  async capture(project: string, rule: VisualPage, viewport: VisualViewport, sourceUrl: string) {
    if (!this.browser) throw new VisualError("BROWSER_MISSING", "Browser has not started");
    const context = await this.browser.createBrowserContext();
    const deadline = Date.now() + this.budget.timeout(this.config.limits.itemTimeoutMs);
    const timer = setTimeout(
      () => {
        void context.close().catch(() => {});
      },
      this.budget.timeout(this.config.limits.itemTimeoutMs, deadline),
    );
    let page: Page | undefined;
    const blocked = new Set<string>();
    try {
      page = await context.newPage();
      const target = new URL(rule.route, sourceUrl);
      const allowed = new Set([target.origin, ...this.config.allowedOrigins]);
      const networkAllowed = (raw: string): boolean => {
        const url = new URL(raw);
        return ["data:", "blob:", "about:"].includes(url.protocol) || allowed.has(url.origin);
      };
      await page.setBypassServiceWorker(true);
      await page.setCacheEnabled(false);
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const ok = networkAllowed(request.url());
        if (!ok) blocked.add(new URL(request.url()).origin);
        void (ok ? request.continue() : request.abort("blockedbyclient")).catch(() => {});
      });
      // WebSockets bypass HTTP interception. Enforce exact origin policy before construction.
      await page.evaluateOnNewDocument(
        (origins: string[]) => {
          const Original = globalThis.WebSocket;
          globalThis.WebSocket = class extends Original {
            constructor(url: string | URL, protocols?: string | string[]) {
              const parsed = new URL(url, location.href);
              if (!origins.includes(parsed.origin)) {
                document.documentElement?.setAttribute("data-tianshu-blocked-ws", parsed.origin);
                throw new Error("Visual resource policy blocked WebSocket origin");
              }
              super(url, protocols);
            }
          };
        },
        [...allowed],
      );
      await page.setViewport(viewport);
      await page.setExtraHTTPHeaders({ "Accept-Language": this.config.defaults.locale });
      const cdp = await page.createCDPSession();
      await cdp.send("Emulation.setLocaleOverride", { locale: this.config.defaults.locale });
      await page.emulateTimezone(this.config.defaults.timezone);
      await page.emulateMediaFeatures([
        { name: "prefers-color-scheme", value: this.config.defaults.colorScheme },
      ]);
      if (rule.storageState) {
        let state: z.infer<typeof StateSchema>;
        try {
          state = StateSchema.parse(
            JSON.parse(await fs.readFile(await projectFile(project, rule.storageState), "utf8")),
          );
        } catch {
          throw new VisualError(
            "LOGIN_STATE_INVALID",
            "Cannot load test storage state; contents omitted",
          );
        }
        if (
          state.cookies.some(
            (c) => c.expires !== undefined && c.expires > 0 && c.expires * 1000 <= Date.now(),
          )
        )
          throw new VisualError("LOGIN_STATE_EXPIRED", "Test login cookies have expired");
        await context.setCookie(...state.cookies);
        await page.evaluateOnNewDocument((origins) => {
          for (const entry of origins)
            if (entry.origin === location.origin)
              for (const item of entry.localStorage) localStorage.setItem(item.name, item.value);
        }, state.origins);
      }
      page.setDefaultTimeout(this.budget.timeout(this.config.limits.navigationTimeoutMs, deadline));
      try {
        const response = await page.goto(target.href, {
          waitUntil: "domcontentloaded",
          timeout: this.budget.timeout(this.config.limits.navigationTimeoutMs, deadline),
        });
        if (response && !response.ok()) throw new Error(`HTTP ${response.status()}`);
      } catch {
        throw new VisualError(
          blocked.size ? "RESOURCE_BLOCKED" : "PAGE_UNREACHABLE",
          blocked.size
            ? `Blocked resource origins: ${[...blocked].join(", ")}`
            : "Page navigation failed; check local service and login state",
        );
      }
      for (const step of rule.steps) {
        page.setDefaultTimeout(
          this.budget.timeout(this.config.limits.navigationTimeoutMs, deadline),
        );
        try {
          if (step.type === "click") await page.click(step.selector);
          if (step.type === "hover") await page.hover(step.selector);
          if (step.type === "input") {
            await page.$eval(step.selector, (element) => {
              (element as HTMLInputElement).value = "";
            });
            await page.type(step.selector, step.value);
          }
          if (step.type === "scroll") {
            if (step.selector)
              await page.$eval(step.selector, (element) => element.scrollIntoView());
            else await page.evaluate((x, y) => window.scrollTo(x, y), step.x ?? 0, step.y ?? 0);
          }
          if (step.type === "wait") {
            if (step.selector)
              await page.waitForSelector(step.selector, {
                visible: step.state !== "hidden",
                hidden: step.state === "hidden",
              });
            else if (step.url)
              await page.waitForFunction((url) => location.href === url, {}, step.url);
            else
              await delay(this.budget.timeout(step.durationMs!, deadline), undefined, {
                signal: this.budget.signal,
              });
          }
        } catch {
          this.budget.check();
          throw new VisualError(
            "INTERACTION_FAILED",
            `Interaction failed: ${step.type}${"selector" in step ? ` ${step.selector ?? ""}` : ""}`,
            "failed",
          );
        }
      }
      if (rule.readySelector) {
        try {
          await page.waitForSelector(rule.readySelector, {
            visible: true,
            timeout: this.budget.timeout(this.config.limits.navigationTimeoutMs, deadline),
          });
        } catch {
          throw new VisualError(
            "PAGE_NOT_READY",
            "Readiness selector not visible; check login redirect and page readiness",
          );
        }
      }
      const capture = rule.capture ?? this.config.defaults.capture;
      const selector = rule.selector ?? this.config.defaults.selector;
      if (capture === "fullPage") {
        let y = 0;
        while (true) {
          this.budget.timeout(this.config.limits.itemTimeoutMs, deadline);
          const height = await page.evaluate(() => document.documentElement.scrollHeight);
          if (
            height * viewport.width * viewport.deviceScaleFactor ** 2 >
            this.config.limits.decodedPixels
          )
            throw new VisualError(
              "PIXEL_BUDGET",
              "Full page exceeds pixel budget or keeps expanding",
            );
          if (y >= height) break;
          await page.evaluate((position) => window.scrollTo(0, position), y);
          await delay(50, undefined, { signal: this.budget.signal });
          y += viewport.height;
        }
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      await page.waitForFunction(() => document.fonts.status === "loaded", {
        timeout: this.budget.timeout(this.config.limits.navigationTimeoutMs, deadline),
      });
      await page.waitForFunction(
        (fullPage) =>
          Array.from(document.images).every((img) => {
            const r = img.getBoundingClientRect();
            return (
              (!fullPage &&
                (r.bottom < 0 || r.top >= innerHeight || r.right < 0 || r.left >= innerWidth)) ||
              (img.complete && img.naturalWidth > 0)
            );
          }),
        { timeout: this.budget.timeout(this.config.limits.navigationTimeoutMs, deadline) },
        capture === "fullPage",
      );
      await page.addStyleTag({
        content:
          "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}html{scroll-behavior:auto!important}",
      });
      let clip: Rectangle | undefined;
      if (capture === "element") {
        const elements = await page.$$(selector!);
        if (elements.length !== 1)
          throw new VisualError(
            "ELEMENT_AMBIGUOUS",
            "Element screenshot requires exactly one visible element",
            "failed",
          );
        await elements[0]!.scrollIntoView();
        const bounds = await elements[0]!.boundingBox();
        if (!bounds || bounds.width <= 0 || bounds.height <= 0)
          throw new VisualError("ELEMENT_HIDDEN", "Screenshot element is not visible", "failed");
        const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
        clip = { ...bounds, x: bounds.x + scroll.x, y: bounds.y + scroll.y };
      }
      const masks: Rectangle[] = [];
      for (const mask of rule.maskSelectors) {
        const elements = await page.$$(mask);
        if (!elements.length)
          throw new VisualError("MASK_NOT_FOUND", `Mask selector not found: ${mask}`);
        for (const element of elements) {
          const bounds = await element.boundingBox();
          if (!bounds)
            throw new VisualError("MASK_NOT_VISIBLE", `Mask selector not visible: ${mask}`);
          const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
          const offset = clip ?? (capture === "fullPage" ? { x: 0, y: 0 } : scroll);
          masks.push({
            x: (bounds.x + scroll.x - offset.x) * viewport.deviceScaleFactor,
            y: (bounds.y + scroll.y - offset.y) * viewport.deviceScaleFactor,
            width: bounds.width * viewport.deviceScaleFactor,
            height: bounds.height * viewport.deviceScaleFactor,
          });
        }
      }
      const dimensions =
        clip ??
        (capture === "fullPage"
          ? await page.evaluate(() => ({
              width: document.documentElement.scrollWidth,
              height: document.documentElement.scrollHeight,
            }))
          : viewport);
      if (
        dimensions.width * dimensions.height * viewport.deviceScaleFactor ** 2 >
        this.config.limits.decodedPixels
      )
        throw new VisualError("PIXEL_BUDGET", "Screenshot exceeds pixel budget");
      const sharp = await loadSharp();
      let previous: Buffer | undefined;
      for (let sample = 0; sample < this.config.limits.stabilitySamples; sample++) {
        this.budget.timeout(this.config.limits.itemTimeoutMs, deadline);
        const ws = await page.evaluate(() =>
          document.documentElement.getAttribute("data-tianshu-blocked-ws"),
        );
        if (ws) blocked.add(ws);
        if (blocked.size)
          throw new VisualError(
            "RESOURCE_BLOCKED",
            `Blocked resource origins: ${[...blocked].join(", ")}`,
          );
        const raw = await page.screenshot({
          type: "png",
          fullPage: capture === "fullPage",
          ...(clip ? { clip } : {}),
          captureBeyondViewport: true,
        });
        const decoded = await sharp(raw).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        let effective = decoded.info.width * decoded.info.height;
        const excluded = new Uint8Array(effective);
        for (const r of masks)
          for (
            let y = Math.max(0, Math.floor(r.y));
            y < Math.min(decoded.info.height, Math.ceil(r.y + r.height));
            y++
          )
            for (
              let x = Math.max(0, Math.floor(r.x));
              x < Math.min(decoded.info.width, Math.ceil(r.x + r.width));
              x++
            ) {
              const n = y * decoded.info.width + x;
              if (!excluded[n]) {
                excluded[n] = 1;
                effective--;
              }
              decoded.data.fill(0, n * 4, n * 4 + 4);
            }
        if (!effective)
          throw new VisualError("MASK_ALL_PIXELS", "Masks exclude the entire screenshot");
        const image = await sharp(decoded.data, { raw: decoded.info }).png().toBuffer();
        if (previous?.equals(image))
          return {
            image,
            masks,
            environment: {
              platform: process.platform,
              arch: process.arch,
              os: os.release(),
              browser: await this.browser.version(),
              browserKind: this.config.browser.mode,
              viewport,
              storageStateLoaded: !!rule.storageState,
            },
            rules: { ...this.config.defaults, ...rule },
          };
        previous = image;
        await delay(100, undefined, { signal: this.budget.signal });
      }
      throw new VisualError("SCREENSHOT_UNSTABLE", "No two adjacent screenshot samples matched");
    } finally {
      clearTimeout(timer);
      await context.close().catch(() => {});
    }
  }
}
