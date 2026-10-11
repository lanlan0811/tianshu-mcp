import { TraeworkCdpClient } from '../traework/cdp/client.js';
import { QODER_SELECTORS, qoderCandidates, qoderPrimary, type QoderSelectorKey } from './selectors.js';
import type { QoderPoll } from './liveness.js';
import { visibleLabelsExpr, normalizeLabels } from '../gui-diagnostics.js';
import {setTimeout as delay} from 'node:timers/promises';

const VISIBLE = `(e)=>{
  if(!e||e.closest('[inert],[hidden],[aria-hidden="true"],[role="dialog"][data-state="closed"]'))return false;
  const r=e.getBoundingClientRect();if(!r.width||!r.height)return false;
  for(let n=e;n;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return false;}
  return true;
}`;

/** Only the Qoder CN primary workbench may receive input. Never attach arbitrary Electron pages. */
export function qoderTargetRank(t: {url?: string}): number {
  return /^qoder-cn-app:\/\/renderer\/index\.html\?workbenchScope=primary(?:#|$)/.test(t.url ?? '') ? 0 : 100;
}

/**
 * 置前后等前台真正生效的上限。实测 `Page.bringToFront` 异步生效（数百毫秒），
 * 期间派发的合成事件仍会被 Chromium 节流吞掉。
 */
const FOCUS_SETTLE_MS = 1_500;

export class QoderCdpClient {
  private readonly client: TraeworkCdpClient;
  constructor(port: number, private readonly timeout: number, private readonly overrides: Record<string,string> = {}) {
    this.client = new TraeworkCdpClient({
      port,
      sendTimeoutMs: timeout,
      appLabel: "Qoder",
      targetRank: qoderTargetRank,
    });
  }
  selector(key: QoderSelectorKey): string { return qoderPrimary(key, this.overrides); }
  /** 该语义键的全部候选选择器（覆盖优先，其后 primary 与 fallbacks，去重保序） */
  candidates(key: QoderSelectorKey): string[] { return qoderCandidates(key, this.overrides); }
  async connect(): Promise<void> {
    await this.client.connect();
    if (qoderTargetRank({url: await this.evaluate<string>('location.href')}) !== 0) {
      this.disconnect(); throw new Error('qoder_target_mismatch');
    }
    await this.focusMainWindow();
  }
  /**
   * 把主窗口置于前台并开启焦点模拟，然后**等前台真正生效**再返回。
   *
   * 真机教训（2026-10-11，本机 Qoder CN 0.3.4，CDP 9777）：
   *   窗口不在前台时 `document.hidden === true`（`visibilityState === 'hidden'`），
   *   Chromium 节流页面 —— `click()` 首行的 `if(document.hidden)return null` 会让
   *   **每一次**点击都判为「控件缺失」，一轮 15s 超时后抛出
   *   `qoder_control_missing_or_ambiguous`，把**环境**问题（窗口在后台）
   *   误报成**产品**问题（选择器漂移）。
   *   由此 bindWorkspace 在 workspace-picker 阶段静默超时，任务卡在 new-task 之后。
   *
   * 实测（同一实例，A/B 因果验证）：
   *   `Emulation.setFocusEmulationEnabled({enabled:true})` 后 `document.hidden`
   *   由 true 转 false；同一 `clickKey('workspace')` 从 15s 超时变为 0.36s 成功，
   *   菜单随即出现（搜索框 + 9 个候选项），搜索→点选全流程走通。
   *   仅调 `Page.bringToFront` 无效（窗口并非最小化，`IsIconic=false`）。
   *
   * 与 Kimi Code / MiniMax Code 的 `focusMainWindow()` 同构：
   * 失败不抛错——置前只是让点击更容易生效，正确性判据始终是点击后的回读。
   */
  async focusMainWindow(): Promise<void> {
    try {
      await this.client.send('Page.enable');
    } catch {
      /* Page 域不可用不影响后续命令 */
    }
    try {
      await this.client.send('Page.bringToFront');
    } catch {
      /* 置前失败：交由调用方的回读判定 */
    }
    try {
      await this.client.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch {
      /* 焦点模拟失败：同上 */
    }
    const until = Date.now() + FOCUS_SETTLE_MS;
    for (;;) {
      try {
        if (!(await this.pageHidden())) return;
      } catch {
        return;
      }
      if (Date.now() >= until) return;
      await delay(100);
    }
  }
  /** 页面是否处于不可见（被节流）状态；读取失败按「不可见未知」交由调用方兜底。 */
  private async pageHidden(): Promise<boolean> {
    return this.evaluate<boolean>('document.hidden === true || document.visibilityState === "hidden"');
  }
  disconnect(): void { this.client.disconnect(); }
  async sessionId():Promise<string|undefined> {
    return this.evaluate(`location.hash.startsWith('#/chat/')?location.hash.split('?')[0].slice(7):undefined`);
  }
  /** 收集页面可见候选标签（issue #23 诊断机制）；失败安全返回空数组。 */
  async visibleLabels(scopeCss?: string): Promise<string[]> {
    try { return normalizeLabels(await this.evaluate<unknown>(visibleLabelsExpr({ scope: scopeCss }))); }
    catch { return []; }
  }
  /** 按候选顺序探测某语义键是否存在（单次 evaluate，无等待循环，故多候选代价低） */
  async existsKey(key: QoderSelectorKey): Promise<boolean> {
    for (const css of this.candidates(key)) if (await this.exists(css)) return true;
    return false;
  }
  /**
   * 返回该语义键**第一个命中的候选选择器**（供需要把选择器拼进组合式查询的调用方使用，
   * 例如「菜单容器 [role=tab]」，此时裸用 selector() 只取 primary，会让多候选形同虚设）。
   * 都不命中返回 null。
   */
  async resolveKey(key: QoderSelectorKey): Promise<string | null> {
    for (const css of this.candidates(key)) if (await this.exists(css)) return css;
    return null;
  }
  /** 读取该语义键第一个命中候选的文本；无候选命中时返回空串。 */
  async textKey(key: QoderSelectorKey): Promise<string> {
    const css = await this.resolveKey(key);
    return css ? this.text(css) : '';
  }
  /**
   * 按候选顺序点击某语义键：先探测哪个候选存在（避免每个候选各自打满超时），
   * 再对命中的那个执行坐标点击。全部候选都不存在则抛错并附诊断。
   */
  async clickKey(key: QoderSelectorKey, text?: string, index?: number): Promise<void> {
    const cands = this.candidates(key);
    for (const css of cands) {
      if (await this.exists(css)) { await this.click(css, text, index); return; }
    }
    const labels = await this.visibleLabels();
    throw new Error(`qoder_control_missing_or_ambiguous: ${key}; candidates=${cands.join(' , ')}${labels.length ? `; 页面可见候选=[${labels.join(' | ')}]` : ''}`);
  }
  async poll():Promise<QoderPoll> {
    const s=Object.fromEntries(Object.keys(QODER_SELECTORS).map(k=>[k,this.candidates(k as QoderSelectorKey).join(',')]));
    return this.evaluate(`(()=>{
      const s=${JSON.stringify(s)},visible=e=>!!e&&!!e.getBoundingClientRect().width&&!e.hidden;
      const user=[...document.querySelectorAll(s.userMessage)].at(-1);
      const id=user?.getAttribute('data-message-id');
      const assistant=[...document.querySelectorAll(s.assistantMessage)].find(e=>e.getAttribute('data-message-id')==='assistant:'+id);
      const question=document.querySelector(s.question),approval=document.querySelector(s.approval);
      const failure=assistant?.querySelector(s.failed),interrupted=assistant?.querySelector(s.interrupted);
      const pending=visible(question)?question:visible(approval)?approval:visible(failure)?failure:visible(interrupted)?interrupted:null;
      let waiting=visible(question)?'agent_question':visible(approval)?'user_confirmation':pending?'setup_recovery':undefined;
      const waitingText=pending?.innerText;
      if(waitingText&&/登录|sign.?in|log.?in/i.test(waitingText))waiting='login_required';
      const running=visible(document.querySelector(s.stop))||document.querySelector(s.conversation)?.getAttribute('aria-busy')==='true'||!!assistant?.querySelector('[data-activity-group-content-motion="streaming"]');
      return {sessionId:location.hash.match(/^#\\/chat\\/([^?]+)/)?.[1],userId:id,userText:user?.innerText??'',
        assistantId:assistant?.getAttribute('data-message-id'),assistantText:assistant?.innerText??'',running,
        completed:!!assistant?.querySelector(s.completed)&&!interrupted&&!failure,
        waiting,waitingText};
    })()`);
  }
  evaluate<T>(expression: string): Promise<T> { return this.client.evaluate<T>(expression); }
  async key(key: string, code: string, virtual: number, modifiers = 0): Promise<void> {
    const p = {key,code,windowsVirtualKeyCode:virtual,modifiers};
    await this.client.send('Input.dispatchKeyEvent',{type:'keyDown',...p});
    await this.client.send('Input.dispatchKeyEvent',{type:'keyUp',...p});
  }
  escape(): Promise<void> { return this.key('Escape','Escape',27); }
  async exists(css: string): Promise<boolean> {
    return this.evaluate(`!![...document.querySelectorAll(${JSON.stringify(css)})].find(${VISIBLE})`);
  }
  async text(css: string): Promise<string> {
    return this.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(css)});return e?.innerText??''})()`);
  }
  async click(css: string, text?: string, index?: number): Promise<void> {
    // 窗口不在前台时 `document.hidden===true`，下面的守卫会把每次点击都判为落空。
    // 先尝试自愈（置前 + 焦点模拟），把「环境问题」在源头消掉而不是让它伪装成选择器失败。
    if (await this.pageHidden().catch(() => false)) await this.focusMainWindow();
    const deadline=Date.now()+this.timeout;
    let point:{x:number;y:number}|null=null;
    do {
      point = await this.evaluate<{x:number;y:number} | null>(`(()=>{
      if(document.hidden)return null;
      let a=[...document.querySelectorAll(${JSON.stringify(css)})].filter(${VISIBLE});
      const wanted=${JSON.stringify(text ?? null)};
      if(wanted!==null)a=a.filter(e=>e.innerText.trim()===wanted);
      const i=${JSON.stringify(index ?? null)};
      if(i===null && a.length!==1)return null;
      const e=a[i??0];if(!e||e.disabled)return null;e.scrollIntoView({block:'nearest'});
      const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
      const top=document.elementFromPoint(x,y);
      if(!top||!e.contains(top))return null;
      return {x,y};})()`);
      if(point)break;
      if(Date.now()<deadline)await delay(Math.min(100,deadline-Date.now()));
    }while(Date.now()<deadline);
    if (!point) {
      // 如实报出真因：窗口在后台时控件「明明在视口内」却点不到，
      // 只报控件缺失会把用户引向错误方向（去查选择器）。
      if (await this.pageHidden().catch(() => false)) {
        throw new Error(`qoder_window_not_foreground: ${css} ${text ?? ''}；Qoder CN 窗口不在前台（页面被节流，合成点击不可靠）——请把 Qoder CN 窗口置于前台后重试`);
      }
      const labels = await this.visibleLabels();
      throw new Error(`qoder_control_missing_or_ambiguous: ${css} ${text ?? ''}${labels.length ? `; 页面可见候选=[${labels.join(' | ')}]` : ''}`);
    }
    await this.client.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
    await this.client.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
  }
  async fill(css: string, text: string): Promise<void> {
    await this.click(css);
    const editor=await this.evaluate<boolean>(`(()=>{const e=document.querySelector(${JSON.stringify(css)});if(!e||document.activeElement!==e)throw new Error('qoder_input_not_focused');return e.getAttribute('contenteditable')==='true';})()`);
    await this.key('a','KeyA',65,process.platform==='darwin'?4:2);
    await this.key('Backspace','Backspace',8);
    const normalized=text.replace(/\r\n/g,'\n');
    if(editor){
      // Chromium's bulk insertText collapses blank lines in Qoder's rich editor.
      // Its visible Shift+Enter command inserts a literal newline without submitting.
      const lines=normalized.split('\n');
      for(let i=0;i<lines.length;i++){
        if(i)await this.key('Enter','Enter',13,8);
        if(lines[i])await this.client.send('Input.insertText',{text:lines[i]});
      }
    }else await this.client.send('Input.insertText',{text});
    const actual = await this.evaluate<string>(`(()=>{
      const e=document.querySelector(${JSON.stringify(css)});if(!e)return '';
      if('value' in e)return e.value;
      const clone=e.cloneNode(true);
      clone.querySelectorAll('[data-editor-link-favicon="true"],[data-editor-offset-ignored]').forEach(n=>n.remove());
      clone.querySelectorAll('[data-editor-inline-token]').forEach(n=>n.replaceWith(document.createTextNode(n.getAttribute('data-editor-inline-token-source')??n.textContent??'')));
      return clone.textContent??'';
    })()`);
    if (actual.replace(/\u200b/g,'').replace(/\r\n/g,'\n') !== normalized) throw new Error(`qoder_input_readback_failed: ${css}; expectedLength=${normalized.length}; actualLength=${actual.length}`);
  }
  async screenshot(file: string): Promise<void> {
    const {data} = await this.client.send('Page.captureScreenshot',{format:'png'}) as {data:string};
    const fs = await import('node:fs/promises'); await fs.writeFile(file,Buffer.from(data,'base64'));
  }
}
