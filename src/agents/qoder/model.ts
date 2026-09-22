import type { QoderCdpClient } from './cdp.js';

export type QoderModelSource = 'default' | 'custom';
export type QoderLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'off';
export const LEVEL_LABELS: Record<QoderLevel,string> = {low:'低',medium:'中',high:'高',xhigh:'极高',max:'最大',off:'关闭思考'};
export function normalizeLevel(value?: string): QoderLevel | undefined {
  if (value === undefined) return undefined;
  const aliases: Record<string,QoderLevel> = {低:'low',中:'medium',高:'high',极高:'xhigh',最大:'max',关闭思考:'off',low:'low',medium:'medium',high:'high',xhigh:'xhigh',max:'max',off:'off'};
  const level=aliases[value.normalize('NFKC').trim().toLowerCase()];
  if(!level)throw new Error(`qoder_reasoning_unsupported: ${value}`);
  return level;
}
export const exactName = (a: string,b: string): boolean => a.normalize('NFKC').trim().toLowerCase() === b.normalize('NFKC').trim().toLowerCase();
export interface ModelChoice {name:string;source:QoderModelSource;index:number}
export function matchModel(items: ModelChoice[],name: string,source?: QoderModelSource): ModelChoice {
  const matches=items.filter(i=>exactName(i.name,name)&&(!source||i.source===source));
  if(matches.length!==1)throw new Error(`${matches.length?'qoder_model_ambiguous':'qoder_model_missing'}: ${name}; available=${items.map(i=>i.source+'/'+i.name).join(', ')}`);
  return matches[0]!;
}
export type WaitFor = (check:()=>Promise<boolean>,stage:string)=>Promise<void>;

export async function configureModel(c: QoderCdpClient, requested: {model?:string;source?:QoderModelSource;level?:string},wait: WaitFor): Promise<{model:string;source:QoderModelSource;level?:QoderLevel;globalChanged:boolean}> {
  const level=normalizeLevel(requested.level);
  const trigger=await c.text(c.selector('model'));
  const name=requested.model ?? trigger.split('\n')[0]?.trim();
  if(!name)throw new Error('qoder_model_unreadable');
  await c.click(c.selector('model'));
  await wait(()=>c.exists(c.selector('modelMenu')),'model-menu');
  const selectedSource=await c.evaluate<QoderModelSource>(`document.querySelector('[data-chat-model-selector-menu] [role="tab"][aria-selected="true"]')?.getAttribute('data-value')`);
  const items:ModelChoice[]=[];
  for(const source of ['default','custom'] as const){
    await c.click(`${c.selector('modelMenu')} [role="tab"][data-value="${source}"]`);
    await wait(()=>c.exists(`${c.selector('modelMenu')} [role="tab"][data-value="${source}"][aria-selected="true"]`),'model-source');
    const names=await c.evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(c.selector('modelList'))})].map(e=>e.innerText.trim().split('\\n')[0])`);
    names.forEach((n,index)=>items.push({name:n,source,index}));
  }
  // Omitting model retains the current group, even when the same name exists in both groups.
  const choice=matchModel(items,name,requested.source??(requested.model?undefined:selectedSource));
  await c.click(`${c.selector('modelMenu')} [role="tab"][data-value="${choice.source}"]`);
  await wait(()=>c.exists(`${c.selector('modelMenu')} [role="tab"][data-value="${choice.source}"][aria-selected="true"]`),'model-source');
  await c.click(c.selector('modelList'),undefined,choice.index);
  await wait(async()=>!await c.exists(c.selector('modelMenu')),'model-menu-closed');
  await wait(async()=>exactName((await c.text(c.selector('model'))).split('\n')[0]??'',choice.name),'model-readback');
  let globalChanged=false;
  if(level!==undefined){
    await c.click(c.selector('model'));
    await wait(()=>c.exists(c.selector('modelMenu')),'model-menu');
    await c.click(`${c.selector('modelMenu')} [role="menuitem"]`,'模型管理');
    await wait(()=>c.exists(c.selector('modelDialog')),'model-management');
    const dialog=c.selector('modelDialog');
    await c.click(`${dialog} [role="tab"][data-value="${choice.source}"]`);
    const levelButton=`${dialog} button[aria-label=${JSON.stringify(`设置 ${choice.name} 的思考强度`)}]`;
    await wait(()=>c.exists(`${dialog} [role="tab"][data-value="${choice.source}"][aria-selected="true"]`),'management-source');
    if(!await c.exists(levelButton))throw new Error(`qoder_reasoning_unsupported: ${choice.name}`);
    const before=await c.text(levelButton);
    await c.click(levelButton);
    await wait(()=>c.exists(c.selector('levelItem')),'reasoning-options');
    const labels=await c.evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(c.selector('levelItem'))})].map(e=>e.innerText.trim())`);
    if(!labels.includes(LEVEL_LABELS[level]))throw new Error(`qoder_reasoning_unsupported: ${LEVEL_LABELS[level]}; available=${labels.join(',')}`);
    await c.click(c.selector('levelItem'),LEVEL_LABELS[level]);
    await wait(async()=>(await c.text(levelButton)).trim()===LEVEL_LABELS[level],'reasoning-readback');
    globalChanged=before.trim()!==LEVEL_LABELS[level];
    if(globalChanged){
      await c.click(`${dialog} button`,'保存设置');
    }else await c.click(`${dialog} button[aria-label="关闭"]`);
    await wait(async()=>!await c.exists(dialog),'settings-saved');
    // Reopen persisted preferences, not just the draft row, to prove saving took effect.
    await c.click(c.selector('model')); await wait(()=>c.exists(c.selector('modelMenu')),'model-menu');
    await c.click(`${c.selector('modelMenu')} [role="menuitem"]`,'模型管理');
    await wait(()=>c.exists(dialog),'model-management');
    await c.click(`${dialog} [role="tab"][data-value="${choice.source}"]`);
    await wait(async()=>await c.exists(levelButton)&&(await c.text(levelButton)).trim()===LEVEL_LABELS[level],'persisted-reasoning');
    await c.click(`${dialog} button[aria-label="关闭"]`);
    await wait(async()=>!await c.exists(dialog),'settings-closed');
  }
  const actual=(await c.text(c.selector('model'))).split('\n').map(s=>s.trim());
  if(!exactName(actual[0]??'',choice.name))throw new Error('qoder_model_readback_failed');
  return {model:choice.name,source:choice.source,level:level??(actual[1]?normalizeLevel(actual[1]):undefined),globalChanged};
}
