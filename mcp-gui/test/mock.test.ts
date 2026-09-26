import { describe, expect, it } from "vitest";
import { MOCK_HOME, fixtureFileCount, mockApi } from "@/api/mock";
import { DEFAULT_WINDOW_BYTES } from "@/core/tailwindow";

describe("mock 数据出口", () => {
  it("fixtures 在构建期被打包（离线也能调 UI）", () => {
    expect(fixtureFileCount()).toBeGreaterThan(10);
  });

  it("数据目录状态含自动探测目录", async () => {
    const state = await mockApi.getDataHomeState();
    expect(state.detected).toBe(MOCK_HOME);
    expect(state.entries.length).toBeGreaterThan(0);
  });

  it("listTasks 解析快照并聚合产物轮次", async () => {
    const tasks = await mockApi.listTasks({
      dataHome: MOCK_HOME,
      filter: { keyword: "", agentId: null, status: null, projectPath: null, from: null, to: null, onlyActive: false },
      sortKey: "updatedAt",
      sortDir: "desc",
    });
    expect(tasks.length).toBe(4);
    const rework = tasks.find((t) => t.taskId === "tsk_20260926135200_d4e5f6");
    expect(rework?.artifacts.agentLogs).toEqual([0, 1]);
    expect(rework?.artifacts.reportJson).toEqual([0, 1]);
    const dryRun = tasks.find((t) => t.taskId === "tsk_20260927090500_g7h8i9");
    expect(dryRun?.dryRun).toBe(true);
    expect(dryRun?.artifacts.dryRunMd).toEqual([0]);
    expect(dryRun?.artifacts.hasDryRunPlan).toBe(true);
    expect(dryRun?.artifacts.reportMd).toEqual([]);
  });

  it("readEvents 返回带类别的事件且无坏行", async () => {
    const res = await mockApi.readEvents({
      dataHome: MOCK_HOME,
      taskId: "tsk_20260926114012_a1b2c3",
    });
    expect(res.events.length).toBeGreaterThan(5);
    expect(res.badLines).toBe(0);
    expect(res.events[0]?.kind).toBe("status");
    expect(res.events.some((e) => e.kind === "agent")).toBe(true);
    expect(res.events.some((e) => e.kind === "note")).toBe(true);
  });

  it("readEvents 支持只取尾部 N 条", async () => {
    const res = await mockApi.readEvents({
      dataHome: MOCK_HOME,
      taskId: "tsk_20260926114012_a1b2c3",
      limit: 2,
    });
    expect(res.events).toHaveLength(2);
  });

  it("readLog 尾部窗口返回文本并与总字节数一致", async () => {
    const res = await mockApi.readLog({
      dataHome: MOCK_HOME,
      relPath: "logs/server.log",
      mode: "tail",
    });
    expect(res.text).toContain("启动");
    expect(res.totalBytes).toBeGreaterThan(0);
    expect(res.loadedTo).toBe(res.totalBytes);
    expect(res.text.length).toBeGreaterThan(0);
  });

  it("readLog 向前加载返回更早的一块", async () => {
    const first = await mockApi.readLog({
      dataHome: MOCK_HOME,
      relPath: "logs/server.log",
      mode: "tail",
      windowBytes: 120,
    });
    const earlier = await mockApi.readLog({
      dataHome: MOCK_HOME,
      relPath: "logs/server.log",
      mode: "before",
      loadedFrom: first.loadedFrom,
      windowBytes: 120,
    });
    expect(earlier.loadedFrom).toBeLessThan(first.loadedFrom);
    expect(earlier.toByte).toBe(first.loadedFrom);
  });

  it("readReport 命中与缺失都能如实回报", async () => {
    const found = await mockApi.readReport({
      dataHome: MOCK_HOME,
      taskId: "tsk_20260926114012_a1b2c3",
      round: 0,
      kind: "json",
    });
    expect(found.missing).toBe(false);
    expect(found.text).toContain("verdict");

    const missing = await mockApi.readReport({
      dataHome: MOCK_HOME,
      taskId: "tsk_20260926114012_a1b2c3",
      round: 9,
      kind: "md",
    });
    expect(missing.missing).toBe(true);
    expect(missing.text).toBe("");
  });

  it("searchAll 在所选范围内命中并分组", async () => {
    const res = await mockApi.searchAll({
      dataHome: MOCK_HOME,
      keyword: "验收",
      scope: { eventStream: true, agentLogs: true, verifyLogs: true, reports: true, serverLog: true },
      caseSensitive: false,
      maxHitsPerFile: 50,
    });
    expect(res.totalHits).toBeGreaterThan(0);
    expect(res.groups.length).toBeGreaterThan(0);
    expect(res.cancelled).toBe(false);
  });

  it("searchAll 空关键字不扫描", async () => {
    const res = await mockApi.searchAll({
      dataHome: MOCK_HOME,
      keyword: "   ",
      scope: { eventStream: true, agentLogs: false, verifyLogs: false, reports: false, serverLog: false },
      caseSensitive: false,
      maxHitsPerFile: 10,
    });
    expect(res.scannedFiles).toBe(0);
  });

  it("最大命中数生效并标记 truncated", async () => {
    const res = await mockApi.searchAll({
      dataHome: MOCK_HOME,
      keyword: "e",
      scope: { eventStream: false, agentLogs: false, verifyLogs: false, reports: false, serverLog: true },
      caseSensitive: false,
      maxHitsPerFile: 3,
    });
    const group = res.groups[0];
    expect(group?.hits.length).toBeLessThanOrEqual(3);
    expect(group?.truncated).toBe(true);
  });

  it("导出在 mock 下明确失败（不假装成功）", async () => {
    await expect(
      mockApi.exportFile({ dataHome: MOCK_HOME, relPath: "logs/server.log", targetPath: "/tmp/x" }),
    ).rejects.toThrow(/不支持导出/);
    await expect(
      mockApi.exportTaskZip({
        dataHome: MOCK_HOME,
        taskId: "tsk_20260926114012_a1b2c3",
        targetPath: "/tmp/x.zip",
        excludeHeavyLogs: true,
      }),
    ).rejects.toThrow(/不支持导出/);
  });

  it("更新相关命令返回明确的“不可用”状态与手动下载入口", async () => {
    const probe = await mockApi.probeUpdateSources();
    expect(probe.degraded).toBe(true);
    const check = await mockApi.checkUpdate("auto");
    expect(check.available).toBe(false);
    expect(check.manualDownloadUrl).toContain("github.com");
  });

  it("默认窗口常量被用于尾部读取", async () => {
    const res = await mockApi.readLog({ dataHome: MOCK_HOME, relPath: "logs/server.log", mode: "tail" });
    expect(res.totalBytes).toBeLessThan(DEFAULT_WINDOW_BYTES);
  });
});