import {describe,it,expect} from 'vitest';
import {resolveQuestionAnswers,answerQoderQuestions,type QuestionPage} from '../../src/agents/qoder/questions.js';
import type {QoderCdpClient} from '../../src/agents/qoder/cdp.js';
const page:QuestionPage={title:'选择语言',index:0,count:1,custom:true,multiple:false,options:[{label:'TypeScript',selected:false},{label:'JavaScript',selected:false}]};
describe('explicit Qoder question answers',()=>{
  it('accepts the user text for a single custom question',()=>expect(resolveQuestionAnswers([page],'使用 Rust')).toEqual(['使用 Rust']));
  it('requires every question to be answered explicitly',()=>{
    const pages=[page,{...page,title:'运行环境',index:1,count:2}];
    expect(()=>resolveQuestionAnswers(pages,'随便')).toThrow('answers_required');
    expect(()=>resolveQuestionAnswers(pages,JSON.stringify({'选择语言':'Rust'}))).toThrow('answer_missing');
    expect(resolveQuestionAnswers(pages,JSON.stringify({'选择语言':'Rust','运行环境':'Windows'}))).toEqual(['Rust','Windows']);
  });
  it('rejects invented options and ambiguous question titles',()=>{
    expect(()=>resolveQuestionAnswers([{...page,custom:false}],'Rust')).toThrow('option_unavailable');
    expect(()=>resolveQuestionAnswers([page,page],'TypeScript')).toThrow('ambiguous');
    expect(()=>resolveQuestionAnswers([page],JSON.stringify({'别的问题':'TypeScript'}))).toThrow('unknown_title');
  });
  it('accepts only explicit supported multiselect options',()=>{
    const multi={...page,multiple:true};
    expect(resolveQuestionAnswers([multi],JSON.stringify({'选择语言':['TypeScript','JavaScript']}))).toEqual([['TypeScript','JavaScript']]);
    expect(()=>resolveQuestionAnswers([multi],JSON.stringify({'选择语言':['Rust']}))).toThrow('option_unavailable');
    expect(()=>resolveQuestionAnswers([page],JSON.stringify({'选择语言':['TypeScript']}))).toThrow('not_multiselect');
  });
});

describe('question control submission boundary',()=>{
  function fixture(){
    const pages=[{...page,count:2},{...page,title:'运行环境',index:1,count:2}];
    let index=1,visible=true;
    const events:string[]=[];
    const client={
      selector:()=> '[data-pending-interaction-composer]',
      evaluate:async()=>pages[index],
      exists:async(css:string)=>css.includes('展开问题')?false:visible,
      fill:async(_css:string,text:string)=>{events.push(`answer:${index}:${text}`);},
      click:async(css:string)=>{
        if(css.includes('header'))index+=css.includes('上一题')?-1:1;
        else if(css.includes('发送答案')){events.push('submit');visible=false;}
        else if(css.includes('下一题')){events.push('next');index++;}
        else throw new Error(`Unexpected interaction ${css}`);
      },
    } as unknown as QoderCdpClient;
    const wait=async(check:()=>Promise<boolean>)=>{if(!await check())throw new Error('state not reached');};
    return {client,wait,events};
  }
  it('validates all questions before changing answers or submitting',async()=>{
    const f=fixture();
    await expect(answerQoderQuestions(f.client,JSON.stringify({'选择语言':'Rust'}),f.wait,async()=>{f.events.push('checkpoint');})).rejects.toThrow('answer_missing');
    expect(f.events).toEqual([]);
  });
  it('records the checkpoint immediately before final submission',async()=>{
    const f=fixture();
    await answerQoderQuestions(f.client,JSON.stringify({'选择语言':'Rust','运行环境':'Windows'}),f.wait,async()=>{f.events.push('checkpoint');});
    expect(f.events).toEqual(['answer:0:Rust','next','answer:1:Windows','checkpoint','submit']);
  });
});
