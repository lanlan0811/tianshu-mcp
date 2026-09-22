import type { QoderCdpClient } from './cdp.js';
import type { WaitFor } from './model.js';

export interface QuestionPage {
  title:string;
  index:number;
  count:number;
  custom:boolean;
  multiple:boolean;
  options:{label:string;selected:boolean}[];
}
type Answer=string|string[];

/** Multiple questions require an explicit title-to-answer map. Never infer defaults. */
export function resolveQuestionAnswers(pages:QuestionPage[],message:string):Answer[] {
  let mapping:Record<string,unknown>|undefined;
  try {
    const parsed:unknown=JSON.parse(message);
    if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))mapping=parsed as Record<string,unknown>;
  }catch { /* A single question accepts ordinary text. */ }
  if(!pages.length||new Set(pages.map(p=>p.title)).size!==pages.length)throw new Error('qoder_question_ambiguous');
  if(pages.length>1&&!mapping)throw new Error('qoder_question_answers_required: 多个问题请提供 JSON 对象，以完整问题文字为键、答案为值');
  if(mapping&&Object.keys(mapping).some(k=>!pages.some(p=>p.title===k)))throw new Error('qoder_question_unknown_title');
  return pages.map(p=>{
    const value=mapping?mapping[p.title]:message;
    if(typeof value!=='string'&&!(Array.isArray(value)&&value.every(v=>typeof v==='string')))throw new Error(`qoder_question_answer_missing: ${p.title}`);
    const answer=value as Answer;
    const values=Array.isArray(answer)?answer:[answer];
    if(!values.length||values.some(v=>!v.trim())||new Set(values).size!==values.length)throw new Error('qoder_question_empty_or_duplicate_answer');
    if(Array.isArray(answer)&&!p.multiple)throw new Error('qoder_question_not_multiselect');
    if((Array.isArray(answer)||!p.custom)&&values.some(v=>!p.options.some(o=>o.label===v)))throw new Error(`qoder_question_option_unavailable: ${p.title}`);
    return answer;
  });
}

/** Uses only rendered question controls. Header navigation never submits an answer. */
export async function answerQoderQuestions(c:QoderCdpClient,message:string,wait:WaitFor,beforeSubmit:()=>Promise<void>):Promise<void> {
  const root=c.selector('question');
  const page=`${root} [data-slot="user-question-transition-page"][data-current="true"]`;
  const read=()=>c.evaluate<QuestionPage>(`(()=>{
    const root=document.querySelector(${JSON.stringify(root)}),page=root?.querySelector('[data-slot="user-question-transition-page"][data-current="true"]');
    if(!root||!page)throw new Error('qoder_question_missing');
    const title=root.querySelector('[data-slot="user-question-expanded-title"] h2:not([aria-hidden="true"])')?.innerText?.trim();
    const countText=[...root.querySelectorAll('header span')].map(e=>e.textContent.trim()).find(t=>/^\\d+\\s*\\/\\s*\\d+$/.test(t));
    const parts=countText?countText.split('/').map(Number):[1,1];
    if(!title)throw new Error('qoder_question_title_missing');
    return {title,index:parts[0]-1,count:parts[1],custom:!!page.querySelector('input[placeholder="输入其他答案"]'),
      multiple:page.querySelector('[role="listbox"]')?.getAttribute('aria-multiselectable')==='true',
      options:[...page.querySelectorAll('[role="option"]')].map(e=>({label:e.querySelector('[data-slot="user-question-option-label"]')?.innerText?.trim(),selected:e.getAttribute('aria-selected')==='true'}))};
  })()`);
  if(await c.exists(`${root} button[aria-label="展开问题"]`))await c.click(`${root} button[aria-label="展开问题"]`);
  await wait(()=>c.exists(page),'question-expanded');
  let current=await read();
  if(!Number.isInteger(current.count)||current.count<1||current.count>100)throw new Error('qoder_question_count_invalid');
  const move=async(index:number)=>{
    while(current.index!==index){
      const target=current.index+(current.index<index?1:-1);
      await c.click(`${root} header button[aria-label="${target>current.index?'下一题':'上一题'}"]`);
      await wait(async()=>{current=await read();return current.index===target;},'question-navigation');
    }
  };
  await move(0);
  const pages:QuestionPage[]=[];
  for(let i=0;i<current.count;i++){await move(i);pages.push(current);}
  const answers=resolveQuestionAnswers(pages,message);
  await move(0);
  for(let i=0;i<pages.length;i++){
    current=await read();
    const original=pages[i]!;
    if(current.index!==i||current.title!==original.title||current.count!==pages.length)throw new Error('qoder_question_changed');
    const answer=answers[i]!;
    const final=i===pages.length-1;
    if(typeof answer==='string'&&current.custom){
      // Explicit free text replaces the single-choice default; no recommended answer is accepted.
      if(current.multiple){
        for(let j=0;j<current.options.length;j++)if(current.options[j]!.selected)await c.click(`${page} [role="option"]`,undefined,j);
      }
      await c.fill(`${page} input[placeholder="输入其他答案"]`,answer);
      if(final)await beforeSubmit();
      await c.click(`${page} [data-slot="user-question-footer-action"]:not([aria-hidden="true"]) button[aria-label="${final?'发送答案':'下一题'}"]`);
    }else{
      const values=Array.isArray(answer)?answer:[answer];
      if(current.custom)await c.fill(`${page} input[placeholder="输入其他答案"]`,'');
      if(current.multiple){
        for(let j=0;j<current.options.length;j++)if(current.options[j]!.selected!==values.includes(current.options[j]!.label))await c.click(`${page} [role="option"]`,undefined,j);
        if(final)await beforeSubmit();
        await c.click(`${page} [data-slot="user-question-footer-action"]:not([aria-hidden="true"]) button[aria-label="${final?'发送答案':'下一题'}"]`);
      }else{
        if(final)await beforeSubmit();
        await c.click(`${page} [role="option"]`,undefined,current.options.findIndex(o=>o.label===values[0]));
      }
    }
    if(!final)await wait(async()=>{current=await read();return current.index===i+1;},'question-next');
  }
  await wait(async()=>!await c.exists(root),'question-answer-acknowledgement');
}
