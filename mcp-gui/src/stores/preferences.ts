/**
 * 用户偏好（语言 / 主题 / 更新源三态 / 数据目录历史 / 上次可用更新源）。
 *
 * 持久化由后端负责（应用配置目录，**不落项目目录**）；mock 下写 localStorage。
 */
import { reactive } from "vue";
import { api } from "@/api";
import type { Preferences } from "@/api/types";
import { setLanguage } from "@/i18n";
import { applyTheme, onSystemThemeChange } from "@/theme";

function defaults(): Preferences {
  return {
    language: "zh-CN",
    theme: "system",
    updateSource: "auto",
    dataHomes: [],
    lastGoodUpdateSource: null,
  };
}

export const preferences = reactive<Preferences>(defaults());

function applyLocalSideEffects(): void {
  setLanguage(preferences.language);
  applyTheme(preferences.theme);
}

export async function loadPreferences(): Promise<void> {
  try {
    const loaded = await api.getPreferences();
    Object.assign(preferences, defaults(), loaded);
  } catch {
    Object.assign(preferences, defaults());
  }
  applyLocalSideEffects();
}

export async function savePreferences(): Promise<void> {
  try {
    await api.setPreferences({ ...preferences });
  } catch {
    // 持久化失败不影响本次会话使用（偏好仍在内存中生效）
  }
}

export async function updatePreferences(patch: Partial<Preferences>): Promise<void> {
  Object.assign(preferences, patch);
  applyLocalSideEffects();
  await savePreferences();
}

/** 系统主题变化时，仅在“跟随系统”模式下重新应用 */
export function initThemeWatcher(): void {
  onSystemThemeChange(() => {
    if (preferences.theme === "system") applyTheme("system");
  });
}