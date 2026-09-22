import { afterAll,describe,expect,it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { QoderCdpClient } from '../../src/agents/qoder/cdp.js';
import { runQoderTask,stopQoder,type QoderRunDeps } from '../../src/agents/qoder/run.js';
import { QODER_PROFILE } from '../../src/agents/qoder/profile.js';
import type { TaskContext,ResolvedAgent,AgentRunOptions } from '../../src/agents/adapter.js';
import type { QoderPoll } from '../../src/agents/qoder/liveness.js';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'qoder-flow-'));
afterAll(()=>fs.rm(root,{recursive:true,force:true}));
class FakeClient extends QoderCdpClient {
  session:string|undefined;
  textValue='';
  sends=0;
  reads=0;
  reconnects=0;
  running=false;
  stopped=false;
  mode:'good'|'approval'|'question'|'unknown'|'disconnect'|'unacknowledged'='good';
  stopFails=false;
  constructor(readonly project:string){super(1,1);}
  override async connect(){this.reconnects++;}
  override disconnect(){}
  override async sessionId(){return this.session;}
  override async exists(){return true;}
  override async text(){return '询问审批';}
  override async evaluate<T>(expression:string):Promise<T>{
    if(expression.includes('URLSearchParams'))return 'session' as T;
    return this.project as T;
  }
  override async fill(_css:string,text:string){this.textValue=text;}
  override async click(css:string){
    if(css===this.selector('newTask'))this.session=undefined;
    if(css===this.selector('send')){this.sends++;this.running=true;this.stopped=false;this.session='session';this.reads=0;}
    if(css===this.selector('stop')&&!this.stopFails){this.running=false;this.stopped=true;}
  }
  override async poll():Promise<QoderPoll>{
    if(this.sends)this.reads++;
    if(this.mode==='disconnect'&&this.reads===2)throw new Error('CDP disconnected');
    const completed=!this.stopped&&this.sends>0&&this.reads>=3&&['good','disconnect'].includes(this.mode);
    if(completed)this.running=false;
    return {sessionId:this.session,userId:this.sends?`u${this.sends}`:undefined,userText:this.mode==='unacknowledged'?'not our message':this.textValue,
      assistantId:this.sends?`assistant:u${this.sends}`:undefined,assistantText:completed?'done':'thinking',running:this.running,completed,
      waiting:this.sends>0?(this.mode==='approval'?'user_confirmation':this.mode==='question'?'agent_question':undefined):undefined,waitingText:this.mode==='approval'?'允许一次':undefined};
  }
}
let serial=0;
async function fixture(){
  const dir=path.join(root,String(++serial));await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'plan.md'),'# plan');
  const c=new FakeClient(dir);
  const ctx:TaskContext={taskId:'task',agentId:'qoder',projectPath:dir,displayPath:dir,task:'implement the plan',planDoc:'plan.md',taskDir:path.join(dir,'state'),workDir:dir,round:0,taskTimeoutMs:5000};
  const resolved:ResolvedAgent={id:'qoder',displayName:'Qoder',profile:{...QODER_PROFILE,gui:{...QODER_PROFILE.gui!,pollIntervalMs:1,stableRounds:2,progressIntervalMs:1,cancelWaitMs:10,idleTimeoutMs:10}},command:'fixture',argsTemplate:[],ok:true,message:'fixture'};
  const deps:Partial<QoderRunDeps>={platform:'win32',ensureInstance:async()=>({ready:{port:1}}),listProcesses:async()=>[],createClient:()=>c,bindWorkspace:async()=>{},configureModel:async()=>({model:'Fixture',source:'custom',level:'high',globalChanged:false})};
  const opts:AgentRunOptions={logger:{info(){},warn(){},error(){},debug(){}}};
  const run=()=>runQoderTask({ctx,resolved,opts,logFile:path.join(ctx.taskDir,'agent.log'),deps});
  return {c,ctx,resolved,deps,opts,run};
}

