import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cacheableContentStatus,
  clearContentCache,
  contentCacheKey,
  readContentCache,
  writeContentCache,
  type ContentCacheEntry,
  type ContentCacheKeyInput,
} from "../../src/visual/content-cache.js";

const dirs: string[] = [];
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "content-cache-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

const keyInput = (overrides: Partial<ContentCacheKeyInput> = {}): ContentCacheKeyInput => ({
  imageSha256: "a".repeat(64),
  expect: "蓝色齿轮与白色文字",
  command: "vision-cli",
  commandPath: "/usr/local/bin/vision-cli",
  commandDigest: "b".repeat(64),
  argsTemplate: ["judge", "--image", "<image:path>"],
  cwd: "/project",
  envDigest: "c".repeat(64),
  allowRemote: false,
  samples: 3,
  ...overrides,
});
const entry = (key: string, status: ContentCacheEntry["status"] = "passed"): ContentCacheEntry => ({
  schemaVersion: 1,
  key,
  imageSha256: keyInput().imageSha256,
  expectDigest: "d".repeat(64),
  status,
  code: status === "passed" ? "CONTENT_MATCH" : status === "failed" ? "CONTENT_MISMATCH" : "CONTENT_UNCERTAIN",
  votes: [{ index: 0, passed: status === "failed" ? false : true, reason: "sample 0" }],
  createdAt: "2026-09-15T00:00:00.000Z",
  durationMs: 123,
});

describe("content cache", () => {
  it("derives a stable key from identical input", () => {
    expect(contentCacheKey(keyInput())).toBe(contentCacheKey(keyInput()));
  });
  it.each([
    ["image change", { imageSha256: "e".repeat(64) }],
    ["expect change", { expect: "另一个期望" }],
    ["command change", { command: "other-cli" }],
    ["command binary upgrade (digest)", { commandDigest: "f".repeat(64) }],
    ["command path change", { commandPath: "/opt/other/vision-cli" }],
    ["template change", { argsTemplate: ["judge", "--b64", "<image:base64:file>"] }],
    ["cwd change", { cwd: "/other" }],
    ["environment change", { envDigest: "0".repeat(64) }],
    ["allowRemote change", { allowRemote: true }],
    ["samples change", { samples: 5 }],
    ["minConfidence change", { minConfidence: 0.6 }],
  ])("key miss on %s", (_label, overrides) => {
    expect(contentCacheKey(keyInput(overrides as Partial<ContentCacheKeyInput>))).not.toBe(
      contentCacheKey(keyInput()),
    );
  });
  it("treats an unresolvable command identity as part of the key (null vs digest)", () => {
    expect(contentCacheKey(keyInput({ commandDigest: null, commandPath: null }))).not.toBe(
      contentCacheKey(keyInput()),
    );
  });

  it("round-trips entries and rejects corrupted or foreign files", async () => {
    const dir = await fixture();
    const key = contentCacheKey(keyInput());
    await writeContentCache(dir, entry(key));
    expect(await readContentCache(dir, key)).toEqual(entry(key));
    const file = path.join(dir, "visual-content-cache", `${key}.json`);
    await fs.writeFile(file, "{not json", "utf8");
    expect(await readContentCache(dir, key)).toBeNull();
    await fs.writeFile(
      file,
      JSON.stringify({ ...entry(key), schemaVersion: 99 }),
      "utf8",
    );
    expect(await readContentCache(dir, key)).toBeNull();
    await fs.writeFile(file, JSON.stringify({ ...entry(key), key: "mismatch" }), "utf8");
    expect(await readContentCache(dir, key)).toBeNull();
  });

  it("allows rewriting after a corrupted read (miss + rewrite wins)", async () => {
    const dir = await fixture();
    const key = contentCacheKey(keyInput());
    const file = path.join(dir, "visual-content-cache", `${key}.json`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "garbage", "utf8");
    expect(await readContentCache(dir, key)).toBeNull();
    await writeContentCache(dir, entry(key, "uncertain"));
    expect((await readContentCache(dir, key))?.status).toBe("uncertain");
  });

  it("only successful verdicts are cacheable statuses", () => {
    expect(cacheableContentStatus("passed")).toBe(true);
    expect(cacheableContentStatus("failed")).toBe(true);
    expect(cacheableContentStatus("uncertain")).toBe(true);
    expect(cacheableContentStatus("blocked")).toBe(false);
    expect(cacheableContentStatus("skipped")).toBe(false);
  });

  it("clears all cached verdicts and reports the removed count", async () => {
    const dir = await fixture();
    const first = contentCacheKey(keyInput());
    const second = contentCacheKey(keyInput({ expect: "second expectation" }));
    await writeContentCache(dir, entry(first));
    await writeContentCache(dir, entry(second, "failed"));
    expect(await clearContentCache(dir)).toBe(2);
    expect(await readContentCache(dir, first)).toBeNull();
    expect(await clearContentCache(dir)).toBe(0);
  });
  it("clearing a task without cache is a no-op", async () => {
    const dir = await fixture();
    expect(await clearContentCache(dir)).toBe(0);
  });
});
