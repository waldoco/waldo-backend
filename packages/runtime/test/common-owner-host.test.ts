import {it,expect,vi,afterEach} from 'vitest';
import {commonOwnerHost} from '../src/channels/common-owner-host';
import type {TelegramWebhookEnv} from '../src/channels/telegram-webhook';
afterEach(()=>vi.unstubAllGlobals());
const fixture=()=>{
 const rows=new Map<string,unknown>([['do_name','real-host-owner'],['telegram_subject','81106']]);
 const storage={kv:{get:(key:string)=>rows.get(key)}} as DurableObjectStorage;
 const env={COMMON_OWNER_TASKS:'1',WALDO_ENVIRONMENT:'staging',WALDO_OWNER_DO_NAMESPACE:'owners',SUPABASE_PROJECT_URL:'https://real-source.fixture.invalid',SUPABASE_PUBLISHABLE_KEY:'fictional-publishable',WALDO_ROUTER_HMAC_SECRET:'fictional-private-hmac',OPENAI_API_KEY:'fictional-key',TELEGRAM_OWNER_DO:{idFromName:(name:string)=>({toString:()=>name==='real-host-owner'?'physical-id':'different-id'})}} as unknown as TelegramWebhookEnv;
 return {env,storage,rows};
};
it('default deployment/production does not opt into common host or browser',()=>{
 const f=fixture();expect(commonOwnerHost({...f.env,COMMON_OWNER_TASKS:undefined},f.storage,'physical-id')).toBeUndefined();
 expect(commonOwnerHost({...f.env,WALDO_ENVIRONMENT:'production'},f.storage,'physical-id')).toBeUndefined();
 const host=commonOwnerHost(f.env,f.storage,'physical-id')!;expect(host.browser).toBeUndefined();expect(host.executionBinding?.provider.id).toBe('openai_responses');expect(host.executionBinding?.environment.environmentKind).toBe('cloud');
});
it('actual signed directory projection supplies strict message presence and physical/subject changes deny',async()=>{
 const f=fixture();let calls=0;
 vi.stubGlobal('fetch',async()=>{calls++;return Response.json({owner_id:'10000000-0000-0000-0000-000000081106',auth_user_id:'30000000-0000-0000-0000-000000000006',presence_id:'20000000-0000-0000-0000-000000081106',do_name:'real-host-owner',provider:'telegram',subject:'81106',state_version:0,admission_revision:'9007199254740993'});});
 const host=commonOwnerHost(f.env,f.storage,'physical-id')!;
 expect(await host.lookup('telegram','81106')).toMatchObject({owner_id:'10000000-0000-0000-0000-000000081106',admission_revision:'9007199254740993'});expect(calls).toBe(1);
 await expect(host.lookup('telegram','81107')).rejects.toThrow('subject changed');expect(calls).toBe(1);
 f.rows.set('telegram_unlinked',true);await expect(host.lookup('telegram','81106')).rejects.toThrow('physical binding');expect(calls).toBe(1);
});
it('canonical access excludes outbound effects and browser while admitting existing private workspace',async()=>{
 const f=fixture(),host=commonOwnerHost(f.env,f.storage,'physical-id')!;
 const access=await host.access();expect(access.grants.status).toBe('available');
 if(access.grants.status==='available'){
  expect(access.grants.tools).toContain('workspace_write');expect(access.grants.tools).toContain('get_context');
  expect(access.grants.tools).not.toContain('send_message');expect(access.grants.tools).not.toContain('execute_action');expect(access.grants.tools).not.toContain('browse_page');
 }
 f.rows.set('do_name','wrong-host');await expect(host.access()).rejects.toThrow('physical binding');
});
