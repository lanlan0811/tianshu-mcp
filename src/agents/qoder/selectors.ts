/**
 * Qoder CN 选择器规范（issue #23：从扁平字符串升级为与 Codex 同构的分层结构）。
 *
 * 每个语义键给「主选择器 + 回退候选 + 文本/aria 候选 + verifiedVersion」。
 * 设计要点（保持向后兼容，勿改坏既有调用）：
 *  - `QODER_SELECTORS[key]` 不再直接是字符串，请用 `qoderCandidates()` 取候选列表，
 *    或 `qoderPrimary()` 取首选字符串。CDP 客户端的 `selector()` 仍返回字符串首选。
 *  - profile.gui.selectors 的覆盖值（单字符串）优先级最高，仍是唯一覆盖形态。
 *  - 实测版本记录在 `verifiedVersion`；未实测写「未实测」。
 *
 * 实测来源：`D:\Qoder CN`（2026-09-23，文件版本 0.3.4，与 issue #23 报告版本一致）。
 */

export interface QoderSelectorSpec {
  /** 主 CSS 选择器 */
  primary: string;
  /** 回退 CSS 选择器（按顺序尝试） */
  fallbacks: string[];
  /** 精确可见文本（中英，归一化比较） */
  texts?: string[];
  /** 精确 aria-label（中英，归一化比较） */
  ariaLabels?: string[];
  /** aria-label 正则源串（含动态名的模板） */
  ariaPatterns?: string[];
  /** 实测版本（未实测写「未实测」） */
  verifiedVersion: string;
  /** 说明 */
  note: string;
}

