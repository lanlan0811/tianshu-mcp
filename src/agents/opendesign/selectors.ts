/**
 * Open Design 控件的 DOM 选择器与页面内表达式。
 *
 * **当前状态（P0，2026-09-25）**：全部为空占位。
 * Open Design 是打包过的 React 应用（无源码可读），选择器必须**真机采集**——
 * 按截图肉眼估出来的坐标/类名会在第一次 UI 升级时静默漂移，这正是 issue #23 踩过的坑。
 * 采集方式：`scripts/probe-opendesign.mjs`（连接受管实例后盘点候选锚点），
 * 采到的结果写回本文件，并同步 `docs/opendesign-cdp.md`。
 *
 * `isEmpty-selectors 门禁`：`run.ts` 在任何点击之前检查关键键是否齐全，
 * 未采集完就派活会直接硬失败 `selector_drift`，而不是盲点一气。
 */

/** 选择器清单键（覆盖 12 步流程需要的全部锚点） */
export type OpenDesignSelectorKey =
  | "composer"
  | "inputBox"
  | "workingDirTrigger"
  | "selectDirItem"
  | "recentDirItem"
  | "workingDirValue"
  | "modelTrigger"
  | "modelMenuItem"
  | "designSystemTrigger"
  | "designSystemSearch"
  | "designSystemItem"
  | "designDirectionTrigger"
  | "designDirectionItem"
  | "sendButton"
  | "stopButton"
  | "conversationText"
  | "openDesignTitle";

/**
 * 关键锚点：**缺任何一个**都不得开始点击（布局守卫）。
 * 这些键对应「必须先看见才能操作」的位置，缺一个就说明页面结构变了或还没渲染完。
 */
export const OPEN_DESIGN_REQUIRED_SELECTORS: readonly OpenDesignSelectorKey[] = [
  "openDesignTitle",
  "composer",
  "inputBox",
  "workingDirTrigger",
  "sendButton",
];

/** 内置选择器（P1 真机采集后填写；profile.gui.selectors 可按键覆盖） */
export const OPEN_DESIGN_SELECTORS: Partial<Record<OpenDesignSelectorKey, string>> = {};

/**
 * 缺哪些关键选择器。返回空数组 = 可以开始操作。
 * 由 `run.ts` 在连接后立即调用（软门禁），避免 P0 阶段被误当成「能派活」。
 */
export function missingRequiredSelectors(
  selectors: Record<string, string>,
): OpenDesignSelectorKey[] {
  return OPEN_DESIGN_REQUIRED_SELECTORS.filter((key) => {
    const value = selectors[key];
    return !value || !value.trim();
  });
}
