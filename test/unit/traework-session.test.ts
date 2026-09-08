/**
 * 单元测试：项目名/路径匹配 + 面板模式识别（开发计划 §4.5 决策 9/12 + 模式切换）。
 */
import { describe, it, expect } from "vitest";
import {
  detectModeFromText,
  matchProjectItem,
  normComparePath,
  projectBasename,
  resolveMode,
} from "../../src/agents/traework/ui/session.js";

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

describe("detectModeFromText 自然语言识别", () => {
  it("识别英文模式名（含空格/连字符变体，大小写不敏感）", () => {
    expect(detectModeFromText("切换到 Code 模式")).toBe("Code");
    expect(detectModeFromText("use code mode please")).toBe("Code");
    expect(detectModeFromText("switch to CODE-MODE")).toBe("Code");
    expect(detectModeFromText("用 Design 模式做首页")).toBe("Design");
    expect(detectModeFromText("Work 模式下实现")).toBe("Work");
  });

  it("识别中文别名", () => {
    expect(detectModeFromText("用代码模式开发")).toBe("Code");
    expect(detectModeFromText("编码模式下补测试")).toBe("Code");
    expect(detectModeFromText("设计模式画五视图")).toBe("Design");
    expect(detectModeFromText("工作模式帮我整理文档")).toBe("Work");
  });

  it("未提及模式则返回 undefined", () => {
    expect(detectModeFromText("实现登录接口")).toBeUndefined();
    expect(detectModeFromText("")).toBeUndefined();
    // 只出现模式名但没有 mode/模式 上下文，不误判
    expect(detectModeFromText("code review 一下")).toBeUndefined();
  });
});

describe("resolveMode 优先级", () => {
  it("显式参数优先于文本", () => {
    expect(resolveMode("Code", "用 Design 模式")).toEqual({ mode: "Code", source: "param" });
  });

  it("无参数时用文本识别", () => {
    expect(resolveMode(undefined, "切换到 Design 模式")).toEqual({ mode: "Design", source: "text" });
  });

  it("都识别不到则默认 Work", () => {
    expect(resolveMode(undefined, "实现登录接口")).toEqual({ mode: "Work", source: "default" });
  });
});
