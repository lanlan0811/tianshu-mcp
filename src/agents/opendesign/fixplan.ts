/**
 * Open Design 修复/优化计划文档生成（计划 P6 / 步 11）。
 *
 * 与 Codex 的 fixplan 同一决策：**计划由 MCP 依据验收失败自动生成**，不指望 agent 自己写。
 *
 * 落盘位置刻意选**项目根下**（默认 `.opendesign/plans/`），不落任务数据目录：
 * 计划文件名要写进发给 Open Design 的修复指令，而 Open Design 只能读它「工作目录」白名单内的文件
 * （`linkedDirs` / 项目根）。写进数据目录会导致「我让你看计划，你说读不到」。
 *
 * 每轮独立文件、文件名含轮次号，**绝不覆盖历史**。
 */
import path from "node:path";
import { OPEN_DESIGN_DEFAULTS } from "../../config/schema.js";
import { visualEvidence } from "../../visual/report.js";
import { renderDirectiveSection } from "../../verify/directives.js";
import { mkdirp, writeTextAtomic } from "../../util/fs.js";
import type { VerifyReport } from "../../tasks/task.js";
import type { AgentRunLogger } from "../adapter.js";

export interface OpenDesignFixPlanInput {
  taskId: string;
  /** 失败的轮次（0-based）；文件名用 round（与报告轮次一致，避免 off-by-one） */
  round: number;
  projectPath: string;
  displayPath: string;
  taskText: string;
  report: VerifyReport;
  /**
   * 计划输出目录（相对项目根或绝对路径）。
   * 默认 `.opendesign/plans`；绝对路径时**不加项目前缀**——强拼会把文件写到奇怪的位置。
   */
  planDir?: string;
  logger: AgentRunLogger;
}

export interface OpenDesignFixPlanResult {
  /** 相对项目根的路径（**正斜杠**，用于写进修复指令） */
  relPath: string;
  /** 绝对路径 */
  absPath: string;
}

/** 计划文档文件名（含轮次号，每轮独立、不覆盖） */
export function fixPlanFileName(round: number): string {
  return `opendesign-fix-r${round}.md`;
}

/** 解析计划目录：绝对路径原样使用，相对路径按项目根展开 */
export function resolvePlanDir(
  projectPath: string,
  planDir?: string,
): { abs: string; rel: string } {
  const raw = planDir?.trim() || OPEN_DESIGN_DEFAULTS.planDir;
  if (path.isAbsolute(raw)) {
    // 绝对路径也要给出可写进指令的相对形式（在项目内才可能被 Open Design 读到）
    const rel = path.relative(projectPath, raw).split(path.sep).join("/");
    return { abs: raw, rel: rel && !rel.startsWith("..") ? rel : raw.split(path.sep).join("/") };
  }
  const rel = raw
    .replace(/^[\\/]+/, "")
    .replace(/[\\/]+$/, "")
    .split(/[\\/]+/)
    .join("/");
  return { abs: path.join(projectPath, ...rel.split("/")), rel };
}

