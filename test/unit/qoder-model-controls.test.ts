import {describe,it,expect} from 'vitest';
import {QoderCdpClient} from '../../src/agents/qoder/cdp.js';
import {configureModel,type QoderModelSource,type WaitFor} from '../../src/agents/qoder/model.js';

class ModelControls extends QoderCdpClient {
  groups={default:['Built-in'],custom:['Custom']};
  source:QoderModelSource='custom';
  selectedSource:QoderModelSource='custom';
  selected='Custom';
  menu=false;
  dialog=false;
  options=false;
  stored='低';
  draft='低';
  levels=['低','中','高','极高'];
  saves=0;
  managementOpens=0;
  ignoreSave=false;
  delayedClose=false;
  closingReads=0;
  constructor(){super(1,1);}
  override async text(css:string){return css===this.selector('model')?`${this.selected}\n${this.stored}`:this.draft;}
  override async evaluate<T>(expr:string):Promise<T>{
    if(expr.includes("getAttribute('data-value')"))return this.selectedSource as T;
    if(expr.includes('menuitemradio'))return this.levels as T;
    if(expr.includes('data-chat-model-selector-list'))return this.groups[this.source] as T;
    throw new Error(`Unexpected read: ${expr}`);
  }
  override async exists(css:string){
    if(css.includes('[aria-selected="true"]'))return css.includes(`data-value="${this.source}"`);
    if(css===this.selector('modelMenu')){
      if(this.closingReads>0&&--this.closingReads===0)this.menu=false;
      return this.menu;
    }
    if(css===this.selector('modelDialog'))return this.dialog;
    if(css===this.selector('levelItem'))return this.options;
    if(css.includes('思考强度'))return this.dialog;
    throw new Error(`Unexpected control: ${css}`);
  }
  override async click(css:string,text?:string,index?:number){
    const group=/data-value="(default|custom)"/.exec(css)?.[1] as QoderModelSource|undefined;
    if(group){this.source=group;return;}
    if(css===this.selector('model')){this.menu=!this.menu;this.source=this.selectedSource;return;}
    if(css===this.selector('modelList')){this.selected=this.groups[this.source][index!]!;this.selectedSource=this.source;if(this.delayedClose)this.closingReads=2;else this.menu=false;return;}
    if(text==='模型管理'){this.dialog=true;this.menu=false;this.draft=this.stored;this.managementOpens++;return;}
    if(css.includes('思考强度')){this.options=true;return;}
    if(css===this.selector('levelItem')){this.draft=text!;this.options=false;return;}
    if(text==='保存设置'){this.saves++;if(!this.ignoreSave)this.stored=this.draft;this.dialog=false;return;}
    if(css.includes('aria-label="关闭"')){this.dialog=false;return;}
    throw new Error(`Unexpected click: ${css} ${text}`);
  }
}
const wait:WaitFor=async(check,stage)=>{for(let i=0;i<3;i++)if(await check())return;throw new Error(`state not reached: ${stage}`);};
describe('Qoder model management controls',()=>{
  it('waits for asynchronous menu dismissal when reselecting the current model',async()=>{
    const c=new ModelControls();c.delayedClose=true;
    const result=await configureModel(c,{model:'Custom',source:'custom',level:'low'},wait);
    expect(result.level).toBe('low');expect(c.managementOpens).toBe(2);
  });
  it('persists the selected level and verifies it by reopening model management',async()=>{
    const c=new ModelControls();const r=await configureModel(c,{model:'Built-in',source:'default',level:'xhigh'},wait);
    expect(r).toEqual({model:'Built-in',source:'default',level:'xhigh',globalChanged:true});
    expect(c.managementOpens).toBe(2);expect(c.saves).toBe(1);expect(c.dialog).toBe(false);
  });
  it('rejects an unsupported maximum without saving a lower level',async()=>{
    const c=new ModelControls();await expect(configureModel(c,{model:'Custom',source:'custom',level:'max'},wait)).rejects.toThrow('reasoning_unsupported');
    expect(c.saves).toBe(0);expect(c.stored).toBe('低');
  });
  it('detects a save that did not persist',async()=>{
    const c=new ModelControls();c.ignoreSave=true;
    await expect(configureModel(c,{level:'high'},wait)).rejects.toThrow('persisted-reasoning');
    expect(c.managementOpens).toBe(2);
  });
  it('retains the current group and level when parameters are omitted',async()=>{
    const c=new ModelControls();c.groups.default=['Custom'];
    expect(await configureModel(c,{},wait)).toEqual({model:'Custom',source:'custom',level:'low',globalChanged:false});
    expect(c.managementOpens).toBe(0);expect(c.saves).toBe(0);
  });
  it('rejects cross-group ambiguity for an explicitly named model',async()=>{
    const c=new ModelControls();c.groups.default=['Custom'];
    await expect(configureModel(c,{model:'Custom'},wait)).rejects.toThrow('model_ambiguous');expect(c.saves).toBe(0);
  });
});
