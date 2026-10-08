export interface ZcodeModelSpec {
  provider: string;
  model: string;
  /** 归一后的思考档位；未指定为 undefined（沿用界面当前值，不切换） */
  level?: ZcodeThoughtLevel;
  /** 请求了但取值域无法识别的原始值（用于发送前报错，绝不静默丢弃） */
  unsupportedLevel?: string;
}

export class ZcodeModelReadbackError extends Error {}

/** 思考档位校验失败（值域外或不在界面实际档位集合内）。 */
export class ZcodeReasoningLevelError extends Error {}

/**
 * 规范档位。集合的**唯一判据**是界面实际渲染出来的选项，因此这里不内置模型名单：
 * 真机实测（2026-09-30，ZCode 3.14.3-Windows，模型 step-plan/step-5-preview）是二值
 * `chat-thought-level-select-item-{disabled,enabled}`（关闭/开启）；官方多档模型若渲染
 * Low/High/Max 也能被同一套归一覆盖。
 */
export type ZcodeThoughtLevel = "off" | "on" | "low" | "medium" | "high" | "max";

export interface ZcodeThoughtTierSet {
  tiers: ZcodeThoughtLevel[];
  /** onoff=界面只有开关两档；multi=多档；unknown=读不到标签（fail-closed） */
  kind: "onoff" | "multi" | "unknown";
}

/** 界面 token（testid 后缀或可见文本）→ 规范档位。中英双语都接受。 */
const THOUGHT_LEVEL_ALIASES: Record<string, ZcodeThoughtLevel> = {
  关闭: "off",
  关闭思考: "off",
  off: "off",
  disabled: "off",
  开启: "on",
  on: "on",
  enabled: "on",
  低: "low",
  low: "low",
  中: "medium",
  medium: "medium",
  高: "high",
  high: "high",
  max: "max",
  最大: "max",
  极高: "max",
  xhigh: "max",
};

/** 档位在错误文案里的界面写法 */
const THOUGHT_LEVEL_UI: Record<ZcodeThoughtLevel, string> = {
  off: "Off",
  on: "On",
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
};

/** 规范顺序（读到的集合按此排序，便于比较与展示） */
const THOUGHT_LEVEL_ORDER: ZcodeThoughtLevel[] = ["off", "on", "low", "medium", "high", "max"];

function thoughtKey(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** 界面 token → 档位；无法识别返回 undefined（绝不猜） */
export function thoughtLevelOfToken(token: string): ZcodeThoughtLevel | undefined {
  const key = thoughtKey(token ?? "");
  return key ? THOUGHT_LEVEL_ALIASES[key] : undefined;
}

/**
 * 请求值归一。取值域外的值**不归一**，原值放进 unsupportedLevel 供发送前报错——
 * 静默丢弃会让「请求高档却被沿用当前档」这种偏差无人察觉。
 */
export function normalizeZcodeReasoningLevel(value: string | undefined): {
  level?: ZcodeThoughtLevel;
  unsupported?: string;
} {
  const raw = value?.normalize("NFKC").trim() ?? "";
  if (!raw) return {};
  const level = thoughtLevelOfToken(raw);
  return level ? { level } : { unsupported: raw };
}

/** 由界面实际档位标签集合归类 */
export function thoughtTierSetOf(labels: string[]): ZcodeThoughtTierSet {
  const levels = new Set<ZcodeThoughtLevel>();
  for (const label of labels) {
    const level = thoughtLevelOfToken(label);
    if (level) levels.add(level);
  }
  const tiers = THOUGHT_LEVEL_ORDER.filter((level) => levels.has(level));
  if (levels.has("on") && levels.has("off")) return { tiers, kind: "onoff" };
  return tiers.length ? { tiers, kind: "multi" } : { tiers, kind: "unknown" };
}

export function thoughtTierLabels(tiers: ZcodeThoughtTierSet): string {
  return tiers.tiers.map((level) => THOUGHT_LEVEL_UI[level]).join("/") || "（空）";
}

export function thoughtLevelUiName(level: ZcodeThoughtLevel): string {
  return THOUGHT_LEVEL_UI[level];
}

/**
 * 校验请求档位是否落在**界面实际档位集合**内。
 * 读不到档位标签（unknown）一律 fail-closed：宁可报错也不按内置名单猜，
 * 否则模型/UI 升级后会把不支持的值"成功"发出去。
 */
export function assertZcodeLevelSupported(
  spec: ZcodeModelSpec,
  tiers: ZcodeThoughtTierSet,
): void {
  if (tiers.kind === "unknown")
    throw new ZcodeReasoningLevelError(
      `无法从界面读到模型 ${spec.model} 的思考档位（读到 ${thoughtTierLabels(tiers)}），拒绝猜测档位；请检查 ZCode 版本与选择器`,
    );
  const labels = thoughtTierLabels(tiers);
  if (spec.unsupportedLevel !== undefined)
    throw new ZcodeReasoningLevelError(
      `模型 ${spec.model} 的思考档位仅支持 ${labels}，收到「${spec.unsupportedLevel}」`,
    );
  if (spec.level && !tiers.tiers.includes(spec.level))
    throw new ZcodeReasoningLevelError(
      `模型 ${spec.model} 的思考档位仅支持 ${labels}，收到「${spec.level}」`,
    );
}

/** 参数级（handlers）可取值的取值域错误文案；无错时返回 undefined。 */
export function describeZcodeLevelValueError(spec: ZcodeModelSpec): string | undefined {
  if (spec.unsupportedLevel === undefined) return undefined;
  return `ZCode 的思考档位不支持「${spec.unsupportedLevel}」：仅支持 低/low、中/medium、高/high、max、on/off，且必须落在所选模型界面实际渲染的档位集合内`;
}

export interface ZcodeModelSelectionRaw {
  display: string;
  ariaLabel?: string;
  currentValue?: string;
  legacyInternal?: string;
  visibleLabel?: string;
  title?: string;
  ambiguous?: boolean;
}

export function parseZcodeModel(value: string | undefined, level?: string): ZcodeModelSpec {
  if (!value) throw new Error("ZCode 必须指定 model，格式为 供应商/模型");
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0]!.trim() || !parts[1]!.trim())
    throw new Error(`ZCode model 格式错误：${value}（应为 供应商/模型）`);
  const normalized = normalizeZcodeReasoningLevel(level);
  return {
    provider: parts[0]!.trim(),
    model: parts[1]!.trim(),
    level: normalized.level,
    unsupportedLevel: normalized.unsupported,
  };
}

