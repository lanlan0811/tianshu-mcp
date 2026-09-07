/** 单元测试：路径规范化 / id / 状态迁移 / 事件流 / 命令分词 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { normPath, projectHash } from "../../src/util/path.js";
import { genTaskId } from "../../src/util/id.js";
import { splitCmd } from "../../src/config/store.js";
import { TRANSITIONS, isTerminal, TERMINAL_STATUSES, ACTIVE_STATUSES } from "../../src/tasks/task.js";

describe("路径规范化", () => {
  it("盘符小写 + 正斜杠（目录名保留大小写）", () => {
    if (process.platform === "win32") {
      const p = normPath("D:\\Trae项目\\Foo\\");
      expect(p).toBe("d:/Trae项目/Foo");
      expect(/^[a-z]:/.test(p)).toBe(true);
      expect(p).not.toContain("\\");
    }
  });
  it("相同路径 hash 稳定且 16 位", () => {
    const a = projectHash(path.resolve("D:\\Trae项目\\tianshu-mcp"));
    const b = projectHash(path.resolve("d:/Trae项目/tianshu-mcp"));
    expect(a).toBe(b);
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
    expect(splitCmd('git diff --check')).toEqual(["git", "diff", "--check"]);
    expect(splitCmd('node "my script.js" arg')).toEqual(["node", "my script.js", "arg"]);
    expect(splitCmd("npm run 'a b'")).toEqual(["npm", "run", "a b"]);
  });
});

describe("状态机迁移表", () => {
  it("合法迁移与终态", () => {
    expect(TRANSITIONS.queued).toContain("running");
    expect(TRANSITIONS.verify_start).toContain("succeeded");
    expect(TRANSITIONS.verify_start).toContain("fixing");
    expect(isTerminal("succeeded")).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(TERMINAL_STATUSES).toHaveLength(5);
    expect(ACTIVE_STATUSES).toContain("queued");
  });
});
