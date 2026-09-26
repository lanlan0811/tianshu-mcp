import { describe, expect, it } from "vitest";
import {
  emptyLogFilter,
  filterLogLines,
  highlightSegments,
  parseLogLine,
  parseLogText,
} from "@/core/logline";

describe("parseLogLine", () => {
  it("解析 [ISO] [LEVEL] msg 三段", () => {
    const line = parseLogLine("[2026-09-26T11:40:12.001Z] [INFO] 启动完成", 7);
    expect(line.ts).toBe("2026-09-26T11:40:12.001Z");
    expect(line.level).toBe("info");
    expect(line.msg).toBe("启动完成");
    expect(line.line).toBe(7);
  });

  it("级别大小写不敏感，未知级别归为 unknown", () => {
    expect(parseLogLine("[t] [WARN] x", 1).level).toBe("warn");
    expect(parseLogLine("[t] [trace] x", 1).level).toBe("unknown");
  });

  it("不符合格式的行原样保留为 unknown（不丢内容、不谎报级别）", () => {
    const line = parseLogLine("裸文本一行", 3);
    expect(line.level).toBe("unknown");
    expect(line.msg).toBe("裸文本一行");
    expect(line.ts).toBeNull();
  });

  it("日志正文可包含方括号", () => {
    const line = parseLogLine("[t] [ERROR] 任务 [tsk_1] 失败", 1);
    expect(line.msg).toBe("任务 [tsk_1] 失败");
    expect(line.level).toBe("error");
  });
});

describe("parseLogText", () => {
  it("忽略末尾换行产生的空元素，并按顺序编号", () => {
    const lines = parseLogText("a\nb\n");
    expect(lines.map((l) => l.raw)).toEqual(["a", "b"]);
    expect(lines.map((l) => l.line)).toEqual([1, 2]);
  });

  it("支持自定义起始行号", () => {
    expect(parseLogText("x", 100)[0]?.line).toBe(100);
  });
});

describe("filterLogLines", () => {
  const lines = parseLogText(
    [
      "[2026-09-26T11:00:00.000Z] [INFO] 开始",
      "[2026-09-26T12:00:00.000Z] [WARN] 慢查询",
      "[2026-09-26T13:00:00.000Z] [ERROR] 失败",
    ].join("\n"),
  );

  it("空过滤器不过滤任何行", () => {
    expect(filterLogLines(lines, emptyLogFilter())).toHaveLength(3);
  });

  it("按级别集合过滤", () => {
    const kept = filterLogLines(lines, { ...emptyLogFilter(), levels: ["error", "warn"] });
    expect(kept).toHaveLength(2);
  });

  it("关键字不区分大小写", () => {
    const kept = filterLogLines(lines, { ...emptyLogFilter(), keyword: "慢查询" });
    expect(kept).toHaveLength(1);
  });

  it("时间范围按 ISO 字典序比较", () => {
    const kept = filterLogLines(lines, {
      ...emptyLogFilter(),
      from: "2026-09-26T11:30:00.000Z",
      to: "2026-09-26T12:30:00.000Z",
    });
    expect(kept).toHaveLength(1);
    expect(kept[0]?.msg).toBe("慢查询");
  });
});

describe("highlightSegments", () => {
  it("无关键字时原样返回单段", () => {
    expect(highlightSegments("abc", "")).toEqual([{ text: "abc", hit: false }]);
  });

  it("多命中切成多段且大小写不敏感", () => {
    const segs = highlightSegments("Error: error 已处理", "error");
    expect(segs.filter((s) => s.hit).map((s) => s.text)).toEqual(["Error", "error"]);
  });

  it("拼回原文不丢字符（结构化分段而非替换）", () => {
    const text = "[INFO] 命中 keyword 一次";
    const segs = highlightSegments(text, "keyword");
    expect(segs.map((s) => s.text).join("")).toBe(text);
  });
});