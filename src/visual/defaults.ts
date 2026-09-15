/** Version-independent defaults, shared by configuration, CLI and execution. */
export const VISUAL_DEFAULTS = {
  capture: "viewport" as const,
  pixelThreshold: 0.1,
  maxDiffRatio: 0.001,
  locale: "en-US",
  timezone: "UTC",
  colorScheme: "light" as const,
  baselineRoot: "tests/visual/baselines",
  viewports: [
    { id: "desktop", width: 1280, height: 720, deviceScaleFactor: 1 },
    { id: "mobile", width: 390, height: 844, deviceScaleFactor: 1 },
  ],
  limits: {
    concurrency: 1,
    serviceTimeoutMs: 60_000,
    navigationTimeoutMs: 30_000,
    itemTimeoutMs: 60_000,
    roundTimeoutMs: 300_000,
    stabilitySamples: 3,
    inputBytes: 20 * 1024 * 1024,
    decodedPixels: 32_000_000,
    artifactBytes: 500 * 1024 * 1024,
  },
  /** AI 内容校验默认值：默认关闭；timeoutMs 与 samples 的乘积必须 ≤ limits.roundTimeoutMs（schema 校验） */
  content: {
    enabled: false,
    allowRemote: false,
    samples: 3,
    timeoutMs: 90_000,
    cache: true,
  },
};
