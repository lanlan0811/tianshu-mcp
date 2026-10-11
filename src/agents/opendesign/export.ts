/**
 * Open Design 的「导出」段 —— 把产物落到项目目录，供视觉验收使用。
 *
 * 为什么必须有这一步（真机取证 2026-09-28）：Open Design 把设计产物存在自己的项目仓库里
 * （`od://app/projects/<id>/conversations/<id>/files/<name>`），**不会自动写进用户的任务文件夹**。
 * 少了导出，`visual.ts` 永远报「未在项目内找到设计稿入口」，视觉验收整段空转。
 *
 * 导出链路（对齐产品操作指引）：
 *   1. 点工具栏「导出」→ 弹出菜单（role=menu，4 项：PDF / 图片 / .zip / 独立 HTML）；
 *   2. 按目标方式点菜单项（role=menuitem，**文本精确匹配**，无 testid）；
 *   3. 产品随即弹出 **Windows 原生保存对话框**（`#32770`，标题是 `blob:od://app/...`），
 *      **默认目录是「下载」** —— 必须在地址栏输入目标文件夹，否则产物落在下载目录；
 *   4. 等产物出现（排除 `.crdownload` 之类的未完成临时文件）；
 *   5. `zip` 方式再解压到项目根。
 *
 * 本文件把**判据层**（方式归一 / 文件名 / 产物定位 / 解压命令）做成纯函数，便于单测；
 * 真实点击与原生对话框走注入的 deps，由真机冒烟覆盖。
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentRunLogger } from "../adapter.js";
import { WINDOWS_SAVE_DIALOG_SCRIPT } from "./dialog.js";

const execFileAsync = promisify(execFile);

export type OpenDesignExportKind = "html" | "zip";

/**
 * 归一导出方式。只支持 `html` / `zip`：
 * - `html`（默认）：产物是自包含 HTML，可直接静态服务做视觉验收，**无需解压**；
 * - `zip`：压缩包，需解压后再验收（用户明确要求支持这条路径）。
 * PDF / 图片**不接受** —— 它们不是可截图的页面来源，拿去做视觉验收没有意义。
 */
export function normalizeExportKind(value: string | undefined): OpenDesignExportKind | null {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return null;
  if (v === "zip" || v.includes("zip")) return "zip";
  if (v === "html" || v.includes("html")) return "html";
  return null;
}

/** 导出方式的选择：非法/缺省一律回退到 `html`（不因用户笔误阻断整条链路） */
export function chooseExportKind(value: string | undefined): OpenDesignExportKind {
  return normalizeExportKind(value) ?? "html";
}

/**
 * 方式 → 菜单项文本。
 * 真机菜单四项：`导出为 PDF` / `导出为图片` / `下载为 .zip` / `导出为独立 HTML`。
 * 注意 zip 那项文案是「**下载为** .zip」（不是「导出为」），照抄产品原文，别顺手改写。
 */
export function exportItemText(kind: OpenDesignExportKind): string {
  return kind === "zip" ? "下载为 .zip" : "导出为独立 HTML";
}

/** 保存对话框里的文件名：html 保留原扩展名，zip 换成 `.zip`；产物名缺失时给稳定兜底名 */
export function exportedFileNameFor(kind: OpenDesignExportKind, artifactName: string): string {
  const base = (artifactName ?? "").trim();
  if (!base) return "opendesign-export.html";
  if (kind === "zip") return `${base.replace(/\.html?$/i, "")}.zip`;
  return base;
}

