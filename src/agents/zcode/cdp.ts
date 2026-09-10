import {
  TraeworkCdpClient,
  CdpDisconnectedError,
  CdpUnavailableError,
} from "../traework/cdp/client.js";
import { candidateExpr, type ZcodeSelectorKey } from "./selectors.js";
import type { ZcodePoll } from "./liveness.js";
import type { ZcodeProjectItem } from "./project.js";

export { CdpDisconnectedError, CdpUnavailableError };

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
    return this.inner.evaluate<T>(expression);
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.inner.send(method, params);
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
  async click(key: ZcodeSelectorKey): Promise<boolean> {
    const point = await this.evaluate<{ x: number; y: number } | null>(
      `(function(){for(const s of ${candidateExpr(key, this.selectors)}){for(const e of document.querySelectorAll(s)){const r=e.getBoundingClientRect();if(r.width&&r.height)return {x:r.left+r.width/2,y:r.top+r.height/2}}}return null})()`,
    );
    if (!point) return false;
    await this.clickAt(point.x, point.y);
    return true;
  }
  async clickExact(
    key: ZcodeSelectorKey,
    value: string,
  ): Promise<{ clicked: boolean; count: number; available: string[] }> {
    const found = await this.evaluate<{
      count: number;
      available: string[];
      point?: { x: number; y: number };
    }>(
      `(async function(){const norm=s=>(s||'').normalize('NFKC').trim().toLocaleLowerCase();const target=norm(${JSON.stringify(value)});const sels=${candidateExpr(key, this.selectors)};const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0};const items=()=>{const out=[];for(const s of sels)for(const e of document.querySelectorAll(s))if(visible(e)&&!out.includes(e))out.push(e);return out};const leafTexts=e=>[...e.querySelectorAll('*')].filter(n=>n.children.length===0).map(n=>(n.textContent||'').trim()).filter(Boolean);const label=e=>(e.getAttribute('data-value')||e.getAttribute('data-model')||e.getAttribute('data-provider')||leafTexts(e)[0]||e.textContent||'').trim();let nodes=items();let scroller=nodes[0];while(scroller&&scroller!==document.body&&scroller.scrollHeight<=scroller.clientHeight)scroller=scroller.parentElement;const start=scroller?.scrollTop||0;if(scroller)scroller.scrollTop=0;const seen=new Map(),matches=new Map();for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,25));nodes=items();for(const e of nodes){const text=label(e);if(!text)continue;const id=e.getAttribute('data-id')||e.getAttribute('data-model-id')||e.getAttribute('data-value')||e.getAttribute('data-model')||e.getAttribute('data-provider')||e.getAttribute('data-testid')||text;seen.set(norm(id)+'|'+norm(text),text);if(norm(text)===target)matches.set(norm(id)+'|'+norm(text),{top:scroller?.scrollTop||0,text})}if(!scroller||scroller.scrollTop+scroller.clientHeight>=scroller.scrollHeight-1)break;const before=scroller.scrollTop;scroller.scrollTop=Math.min(scroller.scrollTop+Math.max(100,scroller.clientHeight*.8),scroller.scrollHeight);if(scroller.scrollTop===before)break}const matchesFound=[...matches.values()];if(matchesFound.length===1){if(scroller)scroller.scrollTop=matchesFound[0].top;await new Promise(r=>setTimeout(r,50));const exact=items().filter(e=>norm(label(e))===target);if(exact.length===1){exact[0].scrollIntoView({block:'center'});const r=exact[0].getBoundingClientRect();return {count:1,available:[...seen.values()],point:{x:r.left+r.width/2,y:r.top+r.height/2}}}}if(scroller)scroller.scrollTop=start;return {count:matchesFound.length,available:[...seen.values()]}})()`,
    );
    if (!found.point) return { clicked: false, count: found.count, available: found.available };
    await this.clickAt(found.point.x, found.point.y);
    return { clicked: true, count: found.count, available: found.available };
  }
  async selection(key: ZcodeSelectorKey): Promise<{ display: string; internal: string }> {
    return this.evaluate(
      `(function(){for(const s of ${candidateExpr(key, this.selectors)})for(const e of document.querySelectorAll(s)){const r=e.getBoundingClientRect();if(!r.width||!r.height)continue;const data=e.closest('[data-model-id],[data-model],[data-value]')||e.querySelector('[data-model-id],[data-model],[data-value]')||e;const display=(e.value||e.textContent||'').trim();const explicit=(data.getAttribute('data-model-id')||data.getAttribute('data-model')||data.getAttribute('data-value')||'').trim();return {display,internal:explicit||(display.includes('/')?display.slice(display.indexOf('/')+1).trim():'')}}return {display:'',internal:''}})()`,
    );
  }
  async projects(): Promise<ZcodeProjectItem[]> {
    return this.evaluate(
      `(function(){const out=[];for(const s of ${candidateExpr("projectItem", this.selectors)})for(const e of document.querySelectorAll(s)){const testid=e.getAttribute('data-testid')||'';const testPath=testid.startsWith('workspace-item-')?testid.slice('workspace-item-'.length):undefined;const name=(e.getAttribute('data-project-name')||e.querySelector('[class*=name]')?.textContent||e.textContent||'').trim();const p=e.getAttribute('data-project-path')||e.querySelector('[data-project-path]')?.getAttribute('data-project-path')||testPath||e.getAttribute('title')||undefined;const id=e.getAttribute('data-project-id')||e.getAttribute('data-id')||testid||undefined;if(name)out.push({name,path:p,id})}return out})()`,
    );
  }
  async clickProject(id: string | undefined, projectPath: string | undefined): Promise<boolean> {
    const point = await this.evaluate<{ x: number; y: number } | null>(
      `(function(){for(const s of ${candidateExpr("projectItem", this.selectors)})for(const e of document.querySelectorAll(s)){const testid=e.getAttribute('data-testid')||'';const id=e.getAttribute('data-project-id')||e.getAttribute('data-id')||testid;const p=e.getAttribute('data-project-path')||e.querySelector('[data-project-path]')?.getAttribute('data-project-path')||(testid.startsWith('workspace-item-')?testid.slice('workspace-item-'.length):'')||e.getAttribute('title')||'';if((${JSON.stringify(id ?? "")}&&id===${JSON.stringify(id ?? "")})||(${JSON.stringify(projectPath ?? "")}&&p===${JSON.stringify(projectPath ?? "")})){const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.left+r.width/2,y:r.top+r.height/2}:null}}return null})()`,
    );
    if (!point) return false;
    await this.clickAt(point.x, point.y);
    return true;
  }
  async boundProjectPath(): Promise<string> {
    return (
      (await this.evaluate<string>(
        `(function(){for(const s of ${candidateExpr("projectPath", this.selectors)})for(const e of document.querySelectorAll(s)){const p=e.getAttribute('data-project-path')||e.getAttribute('title')||(e.textContent||'').trim();if(p)return p}const trigger=document.querySelector('[data-testid="composer-workspace-trigger"]');const name=(trigger?.textContent||'').trim();if(name){const matches=[...document.querySelectorAll('[data-testid^="workspace-item-"]')].filter(e=>(e.textContent||'').trim()===name);if(matches.length===1)return (matches[0].getAttribute('data-testid')||'').slice('workspace-item-'.length)}return window.__ZCODE_PROJECT_PATH__||''})()`,
      )) || ""
    );
  }
  async session(): Promise<{ id?: string; title?: string }> {
    return this.evaluate(
      `(function(){const active=document.querySelector('[data-session-id][aria-current=true],[data-session-id].active');return {id:active?.getAttribute('data-session-id')||history.state?.sessionId||undefined,title:(active?.textContent||document.title||'').trim()||undefined}})()`,
    );
  }
  async selectSession(id?: string, title?: string): Promise<boolean> {
    return this.evaluate(
      `(function(){const nodes=[...document.querySelectorAll('[data-session-id],[data-testid*=task-item],[class*=task-item]')];const byId=${JSON.stringify(id ?? "")};const byTitle=${JSON.stringify(title ?? "")};const found=nodes.filter(e=>(byId&&e.getAttribute('data-session-id')===byId)||(!byId&&byTitle&&(e.textContent||'').trim()===byTitle));if(found.length!==1)return false;found[0].click();return true})()`,
    );
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
    if (!(await this.click("sendButton"))) {
      await this.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
      await this.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
    }
  }
  async conversationText(): Promise<string> {
    return this.text("messageList");
  }
  async poll(): Promise<ZcodePoll> {
    return this.evaluate(
      `(function(){const sels=${JSON.stringify(Object.fromEntries((["stopButton", "runningCard", "toolCall", "questionCard", "assistantMessage", "chatInput", "sendButton"] as ZcodeSelectorKey[]).map((k) => [k, JSON.parse(candidateExpr(k, this.selectors))])))};const visible=k=>{for(const s of sels[k])for(const e of document.querySelectorAll(s)){const r=e.getBoundingClientRect();if(r.width&&r.height)return e}return null};const all=k=>{const a=[];for(const s of sels[k])for(const e of document.querySelectorAll(s))if(!a.includes(e))a.push(e);return a};const q=visible('questionCard');const assistants=all('assistantMessage');const last=assistants[assistants.length-1];const input=visible('chatInput');const send=visible('sendButton');return {stopVisible:!!visible('stopButton'),loading:!!visible('runningCard'),activeTool:!!visible('toolCall'),question:q?(q.textContent||'').trim():undefined,assistantText:last?(last.textContent||'').trim():'',inputEnabled:!!input&&!input.disabled&&input.getAttribute('aria-disabled')!=='true',sendEnabled:!!send&&!send.disabled&&send.getAttribute('aria-disabled')!=='true'}})()`,
    );
  }
}
