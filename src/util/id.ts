/**
 * 基础 ID 生成。任务 id：tsk_<yyyyMMddHHmmss>_<rand6>（开发计划 §4.2）。
 */
import { randomBytes } from "node:crypto";

function tsCompact(d = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function rand6(): string {
  return randomBytes(3).toString("hex").slice(0, 6);
}

export function genTaskId(): string {
  return `tsk_${tsCompact()}_${rand6()}`;
}

export function genVerifyId(): string {
  return `vfy_${tsCompact()}_${rand6()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
