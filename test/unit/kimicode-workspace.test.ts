import { describe, expect, it } from "vitest";
import {
  matchKimicodeWorkspace,
  normalizeWorkspaceName,
  normalizeWorkspacePath,
} from "../../src/agents/kimicode/workspace.js";

/**
 * 归一与匹配是绑定判据的地基：工作区面板回读的是原生形式 `D:\Trae项目\tianshu-mcp`，
 * 任务上下文里的 projectPath 往往来自 normPath（正斜杠 + 小写盘符）。两者必须归一后相等，
 * 否则同一目录会被判成「未登记」进而触发多余的原生对话框。
 */
describe("Kimi Code 工作区路径归一", () => {
  it("Windows：正斜杠、小写盘符、尾部分隔符、大小写差异归一到同一形式", () => {
    const native = normalizeWorkspacePath("D:\\Trae项目\\tianshu-mcp", "win32");
    expect(native).toBe("D:\\trae项目\\tianshu-mcp");
    expect(normalizeWorkspacePath("d:/Trae项目/tianshu-mcp/", "win32")).toBe(native);
    expect(normalizeWorkspacePath("D:\\Trae项目\\.\\tianshu-mcp", "win32")).toBe(native);
    expect(normalizeWorkspacePath("D:\\TRAE项目\\Tianshu-MCP", "win32")).toBe(native);
  });

  it("盘根保留分隔符；空值不产生伪路径", () => {
    expect(normalizeWorkspacePath("d:", "win32")).toBe("D:\\");
    expect(normalizeWorkspacePath("D:\\", "win32")).toBe("D:\\");
    expect(normalizeWorkspacePath("", "win32")).toBe("");
  });

  it("POSIX：只做词法归一（去尾部斜杠、保留根目录）", () => {
    expect(normalizeWorkspacePath("/Users/kimi/Project/", "darwin")).toBe("/Users/kimi/Project");
    expect(normalizeWorkspacePath("/", "darwin")).toBe("/");
  });
});

describe("Kimi Code 工作区名称归一", () => {
  it("NFKC（全角转半角）+ 折叠空白 + trim + 大小写不敏感", () => {
    expect(normalizeWorkspaceName("  tianshu   MCP ")).toBe("tianshu mcp");
    expect(normalizeWorkspaceName("Ｔｉａｎｓｈｕ")).toBe("tianshu");
    expect(normalizeWorkspaceName("项目\t目录")).toBe("项目 目录");
  });
});

describe("Kimi Code 工作区匹配", () => {
  it("完整路径优先于名称：基名不同也能按路径唯一命中", () => {
    const items = [
      { name: "another-name", path: "D:\\Trae项目\\tianshu-mcp" },
      { name: "tianshu-mcp", path: "E:\\copy\\tianshu-mcp" },
    ];
    expect(matchKimicodeWorkspace(items, "D:/Trae项目/tianshu-mcp", "win32")).toEqual({
      item: items[0],
      ambiguous: false,
      candidates: ["D:\\Trae项目\\tianshu-mcp"],
    });
  });

  it("路径未命中时回退名称匹配；同名不同路径即歧义", () => {
    const items = [
      { name: "tianshu-mcp", path: "D:\\work\\tianshu-mcp" },
      { name: "tianshu-mcp", path: "E:\\copy\\tianshu-mcp" },
    ];
    const result = matchKimicodeWorkspace(items, "D:\\Trae项目\\tianshu-mcp", "win32");
    expect(result.ambiguous).toBe(true);
    expect(result.item).toBeUndefined();
    expect(result.candidates).toEqual(["D:\\work\\tianshu-mcp", "E:\\copy\\tianshu-mcp"]);
  });

  it("同一路径出现多条（面板重复渲染）也是歧义，不猜", () => {
    const items = [
      { name: "tianshu-mcp", path: "D:\\Trae项目\\tianshu-mcp" },
      { name: "tianshu-mcp", path: "d:/Trae项目/tianshu-mcp/" },
    ];
    const result = matchKimicodeWorkspace(items, "D:\\Trae项目\\tianshu-mcp", "win32");
    expect(result.ambiguous).toBe(true);
    expect(result.item).toBeUndefined();
  });

  it("0 命中：不歧义、无候选，交由调用方走原生对话框新增", () => {
    const items = [{ name: "other", path: "D:\\other" }];
    expect(matchKimicodeWorkspace(items, "D:\\Trae项目\\tianshu-mcp", "win32")).toEqual({
      ambiguous: false,
      candidates: [],
    });
  });

  it("面板未渲染 ws-path 时按唯一名称命中（路径仅作辅助）", () => {
    const items: Array<{ name: string; path?: string }> = [{ name: "tianshu-mcp" }];
    expect(matchKimicodeWorkspace(items, "D:\\Trae项目\\tianshu-mcp", "win32")).toEqual({
      item: items[0],
      ambiguous: false,
      candidates: ["tianshu-mcp"],
    });
  });

  it("项目路径为空时不做名称匹配，避免把「无路径」误判为某个工作区", () => {
    const items = [{ name: "tianshu-mcp", path: "D:\\Trae项目\\tianshu-mcp" }];
    expect(matchKimicodeWorkspace(items, "", "win32")).toEqual({ ambiguous: false, candidates: [] });
  });
});