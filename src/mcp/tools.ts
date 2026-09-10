/**
 * 工具注册表：8 个工具的 name/description/inputSchema/capability/approval 元数据。
 * MCP 层用 inputSchema 声明；capability/requireApproval 供天枢 policy（§5/§11.3）。
 * 能力标注遵守 R11：读/查询/验收 read；run/cancel/rework write + requireApproval。
 */
import { z } from "zod";
import {
  RunTaskParamsSchema,
  QueryTaskParamsSchema,
  ListTasksParamsSchema,
  GetReportParamsSchema,
  CancelTaskParamsSchema,
  VerifyTaskParamsSchema,
  ReworkTaskParamsSchema,
  ContinueTaskParamsSchema,
} from "../config/schema.js";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  capability: "read" | "write" | "execute" | "network";
  requireApproval: boolean;
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "continue_task",
    description:
      "恢复处于 needs_user 的 ZCode 任务。agent_question 时 message 会发往原会话；关闭旧实例、登录或系统权限场景中 message 仅作为已处理确认。",
    inputSchema: ContinueTaskParamsSchema,
    capability: "write",
    requireApproval: true,
  },
  {
    name: "run_task",
    description:
      "派活：启动一次外部 AI-Agent（codex CLI；traework 为 GUI 驱动）开发任务，可带自动验收与失败自动返修。返回 taskId，立即返回；用 query_task 轮询。projectPath 必须是存在的项目绝对路径；task 是给 agent 的自然语言任务书。可选 model（traework 用，如 GLM-5.3）与 mode（traework 面板模式 Work/Code/Design；缺省从任务书文本识别，识别不到则 Work）。",
    inputSchema: RunTaskParamsSchema,
    capability: "write",
    requireApproval: true,
  },
  {
    name: "query_task",
    description:
      "查询任务状态 / 进度 / 最近日志尾部（默认 agent.log 末 40 行）。返回任务 meta 与日志片段。",
    inputSchema: QueryTaskParamsSchema,
    capability: "read",
    requireApproval: false,
  },
  {
    name: "list_tasks",
    description: "列出历史任务（可按项目路径 / 状态过滤，limit 默认 50）。",
    inputSchema: ListTasksParamsSchema,
    capability: "read",
    requireApproval: false,
  },
  {
    name: "get_task_report",
    description: "取某轮验收报告全文（report.md）。round 缺省取最新一轮。",
    inputSchema: GetReportParamsSchema,
    capability: "read",
    requireApproval: false,
  },
  {
    name: "cancel_task",
    description: "取消运行中任务（kill 进程树）。排队中任务直接移除；终态任务无动作。",
    inputSchema: CancelTaskParamsSchema,
    capability: "write",
    requireApproval: true,
  },
  {
    name: "verify_task",
    description:
      "对已完成任务或项目路径执行一次验收（不改源码）：自动命令检查 + 代码分析（相对 git 基线）。可用 extraChecks 临时加验。需任务/项目二选一。",
    inputSchema: VerifyTaskParamsSchema,
    capability: "read",
    requireApproval: false,
  },
  {
    name: "rework_task",
    description:
      "手动返修：把终态任务（failed/needs_attention）重新入队续跑，同一 agent/项目与轮次记账。feedback 为追加指示（建议带上一次验收失败摘要）。",
    inputSchema: ReworkTaskParamsSchema,
    capability: "write",
    requireApproval: true,
  },
  {
    name: "get_profiles",
    description: "查看当前 agent 适配与可执行探测结果（含未安装/调研占位提示）。",
    inputSchema: z.object({}),
    capability: "read",
    requireApproval: false,
  },
];

export function findTool(name: string): ToolDef | undefined {
  return TOOL_DEFS.find((t) => t.name === name);
}
