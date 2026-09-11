export interface ZcodeSelectorSpec {
  primary: string;
  fallbacks: string[];
  verifiedVersion: string;
  note: string;
}

export type ZcodeSelectorKey =
  | "chatInput"
  | "sendButton"
  | "stopButton"
  | "newTask"
  | "messageList"
  | "assistantMessage"
  | "questionCard"
  | "runningCard"
  | "toolCall"
  | "projectItem"
  | "projectPath"
  | "projectTrigger"
  | "addProject"
  | "chooseFolder"
  | "modelTrigger"
  | "providerOption"
  | "modelOption"
  | "modelValue"
  | "permissionTrigger"
  | "permissionValue"
  | "permissionOption"
  | "loginPage";

export const ZCODE_SELECTORS: Record<ZcodeSelectorKey, ZcodeSelectorSpec> = {
  chatInput: {
    primary: '[data-testid="v4-composer-input"][contenteditable="true"]',
    fallbacks: [
      'textarea[placeholder*="消息"]',
      'textarea[placeholder*="message"]',
      '[contenteditable="true"][role="textbox"]',
    ],
    verifiedVersion: "3.11.x",
    note: "任务输入框",
  },
  sendButton: {
    primary: 'button[data-testid="v4-composer-send"]',
    fallbacks: ['button[aria-label*="发送"]', 'button[aria-label*="Send"]'],
    verifiedVersion: "3.11.x",
    note: "发送按钮",
  },
  stopButton: {
    primary: 'button[data-testid="v4-composer-stop"]',
    fallbacks: ['button[aria-label*="停止"]', 'button[aria-label*="Stop"]'],
    verifiedVersion: "3.11.x",
    note: "权威运行信号",
  },
  newTask: {
    primary: 'button[data-testid="conversation-new-task"]',
    fallbacks: [
      'button[aria-label*="新建任务"]',
      'button[aria-label*="New task"]',
      '[data-testid="task-new-button"]',
    ],
    verifiedVersion: "3.11.x",
    note: "当前窗口顶部的新建会话按钮；避免命中其他工作区挂载的 task-new-button",
  },
  messageList: {
    primary: '[data-testid="v4-timeline"]',
    fallbacks: ['[class*="message-list"]', "main"],
    verifiedVersion: "3.11.x",
    note: "消息列表",
  },
  assistantMessage: {
    primary: '[data-testid^="v4-row-"][class*="assistant-row"]',
    fallbacks: [
      '[data-message-role="assistant"]',
      '[data-role="assistant"]',
      '[class*="assistant-message"]',
    ],
    verifiedVersion: "3.11.x",
    note: "助手消息；3.11.2 使用 v4-row-* 和 assistant-row",
  },
  questionCard: {
    primary: '[role="listbox"][aria-label]:has([role="option"])',
    fallbacks: [
      '[data-testid*="question"]',
      '[class*="ask-user"]',
      '[class*="question-card"]',
    ],
    verifiedVersion: "3.11.x",
    note: "AskUserQuestion 待用户回答控件；优先使用可访问语义，不依赖本地化按钮文本",
  },
  runningCard: {
    primary: '[data-state="loading"]',
    fallbacks: ['[class*="loading-card"]', '[aria-busy="true"]'],
    verifiedVersion: "3.11.x",
    note: "权威运行信号",
  },
  toolCall: {
    primary: '[data-testid*="tool-call"][data-state="running"]',
    fallbacks: ['[class*="tool-call"][class*="running"]'],
    verifiedVersion: "3.11.x",
    note: "活动工具调用",
  },
  projectItem: {
    primary: '[data-testid^="workspace-item-"]',
    fallbacks: ['[class*="project-item"]', '[class*="workspace-item"]'],
    verifiedVersion: "3.11.x",
    note: "项目列表项",
  },
  projectPath: {
    primary: "[data-project-path]",
    fallbacks: ['[title*="/"][class*="project"]', '[title*="\\\\"][class*="project"]'],
    verifiedVersion: "3.11.x",
    note: "当前项目路径",
  },
  projectTrigger: {
    primary: '[data-testid="composer-workspace-trigger"]',
    fallbacks: ['button[aria-label*="项目"]', 'button[aria-label*="Project"]'],
    verifiedVersion: "3.11.x",
    note: "项目菜单",
  },
  addProject: {
    primary: 'button[data-testid="project-add"]',
    fallbacks: [
      'button[aria-label*="添加项目"]',
      'button[aria-label*="Add project"]',
    ],
    verifiedVersion: "3.11.x",
    note: "打开添加项目菜单",
  },
  chooseFolder: {
    primary: '[role="menu"] [role="menuitem"]',
    fallbacks: [
      'button[aria-label*="选择文件夹"]',
      'button[aria-label*="Choose folder"]',
    ],
    verifiedVersion: "3.11.x",
    note: "添加项目菜单中的打开文件夹项；必须按本地化标签唯一匹配",
  },
  modelTrigger: {
    primary: '[data-testid="chat-model-select-trigger"]',
    fallbacks: ['button[aria-label*="模型"]', 'button[aria-label*="Model"]'],
    verifiedVersion: "3.11.x",
    note: "模型菜单",
  },
  providerOption: {
    primary: '[data-testid^="chat-model-select-group-provider:"]',
    fallbacks: ['[role="option"][data-provider]'],
    verifiedVersion: "3.11.x",
    note: "供应商候选",
  },
  modelOption: {
    primary: '[data-testid^="chat-model-select-item-"][role="menuitemradio"]',
    fallbacks: ['[role="option"][data-model]'],
    verifiedVersion: "3.11.x",
    note: "模型候选",
  },
  modelValue: {
    primary: '[data-testid="chat-model-select-trigger"]',
    fallbacks: ['[class*="model-trigger"]'],
    verifiedVersion: "3.11.x",
    note: "当前模型回读",
  },
  permissionTrigger: {
    primary: '[data-testid="chat-mode-select-trigger"]',
    fallbacks: [
      'button[aria-label="切换模式"]',
      'button[aria-label*="权限"]',
      'button[aria-label*="Permission"]',
    ],
    verifiedVersion: "3.11.x",
    note: "权限菜单",
  },
  permissionValue: {
    primary: '[data-testid="chat-mode-select-trigger"]',
    fallbacks: ['[class*="permission-trigger"]'],
    verifiedVersion: "3.11.x",
    note: "权限回读",
  },
  permissionOption: {
    primary: '[data-testid^="chat-mode-select-item-"][role="option"]',
    fallbacks: ['[role="option"][data-permission]'],
    verifiedVersion: "3.11.x",
    note: "权限候选",
  },
  loginPage: {
    primary: '[data-testid="login-page"]',
    fallbacks: ['button[aria-label="登录"]', 'button[aria-label="Sign in"]'],
    verifiedVersion: "3.11.x",
    note: "登录/引导页",
  },
};

export function candidates(
  key: ZcodeSelectorKey,
  overrides: Record<string, string> = {},
): string[] {
  return [
    ...new Set(
      [overrides[key], ZCODE_SELECTORS[key].primary, ...ZCODE_SELECTORS[key].fallbacks].filter(
        (v): v is string => Boolean(v),
      ),
    ),
  ];
}

export function candidateExpr(
  key: ZcodeSelectorKey,
  overrides: Record<string, string> = {},
): string {
  return JSON.stringify(candidates(key, overrides));
}