/** 从 `od://` 文件 URL 里取产物名（末段，剥掉查询串与锚点）；取不到返回空串 */
export function exportedArtifactName(url: string): string {
  const raw = (url ?? "").trim();
  if (!raw) return "";
  const withoutQuery = raw.split(/[?#]/, 1)[0] ?? "";
  const last = withoutQuery.split("/").filter(Boolean).pop() ?? "";
  // 末段可能是 id（纯 hex/uuid）而非文件名 —— 只认带扩展名的
  return /\.[a-z0-9]{2,5}$/i.test(last) ? last : "";
}

export interface ExportedFile {
  name: string;
  size: number;
  mtimeMs: number;
}

/**
 * 在导出目录里挑出本次产物：
 * - 扩展名匹配且**排除未完成的临时下载**（`.crdownload` / `.part` / `.tmp`）；
 * - 多个匹配取**最新修改**的（用户可能反复导出）；
 * - 没有匹配返回 `null`，由调用方如实报告（不猜、不复用旧产物）。
 */
export function pickExportedArtifact(
  kind: OpenDesignExportKind,
  files: readonly ExportedFile[],
): string | null {
  const wantRe = kind === "zip" ? /\.zip$/i : /\.html?$/i;
  const tempRe = /\.(crdownload|part|tmp|download)$/i;
  const candidates = files.filter((f) => wantRe.test(f.name) && !tempRe.test(f.name));
  if (!candidates.length) return null;
  return candidates.reduce((best, cur) => (cur.mtimeMs > best.mtimeMs ? cur : best)).name;
}

/**
 * zip 解压命令：Windows 内置 `Expand-Archive`（**不引入新依赖**）。
 * `-Force` 覆盖已有内容，避免第二次导出因目标目录非空而失败。
 * 路径作为**独立参数**传递（不做字符串拼接），空格与中文都安全。
 */
export function zipExtractCommand(
  zipPath: string,
  targetDir: string,
): { file: string; args: string[] } {
  return {
    file: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Expand-Archive",
      "-LiteralPath",
      zipPath,
      "-DestinationPath",
      targetDir,
      "-Force",
    ],
  };
}

/** 导出段需要的最小页面能力（真实实现为 `cdp.ts` 的 OpenDesignCdpClient；单测注入内存桩） */
export interface OpenDesignExportPage {
  /** 当前产物 URL（用于推导文件名与产物名） */
  currentUrl(): Promise<string>;
  /**
   * 把浏览器下载目录指到目标路径。
   *
   * 真机取证（2026-10-11）：0.24.1 的导出是**浏览器式下载**（blob → `will-download`），
   * 不弹原生保存对话框——点完只出现一个无子控件的 `blob:` 空壳窗口，
   * 下载停在 `~/Downloads/<uuid>.tmp` 不再增长。所以「填地址栏 + 点保存」那条路不适用，
   * 唯一可靠做法是先用 CDP 指定 downloadPath，再点菜单项，文件直接落盘到目标目录。
   */
  setDownloadDir(dir: string): Promise<boolean>;
  /** 按可见文本点一个按钮（工具栏「导出」无 testid，只能按文本找） */
  clickByText(text: string): Promise<{ clicked: boolean; count: number }>;
  /** 等菜单出现（`role=menu`） */
  waitForMenu(timeoutMs: number): Promise<boolean>;
  /** 按文本精确点菜单项（`role=menuitem`），返回可点击项与候选 */
  clickMenuItem(text: string): Promise<{ clicked: boolean; count: number; available: string[] }>;
  sleep(ms: number): Promise<void>;
}

export interface ExportArtifactInput {
  page: OpenDesignExportPage;
  kind: OpenDesignExportKind;
  /** 目标目录（项目根）：产物与解压内容都落这里 */
  targetDir: string;
  ownerPids: number[];
  budgetMs: number;
  logger: AgentRunLogger;
  /**
   * 原生对话框的**基线**：必须在**点导出之前**采样并透传进来。
   *
   * 这是从「选择文件夹」那条已验证工作的路径学到的结构（见 dialog.ts 的
   * `baseline 在点击「选择目录」之前采样` 注释）：基线若在对话框已弹出之后才采，
   * 弹出的那个窗口会被当成"本来就存在"，于是「只看新出现的窗口」这条判据永远匹配不到它。
   * 我第一版把采样放在 saveViaNativeDialog 内部，真机表现就是「对话框明明弹了却找不到」。
   */
  dialogBaseline?: string[];
  deps?: Partial<ExportArtifactDeps>;
}

export interface ExportArtifactDeps {
  /** 处理原生保存对话框（地址栏输入目录 + 点保存）；返回是否成功。基线由调用方透传 */
  saveViaNativeDialog: (input: {
    targetDir: string;
    fileName: string;
    ownerPids: number[];
    budgetMs: number;
    baseline: string[];
  }) => Promise<{ ok: boolean; message?: string }>;
  listFiles: (dir: string) => ExportedFile[];
  extractZip: (zipPath: string, targetDir: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_DEPS: ExportArtifactDeps = {
  saveViaNativeDialog: async (input) => {
    const { saveFileViaNativeDialog } = await import("./dialog.js");
    return saveFileViaNativeDialog(input);
  },
  listFiles: (dir) => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => {
          const st = fs.statSync(path.join(dir, e.name));
          return { name: e.name, size: st.size, mtimeMs: st.mtimeMs };
        });
    } catch {
      return [];
    }
  },
  extractZip: async (zipPath, targetDir) => {
    const cmd = zipExtractCommand(zipPath, targetDir);
    await execFileAsync(cmd.file, cmd.args, { windowsHide: true, timeout: 120_000 });
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface ExportArtifactOutcome {
  ok: boolean;
  /** 落到目标目录的产物文件名（zip 方式指压缩包本身） */
  artifact?: string;
  /** 解压后的入口 HTML（zip 方式才有） */
  entry?: string;
  message?: string;
}

/**
 * 执行导出：点导出 → 选方式 → 处理原生保存对话框 → 等产物 → （zip）解压。
 *
 * 判据纪律：**产物真的出现在目标目录**才算成功（只点按钮不算）——
 * 真机上「菜单点了、对话框关了、文件却没来」是常态（默认目录是「下载」）。
 */
export async function exportArtifact(input: ExportArtifactInput): Promise<ExportArtifactOutcome> {
  const { page, kind, targetDir, ownerPids, budgetMs, logger } = input;
  const deps: ExportArtifactDeps = { ...DEFAULT_DEPS, ...input.deps };

  const url = await page.currentUrl().catch(() => "");
  const artifactName = exportedArtifactName(url);
  const fileName = exportedFileNameFor(kind, artifactName);
  const before = new Set(deps.listFiles(targetDir).map((f) => f.name));

  // 1) 打开导出菜单
  const opened = await page.clickByText("导出");
  if (opened.count !== 1 || !opened.clicked)
    return {
      ok: false,
      message: `「导出」按钮无法唯一点击（匹配 ${opened.count}）——页面可能不在设计文件视图`,
    };
  if (!(await page.waitForMenu(5_000)))
    return { ok: false, message: "点击「导出」后菜单未出现（浮层未展开或点击被吞）" };

  // 1.5) **把下载目录指到项目根**——必须在点菜单项之前（点完就开始下载，那时再设就晚了）。
  //      真机取证（2026-10-11）：0.24.1 是浏览器式下载，不弹保存对话框；
  //      不设这一步文件会落到默认「下载」目录，目标目录永远等不到产物。
  const dirSet = await page.setDownloadDir(targetDir).catch(() => false);
  if (!dirSet)
    logger.warn(
      "[opendesign] 设置下载目录失败（Page/Browser.setDownloadBehavior 均未成功）——产物可能落到浏览器默认下载目录",
    );
  else logger.info(`[opendesign] 已把下载目录指向：${targetDir}`);

  // 2) 点导出方式
  const itemText = exportItemText(kind);
  const item = await page.clickMenuItem(itemText);
  if (!item.clicked)
    return {
      ok: false,
      message: `未找到导出方式「${itemText}」${
        item.available.length ? `；当前可见项：${item.available.join("、")}` : ""
      }`,
    };

  // 3) 原生保存对话框：**只有浏览器式下载没生效时才需要**，故降级为可选兜底。
  //
  //    真机取证（2026-10-11）：0.24.1 是浏览器式下载——`setDownloadDir` 之后点菜单项，
  //    文件**直接落盘**到目标目录，**不弹**保存对话框（点完只出现一个无子控件的 `blob:` 空壳窗口）。
  //    那种情况下若把 saveViaNativeDialog 当必需步骤，它会因为找不到对话框而失败，
  //    整个导出就被它拦死——而这恰恰是最常见的正常路径。
  //
  //    所以：先给一个**短预算**试对话框；失败不 return，继续走「等产物落盘」——
  //    产物是否真的出现在目标目录才是唯一成败判据（见下方 step 4）。
  const saved = await deps
    .saveViaNativeDialog({
      targetDir,
      fileName,
      ownerPids,
      budgetMs: Math.min(budgetMs, 8_000),
      baseline: input.dialogBaseline ?? [],
    })
    .catch((error: unknown) => ({ ok: false, message: String(error) }));
  if (!saved.ok)
    logger.info(
      `[opendesign] 未出现原生保存对话框（${saved.message ?? "未知"}）——按浏览器式下载处理，改等产物直接落盘`,
    );

  // 4) 等产物真的落到目标目录（只点按钮不算）
  const deadline = Date.now() + budgetMs;
  let artifact: string | null = null;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await deps.sleep(500);
    artifact = pickExportedArtifact(
      kind,
      deps.listFiles(targetDir).filter((f) => !before.has(f.name)),
    );
    if (artifact) break;
  }
  if (!artifact)
    return {
      ok: false,
      message: `导出后 ${budgetMs}ms 内目标目录未出现产物（期望 ${fileName}）；产物可能仍落在「下载」目录`,
    };
  logger.info(`[opendesign] 导出产物已落地：${path.join(targetDir, artifact)}`);

  // 5) zip 方式：解压到项目根，并推出可静态服务的入口
  if (kind !== "zip") return { ok: true, artifact };

  const zipPath = path.join(targetDir, artifact);
  try {
    await deps.extractZip(zipPath, targetDir);
  } catch (error) {
    return {
      ok: false,
      artifact,
      message: `解压 ${artifact} 失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const entry = pickExportedArtifact(
    "html",
    deps.listFiles(targetDir).filter((f) => !before.has(f.name)),
  );
  logger.info(`[opendesign] 已解压 ${artifact}${entry ? `，入口 ${entry}` : "（未发现 html 入口）"}`);
  return { ok: true, artifact, entry: entry ?? undefined };
}

/**
 * 从产物 URL 解析 `projectId`。真机形态：
 * `od://app/projects/b05eef18-5d01-476f-a9bf-2b1facbd9842/conversations/<id>/files/onboarding-guide.html`
 *
 * 有了它就不必驱动那个原生保存对话框 —— 产物本来就在
 * `<dataRoot>/projects/<projectId>/` 下（真机实测 2026-09-28）。
 */
export function projectIdFromUrl(url: string): string | null {
  const m = /^od:\/\/app\/projects\/([^/?#]+)/i.exec((url ?? "").trim());
  return m?.[1] ?? null;
}

export interface ArtifactMeta {
  /** 产物入口文件名（相对项目目录） */
  entry: string;
  status: string;
}

/**
 * 解析 `.artifact.json`。真机内容：
 * `{ version:1, kind:"html", entry:"onboarding-guide.html", status:"complete", exports:["html","pdf","zip"] }`
 * 缺 `entry` / 非对象 / 数组一律返回 null（不猜文件名）。
 */
export function artifactEntryFromJson(json: unknown): ArtifactMeta | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  const entry = typeof o.entry === "string" ? o.entry.trim() : "";
  const status = typeof o.status === "string" ? o.status.trim() : "";
  if (!entry) return null;
  return { entry, status };
}

/** 产物是否就绪：`status === "complete"` 且 `entry` 非空（未完成的产物不能拿去验收） */
export function isArtifactReady(meta: ArtifactMeta | null): boolean {
  return Boolean(meta && meta.entry && meta.status === "complete");
}

/** 产物所在项目目录：`<dataRoot>/projects/<projectId>` */
export function artifactProjectDir(dataRoot: string, projectId: string): string {
  return path.join(dataRoot, "projects", projectId);
}

/** 路径归一：斜杠统一、去尾斜杠、Windows 大小写不敏感 */
function normPath(value: string): string {
  return (value ?? "").trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/**
 * 保存对话框的**地址栏是否已到目标目录** —— 这一步的判据，决定「产物会落到哪」。
 *
 * 真机取证（2026-09-28）：对话框默认停在「此电脑 > 下载」，**只填文件名框不会改变保存位置**
 * （用户截图里文件名已填好、地址栏仍是「下载」，产物因此一直落在下载目录）。
 * 所以必须在地址栏导航到目标目录，并**回读确认**——只设值不算到达。
 *
 * 两种显示形态都要认：
 * - 纯路径：`D:\Trae项目\AI游戏\test`（严格相等；**父级不算到达**）
 * - 面包屑：`此电脑 > 软件(D:) > Trae项目 > AI游戏 > test`（逐段比对尾部，"此电脑"段忽略）
 */
export function addressBarMatches(shown: string | undefined, targetDir: string): boolean {
  const raw = (shown ?? "").trim();
  if (!raw) return false;
  const target = normPath(targetDir);
  if (!target) return false;

  // 纯路径形态：严格相等（父级目录不能用 startsWith 放行，否则会存到上一层）
  if (!raw.includes(">")) return normPath(raw) === target;

  // 面包屑形态：按段比对目标路径的**尾部**
  const segs = raw
    .split(/\s*>\s*/)
    .map((s) => normPath(s))
    .filter((s) => s && s !== "此电脑" && s !== "this pc" && s !== "桌面" && s !== "desktop");
  // 「桌面」是快捷入口而非真实路径段，混进来会让段数对不上；真到桌面时纯路径分支会兜住
  if (!segs.length) return false;

  const targetSegs = target.split("\\").filter(Boolean);
  if (segs.length > targetSegs.length) return false;
  const tail = targetSegs.slice(targetSegs.length - segs.length);
  return segs.every((seg, i) => {
    const want = tail[i] ?? "";
    // 盘符段可能显示成「软件(d:)」「系统(c:)」→ 取括号里的盘符
    const drive = /\(([a-z]:)\)/.exec(seg)?.[1];
    const value = drive ?? seg;
    return value === want;
  });
}

/**
 * 保存对话框脚本的源码（供回归测试断言**结构性契约**）。
 *
 * 为什么把源码暴露出来测：真机上两次踩的是**同一类**坑 ——
 * ① 只填文件名框 → 保存位置没变（地址栏还在「下载」，产物落到下载目录）；
 * ② 用 SendKeys/SetForegroundWindow 操作地址栏 → 后台 MCP 子进程调 SetForegroundWindow
 *    会被 Windows 拒绝，地址栏永远拿不到焦点，空转到超时。
 * 这两条无法用单次行为断言覆盖，但可以钉住「脚本必须用 UIA 且不得依赖前台」。
 */
export function saveDialogScriptSource(): string {
  return WINDOWS_SAVE_DIALOG_SCRIPT;
}
