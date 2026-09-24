/**
 * Codex 提示词拼装（开发计划决策 13：planDoc / designSystem 由任务参数显式传入）。
 * 同时提供修复指令模板（决策 11/12：修复计划文档由 MCP 自动生成并固定命名）。
 */
import path from "node:path";
import type { ValidatedReference } from "../zcode/references.js";
import { renderDirectiveLines, type RepairDirectives } from "../../verify/directives.js";

export interface InitialPromptInput {
  task: string;
  context?: string;
  /** 计划文档路径（相对项目根或绝对） */
  planDoc?: string;
  /** 设计系统目录路径（相对项目根或绝对） */
  designSystem?: string;
  /** 已校验的项目内引用（供正文补充绝对路径） */
  refs?: ValidatedReference[];
  /** 返修轮：以上一轮验收反馈替代原始任务书 */
  feedback?: string;
}

/** 修复计划文档文件名（含轮次号，每轮独立、不覆盖） */
export function fixPlanFileName(round: number): string {
  return `codex-fix-r${round}.md`;
}

/** 修复计划文档在项目内的相对路径（默认 .zcode/plans/） */
export function fixPlanRelPath(dir: string | undefined, round: number): string {
  const base = (dir?.trim() || ".zcode/plans").replace(/[\\/]+$/, "");
  return `${base.split(/[\\/]+/).join("/")}/${fixPlanFileName(round)}`;
}

/**
 * 初始开发指令：显式引用计划文档与设计系统（决策 13）。
 * 形如「根据计划文档(xxxxx.md)和设计系统(.xxxxx目录)，进行项目开发」。
 */
export function buildInitialPrompt(input: InitialPromptInput): string {
  if (input.feedback?.trim()) return input.feedback.trim();
  const parts: string[] = [];
  const plan = input.planDoc?.trim();
  const design = input.designSystem?.trim();
  if (plan && design) parts.push(`根据计划文档(${plan})和设计系统(${design})，进行项目开发`);
  else if (plan) parts.push(`根据计划文档(${plan})，进行项目开发`);
  else if (design) parts.push(`根据设计系统(${design})，进行项目开发`);

  let out = parts.length ? `${parts.join("；")}\n\n${input.task}` : input.task;
  if (input.context?.trim()) out += `\n\n【上下文与约束】\n${input.context}`;
  if (input.refs?.length)
    out += `\n\n【已验证项目引用】\n${input.refs.map((r) => `- ${r.directory ? "目录" : "文件"}: ${r.source} => ${r.absolutePath}`).join("\n")}`;
  return out;
}

export interface FixPromptInput {
  /** 验收失败摘要 */
  summary: string;
  /** 修复计划文档在项目内的相对路径（MCP 生成） */
  planRelPath: string;
  /** 完整验收报告的绝对路径 */
  reportPath?: string;
  /** 失败命令的原始输出摘要（可选，进一步保证可复现） */
  evidence?: string;
  /**
   * 结构化修复指令（issue #19，可选）：把「哪一行 / 什么问题 / 做什么」直接写进指令，
   * 省去 Codex 从整篇报告里定位的开销。缺省或为空时不改变既有文案。
   */
  directives?: RepairDirectives;
}

/**
 * 修复指令（决策 8）：说明不通过项 + 指出 MCP 生成的计划文档 + 要求按计划修复。
 * 计划文档由 MCP 生成，故文件名在发送前已知，可直接引用。
 */
export function buildFixPrompt(input: FixPromptInput): string {
  const lines = [
    "【上一轮验收失败 —— 请针对下列失败项定向修复，不要大范围重构】",
    "",
    `修复/优化计划文档：\`${input.planRelPath}\`（请先读取并逐条处理，再按计划修复）`,
    "",
    input.summary,
  ];
  if (input.directives?.items.length) {
    lines.push(
      "",
      "【结构化修复指令（摘要，最多 10 条；完整清单见修复计划文档）】",
      ...renderDirectiveLines(input.directives, 10),
    );
  }
  if (input.evidence?.trim()) lines.push("", "关键证据：", "```text", input.evidence.trim().slice(-2000), "```");
  if (input.reportPath) lines.push("", `完整验收报告：${input.reportPath}`);
  lines.push("", "修复完成后正常结束本轮即可。");
  return lines.join("\n");
}

/** 修复计划文档的落地绝对路径 */
export function fixPlanAbsPath(projectPath: string, dir: string | undefined, round: number): string {
  return path.join(projectPath, ...fixPlanRelPath(dir, round).split("/"));
}
