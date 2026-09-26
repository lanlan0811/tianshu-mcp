/**
 * 大文件的「尾部窗口 + 按需向前加载」分块计算（纯函数，便于单测）。
 *
 * 与后端 `src-tauri/src/tail.rs` 使用同一组默认值；后端负责实际字节读取，
 * 本模块只决定「读哪一段」，从而保证 UI 与后端对 loaded/total 的口径一致。
 */

/** 首屏尾部窗口字节数（与 `TaskStore.readRecentAgentEvents` 的 64 KiB 思路一致） */
export const DEFAULT_WINDOW_BYTES = 64 * 1024;

/** 「加载更多」每次向前追加的字节数 */
export const DEFAULT_CHUNK_BYTES = 64 * 1024;

export interface WindowRange {
  from: number;
  to: number;
}

/** 首屏窗口：文件不足一个窗口时从头读（不会出现负数偏移） */
export function planInitialWindow(
  totalBytes: number,
  windowBytes: number = DEFAULT_WINDOW_BYTES,
): WindowRange {
  const total = Math.max(0, totalBytes);
  const win = Math.max(1, windowBytes);
  const from = Math.max(0, total - win);
  return { from, to: total };
}

/**
 * 向前加载一块。已到文件头时返回 null（UI 据此禁用「加载更多」）。
 * 返回区间为 [newFrom, currentFrom)。
 */
export function planLoadMore(
  currentFrom: number,
  chunkBytes: number = DEFAULT_CHUNK_BYTES,
): WindowRange | null {
  if (currentFrom <= 0) return null;
  const chunk = Math.max(1, chunkBytes);
  const from = Math.max(0, currentFrom - chunk);
  return { from, to: currentFrom };
}

export function hasMoreBefore(loadedFrom: number): boolean {
  return loadedFrom > 0;
}

/** 已加载占比（0..1）；total 为 0 时视为 1（空文件即已看全） */
export function loadedRatio(loadedFrom: number, loadedTo: number, totalBytes: number): number {
  if (totalBytes <= 0) return 1;
  const loaded = Math.max(0, loadedTo - loadedFrom);
  return Math.min(1, loaded / totalBytes);
}

/** UI 提示文案用的计数（字节与行的两种口径都在 UI 层给出，这里只做算术） */
export function loadedBytes(loadedFrom: number, loadedTo: number): number {
  return Math.max(0, loadedTo - loadedFrom);
}

/**
 * 判断是否需要「跳到最新」：跟进开关关闭（用户此前手动上翻）而文件已增长时，
 * UI 不应强行把视口拉回底部——由本函数给出「有待查看的新内容」信号。
 */
export function hasPendingNewContent(
  loadedTo: number,
  totalBytes: number,
  following: boolean,
): boolean {
  return !following && totalBytes > loadedTo;
}