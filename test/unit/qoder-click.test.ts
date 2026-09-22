import {describe,it,expect,vi} from 'vitest';
import {parseHTML} from 'linkedom';
import vm from 'node:vm';
import {QoderCdpClient} from '../../src/agents/qoder/cdp.js';

function fixture(){
  const {document}=parseHTML('<html><body><button id="model"><span>模型</span></button><div id="cover"></div></body></html>');
  for(const e of document.querySelectorAll('*')){
    e.getBoundingClientRect=()=>({width:20,height:20,x:0,y:0,top:0,left:0,right:20,bottom:20,toJSON:()=>({})});
    e.scrollIntoView=()=>{};
  }
  document.elementFromPoint=()=>document.querySelector('#model span');
  const c=new QoderCdpClient(1,30);
  c.evaluate=async<T>(expression:string)=>vm.runInNewContext(expression,{document,getComputedStyle:(e:HTMLElement)=>({display:'block',visibility:'visible',opacity:e.style.opacity||'1'})}) as T;
  const wire=(c as unknown as {client:{send:(method:string,args?:unknown)=>Promise<unknown>}}).client;
  const send=vi.spyOn(wire,'send').mockResolvedValue({});
  return {document,c,send};
}
describe('Qoder hit-tested GUI clicks',()=>{
  it('clicks only when the target owns the point under the pointer',async()=>{
    const f=fixture();await f.c.click('#model');
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenNthCalledWith(1,'Input.dispatchMouseEvent',expect.objectContaining({type:'mousePressed',x:10,y:10}));
  });
  it('does not click through an overlay',async()=>{
    const f=fixture();f.document.elementFromPoint=()=>f.document.querySelector('#cover');
    await expect(f.c.click('#model')).rejects.toThrow('control_missing_or_ambiguous');expect(f.send).not.toHaveBeenCalled();
  });
  it('does not treat an invisible animation frame as a visible control',async()=>{
    const f=fixture();f.document.querySelector<HTMLElement>('#model')!.style.opacity='0';
    expect(await f.c.exists('#model')).toBe(false);
    await expect(f.c.click('#model')).rejects.toThrow('control_missing_or_ambiguous');expect(f.send).not.toHaveBeenCalled();
  });
  it('preserves blank lines without using the submit Enter shortcut',async()=>{
    const f=fixture();const editor=f.document.createElement('div');
    editor.id='input';editor.setAttribute('contenteditable','true');f.document.body.append(editor);
    editor.getBoundingClientRect=f.document.querySelector('#model')!.getBoundingClientRect;editor.scrollIntoView=()=>{};
    f.document.elementFromPoint=()=>editor;
    Object.defineProperty(f.document,'activeElement',{value:editor,configurable:true});
    f.send.mockImplementation(async(method,args)=>{
      const event=args as {type?:string;key?:string;modifiers?:number;text?:string};
      if(method==='Input.insertText'){expect(event.text).not.toContain('\n');editor.textContent+=event.text??'';}
      if(method==='Input.dispatchKeyEvent'&&event.type==='keyDown'){
        if(event.key==='Backspace')editor.textContent='';
        if(event.key==='Enter'){expect(event.modifiers).toBe(8);editor.textContent+='\n';}
      }
      return {};
    });
    const value='标题\n\n  缩进\n\n结尾';await f.c.fill('#input',value);expect(editor.textContent).toBe(value);
  });
});
