/**
 * Kimi Code 任务运行判定（与 zcode/liveness.ts 同构，判据按真机实测重排）。
 *
 * 真机实测（2026-09-20，Kimi Code 1.0.2）决定的权威性排序：
 * 1. `button.stop`（aria-label「中断」）是**权威运行信号**：发送后 0.5–1.2s 出现，完成后消失；
 * 2. `button.send` 的 class 含 `is-starting` 是**次权威**信号，与停止按钮同现；
 * 3. `div.panes` 文本（「思考中…」「工作中…」）只作诊断/稳定判定，不单独判定；
 * 4. 失败态：出现「继续」按钮（`button.ui-button--secondary`）或 panes 内出现
 *    「模型请求失败」/`provider.auth_error` 等文案——**绝不能判完成**。
 *
 * 关键纪律（ZCode/TraeWork 的教训）：
 * - 长思考期间文本可能长时间不变，但停止按钮在 → 必须判 running 并**清零**稳定轮与空闲计时；
 * - 「文本静止 N 秒」永远不能单独作为完成判据，必须先达到 stableRounds 才开始空闲计时；
 * - 停止按钮恒可见且文本停滞超过 stallTimeoutMs → 判等待用户（打破「恒可见 → 恒 running」死锁）；
 * - M4：等待用户（`userGateVisible` / `detectQuestion`）优先于一切完成判定；提问检测的保守判据
 *   与「未配置 userGate 即关闭」见 detectQuestion / questionDetectionEnabled。
 */
import { createHash } from "node:crypto";

export interface KimicodePoll {
  /** `button.stop` 可见 → 权威运行信号 */
  stopVisible: boolean;
  /** `button.send` class 含 `is-starting` → 次权威运行信号 */
  sendStarting: boolean;
  /** `div.panes` 文本（稳定判定的底料） */
  assistantText: string;
  /**
   * 提问/等待用户（M4）：由 `detectQuestion` 从本轮可观测事实推导，**不是页面直接采集的字段**。
   * 保留在 poll 上是为了让 needs_user 分支与判定优先级先落地（M3 起就有该接缝）。
   */
  question?: string;
  /** panes 内失败文案（「模型请求失败」「provider.auth_error」等） */
  errorText?: string;
  /** `button.ui-button--secondary`（「继续」）可见 → 失败态 */
  retryVisible: boolean;
  /**
   * `gui.selectors.userGate` 命中（配置了该选择器才可能为真）。
   * 与 codex 的既有做法一致：**默认禁用**，只有 profile 显式配置后才参与判定。
   */
  userGateVisible?: boolean;
  inputText: string;
  sendEnabled: boolean;
  pageHidden: boolean;
}

export type KimicodePollKind = "running" | "finished" | "needs_user" | "idle_timeout" | "failed";

export interface KimicodePollState {
  hash: string;
  stable: number;
  idleSince: number;
}

/** 停止按钮可见期间「文本最后一次变化」的时刻（0 = 未在计时）。可变对象由调用方跨轮持有。 */
export interface KimicodeStallSince {
  since: number;
}

