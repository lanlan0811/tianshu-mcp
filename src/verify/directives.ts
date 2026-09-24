/**
 * 结构化修复指令提取（issue #19）。
 *
 * 背景：验收失败时的返修报告是**整篇叙述**，agent 需要自己从报告里定位具体问题
 * （哪一行类型不匹配、哪个文件有 TODO、哪个文件改动行数异常），既增加推理开销，
 * 也提高理解偏差导致返修失败的概率。本模块把失败原因解析为**可直接执行的动作**：
 *
 *   { file: "src/foo.ts", line: 42, issue: "TS2322: 类型不匹配", action: "修正该处类型错误（依据 TS2322 提示）" }
 *
 * 设计要点：
 * - 仓库内**没有** per-verifier 模块（typecheck/test/build 都是通用 argv 命令检查），
 *   因此 source 按「检查项 name / argv 启发式」+ 报告内的结构化分析结果匹配。
 * - **永不抛错**：提取失败以数据形式表达（`fallbackReason`），渲染方据此**回退整份报告**。
 *   这是 issue 要求的鲁棒性兜底 —— 提取器出问题绝不能反而让返修失去上下文。
 * - 已知限制：`CheckResult.outputTail` 被截断到最后 4000 字符（runner.ts），大型项目
 *   只能提取到尾部报错；提取不到即自然回退。
 */
import path from "node:path";
import { toPosix } from "../util/fs.js";
import { LOCKFILE_PATTERN } from "./code-analysis.js";
import type { VerifyReport } from "../tasks/task.js";

export interface RepairDirective {
  /** 项目相对 posix 路径；无法定位到文件时省略（如全局 TODO 统计） */
  file?: string;
  line?: number;
  /** 问题描述（面向「是什么」） */
  issue: string;
  /** 处理动作（面向「做什么」） */
  action: string;
  /** 产出本条的提取器 id，便于排查与测试 */
  source: string;
}

export interface RepairDirectives {
  items: RepairDirective[];
  /** 实际产出条目的提取器 id */
  sources: string[];
  /** 非空 ⇒ 结构化提取不可用，渲染方必须回退完整报告 */
  fallbackReason?: string;
}

export interface DirectiveSource {
  id: string;
  extract(report: VerifyReport): RepairDirective[];
}

/** 检查项是否属于类型检查（按 name + argv 启发式，与 isTestCheck 同构） */
function isTypecheckCheck(name: string, cmd: string): boolean {
  return /typecheck|tsc|--noEmit|mypy|pyright/i.test(`${name} ${cmd}`);
}

/** 把可能是绝对的路径归一化为「项目相对 posix 路径」 */
function toProjectRelative(file: string, projectPath: string): string {
  const trimmed = file.trim();
  if (!trimmed) return trimmed;
  if (path.isAbsolute(trimmed)) {
    const rel = path.relative(projectPath, trimmed);
    // 落在项目外的路径保留原样（绝对），不做无法验证的裁剪
    return rel && !rel.startsWith("..") ? toPosix(rel) : toPosix(trimmed);
  }
  return toPosix(trimmed);
}

/** tsc 人性化输出：`src/foo.ts(42,5): error TS2322: Type 'x' is not assignable…` */
const TS_PRETTY = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/;
/** tsc --pretty false：`src/foo.ts:42:5 - error TS2322: Type 'x' is not assignable…` */
const TS_PLAIN = /^(.+?):(\d+):(\d+)\s+-\s+error\s+(TS\d+):\s*(.+)$/;

