/**
 * MCP 工具面镜像（GUI 侧内嵌清单）—— 「MCP 能力」视图的数据源。
 *
 * **真源**：`<repo>/src/mcp/tools.ts` 的 `TOOL_DEFS`。本文件是**镜像**，
 * 由 `mcp-gui/scripts/check-schema-parity.mjs` 强制与真源逐项一致
 * （名称 + capability + requireApproval 三元组按序比对，任一漂移即 `exit 1`）。
 *
 * 新增 / 改名 / 增删工具时：同步本文件，并在 `src/i18n/{zh-CN,en-US}.ts` 的
 * `capabilities.tools.<name>` 补一行说明——两包键集合由 `test/i18n.test.ts` 守住，
 * 说明缺失会在 `test/capabilities.test.ts` 直接报错（不静默返回空串）。
 *
 * 本清单**不读写文件系统、不连 MCP**：它是「工具面长什么样」的静态展示，
 * 与运行中的数据目录无关。
 */

/** 能力三族（与 MCP 的 R11 语义一致） */
export type ToolCapability = "read" | "write" | "execute";

export interface McpToolEntry {
  /** 工具名；与真源 `TOOL_DEFS[].name` 完全一致 */
  name: string;
  capability: ToolCapability;
  /** 是否需要宿主审批（真源 `TOOL_DEFS[].requireApproval` → `_meta.requireApproval`） */
  requireApproval: boolean;
}

/**
 * 工具面全量清单（8 个，v0.9.0 合并后）。
 * **顺序与 `src/mcp/tools.ts` 的 `TOOL_DEFS` 一致**，便于逐项比对。
 *
 * 合并映射：cancel/continue/rework → `manage_task`；list_tasks/get_task_report/get_profiles
 * → `query_info`；wait_task/wait_any → `wait_task`（增强）。
 */
export const MCP_TOOLS: readonly McpToolEntry[] = [
  { name: "prepare_visual_baseline", capability: "write", requireApproval: true },
  { name: "approve_visual_baseline", capability: "write", requireApproval: true },
  { name: "run_task", capability: "write", requireApproval: true },
  { name: "query_task", capability: "read", requireApproval: false },
  { name: "manage_task", capability: "write", requireApproval: true },
  { name: "verify_task", capability: "execute", requireApproval: false },
  { name: "query_info", capability: "read", requireApproval: false },
  { name: "wait_task", capability: "read", requireApproval: false },
] as const;

/** 三族的展示顺序（read → write → execute） */
export const CAPABILITY_FAMILIES: readonly ToolCapability[] = ["read", "write", "execute"];

/** 取某一族的工具（保持真源顺序） */
export function toolsInFamily(family: ToolCapability): McpToolEntry[] {
  return MCP_TOOLS.filter((tool) => tool.capability === family);
}
