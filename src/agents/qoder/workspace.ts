import path from 'node:path';
import type { QoderCdpClient } from './cdp.js';
import type { WaitFor } from './model.js';
import { listOwnedDialogs, selectQoderFolder } from './dialog.js';

export function normalizeWorkspacePath(value: string, platform:NodeJS.Platform=process.platform): string {
  const normalized=(platform==='win32'?path.win32:path.posix).normalize(value).replace(/\\/g,'/').replace(/\/$/,'');
  return platform==='win32'?normalized.toLowerCase():normalized;
}
export async function boundWorkspace(c:QoderCdpClient):Promise<string> {
  return c.evaluate(`(()=>{const a=[...document.querySelectorAll(${JSON.stringify(c.selector('conversationWorkspace')+','+c.selector('workspace'))})].filter(e=>e.getBoundingClientRect().width).map(e=>e.getAttribute('title')).filter(Boolean);return new Set(a).size===1?a[0]:''})()`);
}
export async function assertWorkspace(c:QoderCdpClient,project:string):Promise<void> {
  const actual=await boundWorkspace(c);
  if(!actual||normalizeWorkspacePath(actual)!==normalizeWorkspacePath(project)) throw new Error(`qoder_workspace_mismatch: expected=${project}, actual=${actual}`);
}
export async function bindWorkspace(c:QoderCdpClient,project:string,wait:WaitFor,native:{pids:number[];timeoutMs:number;signal?:AbortSignal;list?:typeof listOwnedDialogs;select?:typeof selectQoderFolder}):Promise<void> {
  const current=await boundWorkspace(c);
  if(current&&normalizeWorkspacePath(current)===normalizeWorkspacePath(project))return;
  await c.click(c.selector('workspace'),undefined,0);
  await wait(()=>c.exists(c.selector('workspaceSearch')),'workspace-menu');
  await c.fill(c.selector('workspaceSearch'),process.platform==='win32'?path.win32.normalize(project):project);
  // UI filters by name OR path; selection is always followed by full-path verification.
  await wait(async()=>await c.evaluate<boolean>(`document.querySelector(${JSON.stringify(c.selector('workspaceSearch'))})?.value===${JSON.stringify(process.platform==='win32'?path.win32.normalize(project):project)}`),'workspace-search');
  const count=await c.evaluate<number>(`document.querySelectorAll(${JSON.stringify(c.selector('workspaceItem'))}).length`);
  if(count>1)throw new Error('qoder_workspace_ambiguous');
  if(count===1){
    await c.click(c.selector('workspaceItem'));
    await wait(async()=>!await c.exists(c.selector('workspaceSearch')),'workspace-selected');
    await assertWorkspace(c,project);return;
  }
  await c.click('[role="menu"][data-state="open"] [role="menuitem"]','新建工作区');
  await wait(()=>c.exists(c.selector('workspaceForm')),'workspace-form');
  const before=await (native.list??listOwnedDialogs)(native.pids,{timeoutMs:native.timeoutMs,signal:native.signal});
  await c.click(c.selector('folderAdd'));
  const selected=await (native.select??selectQoderFolder)(project,native.pids,before,{timeoutMs:native.timeoutMs,signal:native.signal});
  if(!selected.ok)throw new Error(`qoder_folder_dialog: ${selected.message}`);
  await wait(async()=>{
    const paths=await c.evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(c.selector('workspaceForm')+' [title]')})].filter(e=>e.getBoundingClientRect().width).map(e=>e.getAttribute('title'))`);
    return paths.some(p=>normalizeWorkspacePath(p)===normalizeWorkspacePath(project));
  },'source-folder-readback');
  await c.fill(c.selector('workspaceName'),(process.platform==='win32'?path.win32:path.posix).basename(project));
  await c.click(c.selector('workspaceCreate'));
  await wait(async()=>!await c.exists(c.selector('workspaceForm')),'workspace-created');
  await assertWorkspace(c,project);
}
