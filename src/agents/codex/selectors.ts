/**
 * Codex 桌面端选择器规范。
 *
 * 实测（2026-09-11，ChatGPT.exe / Chromium 152）：Codex 前端几乎不用 data-testid
 * （全页仅 2 个），也无可依赖的稳定 class（class 名含构建哈希 _ComposerLayout_kbwao_2）。
 * 因此定位以 aria-label 与可见文本为主，CSS 结构选择器兜底，并按中英双语给候选。
 *
 * 语义键 → 规格（primary + fallbacks + texts + ariaLabels + ariaPatterns）。
 * 所有方法都支持 profile.gui.selectors 覆盖（UI 漂移热修复）。
 */

export interface CodexSelectorSpec {
  /** 主 CSS 选择器 */
  primary: string;
  /** 回退 CSS 选择器 */
  fallbacks: string[];
  /** 精确可见文本（中英双语，归一化后比较） */
  texts?: string[];
  /** 精确 aria-label（中英双语，归一化后比较） */
  ariaLabels?: string[];
  /** aria-label 正则源串（用于含动态名称的模板，如「在 <名> 中开始新聊天」） */
  ariaPatterns?: string[];
  /**
   * 排除选择器：命中任一（自身或祖先 closest）的候选被剔除。
   * 用于把宽泛选择器收敛到应用区（如排除 aria-haspopup 菜单栏）。
   */
  excludes?: string[];
  /**
   * 作用域选择器：若给定，仅保留包含在其首个匹配元素内的候选；
   * 作用域元素不存在时返回空集（不退化到全局）。用于把触发器限定到输入框区域。
   */
  scope?: string;
  verifiedVersion: string;
  note: string;
}

export type CodexSelectorKey =
  | "chatInput"
  | "sendButton"
  | "stopButton"
  | "newChat"
  | "projectSection"
  | "projectPickerTrigger"
  | "addProject"
  | "projectItem"
  | "newProjectMenuItem"
  | "sourceFolderArea"
  | "createProjectButton"
  | "modelTrigger"
  | "reasoningSlider"
  | "modelMenuItem"
  | "menuItem"
  | "permissionTrigger"
  | "permissionOption"
  | "loginIndicator"
  | "messageArea";

