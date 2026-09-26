import { describe, expect, it } from "vitest";
import { enUS } from "@/i18n/en-US";
import { flattenKeys, interpolate, lookup, messagesOf } from "@/i18n";
import { zhCN } from "@/i18n/zh-CN";
import { byteLength } from "@/core/bytes";
import { formatBytes, formatDateTime, formatDuration, baseName, prettyJson } from "@/core/format";
import {
  agentLogRel,
  dryRunJsonRel,
  eventStreamRel,
  reportHtmlRel,
  taskIdFromRel,
} from "@/core/paths";

describe("i18n 完整性", () => {
  it("中英两包键集合完全一致（结构由 zh-CN 定义，en-US 必须对齐）", () => {
    const zh = Object.keys(flattenKeys(zhCN)).sort();
    const en = Object.keys(flattenKeys(enUS)).sort();
    expect(en).toEqual(zh);
  });

  it("没有空文案", () => {
    for (const [key, value] of Object.entries(flattenKeys(zhCN))) {
      expect(value.trim(), `zh-CN ${key} 为空`).not.toBe("");
    }
    for (const [key, value] of Object.entries(flattenKeys(enUS))) {
      expect(value.trim(), `en-US ${key} 为空`).not.toBe("");
    }
  });

  it("未知路径返回路径本身（不静默返回空串）", () => {
    expect(lookup(zhCN, "nope.nothing")).toBe("nope.nothing");
  });

  it("插值替换已知占位符、保留未知占位符", () => {
    expect(interpolate("共 {n} 个", { n: 3 })).toBe("共 3 个");
    expect(interpolate("{a}-{b}", { a: 1 })).toBe("1-{b}");
  });

  it("按语言取包", () => {
    expect(messagesOf("en-US").app.name).toBe("Tianshu-mcp Logs");
    expect(messagesOf("zh-CN").app.name).toBe("Tianshu-mcp 日志台");
  });
});

describe("format", () => {
  it("字节格式化", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
  });

  it("时间格式化：非法输入原样返回（不编造）", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("不是时间")).toBe("不是时间");
  });

  it("耗时格式化", () => {
    expect(formatDuration(120)).toBe("120 ms");
    expect(formatDuration(1500)).toBe("1.5 s");
    expect(formatDuration(90_000)).toBe("1 m 30 s");
  });

  it("baseName 兼容两种斜杠", () => {
    expect(baseName("a/b/agent-0.log")).toBe("agent-0.log");
    expect(baseName("a\\b\\agent-0.log")).toBe("agent-0.log");
  });

  it("prettyJson 对不可序列化值不抛错", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(typeof prettyJson(circular)).toBe("string");
  });
});

describe("paths 与后端命名约定一致", () => {
  it("任务产物命名", () => {
    expect(eventStreamRel("tsk_1")).toBe("tasks/tsk_1/task.jsonl");
    expect(agentLogRel("tsk_1", 2)).toBe("tasks/tsk_1/agent-2.log");
    expect(reportHtmlRel("tsk_1", 0)).toBe("tasks/tsk_1/report-0.html");
    expect(dryRunJsonRel("tsk_1", 1)).toBe("tasks/tsk_1/dry-run-report-1.json");
  });

  it("dry-run 与常规报告路径不重名（结论口径不同，绝不混用）", () => {
    expect(dryRunJsonRel("tsk_1", 0)).not.toBe("tasks/tsk_1/report-0.json");
  });

  it("从相对路径还原 taskId", () => {
    expect(taskIdFromRel("tasks/tsk_1/agent-0.log")).toBe("tsk_1");
    expect(taskIdFromRel("logs/server.log")).toBeNull();
  });

  it("路径全部使用正斜杠", () => {
    expect(eventStreamRel("tsk_1")).not.toContain("\\");
    expect(byteLength(eventStreamRel("tsk_1"))).toBeGreaterThan(0);
  });
});