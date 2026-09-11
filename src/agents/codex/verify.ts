/**
 * Codex 验收基座（开发计划决策 9/20）。
 *
 * 决策 9：以跑脚本/构建为准（客观可复现）。
 * 决策 20：读 package.json 的 scripts 自动推断 test/build/lint/typecheck。
 *
 * 本模块不重复实现验收执行：实际命令执行与报告产出复用既有 AcceptanceEngine
 * （src/verify/acceptance.ts，默认集已按项目技术栈推导）。这里只提供：
 *  - 对「默认集」的显式封装，供 Codex 流程判定是否为**弱验收**；
 *  - 由报告抽取失败证据，供修复计划与修复指令引用。
 */
import { deriveDefaultChecks } from "../../verify/acceptance.js";
import type { AcceptanceCheckDef } from "../../config/schema.js";
import type { VerifyReport } from "../../tasks/task.js";

export interface CodexVerifyBasis {
  checks: AcceptanceCheckDef[];
  notes: string[];
  /**
   * 弱验收：无任何 Node 脚本 / 构建命令可跑，只能做产物存在性等基础检查。
   * 此时验收结论的可信度较低，应在报告中显式标注。
   */
  weak: boolean;
}

/** 推导 Codex 任务默认验收基座（package.json 优先，非 Node 项目回退基础检查）。 */
export async function deriveCodexVerifyBasis(projectPath: string): Promise<CodexVerifyBasis> {
  const { checks, notes } = await deriveDefaultChecks(projectPath);
  const weak = checks.length === 0;
  return {
    checks,
    notes: weak ? [...notes, "未发现可执行验收命令：本轮为弱验收（仅基础检查）。"] : notes,
    weak,
  };
}

/** 由验收报告抽取失败证据文本（命令 + 退出码 + 输出尾部），供修复计划/指令引用。 */
export function extractFailureEvidence(report: VerifyReport, maxChars = 4000): string {
  const failed = report.checks.filter((c) => !c.passed && !c.skipped);
  if (failed.length === 0) return "";
  const lines: string[] = [];
  for (const c of failed) {
    lines.push(`$ ${c.cmd}`);
    lines.push(`  exit=${c.exitCode ?? "n/a"}${c.timeout ? " (timeout)" : ""} duration=${c.durationMs}ms`);
    const tail = (c.outputTail || "").trim();
    if (tail) lines.push(tail.slice(-1200));
    lines.push("");
  }
  return lines.join("\n").slice(0, maxChars);
}

/** 报告是否可在无人值守下判定为「通过」（optional 失败不影响结论） */
export function isVerifiedPass(report: VerifyReport): boolean {
  return report.checks.every((c) => c.passed || c.skipped || c.optional);
}
