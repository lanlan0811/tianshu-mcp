import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { setTimeout as delay } from "node:timers/promises";
import { killTree } from "../agents/spawn.js";
import { projectFile } from "./paths.js";
import { VisualError } from "./errors.js";
import type { VisualPage } from "./schema.js";
import type { VisualBudget } from "./budget.js";

interface Service {
  url: string;
  close(): Promise<void>;
}
const mime: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
async function listen(server: net.Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  }).catch(() => {
    throw new VisualError("PORT_CONFLICT", "Cannot exclusively bind configured service port");
  });
}
export class VisualServices {
  private readonly services = new Map<string, Promise<Service>>();
  constructor(
    private readonly project: string,
    private readonly budget: VisualBudget,
  ) {}
  async get(source: VisualPage["source"]): Promise<string> {
    this.budget.check();
    const key = JSON.stringify(source);
    if (!this.services.has(key)) this.services.set(key, this.start(source));
    return (await this.services.get(key)!).url;
  }
  private async start(source: VisualPage["source"]): Promise<Service> {
    if (source.type === "existing") return { url: source.url, close: async () => {} };
    if (source.type === "static") {
      const root = await projectFile(this.project, source.root);
      if (!(await fs.stat(root)).isDirectory())
        throw new VisualError("STATIC_ROOT", "Static root is not a directory");
      const server = http.createServer((req, res) => {
        void (async () => {
          try {
            const pathname = decodeURIComponent(
              new URL(req.url ?? "/", "http://localhost").pathname,
            );
            const relative = pathname.replace(/^\/+/, "");
            const file = await projectFile(
              root,
              relative.endsWith("/") || !relative ? `${relative}index.html` : relative,
            );
            if (!(await fs.stat(file)).isFile()) {
              res.writeHead(404).end();
              return;
            }
            res.setHeader(
              "Content-Type",
              mime[path.extname(file).toLowerCase()] ?? "application/octet-stream",
            );
            res.setHeader("Cache-Control", "no-store");
            res.end(await fs.readFile(file));
          } catch {
            res.writeHead(404).end();
          }
        })();
      });
      await listen(server, source.port ?? 0, "127.0.0.1");
      return {
        url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
        close: async () => {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        },
      };
    }
    const url = new URL(source.readyUrl);
    if (!url.port)
      throw new VisualError(
        "SERVICE_PORT_REQUIRED",
        "Command services require an explicit port in readyUrl",
      );
    const probe = net.createServer();
    await listen(probe, Number(url.port), url.hostname.replace(/^\[|\]$/g, ""));
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [name, reference] of Object.entries(source.env)) {
      if (process.env[reference] === undefined)
        throw new VisualError(
          "SERVICE_ENV_MISSING",
          `Missing environment variable reference: ${reference}`,
        );
      env[name] = process.env[reference];
    }
    const cwd = await projectFile(this.project, source.cwd);
    const child = crossSpawn(source.command, source.args, {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    let exited = false;
    child.on("error", () => {
      exited = true;
    });
    child.on("exit", () => {
      exited = true;
    });
    const close = async (): Promise<void> => {
      if (child.pid) await killTree(child.pid, "auto");
    };
    const deadline = Date.now() + this.budget.timeout(this.budget.limits.serviceTimeoutMs);
    try {
      while (true) {
        this.budget.check();
        if (exited)
          throw new VisualError("SERVICE_EXITED", "Project service exited before readiness");
        const timeout = this.budget.timeout(this.budget.limits.navigationTimeoutMs, deadline);
        try {
          const response = await fetch(url, {
            redirect: "manual",
            signal: AbortSignal.any([this.budget.signal, AbortSignal.timeout(timeout)]),
          });
          await response.body?.cancel();
          if (response.ok) break;
        } catch {
          this.budget.check();
        }
        await delay(Math.min(100, this.budget.timeout(100, deadline)), undefined, {
          signal: this.budget.signal,
        });
      }
      return { url: source.readyUrl, close };
    } catch (e) {
      await close();
      this.budget.check();
      throw e;
    }
  }
  async close(): Promise<void> {
    const outcomes = await Promise.allSettled(this.services.values());
    await Promise.all(
      outcomes
        .filter((r): r is PromiseFulfilledResult<Service> => r.status === "fulfilled")
        .map((r) => r.value.close()),
    );
    this.services.clear();
  }
}