const typecheckSource: DirectiveSource = {
  id: "typecheck",
  extract(report) {
    const out: RepairDirective[] = [];
    const seen = new Set<string>();
    const checks = report.checks.filter(
      (c) => !c.passed && !c.skipped && isTypecheckCheck(c.name, c.cmd),
    );
    for (const check of checks) {
      for (const rawLine of check.outputTail.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        const m = TS_PRETTY.exec(line) ?? TS_PLAIN.exec(line);
        if (!m) continue;
        const [, file, lineNo, , code, message] = m;
        const rel = toProjectRelative(file!, report.projectPath);
        const key = `${rel}:${lineNo}:${code}:${message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          file: rel,
          line: Number(lineNo),
          issue: `${code}: ${message!.trim()}`,
          action: `修正该处类型错误（依据 ${code} 提示）`,
          source: "typecheck",
        });
      }
    }
    return out;
  },
};

const diffstatSource: DirectiveSource = {
  id: "diffstat",
  extract(report) {
    const a = report.analysis;
    const out: RepairDirective[] = [];
    for (const f of a.bigFileChanges) {
      out.push({
        file: toPosix(f),
        issue: "单文件改动过大（>500 行）",
        action: "拆分改动或确认如此大范围改动确有必要",
        source: "diffstat",
      });
    }
    for (const f of [...a.changedFiles, ...a.untrackedFiles]) {
      const p = toPosix(f);
      if (LOCKFILE_PATTERN.test(p)) {
        out.push({
          file: p,
          issue: "锁文件被修改",
          action: "确认依赖变更是有意的；若非有意请还原该锁文件",
          source: "diffstat",
        });
      }
    }
    // 行级信号没有稳定的文件/行号（signals.ts 只做计数），故产出文件无关的指令
    const sig = a.signals;
    if (sig.todo > 0) {
      out.push({
        issue: `新增/变更行含 TODO/FIXME/HACK 共 ${sig.todo} 处`,
        action: "实现或移除这些待办标记",
        source: "diffstat",
      });
    }
    if (sig.consoleDebug > 0) {
      out.push({
        issue: `新增/变更行含 console.log/debugger 共 ${sig.consoleDebug} 处`,
        action: "移除调试输出",
        source: "diffstat",
      });
    }
    if (sig.secretLike > 0) {
      out.push({
        issue: `新增/变更行含疑似密钥/令牌形态 ${sig.secretLike} 处`,
        action: "改为从环境变量或配置读取，不要硬编码凭证",
        source: "diffstat",
      });
    }
    return out;
  },
};

/**
 * 提取器注册表。新增验收器支持时在此追加 —— 每个 source 只依赖报告内的结构化数据，
 * 因此可以独立单测（不需要真的跑命令）。
 */
export const DIRECTIVE_SOURCES: readonly DirectiveSource[] = [typecheckSource, diffstatSource];

/**
 * 从一轮验收报告提取结构化修复指令。
 * **绝不抛错**：单个 source 异常只记录到 `fallbackReason`，其余 source 继续工作。
 */
export function extractRepairDirectives(report: VerifyReport): RepairDirectives {
  const items: RepairDirective[] = [];
  const sources: string[] = [];
  const errors: string[] = [];
  for (const src of DIRECTIVE_SOURCES) {
    try {
      const got = src.extract(report);
      if (got.length) {
        items.push(...got);
        sources.push(src.id);
      }
    } catch (e) {
      errors.push(`${src.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const out: RepairDirectives = { items, sources };
  if (items.length === 0) {
    out.fallbackReason = errors.length
      ? `结构化提取失败（${errors.join("；")}）`
      : "本轮失败原因无法解析为可直接执行的指令（如测试类失败无稳定的文件/行号）";
  }
  return out;
}

/** 渲染为面向 agent 的紧凑指令块（最多 maxItems 条） */
export function renderDirectiveLines(directives: RepairDirectives, maxItems = 10): string[] {
  return directives.items.slice(0, maxItems).map((d) => {
    const loc = d.file ? `\`${d.file}${d.line ? `:${d.line}` : ""}\`` : "（无具体文件）";
    return `- ${loc} — ${d.issue} → ${d.action}`;
  });
}

/**
 * 返修计划里的「2.5 结构化修复指令」小节（通用 + Codex 两套渲染共用，避免文案漂移）。
 *
 * **回退是显式且自觉的**：没有可用指令时不留空段，而是写明原因并明确要求 agent 回到
 * 完整失败输出定位问题 —— 让「提取失败」成为一个可观测的事实，而不是静默降级。
 */
export function renderDirectiveSection(report: VerifyReport): string {
  const d = report.repairDirectives;
  if (d?.items.length) {
    return [
      "## 2.5 结构化修复指令（可直接执行）",
      "",
      ...d.items.map((it) => {
        const loc = it.file ? `\`${it.file}${it.line ? `:${it.line}` : ""}\`` : "（无具体文件）";
        return `- ${loc} — ${it.issue} → **${it.action}**`;
      }),
      "",
    ].join("\n");
  }
  return [
    "## 2.5 结构化修复指令（不可用，回退完整报告）",
    "",
    `原因：${d?.fallbackReason ?? "本轮报告未生成结构化指令"}`,
    "",
    "> 请**阅读第 2 节的完整失败输出**自行定位问题，不要依赖本节的省略形式。",
    "",
  ].join("\n");
}
