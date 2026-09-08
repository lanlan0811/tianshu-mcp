/**
 * 回复提取与完成判定（纯函数，全量单测覆盖）。
 *
 * 依据实测（2026-09-08 + 参考项目验证）：TraeWork 消息容器文本格式为
 *   {用户消息}{时间}TraeWork[思考过程{推理}]{回复}[由AI生成{时间}]
 * 完成标志「由AI生成」只应作用于「当前消息段」——历史消息末尾的该标志
 * 不能触发本轮完成，否则正文刚生成就被提前截断。
 */
import { interpretLiveness, type LivenessProbe } from "../cdp/client.js";

/** 生成一次发送的唯一标记，用于从消息容器中切出本轮内容 */
export function makeMarker(): string {
  return `【ts${Math.random().toString(36).slice(2, 10)}】`;
}

/** 在完成标志「由AI生成」处截断（消息列表新消息在上，标记切片会拖进历史） */
export function cutAtCompletionMark(added: string): string {
  const i1 = added.indexOf("由AI生成");
  const i2 = added.indexOf("由 AI 生成");
  const idx = i1 === -1 ? i2 : i2 === -1 ? i1 : Math.min(i1, i2);
  return idx === -1 ? added : added.slice(0, idx);
}

/** 是否出现完成标志 */
export function hasCompletionMark(added: string): boolean {
  return added.includes("由AI生成") || added.includes("由 AI 生成");
}

/** 是否仍在思考中（思考中占位表示本轮未结束） */
export function isThinking(added: string): boolean {
  return added.includes("思考中");
}

/**
 * ask_user 挂起检测：模型用原生提问工具结束回合时，面板出现交互卡并阻塞会话
 * （不出现完成标志）。命中 = 本轮实际结束于一次向用户的提问。
 */
export function isAskUserPending(text: string): boolean {
  return /正在向用户提问|等待你的回复/.test(text || "");
}

/**
 * 原生 agent 循环痕迹检测：只认真正的工具执行证据
 * （「已执行 N 条命令」「命令已真实执行」「退出码 N」）。
 * 「任务耗时 Ns」「已初始化环境」是每条回复的固定收尾样板，绝不能当痕迹。
 */
export function hasNativeToolTrace(text: string): boolean {
  return /已执行\s*\d+\s*条命令|命令已真实执行|退出码\s*\d/.test(text || "");
}

/** 用发送前的基线文本裁掉窗口尾部历史（不匹配时回退全窗口） */
export function stripStaleBase(added: string, base: string): string {
  if (base && added.endsWith(base)) return added.slice(0, added.length - base.length);
  return added;
}

export interface ParsedReply {
  content: string;
  reasoning: string;
}

/**
 * 解析标记后的新增文本 → { content, reasoning }。
 * 去掉用户消息前缀、TraeWork 前缀、尾部完成标志/时间戳/消耗与收尾样板。
 */
export function parseAdded(added: string): ParsedReply {
  let s = (added || "").trim();
  if (!s) return { content: "", reasoning: "" };

  // 1) 去掉用户消息（第一个时间戳前的内容）
  const ts = s.match(/\d{2}:\d{2}/);
  if (ts) {
    const idx = s.indexOf(ts[0]);
    if (idx !== -1) s = s.slice(idx + 5);
  }
  // 2) 去掉 TraeWork 前缀
  s = s.replace(/^TraeWork/, "");
  // 3) 去掉尾部完成标志与时间戳
  s = s.replace(/由\s*AI\s*生成\s*\d{2}:\d{2}\s*$/, "");
  s = s.replace(/由\s*AI\s*生成\s*$/, "");
  s = s.replace(/由AI生成\s*\d{2}:\d{2}\s*$/, "");
  s = s.replace(/由AI生成\s*$/, "");
  // 4) 去掉尾部残留时间戳
  s = s.replace(/\s*\d{2}:\d{2}\s*$/, "");
  // 5) 去掉思考中占位
  s = s.replace(/思考中\s*$/, "");
  // 6) 去掉「消耗{数值}」段
  s = s.replace(/消耗\s*[0-9.]+$/, "");
  // 7) 去掉尾部残留的「由AI生成」
  s = s.replace(/由\s*AI\s*生成\s*$/, "");
  // 8) 剥离回复开头的收尾样板（仅剥开头，避免误伤正文提及）
  s = s.replace(/^(?:任务耗时\s*[\d.]+\s*s?)?(?:已初始化环境)?/, "").trim();

  // 推理内容：思考过程段
  let reasoning = "";
  let content = s;
  const thinkIdx = s.indexOf("思考过程");
  if (thinkIdx !== -1) {
    reasoning = s.slice(thinkIdx + 4).trim();
    content = s.slice(0, thinkIdx).trim();
  }
  if (!content && reasoning) content = reasoning;
  return { content, reasoning };
}

