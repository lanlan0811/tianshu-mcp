import {
  TraeworkCdpClient,
  CdpDisconnectedError,
  CdpUnavailableError,
} from "../traework/cdp/client.js";
import { candidateExpr, type ZcodeSelectorKey } from "./selectors.js";
import type { ZcodePoll } from "./liveness.js";
import type { ZcodeProjectItem } from "./project.js";
import { normalizeZcodeModelSelection } from "./model.js";

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
      `(async function(){const norm=s=>(s||'').normalize('NFKC').trim().toLocaleLowerCase();const target=norm(${JSON.stringify(value)});const sels=${candidateExpr(key, this.selectors)};const visible=e=>{const r=e.getBoundingClientRect();if(!(r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth))return false;const x=Math.max(0,Math.min(innerWidth-1,r.left+r.width/2)),y=Math.max(0,Math.min(innerHeight-1,r.top+r.height/2)),hit=document.elementFromPoint(x,y);return !!hit&&(hit===e||e.contains(hit))};const items=()=>{const out=[];for(const s of sels)for(const e of document.querySelectorAll(s))if(visible(e)&&!out.includes(e))out.push(e);return out};const leafTexts=e=>[...e.querySelectorAll('*')].filter(n=>n.children.length===0).map(n=>(n.textContent||'').trim()).filter(Boolean);const label=e=>(e.getAttribute('data-value')||e.getAttribute('data-model')||e.getAttribute('data-provider')||leafTexts(e)[0]||e.textContent||'').trim();let nodes=items();let scroller=nodes[0];while(scroller&&scroller!==document.body&&scroller.scrollHeight<=scroller.clientHeight)scroller=scroller.parentElement;const start=scroller?.scrollTop||0;if(scroller)scroller.scrollTop=0;const seen=new Map(),matches=new Map();for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,25));nodes=items();for(const e of nodes){const text=label(e);if(!text)continue;const id=e.getAttribute('data-id')||e.getAttribute('data-model-id')||e.getAttribute('data-value')||e.getAttribute('data-model')||e.getAttribute('data-provider')||e.getAttribute('data-testid')||text;seen.set(norm(id)+'|'+norm(text),text);if(norm(text)===target)matches.set(norm(id)+'|'+norm(text),{top:scroller?.scrollTop||0,text})}if(!scroller||scroller.scrollTop+scroller.clientHeight>=scroller.scrollHeight-1)break;const before=scroller.scrollTop;scroller.scrollTop=Math.min(scroller.scrollTop+Math.max(100,scroller.clientHeight*.8),scroller.scrollHeight);if(scroller.scrollTop===before)break}const matchesFound=[...matches.values()];if(matchesFound.length===1){if(scroller)scroller.scrollTop=matchesFound[0].top;await new Promise(r=>setTimeout(r,50));const exact=items().filter(e=>norm(label(e))===target);if(exact.length===1){exact[0].scrollIntoView({block:'center'});const r=exact[0].getBoundingClientRect();return {count:1,available:[...seen.values()],point:{x:r.left+r.width/2,y:r.top+r.height/2}}}}if(scroller)scroller.scrollTop=start;return {count:matchesFound.length,available:[...seen.values()]}})()`,
    );
    if (!found.point) return { clicked: false, count: found.count, available: found.available };
    await this.clickAt(found.point.x, found.point.y);
    return { clicked: true, count: found.count, available: found.available };
  }
  async selection(key: ZcodeSelectorKey): Promise<{ display: string; internal: string }> {
    const raw = await this.evaluate<{
      display: string;
      ariaLabel?: string;
      currentValue?: string;
      legacyInternal?: string;
    }>(
      `(function(){for(const s of ${candidateExpr(key, this.selectors)})for(const e of document.querySelectorAll(s)){const r=e.getBoundingClientRect();if(!r.width||!r.height)continue;const data=e.closest('[data-model-id],[data-model],[data-value]')||e.querySelector('[data-model-id],[data-model],[data-value]')||e;return {display:(e.value||e.textContent||'').trim(),ariaLabel:(e.getAttribute('aria-label')||'').trim(),currentValue:(e.getAttribute('data-model-current-value')||'').trim(),legacyInternal:(data.getAttribute('data-model-id')||data.getAttribute('data-model')||data.getAttribute('data-value')||'').trim()}}return {display:''}})()`,
    );
    return normalizeZcodeModelSelection(raw);
  }
  async projects(): Promise<ZcodeProjectItem[]> {
    return this.evaluate(
      `(function(){const out=[];for(const s of ${candidateExpr("projectItem", this.selectors)})for(const e of document.querySelectorAll(s)){const testid=e.getAttribute('data-testid')||'';const testPath=testid.startsWith('workspace-item-')?testid.slice('workspace-item-'.length):undefined;const name=(e.getAttribute('data-project-name')||e.querySelector('[class*=name]')?.textContent||e.textContent||'').trim();const p=e.getAttribute('data-project-path')||e.querySelector('[data-project-path]')?.getAttribute('data-project-path')||testPath||e.getAttribute('title')||undefined;const id=e.getAttribute('data-project-id')||e.getAttribute('data-id')||testid||undefined;if(name)out.push({name,path:p,id})}return out})()`,
    );
  }
  async clickProject(id: string | undefined, projectPath: string | undefined): Promise<boolean> {
    const point = await this.evaluate<{ x: number; y: number } | null>(
      `(async function(){const matches=[];for(const s of ${candidateExpr("projectItem", this.selectors)})for(const e of document.querySelectorAll(s)){const testid=e.getAttribute('data-testid')||'';const id=e.getAttribute('data-project-id')||e.getAttribute('data-id')||testid;const p=e.getAttribute('data-project-path')||e.querySelector('[data-project-path]')?.getAttribute('data-project-path')||(testid.startsWith('workspace-item-')?testid.slice('workspace-item-'.length):'')||e.getAttribute('title')||'';if((${JSON.stringify(id ?? "")}&&id===${JSON.stringify(id ?? "")})||(${JSON.stringify(projectPath ?? "")}&&p===${JSON.stringify(projectPath ?? "")}))matches.push(e)}if(matches.length!==1)return null;matches[0].scrollIntoView({block:'center'});await new Promise(r=>setTimeout(r,50));const r=matches[0].getBoundingClientRect();return r.width&&r.height&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth?{x:r.left+r.width/2,y:r.top+r.height/2}:null})()`,
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
    if (submit.answered)
      return { answered: true, count: 1, available: located.available };
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
