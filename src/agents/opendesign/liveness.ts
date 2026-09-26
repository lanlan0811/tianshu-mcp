/**
 * Open Design 的运行检测（三信号）——纯函数，与 `kimicode/liveness.ts` 同构但多一路信号。
 *
 * 三路信号及各自职责（计划 P5）：
 * 1. **停止按钮可见性**：运行中的权威信号。可见 = 仍在跑（长思考不得被提前判完成）。
 * 2. **对话文本哈希**：判断「内容是否真的停下来了」。
 * 3. **产物文件 mtime/大小指纹**：Open Design 生成设计稿时会**长时间不刷对话**却持续写文件
 *    （与 Kimi Code 的纯对话形态不同）。只看文本会把这类正常工作判成「空闲完成」，
 *    所以在文本稳定的基础上**还要**产物指纹也稳定，才算真正静止。
 *
 * 判定优先级（刻意保守，宁可漏判也不误判）：
 * 运行信号 → 失败态 → needs_user（停止久亮且全静止 / 提问）→ 静止达标 → finished → timeout。
 */
import { createHash } from "node:crypto";

/** 单次轮询的快照（由 `cdp.ts` 采集后传入纯函数判定） */
export interface OpenDesignPoll {
  /** 停止按钮是否可见（权威运行信号） */
  stopVisible: boolean;
  /** 发送按钮是否处于「已提交/启动中」形态（弱信号，可选） */
  sendStarting?: boolean;
  /** 对话正文全文 */
  conversationText: string;
  /** 输入框当前文本（非空说明用户正在写，此时不抢判提问） */
  inputText?: string;
  /** 界面明确给出的失败文案（可选） */
  errorText?: string;
  /**
   * 产物指纹：受监视文件的 `路径:大小:mtimeMs` 串接后由调用方传入。
   * 空串 = 本任务不监视产物（则退化为「仅文本稳定」判据）。
   */
  artifactSignature?: string;
  /** 窗口是否不在前台（合成点击可能被节流；仅诊断） */
  pageHidden?: boolean;
}

export interface OpenDesignPollState {
  /** 上一轮「文本 + 产物」综合指纹 */
  hash: string;
  /** 连续稳定的轮数 */
  stable: number;
  /** 空闲计时起点（0 = 未开始计时） */
  idleSince: number;
}

export type OpenDesignPollKind =
  "running" | "finished" | "needs_user" | "idle_timeout" | "failed" | "timeout";

export interface OpenDesignStallSince {
  since: number;
}