export function exactUiName(a: string, b: string): boolean {
  return (
    a.normalize("NFKC").trim().toLocaleLowerCase() ===
    b.normalize("NFKC").trim().toLocaleLowerCase()
  );
}

export function normalizeZcodeModelSelection(raw: ZcodeModelSelectionRaw): {
  display: string;
  internal: string;
} {
  let display = raw.display.trim();
  const ariaLabel = raw.ariaLabel?.trim();
  if (ariaLabel) {
    while (display.startsWith(ariaLabel)) display = display.slice(ariaLabel.length).trim();
    while (display.endsWith(ariaLabel)) display = display.slice(0, -ariaLabel.length).trim();
  }
  const currentValue = raw.currentValue?.trim() ?? "";
  let currentModel = "";
  try {
    currentModel = currentValue
      ? (decodeURIComponent(currentValue).split(":").at(-1)?.trim() ?? "")
      : "";
  } catch {
    throw new ZcodeModelReadbackError("ZCode 当前模型属性编码无效");
  }
  const visibleLabel = raw.visibleLabel?.trim() || raw.title?.trim() || "";
  const modelName = (value: string) =>
    value.includes("/") ? value.slice(value.indexOf("/") + 1) : value;
  /**
   * `currentValue` 的格式是 `<kind>:<provider>:<urlencoded-model>`。
   * `split(":").at(-1)` 假设**模型名不含冒号**，但真机存在反例：
   * OpenRouter 的免费模型后缀就是 `:free`（2026-10-08，ZCode 3.14.4.7912）——
   *   custom:openrouter:inclusionai%2Fling-3.0-flash-sante%3Afree
   *   解码 = custom:openrouter:inclusionai/ling-3.0-flash-sante:free
   *   split(":").at(-1) = "free"（截断），而可见标签给出完整名 → 误报「属性与可见标签冲突」。
   *
   * 解析改为**按 `<kind>:<provider>:` 前缀剥离**（只切前两段，第三段整段保留），
   * 这与属性格式一一对应，不依赖模型名/路径里是否出现冒号或斜杠。
   * 若剥离结果与可见标签不一致，则回退旧的末段解析结果参与后续校验——
   * 真正的冲突（两个不同模型）仍会被 exactUiName 拦下，不放宽。
   */
  const decodedCurrent = currentValue ? decodeURIComponent(currentValue) : "";
  const stripped = /^[^:]*:[^:]*:(.+)$/.exec(decodedCurrent)?.[1]?.trim() ?? "";
  const visibleModel = visibleLabel ? modelName(visibleLabel) : "";
  const currentModelFromValue =
    stripped && visibleModel && exactUiName(stripped, visibleModel) ? stripped : currentModel;
  if (
    raw.ambiguous ||
    (raw.visibleLabel &&
      raw.title &&
      !exactUiName(modelName(raw.visibleLabel), modelName(raw.title)))
  )
    throw new ZcodeModelReadbackError("ZCode 当前模型可见标签存在歧义");
  if (
    currentModelFromValue &&
    visibleLabel &&
    !exactUiName(currentModelFromValue, modelName(visibleLabel))
  )
    throw new ZcodeModelReadbackError("ZCode 当前模型属性与可见标签冲突");
  if (currentModelFromValue) display = visibleLabel || currentModelFromValue;
  else if (visibleLabel) display = visibleLabel;
  else if (ariaLabel && display.includes(ariaLabel))
    throw new ZcodeModelReadbackError("ZCode 模型文本包含混合标签，无法确认当前模型");
  const legacyInternal = raw.legacyInternal?.trim() ?? "";
  return {
    display,
    internal:
      currentModelFromValue ||
      legacyInternal ||
      (display.includes("/") ? display.slice(display.indexOf("/") + 1).trim() : display),
  };
}
