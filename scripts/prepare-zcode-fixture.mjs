#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.join(
  os.tmpdir(),
  `tianshu-zcode-e2e-${Date.now()}-${randomBytes(3).toString("hex")}`,
);
await fsp.mkdir(path.join(root, ".tianshu-mcp"), { recursive: true });
await Promise.all([
  fsp.writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "tianshu-zcode-e2e-fixture", private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  ),
  fsp.writeFile(
    path.join(root, "check.mjs"),
    "import fs from 'node:fs';\nconst value = fs.existsSync('done.txt') ? fs.readFileSync('done.txt', 'utf8').trim() : '';\nif (value !== 'PASS') {\n  console.error(`done.txt expected PASS, received ${JSON.stringify(value)}`);\n  process.exit(1);\n}\nconsole.log('done.txt=PASS');\n",
    "utf8",
  ),
  fsp.writeFile(
    path.join(root, ".tianshu-mcp", "acceptance.json"),
    `${JSON.stringify({ checks: [{ name: "done-file", cmd: ["node", "check.mjs"] }] }, null, 2)}\n`,
    "utf8",
  ),
  fsp.writeFile(
    path.join(root, "README.md"),
    "# ZCode E2E fixture\n\nTemporary project for real-hardware tianshu-mcp acceptance.\n",
    "utf8",
  ),
]);
for (const args of [
  ["init"],
  ["config", "user.email", "zcode-e2e@example.invalid"],
  ["config", "user.name", "ZCode E2E"],
  ["add", "."],
  ["commit", "-m", "初始化 ZCode 真机验收夹具"],
])
  await execFileAsync("git", args, { cwd: root, windowsHide: true });
process.stdout.write(`${root}\n`);
