import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AgentAdapterRegistry } from '../../src/agents/registry.js';
import { QoderGuiAdapter } from '../../src/agents/qoder/adapter.js';
import { QODER_PROFILE } from '../../src/agents/qoder/profile.js';
import { callTool,makeGitProject,parseMeta,startTestServer,waitForTerminal,rmrf,type TestServer } from '../test-utils.js';
import type { TaskContext } from '../../src/agents/adapter.js';

let server:TestServer|undefined;
const dirs:string[]=[];
afterEach(async()=>{await server?.close();server=undefined;vi.restoreAllMocks();for(const p of dirs.splice(0))await rmrf(p);});
async function setup(){
  const project=await makeGitProject('good');dirs.push(project);
  await fs.writeFile(path.join(project,'plan.md'),'# 开发计划\n写出 done.txt，内容为 PASS。');
  server=await startTestServer();dirs.push(server.home);
  vi.spyOn(AgentAdapterRegistry.prototype,'resolve').mockImplementation(async function(this:AgentAdapterRegistry){
    this.register('qoder',new QoderGuiAdapter('qoder'));
    return {id:'qoder',displayName:'Qoder CN',profile:QODER_PROFILE,command:'fixture',argsTemplate:[],ok:true,message:'hermetic'};
  });
  return {project,client:server.client};
}
const done=(ctx:TaskContext)=>({ok:true,exitCode:0,timeout:false,killed:false,durationMs:1,logFile:path.join(ctx.taskDir,`agent-${ctx.round}.log`),endReason:'completion_mark',session:{id:'fixture-session',boundProjectPath:ctx.projectPath}});

describe('Qoder public tools and objective acceptance loop',()=>{
  it('rejects missing planDoc before GUI execution',async()=>{
    const f=await setup();const run=vi.spyOn(QoderGuiAdapter.prototype,'run');
    const r=await callTool(f.client,'run_task',{projectPath:f.project,agentId:'qoder',task:'do work'});
    expect(r.text).toContain('planDoc');expect(run).not.toHaveBeenCalled();
  });
  it('writes a repair plan before rework, transmits its full text, and re-verifies',async()=>{
    const f=await setup();const rounds:TaskContext[]=[];
    vi.spyOn(QoderGuiAdapter.prototype,'run').mockImplementation(async ctx=>{
      rounds.push(ctx);
      if(ctx.round>0){
        const names=(await fs.readdir(ctx.taskDir)).filter(n=>n.startsWith('rework-')&&n.endsWith('.md'));
        expect(names.length).toBeGreaterThan(0);
        const plan=await fs.readFile(path.join(ctx.taskDir,names[0]!),'utf8');
        expect(ctx.feedback).toContain(plan);expect(ctx.resume?.sessionId).toBe('fixture-session');
      }
      await fs.writeFile(path.join(ctx.projectPath,'done.txt'),ctx.round?'PASS':'FAIL');
      return done(ctx);
    });
    const r=await callTool(f.client,'run_task',{projectPath:f.project,agentId:'qoder',task:'implement plan',planDoc:'plan.md',modelSource:'custom',reasoningLevel:'极高'});
    const meta=parseMeta(r.text).meta!;expect(meta.taskId).toBeTruthy();
    const final=await waitForTerminal(f.client,String(meta.taskId));
    expect(final.status,JSON.stringify(final)).toBe('succeeded');expect(rounds.map(c=>c.round)).toEqual([0,1]);expect(rounds[0]?.modelSource).toBe('custom');
    const report=await callTool(f.client,'get_task_report',{taskId:meta.taskId});expect(report.text).toContain('done-marker');
  });
  it('honors the configured repair limit rather than claiming success',async()=>{
    const f=await setup();let runs=0;
    vi.spyOn(QoderGuiAdapter.prototype,'run').mockImplementation(async ctx=>{runs++;await fs.writeFile(path.join(ctx.projectPath,'done.txt'),'FAIL');return done(ctx);});
    const r=await callTool(f.client,'run_task',{projectPath:f.project,agentId:'qoder',task:'implement',planDoc:'plan.md',autoFixRounds:1});
    const final=await waitForTerminal(f.client,String(parseMeta(r.text).meta?.taskId));expect(final.status).toBe('needs_attention');expect(runs).toBe(2);
  });
  it('writes a complete plan before manual rework in the original session',async()=>{
    const f=await setup();const rounds:number[]=[];
    vi.spyOn(QoderGuiAdapter.prototype,'run').mockImplementation(async ctx=>{
      rounds.push(ctx.round);
      if(ctx.round>0){
        const name=(await fs.readdir(ctx.taskDir)).find(n=>n.startsWith('rework-')&&n.endsWith('.md'))!;
        const plan=await fs.readFile(path.join(ctx.taskDir,name),'utf8');
        expect(plan).toContain('补充边界说明');expect(ctx.feedback).toContain(plan);
        expect(ctx.resume?.sessionId).toBe('fixture-session');
      }
      await fs.writeFile(path.join(ctx.projectPath,'done.txt'),'PASS');return done(ctx);
    });
    const first=await callTool(f.client,'run_task',{projectPath:f.project,agentId:'qoder',task:'implement',planDoc:'plan.md'});
    const taskId=String(parseMeta(first.text).meta?.taskId);
    expect((await waitForTerminal(f.client,taskId)).status).toBe('succeeded');
    await callTool(f.client,'rework_task',{taskId,feedback:'补充边界说明'});
    expect((await waitForTerminal(f.client,taskId)).status).toBe('succeeded');expect(rounds).toEqual([0,1]);
  });
  it('does not run objective verification or repair when GUI requests approval',async()=>{
    const f=await setup();let runs=0;
    vi.spyOn(QoderGuiAdapter.prototype,'run').mockImplementation(async ctx=>{runs++;return {...done(ctx),ok:false,needsUserKind:'user_confirmation',pendingQuestion:'允许一次'};});
    const r=await callTool(f.client,'run_task',{projectPath:f.project,agentId:'qoder',task:'implement',planDoc:'plan.md'});
    const id=String(parseMeta(r.text).meta?.taskId);
    for(let i=0;i<100;i++){
      const query=parseMeta((await callTool(f.client,'query_task',{taskId:id})).text).meta;
      if(query?.status==='needs_user')break;
      await new Promise(r=>setTimeout(r,20));
    }
    const current=await server!.assembly.store.readSnapshot(id);
    expect(current?.status).toBe('needs_user');expect(runs).toBe(1);expect(current?.reportMd).toBeUndefined();expect(current?.qoderSessionId).toBe('fixture-session');
  });
});
