import {describe,it,expect,vi} from 'vitest';
import {env} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {consoleAccess,type ConsoleView} from '../src/channels/console';
import {handleConsole} from '../src/channels/console-signin';
import type {ConsoleAuth} from '../src/identity/console-auth';
import {CONTROLS_PATH} from '../src/channels/dashboard-controls';
import {CONTROL_ACTION_PATH} from '../src/channels/dashboard-control-actions';
import {MEMORY_CONTROL_PATH} from '../src/channels/dashboard-memory-actions';
import {OWNER_CONTROLS_PATH,OWNER_CONTROLS_ACTION_PATH} from '../src/channels/dashboard-owner-controls';
const root='https://telegram-owner';
const apiHeaders=(token:string)=>({cookie:'waldo_console='+token});
const seed=(stub:DurableObjectStub)=>runInDurableObject(stub,(instance,state)=>{Object.assign((instance as unknown as {env:Record<string,unknown>}).env,{TELEGRAM_BOT_TOKEN:'123:synthetic',OPENAI_API_KEY:'synthetic-key'});return consoleAccess(state.storage).grant();});
type Read={csrf:string;revision:string;data:Record<string,unknown>};
const controls=async(stub:DurableObjectStub,token:string,view:string):Promise<Read>=>{const response=await stub.fetch(root+CONTROLS_PATH+'?view='+view,{headers:apiHeaders(token)});expect(response.status).toBe(200);return response.json();};
const postAction=(stub:DurableObjectStub,token:string,read:Read,fields:Record<string,string>)=>stub.fetch(root+CONTROL_ACTION_PATH,{method:'POST',headers:{...apiHeaders(token),'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:read.csrf,revision:read.revision,...fields})});
describe('dashboard control owner route and real executors',()=>{
 it('keeps unsigned and cross-owner sessions out of reads and writes',async()=>{
  const a=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('control-owner-a')),b=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('control-owner-b'));
  const token=await runInDurableObject(a,(_i,state)=>consoleAccess(state.storage).grant());
  for(const [path,method] of [[CONTROLS_PATH+'?view=day','GET'],[CONTROL_ACTION_PATH,'POST'],[MEMORY_CONTROL_PATH+'?id=foreign:claim:1','GET'],[OWNER_CONTROLS_PATH+'?view=account','GET'],[OWNER_CONTROLS_ACTION_PATH,'POST']])for(const [stub,cookie] of [[a,''],[b,token]] as const){const r=await stub.fetch(root+path,{method,headers:{cookie:'waldo_console='+cookie}});expect(r.status).toBe(401);expect(r.headers.get('cache-control')).toBe('private, no-store');}
 });
 it('routes APIs to the verified cookie owner and fails closed without a valid owner',async()=>{
  const requests:string[]=[];const ns={idFromName:(n:string)=>n,get:(n:string)=>({fetch:async()=>{requests.push(n);return Response.json({safe:true});}})} as unknown as DurableObjectNamespace;
  for(const path of [CONTROLS_PATH+'?view=day',CONTROL_ACTION_PATH]){
   const r=await handleConsole(new Request(root+path,{headers:{cookie:'waldo_owner=signed; waldo_console=session'}}),{TELEGRAM_OWNER_DO:ns},{readOwnerCookie:async()=>null} as unknown as ConsoleAuth);expect(r?.status).toBe(401);
   const owner=await handleConsole(new Request(root+path+'?owner=other',{headers:{cookie:'waldo_owner=signed; waldo_console=session'}}),{TELEGRAM_OWNER_DO:ns},{readOwnerCookie:async()=>'one'} as unknown as ConsoleAuth);expect(owner?.status).toBe(200);
  }
  expect(requests).toEqual(['one','one']);
 });
 it('uses real card pin executors and serializes duplicate receipts before execution',async()=>{
  const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('control-day-owner'));
  const token=await runInDurableObject(stub,(instance,state)=>{Object.assign((instance as unknown as {env:Record<string,unknown>}).env,{TELEGRAM_BOT_TOKEN:'123:synthetic',OPENAI_API_KEY:'synthetic-key'});return consoleAccess(state.storage).grant();});
  const headers={cookie:'waldo_console='+token};
  const read=async()=>{const r=await stub.fetch(root+CONTROLS_PATH+'?view=day',{headers});expect(r.status).toBe(200);return r.json() as Promise<{csrf:string;revision:string;data:Pick<ConsoleView,'cards'>}>;};
  const before=await read();const form=new URLSearchParams({csrf:before.csrf,revision:before.revision,view:'day',request_id:'pin-request-0001',action:'card.pin',id:'card:close',value:'22:15'});
  const post=()=>stub.fetch(root+CONTROL_ACTION_PATH,{method:'POST',headers:{...headers,'content-type':'application/x-www-form-urlencoded'},body:form});
  const [a,b]=await Promise.all([post(),post()]);expect(a.status).toBe(200);expect(b.status).toBe(200);const receipts=await Promise.all([a.json(),b.json()]) as {duplicate:boolean;receipt:{state:string}}[];expect(receipts.map(r=>r.duplicate).sort()).toEqual([false,true]);expect(receipts.every(r=>r.receipt.state==='recorded')).toBe(true);
  const after=await read();expect(after.data.cards.find(c=>c.id==='card:close')?.pin).toBe('22:15');expect(after.revision).not.toBe(before.revision);
  form.set('request_id','pin-request-0002');form.set('value','22:30');expect((await post()).status).toBe(409);expect((await read()).data.cards.find(c=>c.id==='card:close')?.pin).toBe('22:15');
  form.set('revision',after.revision);form.set('csrf','wrong');expect((await post()).status).toBe(403);
 });
 it('clears both console cookies and revokes access after the real signout executor',async()=>{
  const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('control-signout-owner'));
  const token=await seed(stub),read=await controls(stub,token,'connections');
  const response=await postAction(stub,token,read,{view:'connections',action:'session.signout',request_id:'signout-request-01'});
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({receipt:{state:'recorded',signed_out:true}});
  const cookies=(response.headers as unknown as {getSetCookie():string[]}).getSetCookie();expect(cookies).toHaveLength(2);
  for(const name of ['waldo_console','waldo_owner'])expect(cookies.find(value=>value.startsWith(name+'='))).toBe(`${name}=; Path=/console; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  expect((await stub.fetch(root+CONTROLS_PATH+'?view=connections',{headers:apiHeaders(token)})).status).toBe(401);
  expect((await postAction(stub,token,read,{view:'connections',action:'session.signout',request_id:'signout-request-01'})).status).toBe(401);
 });
 it('rejects a previously admitted queued mutation after its session is revoked',async()=>{
  const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('control-queued-revocation-owner'));
  const token=await seed(stub),read=await controls(stub,token,'day');
  type Gate={serial:(work:()=>Promise<Response>)=>Promise<Response>;qaAdmitted?:boolean;qaRelease?:()=>void;qaOriginal?:Gate['serial']};
  await runInDurableObject(stub,instance=>{
   const target=instance as unknown as Gate,original=target.serial.bind(target);target.qaOriginal=original;
   const gate=new Promise<void>(resolve=>{target.qaRelease=resolve;});
   target.serial=work=>{target.qaAdmitted=true;return original(async()=>{await gate;return work();});};
  });
  const request=postAction(stub,token,read,{view:'day',action:'card.pin',id:'card:close',value:'22:15',request_id:'revoked-pin-request'});
  try{
   await vi.waitFor(async()=>expect(await runInDurableObject(stub,instance=>(instance as unknown as Gate).qaAdmitted)).toBe(true));
   await runInDurableObject(stub,async(instance,state)=>{await consoleAccess(state.storage).signOutAll();(instance as unknown as Gate).qaRelease!();});
   const response=await request;expect(response.status).toBe(401);expect(await response.json()).toMatchObject({error:'sign_in_required'});
   await runInDurableObject(stub,(_instance,state)=>expect(state.storage.kv.get('console:control-receipts')).toBeUndefined());
  }finally{await runInDurableObject(stub,instance=>{const target=instance as unknown as Gate;target.qaRelease?.();target.serial=target.qaOriginal!;});}
  const newToken=await seed(stub),after=await controls(stub,newToken,'day');
  expect((after.data.cards as {id:string;pin:string|null}[]).find(card=>card.id==='card:close')?.pin).toBeNull();
 });
 it('rejects an old same-ID Memory review after its saved content changes',async()=>{
  const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('control-memory-stale-owner'));
  const token=await seed(stub);await controls(stub,token,'day');
  const id=await runInDurableObject(stub,(_instance,state)=>{
   state.storage.sql.exec("INSERT INTO claims (kind,text,source,evidence,origin,created_at,last_seen_at) VALUES ('preference','Original saved preference','inferred','Owner quote','owner','2026-10-01','2026-10-01')");
   const row=state.storage.sql.exec<{id:number}>('SELECT id FROM claims ORDER BY id DESC LIMIT 1').one();return `${state.id}:claim:${row.id}`;
  });
  const readMemory=async()=>{const response=await stub.fetch(root+MEMORY_CONTROL_PATH+'?'+new URLSearchParams({id}),{headers:apiHeaders(token)});expect(response.status).toBe(200);return response.json() as Promise<Read>;};
  const before=await readMemory();expect(JSON.stringify(before.data)).toContain('Original saved preference');
  await runInDurableObject(stub,(_instance,state)=>state.storage.sql.exec("UPDATE claims SET text='Corrected saved preference' WHERE id=?",Number(id.split(':').at(-1))).toArray());
  const rejected=await postAction(stub,token,before,{view:'memory',action:'spot.confirm',id,request_id:'stale-memory-request'});
  expect(rejected.status).toBe(409);expect(await rejected.json()).toMatchObject({error:'stale_read'});
  const after=await readMemory();expect(after.revision).not.toBe(before.revision);expect(JSON.stringify(after.data)).toContain('Corrected saved preference');
  await runInDurableObject(stub,(_instance,state)=>expect(state.storage.sql.exec('SELECT source FROM claims WHERE id=?',Number(id.split(':').at(-1))).one()).toEqual({source:'inferred'}));
  const accepted=await postAction(stub,token,after,{view:'memory',action:'spot.confirm',id,request_id:'fresh-memory-request'});expect(accepted.status).toBe(200);
  await runInDurableObject(stub,(_instance,state)=>expect(state.storage.sql.exec('SELECT source FROM claims WHERE id=?',Number(id.split(':').at(-1))).one()).toEqual({source:'confirmed'}));
 });
 it('rejects yesterday’s card.today revision across an owner-local date rollover',async()=>{
  const clock=vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-10-01T23:59:00Z'));
  try{
   const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('control-midnight-owner')),token=await seed(stub);
   const initial=await controls(stub,token,'day');
   const changed=await postAction(stub,token,initial,{view:'day',action:'timezone.set',value:'UTC',request_id:'midnight-zone-request'});expect(changed.status).toBe(200);
   const before=await controls(stub,token,'day');expect(before.data.date).toBe('2026-10-01');
   clock.mockReturnValue(Date.parse('2026-10-02T00:01:00Z'));
   const rejected=await postAction(stub,token,before,{view:'day',action:'card.today',id:'card:close',value:'22:15',request_id:'midnight-card-request'});
   expect(rejected.status).toBe(409);expect(await rejected.json()).toMatchObject({error:'stale_read'});
   const after=await controls(stub,token,'day');expect(after.data.date).toBe('2026-10-02');expect(after.revision).not.toBe(before.revision);
  }finally{clock.mockRestore();}
 });

 it('retains a renewed session’s duplicate receipt when another session prunes the journal',async()=>{
  const started=Date.parse('2026-10-01T12:00:00Z'),clock=vi.spyOn(Date,'now').mockReturnValue(started);
  try{
   const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('control-renewed-owner')),token=await seed(stub);
   await runInDurableObject(stub,async(_instance,state)=>{const sessions=await state.storage.get<Record<string,{expires:number}>>('console:sessions');sessions![token]!.expires=started+10*60000;await state.storage.put('console:sessions',sessions!);});
   const read=await controls(stub,token,'day'),fields={view:'day',action:'card.pin',id:'card:close',value:'22:15',request_id:'renewed-pin-request'};
   expect((await postAction(stub,token,read,fields)).status).toBe(200);
   clock.mockReturnValue(started+5*60000);
   await runInDurableObject(stub,async(_instance,state)=>{const access=consoleAccess(state.storage),link=await access.mintLink(root);expect(await access.redeem(new URL(link).searchParams.get('t')!,token)).toBe(token);});
   const other=await seed(stub);clock.mockReturnValue(started+20*60000);
   const otherRead=await controls(stub,other,'day');
   expect((await postAction(stub,other,otherRead,{...fields,value:'22:30',request_id:'other-session-pin'})).status).toBe(200);
   const replay=await postAction(stub,token,read,fields);expect(replay.status).toBe(200);expect(await replay.json()).toMatchObject({duplicate:true,receipt:{state:'recorded'}});
   const after=await controls(stub,token,'day');expect((after.data.cards as {id:string;pin:string|null}[]).find(card=>card.id==='card:close')?.pin).toBe('22:30');
  }finally{clock.mockRestore();}
 });

});
