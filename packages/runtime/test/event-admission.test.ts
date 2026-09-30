import {env} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {eventAdmission} from '../src/channels/event-admission';
it('durable event admission survives reconstruction, binds raw digest and never reclaims unknown notifications',async()=>{
 const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('event-admission-custody'));
 await runInDurableObject(stub,async(_instance,state)=>{
  const inbox=eventAdmission(state.storage);
  expect(inbox.admit('github','id:one','a','fixture')).toBe('admitted');
  // Crash after admission: same delivery can claim the retained work exactly once.
  const restarted=eventAdmission(state.storage);expect(restarted.admit('github','id:one','a','fixture')).toBe('duplicate');expect(restarted.claim('github','id:one')).toBe(true);
  // Crash after claim: whether the external send happened is unknown. No blind retry.
  const lost=eventAdmission(state.storage);expect(lost.claim('github','id:one')).toBe(false);expect(lost.admit('github','id:one','b','changed')).toBe('conflict');
  expect(lost.admit('other','id:one','b','fixture')).toBe('admitted');expect(lost.claim('other','id:one')).toBe(true);lost.finish('other','id:one');expect(lost.claim('other','id:one')).toBe(false);
  expect(state.storage.sql.exec<{state:string}>("SELECT state FROM event_admissions WHERE source='github'").one().state).toBe('unknown');
 });
});
it('actual owner event entry acknowledges durable admission, prevents duplicate notification and preserves unknown after loss',async()=>{
 const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('event-admission-entry'));
 await runInDurableObject(stub,async(instance,state)=>{
  const entry=instance as unknown as {recordEvent(r:Request,b:string):Promise<Response>;setup():unknown};
  const setup=entry.setup;let sends=0;let lose=false;const finished:{status:string;summary:string}[]=[];
  entry.setup=()=>({runs:{start:()=>({id:'synthetic-event'}),finish:(_id:string,status:string,summary:string)=>{finished.push({status,summary});return true;}},api:{sendMessage:async()=>{sends++;if(lose)throw new Error('synthetic response loss');}},owner:42,log:()=>{}});
  try{
   const body=JSON.stringify({subject:'fixture',kind:'push',title:'fixture'});
   const request=(id:string,digest='a'.repeat(64))=>new Request('https://owner/event',{method:'POST',headers:{'x-waldo-event-source':'github','x-waldo-event-notify':'1','x-waldo-event-delivery':`id:${id}`,'x-waldo-event-digest':digest}});
   expect((await entry.recordEvent(request('one'),body)).status).toBe(200);expect((await entry.recordEvent(request('one'),body)).status).toBe(200);expect(sends).toBe(1);
   expect((await entry.recordEvent(request('one','b'.repeat(64)),body)).status).toBe(409);expect(sends).toBe(1);
   lose=true;expect((await entry.recordEvent(request('lost'),body)).status).toBe(200);expect((await entry.recordEvent(request('lost'),body)).status).toBe(200);expect(sends).toBe(2);expect(finished.at(-1)).toEqual({status:'stopped',summary:'github: notification outcome unknown; not retried'});
   expect(state.storage.sql.exec<{state:string}>("SELECT state FROM event_admissions WHERE delivery='id:lost'").one().state).toBe('unknown');
  }finally{entry.setup=setup;}
 });
});
