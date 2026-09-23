import {describe,it,expect} from 'vitest';
import path from 'node:path';
import os from 'node:os';
import {QoderCdpClient} from '../../src/agents/qoder/cdp.js';
import {bindWorkspace} from '../../src/agents/qoder/workspace.js';
import type {WaitFor} from '../../src/agents/qoder/model.js';

class WorkspaceControls extends QoderCdpClient {
  bound='';
  matches=0;
  picker=false;
  form=false;
  selectedFolder=false;
  name='';
  search='';
  clicks:string[]=[];
  constructor(readonly candidate:string){super(1,1);}
  override async evaluate<T>(expr:string):Promise<T>{
    if(expr.includes('new Set(a)'))return this.bound as T;
    if(expr.includes('getAttribute(\'title\')'))return (this.selectedFolder?[this.candidate]:[]) as T;
    if(expr.includes('?.value==='))return true as T;
    if(expr.includes('.length'))return this.matches as T;
    throw new Error(`Unexpected read: ${expr}`);
  }
  override async exists(css:string){
    // issue #23：选择器升级为多候选，桩按候选集合匹配（候选顺序由生产代码决定，这里只需回答「在不在」）。
    if(this.candidates('workspaceSearch').includes(css))return this.picker;
    if(this.candidates('workspaceMenu').includes(css))return false;
    if(this.candidates('workspaceForm').includes(css))return this.form;
    if(this.candidates('workspace').includes(css))return true;
    if(css.includes('[title='))return this.selectedFolder;
    throw new Error(`Unexpected control: ${css}`);
  }
  override async fill(css:string,text:string){
    if(css===this.selector('workspaceSearch'))this.search=text;
    else if(css===this.selector('workspaceName'))this.name=text;
    else throw new Error(`Unexpected input: ${css}`);
  }
  override async click(css:string,text?:string){
    this.clicks.push(text??css);
    if(css===this.selector('workspace'))this.picker=true;
    else if(css===this.selector('workspaceItem')){this.bound=this.candidate;this.picker=false;}
    else if(text==='新建工作区'){this.form=true;this.picker=false;}
    else if(css===this.selector('workspaceCreate')){this.bound=this.candidate;this.form=false;}
    else if(css!==this.selector('folderAdd'))throw new Error(`Unexpected click: ${css}`);
  }
}
const wait:WaitFor=async(check,stage)=>{for(let i=0;i<3;i++)if(await check())return;throw new Error(`state not reached: ${stage}`);};
const project=path.join(os.tmpdir(),'中文 空格','same-name');
describe('Qoder workspace identity and registration',()=>{
  it('reuses an already bound full path without opening the picker',async()=>{
    const c=new WorkspaceControls(project);c.bound=project;
    await bindWorkspace(c,project,wait,{pids:[],timeoutMs:100});expect(c.clicks).toEqual([]);
  });
  it('does not mistake a same-name directory for the requested path',async()=>{
    const c=new WorkspaceControls(path.join(os.tmpdir(),'other','same-name'));c.matches=1;
    await expect(bindWorkspace(c,project,wait,{pids:[],timeoutMs:100})).rejects.toThrow('workspace_mismatch');
    expect(c.search).toBe(project);
  });
  it('rejects multiple candidate matches',async()=>{
    const c=new WorkspaceControls(project);c.matches=2;
    await expect(bindWorkspace(c,project,wait,{pids:[],timeoutMs:100})).rejects.toThrow('workspace_ambiguous');
    expect(c.clicks).not.toContain(c.selector('workspaceItem'));
  });
  it('registers a new existing folder with owner and baseline dialog checks',async()=>{
    const c=new WorkspaceControls(project);const events:string[]=[];
    await bindWorkspace(c,project,wait,{pids:[123],timeoutMs:100,
      list:async pids=>{expect(pids).toEqual([123]);events.push('baseline');return ['old-dialog'];},
      select:async(folder,pids,baseline)=>{
        expect(folder).toBe(project);expect(pids).toEqual([123]);expect(baseline).toEqual(['old-dialog']);
        expect(c.clicks.at(-1)).toBe(c.selector('folderAdd'));events.push('select');c.selectedFolder=true;
        return {ok:true,message:'selected'};
      },
    });
    expect(events).toEqual(['baseline','select']);expect(c.name).toBe('same-name');expect(c.bound).toBe(project);
  });
  it('does not create a workspace when the selected source path cannot be read back',async()=>{
    const c=new WorkspaceControls(project);
    await expect(bindWorkspace(c,project,wait,{pids:[123],timeoutMs:100,list:async()=>[],select:async()=>({ok:true,message:'selected'})})).rejects.toThrow('source-folder-readback');
    expect(c.clicks).not.toContain(c.selector('workspaceCreate'));
  });
});
