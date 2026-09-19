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
 * - 停止按钮恒可见且文本停滞超过 stallTimeoutMs → 判等待用户（打破「恒可见 → 恒 running」死锁）。
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
   * 提问/等待用户（M4 补齐：本轮填不出就不判 needs_user）。
   * 保留字段是为了让 needs_user 分支与判定优先级先落地，M4 只补采集。
   */
  question?: string;
  /** panes 内失败文案（「模型请求失败」「provider.auth_error」等） */
  errorText?: string;
  /** `button.ui-button--secondary`（「继续」）可见 → 失败态 */
  retryVisible: boolean;
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
      poll.pageHidden && "page_hidden",
    ]
      .filter(Boolean)
      .join(",") || "none";
  const hash = hashText(poll.assistantText);

  // 1) 等待用户优先：提问/确认卡片一旦命中，本轮不是「完成」而是暂停。
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