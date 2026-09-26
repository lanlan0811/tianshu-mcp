/**
 * 应用主状态（三栏数据、各 Tab 内容、搜索与更新）。
 *
 * 所有取数一律经 `@/api` 出口；本模块不直接访问文件系统与 Tauri。
 */
import { computed, reactive } from "vue";
import { api, isMockRuntime } from "@/api";
import type {
  CheckUpdateResult,
  DataHomeState,
  LogChunk,
  ProbeSourceResult,
  SearchRequest,
  SearchResult,
  SortDir,
  SortKey,
  TaskEvent,
  TaskFilter,
  TaskSummary,
} from "@/api/types";
import { emptyLogFilter, type LogFilter } from "@/core/logline";
import { emptyFilter, facetValues, filterTasks, sortTasks } from "@/core/filter";
import { DEFAULT_WINDOW_BYTES } from "@/core/tailwindow";

export type TabKey = "events" | "agentLogs" | "verifyLogs" | "reports" | "serverLog" | "search";
export type ReportKind = "md" | "json" | "html" | "dry-run-md" | "dry-run-json";

export interface SearchState {
  keyword: string;
  caseSensitive: boolean;
  scope: SearchRequest["scope"];
  result: SearchResult | null;
  running: boolean;
  scanned: number;
}

export interface UpdateState {
  currentVersion: string;
  updaterConfigured: boolean;
  checking: boolean;
  installing: boolean;
  probe: ProbeSourceResult | null;
  result: CheckUpdateResult | null;
}

const EMPTY_HOME: DataHomeState = { detected: "", active: "", entries: [] };

export const app = reactive({
  ready: false,
  dataHome: EMPTY_HOME as DataHomeState,
  tasks: [] as TaskSummary[],
  tasksLoading: false,
  filter: emptyFilter() as TaskFilter,
  sortKey: "updatedAt" as SortKey,
  sortDir: "desc" as SortDir,
  selectedTaskId: null as string | null,
  tab: "events" as TabKey,
  error: null as string | null,

  // 事件流
  events: [] as TaskEvent[],
  eventsBadLines: 0,
  eventsLoadedFrom: 0,
  eventsLoadedTo: 0,
  eventsTotalBytes: 0,
  eventsWindowBytes: DEFAULT_WINDOW_BYTES,
  eventsLoading: false,

  // 原始日志（agent-* / verify-* / server.log 共用）
  logRelPath: "",
  logText: "",
  logChunk: null as LogChunk | null,
  logFilter: emptyLogFilter() as LogFilter,
  logShowLineNumbers: true,
  logWrap: false,
  logFollow: true,
  logLoading: false,

  // 报告
  reportKind: "md" as ReportKind,
  reportRound: 0,
  reportText: "",
  reportMissing: false,
  reportLoading: false,
  compareOn: false,
  compareLeftRound: 0,
  compareRightRound: 0,

  search: {
    keyword: "",
    caseSensitive: false,
    scope: {
      eventStream: true,
      agentLogs: true,
      verifyLogs: true,
      reports: true,
      serverLog: true,
    },
    result: null,
    running: false,
    scanned: 0,
  } as SearchState,

  update: {
    currentVersion: "",
    updaterConfigured: false,
    checking: false,
    installing: false,
    probe: null,
    result: null,
  } as UpdateState,
});

export const visibleTasks = computed(() =>
  sortTasks(filterTasks(app.tasks, app.filter), app.sortKey, app.sortDir),
);

export const taskFacets = computed(() => facetValues(app.tasks));

export const selectedTask = computed(
  () => app.tasks.find((t) => t.taskId === app.selectedTaskId) ?? null,
);

export function setError(err: unknown): void {
  app.error = err instanceof Error ? err.message : String(err);
}

export function clearError(): void {
  app.error = null;
}

/* ---------------- 数据目录 ---------------- */

export async function refreshDataHome(): Promise<void> {
  try {
    app.dataHome = await api.getDataHomeState();
    app.error = null;
  } catch (err) {
    setError(err);
  }
}

export async function setActiveDataHome(path: string): Promise<void> {
  try {
    app.dataHome = await api.setActiveDataHome(path);
    app.selectedTaskId = null;
    await refreshTasks();
  } catch (err) {
    setError(err);
  }
}

export async function addDataHome(): Promise<void> {
  try {
    const picked = await api.pickDirectory();
    if (!picked) return;
    app.dataHome = await api.addDataHome(picked);
    await refreshTasks();
  } catch (err) {
    setError(err);
  }
}

