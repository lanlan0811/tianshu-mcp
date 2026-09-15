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
export interface VisualResult {
  id: string;
  kind: "page" | "image";
  target: string;
  viewport?: string;
  status: "passed" | "failed" | "blocked" | "skipped";
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
}
export interface VisualReport {
  results: VisualResult[];
  artifactDirectory: string;
  artifactBytes: number;
  cleanedAt?: string;
}
