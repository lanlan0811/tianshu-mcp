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
    return this.evaluate(
      `(function(){for(const s of ${candidateExpr(key, this.selectors)}){for(const e of document.querySelectorAll(s)){const r=e.getBoundingClientRect();if(r.width&&r.height){e.click();return true}}}return false})()`,
    );
  }
  async clickExact(
    key: ZcodeSelectorKey,
    value: string,
  ): Promise<{ clicked: boolean; count: number }> {
    return this.evaluate(
      `(function(){const norm=s=>(s||'').normalize('NFKC').trim().toLocaleLowerCase();const target=norm(${JSON.stringify(value)});const found=[];for(const s of ${candidateExpr(key, this.selectors)})for(const e of document.querySelectorAll(s)){const t=norm(e.textContent||e.getAttribute('data-value')||'');if(t===target&&!found.includes(e))found.push(e)}if(found.length===1){found[0].scrollIntoView({block:'center'});found[0].click()}return {clicked:found.length===1,count:found.length}})()`,
    );
  }
  async projects(): Promise<ZcodeProjectItem[]> {
    return this.evaluate(
      `(function(){const out=[];for(const s of ${candidateExpr("projectItem", this.selectors)})for(const e of document.querySelectorAll(s)){const name=(e.getAttribute('data-project-name')||e.querySelector('[class*=name]')?.textContent||e.textContent||'').trim();const p=e.getAttribute('data-project-path')||e.querySelector('[data-project-path]')?.getAttribute('data-project-path')||e.getAttribute('title')||undefined;const id=e.getAttribute('data-project-id')||e.getAttribute('data-id')||undefined;if(name)out.push({name,path:p,id})}return out})()`,
    );
  }
  async clickProject(id: string | undefined, projectPath: string | undefined): Promise<boolean> {
    return this.evaluate(
      `(function(){for(const s of ${candidateExpr("projectItem", this.selectors)})for(const e of document.querySelectorAll(s)){const id=e.getAttribute('data-project-id')||e.getAttribute('data-id')||'';const p=e.getAttribute('data-project-path')||e.querySelector('[data-project-path]')?.getAttribute('data-project-path')||e.getAttribute('title')||'';if((${JSON.stringify(id ?? "")}&&id===${JSON.stringify(id ?? "")})||(${JSON.stringify(projectPath ?? "")}&&p===${JSON.stringify(projectPath ?? "")})){e.click();return true}}return false})()`,
    );
  }
  async boundProjectPath(): Promise<string> {
    return (
      (await this.evaluate<string>(
        `(function(){for(const s of ${candidateExpr("projectPath", this.selectors)})for(const e of document.querySelectorAll(s)){const p=e.getAttribute('data-project-path')||e.getAttribute('title')||(e.textContent||'').trim();if(p)return p}return window.__ZCODE_PROJECT_PATH__||''})()`,
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
