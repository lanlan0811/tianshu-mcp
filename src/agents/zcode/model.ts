export interface ZcodeModelSpec {
  provider: string;
  model: string;
}

export interface ZcodeModelSelectionRaw {
  display: string;
  ariaLabel?: string;
  currentValue?: string;
  legacyInternal?: string;
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

export function normalizeZcodeModelSelection(
  raw: ZcodeModelSelectionRaw,
): { display: string; internal: string } {
  let display = raw.display.trim();
  const ariaLabel = raw.ariaLabel?.trim();
  if (ariaLabel) {
    while (display.startsWith(ariaLabel)) display = display.slice(ariaLabel.length).trim();
    while (display.endsWith(ariaLabel)) display = display.slice(0, -ariaLabel.length).trim();
  }
  const currentValue = raw.currentValue?.trim() ?? "";
  const currentModel = currentValue ? (currentValue.split(":").at(-1)?.trim() ?? "") : "";
  const legacyInternal = raw.legacyInternal?.trim() ?? "";
  return {
    display,
    internal:
      currentModel ||
      legacyInternal ||
      (display.includes("/") ? display.slice(display.indexOf("/") + 1).trim() : ""),
  };
}
