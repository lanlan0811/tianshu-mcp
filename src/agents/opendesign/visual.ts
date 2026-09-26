/**
 * Open Design 产物的视觉验收「页面来源」推导（计划 P6 / 步 10）。
 *
 * 背景：视觉验收引擎本身是既有的（`src/visual/*`），它需要项目里给出**可截图的页面来源**。
 * Open Design 生成的是设计稿（HTML/CSS/JS 静态产物，或一个带 dev server 的工程），
 * 因此适配器要能判断「这个项目根该怎么起预览」，并把结论**如实回报**给编排方。
 *
 * 两条纪律（都很重要）：
 * 1. **不静默改项目配置**：本模块只**推导建议**，绝不写 `.tianshu-mcp/acceptance.json`。
 *    验收配置显式化是仓库既有原则；偷偷补一份配置会让「验收口径」变成隐藏状态。
 * 2. **推导不出来就明说**：找不到入口时返回 `configured:false` 并给出可操作提示，
 *    由调用方转 `needs_user`——不猜、不硬编码 `/index.html`。
 */
import fs from "node:fs";
import path from "node:path";

/** 单页静态入口候选（按优先级排列；`route` 是预览服务下的访问路径） */
export interface StaticPageCandidate {
  /** 项目内相对路径（正斜杠） */
  relPath: string;
  /** 建议的访问路由（以 `/` 开头） */
  route: string;
  /** 命中的判据说明（写进事件流，便于人工复核） */
  reason: string;
}

export interface VisualPageHint {
  /** 是否推导出可用的页面来源 */
  configured: boolean;
  /** 建议的页面来源类型（对应 `.tianshu-mcp/acceptance.json` 的 `visual.pages[].source.type`） */
  sourceType?: "static" | "command";
  /** static 形态：作为静态根的路径（项目相对） */
  root?: string;
  /** 供人工配置参考的候选入口 */
  candidates: StaticPageCandidate[];
  /** 面向人的说明（推导成功给用法，失败给可操作提示） */
  message: string;
}

/** 常见入口文件名（按优先级）：不含任何用户/项目特定字符串 */
const ENTRY_NAMES = ["index.html", "main.html", "home.html", "prototype.html", "preview.html"];

/** 扫描时跳过的目录（依赖/产物噪声，且可能极大） */
const SKIP_DIRS = new Set(["node_modules", ".git", ".tianshu-mcp", ".opendesign", "dist", "build"]);

/** 扫描深度上限：设计稿产物通常很浅；深挖只会拖慢且更易误判 */
const MAX_DEPTH = 3;

/** 单次扫描的目录访问上限（防御性：异常工程结构不应把适配器拖死） */
const MAX_DIRS = 500;

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * 在项目根内查找可直接静态服务的设计稿入口。
 *
 * 只做**只读**遍历；跳过依赖与已知产物目录（`dist`/`build` 由调用方按需显式指定，
 * 不在自动推导里猜——猜产物目录最容易指向过期文件）。
 */
export function findStaticEntries(projectPath: string): StaticPageCandidate[] {
  const out: StaticPageCandidate[] = [];
  const seenDirs: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: projectPath, depth: 0 }];
  while (queue.length && seenDirs.length < MAX_DIRS) {
    const current = queue.shift()!;
    seenDirs.push(current.dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const dirs: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        dirs.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rank = ENTRY_NAMES.indexOf(entry.name.toLowerCase());
      if (rank < 0) continue;
      const relPath = toPosix(path.relative(projectPath, full));
      out.push({
        relPath,
        route: `/${relPath}`,
        reason: `命中入口文件名 \`${entry.name}\`（深度 ${current.depth}）`,
      });
    }
    // 广度优先 + 深度上限：浅层入口优先，且不会深挖依赖树
    if (current.depth + 1 <= MAX_DEPTH)
      for (const dir of dirs) queue.push({ dir, depth: current.depth + 1 });
  }
  // 入口文件名优先级 + 层级浅优先
  const rankOf = (c: StaticPageCandidate): number => {
    const name = c.relPath.split("/").at(-1)!.toLowerCase();
    const nameRank = ENTRY_NAMES.indexOf(name);
    return nameRank * 100 + c.relPath.split("/").length;
  };
  return out.sort((a, b) => rankOf(a) - rankOf(b));
}

/** 项目根是否存在可起预览服务的工程（package.json 里有 scripts，或含常见框架配置） */
export function hasPreviewableProject(projectPath: string): boolean {
  const markers = [
    "package.json",
    "vite.config.ts",
    "vite.config.js",
    "next.config.js",
    "next.config.mjs",
    "astro.config.mjs",
    "index.html",
  ];
  return markers.some((m) => {
    try {
      return fs.existsSync(path.join(projectPath, m));
    } catch {
      return false;
    }
  });
}

/**
 * 推导视觉验收的页面来源建议。
 *
 * 顺序：先看静态入口（最确定），再看是否存在可起预览服务的工程（交由人工确认启动命令）。
 * **两种都不成立时返回 configured:false**，绝不硬编码 `/index.html`。
 */
export function suggestVisualPages(projectPath: string): VisualPageHint {
  const candidates = findStaticEntries(projectPath);
  if (candidates.length) {
    const best = candidates[0]!;
    // 静态根取入口文件所在目录；根目录下的入口直接用 "." 表示项目根
    const rootDir = path.posix.dirname(best.relPath);
    const root = rootDir === "." ? "." : rootDir;
    return {
      configured: true,
      sourceType: "static",
      root,
      candidates,
      message:
        `推导出静态入口 \`${best.relPath}\`（${best.reason}）。` +
        `建议在 .tianshu-mcp/acceptance.json 配置：` +
        `visual.pages=[{id:"home",source:{type:"static",root:"${root}"},route:"${best.route}"}]。` +
        `**本适配器不会自动修改项目配置**——请人工确认后写入。`,
    };
  }
  if (hasPreviewableProject(projectPath)) {
    return {
      configured: false,
      sourceType: "command",
      candidates: [],
      message:
        "未找到可直接静态服务的设计稿入口（index.html 等），但项目根存在可起预览服务的工程结构。" +
        '请人工在 .tianshu-mcp/acceptance.json 配置 `source.type="command"`（含显式端口与 readyUrl）。' +
        "本适配器不猜启动命令。",
    };
  }
  return {
    configured: false,
    candidates: [],
    message:
      "未在项目内找到设计稿入口（index.html / main.html / home.html / prototype.html / preview.html），" +
      "也未发现可起预览服务的工程结构。视觉验收需要可截图的页面来源：" +
      "请在 .tianshu-mcp/acceptance.json 显式配置 `visual.pages`（static / command / existing 任一形态）。",
  };
}