export const QODER_SELECTORS = {
  input: {
    primary: '[contenteditable="true"][aria-label]',
    fallbacks: ['[contenteditable="true"]', 'textarea[aria-label]'],
    verifiedVersion: '0.3.4',
    note: '任务输入框（contenteditable）；发送前 focus + Input.insertText',
  },
  newTask: {
    primary: '[data-e2e="chat.new"]',
    fallbacks: ['button[aria-label*="新任务"]', 'button[aria-label*="New task" i]'],
    texts: ['新的任务', '新任务', 'New task'],
    verifiedVersion: '0.3.4',
    note: '侧栏「新的任务」入口',
  },
  send: {
    primary: 'button[data-e2e="chat.send"][data-send-button="normal"]',
    fallbacks: ['button[aria-label*="发送"]', 'button[aria-label*="Send" i]'],
    verifiedVersion: '0.3.4',
    note: '发送按钮（normal 态）',
  },
  stop: {
    primary: 'button[data-e2e="chat.send"][data-send-button="generating"]',
    fallbacks: ['button[aria-label*="停止"]', 'button[aria-label*="Stop" i]'],
    verifiedVersion: '0.3.4',
    note: '停止按钮（generating 态）；权威运行信号',
  },
  conversationWorkspace: {
    primary: '[data-conversation-workspace][title]',
    fallbacks: ['[data-conversation-workspace]', 'button[aria-label="工作区"][title]'],
    verifiedVersion: '0.3.4',
    note: '会话已绑定工作区（title=完整路径）',
  },
  conversation: {
    primary: '[data-message-scroller-content]',
    fallbacks: ['[data-message-scroller]', '[data-conversation-content]'],
    verifiedVersion: '0.3.4',
    note: '消息滚动容器',
  },
  userMessage: {
    primary: '[data-message-kind="user"]',
    fallbacks: ['[data-message-role="user"]'],
    verifiedVersion: '0.3.4',
    note: '用户消息',
  },
  assistantMessage: {
    primary: '[data-message-kind="assistant"]',
    fallbacks: ['[data-message-role="assistant"]'],
    verifiedVersion: '0.3.4',
    note: '助手消息',
  },
  completed: {
    primary: '[data-assistant-actions]',
    fallbacks: ['[data-assistant-completed]'],
    verifiedVersion: '0.3.4',
    note: '本轮完成标志',
  },
  failed: {
    primary: '[data-turn-failure-card], [data-assistant-status-note="failed"]',
    fallbacks: ['[data-assistant-status-note="failed"]'],
    verifiedVersion: '0.3.4',
    note: '本轮失败标志',
  },
  interrupted: {
    primary: '[data-assistant-status-note="interrupted"]',
    fallbacks: ['[data-assistant-interrupted]'],
    verifiedVersion: '0.3.4',
    note: '本轮被打断标志',
  },
  question: {
    primary: '[data-pending-interaction-composer]',
    fallbacks: ['[data-pending-interaction]'],
    verifiedVersion: '0.3.4',
    note: 'Agent 原生提问（等待作答）',
  },
  approval: {
    primary: '[data-pending-interaction-overlay]',
    fallbacks: ['[data-pending-interaction-approval]'],
    verifiedVersion: '0.3.4',
    note: '用户确认浮层',
  },
  workspace: {
    // issue #23 真机重探（本机 0.3.4，2026-09-23）修正结论：
    //   0.3.4 页面同时存在 **两个** [data-workspace-picker-trigger] 按钮（输入栏 picker + 另一个同标记按钮），
    //   而生产 click() 在「可见匹配数 !== 1」时判歧义并拒绝——这才是 workspace-menu 阶段超时的真因，
    //   并非「菜单不渲染」（实测点中输入栏 picker 后菜单正常出现，搜索框亦出现）。
    //   输入栏 picker 的权威、唯一标识是 aria-label「切换或清空当前工作区，当前为 <名>」（带 aria-expanded），故置于主选择器。
    primary: 'button[aria-label^="切换或清空当前工作区"]',
    fallbacks: [
      'button[aria-expanded][aria-label*="工作区"]',
      '[data-workspace-picker-trigger]',
      'button[aria-label="工作区"]',
    ],
    ariaLabels: ['工作区'],
    ariaPatterns: ['切换或清空当前工作区', '工作区', 'workspace'],
    verifiedVersion: '0.3.4',
    note: '工作区选择触发器（输入栏 picker）；0.3.4 实测 aria-label=「切换或清空当前工作区，当前为 <名>」，唯一命中；[data-workspace-picker-trigger] 在 0.3.4 有 2 个需避免',
  },
  // 下拉浮层的「打开」证据（多形态并列）；0.3.4 实测：点中输入栏 picker 后正常出现
  workspaceMenu: {
    primary: '[role="menu"][data-state="open"], [role="dialog"][data-state="open"]',
    fallbacks: ['[data-workspace-menu]', '[data-workspace-picker-menu]', '[data-state="open"]'],
    verifiedVersion: '0.3.4',
    note: '工作区下拉浮层（多形态并列）；0.3.4 实测点 picker 后为 [role="menu"][data-state="open"]',
  },
  workspaceSearch: {
    primary: 'input[aria-label="搜索工作区"]',
    fallbacks: [
      '[role="dialog"] input[type="search"]',
      '[role="menu"] input',
      'input[placeholder*="搜索" i]',
      'input[aria-label*="工作区" i]',
    ],
    ariaLabels: ['搜索工作区'],
    verifiedVersion: '0.3.4',
    note: '工作区搜索框；0.3.4 实测点 picker 后出现（aria-label=「搜索工作区」，placeholder=「搜索名称或路径」）',
  },
  workspaceItem: {
    primary: '[role="menuitem"][data-workspace-source="local"]',
    fallbacks: ['[role="menuitem"]', '[role="option"]'],
    verifiedVersion: '0.3.4',
    note: '工作区候选项（下拉内）',
  },
  workspaceForm: {
    primary: '#workspace-editor-form',
    fallbacks: ['[data-workspace-editor] form', 'form[data-workspace-editor]'],
    verifiedVersion: '0.3.4',
    note: '新建工作区表单',
  },
  folderAdd: {
    primary: 'button[aria-describedby="workspace-folder-required"]',
    fallbacks: ['button[aria-label*="添加" i]', 'button[aria-label*="文件夹" i]'],
    texts: ['添加可读写文件夹', 'Add folder'],
    verifiedVersion: '0.3.4',
    note: '表单内「添加文件夹」按钮（唤起原生对话框）',
  },
  workspaceName: {
    primary: '#workspace-editor-form input',
    fallbacks: ['form input[name="name"]', 'input[aria-label*="名称" i]'],
    verifiedVersion: '0.3.4',
    note: '工作区名称输入框',
  },
  workspaceCreate: {
    primary: 'button[form="workspace-editor-form"][type="submit"]',
    fallbacks: ['form button[type="submit"]'],
    texts: ['创建', 'Create'],
    verifiedVersion: '0.3.4',
    note: '新建工作区提交按钮',
  },
  model: {
    primary: 'button[aria-label^="模型:"]',
    fallbacks: ['button[aria-label*="模型" i]', 'button[data-chat-model-selector-trigger]'],
    ariaPatterns: ['^模型[：:]'],
    verifiedVersion: '0.3.4',
    note: '模型触发器（aria-label=「模型:<名>」）',
  },
  modelMenu: {
    primary: '[data-chat-model-selector-menu][data-state="open"]',
    fallbacks: ['[data-chat-model-selector-menu]', '[role="menu"][data-state="open"]'],
    verifiedVersion: '0.3.4',
    note: '模型下拉菜单（打开态）',
  },
  modelList: {
    primary: '[data-chat-model-selector-list] [role="menuitem"]',
    fallbacks: ['[data-chat-model-selector-list] [role="option"]', '[role="menuitemradio"]'],
    verifiedVersion: '0.3.4',
    note: '模型候选列表',
  },
  modelDialog: {
    primary: '[role="dialog"][data-state="open"]:has([role="table"][aria-label="模型参数与显示设置"])',
    fallbacks: ['[role="dialog"]:has([role="table"])', '[data-chat-model-settings-dialog]'],
    verifiedVersion: '0.3.4',
    note: '模型管理对话框',
  },
  levelItem: {
    primary: '[role="menuitemradio"]',
    fallbacks: ['[role="option"]', '[role="menuitem"]'],
    verifiedVersion: '0.3.4',
    note: '思考等级候选项',
  },
  permission: {
    primary: 'button[aria-label="访问权限"]',
    fallbacks: ['button[aria-label*="权限" i]', 'button[aria-label*="permission" i]'],
    ariaLabels: ['访问权限'],
    verifiedVersion: '0.3.4',
    note: '权限模式触发器',
  },
  sessionLink: {
    primary: 'a[href^="#/chat/"]',
    fallbacks: ['a[href*="#/chat/"]'],
    verifiedVersion: '0.3.4',
    note: '会话链接（恢复会话用）',
  },
} satisfies Record<string, QoderSelectorSpec>;

export type QoderSelectorKey = keyof typeof QODER_SELECTORS;

/** profile.gui.selectors 的覆盖表：语义键 → 单个选择器字符串（覆盖优先） */
export type QoderSelectorOverrides = Partial<Record<QoderSelectorKey, string>>;

/**
 * 解析某语义键的候选列表（覆盖值优先，其后 primary 与 fallbacks，去重保序）。
 * 与 Codex 的 `cssCandidates()` 同口径。
 */
export function qoderCandidates(
  key: QoderSelectorKey,
  overrides: Record<string, string> = {},
): string[] {
  const spec = QODER_SELECTORS[key] as QoderSelectorSpec;
  return [
    ...new Set([overrides[key], spec.primary, ...spec.fallbacks].filter((v): v is string => Boolean(v))),
  ];
}

/** 首选字符串选择器（覆盖优先）——保持既有 `selector()` 语义。 */
export function qoderPrimary(key: QoderSelectorKey, overrides: Record<string, string> = {}): string {
  return qoderCandidates(key, overrides)[0] ?? "";
}
