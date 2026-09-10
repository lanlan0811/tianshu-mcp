export interface ZcodeModelSpec {
  provider: string;
  model: string;
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
