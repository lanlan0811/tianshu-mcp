#!/usr/bin/env node
// Read-only diagnostic: no launch, clicks, task submissions, or approvals.
import {QODER_PROFILE} from '../dist/agents/qoder/profile.js';
import {discoverQoder} from '../dist/agents/qoder/discovery.js';
import {listQoderProcessesAsync,rootQoderProcesses,remoteDebugPort} from '../dist/agents/qoder/instance.js';
import {QoderCdpClient} from '../dist/agents/qoder/cdp.js';
import {boundWorkspace} from '../dist/agents/qoder/workspace.js';

const args=process.argv.slice(2);
const help='Usage: node scripts/probe-qoder.mjs [install|state] [--exe <path>] [--port <port>]\nBuild first with npm run build. Never launches Qoder or sends tasks. Connecting state may bring the existing workbench to the foreground.\n';
if(args.includes('--help')||args.includes('-h')){process.stdout.write(help);process.exit(0);}
let command='install',exe,port;
for(let i=0;i<args.length;i++){
  const a=args[i];
  if(a==='--exe'){exe=args[++i];if(!exe)throw new Error('--exe requires a path');}
  else if(a==='--port'){port=Number(args[++i]);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid --port');}
  else if(a==='install'||a==='state')command=a;
  else throw new Error(`Unknown argument: ${a}`);
}
try{
  if(command==='install'){
    const profile={...QODER_PROFILE,gui:{...QODER_PROFILE.gui,...(exe?{exePath:exe}:{})}};
    const installation=await discoverQoder(profile);
    process.stdout.write(JSON.stringify({platform:process.platform,installation,dispatchSupported:process.platform==='win32'&&!!installation},null,2)+'\n');
    if(!installation)process.exitCode=2;
  }else{
    if(process.platform!=='win32')throw new Error('Qoder CN macOS remains research; GUI probe unavailable');
    if(!port){
      const roots=rootQoderProcesses(await listQoderProcessesAsync());
      const ports=[...new Set(roots.map(p=>remoteDebugPort(p.commandLine)).filter(p=>p!==null))];
      if(ports.length!==1)throw new Error('No unique existing CDP instance; specify --port. No instance was launched.');
      port=ports[0];
    }
    const c=new QoderCdpClient(port,QODER_PROFILE.gui.cdpSendTimeoutMs);
    try{
      await c.connect();const p=await c.poll();
      process.stdout.write(JSON.stringify({port,sessionId:p.sessionId,userId:p.userId,assistantId:p.assistantId,running:p.running,completed:p.completed,waiting:p.waiting??null,workspace:await boundWorkspace(c),model:await c.text(c.selector('model')),permission:await c.text(c.selector('permission'))},null,2)+'\n');
    }finally{c.disconnect();}
  }
}catch(error){console.error(String(error));process.exitCode=1;}
