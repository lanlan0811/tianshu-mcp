/**
 * CodexCdpClient：在 TraeworkCdpClient 底座之上，提供 Codex 桌面端的语义操作。
 *
 * Codex 前端约束（实测）：几乎无 data-testid，定位依赖 aria-label / 可见文本 +
 * 结构选择器兜底，故本客户端统一走 selectors.ts 的 resolve 逻辑，并支持 profile 覆盖。
 */
import { TraeworkCdpClient, CdpDisconnectedError, CdpUnavailableError } from "../traework/cdp/client.js";
import { type CodexSelectorKey, resolveFnSource, specArgs } from "./selectors.js";

export { CdpDisconnectedError, CdpUnavailableError };

export interface CodexProjectItem {
  /** 项目显示名 */
  name: string;
  /** 点击「在 <name> 中开始新聊天」用的 aria-label */
  startChatLabel?: string;
  /** 「<name> 的项目操作」用的 aria-label */
  actionsLabel?: string;
}

export interface CodexPoll {
  /** 权威运行信号：生成期间出现停止按钮 */
  stopVisible: boolean;
  /** 发送按钮当前可见（输入非空时） */
  sendVisible: boolean;
  /** 输入框当前文本 */
  composerText: string;
  /** 对话区文本（用于稳定兜底） */
  conversationText: string;
  /** 登录/引导页可见 */
  loginVisible: boolean;
}

export class CodexCdpClient {
  private readonly inner: TraeworkCdpClient;
  constructor(
    port: number,
    sendTimeoutMs: number,
    private readonly selectors: Record<string, string> = {},
  ) {
    this.inner = new TraeworkCdpClient({
      port,
      sendTimeoutMs,
      // Codex 会额外暴露 avatar-overlay 等次级窗口；主应用页在 index.html 且无 overlay 路由。
      targetRank: (t) => {
        const url = t.url ?? "";
        let rank = 0;
        if (/avatar-overlay|overlay/i.test(url)) rank += 100;
        if (/index\.html/i.test(url)) rank -= 10;
        return rank;
      },
    });
  }
  connect(): Promise<void> {
    return this.inner.connect();
  }
  disconnect(): void {
    this.inner.disconnect();
  }
  evaluate<T>(expression: string): Promise<T> {
    return this.inner.evaluate<T>(expression);
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.inner.send(method, params);
  }

  /** 注入页面内 resolve 工具（每次调用独立作用域，避免污染全局） */
  private withResolve(body: string): string {
    return `(function(){${resolveFnSource()};${body}})()`;
  }

  private visibleFilter = `const vis=(e)=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth};`;

