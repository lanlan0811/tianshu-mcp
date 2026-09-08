/**
 * 模型切换（开发计划 §4.5 决策 7：用户可指定 TraeWork 使用的模型）。
 * 下拉是虚拟滚动列表，需滚动收集；切换后严格验证，不一致绝不静默继续。
 */
import type { TraeworkCdpClient } from "../cdp/client.js";
import type { AgentRunLogger } from "../../adapter.js";
import type { SelectorOverrides } from "../cdp/selectors.js";
import { modelNameMatch } from "./reply.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface ModelSwitchOptions {
  selectors?: SelectorOverrides;
  logger: AgentRunLogger;
}

export type ModelSwitchResult =
  | { ok: true; model: string }
  | { ok: false; reason: "not_found" | "restricted" | "verify_failed"; model?: string; available?: string[] };

interface DropdownOption {
  text: string;
  restricted: boolean;
  x: number;
  y: number;
}

/** 读取下拉中当前可见的模型项（含受限标记与坐标） */
async function readOptions(cdp: TraeworkCdpClient, selectors?: SelectorOverrides): Promise<DropdownOption[]> {
  const raw = await cdp.evaluateString(`(function(){
    const cs = ${JSON.stringify([selectors?.modelOption, ".core-model-select-model-item", "[class*='model-select-model-item']"].filter(Boolean))};
    let items = [];
    for (const c of cs) { const found = document.querySelectorAll(c); if (found.length) { items = [...found]; break; } }
    const out = [];
    for (const it of items) {
      const nameEl = it.querySelector('[class*=name]');
      const text = (nameEl ? nameEl.textContent : it.textContent || '').trim();
      const r = it.getBoundingClientRect();
      if (text) out.push({ text, restricted: String(it.className || '').includes('access-restricted'), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
    }
    return JSON.stringify(out);
  })()`);
  try {
    return JSON.parse(raw || "[]") as DropdownOption[];
  } catch {
    return [];
  }
}

/** 滚动模型下拉列表一屏；返回是否还能继续滚动 */
async function scrollList(cdp: TraeworkCdpClient, selectors?: SelectorOverrides): Promise<boolean> {
  const sel = selectors?.modelList ?? ".core-model-select-model-list";
  const v = await cdp.evaluate<number | null>(`(function(){
    const list = document.querySelector(${JSON.stringify(sel)});
    if (!list) return null;
    const before = list.scrollTop;
    list.scrollTop += 200;
    return list.scrollTop > before ? list.scrollTop : null;
  })()`);
  return v !== null;
}

/** 收集下拉中全部可用模型显示名（滚动到底） */
export async function collectModels(cdp: TraeworkCdpClient, opts: ModelSwitchOptions): Promise<string[]> {
  const { selectors, logger } = opts;
  // 若下拉已打开先关闭，保证坐标有效
  if ((await readOptions(cdp, selectors)).length > 0) {
    await cdp.pressEscape();
    await sleep(700);
  }
  const pos = await cdp.center("modelTrigger", selectors);
  if (!pos) {
    logger.warn("[traework] 找不到模型下拉触发器");
    return [];
  }
  await cdp.clickAt(pos.x, pos.y);
  await sleep(1500);

  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    // eslint-disable-next-line no-await-in-loop
    const opts2 = await readOptions(cdp, selectors);
    for (const o of opts2) if (!o.restricted) seen.add(o.text);
    // eslint-disable-next-line no-await-in-loop
    if (!(await scrollList(cdp, selectors))) break;
    // eslint-disable-next-line no-await-in-loop
    await sleep(350);
  }
  await cdp.pressEscape();
  await sleep(400);
  return [...seen];
}

/**
 * 切换模型（严格验证）。model 可为配置名或显示名。
 * 未命中 / 需解锁权益 / 切换后不一致 → 明确失败，不静默用错模型。
 */
export async function selectModel(
  cdp: TraeworkCdpClient,
  model: string,
  opts: ModelSwitchOptions,
): Promise<ModelSwitchResult> {
  const { selectors, logger } = opts;

  // 已选中则无需操作
  const current = await cdp.text("modelTriggerValue", selectors);
  if (modelNameMatch(current, model)) {
    logger.info(`[traework] 模型已是 ${current}，无需切换`);
    return { ok: true, model: current };
  }

  // 打开下拉
  if ((await readOptions(cdp, selectors)).length > 0) {
    await cdp.pressEscape();
    await sleep(700);
  }
  const trigger = await cdp.center("modelTrigger", selectors);
  if (!trigger) return { ok: false, reason: "not_found" };
  await cdp.clickAt(trigger.x, trigger.y);
  await sleep(1500);

  // 滚动查找目标
  let target: DropdownOption | undefined;
  for (let i = 0; i < 40 && !target; i++) {
    // eslint-disable-next-line no-await-in-loop
    const options = await readOptions(cdp, selectors);
    target = options.find((o) => modelNameMatch(o.text, model));
    if (target) break;
    // eslint-disable-next-line no-await-in-loop
    if (!(await scrollList(cdp, selectors))) break;
    // eslint-disable-next-line no-await-in-loop
    await sleep(350);
  }

  if (!target) {
    const available = (await readOptions(cdp, selectors)).filter((o) => !o.restricted).map((o) => o.text);
    await cdp.pressEscape();
    return { ok: false, reason: "not_found", available };
  }
  if (target.restricted) {
    await cdp.pressEscape();
    return { ok: false, reason: "restricted", model: target.text };
  }

  // 滚动到可见后点击（位置会变，重新取坐标）
  await cdp.evaluate(`(function(){
    const items = document.querySelectorAll(${JSON.stringify(selectors?.modelOption ?? ".core-model-select-model-item")});
    for (const it of items) {
      const nameEl = it.querySelector('[class*=name]');
      const t = (nameEl ? nameEl.textContent : it.textContent || '').trim();
      if (t === ${JSON.stringify(target.text)}) { it.scrollIntoView({ block: 'center' }); break; }
    }
  })()`);
  await sleep(500);
  const pos = await cdp.evaluateString(`(function(){
    const items = document.querySelectorAll(${JSON.stringify(selectors?.modelOption ?? ".core-model-select-model-item")});
    for (const it of items) {
      const nameEl = it.querySelector('[class*=name]');
      const t = (nameEl ? nameEl.textContent : it.textContent || '').trim();
      if (t === ${JSON.stringify(target.text)}) {
        const r = it.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
      }
    }
    return '';
  })()`);
  if (!pos) {
    await cdp.pressEscape();
    return { ok: false, reason: "not_found", model: target.text };
  }
  const { x, y } = JSON.parse(pos) as { x: number; y: number };
  await cdp.clickAt(x, y);
  await sleep(1200);

  // 严格验证
  const now = await cdp.text("modelTriggerValue", selectors);
  if (modelNameMatch(now, model) || modelNameMatch(now, target.text)) {
    logger.info(`[traework] 模型已切换到 ${now}`);
    return { ok: true, model: now };
  }
  logger.warn(`[traework] 模型切换后验证不一致：期望 ${model}，实际 ${now}`);
  return { ok: false, reason: "verify_failed", model: target.text };
}
