import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { AgentProfileSchema, RunTaskParamsSchema } from '../../src/config/schema.js';
import { discoverQoder, validExecutable } from '../../src/agents/qoder/discovery.js';
import { QoderCdpClient,qoderTargetRank } from '../../src/agents/qoder/cdp.js';
import { rootQoderProcesses,remoteDebugPort,probeQoderPort } from '../../src/agents/qoder/instance.js';
import { normalizeLevel,matchModel } from '../../src/agents/qoder/model.js';
import { normalizeWorkspacePath } from '../../src/agents/qoder/workspace.js';
import { toNativeDialogPath } from '../../src/agents/qoder/dialog.js';
import { judgeQoderPoll,type QoderPoll } from '../../src/agents/qoder/liveness.js';
import { validateQoderReferences } from '../../src/agents/qoder/references.js';

const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'qoder-unit-'));
afterAll(()=>fs.rm(tmp,{recursive:true,force:true}));
const profile=AgentProfileSchema.parse({adapter:'qoder-gui',executableDiscovery:{preferredDrives:['D:'],relativePaths:['Qoder CN/Qoder CN.exe'],dirs:[],fileNames:['Qoder CN.exe']}});
const primary='qoder-cn-app://renderer/index.html?workbenchScope=primary#/?draft=one';
const observed:QoderPoll={sessionId:'one',userId:'u',userText:'task',assistantId:'assistant:u',assistantText:'done',running:false,completed:true};

describe('Qoder discovery and platform isolation',()=>{
  it('prefers explicit then D before registry and other drives',async()=>{
    for(const drive of ['C:','D:'])await fs.mkdir(path.join(tmp,drive[0]!,'Qoder CN'),{recursive:true});
    const roots={'C:':path.join(tmp,'C'),'D:':path.join(tmp,'D')};
    for(const root of Object.values(roots))await fs.writeFile(path.join(root,'Qoder CN','Qoder CN.exe'),'fixture');
    const input={platform:'win32' as const,driveRoots:roots,fixedDrives:['C:','D:'],registryDirs:[path.join(roots['C:'],'Qoder CN')],shortcuts:[],readVersion:async()=>undefined};
    const found=await discoverQoder(profile,input);
    expect(found?.path).toBe(path.join(roots['D:'],'Qoder CN','Qoder CN.exe'));
    expect((await discoverQoder({...profile,command:path.join(roots['C:'],'Qoder CN','Qoder CN.exe')},input))?.source).toBe('explicit');
    expect(await discoverQoder({...profile,command:path.join(tmp,'wrong.exe')},input)).toBeNull();
  });
  it('rejects foreign executable names and directories',()=>{
    expect(validExecutable(tmp,'win32')).toBe(false);
    expect(validExecutable(process.execPath,'win32')).toBe(false);
  });
  it('discovers a macOS bundle without claiming Windows support',async()=>{
    const dir=path.join(tmp,'Qoder CN.app','Contents','MacOS');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'Qoder CN'),'fixture');
    const p=AgentProfileSchema.parse({executableDiscovery:{dirs:[dir],fileNames:['Qoder CN']}});
    expect((await discoverQoder(p,{platform:'darwin',readVersion:async()=>undefined}))?.source).toBe('bundle');
  });
  it('does not treat plugin/renderer subprocesses as app instances',()=>{
    const rows=['"Qoder CN.exe" --remote-debugging-port=9777','"Qoder CN.exe" --type=renderer','"Qoder CN.exe" C:/user/plugins/host.js','"Qoder CN.exe" --type=crashpad-handler'].map((commandLine,pid)=>({commandLine,pid}));
    expect(rootQoderProcesses(rows).map(p=>p.pid)).toEqual([0]);
    expect(remoteDebugPort('--remote-debugging-port=9777')).toBe(9777);
    expect(remoteDebugPort('--remote-debugging-port=99999')).toBeNull();
  });
  it('requires the CN primary workbench, not a matching title or an overlay',async()=>{
    expect(qoderTargetRank({url:primary})).toBe(0);
    expect(qoderTargetRank({url:'qoder-app://renderer/index.html'})).toBe(100);
    expect((await probeQoderPort(1,1,async()=>[{type:'page',title:'Qoder CN',url:'http://example.test'}])).ready).toBe(false);
    expect((await probeQoderPort(1,1,async(_p,endpoint)=>endpoint==='/json'?[{type:'page',url:primary}]:{})).ready).toBe(true);
  });
});

