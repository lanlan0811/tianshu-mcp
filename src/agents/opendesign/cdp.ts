/**
 * Open Design 的 CDP 客户端装配。
 *
 * 复用 `TraeworkCdpClient` 作为页面级实现（WebSocket / send 超时 / 断线语义已经打磨过），
 * 只注入本产品的**目标排序**：主窗口与浮层（下拉菜单可能渲染在独立渲染进程里，
 * 与 Kimi Code 的 Browser Overlay 同构）各自需要一个 rank 函数。
 */
import { TraeworkCdpClient } from "../traework/cdp/client.js";
import type { KimicodePageClient, KimicodePageRole } from "../kimicode/cdp.js";
import type { SelectorOverrides } from "./dom.js";
import {
  OPEN_DESIGN_LAYOUT_GUARD_KEYS,
  OPEN_DESIGN_SELECTORS,
  type OpenDesignSelectorKey,
} from "./selectors.js";
import { layoutProbeExpression, type LayoutProbeEntry } from "./dom.js";

export interface OpenDesignTargetLike {
  type?: string;
  title?: string;
  url?: string;
}

/** 标题以 Open Design 开头的页面 = 本产品主窗口 */
function isProductPage(target: OpenDesignTargetLike): boolean {
  const title = (target.title ?? "").trim();
  return /^open design/i.test(title) || /open-design/i.test(target.url ?? "");
}

/** 主窗口优先：标题恰为 `Open Design` 者最优先，其次本产品页面，最后其他 page */
export function openDesignMainTargetRank(target: OpenDesignTargetLike): number {
  if ((target.title ?? "").trim() === "Open Design") return 0;
  if (isProductPage(target)) return 1;
  return 2;
}

/** 浮层优先：下拉菜单若在独立渲染进程，其标题通常不是主窗口标题 */
export function openDesignOverlayTargetRank(target: OpenDesignTargetLike): number {
  const title = (target.title ?? "").trim();
  if (!title || /^about:blank$/i.test(target.url ?? "")) return 0;
  return isProductPage(target) ? 2 : 1;
}

export interface OpenDesignCdpDeps {
  /** 按角色创建页面客户端；缺省创建 TraeworkCdpClient（带各自的 targetRank） */
  createClient?: (role: KimicodePageRole) => KimicodePageClient;
}

/**
 * 页面角色 → 客户端。与 KimicodeCdpClient 的装配同构，但**不**在这里做聚焦/重试策略，
 * 那些属于具体步骤（P2 起）的职责。
 */
export function createOpenDesignPageClient(
  role: KimicodePageRole,
  port: number,
  sendTimeoutMs: number,
  deps: OpenDesignCdpDeps = {},
): KimicodePageClient {
  if (deps.createClient) return deps.createClient(role);
  return new TraeworkCdpClient({
    port,
    sendTimeoutMs,
    targetRank: role === "overlay" ? openDesignOverlayTargetRank : openDesignMainTargetRank,
  }) as KimicodePageClient;
}

export interface OpenDesignDocumentProbe {
  /** 页面 URL 与标题（诊断用） */
  url: string;
  title: string;
  /** 关键锚点的存在性与文本（选择器漂移的诊断依据） */
  anchors: LayoutProbeEntry[];
  /** 页面可见文本长度（判「页面还没渲染完」用的粗信号） */
  bodyTextLength: number;
}

/**
 * 在**主窗口**里执行一次只读布局盘点：按注册表里每个语义键解析元素并计数。
 * 纯读取、不点任何东西——probe 脚本、`run.ts` 的 selector_drift 判据共用同一份实现
 * （两处各写一套必然漂移）。
 *
 * `overrides` 用于真机采集：把候选 CSS 按语义键传进来即可读出命中情况。
 */
export async function probeLayout(
  client: KimicodePageClient,
  overrides: SelectorOverrides = {},
): Promise<OpenDesignDocumentProbe> {
  return client.evaluate<OpenDesignDocumentProbe>(
    layoutProbeExpression(OPEN_DESIGN_LAYOUT_GUARD_KEYS, overrides),
  );
}

/**
 * 采集模式：对**全部**语义键（含菜单/按钮这类运行期才出现的键）做布局盘点，
 * 供 `scripts/probe-opendesign.mjs` 输出候选命中清单。缺值的键不会进表达式。
 */
export async function probeAllAnchors(
  client: KimicodePageClient,
  overrides: SelectorOverrides = {},
): Promise<OpenDesignDocumentProbe> {
  const keys = Object.keys(OPEN_DESIGN_SELECTORS) as OpenDesignSelectorKey[];
  const present = keys.filter((key) => {
    const spec = OPEN_DESIGN_SELECTORS[key];
    return Boolean(overrides[key]?.trim() || spec.primary.trim() || (spec.fallbacks ?? []).length);
  });
  return client.evaluate<OpenDesignDocumentProbe>(layoutProbeExpression(present, overrides));
}

/** 选择器覆盖的浅合并（profile.gui.selectors 覆盖内置默认） */
export function mergeSelectors(
  defaults: Record<string, string>,
  overrides: SelectorOverrides = {},
): Record<string, string> {
  const out: Record<string, string> = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (value && value.trim()) out[key] = value.trim();
  }
  return out;
}
