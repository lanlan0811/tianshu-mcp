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
      state: { hash, stable: 0, idleSince: 0 },
      question: poll.question.trim(),
      evidence,
    };
  if (poll.stopVisible || poll.loading || poll.activeTool)
    return { kind: "running", state: { hash, stable: 0, idleSince: 0 }, evidence };
  const stable = hash === previous.hash && poll.assistantText.trim() ? previous.stable + 1 : 0;
  const idleSince = stable >= stableRounds ? previous.idleSince || now : 0;
  if (idleSince && now - idleSince >= idleTimeoutMs)
    return { kind: "idle_timeout", state: { hash, stable, idleSince }, evidence };
  // ZCode can finish without a textual badge: stable assistant reply + composer ready is authoritative.
  // ZCode disables the send button while the empty composer is ready.  The
  // editable composer itself, together with a stable assistant reply and no
  // running signal, is the authoritative completion evidence.
  if (stable >= stableRounds && poll.inputEnabled)
    return { kind: "finished", state: { hash, stable, idleSince }, evidence };
  return { kind: "pending", state: { hash, stable, idleSince }, evidence };
}
