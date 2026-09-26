/**
 * Mock 数据出口：**不装 Rust / 不在桌面运行时**也能完整调 UI 与交互逻辑。
 *
 * 数据来自 `mcp-gui/fixtures/`（真实日志样本，已脱敏），在构建期被 Vite
 * 以 `?raw` 内联为字符串映射，因此浏览器预览与 node 单测都能零 IO 使用。
 *
 * 写操作（导出、安装更新）在 mock 下明确报错，**不假装成功**。
 */
import pkg from "../../package.json";
import { byteLength, sliceRangeByBytes, sliceTailByBytes } from "@/core/bytes";
import { classifyEvent, parseEventStream } from "@/core/events";
import { DEFAULT_WINDOW_BYTES, planInitialWindow } from "@/core/tailwindow";
import type { GuiApi } from "./gui-api";
import type {
  AppVersionInfo,
  ArtifactRounds,
  CheckUpdateResult,
  DataHomeState,
  ExportResult,
  InstallUpdateResult,
  LogChunk,
  Preferences,
  ProbeSourceResult,
  ReadEventsResult,
  ReadReportResult,
  SearchFileGroup,
  SearchHit,
  SearchRequest,
  SearchResult,
  TaskEvent,
  TaskSummary,
} from "./types";

const RAW_FIXTURES = import.meta.glob("../../fixtures/**/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** 相对 fixtures 根的文件映射（键统一为正斜杠） */
function buildFileMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(RAW_FIXTURES)) {
    const idx = key.indexOf("fixtures/");
    if (idx < 0) continue;
    map.set(key.slice(idx + "fixtures/".length), value);
  }
  return map;
}

export const MOCK_FILES: Map<string, string> = buildFileMap();

/** 预览模式下的虚拟数据目录（不指向真实磁盘） */
export const MOCK_HOME = "<预览数据目录>";

export const MOCK_APP_VERSION: string = pkg.version;

function emptyArtifacts(): ArtifactRounds {
  return {
    agentLogs: [],
    verifyLogs: [],
    reportMd: [],
    reportJson: [],
    reportHtml: [],
    dryRunMd: [],
    dryRunJson: [],
    hasBaseline: false,
    hasDryRunPlan: false,
  };
}

function collectArtifacts(taskId: string): ArtifactRounds {
  const a = emptyArtifacts();
  const prefix = `tasks/${taskId}/`;
  for (const rel of MOCK_FILES.keys()) {
    if (!rel.startsWith(prefix)) continue;
    const name = rel.slice(prefix.length);
    const m = /^(agent|verify|report|dry-run-report)-(\d+)\.(log|md|json|html)$/.exec(name);
    if (m) {
      const kind = m[1] ?? "";
      const round = Number(m[2] ?? "0");
      const ext = m[3] ?? "";
      if (kind === "agent" && ext === "log") a.agentLogs.push(round);
      else if (kind === "verify" && ext === "log") a.verifyLogs.push(round);
      else if (kind === "report" && ext === "md") a.reportMd.push(round);
      else if (kind === "report" && ext === "json") a.reportJson.push(round);
      else if (kind === "report" && ext === "html") a.reportHtml.push(round);
      else if (kind === "dry-run-report" && ext === "md") a.dryRunMd.push(round);
      else if (kind === "dry-run-report" && ext === "json") a.dryRunJson.push(round);
      continue;
    }
    if (name === "baseline.json") a.hasBaseline = true;
    if (name === "dry-run-plan.md") a.hasDryRunPlan = true;
  }
  for (const key of ["agentLogs", "verifyLogs", "reportMd", "reportJson", "reportHtml", "dryRunMd", "dryRunJson"] as const) {
    a[key].sort((x, y) => x - y);
  }
  return a;
}

function toSummary(taskId: string, raw: string): TaskSummary | null {
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (k: string): string => (typeof meta[k] === "string" ? (meta[k] as string) : "");
  const num = (k: string): number | null =>
    typeof meta[k] === "number" && Number.isFinite(meta[k]) ? (meta[k] as number) : null;
  return {
    taskId,
    status: str("status"),
    workspaceMode: str("workspaceMode") || "project",
    projectPath: str("projectPath"),
    displayPath: str("displayPath"),
    agentId: str("agentId"),
    task: str("task"),
    roundsUsed: num("roundsUsed") ?? 0,
    reportRound: num("reportRound"),
    createdAt: str("createdAt"),
    updatedAt: str("updatedAt"),
    finishedAt: typeof meta.finishedAt === "string" ? meta.finishedAt : null,
    lastMessage: typeof meta.lastMessage === "string" ? meta.lastMessage : null,
    dryRun: meta.dryRun === true,
    errorType: typeof meta.errorType === "string" ? meta.errorType : null,
    checkSummary: typeof meta.checkSummary === "string" ? meta.checkSummary : null,
    diffstat: typeof meta.diffstat === "string" ? meta.diffstat : null,
    changedFiles: Array.isArray(meta.changedFiles)
      ? meta.changedFiles.filter((x): x is string => typeof x === "string")
      : [],
    dataHome: MOCK_HOME,
    artifacts: collectArtifacts(taskId),
  };
}

