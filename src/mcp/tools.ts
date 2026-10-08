/**
 * 工具注册表：8 个工具的 name/description/inputSchema/capability/approval 元数据。
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
  RunTaskWireSchema,
  QueryTaskParamsSchema,
  VerifyTaskWireSchema,
  ManageTaskParamsSchema,
  QueryInfoParamsSchema,
  WaitTaskMergedParamsSchema,
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
    name: "run_task",
    description:
      "派活：启动外部 AI-Agent 开发任务并可自动验收返修，异步返回 taskId。ZCode 要求 model=供应商/模型，不支持 mode；TraeWork 的 model 可选并支持 Work/Code/Design mode。task/context 内的 ZCode 项目路径引用会在发送前校验。Qoder CN 要求已有 projectPath 和可读 planDoc；modelSource 可选 default/custom，省略模型或等级则沿用当前设置。思考等级通过模型管理保存为全局偏好，权限模式不变；macOS research 禁止派发。可选 idempotencyKey（1..128 字符）：同一 key 在 TTL（默认 24h）内重复提交恒返回原 taskId 与当前状态、不新建任务，参数变更则报冲突——重试请复用同一 key。 " +
      "可选 dryRun=true 进入干跑模式（先审后做）：agent 只分析规划、输出将要修改的文件清单与方案、不动源码；验收引擎只做静态分析（引用文件是否存在、拟改位置是否存在、明显逻辑冲突），跳过 typecheck/test/build。dryRun 需提供 projectPath、忽略 autoVerify、不进入自动返修；产物为独立报告（meta.dryRunReportFiles，不消耗验收轮次）与方案文档（meta.dryRunPlanDoc，可直接作为后续正式任务的 planDoc）。默认关闭。",
    inputSchema: RunTaskWireSchema,
    capability: "write",
    requireApproval: true,
  },
  {
    name: "query_task",
    description:
      "查询任务状态 / 进度 / 最近日志尾部（默认 agent.log 末 40 行）/ 最近细粒度事件。返回任务 meta 与日志片段。" +
      "meta.recentEvents 为最近 N 条 agent 事件（eventLimit 缺省 10、上限 50），" +
      "取值 task_dispatched / confirmation_dialog_detected / awaiting_user_authorization / " +
      "file_modification_started / rework_triggered —— 长任务下可据此区分「正常执行」与「卡在弹窗等人」。" +
      "未实现事件上报的适配器该数组为空，其余字段不变。",
    inputSchema: QueryTaskParamsSchema,
    capability: "read",
    requireApproval: false,
  },
  {
    name: "manage_task",
    description:
      "任务生命周期管理（合并原 cancel_task / continue_task / rework_task），用 action 区分：" +
      "action=cancel 取消运行中任务（CLI 终止进程树；GUI 点击界面停止按钮并等待空闲，未确认停止时结果中明示。排队中任务直接移除。对已终态的 GUI 任务兼任人工确认入口：核实窗口无残留运行后调用可清除 guiStopUnconfirmed 标记）——" +
      "可选 reason 为取消原因；" +
      "action=continue 恢复 needs_user 状态的任务（message 必填）：zcode 在 agent_question 时把 message 发往原会话，关闭旧实例/登录/系统权限场景中 message 仅作已处理确认；codex 的 user_confirmation 重新接入观察（不发送消息）、login_required 复检环境后重发任务书；qoder 通过专用答题控件回复，多题时 message 使用完整问题文字到答案的 JSON 对象。审批或环境处理后仅恢复观察，提交不明时禁止重发；" +
      "action=rework 手动返修终态任务（failed/needs_attention）重新入队续跑，同一 agent/项目与轮次记账：feedback 为追加指示（建议带上一次验收失败摘要），repairHint 为可选的结构化修复提示（自由字符串，上限 4000 字符）——写「文件:行 / 问题 / 做什么」，会以【结构化修复提示】块置于 feedback 之前，不传则行为不变。" +
      "注意：本工具含破坏性 action（cancel / rework）。",
    inputSchema: ManageTaskParamsSchema,
    capability: "write",
    requireApproval: true,
  },
  {
    name: "verify_task",
    description:
      "对已完成任务或项目路径执行一次验收（不改源码）：自动命令检查 + 代码分析（相对 git 基线）。可用 extraChecks 临时加验。需任务/项目二选一。可选 idempotencyKey：同一 key 重试不重跑验收——执行中的同键请求返回进行中提示，已完成的直接返回既有报告与轮次，参数变更则报冲突。",
    inputSchema: VerifyTaskWireSchema,
    capability: "execute",
    requireApproval: false,
  },
  {
    name: "query_info",
    description:
      "统一信息查询入口（合并原 list_tasks / get_task_report / get_profiles），用 type 区分：" +
      "type=tasks 列出历史任务（可按 projectPath / status 过滤，limit 默认 50、上限 200）；" +
      "type=report 取某轮验收报告全文 report.md（taskId 必填，round 0-based、缺省取最新一轮）；" +
      "type=profiles 查看当前 agent 适配与可执行探测结果（含未安装/调研占位提示）。",
    inputSchema: QueryInfoParamsSchema,
    capability: "read",
    requireApproval: false,
  },
  {
    name: "wait_task",
    description:
      "等待任务到达停点（阻塞只读原语，合并原 wait_task / wait_any）。" +
      "单任务模式：提供 taskId，轮询至终态（succeeded/failed/needs_attention/cancelled/interrupted）或 needs_user。" +
      "批量模式：提供 taskIds（1..20 个，开始前校验全部存在、缺一即报错），等待数组顺序首个到达停点者，返回其快照与全部任务当前状态。" +
      "两参数必须且只能提供一个。超时（timeoutMs 缺省 50000ms、上限 600000ms）后返回当前状态快照；" +
      "超时返回时请再次调用本工具继续等待——本调用不影响任务本体，超时/中断均无害。",
    inputSchema: WaitTaskMergedParamsSchema,
    capability: "read",
    requireApproval: false,
  },
];

export function findTool(name: string): ToolDef | undefined {
  return TOOL_DEFS.find((t) => t.name === name);
}
