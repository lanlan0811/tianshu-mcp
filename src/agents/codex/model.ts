/**
 * Codex 模型与思考等级（开发计划决策 4：model + reasoningLevel 双字段）。
 * 思考等级接受中英双语，内部归一为 low/medium/high，UI 选择时映射回界面文案。
 */
import type { ReasoningLevel } from "../../config/schema.js";

export type NormalizedLevel = "low" | "medium" | "high";

export interface CodexModelSpec {
  model: string;
  /** 归一后的思考等级；未指定为 undefined（沿用面板当前值） */
  level?: NormalizedLevel;
}

const LEVEL_MAP: Record<string, NormalizedLevel> = {
  低: "low",
  中: "medium",
  高: "high",
  low: "low",
  medium: "medium",
  high: "high",
};

/** 界面展示文案（中英双语候选），用于点击与回读校验 */
const LEVEL_UI: Record<NormalizedLevel, string[]> = {
  low: ["低", "Low"],
  medium: ["中", "Medium"],
  high: ["高", "High"],
};

export function normalizeLevel(value: string | undefined): NormalizedLevel | undefined {
  if (!value) return undefined;
  const key = value.normalize("NFKC").trim().toLocaleLowerCase();
  return LEVEL_MAP[key] ?? LEVEL_MAP[value.normalize("NFKC").trim()] ?? undefined;
}

export function levelUiTexts(level: NormalizedLevel): string[] {
  return [...LEVEL_UI[level]];
}

/** 校验并归一模型参数（model 必填；level 可选） */
export function parseCodexModel(model: string | undefined, level?: ReasoningLevel | string): CodexModelSpec {
  const trimmed = (model ?? "").trim();
  if (!trimmed) throw new Error("Codex 必须指定 model（如「GPT-5.6 Sol」）");
  return { model: trimmed, level: normalizeLevel(typeof level === "string" ? level : undefined) };
}

/** UI 文本归一比较（NFKC + 去多余空白 + 大小写不敏感） */
export function exactUiName(a: string, b: string): boolean {
  return (
    a.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase() ===
    b.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase()
  );
}

/**
 * 从触发器文本中解析「模型 + 等级」。
 * 形如「GPT-5.6 Sol 高」「GPT-5.6 Sol\n高」「GPT-5.6 Sol High」。
 */
export function parseTriggerValue(text: string): { model: string; level?: NormalizedLevel } {
  const flat = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  const m = /^(.*?)\s+(低|中|高|Low|Medium|High)$/i.exec(flat);
  if (!m) return { model: flat };
  return { model: (m[1] ?? "").trim(), level: normalizeLevel(m[2] ?? "") };
}
