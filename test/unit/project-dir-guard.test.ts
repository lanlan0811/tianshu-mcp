/**
 * 项目目录安全闸门单测：resolveProjectDir / assertSafeProjectDir。
 * 防两类事故：写错路径（相对路径/不存在/符号链接歧义）、worker 写到仓库外（主目录/系统根目录）。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertSafeProjectDir, resolveProjectDir, normPath, dangerKey } from "../../src/util/path.js";
import { makeTmpRoot, rmrf } from "../test-utils.js";

describe("resolveProjectDir", () => {
  it("拒绝相对路径", () => {
    expect(() => resolveProjectDir("some/relative/dir")).toThrow(/绝对路径/);
    expect(() => resolveProjectDir("./x")).toThrow(/绝对路径/);
  });

  it("拒绝不存在的目录", () => {
    expect(() => resolveProjectDir("/no/such/dir-tianshu-mcp-test")).toThrow(/不存在/);
  });

  it("拒绝文件（必须是目录）", async () => {
    const root = await makeTmpRoot("dir-guard-file");
    const file = path.join(root, "a.txt");
    fs.writeFileSync(file, "x");
    expect(() => resolveProjectDir(file)).toThrow(/不存在|目录/);
    await rmrf(root);
  });

  it("正常目录：返回 raw/canonical/norm", async () => {
    const root = await makeTmpRoot("dir-guard-ok");
    const r = resolveProjectDir(root);
    expect(r.raw).toBe(root);
    expect(r.norm).toBe(normPath(fs.realpathSync(root)));
    await rmrf(root);
  });

  it("符号链接被 realpath 消除并标记 viaSymlink", async () => {
    const root = await makeTmpRoot("dir-guard-real");
    const sub = path.join(root, "real-proj");
    fs.mkdirSync(sub);
    const link = path.join(root, "link-proj");
    fs.symlinkSync(sub, link);
    const r = resolveProjectDir(link);
    expect(r.viaSymlink).toBe(true);
    expect(r.canonical).toBe(fs.realpathSync(sub));
    expect(r.norm).toBe(normPath(fs.realpathSync(sub)));
    const direct = resolveProjectDir(sub);
    expect(direct.norm).toBe(r.norm); // 两个字符串,同一目录
    await rmrf(root);
  });
});

describe("assertSafeProjectDir", () => {
  it("拒绝文件系统根目录", () => {
    expect(() => assertSafeProjectDir("/")).toThrow(/根级目录|子树/);
  });

  it("拒绝用户主目录本身", () => {
    expect(() => assertSafeProjectDir(os.homedir())).toThrow(/主目录/);
  });

  it("拒绝系统目录（realpath 前后形态都覆盖）", () => {
    if (process.platform !== "win32") {
      // /etc、/usr 是 POSIX 路径；Windows 上 normPath("/etc") 得到 "<当前盘>:/etc"，
      // 该目录不存在，命中的是「目录不存在」而非拒绝清单，故按平台排除。
      expect(() => assertSafeProjectDir("/etc")).toThrow(/拒绝|根级目录/);
      expect(() => assertSafeProjectDir("/usr")).toThrow(/拒绝|根级目录/);
    } else {
      // Windows 侧改为校验等价语义：盘符根与系统目录都必须被拒绝
      expect(() => assertSafeProjectDir("C:/")).toThrow(/拒绝|根级目录/);
      expect(() => assertSafeProjectDir("C:/Windows")).toThrow(/拒绝|根级目录/);
    }
    if (process.platform === "darwin") {
      // macOS /tmp→/private/tmp、/var→/private/var：realpath 后也必须命中
      expect(() => assertSafeProjectDir("/tmp")).toThrow(/拒绝|根级目录/);
      expect(() => assertSafeProjectDir("/var")).toThrow(/拒绝|根级目录/);
    }
  });

  it("系统根目录的子目录不受影响（/tmp/xxx、/Users/name/repo）", async () => {
    const root = await makeTmpRoot("dir-guard-nested");
    const r = assertSafeProjectDir(root); // 位于 /tmp 或 /var/folders 下
    expect(r.norm.length).toBeGreaterThan(0);
    await rmrf(root);
  });
});

describe("dangerKey（win32 具名危险目录大小写不敏感）", () => {
  it("win32：大写/混合形态归一到小写 key（命中 DANGEROUS_ROOTS 字面量）", () => {
    // c:/Windows（normPath 只小写盘符）与 C:\Users 的 norm 形态 c:/Users、小写变体均归一
    expect(dangerKey("c:/Windows", "win32")).toBe("c:/windows");
    expect(dangerKey("c:/Users", "win32")).toBe("c:/users");
    expect(dangerKey("c:/WINDOWS", "win32")).toBe("c:/windows");
    expect(dangerKey("c:/windows", "win32")).toBe("c:/windows");
    expect(dangerKey("C:/Program Files", "win32")).toBe("c:/program files");
    expect(dangerKey("D:/", "win32")).toBe("d:/");
  });

  it("win32 下普通项目路径小写化后不命中任何危险根（精确相等才命中）", () => {
    expect(dangerKey("c:/users/name/repo", "win32")).toBe("c:/users/name/repo");
    expect(dangerKey("d:/proj", "win32")).toBe("d:/proj");
  });

  it("POSIX：保留大小写（/ETC ≠ /etc），普通项目路径原样不命中", () => {
    expect(dangerKey("/home/user/proj", "linux")).toBe("/home/user/proj");
    expect(dangerKey("/Users/x/repo", "darwin")).toBe("/Users/x/repo");
    expect(dangerKey("/ETC", "linux")).toBe("/ETC"); // POSIX 大小写敏感：不命中 /etc
  });
});
