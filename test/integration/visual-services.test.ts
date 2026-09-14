import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { VisualServices } from "../../src/visual/services.js";
import { VisualBudget } from "../../src/visual/budget.js";
import { VisualConfigSchema, SourceSchema } from "../../src/visual/schema.js";

const dirs: string[] = [];
const services: VisualServices[] = [];
const budgets: VisualBudget[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const budget of budgets.splice(0)) budget.dispose();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function fixture(signal?: AbortSignal) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "视觉 服务-")); dirs.push(project);
  const budget = new VisualBudget(VisualConfigSchema.parse({ limits: { serviceTimeoutMs: 2000 } }).limits, signal); budgets.push(budget);
  const service = new VisualServices(project, budget); services.push(service);
  return { project, service };
}
async function port() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const value = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return value;
}
it("shares static sources, denies escaping symlinks, and releases its port", async () => {
  const { project, service } = await fixture();
  await fs.mkdir(path.join(project, "public"));
  await fs.writeFile(path.join(project, "public", "index.html"), "<main>local</main>");
  await fs.writeFile(path.join(project, "secret.txt"), "not public");
  await fs.symlink(project, path.join(project, "public", "outside"), process.platform === "win32" ? "junction" : "dir");
  const source = SourceSchema.parse({ type: "static", root: "public" });
  const [first, second] = await Promise.all([service.get(source), service.get(source)]);
  expect(first).toBe(second);
  expect(await (await fetch(first)).text()).toContain("local");
  expect((await fetch(`${first}/outside/secret.txt`)).status).toBe(404);
  expect((await fetch(`${first}/outside/`)).status).toBe(404);
  await service.close();
  await expect(fetch(first)).rejects.toThrow();
});
it("does not reuse or terminate an existing listener for command sources", async () => {
  const { service } = await fixture();
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(listener.address() as net.AddressInfo).port}`;
    await expect(service.get(SourceSchema.parse({ type: "command", command: process.execPath, args: ["-e", "process.exit(99)"], readyUrl: url }))).rejects.toMatchObject({ code: "PORT_CONFLICT" });
    expect(listener.listening).toBe(true);
    expect(await service.get(SourceSchema.parse({ type: "existing", url }))).toBe(url);
    await service.close();
    expect(listener.listening).toBe(true);
  } finally { await new Promise<void>((resolve) => listener.close(() => resolve())); }
});
it("starts a command with arguments and closes only its own process", async () => {
  const { project, service } = await fixture();
  const selectedPort = await port();
  await fs.writeFile(path.join(project, "server.mjs"), `import http from 'node:http'; import fs from 'node:fs'; fs.writeFileSync('pid.txt',String(process.pid)); http.createServer((req,res)=>res.end('ready')).listen(Number(process.argv[2]),'127.0.0.1');`);
  const url = await service.get(SourceSchema.parse({ type: "command", command: process.execPath, args: ["server.mjs", String(selectedPort)], readyUrl: `http://127.0.0.1:${selectedPort}` }));
  expect(await (await fetch(url)).text()).toBe("ready");
  const pid = Number(await fs.readFile(path.join(project, "pid.txt"), "utf8"));
  await service.close();
  expect(() => process.kill(pid, 0)).toThrow();
});
it("cancels a service that never becomes ready and removes its process", async () => {
  const controller = new AbortController();
  const { project, service } = await fixture(controller.signal);
  await fs.writeFile(path.join(project, "server.mjs"), "import fs from 'node:fs'; fs.writeFileSync('pid.txt',String(process.pid)); setInterval(()=>{},1000);");
  const running = service.get(SourceSchema.parse({ type: "command", command: process.execPath, args: ["server.mjs"], readyUrl: `http://127.0.0.1:${await port()}` }));
  const rejection = expect(running).rejects.toMatchObject({ code: "CANCELLED" });
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) { try { await fs.access(path.join(project, "pid.txt")); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); } }
  controller.abort();
  await rejection;
  const pid = Number(await fs.readFile(path.join(project, "pid.txt"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});