export async function removeDataHome(path: string): Promise<void> {
  try {
    app.dataHome = await api.removeDataHome(path);
    await refreshTasks();
  } catch (err) {
    setError(err);
  }
}

/* ---------------- 任务列表 ---------------- */

export async function refreshTasks(): Promise<void> {
  app.tasksLoading = true;
  try {
    app.tasks = await api.listTasks({
      dataHome: app.dataHome.active,
      filter: app.filter,
      sortKey: app.sortKey,
      sortDir: app.sortDir,
    });
    app.error = null;
    if (app.selectedTaskId && !app.tasks.some((t) => t.taskId === app.selectedTaskId)) {
      app.selectedTaskId = null;
    }
    if (!app.selectedTaskId && app.tasks.length > 0) {
      await selectTask(app.tasks[0]?.taskId ?? null);
    }
  } catch (err) {
    setError(err);
  } finally {
    app.tasksLoading = false;
  }
}

export async function selectTask(taskId: string | null): Promise<void> {
  app.selectedTaskId = taskId;
  if (!taskId) return;
  await openTab(app.tab);
}

export async function openTab(tab: TabKey): Promise<void> {
  app.tab = tab;
  const task = selectedTask.value;
  if (!task) return;
  switch (tab) {
    case "events":
      await loadEvents(true);
      break;
    case "agentLogs":
      await openRoundLog("agent", pickRound(task.artifacts.agentLogs));
      break;
    case "verifyLogs":
      await openRoundLog("verify", pickRound(task.artifacts.verifyLogs));
      break;
    case "reports":
      await openReport(currentReportRound(), app.reportKind);
      break;
    case "serverLog":
      await openLog("logs/server.log");
      break;
    case "search":
    default:
      break;
  }
}

function pickRound(rounds: number[]): number | null {
  if (rounds.length === 0) return null;
  return rounds[rounds.length - 1] ?? null;
}

function currentReportRound(): number {
  const task = selectedTask.value;
  if (!task) return 0;
  if (app.reportKind.startsWith("dry-run")) {
    return pickRound(task.artifacts.dryRunMd) ?? 0;
  }
  return task.reportRound ?? pickRound(task.artifacts.reportMd) ?? 0;
}

/* ---------------- 事件流 ---------------- */

export async function loadEvents(reset: boolean): Promise<void> {
  const taskId = app.selectedTaskId;
  if (!taskId) return;
  if (reset) {
    app.eventsWindowBytes = DEFAULT_WINDOW_BYTES;
  }
  app.eventsLoading = true;
  try {
    const res = await api.readEvents({
      dataHome: app.dataHome.active,
      taskId,
      windowBytes: app.eventsWindowBytes,
    });
    app.events = res.events;
    app.eventsBadLines = res.badLines;
    app.eventsLoadedFrom = res.loadedFrom;
    app.eventsLoadedTo = res.loadedTo;
    app.eventsTotalBytes = res.totalBytes;
    app.error = null;
  } catch (err) {
    setError(err);
  } finally {
    app.eventsLoading = false;
  }
}

export async function loadMoreEvents(): Promise<void> {
  if (app.eventsLoadedFrom <= 0) return;
  app.eventsWindowBytes = app.eventsWindowBytes * 4;
  await loadEvents(false);
}

/* ---------------- 原始日志 ---------------- */

export async function openRoundLog(kind: "agent" | "verify", round: number | null): Promise<void> {
  const taskId = app.selectedTaskId;
  if (!taskId || round === null) {
    app.logRelPath = "";
    app.logText = "";
    app.logChunk = null;
    return;
  }
  await openLog(`tasks/${taskId}/${kind}-${round}.log`);
}

export async function openLog(relPath: string): Promise<void> {
  app.logRelPath = relPath;
  app.logLoading = true;
  try {
    const chunk = await api.readLog({
      dataHome: app.dataHome.active,
      relPath,
      mode: "tail",
      windowBytes: DEFAULT_WINDOW_BYTES,
    });
    app.logChunk = chunk;
    app.logText = chunk.text;
    app.error = null;
  } catch (err) {
    setError(err);
  } finally {
    app.logLoading = false;
  }
}

export async function loadMoreLog(): Promise<void> {
  const chunk = app.logChunk;
  if (!chunk || chunk.loadedFrom <= 0) return;
  app.logLoading = true;
  try {
    const before = await api.readLog({
      dataHome: app.dataHome.active,
      relPath: app.logRelPath,
      mode: "before",
      loadedFrom: chunk.loadedFrom,
      windowBytes: DEFAULT_WINDOW_BYTES,
    });
    app.logChunk = {
      ...chunk,
      loadedFrom: before.loadedFrom,
      totalBytes: before.totalBytes,
    };
    app.logText = before.text + app.logText;
    app.error = null;
  } catch (err) {
    setError(err);
  } finally {
    app.logLoading = false;
  }
}

