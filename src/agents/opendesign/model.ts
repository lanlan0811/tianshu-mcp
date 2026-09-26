/**
 * Open Design 的「设计方向」归一与「模型 / 设计系统」候选匹配。
 *
 * 三族语义必须分清，别混用（Kimi/ZCode 的历史教训）：
 * - `normalizeOpenDesignDirection`：把用户输入归一为内部值，**非法值直接拒绝**（不在 UI 层兜底）。
 * - `matchMenuCandidate`：菜单候选项与目标名之间是**精确匹配**（去首尾空白 + 大小写/全半角归一），
 *   匹配不上就报错并**回显当前可见候选**——绝不退化成模糊匹配（选错模型比报错更糟）。
 * - `exactUiName`：回读校验专用，只用于「UI 现在显示的确实是我刚选的那个」这个判断。
 */

/** 内部设计方向值（只支持这三种，其余 UI 方向一律拒绝） */
export type OpenDesignDirection = "prototype" | "document" | "clone";

/** 设计方向 → 中文 UI 菜单文本（profile.directionLabels 可覆盖） */
export const OPEN_DESIGN_DIRECTION_LABELS: Record<OpenDesignDirection, string> = {
  prototype: "原型",
  document: "文档",
  clone: "网站复刻",
};

/** 允许的外部写法（中英 + 常见同义写法）→ 内部值 */
const DIRECTION_ALIASES: Record<string, OpenDesignDirection> = {
  原型: "prototype",
  prototype: "prototype",
  文档: "document",
  document: "document",
  doc: "document",
  网站复刻: "clone",
  网站克隆: "clone",
  clone: "clone",
  website: "clone",
  "website-clone": "clone",
};

/**
 * UI 里存在但**产品策略不允许派发**的方向（会被显式拒绝，而不是「未识别」）。
 * 明确列出是为了给出可操作的错误文案：用户看到「幻灯片」应当被告知「本适配器不支持」，
 * 而不是「未知取值」。
 */
export const OPEN_DESIGN_REJECTED_DIRECTIONS = ["幻灯片", "图片", "HyperFrames"] as const;

export function normalizeOpenDesignDirection(
  value: string | undefined,
): { ok: true; direction: OpenDesignDirection } | { ok: false; error: string } {
  const raw = (value ?? "").trim();
  if (!raw)
    return {
      ok: false,
      error:
        "Open Design 需要 designDirection 参数（设计方向）：只支持「原型 / 文档 / 网站复刻」（prototype / document / clone）",
    };
  const key = raw.toLowerCase();
  const hit = DIRECTION_ALIASES[raw] ?? DIRECTION_ALIASES[key];
  if (hit) return { ok: true, direction: hit };
  if ((OPEN_DESIGN_REJECTED_DIRECTIONS as readonly string[]).includes(raw))
    return {
      ok: false,
      error: `Open Design 不支持设计方向「${raw}」：只支持「原型 / 文档 / 网站复刻」`,
    };
  return {
    ok: false,
    error: `无法识别的设计方向「${raw}」：只支持「原型 / 文档 / 网站复刻」（prototype / document / clone）`,
  };
}

/** 取设计方向应点击的菜单文本（profile.directionLabels 优先，中文默认值兜底） */
export function directionLabel(
  direction: OpenDesignDirection,
  overrides: Record<string, string> = {},
): string {
  const override = overrides[direction]?.trim();
  return override || OPEN_DESIGN_DIRECTION_LABELS[direction];
}

/**
 * 名称归一：去首尾空白、压缩内部空白、全角空格→半角、大小写统一。
 * 用于**回读校验**；`matchMenuCandidate` 同样以它做基准确匹配。
 */
export function normalizeKey(value: string): string {
  return value
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** 回读校验：UI 当前显示值是否就是刚选的目标值（不做包含匹配） */
export function exactUiName(actual: string | undefined, wanted: string): boolean {
  const a = normalizeKey(actual ?? "");
  const b = normalizeKey(wanted);
  return a.length > 0 && a === b;
}

export interface MenuCandidate {
  label: string;
}

export interface CandidateMatch {
  ok: boolean;
  index: number;
  label?: string;
  /** 匹配失败时回显当前可见候选（最多 20 项），便于选择器/文案漂移时定位 */
  candidates?: string[];
  error?: string;
}

/**
 * 在菜单候选中精确匹配目标名。
 * 命中多个同名字项时取第一个（UI 里同名项不可区分，取首个是稳定行为）。
 */
export function matchMenuCandidate(
  candidates: MenuCandidate[],
  wanted: string,
  what = "菜单项",
): CandidateMatch {
  const target = normalizeKey(wanted);
  const labels = candidates.map((c) => (c.label ?? "").trim()).filter(Boolean);
  const index = labels.findIndex((label) => normalizeKey(label) === target);
  if (index >= 0) return { ok: true, index, label: labels[index]! };
  const visible = labels.slice(0, 20).join("、");
  return {
    ok: false,
    index: -1,
    candidates: labels.slice(0, 20),
    error: `未找到${what}「${wanted}」${visible ? `；当前可见候选：${visible}` : "；当前菜单没有可见候选项"}`,
  };
}

/**
 * 从触发区文本里抽出「模型名」。触发区通常形如 `v4.1-flash`，但也可能带上状态点或
 * 后缀（如 `v4.1-flash ▾`）。这里只做保守清理：去掉常见装饰字符后取首个非空片段。
 */
export function parseTriggerValue(text: string | undefined): string | undefined {
  const cleaned = (text ?? "")
    .replace(/[\u25be\u25bc\u2304\u2193\u2191]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  return cleaned;
}
