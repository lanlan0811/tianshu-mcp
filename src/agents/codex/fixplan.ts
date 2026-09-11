/**
 * Codex 修复计划文档生成（开发计划决策 11/12）。
 *
 * 决策 11：由 MCP 依据验收失败输出自动生成（不依赖 ChatGPT 自己写）。
 * 决策 12：每轮独立文件、文件名含轮次号（codex-fix-r<N>.md），保留每轮修复历史、不覆盖。
 *
 * 与通用 writeRepairPlan（任务数据目录）不同：本模块把计划写入**项目内**约定目录
 * （gui.fixPlanDir，默认 .zcode/plans/），因为该文件名要写进发给 Codex 的修复指令，
 * 而 Codex 只能读项目工作区内的文件。
 */
import path from "node:path";
import { mkdirp, writeTextAtomic } from "../../util/fs.js";
import type { VerifyReport } from "../../tasks/task.js";
import type { AgentRunLogger } from "../adapter.js";
import { fixPlanRelPath, fixPlanAbsPath } from "./input.js";

export interface CodexFixPlanInput {
  taskId: string;
  /** 失败的轮次（0-based）；生成的文件名用 round + 1 */
  round: number;
  projectPath: string;
  displayPath: string;
  taskText: string;
  report: VerifyReport;
  /** 计划文档输出目录（相对项目根），默认 .zcode/plans */
  fixPlanDir?: string;
  logger: AgentRunLogger;
}

export interface CodexFixPlanResult {
  /** 相对项目根的路径（写入修复指令） */
  relPath: string;
  /** 绝对路径 */
  absPath: string;
}

/** 渲染修复计划正文（含失败证据、通过项、代码分析、修复要求） */
export function renderCodexFixPlan(input: CodexFixPlanInput): string {
  const { report } = input;
  const failed = report.checks.filter((c) => !c.passed && !c.skipped);
  const skipped = report.checks.filter((c) => c.skipped);
  const passed = report.checks.filter((c) => c.passed);
  const a = report.analysis;
  const roundNo = input.round + 1;

  const lines: string[] = [
    `# Codex 修复计划（第 ${roundNo} 轮返修）`,
    "",
    `- 任务 ID：\`${input.taskId}\``,
    `- 项目：\`${input.displayPath}\``,
    `- 生成时间：${report.finishedAt}`,
    `- 生成方：tianshu-mcp（自动生成，供 Codex 按计划修复）`,
    `- 验收结论：**未通过**（${failed.length} 项失败 / ${passed.length} 项通过 / ${skipped.length} 项跳过）`,
    "",
    "## 1. 原始任务目标",
    "",
    "```text",
    input.taskText.slice(0, 2000),
    "```",
    "",
    "## 2. 失败项（必须修复）",
    "",
  ];

  if (failed.length === 0) lines.push("（无硬失败项——失败可能来自代码分析告警，见第 4 节）", "");
  else {
    failed.forEach((c, i) => {
      lines.push(`### 2.${i + 1} ${c.name}`, "");
      lines.push(`- 命令：\`${c.cmd}\``);
      lines.push(`- 退出码：${c.exitCode ?? "n/a"}${c.timeout ? "（超时）" : ""}`);
      lines.push(`- 耗时：${c.durationMs}ms`);
      lines.push("", "输出尾部：", "```text", (c.outputTail || "(无输出)").slice(-2000), "```", "");
    });
  }

  lines.push("## 3. 通过的项（勿破坏）", "");
  if (passed.length === 0) lines.push("（无）", "");
  else lines.push(passed.map((c) => `- [PASS] ${c.name}`).join("\n"), "");
  if (skipped.length) {
    lines.push(
      "## 3.1 跳过的项",
      "",
      skipped.map((c) => `- [SKIP] ${c.name}${c.reason ? `（${c.reason}）` : ""}`).join("\n"),
      "",
    );
  }

  lines.push("## 4. 代码分析结果", "");
  const changed = [...a.changedFiles, ...a.untrackedFiles];
  lines.push(`- 变更文件（${changed.length} 个）：`);
  lines.push(changed.length ? changed.slice(0, 50).map((f) => `  - \`${f}\``).join("\n") : "  （无变更）");
  lines.push(`- diffstat：+${a.diffstat.totalAdd} -${a.diffstat.totalDel}`);
  const sig = a.signals;
  lines.push(
    `- 可疑标记：TODO/FIXME ${sig.todo} 处、console.log/debugger ${sig.consoleDebug} 处、注释代码块 ${sig.commentedBlock} 处、疑似密钥 ${sig.secretLike} 处`,
  );
  if (a.bigFileChanges.length) lines.push(`- 超大单文件改动（>500 行）：${a.bigFileChanges.join("、")}`);
  if (a.warnings.length) lines.push("", "告警：", ...a.warnings.map((w) => `- ${w}`));
  if (a.notes.length) lines.push("", "提示：", ...a.notes.map((n) => `- ${n}`));
  lines.push("");

  lines.push(
    "## 5. 修复要求",
    "",
    "1. **只针对第 2 节的失败项定向修复**，不要大范围重构，不要改动第 3 节已通过的模块。",
    "2. 修复后请在项目内重新运行相应检查命令，确认通过。",
    "3. 如某失败项确认为环境问题（缺依赖、端口占用等），请在回复中明确说明，不要伪造通过。",
    "4. 修复完成后正常结束本轮，等待重新验收。",
    "",
    `> 完整验收报告：\`${report.files.md}\``,
    "",
  );
  return lines.join("\n");
}

/**
 * 写 Codex 修复计划文档到项目内约定目录。
 * 文件名含轮次号、每轮独立，绝不覆盖历史。
 */
export async function writeCodexFixPlan(input: CodexFixPlanInput): Promise<CodexFixPlanResult> {
  const roundNo = input.round + 1;
  const relPath = fixPlanRelPath(input.fixPlanDir, roundNo);
  const absPath = fixPlanAbsPath(input.projectPath, input.fixPlanDir, roundNo);
  await mkdirp(path.dirname(absPath));
  await writeTextAtomic(absPath, renderCodexFixPlan(input));
  input.logger.info(`[codex] 已生成修复计划：${relPath}（${absPath}）`);
  return { relPath, absPath };
}
