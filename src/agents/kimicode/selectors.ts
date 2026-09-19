/**
 * Kimi Code 选择器规范（实测 2026-09-20；Kimi Code 1.0.2 / Chromium 150.0.7871.114 / Electron 43.1.1）。
 *
 * 实测要点（改这里的任何键都必须真机复验）：
 * 1) 全页 `data-testid` 数为 **0**，但 class 名语义化且稳定（非构建哈希）→ 以 class + 文本/aria 为主判据；
 *    Vue scoped 属性 `data-v-*` 随构建变化，禁止依赖。
 * 2) Kimi Code 是**双渲染进程**：主窗口承载侧栏/会话/composer；而**模型菜单、思考档位、执行模式菜单**
 *    渲染在独立的 `Kimi Browser Overlay` 窗口（`app://renderer/browser-overlay.html`）。
 *    因此这里维护两张表：KIMICODE_SELECTORS（主窗口）与 KIMICODE_OVERLAY_SELECTORS（浮层窗口）。
 * 3) 浮层菜单通过 `browserOverlayOpenMenu`/`browserOverlayCloseMenu` 打开与关闭：菜单关闭时 overlay
 *    窗口 `visibilityState` 为 hidden —— 判定「菜单是否打开」必须以 overlay 可见性为准，不能只看 DOM 存在。
 */

export interface KimicodeSelectorSpec {
  /** 主 CSS 选择器 */
  primary: string;
  /** 回退 CSS 选择器 */
  fallbacks: string[];
  /** 精确可见文本（归一化后比较，中英双语） */
  texts?: string[];
  /** 精确 aria-label（归一化后比较，中英双语） */
  ariaLabels?: string[];
  /** aria-label 正则源串（用于含动态名称的模板） */
  ariaPatterns?: string[];
  /** 排除选择器：命中任一（自身或祖先 closest）的候选被剔除 */
  excludes?: string[];
  /** 作用域选择器：仅保留落在其匹配元素内的候选；作用域元素不存在时返回空集 */
  scope?: string;
  /** 实测校验的客户端版本 */
  verifiedVersion: string;
  note: string;
}

/** 主窗口语义键（侧栏 / 会话 / composer） */
export type KimicodeSelectorKey =
  | "newSession"
  | "search"
  | "workspaceSectionToggle"
  | "workspaceMore"
  | "workspaceAddSession"
  | "workspaceChip"
  | "workspaceChipName"
  | "workspacePanel"
  | "workspaceRow"
  | "workspaceName"
  | "workspacePath"
  | "chooseFolder"
  | "sessionItem"
  | "sessionTitle"
  | "sessionMore"
  | "chatInput"
  | "attachButton"
  | "permissionPill"
  | "modelPill"
  | "modelName"
  | "thinkSuffix"
  | "sendButton"
  | "stopButton"
  | "userMenu"
  | "settingsButton"
  | "gitBranch"
  | "openInMain"
  | "messageArea"
  | "modelDialog"
  | "modelDialogSearch"
  | "modelDialogRow"
  | "modelDialogRowName"
  | "assistantCopyButton"
  | "userCopyButton"
  | "errorRetryButton";

/** 浮层（Kimi Browser Overlay）语义键：模型菜单 / 思考档位 / 执行模式菜单 */
export type KimicodeOverlaySelectorKey =
  | "overlayStage"
  | "menuList"
  | "menuRow"
  | "menuRowTitle"
  | "menuRowDescription"
  | "modelOption"
  | "thinkingSegment"
  | "moreModelsItem"
  | "permissionOption";

