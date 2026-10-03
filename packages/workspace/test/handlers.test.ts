import { expect, it } from 'vitest';
import { workspaceHandlers } from '../src/handlers';
import { workspaceStore, LIMITS, type WorkspaceState } from '../src/store';
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

it('literal revision edits preserve unrelated recipient bytes and reject ambiguous, absent or stale spans',async()=>{
 let state:WorkspaceState={binding:null,files:[],bodies:[],operations:[]};const map=new Map<string,Uint8Array>();let n=1;
 const id=(n:number)=>`abcdefab-cdef-4abc-8abc-abcdefab${n.toString(16).padStart(4,'a')}`;
 const store=await workspaceStore({binding:{ownerId:id(100),environment:'staging',namespace:'ns',doName:'name',doId:'id',stateVersion:1,mappingVersion:1},admit:async()=>({status:'ok'}),metadata:{transaction(f){const d=structuredClone(state);const r=f(d);state=d;return r;}},bodies:{put:async(b,v)=>{map.set(b.blob_id,v);},get:async b=>map.get(b.blob_id)??null,remove:async b=>{map.delete(b.blob_id);}},now:()=>0,newId:()=>id(n++)});
 const h=workspaceHandlers(store);const write={path:'draft.md',text:'To: demo@example.test\nSubject: Noon demo\nHi, demo at noon.\nKeep café ☕ unchanged.',mime:'text/markdown',expected_revision:0,operation_id:id(200)};
 const saved=await h.write(write);expect(saved.ok).toBe(true);const file=state.files[0]!;
 const edit={path:write.path,mime:write.mime,expected_revision:1,operation_id:id(201),edits:[{before:'Subject: Noon demo',after:'Subject: Demo at 14:00'},{before:'Hi, demo at noon.',after:'Hi there! Please join the demo at 14:00.'}]};
 expect(await h.write(edit)).toMatchObject({ok:true,data:{file_id:file.file_id,revision:2}});
 expect((await store.read(file.file_id,2,0,8000)).text).toBe('To: demo@example.test\nSubject: Demo at 14:00\nHi there! Please join the demo at 14:00.\nKeep café ☕ unchanged.');
 expect(await h.write(edit)).toMatchObject({ok:true,data:{file_id:file.file_id,revision:2}});
 expect(await h.write({...edit,operation_id:id(202)})).toMatchObject({ok:false,code:'conflict'});
 const bad=(edits:unknown)=>h.write({...edit,edits,expected_revision:2,operation_id:id(203)});
 expect(await bad([{before:'14:00',after:'15:00'}])).toMatchObject({ok:false,code:'conflict'});
 expect(await bad([{before:'missing',after:'new'}])).toMatchObject({ok:false,code:'conflict'});
 expect(await bad([{before:'Subject: Demo at 14:00',after:'x'},{before:'Demo at 14:00',after:'y'}])).toMatchObject({ok:false,code:'conflict'});
 expect(await h.write({...write,operation_id:id(204),expected_revision:2,text:'To: [REDACTED_EMAIL]\nChanged body'})).toMatchObject({ok:false,code:'conflict'});
 expect(await h.write({...edit,operation_id:id(205),expected_revision:2,edits:[{before:'demo@example.test',after:'[REDACTED_EMAIL]'}]})).toMatchObject({ok:true,data:{revision:3}});
 const masked=(await store.read(file.file_id,3,0,8000)).text;expect(masked).toContain('[REDACTED_EMAIL]');
 expect(await h.write({...write,operation_id:id(206),expected_revision:3,text:masked.replace('Hi there!','Hi!')})).toMatchObject({ok:false,code:'conflict'});
 expect(await h.write({...write,operation_id:id(207),expected_revision:3,text:'Subject: Demo\nRecipient removed at owner request.'})).toMatchObject({ok:true,data:{revision:4}});
 expect((await store.read(file.file_id,4,0,8000)).text).not.toContain('demo@example.test');
 expect((await store.read(file.file_id,4,0,8000)).text).not.toContain('[REDACTED_EMAIL]');
 expect(await h.write({...edit,expected_revision:4,operation_id:id(208),edits:[{before:'Demo',after:'x'.repeat(LIMITS.textWriteBytes-4)}]})).toMatchObject({ok:false,code:'invalid'});
 expect(state.files[0]!.revision).toBe(4);
});
