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
  // issue #23 真机重探修正：0.3.4 有 2 个 [data-workspace-picker-trigger]，旧代码点它即歧义失败；
  // 现主选择器为唯一的 aria-label「切换或清空当前工作区…」。index=0 保留原索引语义（多候选时取首个可见）。
  await c.clickKey('workspace', undefined, 0);
  // 菜单打开判定：搜索框出现 **或** 任一浮层（menu/dialog 的 data-state=open）出现（多形态并列，避免误判）。
  try {
    await wait(async()=>await c.existsKey('workspaceSearch')||await c.existsKey('workspaceMenu'),'workspace-menu');
  } catch (error) {
    // 附页面可见候选，便于定位 UI 漂移
    const labels = await c.visibleLabels();
    const hint = labels.length ? `；页面可见候选=[${labels.join(' | ')}]` : '';
    throw new Error(`${(error as Error).message}${hint}`);
  }
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
