/**
 * 三级验收配置继承（issue #20）。
 *
 * 一个天枢宿主下挂载多个同类项目（例如多个前端工程）时，逐个项目创建
 * `.tianshu-mcp/acceptance.json` 成本高、维护易遗漏。因此引入继承链，优先级由低到高：
 *
 *   1. `<数据目录>/acceptance.default.json`   （全局兜底；缺失 = 空配置，不报错）
 *   2. `<project>/.tianshu-mcp/acceptance.json`（项目级覆盖）
 *   3. 派发任务时传入的临时覆盖参数            （最高优先级；仅当次任务生效，不落盘为配置）
 *
 * **合并语义（刻意从简，见下）**：按字段「高优先级层定义了就整体取胜」。
 * - 标量（`requireChanges` / `verifyConcurrency`）：即标准的覆盖语义。
 * - 数组（`checks`）：**整体覆盖**而非拼接 —— 拼接会让「项目追加一项检查」变成
 *   「项目无法移除全局检查」，歧义大且不可预测，issue 也明确建议整体覆盖。
 * - 对象（`visual`）：同样**整体覆盖**，不做跨层深合并。
 *
 * 关于 `visual` 不做深合并的理由（**重要，改这里前先读**）：`VisualConfigSchema` 的几乎每个
 * 字段都带 `.default()`（`enabled` / `browser` / `viewports` / `defaults` / `limits` / …）。
 * 一旦允许深合并，解析任一层都会 materialize 一整套默认值，低优先级层的**显式**取值会被
 * 高优先级层「未书写、仅因默认值而出现」的字段静默覆盖 —— 与 `requireChanges` 曾经踩过的
 * `.default(true)` 污染是同一类错误。要做对必须改为「合并在原始 JSON 上、只对合并结果做一次
 * 校验」，改动面明显更大且收益有限（issue 举的字段都是标量）。故本版明确选择整体覆盖。
 *
 * 本模块**只服务验收配置**，刻意不做通用深合并工具。
 */
import type { PartialAcceptanceConfig } from "./schema.js";

export interface AcceptanceLayer {
  source: "global" | "project" | "override";
  /** 该层的来源路径（override 层写「调用参数」） */
  path: string;
  /** 解析后的分层配置；该层文件缺失时省略 */
  config?: PartialAcceptanceConfig;
}

export interface ResolvedAcceptance {
  /** 合并后仍可能缺省（消费方负责兜底默认值） */
  config: PartialAcceptanceConfig;
  /** 实际参与合并的层（仅包含存在的层），按优先级从低到高 */
  applied: { source: AcceptanceLayer["source"]; path: string }[];
}

/**
 * 合并两层配置：override 中**显式书写**的字段整体取代 base 的同名字段。
 * `undefined` 视为「本层未书写」，不参与覆盖（否则 `{requireChanges: undefined}` 会误清空下层取值）。
 */
export function mergeAcceptanceConfig(
  base: PartialAcceptanceConfig | undefined,
  override: PartialAcceptanceConfig | undefined,
): PartialAcceptanceConfig {
  const out: PartialAcceptanceConfig = { ...(base ?? {}) };
  const target = out as Record<string, unknown>;
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value !== undefined) target[key] = value;
  }
  return out;
}

/** 按数组顺序（低 → 高优先级）依次合并；缺失层直接跳过 */
export function resolveAcceptanceLayers(layers: AcceptanceLayer[]): ResolvedAcceptance {
  let config: PartialAcceptanceConfig = {};
  const applied: { source: AcceptanceLayer["source"]; path: string }[] = [];
  for (const layer of layers) {
    if (!layer.config) continue;
    config = mergeAcceptanceConfig(config, layer.config);
    applied.push({ source: layer.source, path: layer.path });
  }
  return { config, applied };
}

/** 供调试命令/日志使用的一行摘要（不打印任何凭证，只打层与最终取值） */
export function summarizeResolved(resolved: ResolvedAcceptance): string {
  const c = resolved.config;
  return [
    `生效层=${resolved.applied.map((a) => a.source).join(">") || "（无）"}`,
    `checks=${c.checks ? c.checks.length : "（默认集）"}`,
    `requireChanges=${c.requireChanges ?? "（默认 true）"}`,
    `verifyConcurrency=${c.verifyConcurrency ?? "（继承 server config）"}`,
    `visual=${c.visual ? "已覆盖" : "（未配置）"}`,
  ].join(" ");
}
