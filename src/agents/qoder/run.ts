import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { GuiProfileSchema } from '../../config/schema.js';
import { readJsonSafe, writeJsonAtomic } from '../../util/fs.js';
import type { AgentRunOptions, AgentRunResult, ResolvedAgent, TaskContext } from '../adapter.js';
import { QoderCdpClient } from './cdp.js';
import { ensureQoderInstance, listQoderProcessesAsync } from './instance.js';
import { bindWorkspace, assertWorkspace } from './workspace.js';
import { configureModel, type WaitFor } from './model.js';
import { judgeQoderPoll } from './liveness.js';
import { validateQoderReferences } from './references.js';
import { answerQoderQuestions } from './questions.js';

interface Checkpoint {
  round:number;
  phase:'sending'|'sent'|'completed'|'answer_sending';
  sessionId?:string;
  userId?:string;
  marker:string;
  model?:string;
  source?:'default'|'custom';
  level?:string;
  permission?:string;
}
export interface QoderRunDeps {
  ensureInstance:typeof ensureQoderInstance;
  listProcesses:typeof listQoderProcessesAsync;
  createClient:(port:number,timeout:number,selectors:Record<string,string>)=>QoderCdpClient;
  bindWorkspace:typeof bindWorkspace;
  configureModel:typeof configureModel;
  answerQuestions:typeof answerQoderQuestions;
  platform:NodeJS.Platform;
}
const defaults:QoderRunDeps={ensureInstance:ensureQoderInstance,listProcesses:listQoderProcessesAsync,
  createClient:(port,timeout,selectors)=>new QoderCdpClient(port,timeout,selectors),bindWorkspace,configureModel,answerQuestions:answerQoderQuestions,platform:process.platform};

export async function stopQoder(c:QoderCdpClient,sessionId:string,waitMs:number):Promise<{clicked:boolean;idle:boolean}> {
  let clicked=false;
  try {
    if(await c.sessionId()!==sessionId)return {clicked,idle:false};
    if((await c.poll()).running){await c.click(c.selector('stop'));clicked=true;}
    const end=Date.now()+waitMs;
    let idleCount=0;
    do {
      if(await c.sessionId()!==sessionId)return {clicked,idle:false};
      if(!(await c.poll()).running){if(++idleCount>=2)return {clicked,idle:true};}else idleCount=0;
      await delay(Math.min(200,Math.max(1,end-Date.now())));
    }while(Date.now()<end);
  }catch{ /* Unconfirmed stop is explicitly surfaced; never close the app. */ }
  return {clicked,idle:false};
}

