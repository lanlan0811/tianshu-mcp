/**
 * MiniMax Code 模型三件套的选择流程（模型 / 推理等级 / 上下文窗口）。
 *
 * 从 run.ts 抽出：这是本适配器最复杂的一段（二级子菜单 + 三种模型形态 + fail-closed 校验），
 * 独立成文件便于单测与阅读。
 *
 * 真机实测（2026-10-05，MiniMax Code 3.1.0）确立的三条硬事实：
 *
 * 1) **档位与窗口在二级子菜单里**：带 `aria-haspopup="menu"` 的模型项悬停后
 *    `aria-expanded` 变 `true`，窗口里出现第二个 `role="menu"`，其中才是
 *    `role=group[aria-label=推理等级]` 与 `[data-testid=model-context-control]`。
 *    直接点模型项会**立即提交切换并关闭菜单**，什么也读不到。
 *
 * 2) **子菜单容器复用**：不先移开再移入，会读到**上一个悬停模型**残留的 DOM。
 *    因此读候选必须带「归属模型」约束（见 cdp.effortOptions(model)）。
 *
 * 3) **档位/窗口集合随模型变化**（实测）：
 *    - `M3.1-Flash-Preview`：六档（default/low/medium/high/xhigh/max）+ 窗口（512K/1M）；
 *    - `M3`：**无档位组** + 窗口；
 *    - `deepseek-v4.1-flash`：三档（low/high/max）+ **无窗口组**；
 *    - `M2.7-highspeed` / `M2.7`：**无子菜单**。
 *    → 对无子菜单的模型请求档位/窗口必须在发送前响亮报错，绝不静默沿用界面当前值。
 *
 * 顺序纪律：**先选档位/窗口，最后点模型项提交**——点模型项会关菜单，所以它必须放最后。
 */
import type { AgentRunLogger } from "../adapter.js";
import type { MinimaxCdpClient, MinimaxContextOption, MinimaxEffortOption } from "./cdp.js";
import {
  assertContextWindowSupported,
  assertLevelSupported,
  exactUiName,
  levelOfToken,
  optionMatches,
  parseTriggerValue,
  tierSetOf,
  type MinimaxModelSpec,
} from "./model.js";

export interface SelectModelArgs {
  cdp: MinimaxCdpClient;
  spec: MinimaxModelSpec;
  /** 悬停后等待二级子菜单展开的预算（ms） */
  submenuTimeoutMs: number;
  /** 菜单交互预算（调用方夹住任务总时限/setup 预算后的剩余值） */
  menuBudget: () => number;
  sleep: (ms: number) => Promise<void>;
  logger: AgentRunLogger;
}

export interface SelectModelOutcome {
  ok: boolean;
  /** 成功时的模型触发器全文（供档位回读） */
  trigger?: string;
  /** 失败归类：写入 AgentRunResult.endReason */
  endReason?: "model_mismatch" | "model_unavailable";
  error?: string;
}

/** 可见候选列表（选择器漂移时的诊断依据，最多 20 项） */
function candidatesOf(items: Array<{ label: string }>): string {
  return items
    .map((item) => item.label)
    .filter(Boolean)
    .slice(0, 20)
    .join("、");
}

export class MinimaxModelSelectError extends Error {
  constructor(
    message: string,
    readonly endReason: "model_mismatch" | "model_unavailable",
  ) {
    super(message);
  }
}

/**
 * 确保界面模型 = `spec.model`，并（在请求时）设置推理等级与上下文窗口。
 *
 * 读模型名一律走 `parseTriggerValue`（触发器可能是单行模型名，也可能是「模型\n档位」两行）。
 * 所有比较都是 NFKC 归一的**精确**匹配——`M3` 与 `M3.1-Flash-Preview` 必须区分。
 */
export async function selectModel(args: SelectModelArgs): Promise<SelectModelOutcome> {
  try {
    const trigger = await ensureModelSelected(args);
    return { ok: true, trigger };
  } catch (error) {
    if (error instanceof MinimaxModelSelectError)
      return { ok: false, endReason: error.endReason, error: error.message };
    throw error;
  }
}

/** 读触发器文本；`waitForModel` 时等到模型名回读一致（限定观察期，不无限等） */
async function readTrigger(
  cdp: MinimaxCdpClient,
  spec: MinimaxModelSpec,
  sleep: (ms: number) => Promise<void>,
  waitForModel = false,
): Promise<string> {
  const until = Date.now() + 5_000;
  let last = "";
  for (let attempt = 0; attempt < 25 && Date.now() < until; attempt++) {
    last = await cdp.modelTriggerText();
    if (!waitForModel || exactUiName(parseTriggerValue(last).model, spec.model)) return last;
    await sleep(Math.min(200, Math.max(0, until - Date.now())));
  }
  return last;
}

function modelMatches(text: string, spec: MinimaxModelSpec): boolean {
  return exactUiName(parseTriggerValue(text).model, spec.model);
}

/**
 * 主流程：读当前模型 → 不匹配则切换（含子菜单档位/窗口）→ 回读校验。
 * 抛出 `MinimaxModelSelectError` 表示失败（调用方映射到 endReason）。
 */
