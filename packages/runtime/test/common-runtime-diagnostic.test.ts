import {expect,it,vi} from 'vitest';
import {commonRuntimeDiagnostic} from '../src/channels/common-runtime-diagnostic';
const limiter={limit:vi.fn(async()=>({success:true}))} as unknown as RateLimit;
const env={WALDO_ENVIRONMENT:'staging',SUPABASE_PROJECT_URL:'https://togdshayyxycitzckpqv.supabase.co',SUPABASE_PUBLISHABLE_KEY:'PRIVATE_KEY',WALDO_ROUTER_HMAC_SECRET:'PRIVATE_HMAC'};
it('helper fixed configuration receipt reveals no secret target or owner data',async()=>{
 const response=await commonRuntimeDiagnostic(env,limiter,'PRIVATE_OWNER');const text=await response.text();
 expect(JSON.parse(text)).toMatchObject({project_matches_expected:true,configured:{directory_key:true,router_signing:true,common_owner_tasks:false,browser_binding:false}});
 for(const value of ['PRIVATE_KEY','PRIVATE_HMAC','PRIVATE_OWNER','togdshayy','https:'])expect(text).not.toContain(value);
 expect(response.headers.get('cache-control')).toBe('no-store');
});
it('alternate or malformed targets do not gain equality or expose their values',async()=>{
 for(const url of ['https://other.supabase.co','https://u:p@togdshayyxycitzckpqv.supabase.co','http://togdshayyxycitzckpqv.supabase.co','https://togdshayyxycitzckpqv.supabase.co/?private=1','PRIVATE_BAD_URL']){
  const response=await commonRuntimeDiagnostic({...env,SUPABASE_PROJECT_URL:url},limiter,'owner');expect(await response.json()).toMatchObject({project_matches_expected:false});
 }
});
it('production and absent/failed limiter fail closed',async()=>{
 expect((await commonRuntimeDiagnostic({...env,WALDO_ENVIRONMENT:'production'},limiter,'owner')).status).toBe(404);
 expect((await commonRuntimeDiagnostic(env,undefined,'owner')).status).toBe(503);
 expect((await commonRuntimeDiagnostic(env,{limit:async()=>({success:false})} as RateLimit,'owner')).status).toBe(429);
 expect((await commonRuntimeDiagnostic(env,{limit:async()=>{throw Error('private');}} as RateLimit,'owner')).status).toBe(503);
});
