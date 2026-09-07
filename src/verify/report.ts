/** report.md / report.json 生成（验收引擎产物，开发计划 §8.5） */
import type { VerifyReport } from "../tasks/task.js";

export function reportToJsonable(report: VerifyReport): Record<string, unknown> {
  return {
    round: report.round,
    taskId: report.taskId,
    projectPath: report.projectPath,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    passed: report.passed,
    verdict: report.verdict,
    checks: report.checks,
    analysis: report.analysis,
    files: report.files,
    message: report.message,
  };
}

export function reportToMd(report: VerifyReport): string {
  const L: string[] = [];
  L.push(`# 验收报告 — 第 ${report.round} 轮`, "");
  L.push(`- 任务: ${report.taskId}`);
  L.push(`- 项目: ${report.projectPath}`);
  L.push(`- 开始: ${report.startedAt}`);
  L.push(`- 结束: ${report.finishedAt}`);
  L.push(`- 结论: **${report.verdict === "passed" ? "通过 ✅" : "失败 ❌"}**`);
  L.push("", "## 自动命令检查", "");
  if (report.checks.length === 0) L.push("（无可运行的检查项）", "");
  for (const c of report.checks) {
    const mark = c.skipped ? "SKIP" : c.passed ? "PASS" : "FAIL";
    L.push(`- [${mark}] ${c.name} — \`${c.cmd}\`${c.durationMs >= 0 ? ` (${c.durationMs}ms)` : ""}${c.skipped && c.reason ? ` — ${c.reason}` : ""}`);
    if (!c.passed && !c.skipped) {
      if (c.timeout) L.push(`  - ⚠️ 超时（${c.durationMs}ms）`);
      L.push(`  - 退出码: ${c.exitCode ?? "n/a"}`);
      if (c.outputTail) {
        L.push("  - 输出尾部:", "", "    ```");
        const tail = c.outputTail.split("\n").slice(-40);
        for (const s of tail) L.push(`    ${s}`);
        L.push("    ```", "");
      }
    }
  }
  const a = report.analysis;
  L.push("## 代码分析", "");
  if (a.changedFiles.length === 0 && a.untrackedFiles.length === 0) {
    L.push("无变更文件（相对 git 基线）。", "");
  } else {
    L.push(`### 变更清单（${a.changedFiles.length} 个已跟踪 + ${a.untrackedFiles.length} 个未跟踪）`, "");
    for (const f of a.changedFiles) L.push(`- ${f}`);
    for (const f of a.untrackedFiles) L.push(`- (未跟踪) ${f}`);
    L.push("", `### diffstat：+${a.diffstat.totalAdd} -${a.diffstat.totalDel}`, "");
    for (const pf of a.diffstat.perFile) L.push(`- ${pf.file}: +${pf.add} -${pf.del}${pf.binary ? " (binary)" : ""}`);
  }
  const sig = a.signals;
  const sigTotal = sig.todo + sig.consoleDebug + sig.commentedBlock + sig.secretLike;
  if (sigTotal > 0 || a.bigFileChanges.length > 0 || a.warnings.length > 0) {
    L.push("", "### 可疑标记与告警", "");
    if (sig.todo) L.push(`- TODO/FIXME/HACK 命中 ${sig.todo} 处`);
    if (sig.consoleDebug) L.push(`- console.log/debugger 命中 ${sig.consoleDebug} 处`);
    if (sig.commentedBlock) L.push(`- 被注释掉的整块代码 ${sig.commentedBlock} 处`);
    if (sig.secretLike) L.push(`- 疑似密钥/令牌形态 ${sig.secretLike} 处`);
    for (const f of a.bigFileChanges) L.push(`- ⚠️ 超大单文件改动: ${f}`);
    for (const w of a.warnings) L.push(`- ⚠️ ${w}`);
  }
  for (const n of a.notes) L.push(`- 💡 ${n}`);
  L.push("", "---", "", report.message, "");
  return L.join("\n");
}

/** 摘要：面向天枢的可读结论（≤ 约 6KB） */
export function summarizeReport(report: VerifyReport): string {
  const passCount = report.checks.filter((c) => c.passed).length;
  const fail = report.checks.filter((c) => !c.passed && !c.skipped);
  const skip = report.checks.filter((c) => c.skipped).length;
  const head =
    report.passed
      ? `✅ 验收通过（第 ${report.round} 轮）：${passCount}/${report.checks.length} 项命令检查通过${skip ? `，${skip} 项跳过` : ""}。`
      : `❌ 验收失败（第 ${report.round} 轮）：${fail.length} 项检查未通过${skip ? `，${skip} 项跳过` : ""}。`;
  const lines = [head, ""];
  for (const c of report.checks) {
    const st = c.skipped ? "SKIP" : c.passed ? "PASS" : "FAIL";
    lines.push(`- [${st}] ${c.name} — ${c.cmd}${c.skipped ? (c.reason ? `（${c.reason}）` : "") : `（${c.durationMs}ms, exit=${c.exitCode}）`}`);
    if (!c.passed && !c.skipped && c.outputTail) {
      const tail = c.outputTail.trim().split("\n").slice(-6).map((s) => `    ${s}`).join("\n");
      lines.push(`  输出尾部：\n${tail}`);
    }
  }
  const a = report.analysis;
  const sigTotal = a.signals.todo + a.signals.consoleDebug + a.signals.commentedBlock + a.signals.secretLike;
  const analysisBits: string[] = [];
  analysisBits.push(`变更 ${a.changedFiles.length} 个已跟踪 + ${a.untrackedFiles.length} 个未跟踪文件，diffstat +${a.diffstat.totalAdd} -${a.diffstat.totalDel}`);
  if (sigTotal) analysisBits.push(`可疑标记 ${sigTotal} 处`);
  if (a.bigFileChanges.length) analysisBits.push(`超大改动 ${a.bigFileChanges.length} 个`);
  if (a.warnings.length) analysisBits.push(`告警 ${a.warnings.length} 条`);
  if (analysisBits.length) lines.push("", `代码分析：${analysisBits.join("；")}。`);
  lines.push("", `报告：${report.files.md}`, `JSON：${report.files.json}`);
  return lines.join("\n");
}