export const KIMICODE_SELECTORS: Record<KimicodeSelectorKey, KimicodeSelectorSpec> = {
  newSession: {
    primary: "button.btn-new-chat",
    fallbacks: ["aside.side button.search + button", "aside.side button"],
    texts: ["新建会话", "New session", "New chat"],
    verifiedVersion: "1.0.2",
    note: "侧栏顶部新建会话按钮；点击后进入草稿页（URL 由 /sessions/<id> 变为 app://renderer/）",
  },
  search: {
    primary: "button.search",
    fallbacks: ["aside.side button[class*='search']"],
    texts: ["搜索", "Search"],
    verifiedVersion: "1.0.2",
    note: "侧栏搜索入口（本适配器不使用，保留用于诊断）",
  },
  workspaceSectionToggle: {
    primary: "button.side-section-toggle[aria-label='折叠全部工作区']",
    fallbacks: ["button.side-section-toggle"],
    ariaLabels: ["折叠全部工作区", "展开全部工作区", "Collapse all workspaces"],
    verifiedVersion: "1.0.2",
    note: "会话分组头的折叠开关",
  },
  workspaceMore: {
    primary: "button.gh-more[aria-label='选项']",
    fallbacks: ["button.gh-more"],
    ariaLabels: ["选项", "Options"],
    verifiedVersion: "1.0.2",
    note: "工作区分组「…」菜单（重命名/移除等；本适配器不使用，保留用于诊断）",
  },
  workspaceAddSession: {
    primary: "button.gh-add[aria-label='在此工作区新建会话']",
    fallbacks: ["button.gh-add"],
    ariaLabels: ["在此工作区新建会话", "New session in this workspace"],
    verifiedVersion: "1.0.2",
    note: "在指定工作区分组下直接新建会话（比全局「新建会话」更精确，绑定失败时的可靠入口）",
  },
  workspaceChip: {
    primary: "button.ws-chip",
    fallbacks: ["div.ws-anchor button"],
    verifiedVersion: "1.0.2",
    note: "草稿页输入框上方的工作区触发器；**发送后从 composer 消失**（可用作「草稿页」判据之一）",
  },
  workspaceChipName: {
    primary: "span.ws-chip-name",
    fallbacks: ["button.ws-chip > span"],
    verifiedVersion: "1.0.2",
    note: "触发器上的工作区名（未绑定时应为占位词，实测继承上次工作区）",
  },
  workspacePanel: {
    primary: "div.ws-panel[role='menu']",
    fallbacks: ["div.ws-panel"],
    verifiedVersion: "1.0.2",
    note: "工作区下拉面板（**主窗口内渲染**，与模型菜单不同）",
  },
  workspaceRow: {
    primary: "button.ws-row[role='menuitem']",
    fallbacks: ["div.ws-panel button.ws-row"],
    verifiedVersion: "1.0.2",
    note: "面板内的「最近的文件夹」项；当前选中项带 class `on`",
  },
  workspaceName: {
    primary: "span.ws-name",
    fallbacks: ["button.ws-row span"],
    verifiedVersion: "1.0.2",
    note: "文件夹显示名（如 tianshu-mcp）",
  },
  workspacePath: {
    primary: "span.ws-path",
    fallbacks: [],
    verifiedVersion: "1.0.2",
    note: "**文件夹完整绝对路径**（如 D:\\Trae项目\\tianshu-mcp）→ 绑定判据以此为主，基名仅作辅助",
  },
  chooseFolder: {
    primary: "button.ws-action[role='menuitem']",
    fallbacks: ["div.ws-panel button.ws-action"],
    texts: ["选择文件夹…", "选择文件夹...", "Choose folder…", "Choose folder"],
    verifiedVersion: "1.0.2",
    note: "触发原生「添加工作区」对话框（#32770）；必须用 trusted 点击",
  },
  sessionItem: {
    primary: "div.se[data-session-id]",
    fallbacks: ["div.group-sessions div.se"],
    verifiedVersion: "1.0.2",
    note: "会话项；**data-session-id 即会话 id**（同时也可从主窗口 URL 读取），标题在 span.t",
  },
  sessionTitle: {
    primary: "div.se span.t",
    fallbacks: ["div.se span"],
    verifiedVersion: "1.0.2",
    note: "会话标题文本",
  },
  sessionMore: {
    primary: "button.ch-act-more[aria-label='选项']",
    fallbacks: ["button.ch-act-more"],
    ariaLabels: ["选项", "Options"],
    verifiedVersion: "1.0.2",
    note: "会话头部「…」菜单（归档/删除入口；本适配器不使用，保留用于诊断与清理）",
  },
  chatInput: {
    primary: "div.ProseMirror[contenteditable='true'][aria-label='消息输入框']",
    fallbacks: [
      "div.ProseMirror[contenteditable='true'][role='combobox']",
      "div.ProseMirror[contenteditable='true']",
    ],
    ariaLabels: ["消息输入框", "Message input"],
    verifiedVersion: "1.0.2",
    note: "ProseMirror 富文本输入框；必须走 CDP 真实输入管线（Input.insertText），不能设 value。清空后 innerText 长度仍为 1（保留空 <p>）",
  },
  attachButton: {
    primary: "button.composer-attach[aria-label='添加']",
    fallbacks: ["button.composer-attach"],
    ariaLabels: ["添加", "Add", "Attach"],
    verifiedVersion: "1.0.2",
    note: "附件入口（点开为主窗口内的 div.add-menu）",
  },
  permissionPill: {
    primary: "span.perm-pill",
    fallbacks: ["span.perm-pill[role='button']"],
    verifiedVersion: "1.0.2",
    note: "执行模式触发器（文本如「完全自动」）。class 含 perm-auto / 其他模式后缀；`.open` 表示菜单已展开。菜单渲染在 overlay",
  },
  modelPill: {
    primary: "button.model-pill",
    fallbacks: ["button[aria-haspopup='menu'].model-pill", "span.ui-tip > button.model-pill"],
    verifiedVersion: "1.0.2",
    note: "模型+思考档位触发器（aria-haspopup=menu / aria-expanded）。内含 span.mp-name 与 span.think-suffix；点击后菜单渲染在 overlay",
  },
  modelName: {
    primary: "span.mp-name",
    fallbacks: ["button.model-pill > span:first-child"],
    verifiedVersion: "1.0.2",
    note: "触发器上的模型名（如 K3、stepfun/step-3.7-flash:free）",
  },
  thinkSuffix: {
    primary: "span.think-suffix",
    fallbacks: ["button.model-pill > span:last-of-type"],
    verifiedVersion: "1.0.2",
    note: "触发器上的档位后缀，形如「 · High」「 · Max」；非官方模型实测为「 · 思考」",
  },
  sendButton: {
    primary: "button.send",
    fallbacks: ["button.send[aria-label^='发送']"],
    verifiedVersion: "1.0.2",
    note: "发送按钮（aria-label「发送 ↵」）。输入为空时 disabled；发送中 class 变为 `send is-starting` → 次权威运行信号",
  },
  stopButton: {
    primary: "button.stop",
    fallbacks: ["button.stop[aria-label='中断']"],
    ariaLabels: ["中断", "Stop", "Interrupt"],
    verifiedVersion: "1.0.2",
    note: "**权威运行信号**：生成期间出现，完成后消失（实测 0.5–1.2s 内出现）。不要加入「取消」等宽泛文案",
  },
  userMenu: {
    primary: "button.user-menu-trigger",
    fallbacks: ["aside.side button[class*='user-menu']"],
    verifiedVersion: "1.0.2",
    note: "左下角用户菜单（本适配器不使用，保留用于登录态诊断）",
  },
  settingsButton: {
    primary: "button.side-footer-settings[aria-label='设置']",
    fallbacks: ["button.side-footer-settings"],
    ariaLabels: ["设置", "Settings"],
    verifiedVersion: "1.0.2",
    note: "设置入口（保留用于诊断）",
  },
  gitBranch: {
    primary: "button.ch-git",
    fallbacks: ["button[class*='ch-git']"],
    verifiedVersion: "1.0.2",
    note: "会话头部的 Git 分支 chip（文本如 master）；发送后出现，可用于确认会话已进入工作区上下文",
  },
  openInMain: {
    primary: "button.open-in-main",
    fallbacks: ["button[aria-label='用 File Explorer 打开']"],
    ariaLabels: ["用 File Explorer 打开", "Open in File Explorer"],
    verifiedVersion: "1.0.2",
    note: "会话头部「在文件管理器中打开」（本适配器不使用，保留用于绑定诊断）",
  },
  messageArea: {
    primary: "div.panes",
    fallbacks: ["div.chat-layout div.panes", "div[class*='panes']"],
    verifiedVersion: "1.0.2",
    note: "对话正文容器；文本稳定兜底判定与错误文案提取都用它。**不要用 body**（会混入侧栏与会话标题）",
  },
  modelDialog: {
    primary: "div.ui-dialog[role='dialog']",
    fallbacks: ["div[role='dialog'][class*='ui-dialog']"],
    verifiedVersion: "1.0.2",
    note: "「切换模型」对话框（overlay 内点「更多模型…」后出现在**主窗口**）",
  },
  modelDialogSearch: {
    primary: "div.ui-dialog input.ui-input",
    fallbacks: ["div.ui-dialog input[placeholder*='搜索模型']"],
    verifiedVersion: "1.0.2",
    note: "对话框搜索框（placeholder「搜索模型或提供商…」）；聚焦后 Input.insertText 即可过滤",
  },
  modelDialogRow: {
    primary: "div.ui-dialog div.model-row[role='option']",
    fallbacks: ["div.model-list div.model-row"],
    verifiedVersion: "1.0.2",
    note: "模型候选行。**`.is-current` 才是当前模型**（`.is-selected` 只是推荐项，实测指向 K2.8 Preview 而实际模型是 K3）",
  },
  modelDialogRowName: {
    primary: "div.model-row span.model-name",
    fallbacks: ["span.model-name"],
    verifiedVersion: "1.0.2",
    note: "模型名（如 K3、K3-256k、K2.8 Preview），精确匹配用 NFKC + 折叠空白",
  },
  assistantCopyButton: {
    primary: "button.a-cpbtn",
    fallbacks: ["button[aria-label='复制'][class*='a-cp']"],
    ariaLabels: ["复制", "Copy"],
    verifiedVersion: "1.0.2",
    note: "助手回复的复制按钮；回复落地后可作辅助证据（不作为完成判据）",
  },
  userCopyButton: {
    primary: "button.u-copy",
    fallbacks: ["button[aria-label='复制'][class*='u-copy']"],
    ariaLabels: ["复制", "Copy"],
    verifiedVersion: "1.0.2",
    note: "用户消息的复制按钮；发送确认的辅助证据之一",
  },
  errorRetryButton: {
    primary: "button.ui-button--secondary",
    fallbacks: ["button[class*='ui-button--secondary']"],
    texts: ["继续", "Continue", "Retry"],
    verifiedVersion: "1.0.2",
    note: "模型请求失败后的「继续」按钮（实测伴随 provider.auth_error / HTTP 403 文案）；用于把本轮判为失败而非完成",
  },
};

