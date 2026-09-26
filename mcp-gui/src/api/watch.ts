/**
 * 文件变更监听（实时 tail）。
 *
 * - Tauri：Rust 侧 `watcher.rs` 通过 `notify` 监听，发 `gui/log-changed` 事件；
 * - mock：不模拟文件增长（**不假装**有实时数据），仅返回一个空清理函数。
 */
import { api, isMockRuntime } from "@/api";

export const LOG_CHANGED_EVENT = "gui/log-changed";

export interface LogChangePayload {
  relPath: string;
  totalBytes: number;
}

export type WatchCallback = (payload: LogChangePayload) => void;

/** 启动监听，返回停止函数 */
export async function startWatch(
  paths: string[],
  onChange: WatchCallback,
): Promise<() => void> {
  if (isMockRuntime || paths.length === 0) {
    return () => {};
  }
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<LogChangePayload>(LOG_CHANGED_EVENT, (event) => {
    onChange(event.payload);
  });
  await api.watchStart(paths);
  return () => {
    void unlisten();
    void api.watchStop();
  };
}