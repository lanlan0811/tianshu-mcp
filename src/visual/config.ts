import fs from "node:fs/promises";
import path from "node:path";
import { AcceptanceConfigSchema, type AcceptanceConfig } from "../config/schema.js";
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
