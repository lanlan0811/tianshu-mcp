export interface ZcodeModelSpec {
  provider: string;
  model: string;
}

export class ZcodeModelReadbackError extends Error {}

export interface ZcodeModelSelectionRaw {
  display: string;
  ariaLabel?: string;
  currentValue?: string;
  legacyInternal?: string;
  visibleLabel?: string;
  title?: string;
  ambiguous?: boolean;
}

export function parseZcodeModel(value: string | undefined): ZcodeModelSpec {
  if (!value) throw new Error("ZCode 必须指定 model，格式为 供应商/模型");
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0]!.trim() || !parts[1]!.trim())
    throw new Error(`ZCode model 格式错误：${value}（应为 供应商/模型）`);
  return { provider: parts[0]!.trim(), model: parts[1]!.trim() };
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
  if (
    raw.ambiguous ||
    (raw.visibleLabel &&
      raw.title &&
      !exactUiName(modelName(raw.visibleLabel), modelName(raw.title)))
  )
    throw new ZcodeModelReadbackError("ZCode 当前模型可见标签存在歧义");
  if (currentModel && visibleLabel && !exactUiName(currentModel, modelName(visibleLabel)))
    throw new ZcodeModelReadbackError("ZCode 当前模型属性与可见标签冲突");
  if (currentModel) display = visibleLabel || currentModel;
  else if (visibleLabel) display = visibleLabel;
  else if (ariaLabel && display.includes(ariaLabel))
    throw new ZcodeModelReadbackError("ZCode 模型文本包含混合标签，无法确认当前模型");
  const legacyInternal = raw.legacyInternal?.trim() ?? "";
  return {
    display,
    internal:
      currentModel ||
      legacyInternal ||
      (display.includes("/") ? display.slice(display.indexOf("/") + 1).trim() : display),
  };
}
