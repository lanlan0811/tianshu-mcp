/**
 * 工具注册表：11 个工具的 name/description/inputSchema/capability/approval 元数据。
 * MCP 层用 inputSchema 声明；capability/requireApproval 供天枢 policy（§5/§11.3）。
 * 能力标注遵守 R11（三族语义）：
 * - read：读/查询，无副作用；`server.ts` 据此推导 MCP `readOnlyHint: true`。
 * - write：派活/取消/返修/视觉基准写盘等有副作用操作，全部 requireApproval。
 * - execute：会执行项目侧命令（可产生构建产物），但不改源码；当前仅 `verify_task`，
 *   按 R11 仍免审批——`readOnlyHint` 会因此为 false，审批与否由 `_meta.requireApproval` 单独承载。
 */
import { z } from "zod";
import { PrepareBaselineSchema, ApproveBaselineSchema } from "../visual/baselines.js";
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
  capability: "read" | "write" | "execute";
  requireApproval: boolean;
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "prepare_visual_baseline",
    description: "准备视觉基准候选，返回摘要与预览；不采用正式基准。需要用户授权。",
    inputSchema: PrepareBaselineSchema,
    capability: "write",
    requireApproval: true,
  },
  {
    name: "approve_visual_baseline",
    description:
      "仅在用户明确审阅并授权后批准视觉基准。必须核对候选摘要与批准说明；自动返修禁止调用。宿主必须实施实际审批控制。",
    inputSchema: ApproveBaselineSchema,
    capability: "write",
    requireApproval: true,
  },
  {
    name: "continue_task",
    description:
      "恢复处于 needs_user 的任务。zcode：agent_question 时 message 发往原会话，关闭旧实例/登录/系统权限场景中 message 仅作已处理确认。codex：user_confirmation 时重新接入观察 GUI 内运行（不发送消息）；login_required 时复检环境后重发任务书。qoder：Agent 提问通过专用答题控件回复；多题 message 使用完整问题文字到答案的 JSON 对象。审批或环境处理后仅恢复观察，提交不明时禁止重发。",
    inputSchema: ContinueTaskParamsSchema,
    capability: "write",
    requireApproval: true,
  },
  {
    name: "run_task",
    description:
      "派活：启动外部 AI-Agent 开发任务并可自动验收返修，异步返回 taskId。ZCode 要求 model=供应商/模型，不支持 mode；TraeWork 的 model 可选并支持 Work/Code/Design mode。task/context 内的 ZCode 项目路径引用会在发送前校验。Qoder CN 要求已有 projectPath 和可读 planDoc；modelSource 可选 default/custom，省略模型或等级则沿用当前设置。思考等级通过模型管理保存为全局偏好，权限模式不变；macOS research 禁止派发。可选 idempotencyKey（1..128 字符）：同一 key 在 TTL（默认 24h）内重复提交恒返回原 taskId 与当前状态、不新建任务，参数变更则报冲突——重试请复用同一 key。",
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
      "取消运行中任务：CLI agent 终止进程树；GUI agent（codex 等）尽力点击界面停止按钮并等待 GUI 空闲（有界超时），未确认停止时结果中明示。排队中任务直接移除。对已处于终态的 GUI 任务，本调用兼任人工确认入口：人工核实窗口中已无残留运行后调用，可清除 meta 的 guiStopUnconfirmed 待确认标记（不改终态）。",
    inputSchema: CancelTaskParamsSchema,
    capability: "write",
    requireApproval: true,
  },
  {
    name: "verify_task",
    description:
      "对已完成任务或项目路径执行一次验收（不改源码）：自动命令检查 + 代码分析（相对 git 基线）。可用 extraChecks 临时加验。需任务/项目二选一。可选 idempotencyKey：同一 key 重试不重跑验收——执行中的同键请求返回进行中提示，已完成的直接返回既有报告与轮次，参数变更则报冲突。",
    inputSchema: VerifyTaskParamsSchema,
    capability: "execute",
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