async function ensureModelSelected(args: SelectModelArgs): Promise<string> {
  const { cdp, spec, menuBudget, sleep, logger } = args;
  const needsSubmenu = Boolean(spec.level || spec.contextWindow);

  let trigger = await readTrigger(cdp, spec, sleep);
  /** 诊断用：可见候选（UI 漂移时的定位依据） */
  let menuCandidates: string[] = [];
  /** 是否真的点中过某个模型项——决定失败是「没有这个模型」还是「点了但没生效」 */
  let pickedAnywhere = false;

  // 菜单只在需要切换、或需要确认档位/窗口时才打开——已匹配且无额外要求时不打扰界面。
  if (!modelMatches(trigger, spec) || needsSubmenu) {
    if (!(await cdp.openModelMenu(menuBudget()))) {
      throw new MinimaxModelSelectError(
        "无法打开 MiniMax Code 模型菜单（独立 Model menu 窗口未出现或触发器点击被吞）",
        "model_mismatch",
      );
    }
    const models = await cdp.menuModels();
    menuCandidates = models.map((m) => m.name).filter(Boolean);
    const hit = models.filter((m) => exactUiName(m.name, spec.model));
    if (hit.length !== 1) {
      await cdp.dismissMenus();
      throw new MinimaxModelSelectError(
        `模型不存在或同名歧义：${spec.model}（可见候选=${menuCandidates.join("、") || "无"}）`,
        "model_unavailable",
      );
    }
    const target = hit[0]!;

    if (needsSubmenu && !target.hasPopup) {
      // 该模型没有子菜单 → 档位/窗口无从指定。**绝不静默沿用界面当前值**。
      await cdp.dismissMenus();
      throw new MinimaxModelSelectError(
        `模型 ${spec.model} 不支持推理等级/上下文窗口设置（该项无子菜单），无法满足请求的` +
          ` reasoningLevel=${spec.level ?? spec.unsupported ?? ""}${spec.contextWindow ? ` / contextWindow=${spec.contextWindow}` : ""}；` +
          "请改用带子菜单的模型或移除这些参数",
        "model_unavailable",
      );
    }

    if (needsSubmenu) {
      // 二级子菜单：**先选档位/窗口，最后点模型项提交**（点它会关菜单）。
      await pickSubmenu(args);
      const picked = await cdp.clickExact("menu.modelOption", spec.model);
      pickedAnywhere = picked.clicked;
      if (!picked.clicked) {
        await cdp.dismissMenus();
        throw new MinimaxModelSelectError(
          `档位/窗口已选择，但模型项 ${spec.model} 无法点击提交（匹配 ${picked.count}）`,
          "model_mismatch",
        );
      }
    } else {
      const clicked = await cdp.clickExact("menu.modelOption", spec.model);
      pickedAnywhere = clicked.clicked;
      if (!clicked.clicked) {
        await cdp.dismissMenus();
        throw new MinimaxModelSelectError(
          `无法唯一点击模型项 ${spec.model}（匹配 ${clicked.count}；可见候选=${clicked.available.slice(0, 20).join("、") || "无"}）`,
          "model_mismatch",
        );
      }
    }
    await sleep(300);
    trigger = await readTrigger(cdp, spec, sleep, true);
  } else {
    logger.info(`[minimax] 模型回读已匹配，复用 ${spec.model}`);
  }

  if (!modelMatches(trigger, spec)) {
    const describe = `可见候选=${menuCandidates.join("、") || "无"}`;
    if (pickedAnywhere)
      throw new MinimaxModelSelectError(
        `模型切换回读不一致：触发器文本=${trigger || "空"}，期望模型=${spec.model}（${describe}）`,
        "model_mismatch",
      );
    throw new MinimaxModelSelectError(
      `模型不存在或同名歧义：${spec.model}（${describe}）`,
      "model_unavailable",
    );
  }

  // 档位回读：触发器第二行是档位（实测 `"M3.1-Flash-Preview\ndefault"`）。
  // 未指定档位时不比对（界面当前值即语义）；指定了就必须对得上。
  const parsed = parseTriggerValue(trigger);
  if (spec.level) {
    if (!parsed.levelToken)
      throw new MinimaxModelSelectError(
        `推理等级无法回读：触发器文本=${trigger || "空"}（未包含档位行），期望=${spec.level}`,
        "model_mismatch",
      );
    if (levelOfToken(parsed.levelToken) !== spec.level)
      throw new MinimaxModelSelectError(
        `推理等级回读不一致：触发器=${parsed.levelToken}，期望=${spec.level}`,
        "model_mismatch",
      );
    logger.info(`[minimax] 推理等级回读匹配：${parsed.levelToken}`);
  }
  await cdp.dismissMenus();
  return trigger;
}

