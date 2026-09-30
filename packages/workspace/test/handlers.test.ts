import { expect, it } from 'vitest';
import { workspaceHandlers } from '../src/handlers';
import { workspaceStore, type WorkspaceState } from '../src/store';
it('real store adapters bound text/taint, reject extra scope and never echo write body',async()=>{
 let state:WorkspaceState={binding:null,files:[],bodies:[],operations:[]};const map=new Map<string,Uint8Array>();let n=100;
 const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 const store=await workspaceStore({binding:{ownerId:id(1),environment:'staging',namespace:'namespace',doName:'name',doId:'id',stateVersion:1,mappingVersion:1},admit:async()=>({status:'ok'}),metadata:{transaction(f){const draft=structuredClone(state);const r=f(draft);state=draft;return r;}},bodies:{put:async(b,v)=>{map.set(b.blob_id,v);},get:async b=>map.get(b.blob_id)??null,remove:async b=>{map.delete(b.blob_id);}},now:()=>0,newId:()=>id(n++)});
 const h=workspaceHandlers(store),a={path:'text.md',text:'hostile instruction is data',mime:'text/markdown',expected_revision:0,operation_id:id(2)};
 const saved=await h.write(a);expect(saved.ok).toBe(true);expect(JSON.stringify(saved)).not.toContain(a.text);expect(saved.source_taint).toBeNull();
 const file=state.files[0]!;expect(await h.read({file_id:file.file_id,revision:1})).toMatchObject({ok:true,source_taint:'external',data:{text:a.text}});
 expect(await h.list({})).toMatchObject({ok:true,source_taint:'external'});expect(await h.read({file_id:file.file_id,revision:1,ownerId:id(4)})).toMatchObject({ok:false,source_taint:'external',code:'invalid'});
 expect(await h.write({...a,operation_id:id(3),mime:'application/pdf'})).toMatchObject({ok:false,code:'invalid'});expect(await h.write({...a,operation_id:id(3),text:'😎'.repeat(70000)})).toMatchObject({ok:false,code:'invalid'});
});