let activeHome = MOCK_HOME;
const extraHomes: string[] = [];

function homeState(): DataHomeState {
  return {
    detected: MOCK_HOME,
    active: activeHome,
    entries: [
      { path: MOCK_HOME, label: MOCK_HOME, valid: true, message: "" },
      ...extraHomes.map((p) => ({ path: p, label: p, valid: true, message: "" })),
    ],
  };
}

const PREF_KEY = "tianshu-mcp-logs.preferences";

function defaultPreferences(): Preferences {
  return {
    language: "zh-CN",
    theme: "system",
    updateSource: "auto",
    dataHomes: [],
    lastGoodUpdateSource: null,
  };
}

function loadPreferences(): Preferences {
  try {
    const raw = globalThis.localStorage?.getItem(PREF_KEY);
    if (!raw) return defaultPreferences();
    return { ...defaultPreferences(), ...(JSON.parse(raw) as Partial<Preferences>) };
  } catch {
    return defaultPreferences();
  }
}

function savePreferences(prefs: Preferences): void {
  try {
    globalThis.localStorage?.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch {
    // 预览模式无持久化能力时静默忽略（不影响 UI 调试）
  }
}

function relPathOfLog(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\.?\//, "");
}

function readWhole(relPath: string): string | null {
  const rel = relPathOfLog(relPath);
  return MOCK_FILES.get(rel) ?? null;
}

function logChunk(relPath: string, mode: "tail" | "before", loadedFrom: number | undefined, windowBytes: number | undefined): LogChunk {
  const rel = relPathOfLog(relPath);
  const text = MOCK_FILES.get(rel) ?? "";
  const win = windowBytes ?? DEFAULT_WINDOW_BYTES;
  if (mode === "tail") {
    const initial = planInitialWindow(byteLength(text), win);
    const slice = sliceRangeByBytes(text, initial.from, initial.to);
    return {
      text: slice.text,
      relPath: rel,
      absolutePath: `${MOCK_HOME}/${rel}`,
      fromByte: slice.fromByte,
      toByte: slice.toByte,
      loadedFrom: slice.fromByte,
      loadedTo: slice.toByte,
      totalBytes: slice.totalBytes,
    };
  }
  const from = Math.max(0, (loadedFrom ?? 0) - win);
  const to = loadedFrom ?? 0;
  const slice = sliceRangeByBytes(text, from, to);
  return {
    text: slice.text,
    relPath: rel,
    absolutePath: `${MOCK_HOME}/${rel}`,
    fromByte: slice.fromByte,
    toByte: slice.toByte,
    loadedFrom: slice.fromByte,
    loadedTo: loadedFrom ?? slice.toByte,
    totalBytes: slice.totalBytes,
  };
}

function scanFiles(pred: (rel: string) => boolean): string[] {
  return [...MOCK_FILES.keys()].filter(pred);
}

function searchOneFile(rel: string, req: SearchRequest): SearchFileGroup | null {
  const text = MOCK_FILES.get(rel) ?? "";
  const needle = req.caseSensitive ? req.keyword : req.keyword.toLowerCase();
  const hits: SearchHit[] = [];
  let truncated = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const hay = req.caseSensitive ? line : line.toLowerCase();
    const at = hay.indexOf(needle);
    if (at < 0) continue;
    if (hits.length >= req.maxHitsPerFile) {
      truncated = true;
      break;
    }
    const start = Math.max(0, at - 40);
    const end = Math.min(line.length, at + needle.length + 40);
    hits.push({
      relPath: rel,
      line: i + 1,
      text: line,
      snippet: `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`,
    });
  }
  if (hits.length === 0) return null;
  const m = /^tasks\/([^/]+)\//.exec(rel);
  return { taskId: m ? (m[1] ?? null) : null, relPath: rel, hits, truncated };
}

