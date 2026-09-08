/**
 * TraeWork UI 选择器表（开发计划 §4.6）。
 *
 * 集中管理所有 DOM 选择器，每个语义键给「主选择器 + 回退候选」。
 * - 实测结论（2026-09-08，Trae SOLO CN v1.107.1）标注 verified
 * - 支持 profile.gui.selectors 覆盖（UI 升级漂移时无需改代码）
 * - 主选择器未命中时按顺序尝试回退；全部失败由调用方抛诊断错误
 */

export interface SelectorSpec {
  /** 主选择器 */
  primary: string;
  /** 回退候选（按顺序尝试） */
  fallbacks: string[];
  /** 是否已在本机实测 */
  verified: boolean;
  /** 说明 */
  note: string;
}

export type SelectorKey =
  | "chatInput"
  | "newTask"
  | "taskListItem"
  | "taskListGroupName"
  | "modeTab"
  | "modelTrigger"
  | "modelTriggerValue"
  | "modelOption"
  | "modelList"
  | "modeSwitcher"
  | "projectButton"
  | "cascadeMenu"
  | "cascadeMenuItem"
  | "cascadeMenuItemTitle"
  | "cascadeMenuItemSubtitle"
  | "cascadeMenuGroupHeader"
  | "cascadeMenuFooter"
  | "messageContainer"
  | "toolCard";

