/**
 * A8b 深链解析（纯函数，可单测）。
 *
 * 只认 `tianshu://task/<任务ID>`；**其余一律返回 `null`**（不猜、不宽松匹配），
 * 由调用方给出「无法识别的深链」提示。
 *
 * 任务 ID 额外做字符白名单校验（`[A-Za-z0-9_-]`）：深链是**外部输入**，
 * 且任务 ID 会拼进文件路径（`tasks/<id>/…`），必须挡住 `..` / 分隔符等路径穿越写法。
 */
import type { TaskEvent } from "@/api/types";

/** Rust 侧同名的深链事件（`lib.rs` 的 `DEEPLINK_EVENT`），改动必须两处同步 */
export const DEEPLINK_EVENT = "gui://deeplink";

/** 协议名（与 `tauri.conf.json` 的 `plugins.deep-link.desktop.schemes` 一致） */
export const DEEPLINK_SCHEME = "tianshu";

export interface DeepLinkTarget {
  view: "task";
  taskId: string;
}

const TASK_ID_RE = /^[A-Za-z0-9_-]+$/;

export function parseDeepLink(url: string): DeepLinkTarget | null {
  const raw = url.trim();
  if (raw === "") return null;
  // URL 解析器会把 `..` / `%2e%2e` 归一化掉（`tianshu://task/../x` 会变成 `/x`），
  // 归一化后的结果再也看不出原样。直接拒绝这类写法：任务 ID 里本就不允许出现 `.`，
  // 与其让「写错的链接」被静默猜成一个别的 ID，不如如实判为无法识别。
  if (raw.includes("..") || /%2e/i.test(raw)) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  // `URL` 会把 scheme 小写化，但**不保证** host 大小写，故这里统一小写后再比较
  if (parsed.protocol !== `${DEEPLINK_SCHEME}:`) return null;
  if (parsed.host.toLowerCase() !== "task") return null;

  // `tianshu://task/tsk_1` 的路径是 `/tsk_1`；allow 末尾斜杠产生的空段
  const segments = parsed.pathname.split("/").filter((seg) => seg !== "");
  if (segments.length !== 1) return null;
  // `decodeURIComponent` 对**外部可控**的畸形转义抛 `URIError`（`%zz`、`%`、`%80` 等），
  // 而本函数的契约是「其余一律返回 null」（见文件头）。深链的入队侧不做业务判断
  // （`lib.rs` 的 `queue_deeplinks` 只入队），故畸形输入必然走到这里——必须就地收口：
  // 解码失败即「无法识别」，交由调用方如实提示，绝不上抛。
  let taskId: string;
  try {
    taskId = decodeURIComponent(segments[0] as string);
  } catch {
    return null;
  }
  if (!TASK_ID_RE.test(taskId)) return null;

  return { view: "task", taskId };
}

/** 一批深链里**第一条可识别**的目标（其余忽略；全不可识别返回 `null`） */
export function firstDeepLinkTarget(urls: string[]): DeepLinkTarget | null {
  for (const url of urls) {
    const target = parseDeepLink(url);
    if (target) return target;
  }
  return null;
}

/** 事件流 → 需全量读取才能看全的阶段（供界面提示「已读全量 / 仅窗口」） */
export function needsFullRead(events: TaskEvent[]): boolean {
  return events.length > 0 && events[0]?.event !== "created";
}
