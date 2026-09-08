/**
 * S6 回归测试：运行时文本禁止 emoji 状态图标；MCP 版本与 package.json 一致。
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { MCP_SERVER_VERSION } from "../../src/version.generated.js";
import pkg from "../../package.json" with { type: "json" };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** 状态图标 emoji（✅❌⚠️💡🔧 等）在运行时文本中禁止 */
const BANNED = /[✅❌⚠️💡🎯🔍🚀📦🔥✨🔁]/;

describe("S6 纯文本状态标记", () => {
  it("src/ 运行时文本无 emoji 状态图标", () => {
    const dirs = ["src"];
    for (const d of dirs) {
      const abs = path.join(ROOT, d);
      const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (/\.(ts)$/.test(e.name) && !e.name.includes("version.generated")) {
            const text = fs.readFileSync(full, "utf8");
            const hit = text.match(BANNED);
            expect(hit, `${full} 含禁用 emoji: ${hit?.[0]}`).toBeNull();
          }
        }
      };
      walk(abs);
    }
  });
});

describe("S6 MCP 版本单一来源", () => {
  it("version.generated.ts 与 package.json.version 一致", () => {
    expect(MCP_SERVER_VERSION).toBe(pkg.version);
    expect(MCP_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
