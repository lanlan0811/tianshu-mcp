import {
  TraeworkCdpClient,
  CdpDisconnectedError,
  CdpUnavailableError,
} from "../traework/cdp/client.js";
import { candidateExpr, type ZcodeSelectorKey } from "./selectors.js";
import type { ZcodePoll } from "./liveness.js";
import { projectDisplayName, type ZcodeProjectItem } from "./project.js";
import { normalizeZcodeModelSelection, type ZcodeModelSelectionRaw } from "./model.js";
import {
  ZCODE_DOM,
  projectTriggerDom,
  projectTriggerProbeExpression,
  projectMenuOpenExpression,
  workOutsideProjectExpression,
  workspaceBindingExpression,
  modelSelectionExpression,
  sendButtonPointExpression,
} from "./dom.js";

export { CdpDisconnectedError, CdpUnavailableError };

export async function retryZcodeEvaluation<T>(
  operation: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        attempt >= 1 ||
        !(error instanceof CdpUnavailableError) ||
        error instanceof CdpDisconnectedError
      )
        throw error;
      await sleep(500);
    }
  }
}

export interface ZcodeSessionItem {
  id: string;
  title?: string;
}

export interface ZcodeQuestionAnswerResult {
  answered: boolean;
  count: number;
  available: string[];
  error?: string;
}

export interface ZcodeClickExactResult {
  clicked: boolean;
  count: number;
  available: string[];
  testids?: string[];
}

/**
 * `clickProject` 的失败面：把「没找到」「找到了但目标不可见（3.14.x 幽灵项）」
 * 「触发器本身不可用」区分开——上层据此决定是继续重试、重开菜单，还是回落导入路径。
 */
export type ZcodeProjectClickFailure = "trigger-unavailable" | "not-found" | "not-visible";

export interface ZcodeProjectClickResult {
  clicked: boolean;
  reason: "clicked" | ZcodeProjectClickFailure;
}

/**
 * 思考档位选项的原始事实。归一（token → 规范档位）刻意留在 TS 侧的纯函数里，
 * DOM 表达式只负责如实采集，保证归一逻辑可被单测覆盖。
 */
export interface ZcodeThoughtLevelOption {
  /** data-testid 原值 */
  id: string;
  /** testid 后缀（真机实测为 enabled / disabled） */
  token: string;
  /** 可见文本（如「开启」） */
  text: string;
  checked: boolean;
}

export interface ZcodeThoughtLevelSnapshot {
  triggerMounted: boolean;
  /** 是否为了读取选项而展开过菜单 */
  opened: boolean;
  /** 触发器文本（未展开菜单时，这是当前档位的唯一可读证据） */
  triggerText: string;
  options: ZcodeThoughtLevelOption[];
}

/** 项目触发器就绪状态：每个取值对应一种可区分的失败面，禁止统一降级为「超时」。 */
export type ZcodeTriggerState =
  | "missing"
  | "hidden"
  | "ambiguous"
  | "disabled"
  | "covered"
  | "ready";

export interface ZcodeTriggerProbe {
  state: ZcodeTriggerState;
  /** 命中优先级层的选择器（未命中时为空串） */
  selector: string;
  /** 命中层内的可见匹配数 */
  count: number;
  /** 全部候选选择器命中的节点数（含不可见），用于区分「未挂载」与「已挂载但不可见」 */
  mounted: number;
  ready: boolean;
  point?: { x: number; y: number };
  /** 命中/遮挡节点的最小诊断属性（tag#testid[aria-label]），不含页面正文 */
  detail?: string;
  /**
   * 页面是否处于 hidden（窗口被遮挡/最小化时 Chromium 会节流渲染）。
   * 这是「点击被吞」的最常见环境原因，必须出现在失败诊断里。
   */
  pageHidden?: boolean;
}

export interface ZcodeProjectMenuResult {
  opened: boolean;
  reason?: "not-ready" | "menu-not-open";
  probe: ZcodeTriggerProbe;
}

/** 点击后确认菜单打开的轮询间隔（不是独立超时；窗口由调用方从集中配置与总预算算出）。 */
const PROJECT_MENU_POLL_MS = 100;

/**
 * 触发器点击被吞后的重试间隔。真机实测：ZCode 窗口被其他窗口完全遮挡时，Chromium 判定
 * occluded 并节流页面，合成鼠标事件常被吞掉（首次点击无效、第二次才打开菜单），
 * 所以「点一次然后干等」会必然失败。重试有界，不重置调用方给的 deadline。
 */
const TRIGGER_RECLICK_MS = 1_500;

