import fs from "node:fs/promises";
import path from "node:path";
import {
  AcceptanceConfigSchema,
  PartialAcceptanceConfigSchema,
  type AcceptanceConfig,
  type PartialAcceptanceConfig,
} from "../config/schema.js";
import { VisualError } from "./errors.js";

/** Only ENOENT means absent. Invalid or unreadable configuration never falls back. */
export async function readAcceptanceConfig(projectPath: string): Promise<AcceptanceConfig | null> {
  let text: string;
  try {
    text = await fs.readFile(path.join(projectPath, ".tianshu-mcp", "acceptance.json"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new VisualError("CONFIG_UNREADABLE", `Cannot read acceptance.json: ${String(e)}`);
  }
  try {
    return AcceptanceConfigSchema.parse(JSON.parse(text));
  } catch (e) {
    throw new VisualError("CONFIG_INVALID", `Invalid acceptance.json: ${String(e)}`);
  }
}

/**
 * 读取**单层**验收配置（issue #20）。与 `readAcceptanceConfig` 的区别是：
 * 1. 接受任意绝对路径（全局层是 `<数据目录>/acceptance.default.json`，不在项目内）；
 * 2. 用**无默认值**的 `PartialAcceptanceConfigSchema` 解析 —— 带默认值的 schema 会把
 *    `requireChanges: true` 之类凭空 materialize 出来，进而覆盖低优先级层的显式取值。
 *
 * 错误语义与项目级保持一致（fail-closed）：仅 `ENOENT` 视为「该层不存在」，
 * 读不了 → `CONFIG_UNREADABLE`，写坏/字段不合法 → `CONFIG_INVALID`。
 */
export async function readAcceptanceLayer(
  absPath: string,
  label: string,
): Promise<PartialAcceptanceConfig | null> {
  let text: string;
  try {
    text = await fs.readFile(absPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new VisualError("CONFIG_UNREADABLE", `无法读取验收配置层 ${label}（${absPath}）：${String(e)}`);
  }
  try {
    return PartialAcceptanceConfigSchema.parse(JSON.parse(text));
  } catch (e) {
    throw new VisualError("CONFIG_INVALID", `验收配置层 ${label} 不合法（${absPath}）：${String(e)}`);
  }
}
