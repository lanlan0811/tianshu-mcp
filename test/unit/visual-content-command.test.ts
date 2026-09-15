import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseVerdictLine,
  prepareCommandArgs,
  resolveCommandIdentity,
  resolveCommandPath,
  resolveContentEnv,
  runContentCommand,
} from "../../src/visual/content-command.js";
import { VisualError } from "../../src/visual/errors.js";

const dirs: string[] = [];
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "content-command-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

const IMAGE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("content command contract", () => {
  describe("prepareCommandArgs", () => {
    it("expands image path and creates the expect file", async () => {
      const dir = await fixture();
      const imagePath = path.join(dir, "image.png");
      await fs.writeFile(imagePath, Buffer.from(IMAGE_PNG, "base64"));
      const prepared = await prepareCommandArgs({
        argsTemplate: ["judge", "--image", "<image:path>", "--expect-file", "<expect:file>"],
        imagePath,
        expect: "蓝色齿轮与白色文字",
        tempDir: path.join(dir, "tmp"),
      });
      expect(prepared.argv).toEqual([
        "judge",
        "--image",
        imagePath,
        "--expect-file",
        path.join(dir, "tmp", "expect.txt"),
      ]);
      expect(await fs.readFile(prepared.tempFiles[0]!, "utf8")).toBe("蓝色齿轮与白色文字");
    });

    it("does not create temp files for unused placeholders", async () => {
      const dir = await fixture();
      const prepared = await prepareCommandArgs({
        argsTemplate: ["judge", "--image", "<image:path>"],
        imagePath: path.join(dir, "image.png"),
        expect: "expectation",
        tempDir: path.join(dir, "tmp"),
      });
      expect(prepared.tempFiles).toEqual([]);
      await expect(fs.stat(path.join(dir, "tmp"))).rejects.toThrow();
    });

    it("creates a base64 payload file only for the egress placeholder", async () => {
      const dir = await fixture();
      const imagePath = path.join(dir, "image.png");
      await fs.writeFile(imagePath, Buffer.from(IMAGE_PNG, "base64"));
      const prepared = await prepareCommandArgs({
        argsTemplate: ["--image-b64-file", "<image:base64:file>"],
        imagePath,
        expect: "expectation",
        tempDir: path.join(dir, "tmp"),
      });
      expect(prepared.tempFiles).toHaveLength(1);
      expect(await fs.readFile(prepared.tempFiles[0]!, "utf8")).toBe(IMAGE_PNG);
    });

    it("expands multiple placeholders inside one token without re-expansion", async () => {
      const dir = await fixture();
      const imagePath = path.join(dir, "image.png");
      const prepared = await prepareCommandArgs({
        argsTemplate: ["--pair=<image:path>|<image:path>"],
        imagePath,
        expect: "expectation",
        tempDir: path.join(dir, "tmp"),
      });
      expect(prepared.argv).toEqual([`--pair=${imagePath}|${imagePath}`]);
    });

    it("rejects unknown placeholders at runtime (defensive fallback)", async () => {
      const dir = await fixture();
      await expect(
        prepareCommandArgs({
          argsTemplate: ["--data", "<image:bytes>"],
          imagePath: path.join(dir, "image.png"),
          expect: "expectation",
          tempDir: path.join(dir, "tmp"),
        }),
      ).rejects.toMatchObject({ code: "CONTENT_CONFIG_INVALID" });
    });
  });

  describe("resolveContentEnv", () => {
    it("maps declared child names to host values", () => {
      process.env.__TIANSHU_CONTENT_TEST_VALUE = "token-value";
      try {
        expect(
          resolveContentEnv({ VISION_API_KEY: "__TIANSHU_CONTENT_TEST_VALUE" }),
        ).toEqual({ VISION_API_KEY: "token-value" });
      } finally {
        delete process.env.__TIANSHU_CONTENT_TEST_VALUE;
      }
    });
    it("throws CONTENT_ENV_MISSING when the host variable is absent", () => {
      expect(() => resolveContentEnv({ VISION_API_KEY: "__TIANSHU_CONTENT_ABSENT" })).toThrow(
        VisualError,
      );
      try {
        resolveContentEnv({ VISION_API_KEY: "__TIANSHU_CONTENT_ABSENT" });
      } catch (e) {
        expect((e as VisualError).code).toBe("CONTENT_ENV_MISSING");
      }
    });
  });

  describe("parseVerdictLine", () => {
    it("takes the last non-empty line and validates the contract", () => {
      const verdict = parseVerdictLine(
        `noise line\nprogress: 50%\n\n{"passed":true,"confidence":0.9,"reason":"ok"}\n`,
      );
      expect(verdict).toEqual({ passed: true, confidence: 0.9, reason: "ok" });
    });
    it("rejects empty stdout", () => {
      expect(() => parseVerdictLine("  \n \n")).toThrowError(
        expect.objectContaining({ code: "CONTENT_OUTPUT_INVALID" }),
      );
    });
    it("rejects a non-JSON last line", () => {
      expect(() => parseVerdictLine("noise\nstill not json")).toThrowError(
        expect.objectContaining({ code: "CONTENT_OUTPUT_INVALID" }),
      );
    });
    it("rejects JSON that violates the verdict contract", () => {
      expect(() => parseVerdictLine('{"passed":"yes"}')).toThrowError(
        expect.objectContaining({ code: "CONTENT_OUTPUT_INVALID" }),
      );
      expect(() => parseVerdictLine('{"passed":true}')).toThrowError(
        expect.objectContaining({ code: "CONTENT_OUTPUT_INVALID" }),
      );
      expect(() => parseVerdictLine('{"passed":true,"reason":"ok","extra":1}')).toThrowError(
        expect.objectContaining({ code: "CONTENT_OUTPUT_INVALID" }),
      );
    });
  });

  describe("runContentCommand", () => {
    it("runs a node command and captures stdout with noise", async () => {
      const outcome = await runContentCommand({
        command: process.execPath,
        argv: [
          "-e",
          "console.log('noise'); console.log(JSON.stringify({passed:true,confidence:0.9,reason:'ok'}))",
        ],
        cwd: process.cwd(),
        env: { ...process.env },
        timeoutMs: 30_000,
      });
      expect(outcome.exitCode).toBe(0);
      expect(parseVerdictLine(outcome.stdout)).toEqual({
        passed: true,
        confidence: 0.9,
        reason: "ok",
      });
    });
    it("reports non-zero exit codes with stderr", async () => {
      const outcome = await runContentCommand({
        command: process.execPath,
        argv: ["-e", "console.error('boom'); process.exit(2)"],
        cwd: process.cwd(),
        env: { ...process.env },
        timeoutMs: 30_000,
      });
      expect(outcome.exitCode).toBe(2);
      expect(outcome.stderr).toContain("boom");
    });
    it("times out and kills the process tree", async () => {
      const started = Date.now();
      const outcome = await runContentCommand({
        command: process.execPath,
        argv: ["-e", "setTimeout(() => {}, 60000)"],
        cwd: process.cwd(),
        env: { ...process.env },
        timeoutMs: 500,
      });
      expect(outcome.timeout).toBe(true);
      expect(outcome.exitCode).toBeNull();
      expect(Date.now() - started).toBeLessThan(10_000);
    });
    it("resolves spawn errors (command not found) without throwing", async () => {
      const outcome = await runContentCommand({
        command: "definitely-not-a-command-xyz",
        argv: [],
        cwd: process.cwd(),
        env: { ...process.env },
        timeoutMs: 30_000,
      });
      expect(outcome.spawnError).toBeTruthy();
    });
    it("keeps only the output tail beyond the capture cap", async () => {
      const outcome = await runContentCommand({
        command: process.execPath,
        argv: ["-e", "console.log('x'.repeat(5000))"],
        cwd: process.cwd(),
        env: { ...process.env },
        timeoutMs: 30_000,
        maxOutputChars: 1024,
      });
      expect(outcome.stdout.length).toBeLessThanOrEqual(1024);
    });
  });

  describe("resolveCommandPath / resolveCommandIdentity", () => {
    it("resolves an absolute executable directly", async () => {
      expect(await resolveCommandPath(process.execPath, process.cwd())).toBe(path.resolve(process.execPath));
    });
    it("resolves a PATH command via where/which", async () => {
      const resolved = await resolveCommandPath("node", process.cwd());
      expect(resolved).toBeTruthy();
    });
    it("returns null for a missing command", async () => {
      expect(await resolveCommandPath("definitely-not-a-command-xyz", process.cwd())).toBeNull();
    });
    it("includes the resolved executable in the identity digest", async () => {
      const identity = await resolveCommandIdentity(process.execPath, [], process.cwd());
      expect(identity.commandPath).toBeTruthy();
      expect(identity.commandDigest).toBeTruthy();
    });
    it("includes project file args (e.g. judge scripts) in the identity digest", async () => {
      const dir = await fixture();
      const script = path.join(dir, "judge.mjs");
      await fs.writeFile(script, "console.log('v1');\n");
      const first = await resolveCommandIdentity(process.execPath, [script], dir);
      expect(first.commandDigest).toBeTruthy();
      await fs.writeFile(script, "console.log('v2');\n");
      const second = await resolveCommandIdentity(process.execPath, [script], dir);
      expect(second.commandDigest).not.toBe(first.commandDigest);
    });
    it("returns a null digest when the command cannot be resolved (no caching)", async () => {
      const identity = await resolveCommandIdentity("definitely-not-a-command-xyz", [], process.cwd());
      expect(identity.commandPath).toBeNull();
      expect(identity.commandDigest).toBeNull();
    });
  });
});
