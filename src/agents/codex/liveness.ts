/**
 * Codex 任务运行判定（开发计划决策 7/8；issue #5 修复后含 stall 判定）。
 *
 * 设计（吸取 TraeWork 误判完成的教训）：
 * 1. 停止按钮为**权威运行信号**：出现即 running，绝不在此时判完成。
 * 2. 文本稳定只在**曾观测到运行信号**后才作为完成证据——避免停止钮选择器漂移时，
 *    把「其实还在生成、只是 DOM 恰好静止」误判为完成。
 * 3. 若始终未观测到运行信号（选择器未命中）→ 不判完成，转入空闲计时，最终 idle_timeout：
 *    结束本轮但**不终止实例**（失败开放，不比现状更糟）。
 * 4. 等待用户判定（issue #5）：「方案确认卡/订阅结账页」等场景下 turn 是暂停而非结束，
 *    停止按钮恒可见 → 上面的规则会死锁。两条出路：
 *    - userGateVisible：profile.gui.selectors.userGate 配置的界面检测（快速路径）；
 *    - stall 兜底：停止按钮持续可见且对话哈希 stallTimeoutMs 不变 → needs_user。
 *      它无法区分「等用户确认」与「长时间静默的合法长命令」，误判后果是转
 *      needs_user（非终态、可 continue 恢复），远好于死等总超时；长命令任务
 *      应调大 gui.stallTimeoutMs。
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
  /** 「等待用户」界面检测命中（gui.selectors.userGate 配置后启用） */
  userGateVisible?: boolean;
}

export interface CodexPollState {
  hash: string;
  stable: number;
  idleSince: number;
  /** 本轮是否曾观测到权威运行信号 */
  sawRunning: boolean;
  /** 停止按钮可见且对话哈希不变的起始时刻（0 = 未在计时） */
  stallSince: number;
}

export type CodexVerdict = {
  kind: "running" | "pending" | "finished" | "needs_login" | "needs_user" | "idle_timeout";
  state: CodexPollState;
  evidence: string;
};

/** 与 GuiProfileSchema.stallTimeoutMs 默认一致；仅供直调兜底，生产路径由 codexGuiOf 传入 */
export const DEFAULT_STALL_TIMEOUT_MS = 300_000;

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export const initialCodexState = (): CodexPollState => ({
  hash: "",
  stable: 0,
  idleSince: 0,
  sawRunning: false,
  stallSince: 0,
});

export function judgeCodexPoll(
  poll: CodexPoll,
  previous: CodexPollState,
  stableRounds: number,
  idleTimeoutMs: number,
  now = Date.now(),
  stallTimeoutMs: number = DEFAULT_STALL_TIMEOUT_MS,
): CodexVerdict {
  const hash = hashText(poll.conversationText);

  if (poll.loginVisible)
    return {
      kind: "needs_login",
      state: { hash, stable: 0, idleSince: 0, sawRunning: previous.sawRunning, stallSince: 0 },
      evidence: "login_indicator",
    };

  // 等待用户快速路径：界面检测命中（如结账页/确认卡，选择器可配置）
  if (poll.userGateVisible)
    return {
      kind: "needs_user",
      state: { hash, stable: 0, idleSince: 0, sawRunning: previous.sawRunning, stallSince: 0 },
      evidence: "user_gate",
    };

  if (poll.stopVisible) {
    // stall 兜底（issue #5）：停止按钮恒可见时对话哈希长时间不变 → 判定等待用户。
    const hashUnchanged = hash === previous.hash;
    const stallSince = hashUnchanged ? previous.stallSince || now : now;
    if (hashUnchanged && previous.stallSince && now - previous.stallSince >= stallTimeoutMs)
      return {
        kind: "needs_user",
        state: { hash, stable: 0, idleSince: 0, sawRunning: true, stallSince },
        evidence: "stop_button+stall",
      };
    return {
      kind: "running",
      state: { hash, stable: 0, idleSince: 0, sawRunning: true, stallSince },
      evidence: "stop_button",
    };
  }

  const sawRunning = previous.sawRunning;
  const stable =
    hash === previous.hash && poll.conversationText.trim() ? previous.stable + 1 : 0;
  const idleSince = stable >= stableRounds ? previous.idleSince || now : 0;

  // 权威完成：曾运行 → 停止钮消失 → 文本稳定
  if (sawRunning && stable >= stableRounds && poll.conversationText.trim())
    return {
      kind: "finished",
      state: { hash, stable, idleSince, sawRunning, stallSince: 0 },
      evidence: "stop_button_gone+text_stable",
    };

  // 失败开放：始终无运行信号 → 空闲超时（结束本轮、保留实例）
  if (idleSince && now - idleSince >= idleTimeoutMs)
    return {
      kind: "idle_timeout",
      state: { hash, stable, idleSince, sawRunning, stallSince: 0 },
      evidence: "no_running_signal+idle",
    };

  return { kind: "pending", state: { hash, stable, idleSince, sawRunning, stallSince: 0 }, evidence: "none" };
}