  async dismissMenus(): Promise<void> {
    // 先关弹出菜单/列表，再关残留对话框（上一轮失败可能留下「创建项目」对话框，
    // 会遮挡输入框导致后续找不到触发器）。
    for (let i = 0; i < 6; i++) {
      // eslint-disable-next-line no-await-in-loop
      const open = await this.evaluate<number>(
        `(function(){return [...document.querySelectorAll('[role="menu"],[role="listbox"]')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth}).length})()`,
      );
      if (!open) break;
      // eslint-disable-next-line no-await-in-loop
      await this.pressEscape();
      // eslint-disable-next-line no-await-in-loop
      await this.evaluate(`new Promise(resolve=>setTimeout(resolve,50))`);
    }
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      const dlg = await this.evaluate<number>(
        `(function(){return [...document.querySelectorAll('[role="dialog"]')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth}).length})()`,
      );
      if (!dlg) return;
      // eslint-disable-next-line no-await-in-loop
      await this.pressEscape();
      // eslint-disable-next-line no-await-in-loop
      await this.evaluate(`new Promise(resolve=>setTimeout(resolve,250))`);
    }
  }

  private async pressEscape(): Promise<void> {
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  }

  private async clickAt(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  /** 元素是否存在且可见 */
  async exists(key: CodexSelectorKey): Promise<boolean> {
    return this.evaluate<boolean>(
      this.withResolve(
        `${this.visibleFilter}const els=__codexResolve(${specArgs(key, this.selectors)});return els.some(vis);`,
      ),
    );
  }

  /** 第一个可见元素文本 */
  async text(key: CodexSelectorKey): Promise<string> {
    return (
      (await this.evaluate<string>(
        this.withResolve(
          `${this.visibleFilter}const els=__codexResolve(${specArgs(key, this.selectors)});for(const e of els){if(vis(e))return ((e.value!==undefined?e.value:'')||e.textContent||'').trim()}return '';`,
        ),
      )) || ""
    );
  }

  /** 点击第一个可见元素（DOM click 优先，回退坐标点击） */
  async click(key: CodexSelectorKey): Promise<boolean> {
    const point = await this.evaluate<{ x: number; y: number } | null>(
      this.withResolve(
        `${this.visibleFilter}const els=__codexResolve(${specArgs(key, this.selectors)});for(const e of els){if(!vis(e))continue;const r=e.getBoundingClientRect();if(e.click){e.click();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}}}return null;`,
      ),
    );
    if (point) return true;
    const pos = await this.center(key);
    if (!pos) return false;
    await this.clickAt(pos.x, pos.y);
    return true;
  }

  /**
   * 以**真实 CDP 鼠标事件**点击（trusted），并校验落点确实命中目标（或其后代/祖先）。
   * 打开原生文件/文件夹选择器必须走这一路径：DOM `element.click()` 是 untrusted 事件，
   * 应用会忽略而不弹原生对话框；同时用 elementFromPoint 防止点偏到相邻控件。
   */
  async clickTrusted(key: CodexSelectorKey): Promise<boolean> {
    const point = await this.evaluate<{ x: number; y: number } | null>(
      this.withResolve(
        `${this.visibleFilter}
         const els=__codexResolve(${specArgs(key, this.selectors)}).filter(vis);
         for(const e of els){
           const r=e.getBoundingClientRect();
           const x=Math.round(r.left+r.width/2), y=Math.round(r.top+r.height/2);
           const hit=document.elementFromPoint(x,y);
           if(hit&&(hit===e||e.contains(hit)||hit.contains(e)))return {x,y};
         }
         return null;`,
      ),
    );
    if (!point) return false;
    await this.clickAt(point.x, point.y);
    return true;
  }

  /** 第一个可见元素中心坐标 */
  async center(key: CodexSelectorKey): Promise<{ x: number; y: number } | null> {
    return this.evaluate<{ x: number; y: number } | null>(
      this.withResolve(
        `${this.visibleFilter}const els=__codexResolve(${specArgs(key, this.selectors)});for(const e of els){if(!vis(e))continue;const r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}}return null;`,
      ),
    );
  }

  /**
   * 在可见候选/菜单项里按归一化文本精确选择。
   * 返回匹配数（0=无、1=成功、>1=歧义）与可见候选文本列表。
   */
  async clickExact(
    key: CodexSelectorKey,
    value: string,
  ): Promise<{ clicked: boolean; count: number; available: string[] }> {
    const found = await this.evaluate<{
      count: number;
      available: string[];
      point?: { x: number; y: number };
    }>(
      this.withResolve(
        `const norm=(s)=>(s||'').normalize('NFKC').trim().replace(/\\s+/g,' ').toLocaleLowerCase();
         const target=norm(${JSON.stringify(value)});
         ${this.visibleFilter}
         const els=__codexResolve(${specArgs(key, this.selectors)}).filter(vis);
         const lab=(e)=>((e.getAttribute('aria-label')||'')+' '+(e.innerText||e.textContent||'')).trim();
         const available=[...new Set(els.map(e=>lab(e)).filter(Boolean))];
         const exact=els.filter(e=>{
           const aria=norm(e.getAttribute('aria-label')||'');
           const inner=norm(e.innerText||e.textContent||'');
           return aria===target||inner===target||aria.split(' ').indexOf(target)>=0;
         });
         // 文本命中有歧义时（如「创建项目」既是 <h2> 标题又是 <button>），
         // 优先取真正可交互的元素，避免点到标题容器。
         let picked=exact;
         if(exact.length>1){
           const clickable=exact.filter(e=>/^(BUTTON|A)$/.test(e.tagName)||['button','menuitem','menuitemradio','option','tab'].includes(e.getAttribute('role')||''));
           if(clickable.length===1)picked=clickable;
         }
         if(picked.length===1){const e=picked[0];const r=e.getBoundingClientRect();return {count:1,available,point:{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}}}
         return {count:picked.length,available};`,
      ),
    );
    if (!found.point) return { clicked: false, count: found.count, available: found.available };
    await this.clickAt(found.point.x, found.point.y);
    return { clicked: true, count: found.count, available: found.available };
  }

  /** 点击 aria-label 完全等于给定值（或含动态名称模板）的可见元素 */
  async clickByAriaLabel(label: string): Promise<boolean> {
    const point = await this.evaluate<{ x: number; y: number } | null>(
      `(function(){const norm=(s)=>(s||'').normalize('NFKC').trim();const target=norm(${JSON.stringify(label)});
        ${this.visibleFilter}
        for(const e of document.querySelectorAll('[aria-label]')){if(!vis(e))continue;if(norm(e.getAttribute('aria-label'))===target){const r=e.getBoundingClientRect();if(e.click){e.click();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}}return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}}}return null})()`,
    );
    if (!point) return false;
    await this.clickAt(point.x, point.y);
    return true;
  }

  /** 枚举侧边栏项目：从「<名> 的项目操作」aria-label 提取名称 */
  async projects(): Promise<CodexProjectItem[]> {
    return this.evaluate<CodexProjectItem[]>(
      `(function(){
        const out=[];const seen=new Set();
        const strip=(s)=>s.replace(/\s*(的项目操作|项目操作|project actions)\s*$/i,'').trim();
        for(const e of document.querySelectorAll('[aria-label]')){
          const aria=(e.getAttribute('aria-label')||'').trim();
          const m=/(.+?)\s*(的项目操作|项目操作)$/.exec(aria)||/(.+?)\s*(project actions)$/i.exec(aria);
          if(!m)continue;
          const name=m[1].trim();const key=name.toLocaleLowerCase();
          if(!name||seen.has(key))continue;seen.add(key);
          out.push({name,actionsLabel:aria,startChatLabel:undefined});
        }
        return out;
      })()`,
    );
  }

  /** 读取「创建项目」对话框全文（用于校验源文件夹是否已回填目标目录） */
  async createProjectDialogText(): Promise<string> {
    return (
      (await this.evaluate<string>(
        `(function(){
          const vis=(e)=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0};
          const dlg=[...document.querySelectorAll('[role="dialog"]')].filter(vis).find((d)=>/创建项目|Create project/i.test(d.innerText||''));
          return dlg?((dlg.innerText||'').replace(/\\s+/g,' ').trim()):'';
        })()`,
      )) || ""
    );
  }

  /** 读取当前模型/思考等级触发器文本（限定输入框作用域，排除菜单栏与模式切换器） */
  async modelTriggerText(): Promise<string> {
    return (
      (await this.evaluate<string>(
        this.withResolve(
          `${this.visibleFilter}
           const els=__codexResolve(${specArgs("modelTrigger", this.selectors)}).filter(vis);
           // 输入框同一组还有 本地/分支/权限 三个非模型 chip，按 aria-label 与已知文案剔除
           const known=['选择聊天的运行位置','切换分支','更改权限','Local','Branch','Permissions'];
           const norm=(s)=>(s||'').normalize('NFKC').trim().replace(/\\s+/g,' ').toLocaleLowerCase();
           const knownSet=known.map(norm);
           const pick=els.find((e)=>{
             const aria=norm(e.getAttribute('aria-label')||'');
             if(knownSet.indexOf(aria)>=0)return false;
             const t=(e.innerText||'').trim();
             if(/^(本地|Local|master|main|完全访问|Full access)$/i.test(t))return false;
             return true;
           });
           return pick?((pick.innerText||'').trim()):'';`,
        ),
      )) || ""
    );
  }

  /** 读取当前权限模式文本（切换前回读） */
  async permissionText(): Promise<string> {
    return this.text("permissionTrigger");
  }
  /**
   * 读取当前会话已绑定的项目名。
   * 权威信号：输入框内的项目 chip 带 `aria-label="切换项目：<名>"`（未绑定时为「不在项目中工作」）。
   * 真机教训：早期实现把所有非 chip 按钮文本拼起来，会返回整页文案并意外“通过”匹配。
   */
  async boundProjectName(): Promise<string> {
    return (
      (await this.evaluate<string>(
        `(function(){
          const norm=(s)=>(s||'').normalize('NFKC').trim();
          const vis=(e)=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0};
          for(const e of document.querySelectorAll('[aria-label]')){
            if(!vis(e))continue;
            const aria=norm(e.getAttribute('aria-label'));
            const m=/^(?:切换项目|Switch project)[：:]\\s*(.+)$/i.exec(aria);
            if(m&&m[1])return m[1].trim();
          }
          return '';
        })()`,
      )) || ""
    );
  }

  /** 聚焦输入框（ProseMirror） */
  async focusComposer(): Promise<boolean> {
    return this.evaluate<boolean>(
      this.withResolve(
        `${this.visibleFilter}const els=__codexResolve(${specArgs("chatInput", this.selectors)});for(const e of els){if(vis(e)){e.focus();const s=getSelection();const r=document.createRange();r.selectNodeContents(e);r.collapse(false);s.removeAllRanges();s.addRange(r);return true}}return false;`,
      ),
    );
  }

  async inputText(): Promise<string> {
    return this.text("chatInput");
  }

  /** 写入输入框：ProseMirror 不吃 value，必须走 CDP 输入管线 */
  async typeText(text: string): Promise<void> {
    if (!(await this.focusComposer())) throw new Error("找不到 Codex 输入框（ProseMirror）");
    await this.send("Input.insertText", { text });
  }

  /** 清空输入框 */
  async clearComposer(): Promise<void> {
    await this.evaluate(
      `(function(){const e=document.querySelector('div.ProseMirror[contenteditable="true"]');if(!e)return 'NO';e.focus();const s=getSelection();const r=document.createRange();r.selectNodeContents(e);s.removeAllRanges();s.addRange(r);document.execCommand('delete');return 'OK'})()`,
    );
  }

  /** 发送：优先点发送按钮（条件渲染），否则 Enter */
  async sendMessage(): Promise<void> {
    const clicked = await this.click("sendButton");
    if (clicked) return;
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  }

  /** 一次求值拿全部轮询信号 */
  async poll(): Promise<CodexPoll> {
    return this.evaluate<CodexPoll>(
      this.withResolve(
        `const sels=${JSON.stringify({
          stopButton: specArgs("stopButton", this.selectors),
          sendButton: specArgs("sendButton", this.selectors),
          chatInput: specArgs("chatInput", this.selectors),
          loginIndicator: specArgs("loginIndicator", this.selectors),
          messageArea: specArgs("messageArea", this.selectors),
        })};${this.visibleFilter}
        const resolve=(k)=>__codexResolve(JSON.parse(sels[k]));
        const visAny=(k)=>{for(const e of resolve(k)){if(vis(e))return true}return false};
        const textOf=(k)=>{for(const e of resolve(k)){if(vis(e))return (e.value!==undefined?e.value:'')||(e.innerText||e.textContent||'')}return ''};
        return {
          stopVisible:visAny('stopButton'),
          sendVisible:visAny('sendButton'),
          composerText:(textOf('chatInput')||'').trim(),
          conversationText:(textOf('messageArea')||'').trim().slice(0,20000),
          loginVisible:visAny('loginIndicator')
        };`,
      ),
    );
  }
}
