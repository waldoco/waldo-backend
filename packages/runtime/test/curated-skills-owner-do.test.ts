import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { workspaceStore, type WorkspaceState, type WorkspaceStore } from '@waldo/workspace';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { CURATED_PREPARATION_SKILL } from '../src/skills/curated-owner';
const seen=vi.hoisted(()=>({mode:'',step:0,requests:[] as Array<{instructions:string;input:unknown;tools?:Array<{name:string}>}>,store:undefined as WorkspaceStore|undefined,fileId:'',revision:0}));
vi.mock('../src/channels/telegram-api',async(load)=>({...await load<typeof import('../src/channels/telegram-api')>(),createTelegramCaller:()=>async(method:string)=>method==='getMe'?{username:'fixture_bot'}:method==='sendMessage'?{message_id:1}:true}));
vi.mock('../src/channels/workspace-host',async(load)=>({...await load<typeof import('../src/channels/workspace-host')>(),workspaceOwnerHost:async()=>seen.store!}));
vi.mock('openai',()=>({default:class {responses={create:async(body:{instructions:string;input:unknown;text?:{format?:{name:string}};tools?:Array<{name:string}>})=>{
 const format=body.text?.format?.name;
 if(format) return {id:'fixture-format',output_text:format==='claim_ops'?'{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}':format==='reaction'?'{"reaction":"👌"}':'{}',output:[],usage:{input_tokens:1,output_tokens:1}};
 seen.requests.push(structuredClone(body));
 const call=(name:string,args:unknown)=>({id:`fixture-${seen.step}`,output_text:'',output:[{type:'function_call',call_id:`call-${seen.step}`,name,arguments:JSON.stringify(args)}],usage:{input_tokens:1,output_tokens:1}});
 const step=seen.step++;
 if(seen.mode==='install'||seen.mode==='disable'){
  if(step===0)return call(`skills_${seen.mode}`,{name:'document-email-preparation',version:1});
 } else if(seen.mode==='draft'||seen.mode==='revise'){
  if(step===0)return call('skills_load',{name:'document-email-preparation',version:1});
  if(step===1)expect(body.instructions).toContain('Prepare a reviewable draft.');
  if(step===1 && seen.mode==='revise')return call('workspace_read',{file_id:seen.fileId,revision:seen.revision});
  if((step===1 && seen.mode==='draft') || (step===2 && seen.mode==='revise')){return call('workspace_write',{path:'drafts/demo-email.md',text:seen.mode==='draft'?'To: demo@example.test\nSubject: Demo plan\nThe demo is October 15 at 09:10 UTC.':'To: demo@example.test\nSubject: Revised demo plan\nThe demo is October 15 at 10:00 UTC.',mime:'text/markdown',expected_revision:seen.mode==='draft'?0:seen.revision});}
 }
 return {id:'fixture-final',output_text:'Draft prepared for review; it has not been sent.',output:[],usage:{input_tokens:1,output_tokens:1}};
}};}}));
let seq=810000;
it('actual default owner DO installs once, selects normal tasks, saves and revises a practical email draft across turns, then disables',async()=>{
 const name=`curated-default-${++seq}`;
 await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)),async(_,state)=>{
  const noFetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('fixture denies real providers'));
  await state.storage.put({telegram_subject:'42',do_name:name});
  let ws:WorkspaceState={binding:null,files:[],bodies:[],operations:[]};const blobs=new Map<string,Uint8Array>();let n=10;
  const id=()=>`abcdefab-cdef-4abc-8abc-abcdefab${(n++).toString(16).padStart(4,'a').replace(/\d/g,'b')}`;
  seen.store=await workspaceStore({binding:{ownerId:'abcdefab-cdef-4abc-8abc-abcdefabcdef',environment:'staging',namespace:'fixture',doName:name,doId:state.id.toString(),stateVersion:1,mappingVersion:1},admit:async()=>({status:'ok'}),metadata:{transaction(work){const draft=structuredClone(ws);const value=work(draft);ws=draft;return value;}},bodies:{put:async(b,v)=>{blobs.set(b.blob_id,v);},get:async b=>blobs.get(b.blob_id)??null,remove:async b=>{blobs.delete(b.blob_id);}},now:Date.now,newId:id});
  const privateEnv={...env,TELEGRAM_BOT_TOKEN:'7.fixture',OPENAI_API_KEY:'fixture-model-key',WALDO_TOOL_OFFLOAD:'0'};
  let instance=new TelegramOwnerDO(state,privateEnv);
  const {TelegramOwnerInbox}=await import('../src/channels/telegram-owner-inbox');const {persistInboxWake}=await import('../src/scheduler/alarm-slot');const inbox=new TelegramOwnerInbox(state.storage,persistInboxWake);
  const send=async(mode:string,text:string)=>{
   seen.mode=mode;seen.step=0;const update=++seq;
   await inbox.admit({bot:'7.fixture',subject:'42',doName:name},update,JSON.stringify({update_id:update,message:{message_id:update,from:{id:42,is_bot:false},chat:{id:42,type:'private'},text}}));
   await (instance as unknown as {drainInbox():Promise<void>}).drainInbox();
   expect((await inbox.records()).find(r=>r.updateId===update)?.state).toBe('awaiting_delivery');
  };
  try{
   seen.requests=[];await send('install','/skills install document-email-preparation@1');
   expect(state.storage.sql.exec<{status:string}>('SELECT status FROM skills WHERE name=?',CURATED_PREPARATION_SKILL.name).toArray()[0]?.status).toBe('active');
   await send('draft','Prepare an email draft for the demo on October 15 at 09:10 UTC and save it privately.');
   expect(ws.files).toHaveLength(1);expect(ws.files[0]?.revision).toBe(1);seen.fileId=ws.files[0]!.file_id;seen.revision=1;
   instance=new TelegramOwnerDO(state,privateEnv);
   await send('revise','Change the saved demo draft time to 10:00 UTC.');
   expect(ws.files).toHaveLength(1);expect(ws.files[0]?.file_id).toBe(seen.fileId);expect(ws.files[0]?.revision).toBe(2);
   const read=await seen.store!.read(seen.fileId,2,0,8000);expect(read.text).toContain('10:00 UTC');
   expect(seen.requests.some(r=>r.instructions.includes(CURATED_PREPARATION_SKILL.body_markdown))).toBe(true);
   const offered=seen.requests[0]!.tools!.map(t=>t.name).sort();
   expect(offered).not.toContain('execute_code');
   expect(seen.requests.every(r=>JSON.stringify(r.tools?.map(t=>t.name).sort())===JSON.stringify(offered))).toBe(true);
   expect(seen.requests.every(r=>!JSON.stringify(r.input).includes(CURATED_PREPARATION_SKILL.body_markdown))).toBe(true);
   const before=seen.requests.length;await send('disable','/skills disable document-email-preparation@1');
   await send('ordinary','What is the next step?');
   expect(seen.requests.slice(before).every(r=>!r.instructions.includes(CURATED_PREPARATION_SKILL.body_markdown))).toBe(true);
   expect(state.storage.sql.exec<{status:string}>('SELECT status FROM skills WHERE name=?',CURATED_PREPARATION_SKILL.name).toArray()[0]?.status).toBe('archived');
  } finally {await state.storage.deleteAlarm();noFetch.mockRestore();seen.store=undefined;}
 });
});
