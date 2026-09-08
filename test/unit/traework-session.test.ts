/**
 * 单元测试：项目名/路径匹配（开发计划 §4.5 决策 9/12）。
 */
import { describe, it, expect } from "vitest";
import { matchProjectItem, normComparePath, projectBasename } from "../../src/agents/traework/ui/session.js";

describe("projectBasename", () => {
  it("取路径末段（兼容正反斜杠与尾部斜杠）", () => {
    expect(projectBasename("D:\\Trae项目\\zhiyu")).toBe("zhiyu");
    expect(projectBasename("D:/Trae项目/zhiyu")).toBe("zhiyu");
    expect(projectBasename("D:\\Trae项目\\zhiyu\\")).toBe("zhiyu");
  });
});

describe("normComparePath", () => {
  it("统一分隔符、大小写与尾部斜杠", () => {
    expect(normComparePath("D:\\Trae项目\\Zhiyu\\")).toBe("d:/trae项目/zhiyu");
    expect(normComparePath("d:/trae项目/zhiyu")).toBe("d:/trae项目/zhiyu");
  });
});

describe("matchProjectItem", () => {
  it("按名称匹配（不区分大小写）", () => {
    expect(matchProjectItem({ name: "zhiyu", subtitle: "" }, "D:\\Trae项目\\zhiyu")).toBe(true);
    expect(matchProjectItem({ name: "ZhiYu", subtitle: "" }, "D:/Trae项目/zhiyu")).toBe(true);
    expect(matchProjectItem({ name: "AquaWisp", subtitle: "" }, "D:\\Trae项目\\zhiyu")).toBe(false);
  });

  it("按副标题路径匹配（绝对路径或尾部片段）", () => {
    expect(matchProjectItem({ name: "任意名", subtitle: "d:\\Trae项目\\zhiyu" }, "D:\\Trae项目\\zhiyu")).toBe(true);
    expect(matchProjectItem({ name: "任意名", subtitle: "…\\Trae项目\\zhiyu" }, "D:\\Trae项目\\zhiyu")).toBe(false);
    expect(matchProjectItem({ name: "x", subtitle: "c:\\Users\\Lenovo\\.trae-cn\\assistant" }, "D:\\Trae项目\\zhiyu")).toBe(false);
  });

  it("名称不同且路径不同则不匹配", () => {
    expect(matchProjectItem({ name: "docode-s3", subtitle: "d:\\Trae项目\\docode-s3" }, "D:\\Trae项目\\zhiyu")).toBe(false);
  });
});
