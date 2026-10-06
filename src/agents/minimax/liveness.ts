/**
 * MiniMax Code 任务运行判定（与 kimicode/liveness.ts 同构，判据按真机实测重排）。
 *
 * 真机实测决定的权威性排序（2026-10-05，MiniMax Code 3.1.0）：
 * 1. `[data-testid="stop-button"]` 是**权威运行信号**：生成期间出现，完成后消失。
 *    **待复验**：该 testid 来自产品产物 `app.asar` 的常量提取（真机发送后态因额度受限未采到），
 *    因此本判定对其缺失是**自适应降级**的——`stopVisible` 恒为 false 时自动落到
 *    信号 2/3（发送按钮双态 + 文本稳定），不会把「采不到停止按钮」误判成「已完成」。
 * 2. `send-button` 的 `aria-disabled` 双态是**次权威**信号：输入框有内容时 `aria-disabled=null`，
 *    发送后清空 → 回到 `"true"`。运行期间按钮处于「已发送」态。
 * 3. `[data-testid="message-list"]` 文本只作**稳定判定底料**，不单独判定。
 * 4. 失败态：界面出现失败文案（`请求失败` / `网络异常` / `HTTP 4xx` 等）。
 *    「重试按钮」选择器**未内置**（未真机验证），只在 profile 显式配置后才参与判定。
 *
 * 关键纪律（ZCode/TraeWork/Kimi Code 的教训）：
 * - 长思考期间文本可能长时间不变，但停止按钮/运行信号在 → 必须判 running 并**清零**稳定轮与空闲计时；
 * - 「文本静止 N 秒」永远不能单独作为完成判据，必须先达到 stableRounds 才开始空闲计时；
 * - 停止按钮恒可见且文本停滞超过 stallTimeoutMs → 判等待用户（打破「恒可见 → 恒 running」死锁）。
 */
import { createHash } from "node:crypto";

export interface MinimaxPoll {
  /** `[data-testid="stop-button"]` 可见 → 权威运行信号（产物提取，缺失时自动降级） */
  stopVisible: boolean;
  /** 发送按钮是否可见（不要求可用） */
  sendVisible?: boolean;
  /** 发送按钮是否处于禁用态（`aria-disabled="true"`） */
  sendDisabled?: boolean;
  /** 对话正文文本（稳定判定的底料） */
  assistantText: string;
  /**
   * 提问/等待用户：由 `detectQuestion` 从本轮可观测事实推导，**不是页面直接采集的字段**。
   */
  question?: string;
  /** 对话正文里的失败文案 */
  errorText?: string;
  /** profile 配置的重试按钮命中 → 失败态（未配置时恒 false） */
  retryVisible: boolean;
  /** `gui.selectors.userGate` 命中（配置了该选择器才可能为真） */
  userGateVisible?: boolean;
  /**
   * `question-dialog` / `questionnaire-composer` 命中（产物提取，未真机复验）。
   * **只作辅助证据**：needs_user 的主判据仍是 detectQuestion 的保守启发式。
   */
  questionVisible?: boolean;
  /** 页面忙碌横幅（产物提取）。**只作诊断**，不参与判定 */
  busyVisible?: boolean;
  inputText: string;
  sendEnabled: boolean;
  pageHidden: boolean;
}

export type MinimaxPollKind =
  | "running"
  | "finished"
  | "needs_user"
  | "idle_timeout"
  | "failed";

export interface MinimaxPollState {
  hash: string;
  stable: number;
  idleSince: number;
  /**
   * 本轮是否曾观测到权威运行信号（issue #31）。
   *
   * 文本稳定**只在曾观测到运行信号后**才作为完成证据——`stop-button` 选择器漂移时，
   * 界面会「看起来静止」而任务其实仍在进行；此时若仅凭 stableRounds 判完成，就会在
   * stableRounds × pollInterval（默认约 12s）后把进行中的任务误判成成功，直接进入验收/返修链。
   * 与 Codex 的 `sawRunning` 门对齐。
   *
   * 注意（本 driver 的特殊性）：`stopVisible` 依赖的 `[data-testid="stop-button"]` 来自产物常量
   * 提取、真机未复验（见文件头「待复验」）。若该 testid 实际不存在，本门会让 MiniMax
   * **每个任务**都收敛为 idle_timeout → 需人工介入（fail-closed：可 continue_task 恢复，
   * 远好于误判成功）。这是与 `hasRunSignal` 注释一致的「有意的慢而不错」。
   */
  sawRunning: boolean;
}

/** 停止按钮可见期间「文本最后一次变化」的时刻（0 = 未在计时）。可变对象由调用方跨轮持有。 */
export interface MinimaxStallSince {
  since: number;
}

