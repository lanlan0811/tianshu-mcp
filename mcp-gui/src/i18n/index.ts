/**
 * i18n 运行时：点路径取值 + `{name}` 插值 + 键集合比对工具（供测试使用）。
 */
import { ref, computed } from "vue";
import type { Language } from "@/api/types-lite";
import { zhCN, type Messages } from "./zh-CN";
import { enUS } from "./en-US";

export type { Messages };

const BUNDLES: Record<Language, Messages> = { "zh-CN": zhCN, "en-US": enUS };

export const DEFAULT_LANGUAGE: Language = "zh-CN";

export function messagesOf(lang: Language): Messages {
  return BUNDLES[lang] ?? BUNDLES[DEFAULT_LANGUAGE];
}

/** 点路径取值；路径不存在时返回路径本身（**不返回空串**，避免静默丢失文案） */
export function lookup(messages: Messages, path: string): string {
  let cursor: unknown = messages;
  for (const seg of path.split(".")) {
    if (!cursor || typeof cursor !== "object") return path;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return typeof cursor === "string" ? cursor : path;
}

/** `{name}` 占位替换；未提供的占位符原样保留（便于发现漏传） */
export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : whole,
  );
}

/** 展平为 `a.b.c` → 值 的映射（i18n 完整性测试用） */
export function flattenKeys(messages: Messages): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (node: unknown, prefix: string) => {
    if (typeof node === "string") {
      out[prefix] = node;
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, prefix ? `${prefix}.${k}` : k);
      }
    }
  };
  walk(messages, "");
  return out;
}

/** 当前语言（全局单例；由 preferences store 负责持久化） */
export const currentLanguage = ref<Language>(DEFAULT_LANGUAGE);

export function setLanguage(lang: Language): void {
  currentLanguage.value = lang;
}

export function useI18n() {
  const messages = computed(() => messagesOf(currentLanguage.value));
  const t = (path: string, params?: Record<string, string | number>): string =>
    interpolate(lookup(messages.value, path), params);
  return { language: currentLanguage, messages, t };
}