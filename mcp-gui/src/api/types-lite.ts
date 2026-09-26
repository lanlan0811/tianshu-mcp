/**
 * 轻量共享类型（避免 `api/types.ts` 与 `i18n` 之间的循环依赖）。
 */
export type Language = "zh-CN" | "en-US";
export type ThemeMode = "system" | "light" | "dark";
export type UpdateSource = "auto" | "gitee" | "github";