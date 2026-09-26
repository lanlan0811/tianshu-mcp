/**
 * 前端唯一数据出口：按运行环境选择 Tauri 实现或 mock 实现。
 *
 * 组件**只能**从这里取数（不允许直接 import tauri 或 mock）。
 */
import type { RuntimeMode } from "./types";
import type { GuiApi } from "./gui-api";
import { tauriApi } from "./tauri";
import { mockApi } from "./mock";

function detectRuntimeMode(): RuntimeMode {
  const forced = import.meta.env?.VITE_GUI_MOCK;
  if (forced === "1" || forced === "true") return "mock";
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) return "tauri";
  return "mock";
}

export const runtimeMode: RuntimeMode = detectRuntimeMode();
export const isMockRuntime = runtimeMode === "mock";

export const api: GuiApi = runtimeMode === "tauri" ? tauriApi : mockApi;

export type { GuiApi };
export * from "./types";