export interface MinimaxVerdict {
  kind: MinimaxPollKind;
  state: MinimaxPollState;
  evidence: string;
  question?: string;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function initialMinimaxState(): MinimaxPollState {
  return { hash: "", stable: 0, idleSince: 0, sawRunning: false };
}

/** 末段提问文本的最大长度（只用于 pendingQuestion，防止把整篇回复当问题） */
const QUESTION_TAIL_CHARS = 1_200;

/**
 * 本轮是否存在「运行中」信号。
 *
 * 三信号的自适应降级（关键设计）：
 * - 信号 1（权威）：`stop-button` 可见。该 testid 来自产物提取、真机未复验，
 *   所以**不能**把它的缺失当成「已停止」；
 * - 信号 2（**本产品不成立**）：MiniMax Code 的发送按钮只有 `aria-disabled` 双态，
 *   而「输入框空」与「已发送待回复」都会让它禁用——两者无法从按钮本身区分，
 *   因此它**不构成**运行证据（Kimi Code 的 `is-starting` class 在实测中不存在对应物）。
 *   把它算作运行信号会让「发完就永远 running」；
 * - 信号 3（兜底）：文本稳定窗口。停止按钮选择器全部失效时，稳定轮 + 空闲计时仍能收敛本轮，
 *   只是收敛更慢（多等 stableRounds 轮）——这是有意的**慢而不错**。
 */
export function hasRunSignal(poll: MinimaxPoll): boolean {
  return poll.stopVisible;
}

/**
 * 提问检测（保守启发式）。
 *
 * **待真机验证**：MiniMax Code 向用户提问时的界面形态没有实测样本（账号额度受限），
 * 所以这里只依据**保守的可观测事实**，不写任何猜测型选择器：
 *   1. 无运行信号（`stop-button` 不可见）——生成中不可能是等待输入；
 *   2. 输入框为空（归一化后为空串）——输入框有内容说明用户正在写，别抢判；
 *   3. 有已知基线且本轮文本**已变化**（`previous.hash` 非空且与当前不同）——首轮无基线不判；
 *   4. 文本末尾以问句结尾（`?` / `？`）。
 *
 * 判据刻意保守：宁可漏判（退回 idle_timeout，实例保留可恢复）也不误判——误判会把正常完成的
 * 回复判成 needs_user，并在恢复时把用户确认文本当成回答发给模型。
 */
export function detectQuestion(
  poll: MinimaxPoll,
  previous: MinimaxPollState,
): string | undefined {
  if (hasRunSignal(poll)) return undefined;
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
  poll: MinimaxPoll,
  previous: MinimaxPollState,
  selectors: Record<string, string> = {},
): MinimaxPoll {
  if (poll.question?.trim()) return poll;
  if (!questionDetectionEnabled(selectors)) return poll;
  const question = detectQuestion(poll, previous);
  return question ? { ...poll, question } : poll;
}

export function judgeMinimaxPoll(
  poll: MinimaxPoll,
  previous: MinimaxPollState,
  stableRounds: number,
  idleTimeoutMs: number,
  stallTimeoutMs: number,
  stallSince: MinimaxStallSince,
  now = Date.now(),
): MinimaxVerdict {
  const evidence =
    [
      poll.stopVisible && "stop_button",
      poll.questionVisible && "question_dialog",
      poll.busyVisible && "busy_banner",
      poll.retryVisible && "retry_button",
      poll.errorText?.trim() && "error_text",
      poll.userGateVisible && "user_gate",
      poll.pageHidden && "page_hidden",
    ]
      .filter(Boolean)
      .join(",") || "none";
  const hash = hashText(poll.assistantText);

  // 1) 等待用户优先：配置的选择器命中（user_gate）或提问检测命中 —— 本轮不是「完成」而是暂停。
  if (poll.userGateVisible)
    return {
      kind: "needs_user",
      state: { hash, stable: 0, idleSince: 0, sawRunning: previous.sawRunning },
      evidence,
      question: poll.question?.trim(),
    };
  if (poll.question?.trim())
    return {
      kind: "needs_user",
      state: { hash, stable: 0, idleSince: 0, sawRunning: previous.sawRunning },
      evidence,
      question: poll.question.trim(),
    };

  // 2) 运行信号：停止按钮 —— 清零一切稳定/空闲计时，长思考不得被提前判完成。
  if (poll.stopVisible) {
    if (!previous.hash || hash !== previous.hash || !stallSince.since) stallSince.since = now;
    // 停止按钮恒可见 + 文本长期不变：继续等只会在任务总时限上耗尽，如实转 needs_user（可 continue 恢复）。
    if (now - stallSince.since >= stallTimeoutMs)
      return {
        kind: "needs_user",
        state: { hash, stable: 0, idleSince: 0, sawRunning: true },
        evidence: `${evidence}+stall`,
        question: `MiniMax Code 停止按钮持续可见且对话内容已停滞约 ${Math.round(stallTimeoutMs / 1000)}s：agent 可能在等待用户确认或长时间静默。请回到 MiniMax Code 窗口确认后调用 continue_task。`,
      };
    return { kind: "running", state: { hash, stable: 0, idleSince: 0, sawRunning: true }, evidence };
  }

  // 无运行信号：停滞计时作废。
  stallSince.since = 0;

  // 3) 失败态：界面明确给出失败文案或（配置的）重试按钮 —— 不得判完成。
  if (poll.retryVisible || poll.errorText?.trim())
    return {
      kind: "failed",
      state: { hash, stable: 0, idleSince: 0, sawRunning: previous.sawRunning },
      evidence,
    };

  // 4) 文本稳定累计；达到 stableRounds 才开始空闲计时，文本一变立刻清零。
  const sawRunning = previous.sawRunning;
  const stable = hash === previous.hash && poll.assistantText.trim() ? previous.stable + 1 : 0;
  const idleSince = stable >= stableRounds ? previous.idleSince || now : 0;
  if (idleSince && now - idleSince >= idleTimeoutMs)
    return { kind: "idle_timeout", state: { hash, stable, idleSince, sawRunning }, evidence };

  // 5) 无运行信号 + 文本稳定 ≥ stableRounds + 无错误 → 完成。
  //
  // issue #31：以上仅在**曾观测到运行信号**后成立。否则「文本静止」可能只是 stop-button
  // 选择器漂移造成的假象——此时不得判完成，只允许走上面的 idle_timeout。
  if (sawRunning && stable >= stableRounds && poll.assistantText.trim())
    return { kind: "finished", state: { hash, stable, idleSince, sawRunning }, evidence };

  return { kind: "running", state: { hash, stable, idleSince, sawRunning }, evidence };
}
