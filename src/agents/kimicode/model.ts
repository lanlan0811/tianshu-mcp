/**
 * Kimi Code 模型与思考档位（开发计划决策 6/7）。
 *
 * 与 ZCode/Codex 的实质差别：Kimi Code 的思考档位**不是固定档位数**——
 * 真机实测（2026-09-20，Kimi Code 1.0.2）：
 * - 官方模型（Kimi 订阅，如 `K3` / `K2.8 Preview` / `K3-256k`）档位是 `Low / High / Max`；
 * - 非官方模型（如 kiro 的 `stepfun/step-3.7-flash:free`）档位只有 `On / Off`，默认 `On`，
 *   且触发器的档位后缀变成「思考」而不是档位名。
 *
 * 因此这里**刻意不内置模型名单**：档位集合的唯一判据是「界面实际渲染出来的档位标签」，
 * 由 tierSetOf 归类后校验请求值；越权档位在发送前响亮报错，绝不静默沿用。
 *
 * 全部比较一律 NFKC 归一 + 折叠空白 + 大小写不敏感；`K3` 与 `K3-256k` 必须精确区分
 * （前缀命中会把 K3-256k 误判成已选中 K3，从而跳过切换）。
 */

export type KimicodeLevel = "low" | "high" | "max" | "on" | "off";

export interface KimicodeModelSpec {
  model: string;
  level?: KimicodeLevel;
  /** 请求了但界面档位集合不支持的原始值（用于报错） */
  unsupported?: string;
}

/** 界面档位集合的两种实测形态 + 读不到时的 unknown（fail-closed） */
export interface KimicodeTierSet {
  tiers: KimicodeLevel[];
  kind: "official" | "onoff" | "unknown";
}

/** 触发器文本里的档位分隔符（实测为中点 + 两侧空格，如 `K3 · High`） */
const TRIGGER_SEPARATOR = "·";

/** 档位别名：中英双语都接受。刻意不含 `中`/`medium`——它不是任何模型的合法档位 */
const LEVEL_ALIASES: Record<string, KimicodeLevel> = {
  低: "low",
  low: "low",
  高: "high",
  high: "high",
  max: "max",
  on: "on",
  off: "off",
};

/** 界面上的档位标签（用于错误文案与 tierSetOf 的归类） */
const TIER_UI_NAME: Record<KimicodeLevel, string> = {
  low: "Low",
  high: "High",
  max: "Max",
  on: "On",
  off: "Off",
};

/** 档位的规范顺序（读到的标签集合按此排序，便于比较与展示） */
const CANONICAL_TIER_ORDER: KimicodeLevel[] = ["low", "high", "max", "on", "off"];

/**
 * 报错时的「收到」写法：中英对照。
 * 真机反馈里同一档位可能被写成中文或英文，报错必须能让用户对上自己传的那个值。
 */
const LEVEL_RECEIPT: Record<string, string> = {
  低: "「低」（low）",
  low: "「低」（low）",
  中: "「中」（medium）",
  medium: "「中」（medium）",
  高: "「高」（high）",
  high: "「高」（high）",
  max: "「max」",
  on: "「on」",
  off: "「off」",
};

export function normalizeKey(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** UI 文本归一比较（NFKC + 折叠空白 + 大小写不敏感） */
export function exactUiName(a: string, b: string): boolean {
  return normalizeKey(a) === normalizeKey(b);
}

/** 界面 token → 档位；无法识别（含 `思考` 这类非档位后缀）返回 undefined */
export function levelOfToken(token: string): KimicodeLevel | undefined {
  return LEVEL_ALIASES[normalizeKey(token)];
}

/**
 * 请求值归一：`低/low → low`、`高/high → high`、`max`、`on`、`off`。
 * `中/medium` 与其他任何值都**不归一**，原值放在 unsupported 里供调用方报错——
 * 静默丢弃会让「官方模型收到中档」变成「沿用界面当前档」，与用户意图不符。
 */
export function normalizeReasoningLevel(value: string | undefined): {
  level?: KimicodeLevel;
  unsupported?: string;
} {
  const raw = value?.normalize("NFKC").trim() ?? "";
  if (!raw) return {};
  const level = LEVEL_ALIASES[normalizeKey(raw)];
  return level ? { level } : { unsupported: raw };
}

/**
 * 解析触发器文本（`button.model-pill` 的全文）。
 *
 * 实测：`K3 · High` → 模型 K3、档位 High；`stepfun/step-3.7-flash:free · 思考` →
 * 模型 `stepfun/step-3.7-flash:free`、**无档位 token**（「思考」只是非官方模型的标记）；
 * 无分隔符时整串即模型名（模型名本身含空格，如 `K2.8 Preview`，所以不能按空格切）。
 */
export function parseTriggerValue(text: string): { model: string; levelToken?: string } {
  const flat = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!flat) return { model: "" };
  const at = flat.indexOf(TRIGGER_SEPARATOR);
  if (at < 0) return { model: flat };
  const model = flat.slice(0, at).trim();
  const suffix = flat.slice(at + TRIGGER_SEPARATOR.length).trim();
  if (!suffix) return { model };
  return levelOfToken(suffix) ? { model, levelToken: suffix } : { model };
}