/** 实时增量：把新追加的尾部内容合并进来（跟随开启时才自动滚底，见组件） */
export async function applyLogGrowth(totalBytes: number): Promise<void> {
  const chunk = app.logChunk;
  if (!chunk || totalBytes <= chunk.loadedTo) return;
  try {
    const fresh = await api.readLog({
      dataHome: app.dataHome.active,
      relPath: app.logRelPath,
      mode: "tail",
      windowBytes: Math.max(DEFAULT_WINDOW_BYTES, totalBytes - chunk.loadedTo + 4096),
    });
    if (fresh.text.length > 0) {
      app.logText = app.logText + fresh.text;
      app.logChunk = { ...chunk, loadedTo: fresh.toByte, totalBytes: fresh.totalBytes };
    }
  } catch {
    // 实时增量失败不打断阅读（下次事件会重试）
  }
}

/* ---------------- 报告 ---------------- */

export async function openReport(round: number, kind: ReportKind): Promise<void> {
  const taskId = app.selectedTaskId;
  if (!taskId) return;
  app.reportRound = round;
  app.reportKind = kind;
  app.reportLoading = true;
  try {
    const res = await api.readReport({
      dataHome: app.dataHome.active,
      taskId,
      round,
      kind,
    });
    app.reportText = res.text;
    app.reportMissing = res.missing;
    app.error = null;
  } catch (err) {
    setError(err);
  } finally {
    app.reportLoading = false;
  }
}

/* ---------------- 跨任务搜索 ---------------- */

export async function runSearch(): Promise<void> {
  app.search.running = true;
  app.search.scanned = 0;
  try {
    const res = await api.searchAll({
      dataHome: app.dataHome.active,
      keyword: app.search.keyword,
      scope: { ...app.search.scope },
      caseSensitive: app.search.caseSensitive,
      maxHitsPerFile: 50,
    });
    app.search.result = res;
    app.search.scanned = res.scannedFiles;
    app.error = null;
  } catch (err) {
    setError(err);
  } finally {
    app.search.running = false;
  }
}

export async function cancelSearch(): Promise<void> {
  try {
    await api.searchCancel();
  } catch (err) {
    setError(err);
  }
}

/* ---------------- 导出 ---------------- */

export async function exportCurrentFile(): Promise<string | null> {
  if (!app.logRelPath) return null;
  const base = app.logRelPath.replace(/\//g, "_");
  const target = await api.pickSavePath(base);
  if (!target) return null;
  const res = await api.exportFile({
    dataHome: app.dataHome.active,
    relPath: app.logRelPath,
    targetPath: target,
  });
  return res.targetPath;
}

export async function exportTaskZip(excludeHeavyLogs: boolean): Promise<string | null> {
  const taskId = app.selectedTaskId;
  if (!taskId) return null;
  const target = await api.pickSavePath(`${taskId}.zip`);
  if (!target) return null;
  const res = await api.exportTaskZip({
    dataHome: app.dataHome.active,
    taskId,
    targetPath: target,
    excludeHeavyLogs,
  });
  return res.targetPath;
}

/* ---------------- 更新 ---------------- */

export async function initUpdateInfo(): Promise<void> {
  try {
    const info = await api.getAppVersion();
    app.update.currentVersion = info.version;
    app.update.updaterConfigured = info.updaterConfigured;
  } catch {
    // 取版本失败不阻塞主流程
  }
}

export async function probeUpdateSources(): Promise<void> {
  try {
    app.update.probe = await api.probeUpdateSources();
  } catch (err) {
    setError(err);
  }
}

export async function checkUpdate(source: string): Promise<void> {
  app.update.checking = true;
  try {
    app.update.result = await api.checkUpdate(source);
    app.error = null;
  } catch (err) {
    setError(err);
  } finally {
    app.update.checking = false;
  }
}

export async function installUpdate(source: string): Promise<void> {
  app.update.installing = true;
  try {
    const res = await api.installUpdate(source);
    if (res.error) setError(res.error);
  } catch (err) {
    setError(err);
  } finally {
    app.update.installing = false;
  }
}

/* ---------------- 启动 ---------------- */

export async function bootstrap(): Promise<void> {
  await refreshDataHome();
  await initUpdateInfo();
  await refreshTasks();
  app.ready = true;
}

export const runtimeIsMock = isMockRuntime;