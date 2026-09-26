/**
 * `logs/server.log` 行解析与过滤。
 *
 * 行格式由 `src/util/log.ts` 固定：`[<ISO时间>] [<LEVEL>] <msg>`
 * （LEVEL 为 DEBUG / INFO / WARN / ERROR）。
 */
export type LogLevel = "debug" | "info" | "warn" | "error" | "unknown";

export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export interface LogLine {
  /** 原样保留（用于复制/导出与高亮重建） */
  raw: string;
  ts: string | null;
  level: LogLevel;
  msg: string;
  /** 从 1 开始的行号 */
  line: number;
}

const LINE_RE = /^\[([^\]]+)\]\s*\[([A-Za-z]+)\]\s?([\s\S]*)$/;

export function parseLogLine(raw: string, line: number): LogLine {
  const m = LINE_RE.exec(raw);
  if (!m) {
    return { raw, ts: null, level: "unknown", msg: raw, line };
  }
  const levelRaw = (m[2] ?? "").toLowerCase();
  const level: LogLevel =
    levelRaw === "debug" || levelRaw === "info" || levelRaw === "warn" || levelRaw === "error"
      ? levelRaw
      : "unknown";
  return { raw, ts: m[1] ?? null, level, msg: m[3] ?? "", line };
}

export function parseLogText(text: string, startLine = 1): LogLine[] {
  const out: LogLine[] = [];
  const rows = text.split("\n");
  for (let i = 0; i < rows.length; i += 1) {
    const raw = rows[i] ?? "";
    // 尾部空行不留（文件以 \n 结尾时必然产生一个空元素）
    if (raw === "" && i === rows.length - 1) continue;
    out.push(parseLogLine(raw, startLine + i));
  }
  return out;
}

export interface LogFilter {
  /** 空集合 = 不按级别限制 */
  levels: LogLevel[];
  keyword: string;
  /** ISO 时间下界（含），字典序比较即可（同为 UTC ISO 串） */
  from: string | null;
  to: string | null;
}

export function emptyLogFilter(): LogFilter {
  return { levels: [], keyword: "", from: null, to: null };
}

export function filterLogLines(lines: LogLine[], filter: LogFilter): LogLine[] {
  const kw = filter.keyword.trim().toLowerCase();
  return lines.filter((l) => {
    if (filter.levels.length > 0 && !filter.levels.includes(l.level)) return false;
    if (kw && !l.raw.toLowerCase().includes(kw)) return false;
    if (filter.from && l.ts && l.ts < filter.from) return false;
    if (filter.to && l.ts && l.ts > filter.to) return false;
    return true;
  });
}

export interface Segment {
  text: string;
  hit: boolean;
}

/**
 * 按关键字把一行切成「命中段 / 非命中段」。
 *
 * 刻意**不用 `v-html`**：返回结构化分段由模板渲染，避免日志内容被当作标记注入。
 */
export function highlightSegments(text: string, keyword: string): Segment[] {
  const kw = keyword.trim();
  if (!kw) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const target = kw.toLowerCase();
  const out: Segment[] = [];
  let cursor = 0;
  for (;;) {
    const at = lower.indexOf(target, cursor);
    if (at < 0) {
      out.push({ text: text.slice(cursor), hit: false });
      break;
    }
    if (at > cursor) out.push({ text: text.slice(cursor, at), hit: false });
    out.push({ text: text.slice(at, at + kw.length), hit: true });
    cursor = at + kw.length;
  }
  return out.filter((s) => s.text.length > 0);
}