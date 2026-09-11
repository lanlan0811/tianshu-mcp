/**
 * Codex 任务运行判定（开发计划决策 7/8）。
 *
 * 设计（吸取 TraeWork 误判完成的教训）：
 * 1. 停止按钮为**权威运行信号**：出现即 running，绝不在此时判完成。
 * 2. 文本稳定只在**曾观测到运行信号**后才作为完成证据——避免停止钮选择器漂移时，
 *    把「其实还在生成、只是 DOM 恰好静止」误判为完成。
 * 3. 若始终未观测到运行信号（选择器未命中）→ 不判完成，转入空闲计时，最终 idle_timeout：
 *    结束本轮但**不终止实例**（失败开放，不比现状更糟）。
 */
import { createHash } from "node:crypto";

export interface CodexPoll {
  /** 权威运行信号：生成期间出现停止按钮 */
  stopVisible: boolean;
  /** 输入框当前文本 */
  composerText: string;
  /** 对话区文本（稳定兜底） */
  conversationText: string;
  /** 登录/引导页可见 */
  loginVisible: boolean;
  /** 发送按钮当前是否可见（输入非空时） */
  sendVisible?: boolean;
}

export interface CodexPollState {
  hash: string;
  stable: number;
  idleSince: number;
  /** 本轮是否曾观测到权威运行信号 */
  sawRunning: boolean;
}

export type CodexVerdict = {
  kind: "running" | "pending" | "finished" | "needs_login" | "idle_timeout";
  state: CodexPollState;
  evidence: string;
};

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export const initialCodexState = (): CodexPollState => ({
  hash: "",
  stable: 0,
  idleSince: 0,
  sawRunning: false,
});

export function judgeCodexPoll(
  poll: CodexPoll,
  previous: CodexPollState,
  stableRounds: number,
  idleTimeoutMs: number,
  now = Date.now(),
): CodexVerdict {
  const hash = hashText(poll.conversationText);

  if (poll.loginVisible)
    return {
      kind: "needs_login",
      state: { hash, stable: 0, idleSince: 0, sawRunning: previous.sawRunning },
      evidence: "login_indicator",
    };

  if (poll.stopVisible)
    return {
      kind: "running",
      state: { hash, stable: 0, idleSince: 0, sawRunning: true },
      evidence: "stop_button",
    };

  const sawRunning = previous.sawRunning;
  const stable =
    hash === previous.hash && poll.conversationText.trim() ? previous.stable + 1 : 0;
  const idleSince = stable >= stableRounds ? previous.idleSince || now : 0;

  // 权威完成：曾运行 → 停止钮消失 → 文本稳定
  if (sawRunning && stable >= stableRounds && poll.conversationText.trim())
    return { kind: "finished", state: { hash, stable, idleSince, sawRunning }, evidence: "stop_button_gone+text_stable" };

  // 失败开放：始终无运行信号 → 空闲超时（结束本轮、保留实例）
  if (idleSince && now - idleSince >= idleTimeoutMs)
    return { kind: "idle_timeout", state: { hash, stable, idleSince, sawRunning }, evidence: "no_running_signal+idle" };

  return { kind: "pending", state: { hash, stable, idleSince, sawRunning }, evidence: "none" };
}
