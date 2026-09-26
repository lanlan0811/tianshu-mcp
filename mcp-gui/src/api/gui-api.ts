/**
 * 前端唯一数据出口的接口定义（tauri 实现与 mock 实现共同遵守）。
 */
import type {
  AppVersionInfo,
  CheckUpdateResult,
  DataHomeState,
  ExportFileRequest,
  ExportResult,
  ExportTaskZipRequest,
  InstallUpdateResult,
  ListTasksRequest,
  LogChunk,
  Preferences,
  ProbeSourceResult,
  ReadEventsRequest,
  ReadEventsResult,
  ReadLogRequest,
  ReadReportRequest,
  ReadReportResult,
  SearchRequest,
  SearchResult,
  TaskSummary,
} from "./types";

export interface GuiApi {
  getAppVersion(): Promise<AppVersionInfo>;
  getDataHomeState(): Promise<DataHomeState>;
  addDataHome(path: string): Promise<DataHomeState>;
  removeDataHome(path: string): Promise<DataHomeState>;
  setActiveDataHome(path: string): Promise<DataHomeState>;
  /** 原生目录选择（mock 下返回 null） */
  pickDirectory(): Promise<string | null>;
  /** 原生保存路径选择（mock 下返回 null） */
  pickSavePath(defaultName: string): Promise<string | null>;
  listTasks(req: ListTasksRequest): Promise<TaskSummary[]>;
  readEvents(req: ReadEventsRequest): Promise<ReadEventsResult>;
  readLog(req: ReadLogRequest): Promise<LogChunk>;
  readReport(req: ReadReportRequest): Promise<ReadReportResult>;
  exportFile(req: ExportFileRequest): Promise<ExportResult>;
  exportTaskZip(req: ExportTaskZipRequest): Promise<ExportResult>;
  searchAll(req: SearchRequest): Promise<SearchResult>;
  searchCancel(): Promise<void>;
  probeUpdateSources(): Promise<ProbeSourceResult>;
  checkUpdate(source: string): Promise<CheckUpdateResult>;
  installUpdate(source: string): Promise<InstallUpdateResult>;
  getPreferences(): Promise<Preferences>;
  setPreferences(prefs: Preferences): Promise<void>;
  watchStart(paths: string[]): Promise<void>;
  watchStop(): Promise<void>;
}