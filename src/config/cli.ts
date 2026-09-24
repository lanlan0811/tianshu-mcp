/**
 * `tianshu-mcp config …` CLI 子命令（issue #20）。
 *
 * 目的：三级继承（全局 / 项目 / 任务级覆盖）生效后，「最终到底用了哪几层、每层贡献了什么」
 * 必须可查——否则排障只能靠猜。输出走 `console.log`，**绝不触碰协议 stdout**
 * （与 `visual/cli.ts` 同一约定；本命令在创建 MCP server 之前返回）。
 *
 * 不挂在 `visual` 命名空间下：`acceptance.json` 是验收引擎的配置，视觉验收只是共用一个文件，
 * 混进 visual 会误导使用者。
 *
 * 用法：
 *   tianshu-mcp config acceptance [projectPath] [--task <taskId>]
 */
import path from "node:path";
import { readAcceptanceLayer } from "../visual/config.js";
import { resolveAcceptanceLayers, summarizeResolved, type AcceptanceLayer } from "./acceptance-merge.js";
import { resolveDataHome } from "./store.js";
import { readJsonSafe } from "../util/fs.js";
import type { PartialAcceptanceConfig } from "./schema.js";
import type { TaskMeta } from "../tasks/task.js";

export async function runConfigCli(args: string[]): Promise<void> {
  const [scope, ...rest] = args;
  if (scope !== "acceptance") {
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: `未知的 config 子命令: ${scope ?? "(空)"}`,
          usage: [
            "tianshu-mcp config acceptance [projectPath] [--task <taskId>]",
            "",
            "打印验收配置三级继承（全局 / 项目 / 任务级覆盖）的生效情况与最终取值。",
          ],
        },
        null,
        2,
      ),
    );
    return;
  }
  const result = await inspectAcceptance(rest);
  console.log(JSON.stringify(result, null, 2));
}

export interface AcceptanceInspection {
  ok: boolean;
  project?: string;
  taskId?: string;
  layers: {
    source: string;
    path: string;
    present: boolean;
    config?: PartialAcceptanceConfig;
    error?: { code: string; message: string };
  }[];
  /** 实际参与合并的层（低 → 高） */
  appliedOrder: string[];
  effective: {
    checks: number | "（默认集）";
    requireChanges: boolean | "（默认 true）";
    verifyConcurrency: number | "（继承 server config）";
    visual: "已覆盖" | "（未配置）";
  };
  summary: string;
  error?: string;
}

/** 解析 `[projectPath] [--task <taskId>]`（顺序无关，两者都可省） */
function parseArgs(rest: string[]): { projectPath?: string; taskId?: string; error?: string } {
  let projectPath: string | undefined;
  let taskId: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--task") {
      taskId = rest[i + 1];
      if (!taskId) return { error: "--task 需要一个 taskId 参数" };
      i++;
    } else if (a.startsWith("--")) {
      return { error: `未知选项: ${a}` };
    } else if (projectPath === undefined) {
      projectPath = a;
    } else {
      return { error: `多余的参数: ${a}` };
    }
  }
  return { projectPath, taskId };
}

/**
 * 收集并解析三层配置。**不抛错**：某层写坏时把错误放进该层的 `error` 字段并让整体
 * `ok: false`，这样调试命令仍然能把「是哪一层坏了」显示出来（而不是只吐一句异常）。
 */
export async function inspectAcceptance(rest: string[]): Promise<AcceptanceInspection> {
  const parsed = parseArgs(rest);
  if (parsed.error) {
    return { ok: false, error: parsed.error, layers: [], appliedOrder: [], effective: emptyEffective(), summary: "" };
  }
  const home = resolveDataHome();
  const globalPath = path.join(home, "acceptance.default.json");
  const projectPath = parsed.projectPath ? path.resolve(parsed.projectPath) : undefined;
  const projectFile = projectPath ? path.join(projectPath, ".tianshu-mcp", "acceptance.json") : undefined;

  const layers: AcceptanceInspection["layers"] = [];
  let taskError: string | undefined;

  // 层的 label 统一用 source 名（global / project）：它与 CLI 输出的 source 字段、
  // 以及验收引擎报错文案里的层名同源，便于按字符串定位是哪一层出了问题。
  const global = await readLayerInto(layers, "global", globalPath);
  const project = projectFile
    ? await readLayerInto(layers, "project", projectFile)
    : (layers.push({ source: "project", path: "（未提供 projectPath）", present: false }),
      undefined);

  // 任务级覆盖来自任务快照（issue #20 把 override 持久化在 TaskMeta 上）
  let override: PartialAcceptanceConfig | undefined;
  if (parsed.taskId) {
    const metaPath = path.join(home, "tasks", parsed.taskId, "task.json");
    const meta = await readJsonSafe<TaskMeta>(metaPath);
    if (!meta) {
      layers.push({ source: "override", path: metaPath, present: false });
      taskError = `任务快照不可读或不存在: ${parsed.taskId}`;
    } else {
      override = meta.acceptanceOverride;
      layers.push({
        source: "override",
        path: `${metaPath}（TaskMeta.acceptanceOverride）`,
        present: override !== undefined,
        ...(override ? { config: override } : {}),
      });
    }
  } else {
    layers.push({ source: "override", path: "（未提供 --task，无任务级覆盖）", present: false });
  }

  const mergedLayers: AcceptanceLayer[] = [
    { source: "global", path: globalPath, config: global },
    { source: "project", path: projectFile ?? "（未提供）", config: project },
    { source: "override", path: "TaskMeta.acceptanceOverride", config: override },
  ];
  const resolved = resolveAcceptanceLayers(mergedLayers);
  const anyLayerError = layers.some((l) => l.error);
  const ok = !anyLayerError && !taskError;
  return {
    ok,
    ...(projectPath ? { project: projectPath } : {}),
    ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
    layers,
    appliedOrder: resolved.applied.map((a) => a.source),
    effective: {
      checks: resolved.config.checks ? resolved.config.checks.length : "（默认集）",
      requireChanges: resolved.config.requireChanges ?? "（默认 true）",
      verifyConcurrency: resolved.config.verifyConcurrency ?? "（继承 server config）",
      visual: resolved.config.visual ? "已覆盖" : "（未配置）",
    },
    summary: summarizeResolved(resolved),
    ...(taskError ? { error: taskError } : {}),
  };
}

async function readLayerInto(
  layers: AcceptanceInspection["layers"],
  source: string,
  absPath: string,
): Promise<PartialAcceptanceConfig | undefined> {
  try {
    const config = await readAcceptanceLayer(absPath, source);
    layers.push({
      source,
      path: absPath,
      present: config !== null,
      ...(config ? { config } : {}),
    });
    return config ?? undefined;
  } catch (e) {
    // 该层写坏/读不了：如实登记为错误层，其余层继续解析（调试命令的价值正在于此）
    layers.push({
      source,
      path: absPath,
      present: true,
      error: {
        code: (e as { code?: string }).code ?? "CONFIG_ERROR",
        message: e instanceof Error ? e.message : String(e),
      },
    });
    return undefined;
  }
}

function emptyEffective(): AcceptanceInspection["effective"] {
  return {
    checks: "（默认集）",
    requireChanges: "（默认 true）",
    verifyConcurrency: "（继承 server config）",
    visual: "（未配置）",
  };
}
