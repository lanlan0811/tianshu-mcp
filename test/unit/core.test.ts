/** 单元测试：路径规范化 / id / 状态迁移 / 事件流 / 命令分词 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { normPath, projectHash } from "../../src/util/path.js";
import { genTaskId } from "../../src/util/id.js";
import { splitCmd, toAcceptanceDef } from "../../src/config/store.js";
import {
  TRANSITIONS,
  isTerminal,
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
} from "../../src/tasks/task.js";

describe("路径规范化", () => {
  it("盘符小写 + 正斜杠（目录名保留大小写）", () => {
    if (process.platform !== "win32") return; // Windows 专用语义
    const p = normPath("D:\\Trae项目\\Foo\\");
    expect(p).toBe("d:/Trae项目/Foo");
    expect(/^[a-z]:/.test(p)).toBe(true);
    expect(p).not.toContain("\\");
  });
  it("相同路径 hash 稳定且 16 位", () => {
    const base = path.resolve("tianshu-mcp");
    const a = projectHash(base);
    const b = projectHash(`${base}${path.sep}`);
    const c = projectHash(base);
    expect(a).toBe(b); // 尾分隔符不影响
    expect(a).toBe(c);
    expect(a).toHaveLength(16);
  });
});

describe("任务 id", () => {
  it("tsk_ 前缀 + 时间戳 + 随机尾", () => {
    const id = genTaskId();
    expect(id).toMatch(/^tsk_\d{14}_[0-9a-f]{6}$/);
    expect(genTaskId()).not.toBe(genTaskId());
  });
});

describe("命令分词（非 shell）", () => {
  it("引号与空白", () => {
    expect(splitCmd("git diff --check")).toEqual(["git", "diff", "--check"]);
    expect(splitCmd('node "my script.js" arg')).toEqual(["node", "my script.js", "arg"]);
    expect(splitCmd("npm run 'a b'")).toEqual(["npm", "run", "a b"]);
  });

  // issue #17：把极简分词的边界语义钉死。这些行为是「字符串形态 cmd」的既有事实，
  // 文档据此警示「推荐一律用数组形态」；将来若改分词器，这些用例应先被有意识地修改。
  it("边界语义锁定（无转义、引号不闭合不报错、空引号产出空参数）", () => {
    // 无引号：按空白拆，连续/首尾空白折叠
    expect(splitCmd("npm run a b")).toEqual(["npm", "run", "a", "b"]);
    expect(splitCmd("  spaced   out  ")).toEqual(["spaced", "out"]);
    // 引号不闭合：不报错，引号作为普通字符参与 \S+ 匹配
    expect(splitCmd('npm run "unclosed arg')).toEqual(["npm", "run", '"unclosed', "arg"]);
    // 无转义支持：反斜杠是普通字符，\" 不能用于在双引号内转义
    expect(splitCmd('node "a\\"b"')).toEqual(["node", "a\\", 'b"']);
    // 空引号：产出空参数（调用方须自行防范空 argv 元素）
    expect(splitCmd('cmd "" empty')).toEqual(["cmd", "", "empty"]);
  });

  it("数组形态不经分词（toAcceptanceDef 原样透传）", () => {
    const def = toAcceptanceDef({ name: "x", cmd: ["npm", "run", "a b"] });
    expect(def.cmd).toEqual(["npm", "run", "a b"]);
    expect(def.displayCmd).toBe("npm run a b");
  });
});

describe("状态机迁移表", () => {
  it("合法迁移与终态", () => {
    expect(TRANSITIONS.queued).toContain("running");
    expect(TRANSITIONS.verify_start).toContain("succeeded");
    expect(TRANSITIONS.verify_start).toContain("fixing");
    expect(TRANSITIONS.running).toContain("needs_user");
    expect(TRANSITIONS.needs_user).toContain("queued");
    expect(isTerminal("succeeded")).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(TERMINAL_STATUSES).toHaveLength(5);
    expect(ACTIVE_STATUSES).toContain("queued");
    expect(ACTIVE_STATUSES).not.toContain("needs_user");
  });
});
