import { describe, expect, it } from "vitest";
import {
  ACTIVE_STATUSES,
  AGENT_EVENT_NAMES,
  STATUS_EVENT_NAMES,
  TASK_STATUSES,
  TERMINAL_STATUSES,
  classifyEvent,
  isActiveStatus,
  isAgentEventName,
  isTerminalStatus,
  parseEventStream,
} from "@/core/events";

describe("词表镜像", () => {
  it("与真源规模一致（任何一侧漂移都会被 check-schema-parity 拦截）", () => {
    expect(TASK_STATUSES).toHaveLength(10);
    expect(TERMINAL_STATUSES).toHaveLength(5);
    expect(ACTIVE_STATUSES).toHaveLength(4);
    expect(AGENT_EVENT_NAMES).toHaveLength(5);
    expect(STATUS_EVENT_NAMES).toHaveLength(17);
  });

  it("活动态与终态互不重叠且都包含于全量状态", () => {
    for (const s of ACTIVE_STATUSES) expect(TASK_STATUSES).toContain(s);
    for (const s of TERMINAL_STATUSES) expect(TASK_STATUSES).toContain(s);
    const overlap = ACTIVE_STATUSES.filter((s) => (TERMINAL_STATUSES as readonly string[]).includes(s));
    expect(overlap).toEqual([]);
  });

  it("判定函数与集合一致", () => {
    expect(isActiveStatus("running")).toBe(true);
    expect(isTerminalStatus("succeeded")).toBe(true);
    expect(isTerminalStatus("running")).toBe(false);
    expect(isAgentEventName("rework_triggered")).toBe(true);
    expect(isAgentEventName("note")).toBe(false);
  });
});

describe("classifyEvent", () => {
  it("区分状态跃迁 / 细粒度 agent 事件 / 进度审计", () => {
    expect(classifyEvent("succeeded")).toBe("status");
    expect(classifyEvent("task_dispatched")).toBe("agent");
    expect(classifyEvent("note")).toBe("note");
    expect(classifyEvent("未知事件")).toBe("unknown");
  });
});

describe("parseEventStream", () => {
  it("解析 JSON Lines 并带上物理行号与类别", () => {
    const text = [
      '{"ts":"2026-09-26T11:41:03.512Z","event":"created","state":"queued","detail":"已创建"}',
      '{"ts":"2026-09-26T11:41:12.884Z","event":"task_dispatched","state":"running","data":{"round":0}}',
    ].join("\n");
    const { events, badLines } = parseEventStream(text);
    expect(badLines).toBe(0);
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe("status");
    expect(events[1]?.kind).toBe("agent");
    expect(events[1]?.data).toEqual({ round: 0 });
    expect(events.map((e) => e.line)).toEqual([1, 2]);
  });

  it("坏行跳过但计数（不静默伪装成正常）", () => {
    const text = ['{"event":"note","state":"running"}', "{坏行", "", '{"noEvent":true}'].join("\n");
    const { events, badLines } = parseEventStream(text);
    expect(events).toHaveLength(1);
    expect(badLines).toBe(2);
  });

  it("缺少 detail 时给出 null 而不是空串", () => {
    const { events } = parseEventStream('{"event":"queued","state":"queued"}');
    expect(events[0]?.detail).toBeNull();
    expect(events[0]?.data).toBeNull();
  });

  it("空文本返回空结果", () => {
    expect(parseEventStream("")).toEqual({ events: [], badLines: 0 });
  });
});