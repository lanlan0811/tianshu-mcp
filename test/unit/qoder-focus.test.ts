import {describe,it,expect,vi} from 'vitest';
import {parseHTML} from 'linkedom';
import vm from 'node:vm';
import {QoderCdpClient} from '../../src/agents/qoder/cdp.js';

const PRIMARY='qoder-cn-app://renderer/index.html?workbenchScope=primary#/';

/**
 * 焦点夹具：复刻 2026-10-11 真机观察到的行为——
 * Qoder 窗口被遮挡/不在前台时 `document.hidden===true`，Chromium 节流页面，
 * 合成鼠标事件被吞（控件明明在视口内却点不到）；调用
 * `Emulation.setFocusEmulationEnabled({enabled:true})` 后 hidden 转 false（真机实测）。
 */
function fixture(opts:{hidden?:boolean;focusHeals?:boolean}={}){
  const {document}=parseHTML('<html><body><button id="model"><span>模型</span></button><div id="cover"></div></body></html>');
  let hidden=opts.hidden??false;
  const focusHeals=opts.focusHeals??true;
  Object.defineProperty(document,'hidden',{get:()=>hidden,configurable:true});
  Object.defineProperty(document,'visibilityState',{get:()=>hidden?'hidden':'visible',configurable:true});
  for(const e of document.querySelectorAll('*')){
    e.getBoundingClientRect=()=>({width:20,height:20,x:0,y:0,top:0,left:0,right:20,bottom:20,toJSON:()=>({})});
    e.scrollIntoView=()=>{};
  }
  document.elementFromPoint=()=>document.querySelector('#model span');
  const c=new QoderCdpClient(1,30);
  c.evaluate=async<T>(expression:string)=>vm.runInNewContext(expression,{
    document,
    location:{href:PRIMARY},
    getComputedStyle:(e:HTMLElement)=>({display:'block',visibility:'visible',opacity:e.style.opacity||'1'}),
  }) as T;
  const wire=(c as unknown as {client:{connect:()=>Promise<void>;disconnect:()=>void;send:(method:string,args?:unknown)=>Promise<unknown>}}).client;
  vi.spyOn(wire,'connect').mockResolvedValue(undefined);
  vi.spyOn(wire,'disconnect').mockImplementation(()=>{});
  const send=vi.spyOn(wire,'send').mockImplementation(async(method:string,args?:unknown)=>{
    if(method==='Emulation.setFocusEmulationEnabled'&&(args as {enabled?:boolean}|undefined)?.enabled===true&&focusHeals)hidden=false;
    return {};
  });
  return {document,c,send,isHidden:()=>hidden};
}

describe('Qoder 窗口不在前台时的点击可用性',()=>{
  it('connect 在窗口不在前台时开启焦点模拟，并等到页面真的可见',async()=>{
    const f=fixture({hidden:true});
    expect(f.isHidden()).toBe(true);
    await f.c.connect();
    expect(f.send).toHaveBeenCalledWith('Emulation.setFocusEmulationEnabled',{enabled:true});
    expect(f.isHidden()).toBe(false);
  });

  it('click 自愈：窗口不在前台时先恢复前台再点击，不把节流误报成控件缺失',async()=>{
    const f=fixture({hidden:true});
    await f.c.click('#model');
    expect(f.send).toHaveBeenCalledWith('Emulation.setFocusEmulationEnabled',{enabled:true});
    expect(f.send).toHaveBeenCalledWith('Input.dispatchMouseEvent',expect.objectContaining({type:'mousePressed'}));
  });

  it('焦点模拟救不回来时，报错点名「窗口不在前台」而不是只报控件缺失',async()=>{
    const f=fixture({hidden:true,focusHeals:false});
    await expect(f.c.click('#model')).rejects.toThrow(/不在前台|节流/);
  });
});
