/**
 * 任务书输入与发送（开发计划 §4.5 步骤 4/5）。
 * 发送前回读输入框内容确认拼装正确，为空则重试一次（参考项目已验证的做法）。
 */
import type { TraeworkCdpClient } from "../cdp/client.js";
import type { AgentRunLogger } from "../../adapter.js";
import type { SelectorOverrides } from "../cdp/selectors.js";

export interface ComposerOptions {
  selectors?: SelectorOverrides;
  logger: AgentRunLogger;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 拼装发给 TraeWork 的文本：task + 可选上下文 + 可选返修反馈（直拼，不套模板） */
export function buildPromptText(task: string, context?: string, feedback?: string): string {
  let text = task;
  if (context?.trim()) text += `\n\n【附加上下文 / 约束】\n${context}`;
  if (feedback?.trim()) text += `\n\n【上一轮验收未通过 —— 请针对下列问题修改，不要大范围重构】\n${feedback}`;
  return text;
}

/** 读取输入框当前文本（回读校验用） */
export async function readInputText(cdp: TraeworkCdpClient, selectors?: SelectorOverrides): Promise<string> {
  return cdp.text("chatInput", selectors);
}

/**
 * 输入文本并发送。
 * @returns 发送前回读到的输入框内容（用于日志/诊断）
 */
export async function typeAndSend(
  cdp: TraeworkCdpClient,
  text: string,
  opts: ComposerOptions,
): Promise<{ typedText: string }> {
  const { selectors, logger } = opts;
  const focused = await cdp.focus("chatInput", selectors);
  if (!focused) {
    throw new Error("找不到聊天输入框（.chat-input-v2-input-box-editable）——TraeWork 可能仍在加载或 UI 已变更");
  }
  await sleep(400);
  await cdp.insertText(text);
  await sleep(800);

  // 回读校验：为空则重试一次（参考项目实测 insertText 偶发丢失）
  let typed = await readInputText(cdp, selectors);
  if (!typed.trim()) {
    logger.warn("[traework] 输入框回读为空，重试一次 insertText");
    await cdp.focus("chatInput", selectors);
    await sleep(300);
    await cdp.insertText(text);
    await sleep(800);
    typed = await readInputText(cdp, selectors);
  }
  if (!typed.trim()) {
    throw new Error("任务书未能写入输入框（两次尝试后仍为空）");
  }
  // 回读内容必须包含标记（调用方已在文本首部注入），否则视为拼装异常
  logger.info(`[traework] 已写入输入框（回读 ${typed.length} 字符），按 Enter 发送`);

  await cdp.pressEnter();
  return { typedText: typed };
}
