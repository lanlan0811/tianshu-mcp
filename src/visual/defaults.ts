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
};
