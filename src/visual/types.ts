export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
  area?: number;
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