export const mockApi: GuiApi = {
  getAppVersion: async (): Promise<AppVersionInfo> => ({
    version: MOCK_APP_VERSION,
    updaterConfigured: false,
  }),

  getDataHomeState: async () => homeState(),

  addDataHome: async (path) => {
    const normalized = path.trim();
    if (normalized && normalized !== MOCK_HOME && !extraHomes.includes(normalized)) {
      extraHomes.push(normalized);
    }
    return homeState();
  },

  removeDataHome: async (path) => {
    const i = extraHomes.indexOf(path);
    if (i >= 0) extraHomes.splice(i, 1);
    if (activeHome === path) activeHome = MOCK_HOME;
    return homeState();
  },

  setActiveDataHome: async (path) => {
    activeHome = path || MOCK_HOME;
    return homeState();
  },

  pickDirectory: async () => null,
  pickSavePath: async () => null,

  listTasks: async (req) => {
    void req;
    const out: TaskSummary[] = [];
    for (const rel of scanFiles((r) => /^tasks\/[^/]+\/task\.json$/.test(r))) {
      const m = /^tasks\/([^/]+)\/task\.json$/.exec(rel);
      const taskId = m?.[1];
      if (!taskId) continue;
      const summary = toSummary(taskId, MOCK_FILES.get(rel) ?? "");
      if (summary) out.push(summary);
    }
    return out;
  },

  readEvents: async (req): Promise<ReadEventsResult> => {
    const rel = `tasks/${req.taskId}/task.jsonl`;
    const text = MOCK_FILES.get(rel) ?? "";
    const sliced = sliceTailByBytes(text, req.windowBytes ?? DEFAULT_WINDOW_BYTES);
    const parsed = parseEventStream(sliced.text);
    const events: TaskEvent[] = parsed.events;
    return {
      events: req.limit && req.limit > 0 ? events.slice(-req.limit) : events,
      totalBytes: sliced.totalBytes,
      loadedFrom: sliced.fromByte,
      loadedTo: sliced.toByte,
      badLines: parsed.badLines,
      loadedCount: events.length,
    };
  },

  readLog: async (req) => logChunk(req.relPath, req.mode, req.loadedFrom, req.windowBytes),

  readReport: async (req): Promise<ReadReportResult> => {
    const rel =
      req.kind === "dry-run-md"
        ? `tasks/${req.taskId}/dry-run-report-${req.round}.md`
        : req.kind === "dry-run-json"
          ? `tasks/${req.taskId}/dry-run-report-${req.round}.json`
          : `tasks/${req.taskId}/report-${req.round}.${req.kind}`;
    const text = MOCK_FILES.get(rel);
    return {
      relPath: rel,
      absolutePath: `${MOCK_HOME}/${rel}`,
      text: text ?? "",
      missing: text === undefined,
    };
  },

  exportFile: async (): Promise<ExportResult> => {
    throw new Error("本地预览模式不支持导出（请在桌面应用中操作）");
  },

  exportTaskZip: async (): Promise<ExportResult> => {
    throw new Error("本地预览模式不支持导出（请在桌面应用中操作）");
  },

  searchAll: async (req): Promise<SearchResult> => {
    if (!req.keyword.trim()) {
      return { groups: [], scannedFiles: 0, totalHits: 0, cancelled: false };
    }
    const groups: SearchFileGroup[] = [];
    let scannedFiles = 0;
    let totalHits = 0;
    for (const rel of MOCK_FILES.keys()) {
      const isEvent = /^tasks\/[^/]+\/task\.jsonl$/.test(rel);
      const isAgentLog = /^tasks\/[^/]+\/agent-\d+\.log$/.test(rel);
      const isVerifyLog = /^tasks\/[^/]+\/verify-\d+\.log$/.test(rel);
      const isReport = /^tasks\/[^/]+\/report-\d+\.(md|json)$/.test(rel);
      const isServerLog = rel === "logs/server.log";
      const inScope =
        (isEvent && req.scope.eventStream) ||
        (isAgentLog && req.scope.agentLogs) ||
        (isVerifyLog && req.scope.verifyLogs) ||
        (isReport && req.scope.reports) ||
        (isServerLog && req.scope.serverLog);
      if (!inScope) continue;
      scannedFiles += 1;
      const group = searchOneFile(rel, req);
      if (group) {
        groups.push(group);
        totalHits += group.hits.length;
      }
    }
    return { groups, scannedFiles, totalHits, cancelled: false };
  },

  searchCancel: async () => {},

  probeUpdateSources: async (): Promise<ProbeSourceResult> => ({
    gitee: { reachable: false, latencyMs: null },
    github: { reachable: false, latencyMs: null },
    picked: "github",
    cached: false,
    degraded: true,
  }),

  checkUpdate: async (): Promise<CheckUpdateResult> => ({
    available: false,
    currentVersion: MOCK_APP_VERSION,
    version: null,
    notes: null,
    source: null,
    manualDownloadUrl: "https://github.com/lanlan0811/tianshu-mcp/releases",
    error: null,
  }),

  installUpdate: async (): Promise<InstallUpdateResult> => {
    throw new Error("本地预览模式不支持安装更新");
  },

  getPreferences: async () => loadPreferences(),
  setPreferences: async (prefs) => savePreferences(prefs),

  watchStart: async () => {},
  watchStop: async () => {},
};

/** 导出给单测使用：确保 fixtures 被正确打包 */
export function fixtureFileCount(): number {
  return MOCK_FILES.size;
}

/** 导出给单测使用：事件分类口径需与后端一致 */
export const mockInternals = { classifyEvent, readWhole };