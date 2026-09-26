/**
 * Open Design 控件的选择器注册表与页面内解析函数。
 *
 * **选择器来源纪律**：Open Design 是打包过的 React 应用（无源码可读），选择器**只能真机采集**，
 * 不能按截图目测硬写——目测出来的坐标/类名会在第一次 UI 升级时静默漂移（issue #23 的教训）。
 * 采集入口：`node scripts/probe-opendesign.mjs anchors`。
 *
 * **当前状态（P1）**：`primary` 全部为空串，`fallbacks` 只保留少量语义化兜底（aria/role 类，
 * 不含任何截图目测的类名）。因此：
 * - `missingSelectorKeys()` 会返回全部**布局守卫键** → `run.ts` 在任何点击之前硬失败 `selector_drift`；
 * - 探针里的 `ANCHOR_CANDIDATES` 提供**宽匹配候选**用于人工收敛，收敛结果写回本文件的 `primary`；
 * - `profile.gui.selectors` 支持按语义键热覆盖（UI 小改版时无需发版）。
 *
 * 采集完成后必须同步 `docs/opendesign-cdp.md` 的证据表。
 */

/** 选择器键：覆盖 12 步流程需要的全部锚点 */
export type OpenDesignSelectorKey =
  | "title"
  | "composer"
  | "inputBox"
  | "workingDirTrigger"
  | "selectDirItem"
  | "workingDirValue"
  | "modelTrigger"
  | "modelMenuItem"
  | "designSystemTrigger"
  | "designSystemSearch"
  | "designSystemItem"
  | "designDirectionTrigger"
  | "designDirectionItem"
  | "sendButton"
  | "stopButton"
  | "conversationText";

export interface OpenDesignSelectorSpec {
  /**
   * 主选择器（真机采集得到）。空串 = 尚未采集——**不写任何目测值**，
   * 让 fail-closed 门禁如实拦住派发，而不是用猜的选择器去点错地方。
   */
  primary: string;
  /** 语义化兜底候选（aria/role 等稳定语义，不含截图目测的类名） */
  fallbacks?: string[];
  /** 精确文本谓词（NFKC 归一后全等匹配） */
  texts?: string[];
  /** aria-label 精确匹配 */
  ariaLabels?: string[];
  /** aria-label 正则匹配 */
  ariaPatterns?: string[];
  /** 命中这些选择器的祖先即排除（避免点到容器） */
  excludes?: string[];
  /** 限定作用域的祖先选择器 */
  scope?: string;
}

/**
 * 布局守卫键：**必须全部有值**才允许开始操作。
 *
 * 只收「工作区初始状态就存在」的锚点。刻意**不含**下列键——它们在初始页面并不存在，
 * 放进守卫会让适配器永远无法启动：
 * - `selectDirItem`（展开「工作目录」后才出现）
 * - 三个 `*MenuItem` / `designSystemItem`（菜单/面板打开后才出现）
 * - `stopButton`（任务运行时才出现）
 * - `designSystemSearch`（设计系统面板打开后才出现）
 */
export const OPEN_DESIGN_LAYOUT_GUARD_KEYS: readonly OpenDesignSelectorKey[] = [
  "title",
  "composer",
  "inputBox",
  "workingDirTrigger",
  "workingDirValue",
  "modelTrigger",
  "designSystemTrigger",
  "designDirectionTrigger",
  "sendButton",
  "conversationText",
];

export const OPEN_DESIGN_SELECTORS: Record<OpenDesignSelectorKey, OpenDesignSelectorSpec> = {
  /** 页面标题/框架锚点：用于确认「连上的是 Open Design 主窗口」且页面已渲染 */
  title: {
    primary: "",
    fallbacks: ["header h1", "main h1"],
  },
  /** 输入区容器（发送按钮与各选择器都在其中） */
  composer: {
    primary: "",
    fallbacks: ["main form", "[role=form]"],
  },
  /** 任务书输入框 */
  inputBox: {
    primary: "",
    fallbacks: ["textarea", "[contenteditable=true]", "[role=textbox]"],
  },
  /** 「工作目录」触发器（图 1 第 1 步） */
  workingDirTrigger: {
    primary: "",
    fallbacks: ["[aria-haspopup]", "[aria-expanded]"],
  },
  /** 「选择目录」菜单项（图 1 第 2 步） */
  selectDirItem: {
    primary: "",
    fallbacks: ["[role=menuitem]", "[role=option]"],
  },
  /** 工作目录显示值（绑定后的回读判据） */
  workingDirValue: {
    primary: "",
    fallbacks: ["[aria-label]", "code"],
  },
  /** 模型触发器（图 3 第 1 步） */
  modelTrigger: {
    primary: "",
    fallbacks: ["[aria-haspopup]", "[aria-expanded]"],
  },
  /** 模型菜单项（图 3 第 2 步） */
  modelMenuItem: {
    primary: "",
    fallbacks: ["[role=menuitem]", "[role=option]", "[role=menuitemradio]"],
  },
  /** 设计系统触发器（图 4 第 1 步） */
  designSystemTrigger: {
    primary: "",
    fallbacks: ["[aria-haspopup]", "[aria-expanded]"],
  },
  /** 设计系统搜索框（图 4 第 3 步） */
  designSystemSearch: {
    primary: "",
    fallbacks: ["input[type=search]", "[role=searchbox]", "input[placeholder]"],
  },
  /** 设计系统列表项（图 4 第 2 步） */
  designSystemItem: {
    primary: "",
    fallbacks: ["[role=option]", "[role=menuitem]", "[role=listitem]"],
  },
  /** 设计方向触发器（图 5 第 1 步） */
  designDirectionTrigger: {
    primary: "",
    fallbacks: ["[aria-haspopup]", "[aria-expanded]"],
  },
  /** 设计方向菜单项（图 5 第 2 步） */
  designDirectionItem: {
    primary: "",
    fallbacks: ["[role=menuitem]", "[role=option]", "[role=menuitemradio]"],
  },
  /** 发送按钮（图 1/图 3/图 5 右上角的圆形按钮） */
  sendButton: {
    primary: "",
    fallbacks: ["button[type=submit]", "[aria-label*=send i]", "[aria-label*=发送]"],
  },
  /** 停止按钮：**运行中的权威信号**（任务运行时才出现） */
  stopButton: {
    primary: "",
    fallbacks: ["[aria-label*=stop i]", "[aria-label*=停止]"],
  },
  /** 对话正文容器：运行检测取文本哈希 */
  conversationText: {
    primary: "",
    fallbacks: ["[role=log]", "[class*=message i]"],
  },
};

