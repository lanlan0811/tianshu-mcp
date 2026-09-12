/**
 * 工具注册表：9 个工具的 name/description/inputSchema/capability/approval 元数据。
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
      "恢复处于 needs_user 的任务。zcode：agent_question 时 message 发往原会话，关闭旧实例/登录/系统权限场景中 message 仅作已处理确认。codex：user_confirmation 时重新接入观察 GUI 内运行（不发送消息）；login_required 时复检环境后重发任务书。",
    inputSchema: ContinueTaskParamsSchema,
    capability: "write",
    requireApproval: true,
  },
  {
    name: "run_task",
    description:
      "派活：启动外部 AI-Agent 开发任务并可自动验收返修，异步返回 taskId。ZCode 要求 model=供应商/模型，不支持 mode；TraeWork 的 model 可选并支持 Work/Code/Design mode。task/context 内的 ZCode 项目路径引用会在发送前校验。",
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
    description:
      "取消运行中任务：CLI agent 终止进程树；GUI agent（codex 等）尽力点击界面停止按钮并等待 GUI 空闲（有界超时），未确认停止时结果中明示。排队中任务直接移除；终态任务无动作。",
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
