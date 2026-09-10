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
    primary: '[contenteditable="true"][data-lexical-editor="true"]',
    fallbacks: [
      'textarea[placeholder*="消息"]',
      'textarea[placeholder*="message"]',
      '[contenteditable="true"][role="textbox"]',
    ],
    verifiedVersion: "3.11.x",
    note: "任务输入框",
  },
  sendButton: {
    primary: 'button[data-testid*="send"]',
    fallbacks: ['button[aria-label*="发送"]', 'button[aria-label*="Send"]'],
    verifiedVersion: "3.11.x",
    note: "发送按钮",
  },
  stopButton: {
    primary: 'button[data-testid*="stop"]',
    fallbacks: ['button[aria-label*="停止"]', 'button[aria-label*="Stop"]'],
    verifiedVersion: "3.11.x",
    note: "权威运行信号",
  },
  newTask: {
    primary: '[data-testid*="new-task"]',
    fallbacks: ['button[aria-label*="新建任务"]', 'button[aria-label*="New task"]'],
    verifiedVersion: "3.11.x",
    note: "新建会话",
  },
  messageList: {
    primary: '[data-testid*="message-list"]',
    fallbacks: ['[class*="message-list"]', "main"],
    verifiedVersion: "3.11.x",
    note: "消息列表",
  },
  assistantMessage: {
    primary: '[data-message-role="assistant"]',
    fallbacks: ['[data-role="assistant"]', '[class*="assistant-message"]'],
    verifiedVersion: "3.11.x",
    note: "助手消息",
  },
  questionCard: {
    primary: '[data-testid*="question"]',
    fallbacks: ['[class*="ask-user"]', '[class*="question-card"]'],
    verifiedVersion: "3.11.x",
    note: "待用户回答",
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
    primary: '[data-testid*="project-item"]',
    fallbacks: ['[class*="project-item"]', '[class*="workspace-item"]'],
    verifiedVersion: "3.11.x",
    note: "项目列表项",
  },
  projectPath: {
    primary: "[data-project-path]",
    fallbacks: ['[title*="/"][class*="project"]', '[title*="\\"][class*="project"]'],
    verifiedVersion: "3.11.x",
    note: "当前项目路径",
  },
  projectTrigger: {
    primary: '[data-testid*="project-trigger"]',
    fallbacks: ['button[aria-label*="项目"]', 'button[aria-label*="Project"]'],
    verifiedVersion: "3.11.x",
    note: "项目菜单",
  },
  chooseFolder: {
    primary: '[data-testid*="choose-folder"]',
    fallbacks: ['button[aria-label*="选择文件夹"]', 'button[aria-label*="Choose folder"]'],
    verifiedVersion: "3.11.x",
    note: "原生目录面板入口",
  },
  modelTrigger: {
    primary: '[data-testid*="model-trigger"]',
    fallbacks: ['button[aria-label*="模型"]', 'button[aria-label*="Model"]'],
    verifiedVersion: "3.11.x",
    note: "模型菜单",
  },
  providerOption: {
    primary: '[data-testid*="provider-option"]',
    fallbacks: ['[role="option"][data-provider]'],
    verifiedVersion: "3.11.x",
    note: "供应商候选",
  },
  modelOption: {
    primary: '[data-testid*="model-option"]',
    fallbacks: ['[role="option"][data-model]'],
    verifiedVersion: "3.11.x",
    note: "模型候选",
  },
  modelValue: {
    primary: '[data-testid*="model-value"]',
    fallbacks: ['[class*="model-trigger"]'],
    verifiedVersion: "3.11.x",
    note: "当前模型回读",
  },
  permissionTrigger: {
    primary: '[data-testid*="permission-trigger"]',
    fallbacks: ['button[aria-label*="权限"]', 'button[aria-label*="Permission"]'],
    verifiedVersion: "3.11.x",
    note: "权限菜单",
  },
  permissionValue: {
    primary: '[data-testid*="permission-value"]',
    fallbacks: ['[class*="permission-trigger"]'],
    verifiedVersion: "3.11.x",
    note: "权限回读",
  },
  permissionOption: {
    primary: '[data-testid*="permission-option"]',
    fallbacks: ['[role="option"][data-permission]'],
    verifiedVersion: "3.11.x",
    note: "权限候选",
  },
  loginPage: {
    primary: '[data-testid*="login"]',
    fallbacks: ['button[aria-label*="登录"]', 'button[aria-label*="Sign in"]'],
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