export const CODEX_SELECTORS: Record<CodexSelectorKey, CodexSelectorSpec> = {
  chatInput: {
    primary: 'div.ProseMirror[contenteditable="true"]',
    fallbacks: ['[contenteditable="true"][role="textbox"]', 'textarea[placeholder]'],
    ariaLabels: ["随心输入", "Type a message", "Message", "输入消息"],
    verifiedVersion: "26.903.x",
    note: "ProseMirror 富文本输入框；必须走 CDP 输入，不能设 value",
  },
  sendButton: {
    primary: 'button[aria-label="发送"]',
    fallbacks: ['button[aria-label*="Send" i]', 'button[type="submit"]'],
    ariaLabels: ["发送", "Send"],
    verifiedVersion: "26.903.x",
    note: "条件渲染：输入框为空时不存在，出现即代表可发送",
  },
  stopButton: {
    primary: 'button[aria-label*="停止"]',
    fallbacks: ['button[aria-label*="Stop" i]', 'button[aria-label*="取消"]'],
    ariaLabels: ["停止", "Stop"],
    verifiedVersion: "26.903.x",
    note: "权威运行信号；生成期间替代发送按钮（待真机运行确认）",
  },
  newChat: {
    primary: 'button.sidebar-item',
    fallbacks: ['nav button', 'aside button'],
    texts: ["新对话", "New chat"],
    verifiedVersion: "26.903.x",
    note: "侧边栏新建会话",
  },
  projectSection: {
    primary: 'button[class*="section-toggle"]',
    fallbacks: ['nav button', 'aside button'],
    texts: ["项目", "Projects"],
    verifiedVersion: "26.903.x",
    note: "侧边栏项目分组开关",
  },
  addProject: {
    primary: 'button[aria-label="添加新项目"]',
    fallbacks: ["button[aria-label*='添加' i]", "button[aria-label*='Add project' i]"],
    ariaLabels: ["添加新项目", "Add new project", "Add project"],
    verifiedVersion: "26.903.x",
    note: "打开新建项目入口",
  },
  projectPickerTrigger: {
    // 真机实测：触发器 = aria-label「切换项目：<名>」(aria-haspopup="dialog")。
    // 注意两点：
    //  1) 它**不在** ComposerLayout 作用域内；
    //  2) 侧边栏有 aria-label="添加新项目"、输入框另有独立按钮 aria-label="不在项目中工作"
    //     （那是「离开项目」动作，不是触发器）——都不能混入本键，否则会误点。
    primary: 'button[aria-haspopup="dialog"][aria-label^="切换项目"]',
    fallbacks: ["button[aria-haspopup='dialog'][aria-label^='Switch project']"],
    ariaPatterns: ["^切换项目[：:]", "^Switch project[：:]"],
    verifiedVersion: "26.903.x",
    note: "输入框内的项目选择触发器（已绑定/未绑定均为「切换项目…」语义）",
  },
  projectItem: {
    primary: 'button[aria-label$="的项目操作"]',
    fallbacks: ["button[aria-label*='project actions' i]"],
    ariaPatterns: ["的项目操作$", "project actions$"],
    verifiedVersion: "26.903.x",
    note: "项目项（按 aria-label 前缀提取项目名）",
  },
  newProjectMenuItem: {
    primary: '[role="menu"] [role="menuitem"]',
    fallbacks: ['[role="menuitem"]', '[role="option"]'],
    texts: ["新建项目", "New project", "添加项目"],
    verifiedVersion: "26.903.x",
    note: "项目搜索弹层里的「新建项目」项",
  },
  sourceFolderArea: {
    // 真机实测：可点击的是「创建项目」对话框里文字为
    // 「添加 Codex 可读取和编辑的文件夹」的按钮（drop zone）。
    // 不要用「源文件夹」——那是 <label>，不可点击；用它会把 trusted 点击打在 label 上而不弹对话框。
    primary: '[role="dialog"] button[class*="drop" i]',
    fallbacks: [
      '[role="dialog"] [class*="dropzone" i]',
      '[role="dialog"] [class*="upload" i] button',
    ],
    texts: [
      "添加 Codex 可读取和编辑的文件夹",
      "Add a folder Codex can read and edit",
      "Add Codex-readable folder",
      "添加文件夹",
      "Add folder",
    ],
    verifiedVersion: "26.903.x",
    note: "创建项目对话框里添加源文件夹的按钮（点击后弹原生选择器）；必须 trusted 点击",
  },
  createProjectButton: {
    // 真机实测：「创建项目」同时是对话框标题 <h2> 与提交按钮 <button>，
    // 必须限定 button，否则文本匹配会命中标题造成歧义。
    primary: '[role="dialog"] form button:last-of-type',
    fallbacks: [
      '[role="dialog"] button[type="submit"]',
      '[role="dialog"] footer button:last-of-type',
    ],
    texts: ["创建项目", "Create project"],
    verifiedVersion: "26.903.x",
    note: "创建项目确认按钮（须确认源文件夹已挂上后再点；文本匹配还需限定 button）",
  },
  modelTrigger: {
    // 真机实测（26.903.x）：输入框工具条同一组有 4 个 aria-haspopup=menu 的 chip：
    //   本地(aria=选择聊天的运行位置) / 分支(aria=切换分支) / 权限(aria=更改权限) / 模型+等级
    // 其中只有「模型+等级」chip **没有 aria-label** —— 故用 :not([aria-label]) 精确锁定它。
    // 早期用通用 `button[aria-haspopup="menu"]`，解析顺序会把「完全访问」排在前面，
    // 导致 click(modelTrigger) 实际点到权限按钮、模型菜单打不开（真机实测踩坑）。
    primary: 'button[aria-haspopup="menu"]:not([aria-label])',
    fallbacks: ['button[aria-haspopup="menu"]:not([aria-label])', '[aria-haspopup="menu"]'],
    excludes: [
      '[role="menubar"]',
      "header",
      '[class*="menubar" i]',
      // 兜底：万一日后模型 chip 也带上 aria-label，仍靠排除同组其它 chip 收敛
      '[aria-label="更改权限"]',
      '[aria-label="选择聊天的运行位置"]',
      '[aria-label="切换分支"]',
      '[aria-label*="permission" i]',
    ],
    // 作用域：输入框容器（CSS Module 基名 ComposerLayout 稳定，哈希后缀会变）。
    // 兼容性优先，同时列出 ProseMirror 元素本身。
    scope: '[class*="ComposerLayout"],div.ProseMirror[contenteditable="true"]',
    verifiedVersion: "26.903.x",
    note: "模型+思考等级菜单触发器；限定在输入框作用域内，排除顶部菜单栏与模式切换器",
  },
  reasoningSlider: {
    // 真机实测（26.903.x）：思考强度是**滑块**（不是菜单项），
    // 5 档 aria-valuemin=0 / aria-valuemax=4，标签依次 轻度/中/高/极高/极高。
    // 位于模型菜单内，用左右方向键调节；必须精确比较，避免「高」误命中「极高」。
    primary: '[role="slider"]',
    fallbacks: ['[role="menu"] input[type="range"]', 'input[type="range"]'],
    verifiedVersion: "26.903.x",
    note: "模型菜单里的思考强度滑块（用方向键调节，aria-valuenow 表示档位）",
  },
  modelMenuItem: {
    // 真机实测：模型候选是 role=menuitemradio，选中项 aria-checked="true"。
    // 「默认 推荐模型集」也是 menuitemradio，需按文本/aria-checked 区分。
    primary: '[role="menu"] [role="menuitemradio"]',
    fallbacks: ['[role="menuitemradio"]', '[role="listbox"] [role="option"]'],
    verifiedVersion: "26.903.x",
    note: "模型候选（menuitemradio，aria-checked 表示当前选中）",
  },
  menuItem: {
    primary: '[role="menu"] [role="menuitem"]',
    fallbacks: [
      '[role="menu"] [role="menuitemradio"]',
      '[role="menu"] [role="option"]',
      '[role="listbox"] [role="option"]',
    ],
    verifiedVersion: "26.903.x",
    note: "通用菜单项，用于精确文本选择",
  },
  permissionTrigger: {
    primary: 'button[aria-label="更改权限"]',
    fallbacks: ["button[aria-label*='权限' i]", "button[aria-label*='permission' i]"],
    ariaLabels: ["更改权限", "Change permission", "Permissions"],
    verifiedVersion: "26.903.x",
    note: "权限模式触发器（文本如「完全访问」）",
  },
  permissionOption: {
    primary: '[role="menu"] [role="menuitem"]',
    fallbacks: ['[role="menuitemradio"]', '[role="option"]'],
    texts: ["完全访问", "Full access", "完全訪問"],
    verifiedVersion: "26.903.x",
    note: "权限候选（默认目标：完全访问 / Full access）",
  },
  loginIndicator: {
    primary: 'button[aria-label*="登录" i]',
    fallbacks: ["button[aria-label*='Sign in' i]", "a[href*='login' i]"],
    texts: ["登录", "Sign in", "Log in"],
    verifiedVersion: "26.903.x",
    note: "登录/引导页指示",
  },
  messageArea: {
    // 实测：页面有多个 <main>（首个为空壳），且 #root 会把「返回 ChatGPT」等导航文案算进来。
    // 对话正文在 CSS Module 基名 MainContentSurface 的容器里（哈希后缀会变）。
    primary: '[class*="MainContentSurface"]',
    fallbacks: [
      '[class*="thread" i]',
      '[class*="conversation" i]',
      '[class*="MessageList" i]',
      '[class*="message-list" i]',
    ],
    verifiedVersion: "26.903.x",
    note: "对话正文区域；用于文本稳定兜底判定（勿用裸 main/#root，会混入导航壳）",
  },
};