export interface KimicodeVerdict {
  kind: KimicodePollKind;
  state: KimicodePollState;
  evidence: string;
  question?: string;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function initialKimicodeState(): KimicodePollState {
  return { hash: "", stable: 0, idleSince: 0 };
}

/** 末段提问文本的最大长度（只用于 pendingQuestion，防止把整篇回复当问题） */
const QUESTION_TAIL_CHARS = 1_200;

/**
 * 提问检测（M4）。
 *
 * **待真机验证**：Kimi Code 向用户提问时的界面形态没有实测样本（账号额度受限，无法造出提问场景），
 * 所以这里只依据**保守的可观测事实**，不写任何猜测型选择器：
 *   1. 无运行信号（`button.stop` 不可见、`send` 未 `is-starting`）——生成中不可能是等待输入；
 *   2. 输入框为空（归一化后为空串）——输入框有内容说明用户正在写，别抢判；
 *   3. 有已知基线且本轮文本**已变化**（`previous.hash` 非空且与当前不同）——首轮无基线不判，
 *      文本没变化也不判（避免把同一段问句反复判成新提问）；
 *   4. panes 末尾文本以问句结尾（`?` / `？`）。
 *
 * 判据刻意保守：宁可漏判（退回 idle_timeout，实例保留可恢复）也不误判——误判会把正常完成的
 * 回复判成 needs_user，并在恢复时把用户确认文本当成回答发给模型。
 * `gui.selectors.userGate` 未配置时，本检测默认**关闭**（见 `questionDetectionEnabled`）；
 * 配置了该选择器时，等待用户由选择器命中直接判定，本启发式不再参与（避免双重判据互相打架）。
 */
export function detectQuestion(
  poll: KimicodePoll,
  previous: KimicodePollState,
): string | undefined {
  if (poll.stopVisible || poll.sendStarting) return undefined;
  if (poll.inputText.normalize("NFKC").trim()) return undefined;
  if (!previous.hash || hashText(poll.assistantText) === previous.hash) return undefined;
  const tail = poll.assistantText.trim().slice(-QUESTION_TAIL_CHARS).trim();
  if (!/[?？]\s*$/.test(tail)) return undefined;
  return tail;
}

/** 是否启用启发式提问检测：只有 profile 显式配置了 gui.selectors.userGate 才启用 */
export function questionDetectionEnabled(selectors: Record<string, string> = {}): boolean {
  return Boolean(selectors.userGate?.trim());
}

/**
 * 把提问检测接到本轮 poll 上（调用方在 judge 之前调用）。
 * 未配置 `gui.selectors.userGate` 时不启用启发式检测 —— 这样「未配置 → 不判 agent_question」
 * 是默认行为，stall 兜底与 idle_timeout 仍能收敛本轮。
 */
export function withDetectedQuestion(
  poll: KimicodePoll,
  previous: KimicodePollState,
  selectors: Record<string, string> = {},
): KimicodePoll {
  if (poll.question?.trim()) return poll;
  if (!questionDetectionEnabled(selectors)) return poll;
  const question = detectQuestion(poll, previous);
  return question ? { ...poll, question } : poll;
}

export function judgeKimicodePoll(
  poll: KimicodePoll,
  previous: KimicodePollState,
  stableRounds: number,
  idleTimeoutMs: number,
  stallTimeoutMs: number,
  stallSince: KimicodeStallSince,
  now = Date.now(),
): KimicodeVerdict {
  const evidence =
    [
      poll.stopVisible && "stop_button",
      poll.sendStarting && "send_starting",
      poll.retryVisible && "retry_button",
      poll.errorText?.trim() && "error_text",
      poll.userGateVisible && "user_gate",
      poll.pageHidden && "page_hidden",
    ]
      .filter(Boolean)
      .join(",") || "none";
  const hash = hashText(poll.assistantText);

  // 1) 等待用户优先：配置的选择器命中（user_gate）或提问检测命中 —— 本轮不是「完成」而是暂停。
  //    配置了 userGate 时，等待用户一律由它判定，question 仅作问题原文补充。
  if (poll.userGateVisible)
    return {
      kind: "needs_user",
      state: { hash, stable: 0, idleSince: 0 },
      evidence,
      question: poll.question?.trim(),
    };
  if (poll.question?.trim())
    return {
      kind: "needs_user",
      state: { hash, stable: 0, idleSince: 0 },
      evidence,
      question: poll.question.trim(),
    };

  // 2/5) 运行信号：停止按钮或发送中 —— 清零一切稳定/空闲计时，长思考不得被提前判完成。
  if (poll.stopVisible || poll.sendStarting) {
    if (!previous.hash || hash !== previous.hash || !stallSince.since) stallSince.since = now;
    // 停止按钮恒可见 + 文本长期不变：继续等只会在任务总时限上耗尽，如实转 needs_user（可 continue 恢复）。
    if (poll.stopVisible && now - stallSince.since >= stallTimeoutMs)
      return {
        kind: "needs_user",
        state: { hash, stable: 0, idleSince: 0 },
        evidence: `${evidence}+stall`,
        question: `Kimi Code 停止按钮持续可见且对话内容已停滞约 ${Math.round(stallTimeoutMs / 1000)}s：agent 可能在等待用户确认或长时间静默。请回到 Kimi Code 窗口确认后调用 continue_task。`,
      };
    return { kind: "running", state: { hash, stable: 0, idleSince: 0 }, evidence };
  }

  // 无运行信号：停滞计时作废。
  stallSince.since = 0;

  // 3) 失败态：界面明确给出「继续」按钮或失败文案 —— 不得判完成。
  if (poll.retryVisible || poll.errorText?.trim())
    return { kind: "failed", state: { hash, stable: 0, idleSince: 0 }, evidence };

  // 4) 文本稳定累计；达到 stableRounds 才开始空闲计时，文本一变立刻清零。
  const stable = hash === previous.hash && poll.assistantText.trim() ? previous.stable + 1 : 0;
  const idleSince = stable >= stableRounds ? previous.idleSince || now : 0;
  if (idleSince && now - idleSince >= idleTimeoutMs)
    return { kind: "idle_timeout", state: { hash, stable, idleSince }, evidence };

  // 6) 无运行信号 + 文本稳定 ≥ stableRounds + 无错误 → 完成。
  if (stable >= stableRounds && poll.assistantText.trim())
    return { kind: "finished", state: { hash, stable, idleSince }, evidence };

  return { kind: "running", state: { hash, stable, idleSince }, evidence };
}