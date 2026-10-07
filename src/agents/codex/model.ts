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

/**
 * 界面展示文案（中英双语候选），用于滑块回读校验与点击。
 * 真机实测（26.903.x）：思考强度滑块 5 档标签为
 *   0=轻度 / 1=中 / 2=高 / 3=极高 / 4=极高
 * 故「低」在 UI 上实际显示为「轻度」，必须一并接受。
 */
const LEVEL_UI: Record<NormalizedLevel, string[]> = {
  low: ["轻度", "低", "Low", "Light"],
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

/**
 * 判断给定界面等级文案是否命中目标等级。
 * 必须**精确**比较（而非包含）：UI 同时存在「高」与「极高」，
 * 若用 includes 会把手动停在「极高」误判成已命中「高」。
 */
export function levelTokenMatches(uiToken: string, level: NormalizedLevel): boolean {
  const token = uiToken.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
  return LEVEL_UI[level].some((t) => t.normalize("NFKC").trim().toLocaleLowerCase() === token);
}

/** 从「GPT-5.6 Sol 高」这类模型项文本里取出等级 token（最后一行/最后一段） */
export function extractLevelToken(modelItemText: string): string {
  const flat = modelItemText.normalize("NFKC").replace(/\s+/g, " ").trim();
  const parts = flat.split(/\s+/);
  return parts.length ? parts[parts.length - 1]! : "";
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
 * 触发器文本里可能出现的全部档位 token（issue #34）。
 * 真机实测（26.930.4958.0）：触发器按钮内的档位轮播层**9 层全在 DOM 里**，
 * 仅当前档 `opacity:1`（其余 `opacity:0` 但 `display:block`），故 `innerText` 会
 * 把整条等级条一并读出 —— 无/极低/轻度/中/高/极高/Max/Ultra/持续。
 * 外加历史版式的 低/Low/Medium/High。切分时必须按**整 token** 比较，避免误伤模型名子串。
 */
const TRIGGER_LEVEL_TOKENS = [
  "无",
  "极低",
  "轻度",
  "低",
  "中",
  "高",
  "极高",
  "Low",
  "Medium",
  "High",
  "Max",
  "Ultra",
  "持续",
];

/** 档位 token → 归一等级（复用 LEVEL_UI 的精确匹配语义：「极高」不得命中等同「高」） */
function levelOfTriggerToken(token: string): NormalizedLevel | undefined {
  for (const level of ["low", "medium", "high"] as const) {
    if (levelTokenMatches(token, level)) return level;
  }
  return undefined;
}

/**
 * `data-selected-reasoning-effort` 属性值 → 归一等级（issue #34）。
 * 该属性是触发器上的**权威机器可读值**，取值是枚举 id（low/medium/high/xhigh/max/…），
 * 与界面文案解耦。只有能一一对应到 `NormalizedLevel`（三档）的值才返回；
 * `xhigh` 等超出归一范围的档位返回 `undefined` —— **不猜**，交由调用方按「未匹配」处理。
 */
export function levelFromEffortToken(token: string | undefined): NormalizedLevel | undefined {
  const key = (token ?? "").normalize("NFKC").trim().toLocaleLowerCase();
  const map: Record<string, NormalizedLevel> = { low: "low", medium: "medium", high: "high" };
  return map[key];
}

/**
 * 触发器回读到的**任意**档位 token → 归一等级（issue #34）。
 * 同时接受两类形态：属性枚举 id（low/medium/high）与界面文案（轻度/中/高）。
 * `xhigh` / `Max` / `Ultra` 等超出 `NormalizedLevel`（三档）的档位返回 `undefined` —— **不猜**。
 */
export function levelFromTriggerToken(token: string | undefined): NormalizedLevel | undefined {
  return levelFromEffortToken(token) ?? (token ? levelOfTriggerToken(token) : undefined);
}

/** 结构化回读值（与 cdp.ts 的 CodexModelTriggerReadback 同形；此处独立声明避免 model→cdp 依赖） */
export interface TriggerReadbackLike {
  model: string;
  levelToken?: string;
  levelTextToken?: string;
  source: "attrs" | "nodes" | "innerText";
  raw: string;
}

/** `resolveTriggerReadback` 的归一结果：run.ts 的匹配判据直接消费它 */
export interface TriggerValue {
  /** 模型名；空串 = 本次未读到（调用方按未知等待，不得据此判不符） */
  model: string;
  level?: NormalizedLevel;
  /** 非空表示两条档位来源不一致，已按属性取值并如实回报 */
  mismatch?: string;
  /** 本次读到的来源，仅用于日志诊断 */
  source?: "attrs" | "nodes" | "innerText";
}

/**
 * 把结构化回读值归一为「模型 + 等级」（issue #34）。
 *
 * - `attrs` / `nodes` 来源：模型名直接取自专用节点，**不再解析整串**；
 * - `innerText` 来源（老版式 / 类名漂移）：整串交 `parseTriggerValue` 兜底切分；
 * - 属性值与界面文案**不一致**时以属性为准，并在 `mismatch` 里如实回报（不静默选其一）；
 * - 无任何来源时返回 `{ model: "" }`，**调用方须按「未读到」等待**，不得据此判 `model_mismatch`。
 */
export function resolveTriggerReadback(read: TriggerReadbackLike): TriggerValue {
  if (read.source === "innerText" || !read.model) {
    const parsed = read.raw ? parseTriggerValue(read.raw) : { model: "" };
    return { ...parsed, source: read.source };
  }
  const fromToken = levelFromTriggerToken(read.levelToken);
  if (read.levelToken && read.levelTextToken) {
    const fromText = levelFromTriggerToken(read.levelTextToken);
    if (fromToken !== undefined && fromText !== undefined && fromToken !== fromText)
      return {
        model: read.model,
        level: fromToken,
        source: read.source,
        mismatch: `档位来源不一致：属性=${read.levelToken}(${fromToken}) / 界面文案=${read.levelTextToken}(${fromText})，已按属性取值`,
      };
  }
  return { model: read.model, level: fromToken, source: read.source };
}

/**
 * 从触发器文本中解析「模型 + 等级」。
 * 形如「GPT-5.6 Sol 高」「GPT-5.6 Sol\n高」「GPT-5.6 Sol High」。
 *
 * issue #34：这是**兜底路径**（结构化回读不可用时的降级），因此必须容忍真机 26.930 的
 * 形态 —— `innerText` 混入整条等级条（`6 Luna 中 无 极低 轻度 中 高 极高 Max Ultra 持续`）。
 * 旧实现要求文本**以等级词结尾**，此处以「持续」结尾即整串被当型号 → `model_mismatch`。
 * 现改为「扫到首个档位 token 为止」：模型名 = 首个档位 token 之前的部分。
 */
export function parseTriggerValue(text: string): { model: string; level?: NormalizedLevel } {
  const flat = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!flat) return { model: "" };
  const parts = flat.split(/\s+/);
  const idx = parts.findIndex((part) =>
    TRIGGER_LEVEL_TOKENS.some((token) => token.toLocaleLowerCase() === part.toLocaleLowerCase()),
  );
  // 无档位 token：整串即模型名（沿用旧语义）
  if (idx < 0) return { model: flat };
  const model = parts.slice(0, idx).join(" ").trim();
  // 整串都是档位词、取不到模型名 —— 不猜，整串回传交由调用方按「不符」处理
  if (!model) return { model: flat };
  return { model, level: levelOfTriggerToken(parts[idx]!) };
}