export const SELECTORS: Record<SelectorKey, SelectorSpec> = {
  chatInput: {
    primary: ".chat-input-v2-input-box-editable",
    fallbacks: [".solo-lite-chat-input-field", '[contenteditable="true"][class*="chat-input"]'],
    verified: true,
    note: "聊天输入框（contenteditable）；发送前 focus + Input.insertText",
  },
  newTask: {
    primary: ".task-list-new-task-item",
    fallbacks: ["[class*='task-list-new-task']", "[class*='new-task-item']"],
    verified: true,
    note: "侧边栏「新建任务」；每任务开干净会话",
  },
  taskListItem: {
    // 实机 1.107.1：会话标题是 .taskText；任务列表按项目分组（.task-list-group-name）
    primary: ".taskText",
    fallbacks: [".solo-lite-task-item", '[class*="task-item-text"]'],
    verified: true,
    note: "任务列表中的会话标题（.taskText）；注意 .task-list-new-task-item 是「新建任务/插件市场」等按钮，不可当会话项",
  },
  taskListGroupName: {
    // 实机：侧边栏按项目文件夹分组，组名即项目名（图1 的 docode-s3 / zhiyu）
    primary: ".task-list-group-name",
    fallbacks: ['[class*="task-list-group-name"]'],
    verified: true,
    note: "任务列表的项目分组名（= 项目文件夹名称）",
  },
  modeTab: {
    primary: '[class*="mode-switcher-btn"] [class*="tab"]',
    fallbacks: ["[class*='mode-switcher'] [class*='tab']"],
    verified: true,
    note: "模式切换分段（Work/Code/Design）；项目文件夹按钮仅在 Work 模式出现",
  },
  modelTrigger: {
    primary: ".core-model-select-trigger",
    fallbacks: ["[class*='model-select-trigger']"],
    verified: true,
    note: "模型下拉触发器；坐标点击用",
  },
  modelTriggerValue: {
    primary: ".core-model-select-trigger-value",
    fallbacks: ["[class*='model-select-trigger'] [class*='value']"],
    verified: true,
    note: "当前模型显示名；切换后严格验证",
  },
  modelOption: {
    primary: ".core-model-select-model-item",
    fallbacks: ["[class*='model-select-model-item']"],
    verified: true,
    note: "下拉模型项（虚拟滚动，需逐步滚动收集）",
  },
  modelList: {
    primary: ".core-model-select-model-list",
    fallbacks: ["[class*='model-select-model-list']"],
    verified: true,
    note: "模型下拉滚动容器",
  },
  modeSwitcher: {
    primary: '[class*="mode-switcher-btn"]',
    fallbacks: ["[class*='mode-switcher']"],
    verified: true,
    note: "Work/Code/Design 形态切换器（agent 形态检测用）",
  },
  projectButton: {
    // 实测（1.107.1）：未绑定项目时类名含 projectButtonPlaceholder*（文本「选择文件夹（可选）」）。
    // 已绑定时该 placeholder 类消失，变成普通 inputBarButton（文本=项目名）。
    // 因此这里只认 placeholder 形态；「已绑定」判定与选择由 session.ts 按文本处理
    // （同排还有文本为「本地」的 inputBarButton，不能用宽选择器）。
    primary: '[class*="projectButtonPlaceholder"]',
    fallbacks: ["[class*='projectButton']", "[class*='folderButton']"],
    verified: true,
    note: "图2 项目按钮（未绑定态）；已绑定态由 session.ts 按文本识别",
  },
  cascadeMenu: {
    primary: '[class*="cascadeMenu"]',
    fallbacks: ["[class*='cascade-menu']", "[class*='dropdown-menu']"],
    verified: true,
    note: "图2 项目文件夹下拉浮层",
  },
  cascadeMenuItem: {
    // 实机：真实项带 WithSubtitle 类；内层 cascadeMenuItemInner/Title/Subtitle 会被前缀选择器误命中，
    // 故主选择器要求 WithSubtitle，回退时由代码按「是否为内层」过滤。
    primary: '[class*="cascadeMenuItemWithSubtitle"]',
    fallbacks: ['[class*="cascadeMenuItem"]'],
    verified: true,
    note: "下拉中的项目项（含标题+副标题路径）；勿把 cascadeMenuItemInner/Title/Subtitle 当项",
  },
  cascadeMenuItemTitle: {
    primary: '[class*="cascadeMenuItemTitle"]',
    fallbacks: ['[class*="item-title"]'],
    verified: true,
    note: "项目项标题（项目名）",
  },
  cascadeMenuItemSubtitle: {
    primary: '[class*="cascadeMenuItemSubtitle"]',
    fallbacks: ['[class*="item-subtitle"]'],
    verified: true,
    note: "项目项副标题（项目绝对路径）",
  },
  cascadeMenuGroupHeader: {
    primary: '[class*="cascadeMenuGroupHeader"]',
    fallbacks: ['[class*="cascadeMenuGroupTitle"]'],
    verified: true,
    note: "分组标题（如「最近」）",
  },
  cascadeMenuFooter: {
    // 实机 1.107.1：底部「选择文件夹」是 BUTTON.cascadeFooterButton-ISVymP（内层 DIV.cascadeFooter-gPXKNi）
    primary: '[class*="cascadeFooterButton"]',
    fallbacks: ['[class*="cascadeFooter"]', '[class*="cascadeMenuFooter"]', '[class*="footer"] [class*="utton"]'],
    verified: true,
    note: "下拉底部「选择文件夹」按钮（点击后弹 Windows 原生对话框）；注意 click() 可能不触发原生弹窗，需确认对话框真的出现",
  },
  messageContainer: {
    primary: ".message-list-cache-container",
    fallbacks: ["[class*='message-list']"],
    verified: true,
    note: "消息容器；新会话发消息后出现",
  },
  toolCard: {
    primary: ".core-toolcall-base-card,.core-run-command-card,.core-web-search-card,.core-mcp-content",
    fallbacks: ["[class*='toolcall']", "[class*='run-command']"],
    verified: true,
    note: "Trae 原生工具卡片；用于检测 agent 形态执行痕迹",
  },
};

/** 选择器覆盖表：语义键 → 单个选择器（来自 profile.gui.selectors） */
export type SelectorOverrides = Partial<Record<SelectorKey, string>>;

/** 解析某语义键的候选列表（覆盖值优先，其后主选择器与回退） */
export function resolveSelectors(key: SelectorKey, overrides?: SelectorOverrides): string[] {
  const spec = SELECTORS[key];
  if (!spec) throw new Error(`未知选择器语义键: ${key}`);
  const override = overrides?.[key];
  const list = override ? [override, ...spec.fallbacks, spec.primary] : [spec.primary, ...spec.fallbacks];
  // 去重且保序
  return [...new Set(list.filter(Boolean))];
}

/** 生成「按候选顺序查找元素」的页面内表达式片段 */
export function candidateArrayExpr(key: SelectorKey, overrides?: SelectorOverrides): string {
  return JSON.stringify(resolveSelectors(key, overrides));
}