/** 模型名归一化：小写、去分隔符、去补贴后缀 */
export function normModelName(s: string | undefined): string {
  return (s || "")
    .toLowerCase()
    .replace(/专属补贴.*$/g, "")
    .replace(/补贴.*$/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
}

/**
 * 宽容模型名匹配：actual 与 target 相等，或 actual 仅多出计划档位缀（如 "Max"）。
 * 拒绝版本号延续（GLM-5 ≠ GLM-5.3Max）。
 */
export function modelNameMatch(actual: string | undefined, target: string | undefined): boolean {
  if (!actual || !target) return false;
  const a = normModelName(actual);
  const b = normModelName(target);
  if (a === b) return true;
  if (!a.startsWith(b)) return false;
  const rest = a.slice(b.length);
  return /^(max|pro|plus|air|lite|正式版|专属补贴|补贴)*$/.test(rest);
}

/** 轮询状态机：给定累计观测，判断本轮是否已结束 */
export interface CompletionState {
  /** 上一次观测到的容器全文 */
  prev: string;
  /** 连续无变化计数 */
  stable: number;
  /** 达到稳定确认轮数的时间；0 表示尚未进入空闲计时 */
  idleSince: number;
}

export type CompletionVerdict =
  | { kind: "finished"; added: string }
  | { kind: "ask_user"; added: string }
  | { kind: "idle"; added: string }
  | { kind: "pending"; state: CompletionState };

export interface JudgePollOptions {
  liveness?: LivenessProbe;
  now?: number;
  idleTimeoutMs?: number;
}

/**
 * 判定一次轮询观测。
 * @param current 本次容器全文
 * @param marker 本轮标记
 * @param base 发送前基线（裁掉尾部历史）
 * @param state 上次轮询状态
 * @param stableRounds 无变化多少轮后兜底结束
 */
export function judgePoll(
  current: string,
  marker: string,
  base: string,
  state: CompletionState,
  stableRounds: number,
  opts: JudgePollOptions = {},
): CompletionVerdict {
  const hasMarker = current.includes(marker);
  let added = "";
  if (hasMarker) {
    added = current.slice(current.indexOf(marker) + marker.length);
  }
  const cutStale = (t: string): string => stripStaleBase(t, base);

  const thinking = hasMarker && isThinking(added);
  const finished = hasMarker && hasCompletionMark(added);
  const liveness = interpretLiveness(opts.liveness ?? { stopVisible: false, tailLoading: false, thinkingStream: false });
  const now = opts.now ?? Date.now();
  const idleTimeoutMs = opts.idleTimeoutMs ?? 10 * 60_000;

  // 字面「思考中」优先，且清除可能从前一静态阶段留下的计时。
  if (thinking) {
    return { kind: "pending", state: { prev: current, stable: 0, idleSince: 0 } };
  }

  // ask_user 挂起：立即结束（无完成标志、会话被阻塞）
  if (hasMarker && isAskUserPending(cutStale(added))) {
    return { kind: "ask_user", added: cutStale(added) };
  }

  // 权威运行信号优先于完成标志；thinkingStream 仅诊断，不影响 running。
  if (liveness.running) {
    return { kind: "pending", state: { prev: current, stable: 0, idleSince: 0 } };
  }

  if (finished) {
    return { kind: "finished", added: cutAtCompletionMark(added) };
  }

  // 稳定确认后只开始空闲计时，不再直接等同于完成。
  let stable = state.stable;
  let idleSince = state.idleSince;
  if (current === state.prev) {
    if (hasMarker && added) stable += 1;
  } else {
    stable = 0;
    idleSince = 0;
  }
  if (stable >= stableRounds && idleSince === 0) idleSince = now;
  if (idleSince > 0 && now - idleSince >= idleTimeoutMs) {
    return { kind: "idle", added: cutStale(added) };
  }
  return { kind: "pending", state: { prev: current, stable, idleSince } };
}