/** 悬停目标模型展开子菜单 → 读候选 → 校验 → 依次选档位与窗口 */
async function pickSubmenu(args: SelectModelArgs): Promise<void> {
  const { cdp, spec, submenuTimeoutMs, menuBudget, logger } = args;
  if (!(await cdp.hoverModel(spec.model, Math.min(submenuTimeoutMs, menuBudget())))) {
    // 失败现场没有可诊断信息时只能靠重跑猜（真机缺陷，2026-10-10）：
    // 日志只留 `hoverModel elapsed=9630ms`，无法区分「菜单没开」「开的是别的窗口」
    // 「子菜单渲染了但归属不对」「子菜单容器为空」这四种情况。这里一次性取回全部事实，
    // **先记日志再抛错**（抛错后进程很快结束，日志是唯一留存的现场）。
    const diag = await cdp.menuDiagnostics(spec.model).catch(() => null);
    const owner = await cdp.submenuOwner().catch(() => "");
    logger.warn(
      `[minimax] 子菜单未展开：模型=${spec.model}；当前归属=${owner || "（无）"}；` +
        `菜单诊断=${JSON.stringify(diag ?? "（读取失败）")}`,
    );
    await cdp.dismissMenus();
    throw new MinimaxModelSelectError(
      `模型 ${spec.model} 的推理等级/上下文窗口子菜单未在观察期内展开` +
        `（悬停未生效或 UI 结构已漂移${owner ? `；当前子菜单归属=${owner}` : ""}` +
        `${diag ? `；菜单诊断=${JSON.stringify(diag)}` : ""}）`,
      "model_mismatch",
    );
  }
  const efforts = await cdp.effortOptions(spec.model);
  const contexts = await cdp.contextOptions(spec.model);
  const tiers = tierSetOf(efforts.map((e) => e.label));
  try {
    assertLevelSupported(spec, tiers);
    assertContextWindowSupported(
      spec,
      contexts.map((c) => c.label),
    );
  } catch (e) {
    await cdp.dismissMenus();
    throw new MinimaxModelSelectError(
      e instanceof Error ? e.message : String(e),
      "model_mismatch",
    );
  }
  await pickOption(args, "effort", spec.level, efforts);
  await pickOption(args, "context", spec.contextWindow, contexts);
  // 档位/窗口选完后由调用方点模型项提交（点它会关菜单，所以放最后）。
}

/**
 * 在二级子菜单里选一个选项。
 *
 * - `wanted` 未指定 → 不切换（沿用界面当前值；这不是「静默沿用请求值」——调用方本来就没要求）；
 * - `wanted` 指定 → 必须**精确**命中界面候选，点完还要**回读 `aria-checked`** 确认真的切过去了。
 *
 * 回读用**有界轮询至收敛**，不用「固定 sleep + 单次读数」（真机缺陷，2026-10-10）：
 * 点击后 UI 异步更新，实测同一轮内 `+350ms` 仍读到旧值 `512K`、`+1550ms` 才变 `1M`；
 * 旧实现等 350ms 就读一次，8 轮里 7 轮误报
 * `上下文窗口切换回读不一致：期望「1M」，实际「512K」` → `model_mismatch`——
 * **点击其实早已生效，是回读太早**。以收敛为准而非固定时长，
 * 与 `focusMainWindow()` 的既有做法一致。
 */
const SUBMENU_SETTLE_TIMEOUT_MS = 4_000;
const SUBMENU_SETTLE_POLL_MS = 200;

/** 读取某个子菜单的候选（按 kind 分派；两个维度共用同一套收敛逻辑） */
function readSubmenuOptions(
  cdp: MinimaxCdpClient,
  spec: MinimaxModelSpec,
  kind: "effort" | "context",
): Promise<(MinimaxEffortOption | MinimaxContextOption)[]> {
  return kind === "effort" ? cdp.effortOptions(spec.model) : cdp.contextOptions(spec.model);
}

async function pickOption(
  args: SelectModelArgs,
  kind: "effort" | "context",
  wanted: string | undefined,
  options: (MinimaxEffortOption | MinimaxContextOption)[],
): Promise<void> {
  const { cdp, spec, sleep, logger } = args;
  const label = kind === "effort" ? "推理等级" : "上下文窗口";
  if (!wanted) return;
  const hit = options.find((o) => optionMatches(o.label, wanted));
  if (!hit)
    throw new MinimaxModelSelectError(
      `模型子菜单里没有目标${label}「${wanted}」（可见=${candidatesOf(options)}）`,
      "model_mismatch",
    );
  if (hit.current) return;
  await cdp.clickMenuPoint(hit.point);
  // 点到收敛：读到目标值即返回；超时仍未收敛则如实报最后一次读数（不谎报成功）。
  const until = Date.now() + SUBMENU_SETTLE_TIMEOUT_MS;
  let now: { label?: string } | undefined;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(SUBMENU_SETTLE_POLL_MS);
    // eslint-disable-next-line no-await-in-loop
    const after = await readSubmenuOptions(cdp, spec, kind);
    now = after.find((o) => o.current);
    if (now && optionMatches(now.label ?? "", wanted)) break;
    if (Date.now() >= until) break;
  }
  if (!now || !optionMatches(now.label ?? "", wanted))
    throw new MinimaxModelSelectError(
      `${label}切换回读不一致：期望「${wanted}」，实际「${now?.label ?? "空"}」`,
      "model_mismatch",
    );
  logger.info(`[minimax] ${label}已切换并回读：${now.label}`);
}
