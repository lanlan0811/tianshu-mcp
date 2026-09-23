/**
 * 项目目录安全闸门单测：resolveProjectDir / assertSafeProjectDir。
 * 防两类事故：写错路径（相对路径/不存在/符号链接歧义）、worker 写到仓库外（主目录/系统根目录）。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertSafeProjectDir, resolveProjectDir, normPath, dangerKey, isDangerousProjectDir } from "../../src/util/path.js";
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

  it("系统根目录的子目录不受影响（/tmp/xxx、/var/folders/...、/Users/name/repo）", async () => {
    const root = await makeTmpRoot("dir-guard-nested");
    const r = assertSafeProjectDir(root); // macOS 位于 /var/folders 下——子树拒绝绝不能误伤它
    expect(r.norm.length).toBeGreaterThan(0);
    await rmrf(root);
  });

  it("拒绝系统目录的子树（真实存在目录，win32）", () => {
    if (process.platform !== "win32") return;
    expect(() => assertSafeProjectDir("C:/Windows/System32")).toThrow(/子树|拒绝/);
  });
});

/**
 * 子树拒绝的判定逻辑抽成了可注入 platform 的纯函数，因此能在任意开发机上
 * 验证三平台形态（含 macOS 的 /private/... 与 win32 的大小写归一）。
 * 关键反例（必须放行）：macOS 的 /private/var/folders/...（os.tmpdir()）、
 * c:/windows.old、/etcetera —— 边界感知前缀不得把它们当成子树命中。
 */
describe("isDangerousProjectDir（精确根 / 盘符根 / 系统目录子树）", () => {
  const dangerous: Array<[string, NodeJS.Platform]> = [
    // win32：系统目录子树
    ["c:/windows", "win32"],
    ["c:/windows/system32", "win32"],
    ["c:/Windows/System32", "win32"],
    ["c:/program files", "win32"],
    ["c:/program files/app", "win32"],
    ["c:/Program Files (x86)/App", "win32"],
    // win32：精确根与盘符根
    ["c:/", "win32"],
    ["c:/users", "win32"],
    ["d:", "win32"],
    ["d:/", "win32"],
    // POSIX：系统目录子树
    ["/etc", "linux"],
    ["/etc/passwd", "linux"],
    ["/usr", "linux"],
    ["/usr/local/src", "linux"],
    ["/bin", "linux"],
    ["/bin/x", "linux"],
    ["/sbin", "linux"],
    ["/sbin/x", "linux"],
    // macOS：realpath 后的 /private 形态
    ["/private/etc", "darwin"],
    ["/private/etc/foo", "darwin"],
    // 精确相等的根
    ["/", "linux"],
    ["/var", "linux"],
    ["/tmp", "linux"],
    ["/private/var", "darwin"],
  ];

  const allowed: Array<[string, NodeJS.Platform]> = [
    // 边界感知：同前缀但不是子树
    ["c:/windows.old", "win32"],
    ["/etcetera", "linux"],
    ["/usrlocal", "linux"],
    // 合法工作区（尤其是 macOS 的临时目录——测试基座）
    ["c:/users/name/repo", "win32"],
    ["d:/proj", "win32"],
    ["/private/var/folders/x/y/T/tmp", "darwin"],
    ["/var/folders/x/y/T/tmp", "darwin"],
    ["/var/log", "linux"],
    ["/tmp/xxx", "linux"],
    ["/Users/name/repo", "darwin"],
    ["/home/user/repo", "linux"],
    ["/opt/app", "linux"],
  ];

  for (const [p, platform] of dangerous) {
    it(`拒绝 ${p}（${platform}）`, () => {
      expect(isDangerousProjectDir(p, platform), `${p} 应判为危险`).toBe(true);
    });
  }

  for (const [p, platform] of allowed) {
    it(`放行 ${p}（${platform}）`, () => {
      expect(isDangerousProjectDir(p, platform), `${p} 不应判为危险`).toBe(false);
    });
  }
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

  it("win32 下普通项目路径小写化后仍不是危险目录（子树集也不命中）", () => {
    expect(dangerKey("c:/users/name/repo", "win32")).toBe("c:/users/name/repo");
    expect(dangerKey("d:/proj", "win32")).toBe("d:/proj");
    expect(isDangerousProjectDir("c:/users/name/repo", "win32")).toBe(false);
    expect(isDangerousProjectDir("d:/proj", "win32")).toBe(false);
  });

  it("POSIX：保留大小写（/ETC ≠ /etc），普通项目路径原样不命中", () => {
    expect(dangerKey("/home/user/proj", "linux")).toBe("/home/user/proj");
    expect(dangerKey("/Users/x/repo", "darwin")).toBe("/Users/x/repo");
    expect(dangerKey("/ETC", "linux")).toBe("/ETC"); // POSIX 大小写敏感：不命中 /etc
  });
});
