import {env} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {consoleAccess} from '../src/channels/console';
import {handleConsole} from '../src/channels/console-signin';
import type {ConsoleAuth} from '../src/identity/console-auth';
const path='https://telegram-owner/console/diagnostics/common-runtime';
it('actual owner DO denies unsigned and cross-owner cookies; valid owner gets fixed receipt without database expansion',async()=>{
 const a=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('diag-a')),b=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('diag-b'));
 const token=await runInDurableObject(a,(instance,state)=>{
  Object.assign((instance as unknown as {env:Record<string,unknown>}).env,{TELEGRAM_BOT_TOKEN:'synthetic',OPENAI_API_KEY:'synthetic',WALDO_ENVIRONMENT:'staging',SUPABASE_PROJECT_URL:'https://togdshayyxycitzckpqv.supabase.co',SUPABASE_PUBLISHABLE_KEY:'private-key',WALDO_ROUTER_HMAC_SECRET:'private-hmac',RESPONSIBILITY_RATE_LIMITER:{limit:async()=>({success:true})}});
  return consoleAccess(state.storage).grant();
 });
 expect((await a.fetch(path)).status).toBe(401);
 expect((await b.fetch(path,{headers:{cookie:`waldo_console=${token}`}})).status).toBe(401);
 const before=await runInDurableObject(a,(_i,state)=>state.storage.sql.exec('SELECT name FROM sqlite_master ORDER BY name').toArray());
 const headers={cookie:`waldo_console=${token}`};
 const response=await a.fetch(path,{headers});expect(response.status).toBe(200);expect(await response.json()).toMatchObject({project_matches_expected:true});
 expect((await a.fetch(path+'?url=private',{headers})).status).toBe(400);
 expect((await a.fetch(path,{method:'POST',headers})).status).toBe(405);
 expect(await runInDurableObject(a,(_i,state)=>state.storage.sql.exec('SELECT name FROM sqlite_master ORDER BY name').toArray())).toEqual(before);
 await runInDurableObject(a,async(_i,state)=>consoleAccess(state.storage).signOutAll());
 expect((await a.fetch(path,{headers})).status).toBe(401);
});
it('outer console resolves verified owner cookie, not a URL owner selector',async()=>{
 const owners:string[]=[];const ns={idFromName:(n:string)=>n,get:(n:string)=>({fetch:async()=>{owners.push(n);return Response.json({fixed:true});}})} as unknown as DurableObjectNamespace;
 const request=new Request(path,{headers:{cookie:'waldo_owner=signed; waldo_console=session'}});
 expect((await handleConsole(request,{TELEGRAM_OWNER_DO:ns},{readOwnerCookie:async()=>null} as unknown as ConsoleAuth))?.status).toBe(303);
 expect((await handleConsole(new Request(path+'?owner=other',{headers:request.headers}),{TELEGRAM_OWNER_DO:ns},{readOwnerCookie:async()=>'verified-owner'} as unknown as ConsoleAuth))?.status).toBe(200);
 expect(owners).toEqual(['verified-owner']);
});
