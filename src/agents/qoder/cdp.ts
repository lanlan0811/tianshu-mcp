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

export class QoderCdpClient {
  private readonly client: TraeworkCdpClient;
  constructor(port: number, private readonly timeout: number, private readonly overrides: Record<string,string> = {}) {
    this.client = new TraeworkCdpClient({port, sendTimeoutMs: timeout, targetRank: qoderTargetRank});
  }
  selector(key: QoderSelectorKey): string { return qoderPrimary(key, this.overrides); }
  /** 该语义键的全部候选选择器（覆盖优先，其后 primary 与 fallbacks，去重保序） */
  candidates(key: QoderSelectorKey): string[] { return qoderCandidates(key, this.overrides); }
  async connect(): Promise<void> {
    await this.client.connect();
    if (qoderTargetRank({url: await this.evaluate<string>('location.href')}) !== 0) {
      this.disconnect(); throw new Error('qoder_target_mismatch');
    }
    await this.client.send('Page.bringToFront');
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