export const KIMICODE_OVERLAY_SELECTORS: Record<
  KimicodeOverlaySelectorKey,
  KimicodeSelectorSpec
> = {
  overlayStage: {
    primary: "main.browser-overlay-stage",
    fallbacks: ["#app > main", "body > div#app main"],
    verifiedVersion: "1.0.2",
    note: "浮层菜单舞台；菜单打开时 overlay 窗口 visibilityState 为 visible",
  },
  menuList: {
    primary: "div.browser-overlay-list",
    fallbacks: ["main.browser-overlay-stage div[class*='overlay-list']"],
    verifiedVersion: "1.0.2",
    note: "浮层菜单列表容器",
  },
  menuRow: {
    primary: "button.overlay-menu-row",
    fallbacks: ["button.ui-menu-item.overlay-menu-row"],
    verifiedVersion: "1.0.2",
    note: "浮层菜单通用行（模型项、权限项、更多模型共用同一 class，语义由菜单时机区分）",
  },
  menuRowTitle: {
    primary: "span.overlay-menu-title",
    fallbacks: ["span.overlay-menu-label"],
    verifiedVersion: "1.0.2",
    note: "菜单行标题（如「完全自动」「更多模型…」）",
  },
  menuRowDescription: {
    primary: "span.overlay-menu-description",
    fallbacks: ["span[class*='overlay-menu-description']"],
    verifiedVersion: "1.0.2",
    note: "菜单行说明文案（执行模式菜单里有）",
  },
  modelOption: {
    primary: "button.overlay-menu-row[role='menuitemradio']",
    fallbacks: ["button[role='menuitemradio']"],
    verifiedVersion: "1.0.2",
    note: "模型候选（模型菜单打开时）；**当前模型带 `.is-active`**。注意与执行模式菜单的 menuitemradio 同形，必须按菜单时机使用",
  },
  thinkingSegment: {
    primary: "button.ui-seg__item[role='tab']",
    fallbacks: ["[role='tablist'] button", "button.ui-seg__item"],
    verifiedVersion: "1.0.2",
    note: "思考档位分段控件：官方模型为 Low/High/Max（**当前档带 `.is-on`**），非官方模型为 On/Off。档位集合以界面实际渲染为准",
  },
  moreModelsItem: {
    primary: "button.overlay-menu-row[role='menuitem']",
    fallbacks: ["button[role='menuitem'][class*='overlay-menu-row']"],
    texts: ["更多模型…", "更多模型...", "More models…", "More models"],
    verifiedVersion: "1.0.2",
    note: "「更多模型…」入口：点击后 overlay 隐藏，主窗口弹出「切换模型」对话框",
  },
  permissionOption: {
    primary: "button.overlay-menu-row[role='menuitemradio']",
    fallbacks: ["button[role='menuitemradio']"],
    texts: ["完全自动", "必要时询问", "始终询问", "Full auto"],
    verifiedVersion: "1.0.2",
    note: "执行模式候选（执行模式菜单打开时）；**当前模式带 `.is-active`**。三档实测为 始终询问/必要时询问/完全自动",
  },
};