export async function runQoderTask(args:{ctx:TaskContext;resolved:ResolvedAgent;opts:AgentRunOptions;logFile:string;deps?:Partial<QoderRunDeps>}):Promise<AgentRunResult> {
  const {ctx,resolved,opts,logFile}=args,d={...defaults,...args.deps};
  const g=GuiProfileSchema.parse(resolved.profile.gui??{});
  const started=Date.now(),end=started+ctx.taskTimeoutMs;
  const setupEnd=Math.min(end,started+g.setupRecoveryTimeoutMs);
  const checkpointFile=path.join(ctx.taskDir,'qoder-session.json');
  let checkpoint:Checkpoint|undefined,c:QoderCdpClient|undefined,owned=false,answering=false;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(new Error('qoder_task_timeout')),ctx.taskTimeoutMs);
  const signal=opts.signal?AbortSignal.any([opts.signal,controller.signal]):controller.signal;
  const result=(extra:Partial<AgentRunResult>):AgentRunResult=>({ok:false,exitCode:null,timeout:false,killed:false,
    durationMs:Date.now()-started,logFile,keptInstance:true,
    session:checkpoint?.sessionId?{id:checkpoint.sessionId,boundProjectPath:ctx.projectPath,model:checkpoint.model,provider:checkpoint.source,permissionMode:checkpoint.permission}:undefined,
    actualModel:checkpoint?.model,actualReasoningLevel:checkpoint?.level,actualModelSource:checkpoint?.source,...extra});
  const log=async(message:string)=>{opts.logger.info(`[qoder] ${message}`);await fs.appendFile(logFile,`${new Date().toISOString()} ${message}\n`);};
  const waitUntil=(deadline:number):WaitFor=>async(check,stage)=>{
    while(Date.now()<deadline){signal.throwIfAborted();if(await check()){await log(`准备阶段确认：${stage}`);return;}await delay(Math.min(150,Math.max(1,deadline-Date.now())),undefined,{signal});}
    throw new Error(`qoder_stage_timeout: ${stage}`);
  };
  const pause=(kind:NonNullable<AgentRunResult['needsUserKind']>,message:string)=>result({needsUserKind:kind,pendingQuestion:message,endReason:kind});
  try{
    await fs.mkdir(ctx.taskDir,{recursive:true});await fs.writeFile(logFile,'');
    if(d.platform!=='win32')return result({hardFailure:true,error:'Qoder CN macOS research：未完成真机验证，拒绝派发',endReason:'unsupported_platform'});
    const plan=await validateQoderReferences(ctx.projectPath,ctx.planDoc);
    const saved=await readJsonSafe<Checkpoint>(checkpointFile);
    checkpoint=saved??undefined;
    const instance=await d.ensureInstance(resolved.command,g,opts.logger,{signal,deadline:setupEnd});
    if(instance.needsClose)return pause('close_existing_instance','Qoder CN 已打开但无法连接；请保存现场并手动关闭后 continue_task，MCP 不自动重启。');
    if(!instance.ready)throw new Error('qoder_instance_unavailable');
    c=d.createClient(instance.ready.port,Math.max(1,Math.min(g.cdpSendTimeoutMs,setupEnd-Date.now())),g.selectors);
    try { await c.connect(); } catch(error) {
      signal.throwIfAborted();
      if(Date.now()>=setupEnd)throw error;
      await log('主工作台协议暂未就绪，仅对同一实例重连一次；尚未发送任务。');
      c.disconnect();await c.connect();
    }
    await log('已接入 Qoder CN 主工作台。');
    const client=c,wait=waitUntil(setupEnd);
    let initial=await c.poll();
    const resumeId=ctx.resume?.sessionId??saved?.sessionId;
    const uncertainSend=saved?.round===ctx.round&&(saved.phase==='sending'||saved.phase==='answer_sending');
    const answerRequested=ctx.resume?.kind==='continue'&&ctx.resume.sendMessage===true;
    const reobserve=!!ctx.resume?.reobserve||uncertainSend||(!ctx.resume?.sendMessage&&saved?.round===ctx.round&&saved.phase==='sent');
    const canAnswer=answerRequested&&saved?.sessionId===initial.sessionId&&initial.waiting==='agent_question';
    if(initial.running&&(!resumeId||initial.sessionId!==resumeId||(!reobserve&&!canAnswer)))return pause('setup_recovery','Qoder 当前实例仍在执行或停止结果不确定，拒绝新派发。');
    if(resumeId){
      if(initial.sessionId!==resumeId){
        const selector=`${c.selector('sessionLink')}[href^=${JSON.stringify(`#/chat/${resumeId}?`)}]`;
        if(!await c.exists(selector))throw new Error('qoder_session_lost');
        await c.click(selector);await wait(async()=>await client.sessionId()===resumeId,'restore-session');
      }
      await assertWorkspace(c,ctx.projectPath);
      initial=await c.poll();owned=!!saved&&saved.sessionId===initial.sessionId;
    }else{
      if(ctx.round>0||ctx.resume?.sendMessage)throw new Error('qoder_session_lost');
      if(initial.waiting)return pause(initial.waiting,initial.waitingText??'请先处理 Qoder 当前等待项');
      if(!await c.exists(c.selector('newTask')))return pause('login_required','Qoder 工作界面不可用，请完成登录或引导后继续。');
      await c.click(c.selector('newTask'));
      await wait(async()=>!await client.sessionId()&&await client.exists(client.selector('input')),'new-task');
      const processes=await d.listProcesses({signal,deadline:setupEnd});
      await d.bindWorkspace(c,ctx.projectPath,wait,{pids:processes.map(p=>p.pid),timeoutMs:Math.max(1,Math.min(g.dialogOperationTimeoutMs,setupEnd-Date.now())),signal});
    }
    let expected=saved?.round===ctx.round?saved.userId:undefined;
    if(reobserve){
      if(!checkpoint||!resumeId)throw new Error('qoder_checkpoint_missing');
      const p=await c.poll();
      if(!expected&&p.userText.includes(checkpoint.marker))expected=p.userId;
      if(!expected)return pause('setup_recovery','上次发送结果无法确认；保留现场，拒绝重发。请核对原会话。');
    }else if(answerRequested){
      if(!owned||!checkpoint||!expected)throw new Error('qoder_question_session_unconfirmed');
      if(initial.waiting!=='agent_question')return pause(initial.waiting??'setup_recovery','原会话当前没有可确认的 Agent 提问，未发送答案。');
      if(!ctx.resume?.message?.trim())return pause('agent_question','请提供明确答案。');
      answering=true;
      await d.answerQuestions(c,ctx.resume.message,wait,async()=>{
        if(await client.sessionId()!==checkpoint!.sessionId)throw new Error('qoder_session_changed_during_answer');
        checkpoint!.phase='answer_sending';await writeJsonAtomic(checkpointFile,checkpoint);
      });
      checkpoint.phase='sent';await writeJsonAtomic(checkpointFile,checkpoint);answering=false;
      await log(`已确认原会话问题回复，session=${checkpoint.sessionId}，turn=${expected}`);
    }else{
      if(initial.running)return pause('setup_recovery','原会话尚未空闲，拒绝发送。');
      if(initial.waiting)return pause(initial.waiting,initial.waitingText??'请先处理原会话等待项');
      const selected=await d.configureModel(c,{model:ctx.model??saved?.model,source:ctx.modelSource??saved?.source,level:ctx.reasoningLevel??saved?.level},wait);
      await log(`工作区与模型设置已核对：${selected.source}/${selected.model}/${selected.level??'未显示等级'}；准备填入任务正文。`);
      if(selected.globalChanged)await log(`已保存全局思考偏好：${selected.model}/${selected.level}；该偏好保留并影响后续任务。`);
      const marker=`[tianshu:${ctx.taskId}:round:${ctx.round}:${ctx.resume?.kind==='continue'?Date.now():'initial'}]`;
      const body=ctx.resume?.kind==='continue'&&ctx.resume.sendMessage?ctx.resume.message:
        ctx.round>0?ctx.feedback:`根据计划文档(${plan})进行项目开发。\n项目目录：${ctx.displayPath||ctx.projectPath}\n\n${ctx.task}\n${ctx.context??''}`;
      if(!body?.trim())throw new Error('qoder_empty_instruction');
      await assertWorkspace(c,ctx.projectPath);
      await c.fill(c.selector('input'),`${body}\n\n任务追踪标识：${marker}`);
      await wait(()=>client.exists(client.selector('send')),'send-button');
      const draft=await c.evaluate<string|undefined>(`new URLSearchParams(location.hash.split('?')[1]??'').get('draft')??undefined`);
      checkpoint={round:ctx.round,phase:'sending',sessionId:await c.sessionId()??draft,marker,model:selected.model,source:selected.source,level:selected.level,permission:await c.text(c.selector('permission'))};
      // Persist BEFORE clicking: a crash between input and acknowledgement must not resend the task.
      await writeJsonAtomic(checkpointFile,checkpoint);owned=true;
      await c.click(c.selector('send'));
      await waitUntil(Math.min(end,Date.now()+60_000))(async()=>{
        const p=await client.poll();
        if(p.sessionId&&p.userId&&p.userText.includes(marker)){
          expected=p.userId;checkpoint!.sessionId=p.sessionId;checkpoint!.userId=p.userId;checkpoint!.phase='sent';
          await writeJsonAtomic(checkpointFile,checkpoint);return true;
        }return false;
      },'send-acknowledgement');
      await log(`已确认发送，session=${checkpoint.sessionId}，turn=${expected}，model=${selected.source}/${selected.model}，权限沿用 ${checkpoint.permission}`);
    }
    let idleSince=Date.now(),last='',lastProgress=0,completionCount=0,reconnected=false;
    for(;;){
      signal.throwIfAborted();
      let p;
      try {p=await c.poll();}catch(error){
        if(reconnected)return pause('setup_recovery',`CDP 重连失败，保留原会话；不会重发任务：${String(error)}`);
        reconnected=true;await log('CDP 中断，仅尝试重连观察一次。');c.disconnect();await c.connect();continue;
      }
      if(p.sessionId!==checkpoint?.sessionId)throw new Error('qoder_session_changed_during_run');
      const status=judgeQoderPoll(p,expected);
      if(status==='needs_user')return pause(p.waiting!,p.waitingText??'Qoder 需要用户处理');
      if(status==='completed'){
        if(++completionCount>=g.stableRounds){checkpoint!.phase='completed';await writeJsonAtomic(checkpointFile,checkpoint);await log('本轮完成证据已确认，交给客观验收。');return result({ok:true,exitCode:0,endReason:'completion_mark'});}
      }else completionCount=0;
      if(p.running||p.assistantText!==last)idleSince=Date.now();
      last=p.assistantText;
      if(!p.running&&Date.now()-idleSince>=g.idleTimeoutMs)return pause('setup_recovery','界面静止但没有本轮完成证据，不启动验收。');
      if(Date.now()-lastProgress>=g.progressIntervalMs){
        const note=`Qoder ${status}；turn=${expected??'unknown'}；${p.assistantText.slice(-300)}`;
        await log(note);await opts.onProgress?.(note);lastProgress=Date.now();
      }
      await delay(Math.min(g.pollIntervalMs,Math.max(1,end-Date.now())),undefined,{signal});
    }
  }catch(error){
    const timedOut=controller.signal.aborted||Date.now()>=end;
    if(signal.aborted||timedOut){
      const guiStop=c&&owned&&checkpoint?.sessionId?await stopQoder(c,checkpoint.sessionId,g.cancelWaitMs):undefined;
      return result({timeout:timedOut,killed:!timedOut,guiStop,endReason:timedOut?'task_timeout':'cancelled',error:guiStop&&!guiStop.idle?'Qoder 停止结果不确定；GUI 中任务可能仍在运行，禁止重复派发。':String(error)});
    }
    if(checkpoint?.phase==='sending'||checkpoint?.phase==='answer_sending')return pause('setup_recovery',`发送结果不确定，拒绝自动重发：${String(error)}`);
    if(answering)return pause('agent_question',`答案尚未提交：${String(error)}`);
    if(String(error).includes('CDP_UNAVAILABLE'))return pause('setup_recovery',`Qoder 连接不可用，已保留实例和会话；请处理后继续：${String(error)}`);
    return result({hardFailure:true,endReason:'qoder_error',error:String(error)});
  }finally{clearTimeout(timer);c?.disconnect();}
}
