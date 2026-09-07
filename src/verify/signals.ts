/**
 * 可疑标记扫描（开发计划 §8.3.3）：对变更行做轻量正则。
 * 确定性、免费；仅供报告提示，不单独作为验收失败依据。
 */

export interface SignalCounts {
  todo: number;
  consoleDebug: number;
  commentedBlock: number;
  secretLike: number;
}

const TODO_RE = /\b(TODO|FIXME|HACK|XXX)\b/i;
const CONSOLE_RE = /\bconsole\.(log|debug|info|warn|error)\s*\(|\bdebugger\s*;?/;
const SECRET_KEY_RE =
  /(['"]?(?:api[_-]?key|secret|token|passwd|password|authorization|access[_-]?key|pwd)['"]?\s*[:=]\s*['"][^'"]{6,}['"])/i;
const SECRET_LITERAL_RE = /['"][A-Za-z0-9+/=]{32,}['"]/;

export function scanChangedLinesForSignals(lines: string[]): SignalCounts {
  const signals: SignalCounts = { todo: 0, consoleDebug: 0, commentedBlock: 0, secretLike: 0 };
  let commentRun = 0;
  let inBlockComment = false;
  for (let raw of lines) {
    raw = raw.replace(/\s+$/, "");
    if (TODO_RE.test(raw)) signals.todo++;
    if (CONSOLE_RE.test(raw)) signals.consoleDebug++;
    if (SECRET_KEY_RE.test(raw)) signals.secretLike++;
    else if (raw.length > 40 && SECRET_LITERAL_RE.test(raw)) signals.secretLike++;
    // 被注释掉的整块代码：≥3 行连续整行注释视为可疑
    const line = raw.trim();
    const isCommentStart = /^(\/\*|<!--)/.test(line);
    const isCommentLine = /^(\/\/|#|--|;|\*)/.test(line);
    if (isCommentStart) inBlockComment = true;
    if (isCommentLine || inBlockComment) {
      commentRun++;
      if (line.includes("*/") || line.includes("-->")) inBlockComment = false;
      if (commentRun === 3) signals.commentedBlock++;
    } else {
      commentRun = 0;
    }
  }
  return signals;
}
