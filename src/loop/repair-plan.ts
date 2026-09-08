/**
 * 返修计划文件生成（开发计划 traework-gui-adapter-plan §4.5 步骤 7 / 决策 17）。
 *
 * 验收不通过时，MCP 把失败证据写成一份结构化 markdown 计划，落在任务目录，
 * 再把该文件名写进发给 agent 的返修消息——让 agent 按文档修复，而不是只看一句摘要。
 *
 * 同时写入项目内 `.tianshu-mcp/` 目录一份（可被 agent 通过相对路径读取）；
 * 项目目录不可写时仅落任务目录，不阻断流程。
 */
import path from "node:path";
import { mkdirp, writeTextAtomic } from "../util/fs.js";
import type { VerifyReport } from "../tasks/task.js";
import type { AgentRunLogger } from "../agents/adapter.js";

export interface RepairPlanInput {
  taskId: string;
  round: number;
  projectPath: string;
  displayPath: string;
  taskText: string;
  report: VerifyReport;
  /** 任务目录（必落） */
  taskDir: string;
  logger: AgentRunLogger;
}

export interface RepairPlanResult {
  /** 文件名（相对项目根，供返修消息引用） */
  fileName: string;
  /** 任务目录内的绝对路径 */
  taskPath: string;
  /** 项目内路径（若写入成功） */
  projectPath?: string;
}

/** 生成修复计划 markdown 正文 */
export function renderRepairPlan(input: RepairPlanInput): string {
  const { report } = input;
  const failed = report.checks.filter((c) => !c.passed && !c.skipped);
  const skipped = report.checks.filter((c) => c.skipped);
  const passed = report.checks.filter((c) => c.passed);
  const a = report.analysis;

  const lines: string[] = [
    `# 修复计划（第 ${input.round + 1} 轮返修）`,
    "",
    `- 任务 ID：\`${input.taskId}\``,
    `- 项目：\`${input.displayPath}\``,
    `- 生成时间：${report.finishedAt}`,
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

  if (failed.length === 0) {
    lines.push("（无硬失败项——失败可能来自代码分析告警，见第 4 节）", "");
  } else {
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
    lines.push("## 3.1 跳过的项", "", skipped.map((c) => `- [SKIP] ${c.name}${c.reason ? `（${c.reason}）` : ""}`).join("\n"), "");
  }

  lines.push("## 4. 代码分析结果", "");
  lines.push(`- 变更文件（${a.changedFiles.length + a.untrackedFiles.length} 个）：`);
  const changed = [...a.changedFiles, ...a.untrackedFiles];
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
 * 写修复计划文件。
 * 文件名：`rework-<taskId>-r<round>.md`；落任务目录（必），并尝试落项目 `.tianshu-mcp/`。
 */
export async function writeRepairPlan(input: RepairPlanInput): Promise<RepairPlanResult> {
  const fileName = `rework-${input.taskId}-r${input.round}.md`;
  const content = renderRepairPlan(input);
  const taskPath = path.join(input.taskDir, fileName);
  await mkdirp(input.taskDir);
  await writeTextAtomic(taskPath, content);

  let projectFilePath: string | undefined;
  try {
    const dir = path.join(input.projectPath, ".tianshu-mcp");
    await mkdirp(dir);
    const p = path.join(dir, fileName);
    await writeTextAtomic(p, content);
    projectFilePath = p;
  } catch (e) {
    input.logger.warn(`[repair-plan] 项目内写入失败（不阻断，仅落任务目录）：${(e as Error).message}`);
  }
  input.logger.info(`[repair-plan] 已生成修复计划：${taskPath}`);
  return { fileName, taskPath, projectPath: projectFilePath };
}
