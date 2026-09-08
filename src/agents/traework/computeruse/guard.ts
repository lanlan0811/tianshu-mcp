/**
 * 内置受限 computer-use 守卫（决策 21：仅用于驱动 AI-Agent，其他用途一律拒绝）。
 *
 * 本模块是唯一的桌面自动化入口。任何桌面操作必须先经 assertAllowed 校验：
 * 只有「由 TraeWork 弹出、且标题/进程属于文件夹选择对话框」的窗口才放行。
 * 其他一切目标（浏览器、编辑器、终端、系统对话框等）一律拒绝并抛错。
 */

/** 允许操作的窗口特征（白名单） */
const ALLOWED_WINDOW_TITLE_PATTERNS: RegExp[] = [
  /select project folder/i,
  /选择项目文件夹/,
  /选择文件夹/,
  /select folder/i,
];

/** 允许的宿主进程名（大小写不敏感） */
const ALLOWED_PROCESS_NAMES = ["trae solo cn.exe", "traesolocn.exe", "traework.exe", "traework cn.exe", "explorer.exe"];

export interface DesktopTarget {
  /** 目标窗口标题 */
  windowTitle: string;
  /** 宿主进程名（如 TRAE SOLO CN.exe） */
  processName: string;
  /** 操作意图（用于审计与错误信息） */
  intent: string;
}

export class ComputerUseDeniedError extends Error {
  constructor(msg: string) {
    super(`COMPUTER_USE_DENIED: ${msg}`);
    this.name = "ComputerUseDeniedError";
  }
}

/**
 * 校验一次桌面操作是否放行。
 * 这是硬性边界：不满足条件必须抛错，绝不「尽力而为」地操作其他窗口。
 */
export function assertAllowed(target: DesktopTarget): void {
  const title = (target.windowTitle || "").trim();
  const proc = (target.processName || "").trim().toLowerCase();

  if (!title) {
    throw new ComputerUseDeniedError("目标窗口无标题，无法确认为 AI-Agent 文件夹选择对话框，拒绝操作");
  }
  const titleOk = ALLOWED_WINDOW_TITLE_PATTERNS.some((re) => re.test(title));
  if (!titleOk) {
    throw new ComputerUseDeniedError(
      `目标窗口「${title}」不属于允许的文件夹选择对话框。本 MCP 的 computer-use 仅用于驱动 AI-Agent，其他用途一律拒绝。`,
    );
  }
  const procOk = ALLOWED_PROCESS_NAMES.includes(proc);
  if (!procOk) {
    throw new ComputerUseDeniedError(
      `宿主进程「${target.processName}」不在允许列表内。本 MCP 的 computer-use 仅用于驱动 AI-Agent，其他用途一律拒绝。`,
    );
  }
}

/** 是否放行（不抛错的探测版，供诊断脚本使用） */
export function isAllowed(target: DesktopTarget): boolean {
  try {
    assertAllowed(target);
    return true;
  } catch {
    return false;
  }
}

/** 允许的进程名清单（只读，供文档/诊断） */
export function allowedProcessNames(): readonly string[] {
  return ALLOWED_PROCESS_NAMES;
}
