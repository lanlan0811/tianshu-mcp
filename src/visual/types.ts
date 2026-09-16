export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
  area?: number;
}
/** 单次采样判定：passed 缺省表示该次采样未能给出有效判定（防御性，正常契约必填） */
export interface ContentVote {
  index: number;
  passed?: boolean;
  confidence?: number;
  reason: string;
}
/** 置信度闸门状态（报告可见 minConfidence 是否生效） */
export type ContentConfidenceGate = "off" | "applied" | "downgraded" | "no-confidence";
export interface VisualContentDetail {
  /** 有效 command 字符串，用于报告溯源 */
  provider: string;
  /** 期望描述原文（报告为本地文件，明文便于人工复核） */
  expect: string;
  /** 判定缓存键（sha256） */
  cacheKey: string;
  /** 本次是否命中缓存 */
  cached: boolean;
  votes: ContentVote[];
  /** 有效采样置信度均值 */
  confidence?: number;
  confidenceGate?: ContentConfidenceGate;
}
export interface VisualResult {
  id: string;
  kind: "page" | "image" | "content";
  target: string;
  viewport?: string;
  /** uncertain：AI 判定不确定——既不致败（visualFailed 只取 failed）也不阻塞（visualBlocked 只取 blocked） */
  status: "passed" | "failed" | "blocked" | "skipped" | "uncertain";
  optional: boolean;
  code: string;
  message: string;
  durationMs: number;
  repairable: boolean;
  metrics?: Record<string, unknown>;
  rules?: unknown;
  environment?: Record<string, unknown>;
  regions?: Rectangle[];
  masks?: Rectangle[];
  artifacts?: Record<string, string>;
  /** 仅内容项（kind === "content"）存在 */
  content?: VisualContentDetail;
}
export interface VisualReport {
  results: VisualResult[];
  artifactDirectory: string;
  artifactBytes: number;
  cleanedAt?: string;
}