/** 由界面实际档位标签集合判定形态：含 max 且含 low/high → official；含 on 且含 off → onoff */
export function tierSetOf(labels: string[]): KimicodeTierSet {
  const levels = new Set<KimicodeLevel>();
  for (const label of labels) {
    const level = levelOfToken(label);
    if (level) levels.add(level);
  }
  const tiers = CANONICAL_TIER_ORDER.filter((level) => levels.has(level));
  if (levels.has("max") && (levels.has("low") || levels.has("high")))
    return { tiers, kind: "official" };
  if (levels.has("on") && levels.has("off")) return { tiers, kind: "onoff" };
  return { tiers, kind: "unknown" };
}

/** 档位集合的界面写法（官方 → `Low/High/Max`；非官方 → `On/Off`） */
export function tierLabels(tiers: KimicodeTierSet): string {
  return tiers.tiers.map((level) => TIER_UI_NAME[level]).join("/") || "（空）";
}

function receiptOf(value: string): string {
  return LEVEL_RECEIPT[normalizeKey(value)] ?? `「${value}」`;
}

/**
 * 校验请求档位是否落在**界面实际档位集合**内。
 * 读不到档位标签（unknown）一律 fail-closed：宁可报错也不要按内置名单猜，
 * 否则模型切换/UI 升级后会把不支持的值"成功"发出去。
 */
export function assertLevelSupported(spec: KimicodeModelSpec, tiers: KimicodeTierSet): void {
  if (tiers.kind === "unknown")
    throw new Error(
      `无法从界面读到模型 ${spec.model} 的思考档位标签（读到 ${tierLabels(tiers)}），拒绝猜测档位；请检查 Kimi Code 版本与选择器`,
    );
  const labels = tierLabels(tiers);
  if (spec.unsupported !== undefined)
    throw new Error(
      `模型 ${spec.model} 的思考等级仅支持 ${labels}，收到${receiptOf(spec.unsupported)}`,
    );
  if (spec.level && !tiers.tiers.includes(spec.level))
    throw new Error(`模型 ${spec.model} 的思考等级仅支持 ${labels}，收到${receiptOf(spec.level)}`);
}

/**
 * 省略 reasoningLevel 时的默认策略：官方档位沿用界面当前值（返回 undefined 表示不切换）；
 * 非官方模型强制 `on`（界面默认也是 on，已是 on 时不切换）。
 */
export function defaultLevelFor(
  kind: "official" | "onoff",
  current?: KimicodeLevel,
): KimicodeLevel | undefined {
  if (kind !== "onoff") return undefined;
  return current === "on" ? undefined : "on";
}

/** 界面档位 token 是否命中目标档位。**精确**比较：`High` 绝不能命中 `Higher` 之类 */
export function levelTokenMatches(uiToken: string, level: KimicodeLevel): boolean {
  return levelOfToken(uiToken) === level;
}

/** 校验模型参数：model 必填（Kimi Code 无「默认模型」概念，界面当前值不可作为任务语义） */
export function parseKimicodeModel(
  model: string | undefined,
  level: string | undefined,
): KimicodeModelSpec {
  const trimmed = (model ?? "").trim();
  if (!trimmed) throw new Error("Kimi Code 必须指定 model（如「K3」）");
  const normalized = normalizeReasoningLevel(level);
  return { model: trimmed, level: normalized.level, unsupported: normalized.unsupported };
}

/** 机构调用方（handlers）在无界面档位集合时能报出的取值错误文案 */
export function describeLevelValueError(spec: KimicodeModelSpec): string | undefined {
  if (spec.unsupported === undefined) return undefined;
  return `Kimi Code 的思考等级不支持${receiptOf(spec.unsupported)}：仅支持 低/low、高/high、max、on、off，且必须落在所选模型的界面档位集合内`;
}