export class ZcodeCdpClient {
  private readonly inner: TraeworkCdpClient;
  constructor(
    port: number,
    sendTimeoutMs: number,
    private readonly selectors: Record<string, string> = {},
  ) {
    this.inner = new TraeworkCdpClient({ port, sendTimeoutMs });
  }
  connect(): Promise<void> {
    return this.inner.connect();
  }
  disconnect(): void {
    this.inner.disconnect();
  }
  evaluate<T>(expression: string): Promise<T> {
    return retryZcodeEvaluation(() => this.inner.evaluate<T>(expression));
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.inner.send(method, params);
  }

  async dismissMenus(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      // eslint-disable-next-line no-await-in-loop
      const open = await this.evaluate<number>(
        `(function(){return [...document.querySelectorAll('[role="menu"]')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth}).length})()`,
      );
      if (!open) return;
      // eslint-disable-next-line no-await-in-loop
      await this.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
      // eslint-disable-next-line no-await-in-loop
      await this.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
      // eslint-disable-next-line no-await-in-loop
      await this.evaluate(`new Promise(resolve=>setTimeout(resolve,50))`);
    }
  }

  private async clickAt(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }

  async exists(key: ZcodeSelectorKey): Promise<boolean> {
    return this.evaluate(
      `(function(){for(const s of ${candidateExpr(key, this.selectors)}){for(const e of document.querySelectorAll(s)){const r=e.getBoundingClientRect();if(r.width&&r.height)return true}}return false})()`,
    );
  }
  async text(key: ZcodeSelectorKey): Promise<string> {
    return (
      (await this.evaluate<string>(
        `(function(){for(const s of ${candidateExpr(key, this.selectors)}){for(const e of document.querySelectorAll(s)){const r=e.getBoundingClientRect();if(r.width&&r.height)return (e.value||e.textContent||e.getAttribute('title')||'').trim()}}return ''})()`,
      )) || ""
    );
  }
  /**
   * 通用点击：发事件前必须确认目标**真正可点**——在视口内、且该点命中目标自身或其后代。
   *
   * 真机 3.14.4.7912 实测（2026-10-08）：`conversation-new-task` 挂在页面滚动容器底部
   * （y=2474，视口高 640），宽高都 >0 所以旧判据认为「可见」，于是向**视口外**发鼠标事件——
   * Chromium 直接丢弃，但函数返回 true，形成**假成功**：调用方以为点了，实际页面纹丝不动
   * （3 轮冒烟每轮都出现「顶部新建任务按钮未建立草稿（clicked=true）」）。
   *
   * 与 `probeProjectTrigger` 同一套判据（视口裁剪 + elementFromPoint 命中校验）：
   * 多匹配、视口外、被遮挡一律返回 false，让调用方走回退分支而不是空等。
   */
  async click(key: ZcodeSelectorKey): Promise<boolean> {
    if (key === "projectTrigger") {
      // 与等待共用同一就绪判据：多匹配、不可见、禁用、被遮挡一律不算就绪，不发鼠标事件。
      const probe = await this.probeProjectTrigger();
      if (!probe.ready || !probe.point) return false;
      await this.clickAt(probe.point.x, probe.point.y);
      return true;
    }
    const point = await this.evaluate<{ x: number; y: number } | null>(
      `(function(){
        const vw = innerWidth, vh = innerHeight;
        for(const s of ${candidateExpr(key, this.selectors)}){
          for(const e of document.querySelectorAll(s)){
            const r=e.getBoundingClientRect();
            if(!(r.width&&r.height))continue;
            const x=r.left+r.width/2, y=r.top+r.height/2;
            // 视口外：合成事件会被丢弃，不能当作可点击。
            if(x<0||y<0||x>vw||y>vh)continue;
            // 该点必须命中目标自身或其后代；被别的东西盖住不算可点。
            const hit=document.elementFromPoint(x,y);
            if(!hit||!(hit===e||e.contains(hit)))continue;
            return {x,y};
          }
        }
        return null;
      })()`,
    );
    if (!point) return false;
    await this.clickAt(point.x, point.y);
    return true;
  }

  /** 项目触发器结构化探测（只读，不发事件）。 */
  async probeProjectTrigger(): Promise<ZcodeTriggerProbe> {
    return this.evaluate<ZcodeTriggerProbe>(projectTriggerProbeExpression(this.selectors));
  }

  /** 项目菜单是否已真正可见（点击后置条件）。 */
  async projectMenuOpen(): Promise<boolean> {
    return this.evaluate<boolean>(projectMenuOpenExpression());
  }

  /**
   * 探测 → 点击 → 确认项目菜单打开。事件发出不算成功：菜单没开就返回 menu-not-open。
   * deadline 由调用方从集中配置与 setup/task 总预算取上限（重试不重置截止时间）。
   */
  async clickProjectTriggerAndConfirm(deadline: number): Promise<ZcodeProjectMenuResult> {
    const probe = await this.probeProjectTrigger();
    // 菜单可能**已经开着**（上一次尝试或外部操作的残留）。Radix 下拉是 toggle：此时再点
    // 触发器会把它关掉，随后整段等待都会落到 menu-not-open（3.11.2 真机实测踩过）。
    // 所以先查后点。
    if (await this.projectMenuOpen()) return { opened: true, probe };
    if (!probe.ready || !probe.point) return { opened: false, reason: "not-ready", probe };
    let lastClick = 0;
    while (Date.now() < deadline) {
      // 有界重试点击：窗口被遮挡时节流会让首次点击落空（真机实测第二次才生效）。
      // 每轮都先确认菜单未开，因此不会把已经打开的菜单 toggle 掉。
      if (Date.now() - lastClick >= TRIGGER_RECLICK_MS) {
        // eslint-disable-next-line no-await-in-loop
        await this.clickAt(probe.point.x, probe.point.y);
        lastClick = Date.now();
      }
      // eslint-disable-next-line no-await-in-loop
      if (await this.projectMenuOpen()) return { opened: true, probe };
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, PROJECT_MENU_POLL_MS));
    }
    return { opened: false, reason: "menu-not-open", probe };
  }

  /**
   * 点击「不在项目中工作」（要求该层唯一可见）：进入 ZCode 的 default（无项目）工作区。
   * 新建任务会继承上一次绑定，所以无项目派发必须先显式执行这一步。
   */
  async clickWorkOutsideProject(): Promise<{ clicked: boolean; count: number }> {
    const found = await this.evaluate<{ count: number; point?: { x: number; y: number } }>(
      workOutsideProjectExpression(this.selectors),
    );
    if (!found.point) return { clicked: false, count: found.count };
    await this.clickAt(found.point.x, found.point.y);
    return { clicked: true, count: 1 };
  }

  /**
   * 按可见文本精确定位候选项并作用。
   *
   * `mode="hover"` 只发 mouseMoved、不发按键：radix 的**二级子菜单**（如模型菜单的
   * provider 分组）要 hover 才渲染子项，click 会选中分组本身或把菜单收起——
   * 这是 issue #27「两级模型菜单点击不稳」的真机根因（3.14.3 实测）。
   */
  async clickExact(
    key: ZcodeSelectorKey,
    value: string,
    mode: "click" | "hover" = "click",
  ): Promise<ZcodeClickExactResult> {
    const found = await this.evaluate<{
      count: number;
      available: string[];
      testids?: string[];
      point?: { x: number; y: number };
    }>(
      `(async function(){const norm=s=>(s||'').normalize('NFKC').trim().toLocaleLowerCase();const target=norm(${JSON.stringify(value)});const sels=${candidateExpr(key, this.selectors)};const visible=e=>{const r=e.getBoundingClientRect();if(!(r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth))return false;const x=Math.max(0,Math.min(innerWidth-1,r.left+r.width/2)),y=Math.max(0,Math.min(innerHeight-1,r.top+r.height/2)),hit=document.elementFromPoint(x,y);return !!hit&&(hit===e||e.contains(hit))};const items=()=>{const out=[];for(const s of sels)for(const e of document.querySelectorAll(s))if(visible(e)&&!out.includes(e))out.push(e);return out};const leafTexts=e=>[...e.querySelectorAll('*')].filter(n=>n.children.length===0).map(n=>(n.textContent||'').trim()).filter(Boolean);const directText=e=>[...e.childNodes].filter(n=>n.nodeType===3).map(n=>(n.textContent||'').trim()).filter(Boolean).join(' ');const label=e=>(e.getAttribute('data-value')||e.getAttribute('data-model')||e.getAttribute('data-provider')||directText(e)||leafTexts(e)[0]||e.textContent||'').trim();let nodes=items();let scroller=nodes[0];while(scroller&&scroller!==document.body&&scroller.scrollHeight<=scroller.clientHeight)scroller=scroller.parentElement;const start=scroller?.scrollTop||0;if(scroller)scroller.scrollTop=0;const seen=new Map(),seenTestids=new Map(),matches=new Map();for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,25));nodes=items();for(const e of nodes){const text=label(e);const testid=e.getAttribute('data-testid')||'';const id=e.getAttribute('data-id')||e.getAttribute('data-model-id')||e.getAttribute('data-value')||e.getAttribute('data-model')||e.getAttribute('data-provider')||testid||text;const key=norm(id)+'|'+norm(text);if(testid)seenTestids.set(key,testid);if(!text)continue;seen.set(key,text);if(norm(text)===target)matches.set(key,{top:scroller?.scrollTop||0,text})}if(!scroller||scroller.scrollTop+scroller.clientHeight>=scroller.scrollHeight-1)break;const before=scroller.scrollTop;scroller.scrollTop=Math.min(scroller.scrollTop+Math.max(100,scroller.clientHeight*.8),scroller.scrollHeight);if(scroller.scrollTop===before)break}const result={available:[...seen.values()],testids:[...seenTestids.values()]};const matchesFound=[...matches.values()];if(matchesFound.length===1){if(scroller)scroller.scrollTop=matchesFound[0].top;await new Promise(r=>setTimeout(r,50));const exact=items().filter(e=>norm(label(e))===target);if(exact.length===1){exact[0].scrollIntoView({block:'center'});const r=exact[0].getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;const hit=document.elementFromPoint(x,y);if(hit&&(hit===exact[0]||exact[0].contains(hit)))return {count:1,...result,point:{x,y}};return {count:1,...result}}}if(scroller)scroller.scrollTop=start;return {count:matchesFound.length,...result}})()`,
    );
    if (!found.point)
      return {
        clicked: false,
        count: found.count,
        available: found.available,
        testids: found.testids,
      };
    if (mode === "hover")
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: found.point.x,
        y: found.point.y,
      });
    else await this.clickAt(found.point.x, found.point.y);
    return {
      clicked: true,
      count: found.count,
      available: found.available,
      testids: found.testids,
    };
  }
  async selection(_key: ZcodeSelectorKey): Promise<{ display: string; internal: string }> {
    const raw = await this.evaluate<ZcodeModelSelectionRaw>(
      modelSelectionExpression(this.selectors),
    );
    return normalizeZcodeModelSelection(raw);
  }
  /**
   * 采集项目候选（issue #27 修复）。
   *
   * 两条渠道**始终合并**，不再用 `if(!out.length)` 短路——3.14.x 下必被视口外的侧边栏
   * 幽灵项污染，那时短路恒为假，唯一可信的菜单渠道被整条掐掉。
   * 侧边栏项（旧契约）必须先过 `ZCODE_DOM.visible`：3.14.x 的 `workspace-item-*`
   * 并未从 DOM 消失，只是尺寸塌陷/被滚出视口，它们不是可信的项目证据。
   * 同名时菜单项覆盖侧边栏项：只有菜单的 `aria-checked` 是 ZCode 自己渲染的绑定证据。
   */
  /**
   * 思考档位的只读快照（issue #27 问题三）。
   *
   * 真机实测（2026-09-30，ZCode 3.14.3-Windows）：档位**选项只在菜单展开时挂载**，
   * 因此没有挂载任何选项时按需点开一次、读完立刻关闭（不给后续步骤留副作用）。
   * 只采集原始事实，档位归一与校验交给 model.ts 的纯函数。
   */
  async thoughtLevelSnapshot(): Promise<ZcodeThoughtLevelSnapshot> {
    const triggerExpr = `(function(){${ZCODE_DOM}
      const found=pick(${candidateExpr("thoughtLevelTrigger", this.selectors)});
      return {mounted:found.count?1:0, text:(found.node?.textContent||'').replace(/\\s+/g,' ').trim()};
    })()`;
    const optionsExpr = `(function(){${ZCODE_DOM}
      const out=[];
      for(const s of ${candidateExpr("thoughtLevelOption", this.selectors)})for(const e of document.querySelectorAll(s)){
        const r=e.getBoundingClientRect();
        if(!(r.width&&r.height))continue;
        const id=e.getAttribute('data-testid')||'';
        out.push({id,
          token:id.startsWith('chat-thought-level-select-item-')?id.slice('chat-thought-level-select-item-'.length):'',
          text:(e.textContent||'').replace(/\\s+/g,' ').trim(),
          checked:e.getAttribute('aria-checked')==='true'});
      }
      return out;
    })()`;
    const probe = await this.evaluate<{ mounted: number; text: string }>(triggerExpr);
    if (!probe.mounted)
      return { triggerMounted: false, opened: false, triggerText: probe.text, options: [] };
    let options = await this.evaluate<ZcodeThoughtLevelOption[]>(optionsExpr);
    let opened = false;
    if (!options.length && (await this.click("thoughtLevelTrigger"))) {
      await this.evaluate(`new Promise(r=>setTimeout(r,250))`);
      options = await this.evaluate<ZcodeThoughtLevelOption[]>(optionsExpr);
      opened = options.length > 0;
      await this.dismissRadixSelect();
    }
    const after = await this.evaluate<{ mounted: number; text: string }>(triggerExpr);
    return { triggerMounted: true, opened, triggerText: after.text, options };
  }

  /** 点击指定 testid 的档位选项（选项需已挂载）。 */
  async clickThoughtLevelOption(id: string): Promise<boolean> {
    const point = await this.evaluate<{ x: number; y: number } | null>(
      `(function(){${ZCODE_DOM}
        for(const s of ${candidateExpr("thoughtLevelOption", this.selectors)})for(const e of document.querySelectorAll(s)){
          if((e.getAttribute('data-testid')||'')!==${JSON.stringify(id)})continue;
          const r=e.getBoundingClientRect();
          if(!(r.width&&r.height))continue;
          e.scrollIntoView({block:'center'});
          const b=e.getBoundingClientRect();
          return {x:b.left+b.width/2,y:b.top+b.height/2};
        }
        return null;
      })()`,
    );
    if (!point) return false;
    await this.clickAt(point.x, point.y);
    return true;
  }

  /**
   * 关闭 radix select 的 listbox。`dismissMenus` 只认 `[role="menu"]`，
   * 而档位下拉是 combobox + listbox，需要单独的 Escape。
   */
  private async dismissRadixSelect(): Promise<void> {
    for (let i = 0; i < 2; i++) {
      // eslint-disable-next-line no-await-in-loop
      await this.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
      // eslint-disable-next-line no-await-in-loop
      await this.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
      // eslint-disable-next-line no-await-in-loop
      await this.evaluate(`new Promise(r=>setTimeout(r,120))`);
    }
  }

  async projects(): Promise<ZcodeProjectItem[]> {
    return this.evaluate(
      `(function(){${ZCODE_DOM}
        const order=[];
        const byName=new Map();
        const put=(name,path,id,checked,channel)=>{
          const n=(name||'').trim();
          if(!n)return;
          const key=norm(n);
          const previous=byName.get(key);
          // 菜单渠道优先：同名的侧边栏项被菜单项顶掉；同渠道之间保持先入先得。
          if(previous&&previous.channel==='menu'&&channel!=='menu')return;
          if(!previous)order.push(key);
          byName.set(key,{item:{name:n,path:path||undefined,id:id||undefined,checked},channel});
        };
        for(const s of ${candidateExpr("projectItem", this.selectors)})for(const e of document.querySelectorAll(s)){
          if(!visible(e))continue;
          const testid=e.getAttribute('data-testid')||'';
          const testPath=testid.startsWith('workspace-item-')?testid.slice('workspace-item-'.length):undefined;
          const name=(e.getAttribute('data-project-name')||e.querySelector('[class*=name]')?.textContent||e.textContent||'').trim();
          const p=e.getAttribute('data-project-path')||e.querySelector('[data-project-path]')?.getAttribute('data-project-path')||testPath||e.getAttribute('title')||undefined;
          const id=e.getAttribute('data-project-id')||e.getAttribute('data-id')||testid||undefined;
          put(name,p,id,undefined,'sidebar');
        }
        // issue #24：ZCode 3.14.x 已删除 workspace-item-*，项目列表只能从展开的下拉菜单采集。
        for(const s of ${candidateExpr("projectMenuItem", this.selectors)})for(const e of document.querySelectorAll(s)){
          const name=(e.getAttribute('aria-label')||e.textContent||'').trim();
          // 「不在项目中工作」是工作区切换项，不是项目——按本地化标签排除。
          if(/不在项目中|outside a project|work outside/i.test(name))continue;
          put(name,undefined,e.getAttribute('data-value')||undefined,e.getAttribute('aria-checked')==='true','menu');
        }
        return order.map(key=>byName.get(key).item)
      })()`,
    );
  }
  async clickProject(
    id: string | undefined,
    projectPath: string | undefined,
  ): Promise<ZcodeProjectClickResult> {
    const displayName = projectPath ? projectDisplayName(projectPath) : "";
    const outcome = await this.evaluate<
      { point: { x: number; y: number } } | { reason: ZcodeProjectClickFailure }
    >(
      `(async function(){${projectTriggerDom(this.selectors)}if(!trigger)return {reason:'trigger-unavailable'};const targetName=norm(${JSON.stringify(displayName)});let containers=[];const controlledId=trigger?.getAttribute('aria-controls')||'';if(controlledId){const controlled=document.getElementById(controlledId);if(controlled&&visible(controlled))containers.push(controlled)}if(trigger){let parent=trigger.parentElement;while(parent&&!containers.length){if(parent.querySelector('[role="menuitemcheckbox"]'))containers.push(parent);parent=parent.parentElement}}if(!containers.length)containers=[...document.querySelectorAll('[role="menu"]')].filter(e=>visible(e)&&e.querySelector('[role="menuitemcheckbox"]'));const checkboxMatches=[];for(const container of containers)for(const e of container.querySelectorAll('[role="menuitemcheckbox"]'))if(visible(e)&&norm(e.getAttribute('aria-label')||e.getAttribute('data-value')||e.textContent||'')===targetName&&!checkboxMatches.includes(e))checkboxMatches.push(e);let selected=checkboxMatches.length===1?checkboxMatches[0]:null;if(!selected){const matches=[];for(const s of ${candidateExpr("projectItem", this.selectors)})for(const e of document.querySelectorAll(s)){const testid=e.getAttribute('data-testid')||'';const itemId=e.getAttribute('data-project-id')||e.getAttribute('data-id')||testid;const p=e.getAttribute('data-project-path')||e.querySelector('[data-project-path]')?.getAttribute('data-project-path')||(testid.startsWith('workspace-item-')?testid.slice('workspace-item-'.length):'')||e.getAttribute('title')||'';if(((${JSON.stringify(id ?? "")}&&itemId===${JSON.stringify(id ?? "")})||(${JSON.stringify(projectPath ?? "")}&&p===${JSON.stringify(projectPath ?? "")}))&&!matches.includes(e))matches.push(e)}const shown=matches.filter(visible);if(matches.length&&!shown.length)return {reason:'not-visible'};if(shown.length===1)selected=shown[0]}if(!selected)return {reason:'not-found'};selected.scrollIntoView({block:'center'});await new Promise(r=>setTimeout(r,50));const r=selected.getBoundingClientRect();return visible(selected)?{point:{x:r.left+r.width/2,y:r.top+r.height/2}}:{reason:'not-visible'}})()`,
    );
    if (!("point" in outcome)) return { clicked: false, reason: outcome.reason };
    await this.clickAt(outcome.point.x, outcome.point.y);
    return { clicked: true, reason: "clicked" };
  }
  async boundProjectPath(): Promise<string> {
    return (await this.workspaceBinding()).projectPath;
  }
  async workspaceBinding(): Promise<{
    triggerText: string;
    projectPath: string;
    /** 当前绑定的显示名（3.14.x 无路径渠道时的证据；菜单未开时等于触发器文本） */
    projectName?: string;
    /** 展开菜单中 aria-checked=true 的显示名，用于判定绑定与检测同名/多选歧义 */
    menuChecked?: string[];
    ambiguous?: boolean;
  }> {
    return this.evaluate(workspaceBindingExpression(this.selectors));
  }
  async session(): Promise<{ id?: string; title?: string }> {
    return this.evaluate(
      `(function(){const stable=id=>id&&id!=='draft'?id:undefined;const idOf=e=>{if(!e)return undefined;const explicit=stable(e.getAttribute('data-session-id'));if(explicit)return explicit;const testid=e.getAttribute('data-testid')||'';return testid.startsWith('task-item-')?stable(testid.slice('task-item-'.length)):undefined};const selectors=['[data-testid^="v4-session-pane"][data-session-id]','[data-session-id][aria-current=true]','[data-session-id][aria-selected=true]','[data-testid^="task-item-"][aria-current=true]','[data-testid^="task-item-"][aria-selected=true]','[data-testid^="task-item-"][data-state=active]','[data-testid^="task-item-"][data-state=selected]'];let active=null;for(const s of selectors){active=[...document.querySelectorAll(s)].find(e=>{const r=e.getBoundingClientRect();return r.width&&r.height})||null;if(active)break}const id=idOf(active)||stable(history.state?.sessionId)||stable(history.state?.taskId)||undefined;const item=id?[...document.querySelectorAll('[data-testid^="task-item-"]')].find(e=>(e.getAttribute('data-testid')||'').slice('task-item-'.length)===id):null;return {id,title:id?(item?.getAttribute('title')||item?.textContent||active?.getAttribute('title')||'').trim().slice(0,240)||undefined:undefined}})()`,
    );
  }
  async sessions(): Promise<ZcodeSessionItem[]> {
    return this.evaluate(
      `(function(){const out=[],seen=new Set();for(const e of document.querySelectorAll('[data-session-id],[data-testid^="task-item-"]')){const testid=e.getAttribute('data-testid')||'';const id=e.getAttribute('data-session-id')||(testid.startsWith('task-item-')?testid.slice('task-item-'.length):'');if(!id||id==='draft'||seen.has(id))continue;seen.add(id);const title=(e.getAttribute('title')||e.querySelector('[data-testid*="title"],[title]')?.getAttribute('title')||e.textContent||'').trim().slice(0,240)||undefined;out.push({id,title})}return out})()`,
    );
  }
  async sessionForMarker(marker: string): Promise<ZcodeSessionItem | undefined> {
    return this.evaluate(
      `(function(){const marker=${JSON.stringify(marker)};const matches=[];for(const timeline of document.querySelectorAll('[data-testid="v4-timeline"]')){if(!(timeline.textContent||'').includes(marker))continue;const pane=timeline.closest('[data-session-id]');const id=pane?.getAttribute('data-session-id');if(!id||id==='draft'||matches.some(x=>x.id===id))continue;const item=[...document.querySelectorAll('[data-testid^="task-item-"]')].find(e=>(e.getAttribute('data-testid')||'').slice('task-item-'.length)===id);matches.push({id,title:(item?.getAttribute('title')||item?.textContent||'').trim().slice(0,240)||undefined})}return matches.length===1?matches[0]:undefined})()`,
    );
  }
  async selectSession(id?: string, title?: string): Promise<boolean> {
    const selected = await this.evaluate<
      { already: true } | { point: { x: number; y: number } } | null
    >(
      `(function(){const byId=${JSON.stringify(id ?? "")};const byTitle=${JSON.stringify(title ?? "")};const idOf=e=>{const explicit=e.getAttribute('data-session-id');if(explicit)return explicit;const testid=e.getAttribute('data-testid')||'';return testid.startsWith('task-item-')?testid.slice('task-item-'.length):''};if(byId){const active=[...document.querySelectorAll('[data-testid^="v4-session-pane"][data-session-id]')].find(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&e.getAttribute('data-session-id')===byId});if(active)return {already:true}}const nodes=[...document.querySelectorAll('[data-testid^="task-item-"]')];const found=nodes.filter(e=>(byId&&idOf(e)===byId)||(!byId&&byTitle&&(e.getAttribute('title')||e.textContent||'').trim()===byTitle));if(found.length!==1)return null;found[0].scrollIntoView({block:'center'});const r=found[0].getBoundingClientRect();return r.width&&r.height?{point:{x:r.left+r.width/2,y:r.top+r.height/2}}:null})()`,
    );
    if (!selected) return false;
    if ("already" in selected) return true;
    await this.clickAt(selected.point.x, selected.point.y);
    return true;
  }
  async inputText(): Promise<string> {
    return this.text("chatInput");
  }
  async typeText(text: string): Promise<void> {
    const ok = await this.evaluate<boolean>(
      `(function(){for(const s of ${candidateExpr("chatInput", this.selectors)})for(const e of document.querySelectorAll(s)){const r=e.getBoundingClientRect();if(r.width&&r.height){e.focus();return true}}return false})()`,
    );
    if (!ok) throw new Error("找不到 ZCode 输入框");
    await this.send("Input.insertText", { text });
  }
  async sendMessage(): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (let attempt = 0; attempt < 50 && Date.now() < deadline; attempt++) {
      const point = await this.evaluate<{ x: number; y: number } | null>(
        sendButtonPointExpression(this.selectors),
      );
      if (point) {
        await this.clickAt(point.x, point.y);
        return;
      }
      await this.evaluate("new Promise(resolve=>setTimeout(resolve,200))");
    }
    // 窗口被遮挡/最小化时 Chromium 会节流页面：合成鼠标事件与 elementFromPoint 都不可靠，
    // 按钮「明明在视口内」却点不到（3.11.2-Windows 真机实测 visibilityState=hidden、
    // elementFromPoint 命中非按钮节点）。此时只报按钮会把用户引向错误方向；
    // Page.bringToFront 实测无法恢复被遮挡的 Electron 窗口，所以如实报出真因并给出
    // 可操作指引，不假装能自动恢复。
    let throttled = false;
    try {
      throttled = await this.evaluate<boolean>(
        "document.visibilityState === 'hidden' || document.hidden === true",
      );
    } catch {
      throttled = false;
    }
    throw new Error(
      throttled
        ? "ZCode 发送按钮在观察期内不可点击：ZCode 窗口当前不在前台（页面被节流，合成点击不可靠）——请把 ZCode 窗口置于前台后重试；未发送任务"
        : "ZCode 发送按钮未在观察期内启用或被遮挡；未发送任务",
    );
  }
  async answerQuestion(answer: string): Promise<ZcodeQuestionAnswerResult> {
    const located = await this.evaluate<{
      count: number;
      available: string[];
      point?: { x: number; y: number };
      buttonStates: boolean[];
    }>(
      `(function(){const norm=s=>(s||'').normalize('NFKC').trim().toLocaleLowerCase();const target=norm(${JSON.stringify(answer)});const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&s.display!=='none'&&s.visibility!=='hidden'};const boxes=[...document.querySelectorAll('[role="listbox"][aria-label]:has([role="option"])')].filter(visible);if(boxes.length!==1)return {count:boxes.length,available:[],buttonStates:[]};const box=boxes[0];const options=[...box.querySelectorAll('[role="option"]')].filter(visible);const label=e=>{const leaves=[...e.querySelectorAll('*')].filter(n=>n.children.length===0).map(n=>(n.textContent||'').trim()).filter(Boolean);return leaves.find(x=>norm(x)===target)||e.getAttribute('aria-label')||e.getAttribute('data-value')||''};const available=options.map(e=>{const leaves=[...e.querySelectorAll('*')].filter(n=>n.children.length===0).map(n=>(n.textContent||'').trim()).filter(Boolean);return leaves.find(x=>x&&!/^\\d+[.\uff0e]$/.test(x))||(e.textContent||'').trim()}).filter(Boolean);const matches=options.filter(e=>norm(label(e))===target);let scope=box,buttons=[];while(scope.parentElement){scope=scope.parentElement;buttons=[...scope.querySelectorAll('button:not([role="option"])')].filter(visible);if(buttons.length)break}if(matches.length!==1)return {count:matches.length,available,buttonStates:buttons.map(e=>e.disabled||e.getAttribute('aria-disabled')==='true')};matches[0].scrollIntoView({block:'center'});const r=matches[0].getBoundingClientRect();return {count:1,available,point:{x:r.left+r.width/2,y:r.top+r.height/2},buttonStates:buttons.map(e=>e.disabled||e.getAttribute('aria-disabled')==='true')}})()`,
    );
    if (!located.point)
      return { answered: false, count: located.count, available: located.available };
    await this.clickAt(located.point.x, located.point.y);
    await this.evaluate(`new Promise(resolve=>setTimeout(resolve,100))`);
    const submit = await this.evaluate<
      | { answered: true }
      | { answered: false; error: string }
      | { answered: false; point: { x: number; y: number } }
    >(
      `(function(){const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&s.display!=='none'&&s.visibility!=='hidden'};const boxes=[...document.querySelectorAll('[role="listbox"][aria-label]:has([role="option"])')].filter(visible);if(boxes.length===0)return {answered:true};if(boxes.length!==1)return {answered:false,error:'问题卡片数量不唯一'};let scope=boxes[0],buttons=[];while(scope.parentElement){scope=scope.parentElement;buttons=[...scope.querySelectorAll('button:not([role="option"])')].filter(visible);if(buttons.length)break}const enabled=buttons.filter(e=>!e.disabled&&e.getAttribute('aria-disabled')!=='true');const submits=enabled.filter(e=>e.type==='submit');const newlyEnabled=buttons.filter((e,i)=>!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&${JSON.stringify(located.buttonStates)}[i]===true);const candidates=submits.length===1?submits:newlyEnabled.length===1?newlyEnabled:enabled.length===1?enabled:[];if(candidates.length!==1)return {answered:false,error:'无法唯一定位问题提交按钮'};const r=candidates[0].getBoundingClientRect();return {answered:false,point:{x:r.left+r.width/2,y:r.top+r.height/2}}})()`,
    );
    if (submit.answered) return { answered: true, count: 1, available: located.available };
    if (!("point" in submit))
      return { answered: false, count: 1, available: located.available, error: submit.error };
    await this.clickAt(submit.point.x, submit.point.y);
    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await this.exists("questionCard")))
        return { answered: true, count: 1, available: located.available };
      // eslint-disable-next-line no-await-in-loop
      await this.evaluate(`new Promise(resolve=>setTimeout(resolve,100))`);
    }
    return {
      answered: false,
      count: 1,
      available: located.available,
      error: "问题选项提交后卡片未消失",
    };
  }
  async conversationText(): Promise<string> {
    return this.text("messageList");
  }
  async poll(): Promise<ZcodePoll> {
    return this.evaluate(
      `(function(){const sels=${JSON.stringify(Object.fromEntries((["stopButton", "runningCard", "toolCall", "questionCard", "assistantMessage", "chatInput", "sendButton"] as ZcodeSelectorKey[]).map((k) => [k, JSON.parse(candidateExpr(k, this.selectors))])))};const visible=k=>{for(const s of sels[k])for(const e of document.querySelectorAll(s)){const r=e.getBoundingClientRect();if(r.width&&r.height)return e}return null};const all=k=>{const a=[];for(const s of sels[k])for(const e of document.querySelectorAll(s))if(!a.includes(e))a.push(e);return a};const q=visible('questionCard');const assistants=all('assistantMessage');const last=assistants[assistants.length-1];const input=visible('chatInput');const send=visible('sendButton');return {stopVisible:!!visible('stopButton'),loading:!!visible('runningCard'),activeTool:!!visible('toolCall'),question:q?(q.getAttribute('aria-label')||q.textContent||'').trim():undefined,assistantText:last?(last.textContent||'').trim():'',inputEnabled:!!input&&!input.disabled&&input.getAttribute('aria-disabled')!=='true',sendEnabled:!!send&&!send.disabled&&send.getAttribute('aria-disabled')!=='true'}})()`,
    );
  }
}