/** 合并 profile 覆盖后的 CSS 候选（去重，覆盖优先） */
export function cssCandidates(key: CodexSelectorKey, overrides: Record<string, string> = {}): string[] {
  const spec = CODEX_SELECTORS[key];
  return [...new Set([overrides[key], spec.primary, ...spec.fallbacks].filter((v): v is string => Boolean(v)))];
}

/**
 * 生成页面内 resolve 函数源码：按 CSS 候选 + 文本/aria 谓词解析元素（文档顺序去重）。
 * 调用形式兼容两种：`__codexResolve(css,texts,arias,pats,excl)` 或
 * `__codexResolve([css,texts,arias,pats,excl])`（specArgs 的产物即可直接传入）。
 */
export function resolveFnSource(): string {
  return `function __codexResolve(a,b,c,d,e,f){
    var spec=Array.isArray(a)?a:[a,b,c,d,e,f];
    var css=spec[0]||[],texts=spec[1]||[],arias=spec[2]||[],pats=spec[3]||[],excl=spec[4]||[],scopeSel=spec[5]||'';
    var roots=null;
    if(scopeSel){roots=document.querySelectorAll(scopeSel);if(!roots.length)return[]}
    const inScope=(el)=>{if(!roots)return true;for(const r of roots){if(r===el||r.contains(el))return true}return false};
    const out=[];
    const push=(el)=>{if(!el||out.indexOf(el)>=0)return;if(!inScope(el))return;if(excl.some((s)=>{try{return el.closest(s)}catch(_){return false}}))return;out.push(el)};
    for(const s of css){try{for(const el of document.querySelectorAll(s))push(el)}catch(_){}}
    if(texts.length||arias.length||pats.length){
      const norm=(s)=>(s||'').normalize('NFKC').trim().replace(/\\s+/g,' ').toLocaleLowerCase();
      const tset=texts.map(norm);const aset=arias.map(norm);
      const regs=pats.map((p)=>{try{return new RegExp(p,'i')}catch(_){return null}}).filter(Boolean);
      const scan='[aria-label],button,a,label,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"],[role="tab"],[role="listitem"],div[class]';
      const textHits=[];
      for(const el of document.querySelectorAll(scan)){
        const aria=el.getAttribute('aria-label')||'';
        if(aset.indexOf(norm(aria))>=0){push(el);continue}
        if(regs.some((r)=>r.test(aria))){push(el);continue}
        if(tset.indexOf(norm(el.innerText||el.textContent||''))>=0)textHits.push(el)
      }
      // 文本命中去重：只保留最内层（避免祖先 div 也因包含该文案而命中）
      for(const el of textHits){if(!textHits.some((o)=>o!==el&&el.contains(o)))push(el)}
    }
    return out;
  }`;
}

/** 页面内 spec 的 JSON 参数（[css, texts, ariaLabels, ariaPatterns, excludes, scope]） */
export function specArgs(key: CodexSelectorKey, overrides: Record<string, string> = {}): string {
  const spec = CODEX_SELECTORS[key];
  return JSON.stringify([
    cssCandidates(key, overrides),
    spec.texts ?? [],
    spec.ariaLabels ?? [],
    spec.ariaPatterns ?? [],
    spec.excludes ?? [],
    spec.scope ?? "",
  ]);
}