/** 合并 profile 覆盖后的 CSS 候选（去重，覆盖优先） */
export function cssCandidates(
  spec: OpenDesignSelectorSpec,
  overrides: Record<string, string> = {},
  key?: string,
): string[] {
  const override = key ? overrides[key] : undefined;
  return [
    ...new Set(
      [override, spec.primary, ...(spec.fallbacks ?? [])].filter((v): v is string => Boolean(v)),
    ),
  ];
}

/**
 * 未采集到的**布局守卫键**（返回空数组 = 可以开始操作）。
 * 由 `run.ts` 在连接后立即调用；非空即 `selector_drift` 硬失败并回显缺失键。
 */
export function missingSelectorKeys(
  overrides: Record<string, string> = {},
): OpenDesignSelectorKey[] {
  return OPEN_DESIGN_LAYOUT_GUARD_KEYS.filter((key) => {
    const override = overrides[key]?.trim();
    if (override) return false;
    return !OPEN_DESIGN_SELECTORS[key].primary.trim();
  });
}

/**
 * 生成页面内 resolve 函数源码：按 CSS 候选 + 文本/aria 谓词解析元素（文档顺序去重）。
 * 与 `kimicode/selectors.ts` 的 `__kimicodeResolve` **同构但独立命名**：
 * 两套表达式在同一页面里语义一致、互不干扰（测试也各认各的标记）。
 * 调用形式：`__opendesignResolve(css, texts, arias, pats, excl, scope)` 或单数组形式。
 */
export function resolveFnSource(): string {
  return `function __opendesignResolve(a,b,c,d,e,f){
    var raw=Array.isArray(a)?a:[a,b,c,d,e,f];
    // specArgs() 产出的是 JSON 字符串（页面内直接内联），裸数组也要支持。
    // 少了这一步，JSON 字符串会被当成 css 候选去 querySelectorAll → 永远零命中（静默失效）。
    if(typeof raw[0]==='string'){try{const parsed=JSON.parse(raw[0]);if(Array.isArray(parsed))raw=parsed}catch(_){}}
    // 单选择器简写：spec 首元素仍是字符串 → 把 css 包成数组，**保留其余位置**
    // （曾写成 raw=[[raw[0]]]，把 texts/arias 全丢掉，导致坏 CSS 时回退候选被误当文本谓词）
    if(typeof raw[0]==='string')raw=[[raw[0]],raw[1],raw[2],raw[3],raw[4],raw[5]];
    var css=raw[0]||[],texts=raw[1]||[],arias=raw[2]||[],pats=raw[3]||[],excl=raw[4]||[],scopeSel=raw[5]||'';
    // spec 形态错误要**响亮**：css 不是数组时返回哨兵节点，由探针报 count=-1。
    // 静默返回 [] 会把「表达式拼错」伪装成「页面没这个元素」，是最难查的一类故障。
    if(!Array.isArray(css))return[{__odSpecError:'spec css is not an array'}];
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
export function specArgs(
  spec: OpenDesignSelectorSpec,
  overrides: Record<string, string> = {},
  key?: string,
): string {
  return JSON.stringify([
    cssCandidates(spec, overrides, key),
    spec.texts ?? [],
    spec.ariaLabels ?? [],
    spec.ariaPatterns ?? [],
    spec.excludes ?? [],
    spec.scope ?? "",
  ]);
}

/** 语义键的 spec 解析（含 profile.gui.selectors 覆盖） */
export function selectorSpec(
  key: OpenDesignSelectorKey,
  overrides: Record<string, string> = {},
): string {
  return specArgs(OPEN_DESIGN_SELECTORS[key], overrides, key);
}