export interface OpenDesignVerdict {
  kind: OpenDesignPollKind;
  state: OpenDesignPollState;
  evidence: string;
  question?: string;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** 综合指纹：文本 + 产物（产物为空时退化为纯文本，语义与既往一致） */
export function pollFingerprint(poll: OpenDesignPoll): string {
  const artifact = poll.artifactSignature?.trim() ? poll.artifactSignature.trim() : "";
  return hashText(`${hashText(poll.conversationText)}|${artifact}`);
}

export function initialOpenDesignState(): OpenDesignPollState {
  return { hash: "", stable: 0, idleSince: 0 };
}

/** 末段提问文本的最大长度（只用于 pendingQuestion，防止把整篇回复当问题） */
const QUESTION_TAIL_CHARS = 1_200;

/**
 * 提问检测（保守启发式）。
 *
 * 与 Kimi Code 同一取舍：**宁可漏判**（退回 idle_timeout，实例保留可继续观察）也不误判——
 * 误判会把正常完成的回复判成 needs_user，并在恢复时把用户输入当成回答发出去。
 * 因此要求四条同时成立：无运行信号、输入框为空、文本相对上一轮**已变化**、末尾以问号结尾。
 */
export function detectQuestion(
  poll: OpenDesignPoll,
  previous: OpenDesignPollState,
): string | undefined {
  if (poll.stopVisible || poll.sendStarting) return undefined;
  if ((poll.inputText ?? "").normalize("NFKC").trim()) return undefined;
  if (!previous.hash || pollFingerprint(poll) === previous.hash) return undefined;
  const tail = poll.conversationText.trim().slice(-QUESTION_TAIL_CHARS).trim();
  if (!/[?？]\s*$/.test(tail)) return undefined;
  return tail;
}

/** 综合证据串（终态文案与日志都用它说明「凭什么这么判」） */
export function evidenceOf(poll: OpenDesignPoll): string {
  return (
    [
      poll.stopVisible && "stop_button",
      poll.sendStarting && "send_starting",
      poll.errorText?.trim() && "error_text",
      poll.artifactSignature?.trim() && "artifact",
      poll.pageHidden && "page_hidden",
    ]
      .filter(Boolean)
      .join(",") || "none"
  );
}

/**
 * 运行检测主判定。
 *
 * @param stableRounds 文本/产物连续稳定多少轮后才开始空闲计时
 * @param idleTimeoutMs 静止持续多久算空闲结束
 * @param stallTimeoutMs 停止按钮久亮且全静止多久后转 needs_user（打破「恒 running」死锁）
 * @param taskDeadline 任务总时限（绝对时间戳；到点判 timeout）——避免无限等待
 */
export function judgeOpenDesignPoll(
  poll: OpenDesignPoll,
  previous: OpenDesignPollState,
  stableRounds: number,
  idleTimeoutMs: number,
  stallTimeoutMs: number,
  stallSince: OpenDesignStallSince,
  now = Date.now(),
  taskDeadline = Infinity,
): OpenDesignVerdict {
  const evidence = evidenceOf(poll);
  const hash = pollFingerprint(poll);

  // 1) 运行信号：停止按钮可见 / 启动中 —— 清零稳定与空闲计时（长思考不得被判完成）
  if (poll.stopVisible || poll.sendStarting) {
    if (!previous.hash || hash !== previous.hash || !stallSince.since) stallSince.since = now;
    // 停止按钮恒亮 + 文本与产物全静止 → 很可能在等人（或已卡死）。转 needs_user 可 continue 恢复。
    if (poll.stopVisible && now - stallSince.since >= stallTimeoutMs) {
      const question = detectQuestion(poll, previous);
      return {
        kind: "needs_user",
        state: { hash, stable: 0, idleSince: 0 },
        evidence: `${evidence}+stall`,
        question:
          question ??
          `Open Design 停止按钮持续可见且对话与产物均已停滞约 ${Math.round(stallTimeoutMs / 1000)}s：` +
            `agent 可能在等待用户确认或长时间静默。请回到 Open Design 窗口确认后调用 continue_task。`,
      };
    }
    return { kind: "running", state: { hash, stable: 0, idleSince: 0 }, evidence };
  }

  // 无运行信号：停滞计时作废
  stallSince.since = 0;

  // 2) 失败态：界面明确给出失败文案 —— 不得判完成
  if (poll.errorText?.trim())
    return { kind: "failed", state: { hash, stable: 0, idleSince: 0 }, evidence };

  // 3) 提问（无运行信号 + 文本刚变化 + 空输入框 + 问号结尾）→ 本轮是「暂停」而非「完成」
  const question = detectQuestion(poll, previous);
  if (question)
    return { kind: "needs_user", state: { hash, stable: 0, idleSince: 0 }, evidence, question };

  // 4) 文本 + 产物双稳定累计；任一变即清零
  const stable = hash === previous.hash && poll.conversationText.trim() ? previous.stable + 1 : 0;
  const idleSince = stable >= stableRounds ? previous.idleSince || now : 0;

  // 5) 任务总时限到点：如实判 timeout（与其他 agent 的 taskTimeoutMs 语义一致）
  if (now >= taskDeadline)
    return {
      kind: "timeout",
      state: { hash, stable, idleSince },
      evidence: `${evidence}+deadline`,
    };

  if (idleSince && now - idleSince >= idleTimeoutMs)
    return { kind: "idle_timeout", state: { hash, stable, idleSince }, evidence };

  // 6) 无运行信号 + 双稳定 ≥ stableRounds + 无错误 → 完成
  if (stable >= stableRounds && poll.conversationText.trim())
    return { kind: "finished", state: { hash, stable, idleSince }, evidence };

  return { kind: "running", state: { hash, stable, idleSince }, evidence };
}

/**
 * 产物指纹：把受监视文件的 `相对路径:大小:mtimeMs` 排序串接。
 * 由调用方提供 stat 结果（保持纯函数可测，不在判定层碰文件系统）。
 */
export function artifactSignatureOf(
  files: Array<{ path: string; size: number; mtimeMs: number }>,
): string {
  return files
    .map((f) => `${f.path}:${f.size}:${Math.trunc(f.mtimeMs)}`)
    .sort()
    .join("|");
}
