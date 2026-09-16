import fs from "node:fs/promises";
import path from "node:path";
import { readAcceptanceConfig } from "./config.js";
import { digest } from "./lock.js";
import { projectFile } from "./paths.js";
import type { VisualConfig, VisualPage } from "./schema.js";
import { VisualError } from "./errors.js";
import { writeJsonAtomic } from "../util/fs.js";

export interface VisualSnapshot {
  configDigest: string;
  config?: VisualConfig | null;
  baselines: Record<string, string | null>;
  createdAt: string;
  approved?: { note: string; at: string; previousDigest: string };
}
export function baselineRelative(config: VisualConfig, page: VisualPage, viewport: string): string {
  return (
    page.baseline ??
    path.join(
      config.baselineRoot,
      process.platform,
      config.browser.mode,
      page.id,
      `${viewport}.png`,
    )
  );
}
export async function fileDigest(filename: string): Promise<string | null> {
  try {
    return digest(await fs.readFile(filename));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
export async function captureVisualSnapshot(project: string): Promise<VisualSnapshot> {
  const config = (await readAcceptanceConfig(project))?.visual;
  const baselines: Record<string, string | null> = {};
  if (config?.enabled)
    for (const page of config.pages)
      for (const viewport of page.viewports ?? config.viewports.map((v) => v.id)) {
        const relative = baselineRelative(config, page, viewport);
        // 语义-only 页面（pixel:false，D9）无像素维度：显式记 null，不去读可能残留的无关基准文件
        // （否则删掉/改动一个与该页无关的基准会让冻结摘要漂移，误报 VISUAL_INTEGRITY）
        baselines[relative] = page.pixel
          ? await fileDigest(await projectFile(project, relative))
          : null;
        baselines[`${relative}.manifest.json`] = page.pixel
          ? await fileDigest(await projectFile(project, `${relative}.manifest.json`))
          : null;
      }
  return {
    config: config ?? null,
    configDigest: digest(JSON.stringify(config ?? null)),
    baselines,
    createdAt: new Date().toISOString(),
  };
}
export async function checkVisualSnapshot(project: string, frozen: VisualSnapshot): Promise<void> {
  const current = await captureVisualSnapshot(project);
  if (
    current.configDigest !== frozen.configDigest ||
    JSON.stringify(current.baselines) !== JSON.stringify(frozen.baselines)
  )
    throw new VisualError(
      "VISUAL_INTEGRITY",
      "Visual rules or approved baselines changed. Use visual rules review/approve; agents must not weaken acceptance rules.",
    );
}
export async function freezeVisualSnapshot(
  project: string,
  taskDirectory: string,
): Promise<VisualSnapshot> {
  const filename = path.join(taskDirectory, "visual-snapshot.json");
  try {
    return JSON.parse(await fs.readFile(filename, "utf8")) as VisualSnapshot;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      throw new VisualError("SNAPSHOT_INVALID", "Cannot read frozen visual snapshot");
  }
  const snapshot = await captureVisualSnapshot(project);
  await writeJsonAtomic(filename, snapshot);
  return snapshot;
}