describe('Qoder model and paths',()=>{
  it.each([['低','low'],['中','medium'],['高','high'],['极高','xhigh'],['最大','max'],['关闭思考','off']])('normalizes %s without conflating levels',(input,expected)=>expect(normalizeLevel(input)).toBe(expected));
  it('rejects unsupported on instead of ignoring it',()=>expect(()=>normalizeLevel('on')).toThrow('unsupported'));
  it('requires a unique exact model match across groups',()=>{
    const choices=[{name:'Example',source:'default' as const,index:0},{name:'Example',source:'custom' as const,index:0},{name:'Example Plus',source:'default' as const,index:1}];
    expect(()=>matchModel(choices,'Example')).toThrow('ambiguous');
    expect(matchModel(choices,'Example','custom').source).toBe('custom');
    expect(()=>matchModel(choices,'Exam')).toThrow('missing');
  });
  it('preserves case-sensitive macOS paths and normalizes Windows paths',()=>{
    expect(normalizeWorkspacePath('D:\\中文 空格\\Project\\','win32')).toBe(normalizeWorkspacePath('d:/中文 空格/project','win32'));
    expect(normalizeWorkspacePath('/Projects/A','darwin')).not.toBe(normalizeWorkspacePath('/Projects/a','darwin'));
    expect(toNativeDialogPath('d:/中文 空格/project')).toBe('D:\\中文 空格\\project');
  });
  it('requires an existing readable plan and directory',async()=>{
    await expect(validateQoderReferences(tmp)).rejects.toThrow('planDoc');
    await expect(validateQoderReferences(tmp,'absent.md')).rejects.toThrow();
    await fs.writeFile(path.join(tmp,'plan.md'),'# plan');
    expect(await validateQoderReferences(tmp,'plan.md')).toBe(path.join(tmp,'plan.md'));
    await expect(validateQoderReferences(tmp,'.')).rejects.toThrow('文件');
  });
  it('exposes modelSource and Qoder levels in the public schema',()=>{
    expect(RunTaskParamsSchema.parse({task:'task',modelSource:'custom',reasoningLevel:'极高'}).modelSource).toBe('custom');
    expect(RunTaskParamsSchema.safeParse({task:'task',modelSource:'other'}).success).toBe(false);
  });
});

describe('Qoder completion attribution',()=>{
  it('requires this user turn and matching assistant id',()=>{
    expect(judgeQoderPoll(observed,'u')).toBe('completed');
    expect(judgeQoderPoll(observed,'old')).toBe('unknown');
    expect(judgeQoderPoll({...observed,assistantId:'assistant:old'},'u')).toBe('unknown');
    expect(judgeQoderPoll(observed)).toBe('unknown');
  });
  it('running signals win over a visible footer; approvals win over stop',()=>{
    expect(judgeQoderPoll({...observed,running:true},'u')).toBe('running');
    expect(judgeQoderPoll({...observed,running:true,waiting:'user_confirmation'},'u')).toBe('needs_user');
    expect(judgeQoderPoll({...observed,completed:false},'u')).toBe('unknown');
  });
  it('extracts actual DOM turn ids and ignores old completion',async()=>{
    const {document}=parseHTML(`<html><body><div data-message-scroller-content aria-busy="false"><div data-message-kind="user" data-message-id="old">old</div><article data-message-kind="assistant" data-message-id="assistant:old"><div data-assistant-actions>done</div></article><div data-message-kind="user" data-message-id="new">new</div><article data-message-kind="assistant" data-message-id="assistant:new">thinking</article></div><button data-e2e="chat.send" data-send-button="generating"></button></body></html>`);
    for(const e of document.querySelectorAll('*'))e.getBoundingClientRect=()=>({width:10,height:10,x:0,y:0,top:0,left:0,right:10,bottom:10,toJSON:()=>({})});
    const c=new QoderCdpClient(1,1);
    c.evaluate=async<T>(expr:string)=>vm.runInNewContext(expr,{document,location:{hash:'#/chat/session'}}) as T;
    const p=await c.poll();expect(p.userId).toBe('new');expect(p.running).toBe(true);expect(p.completed).toBe(false);
    const oldFailure=document.createElement('div');oldFailure.setAttribute('data-turn-failure-card','');oldFailure.textContent='old failure';oldFailure.getBoundingClientRect=document.body.getBoundingClientRect;
    document.querySelector('[data-message-id="assistant:old"]')!.append(oldFailure);
    expect((await c.poll()).waiting).toBeUndefined();
    const gate=document.createElement('div');gate.setAttribute('data-pending-interaction-overlay','');gate.textContent='允许一次';gate.getBoundingClientRect=document.body.getBoundingClientRect;document.body.append(gate);
    expect((await c.poll()).waiting).toBe('user_confirmation');
  });
});
