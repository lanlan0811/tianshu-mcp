/**
 * 主题：深色 / 浅色 / 跟随系统（默认跟随系统）。
 *
 * 只操作 `<html data-theme>`，具体色值由 `src/styles.css` 的 CSS 变量提供——
 * 组件里不出现硬编码颜色。
 */
import type { ThemeMode } from "@/api/types-lite";

const MEDIA = "(prefers-color-scheme: dark)";

export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(MEDIA).matches;
}

export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "light" || mode === "dark") return mode;
  return systemPrefersDark() ? "dark" : "light";
}

export function applyTheme(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(mode);
  document.documentElement.dataset["theme"] = resolved;
  document.documentElement.dataset["themeMode"] = mode;
}

/** 系统主题变化订阅（返回取消订阅函数）；仅在“跟随系统”时由调用方决定是否响应 */
export function onSystemThemeChange(cb: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(MEDIA);
  const handler = () => cb();
  mql.addEventListener("change", handler);
  return () => mql.removeEventListener("change", handler);
}