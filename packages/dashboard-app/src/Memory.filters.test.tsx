// @vitest-environment happy-dom
import {act} from 'react';import {createRoot} from 'react-dom/client';import {it,expect,vi} from 'vitest';import {MemoryList} from './Memory';import {readMemory,type MemoryPage,type Claim} from './memory-model';import {response} from './memory-test-fixtures';
it('filters only returned records and preserves source, status and next-page controls',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const page=readMemory(response('view=claims')) as MemoryPage;const first=page.items[0] as Claim;
 try{await act(async()=>root.render(<MemoryList initialView="list" data={{...page,items:[first,{...first,id:'synthetic-owner:claim:2',text:'Owner stated statement',source:'stated'}],page:{...page.page,returned:2,total:30,next_cursor:'page2'}}} onNext={()=>{}} onRestart={()=>{}}/>));
 expect(host.querySelectorAll('.memory-record')).toHaveLength(2);await act(async()=>[...host.querySelectorAll('button')].find(n=>n.textContent==='Inferred')!.click());expect(host.querySelectorAll('.memory-record')).toHaveLength(1);expect(host.textContent).toContain('This page only, not all of Memory');expect(host.textContent).toContain('Shared');expect(host.querySelector<HTMLButtonElement>('.memory-pagination button:last-child')?.disabled).toBe(false);
 }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