/** 渲染修复/优化计划正文 */
export function renderOpenDesignFixPlan(input: OpenDesignFixPlanInput): string {
  const { report } = input;
  const failed = report.checks.filter((c) => !c.passed && !c.skipped);
  const skipped = report.checks.filter((c) => c.skipped);
  const passed = report.checks.filter((c) => c.passed);
  const a = report.analysis;

  const lines: string[] = [
    visualEvidence(report),
    `# Open Design 修复/优化计划（第 ${input.round} 轮返修）`,
    "",
    `- 任务 ID：\`${input.taskId}\``,
    `- 项目：\`${input.displayPath}\``,
    `- 生成时间：${report.finishedAt}`,
    `- 生成方：tianshu-mcp（自动生成，供 Open Design 按计划修复/优化）`,
    `- 验收结论：**未通过**（${failed.length} 项失败 / ${passed.length} 项通过 / ${skipped.length} 项跳过）`,
    "",
    "## 1. 原始设计目标",
    "",
    "```text",
    input.taskText.slice(0, 2000),
    "```",
    "",
    "## 2. 未通过项（必须修复/优化）",
    "",
  ];

  if (failed.length === 0)
    lines.push("（无硬失败项——未通过可能来自视觉比对差异或代码分析告警，见第 3、4 节）", "");
  else {
    failed.forEach((c, i) => {
      lines.push(`### 2.${i + 1} ${c.name}`, "");
      lines.push(`- 命令：\`${c.cmd}\``);
      lines.push(`- 退出码：${c.exitCode ?? "n/a"}${c.timeout ? "（超时）" : ""}`);
      lines.push(`- 耗时：${c.durationMs}ms`);
      lines.push("", "输出尾部：", "```text", (c.outputTail || "(无输出)").slice(-2000), "```", "");
    });
  }

  // 视觉验收差异（本适配器的核心验收面）：按可操作粒度给出「哪一页 / 哪个视口 / 差多少」
  lines.push("## 3. 视觉验收差异（页面截图比对）", "");
  const visual = report.visual;
  if (!visual) lines.push("（本轮没有视觉验收结果）", "");
  else {
    const failedItems = visual.results.filter((r) => r.status === "failed");
    lines.push(
      `- 结论：${failedItems.length ? `**未通过**（${failedItems.length} 项失败 / 共 ${visual.results.length} 项）` : `通过（共 ${visual.results.length} 项）`}`,
      `- 产物目录：\`${visual.artifactDirectory}\``,
      "",
    );
    if (visual.results.length) {
      lines.push(
        "| 项目 | 类型 | 目标 | 视口 | 结论 | 差异 | 产物 |",
        "|---|---|---|---|---|---|---|",
      );
      for (const item of visual.results.slice(0, 50)) {
        const diff =
          typeof item.metrics?.diffRatio === "number"
            ? (item.metrics.diffRatio as number).toFixed(6)
            : typeof item.metrics?.diffPixels === "number"
              ? `${item.metrics.diffPixels}px`
              : "-";
        const artifact = item.artifacts ? Object.values(item.artifacts)[0] : undefined;
        lines.push(
          `| ${item.id} | ${item.kind} | ${item.target} | ${item.viewport ?? "-"} | ` +
            `${item.status === "failed" ? "**FAIL**" : item.status.toUpperCase()} | ${diff} | ${artifact ?? "-"} |`,
        );
      }
      lines.push("");
      const actionable = visual.results.filter((r) => r.status === "failed");
      if (actionable.length) {
        lines.push("失败项原因（逐条）：", "");
        for (const item of actionable) lines.push(`- \`${item.id}\`：${item.message}`);
        lines.push("");
      }
    }
  }

  lines.push(renderDirectiveSection(report));

  lines.push("## 4. 通过项（勿破坏）", "");
  lines.push(passed.length ? passed.map((c) => `- [PASS] ${c.name}`).join("\n") : "（无）", "");
  if (skipped.length) {
    lines.push(
      "## 4.1 跳过项",
      "",
      skipped.map((c) => `- [SKIP] ${c.name}${c.reason ? `（${c.reason}）` : ""}`).join("\n"),
      "",
    );
  }

  lines.push("## 5. 代码分析结果", "");
  const changed = [...a.changedFiles, ...a.untrackedFiles];
  lines.push(`- 变更文件（${changed.length} 个）：`);
  lines.push(
    changed.length
      ? changed
          .slice(0, 50)
          .map((f) => `  - \`${f}\``)
          .join("\n")
      : "  （无变更）",
  );
  lines.push(`- diffstat：+${a.diffstat.totalAdd} -${a.diffstat.totalDel}`);
  if (a.warnings.length) lines.push("", "告警：", ...a.warnings.map((w) => `- ${w}`));
  if (a.notes.length) lines.push("", "提示：", ...a.notes.map((n) => `- ${n}`));
  lines.push("");

  lines.push(
    "## 6. 修复/优化要求",
    "",
    "1. **只针对第 2、3 节的未通过项做定向修复或优化**，不要重做整体设计，不要改动第 4 节已通过的页面/模块。",
    "2. 视觉差异请对照差异图（第 3 节的产物路径）确认是**布局/样式/内容**哪一类问题，再动手。",
    "3. 若某项确认为环境问题（缺依赖、端口占用、预览服务未起等），请在回复中明确说明，**不要伪造通过**。",
    "4. 修复完成后正常结束本轮，等待重新验收。",
    "",
    `> 完整验收报告：\`${report.files.md}\``,
    "",
  );
  return lines.join("\n");
}

/** 写修复/优化计划到项目内约定目录（默认 `.opendesign/plans/`），每轮独立不覆盖 */
export async function writeOpenDesignFixPlan(
  input: OpenDesignFixPlanInput,
): Promise<OpenDesignFixPlanResult> {
  const { abs: dirAbs, rel: dirRel } = resolvePlanDir(input.projectPath, input.planDir);
  const relPath = `${dirRel}/${fixPlanFileName(input.round)}`;
  const absPath = path.join(dirAbs, fixPlanFileName(input.round));
  await mkdirp(path.dirname(absPath));
  await writeTextAtomic(absPath, renderOpenDesignFixPlan(input));
  input.logger.info(`[opendesign] 已生成修复/优化计划：${relPath}（${absPath}）`);
  return { relPath, absPath };
}

/** 发给 Open Design 的返修指令：说明未通过 + 指向 MCP 生成计划 + 要求按计划修复 */
export function buildOpenDesignFixPrompt(input: {
  summary: string;
  planRelPath: string;
  reportPath?: string;
  evidence?: string;
}): string {
  const lines = [
    "【上一轮验收未通过 —— 请针对下列问题定向修复/优化，不要大范围重做】",
    "",
    `修复/优化计划文档：\`${input.planRelPath}\`（请先读取并逐条处理，再按计划修复）`,
    "",
    input.summary,
  ];
  if (input.evidence?.trim())
    lines.push("", "关键证据：", "```text", input.evidence.trim().slice(-2000), "```");
  if (input.reportPath) lines.push("", `完整验收报告：${input.reportPath}`);
  lines.push("", "修复完成后正常结束本轮即可。");
  return lines.join("\n");
}
