import { createHash } from "node:crypto";

export interface ZcodePoll {
  stopVisible: boolean;
  loading: boolean;
  activeTool: boolean;
  question?: string;
  assistantText: string;
  inputEnabled: boolean;
  sendEnabled: boolean;
}

export interface ZcodePollState {
  hash: string;
  stable: number;
  idleSince: number;
  /**
   * 本轮是否曾观测到权威运行信号（issue #31）。
   *
   * 文本稳定**只在曾观测到运行信号后**才作为完成证据——停止按钮/loading/工具调用选择器
   * 漂移时，界面会「看起来静止」而任务其实仍在进行；此时若仅凭 stableRounds 判完成，
   * 就会在 stableRounds × pollInterval（默认约 12s）后把进行中的任务误判成成功，
   * 直接进入验收/返修链。与 Codex 的 `sawRunning` 门对齐。
   */
  sawRunning: boolean;
}
export type ZcodeVerdict = {
  kind: "running" | "pending" | "finished" | "needs_user" | "idle_timeout";
  state: ZcodePollState;
  question?: string;
  evidence: string;
};

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function initialZcodeState(): ZcodePollState {
  return { hash: "", stable: 0, idleSince: 0, sawRunning: false };
}

export function judgeZcodePoll(
  poll: ZcodePoll,
  previous: ZcodePollState,
  stableRounds: number,
  idleTimeoutMs: number,
  now = Date.now(),
): ZcodeVerdict {
  const evidence =
    [
      poll.stopVisible && "stop_button",
      poll.loading && "loading_card",
      poll.activeTool && "active_tool",
    ]
      .filter(Boolean)
      .join(",") || "none";
  const hash = hashText(poll.assistantText);
  if (poll.question?.trim())
    return {
      kind: "needs_user",
      state: { hash, stable: 0, idleSince: 0, sawRunning: previous.sawRunning },
      question: poll.question.trim(),
      evidence,
    };
  if (poll.stopVisible || poll.loading || poll.activeTool)
    return {
      kind: "running",
      state: { hash, stable: 0, idleSince: 0, sawRunning: true },
      evidence,
    };
  const sawRunning = previous.sawRunning;
  const stable = hash === previous.hash && poll.assistantText.trim() ? previous.stable + 1 : 0;
  const idleSince = stable >= stableRounds ? previous.idleSince || now : 0;
  if (idleSince && now - idleSince >= idleTimeoutMs)
    return { kind: "idle_timeout", state: { hash, stable, idleSince, sawRunning }, evidence };
  // ZCode can finish without a textual badge: stable assistant reply + composer ready is authoritative.
  // ZCode disables the send button while the empty composer is ready.  The
  // editable composer itself, together with a stable assistant reply and no
  // running signal, is the authoritative completion evidence.
  //
  // issue #31：以上仅在**曾观测到运行信号**后成立。否则「界面静止」可能只是停止按钮/
  // loading 选择器漂移造成的假象——此时不得判完成，只允许走上面的 idle_timeout。
  if (sawRunning && stable >= stableRounds && poll.inputEnabled)
    return { kind: "finished", state: { hash, stable, idleSince, sawRunning }, evidence };
  return { kind: "pending", state: { hash, stable, idleSince, sawRunning }, evidence };
}
