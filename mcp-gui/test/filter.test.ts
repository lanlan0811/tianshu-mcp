import { describe, expect, it } from "vitest";
import { countByPhase, emptyFilter, facetValues, filterTasks, sortTasks } from "@/core/filter";
import type { TaskSummary } from "@/api/types";

function task(patch: Partial<TaskSummary> & { taskId: string }): TaskSummary {
  return {
    status: "succeeded",
    workspaceMode: "project",
    projectPath: "/p/a",
    displayPath: "/p/a",
    agentId: "codex",
    task: "做点事",
    roundsUsed: 1,
    reportRound: 0,
    createdAt: "2026-09-26T11:00:00.000Z",
    updatedAt: "2026-09-26T11:10:00.000Z",
    finishedAt: null,
    lastMessage: null,
    dryRun: false,
    errorType: null,
    checkSummary: null,
    diffstat: null,
    changedFiles: [],
    dataHome: "/home",
    artifacts: {
      agentLogs: [],
      verifyLogs: [],
      reportMd: [],
      reportJson: [],
      reportHtml: [],
      dryRunMd: [],
      dryRunJson: [],
      hasBaseline: false,
      hasDryRunPlan: false,
    },
    ...patch,
  };
}

const tasks: TaskSummary[] = [
  task({ taskId: "tsk_1", status: "running", agentId: "codex", projectPath: "/p/a" }),
  task({ taskId: "tsk_2", status: "failed", agentId: "traework", projectPath: "/p/b", task: "修复溢出" }),
  task({ taskId: "tsk_3", status: "succeeded", agentId: "codex", projectPath: "/p/a", dryRun: true }),
];

describe("filterTasks", () => {
  it("空条件返回全部", () => {
    expect(filterTasks(tasks, emptyFilter())).toHaveLength(3);
  });

  it("只看进行中", () => {
    const out = filterTasks(tasks, { ...emptyFilter(), onlyActive: true });
    expect(out.map((t) => t.taskId)).toEqual(["tsk_1"]);
  });

  it("按 agent / 项目 / 状态过滤", () => {
    expect(filterTasks(tasks, { ...emptyFilter(), agentId: "traework" }).map((t) => t.taskId)).toEqual([
      "tsk_2",
    ]);
    expect(filterTasks(tasks, { ...emptyFilter(), projectPath: "/p/a" })).toHaveLength(2);
    expect(filterTasks(tasks, { ...emptyFilter(), status: "failed" })).toHaveLength(1);
  });

  it("关键字覆盖任务书 / 路径 / ID / agent", () => {
    expect(filterTasks(tasks, { ...emptyFilter(), keyword: "溢出" }).map((t) => t.taskId)).toEqual(["tsk_2"]);
    expect(filterTasks(tasks, { ...emptyFilter(), keyword: "tsk_3" }).map((t) => t.taskId)).toEqual(["tsk_3"]);
  });

  it("时间范围按 updatedAt 过滤", () => {
    const out = filterTasks(tasks, {
      ...emptyFilter(),
      from: "2026-09-26T11:05:00.000Z",
      to: "2026-09-26T11:20:00.000Z",
    });
    expect(out).toHaveLength(3);
    const none = filterTasks(tasks, { ...emptyFilter(), from: "2026-09-27T00:00:00.000Z" });
    expect(none).toHaveLength(0);
  });
});

describe("sortTasks", () => {
  it("按更新时间倒序（默认）", () => {
    const out = sortTasks(
      [task({ taskId: "a", updatedAt: "2026-09-26T10:00:00.000Z" }), task({ taskId: "b", updatedAt: "2026-09-26T12:00:00.000Z" })],
      "updatedAt",
      "desc",
    );
    expect(out.map((t) => t.taskId)).toEqual(["b", "a"]);
  });

  it("同值时按 taskId 稳定升序", () => {
    const same = "2026-09-26T10:00:00.000Z";
    const out = sortTasks(
      [task({ taskId: "z", updatedAt: same }), task({ taskId: "a", updatedAt: same })],
      "updatedAt",
      "desc",
    );
    expect(out.map((t) => t.taskId)).toEqual(["a", "z"]);
  });
});

describe("facetValues / countByPhase", () => {
  it("给出可选分面并排序", () => {
    const facets = facetValues(tasks);
    expect(facets.agents).toEqual(["codex", "traework"]);
    expect(facets.projects).toEqual(["/p/a", "/p/b"]);
    expect(facets.statuses).toEqual(["failed", "running", "succeeded"]);
  });

  it("统计活动态与终态", () => {
    expect(countByPhase(tasks)).toEqual({ active: 1, terminal: 2 });
  });
});