describe('Qoder run/continue/rework and no duplicate send',()=>{
  it('sends once and only completes with this turn evidence',async()=>{
    const f=await fixture();const r=await f.run();
    expect(r.ok).toBe(true);expect(r.endReason).toBe('completion_mark');expect(f.c.sends).toBe(1);
    expect(r.session?.id).toBe('session');expect(r.actualModelSource).toBe('custom');expect(r.session?.permissionMode).toBe('询问审批');
    expect(f.c.textValue).toContain(path.join(f.ctx.projectPath,'plan.md'));
  });
  it('classifies approval even while stop is present, without accepting it',async()=>{
    const f=await fixture();f.c.mode='approval';const r=await f.run();
    expect(r.needsUserKind).toBe('user_confirmation');expect(r.ok).toBe(false);expect(f.c.sends).toBe(1);expect(f.c.stopped).toBe(false);
  });
  it('reobserves after approval without sending user confirmation to model',async()=>{
    const f=await fixture();f.c.mode='approval';await f.run();
    f.c.mode='good';f.ctx.resume={kind:'continue',sessionId:'session',sendMessage:false,reobserve:true,message:'已处理'};
    const r=await f.run();expect(r.ok).toBe(true);expect(f.c.sends).toBe(1);expect(f.c.textValue).not.toContain('已处理');
  });
  it('reworks in the same session with the repair plan text',async()=>{
    const f=await fixture();await f.run();f.ctx.round=1;f.ctx.feedback='修复计划 repair-1.md\n修复减法误用';f.ctx.resume={kind:'rework',sessionId:'session',sendMessage:true};
    const r=await f.run();expect(r.ok).toBe(true);expect(f.c.sends).toBe(2);expect(r.session?.id).toBe('session');expect(f.c.textValue).toContain('repair-1.md');
  });
  it('answers the owned pending question instead of sending a new chat turn',async()=>{
    const f=await fixture();f.c.mode='question';await f.run();
    f.ctx.resume={kind:'continue',sessionId:'session',sendMessage:true,message:'使用 TypeScript'};
    let answers=0;
    f.deps.answerQuestions=async(_client,message,_wait,beforeSubmit)=>{
      expect(message).toBe('使用 TypeScript');answers++;await beforeSubmit();f.c.mode='good';
    };
    const r=await f.run();expect(r.ok).toBe(true);expect(answers).toBe(1);expect(f.c.sends).toBe(1);
  });
  it('does not repeat an answer whose submission acknowledgement was lost',async()=>{
    const f=await fixture();f.c.mode='question';await f.run();
    f.ctx.resume={kind:'continue',sessionId:'session',sendMessage:true,message:'用户答案'};
    let answers=0;
    f.deps.answerQuestions=async(_client,_message,_wait,beforeSubmit)=>{answers++;await beforeSubmit();throw new Error('disconnected');};
    expect((await f.run()).needsUserKind).toBe('setup_recovery');
    expect((await f.run()).needsUserKind).toBe('agent_question');expect(answers).toBe(1);expect(f.c.sends).toBe(1);
  });
  it('reconnects read-only after disconnect and never resends',async()=>{
    const f=await fixture();f.c.mode='disconnect';const r=await f.run();expect(r.ok).toBe(true);expect(f.c.reconnects).toBe(2);expect(f.c.sends).toBe(1);
  });
  it('does not dispatch into a busy foreign conversation',async()=>{
    const f=await fixture();f.c.session='foreign';f.c.running=true;
    const r=await f.run();expect(r.needsUserKind).toBe('setup_recovery');expect(f.c.sends).toBe(0);expect(f.c.stopped).toBe(false);
  });
  it('stops only its own session on cancellation and records uncertainty',async()=>{
    const f=await fixture();f.c.mode='unknown';f.c.stopFails=true;
    const abort=new AbortController();f.opts.signal=abort.signal;f.opts.onProgress=async()=>abort.abort();
    const r=await f.run();expect(r.killed).toBe(true);expect(r.guiStop?.idle).toBe(false);expect(r.error).toContain('不确定');
  });
  it('cancels a running owned session without closing the application',async()=>{
    const f=await fixture();f.c.mode='unknown';const abort=new AbortController();f.opts.signal=abort.signal;f.opts.onProgress=async()=>abort.abort();
    const r=await f.run();expect(r.killed).toBe(true);expect(f.c.stopped).toBe(true);expect(r.keptInstance).toBe(true);
  });
  it('persists uncertain sends and refuses to retry them',async()=>{
    const f=await fixture();f.c.mode='unacknowledged';f.ctx.taskTimeoutMs=200;
    const r=await f.run();expect(r.timeout).toBe(true);expect(f.c.sends).toBe(1);
    f.ctx.taskTimeoutMs=5000;
    const retry=await f.run();expect(retry.needsUserKind).toBe('setup_recovery');expect(f.c.sends).toBe(1);
  });
  it('refuses macOS dispatch without launching processes',async()=>{
    const f=await fixture();f.deps.platform='darwin';const r=await f.run();expect(r.hardFailure).toBe(true);expect(f.c.reconnects).toBe(0);
  });
  it('does not stop a different session after the user navigated away',async()=>{
    const f=await fixture();f.c.session='other';f.c.running=true;
    expect(await stopQoder(f.c,'owned',10)).toEqual({clicked:false,idle:false});expect(f.c.stopped).toBe(false);
  });
});