/** 合并 profile 覆盖后的 CSS 候选（去重，覆盖优先） */
export function cssCandidates(
  spec: KimicodeSelectorSpec,
  overrides: Record<string, string> = {},
  key?: string,
): string[] {
  const override = key ? overrides[key] : undefined;
  return [...new Set([override, spec.primary, ...spec.fallbacks].filter((v): v is string => Boolean(v)))];
}

/**
 * 生成页面内 resolve 函数源码：按 CSS 候选 + 文本/aria 谓词解析元素（文档顺序去重）。
 * 调用形式兼容两种：`__kimicodeResolve(css,texts,arias,pats,excl,scope)` 或单数组形式。
 */
export function resolveFnSource(): string {
  return `function __kimicodeResolve(a,b,c,d,e,f){
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
      const scan='[aria-label],button,a,label,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="tab"],[role="option"],[role="listitem"],[role="menu"],div[class]';
      const textHits=[];
      for(const el of document.querySelectorAll(scan)){
        const aria=el.getAttribute('aria-label')||'';
        if(aset.indexOf(norm(aria))>=0){push(el);continue}
        if(regs.some((r)=>r.test(aria))){push(el);continue}
        if(tset.indexOf(norm(el.innerText||el.textContent||''))>=0)textHits.push(el)
      }
      // 文本命中去重：只保留最内层（避免祖先 div 因包含同一文案而命中）
      for(const el of textHits){if(!textHits.some((o)=>o!==el&&el.contains(o)))push(el)}
    }
    return out;
  }`;
}

/** 页面内 spec 的 JSON 参数（[css, texts, ariaLabels, ariaPatterns, excludes, scope]） */
export function specArgs(spec: KimicodeSelectorSpec, overrides: Record<string, string> = {}, key?: string): string {
  return JSON.stringify([
    cssCandidates(spec, overrides, key),
    spec.texts ?? [],
    spec.ariaLabels ?? [],
    spec.ariaPatterns ?? [],
    spec.excludes ?? [],
    spec.scope ?? "",
  ]);
}

/** 主窗口键的 spec 解析（含 profile.gui.selectors 覆盖） */
export function mainSpec(key: KimicodeSelectorKey, overrides: Record<string, string> = {}): string {
  return specArgs(KIMICODE_SELECTORS[key], overrides, key);
}

/** 浮层键的 spec 解析（含 profile.gui.selectors 覆盖，键名加 overlay 前缀避免与主窗口同名键冲突） */
export function overlaySpec(
  key: KimicodeOverlaySelectorKey,
  overrides: Record<string, string> = {},
): string {
  return specArgs(KIMICODE_OVERLAY_SELECTORS[key], overrides, `overlay.${key}`);
}