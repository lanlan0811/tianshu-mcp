/**
 * Open Design 的 CDP 客户端装配。
 *
 * 复用 `TraeworkCdpClient` 作为页面级实现（WebSocket / send 超时 / 断线语义已经打磨过），
 * 只注入本产品的**目标排序**：主窗口与浮层（下拉菜单可能渲染在独立渲染进程里，
 * 与 Kimi Code 的 Browser Overlay 同构）各自需要一个 rank 函数。
 */
import { TraeworkCdpClient } from "../traework/cdp/client.js";
import type { KimicodePageClient, KimicodePageRole } from "../kimicode/cdp.js";
import type { SelectorOverrides } from "../kimicode/dom.js";

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
  anchors: Record<string, { count: number; text?: string }>;
}

/**
 * 在**主窗口**里执行一次只读盘点：把 anchors 里每个 CSS 选择器数一遍并取首个文本。
 * 脚本是纯读取，不点任何东西——probe 脚本与后续 selector_drift 诊断共用。
 */
export async function probeDocumentAnchors(
  client: KimicodePageClient,
  selectors: Record<string, string>,
): Promise<OpenDesignDocumentProbe> {
  const payload = JSON.stringify(selectors);
  const expression = `(() => {
  const spec = ${payload};
  const out = {};
  for (const key of Object.keys(spec)) {
    let count = 0;
    let text;
    try {
      const nodes = document.querySelectorAll(spec[key]);
      count = nodes.length;
      if (count > 0) {
        const raw = (nodes[0].innerText ?? nodes[0].textContent ?? "").trim();
        text = raw.length > 200 ? raw.slice(0, 200) : raw;
      }
    } catch (e) {
      count = -1;
      text = "selector-error: " + String(e && e.message ? e.message : e);
    }
    out[key] = text === undefined ? { count } : { count, text };
  }
  return { url: location.href, title: document.title, anchors: out };
})()`;
  return client.evaluate<OpenDesignDocumentProbe>(expression);
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
