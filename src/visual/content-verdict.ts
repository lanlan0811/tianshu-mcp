/**
 * 内容判定防抖的纯函数核心（issue #13 计划 §4.4）：
 * 多次采样多数投票 + 可选置信度闸门。零 IO，便于穷举单测。
 */
import type { ContentVote } from "./types.js";

export type ContentTallyCode = "CONTENT_MATCH" | "CONTENT_MISMATCH" | "CONTENT_UNCERTAIN";
export type ContentTallyStatus = "passed" | "failed" | "uncertain";

export interface ContentTally {
  code: ContentTallyCode;
  status: ContentTallyStatus;
  /** 已给出置信度的投票的算术均值（3 位小数）；命令不报置信度则为 undefined，不参与任何闸门 */
  confidence?: number;
  /** 多数票一方的首个理由（命令语言原样透传）；不确定时为 MCP 自身的票型说明 */
  reason: string;
  passedVotes: number;
  failedVotes: number;
  /** 未能给出有效判定（passed 缺省）的采样数 */
  invalidVotes: number;
  /**
   * 置信度闸门状态：
   * - off：未配置 minConfidence
   * - applied：已配置且均值达标（或本就不确定）
   * - downgraded：已配置且均值低于阈值 → 降级为不确定
   * - no-confidence：已配置但命令未提供 confidence，闸门未生效（须在报告中可见）
   */
  confidenceGate: "off" | "applied" | "downgraded" | "no-confidence";
}

export function tallyContentVotes(input: {
  votes: ContentVote[];
  samples: number;
  minConfidence?: number;
}): ContentTally {
  const { votes, samples, minConfidence } = input;
  const passedVotes = votes.filter((v) => v.passed === true).length;
  const failedVotes = votes.filter((v) => v.passed === false).length;
  const invalidVotes = votes.length - passedVotes - failedVotes;
  const withConfidence = votes.filter((v) => typeof v.confidence === "number");
  const confidence = withConfidence.length
    ? Number(
        (
          withConfidence.reduce((sum, v) => sum + (v.confidence as number), 0) /
          withConfidence.length
        ).toFixed(3),
      )
    : undefined;
  const firstReason = (side: boolean): string | undefined =>
    votes.find((v) => v.passed === side)?.reason;

  let code: ContentTallyCode;
  let status: ContentTallyStatus;
  let reason: string;
  if (passedVotes > samples / 2) {
    code = "CONTENT_MATCH";
    status = "passed";
    reason = firstReason(true) ?? "Majority of samples satisfied the expectation";
  } else if (failedVotes > samples / 2) {
    code = "CONTENT_MISMATCH";
    status = "failed";
    reason = firstReason(false) ?? "Majority of samples did not satisfy the expectation";
  } else {
    code = "CONTENT_UNCERTAIN";
    status = "uncertain";
    reason = `Votes are not conclusive: ${passedVotes} passed, ${failedVotes} failed, ${invalidVotes} undecided out of ${samples} samples`;
  }

  let confidenceGate: ContentTally["confidenceGate"] = "off";
  if (minConfidence !== undefined) {
    if (confidence === undefined) {
      confidenceGate = "no-confidence";
    } else if (confidence < minConfidence) {
      confidenceGate = "downgraded";
      if (status !== "uncertain") {
        code = "CONTENT_UNCERTAIN";
        status = "uncertain";
        reason = `${reason} (mean confidence ${confidence} below configured ${minConfidence})`;
      }
    } else {
      confidenceGate = "applied";
    }
  }
  return {
    code,
    status,
    ...(confidence !== undefined ? { confidence } : {}),
    reason,
    passedVotes,
    failedVotes,
    invalidVotes,
    confidenceGate,
  };
}
