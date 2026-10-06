// @vitest-environment happy-dom
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {MemoryMap} from './MemoryMap';
import type {MemoryPage} from './memory-model';
const page:MemoryPage={version:1,state:'available',complete:true,unavailable_claim_count:0,view:'claims',items:[],page:{limit:25,returned:0,total:0,next_cursor:null}};
const reply=(partial=false)=>({...page,actions:[],view:'interpretations',state:partial?'partial':'available',complete:!partial,unavailable_claim_count:partial?2:0});
async function mount(fetcher:()=>Promise<Response>){
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('fetch',vi.fn(fetcher));
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 await act(async()=>root.render(<MemoryMap read={page} focus="spots" spots={[]}/>));
 return {host,close:async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}};
}
it('does not turn a failed second read into an empty Memory, and allows retry',async()=>{
 let failed=true;const {host,close}=await mount(async()=>{if(failed)throw Error('Network failed');return new Response(JSON.stringify(reply()));});
 try{
  expect(host.textContent).toContain('Other page unavailable: Network failed');expect(host.textContent).not.toContain('Nothing saved yet');
  failed=false;await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Retry other page')!.click());
  expect(host.textContent).toContain('Nothing saved yet');
 }finally{await close();}
});
it('preserves partial read metadata and withholds complete-empty language',async()=>{
 const {host,close}=await mount(async()=>new Response(JSON.stringify(reply(true))));
 try{expect(host.textContent).toContain('partial, incomplete read');expect(host.textContent).toContain('2 claims withheld');expect(host.textContent).not.toContain('Nothing saved yet');}finally{await close();}
});
it('provides bounded zoom, keyboard pan and reset without hijacking node keys',async()=>{
 const {host,close}=await mount(async()=>new Response(JSON.stringify(reply())));
 try{
  const stage=host.querySelector<HTMLElement>('.mm-stage')!;
  await act(async()=>stage.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})));
  expect(stage.style.getPropertyValue('--px')).toBe('-40px');
  await act(async()=>{for(let i=0;i<30;i++)host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click();});
  expect(stage.style.getPropertyValue('--zoom')).toBe('2');
  await act(async()=>stage.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true})));
  expect(stage.style.getPropertyValue('--zoom')).toBe('1');expect(stage.style.getPropertyValue('--px')).toBe('0px');
 }finally{await close();}
});
