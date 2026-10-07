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

it('connected read-only tools use shared admission and revoked connector state changes its ACL',async()=>{
 const f=fixture();f.rows.set('google:accounts',[{id:'account',email:'owner@example.test'}]);
 const host=commonOwnerHost({...f.env,DRIVE_READS:'1',BRAVE_SEARCH_API_KEY:'fictional-search'},f.storage,'physical-id')!;
 const connected=await host.access();expect(connected.grants).toMatchObject({tools:expect.arrayContaining(['query_calendar','query_availability','get_tasks','read_drive','web_search'])});
 if(connected.grants.status==='available'){for(const name of ['send_email','read_thread','execute_action','propose_calendar_change'])expect(connected.grants.tools).not.toContain(name);}
 f.rows.set('google:accounts',[]);const revoked=await host.access();if(revoked.grants.status==='available')expect(revoked.grants.tools).not.toContain('query_calendar');
});
it('task scope excluding workspace never invokes receipt projection and matching scope admits it',async()=>{
 const f=fixture(),host=commonOwnerHost(f.env,f.storage,'physical-id')!;
 const workspace=vi.fn(async()=>[{text:'Saved artifact',source:{source_key:'receipt',source_kind:'workspace_snapshot' as const,scope:'principal' as const,source_taint:'external' as const,produced_at:123}}]);
 const admission={invocation:{verified_authority:{principal_ref:'owner',tenant_ref:'tenant'},input_refs:[{content_digest:'sha256:'+'a'.repeat(64)}]},snapshot:{snapshot_at:123,snapshot_ref:'snapshot'},assertCurrent:async()=>{}} as unknown as Parameters<typeof host.context>[0];
 host.context(admission,workspace);
 const request={principal_ref:'owner',tenant_ref:'tenant',snapshot_ref:'snapshot',snapshot_at:123};
 expect(await host.taskMaterials!(request,[])).toMatchObject({workspace:[]});expect(workspace).not.toHaveBeenCalled();
 expect(await host.taskMaterials!(request,['workspace'])).toMatchObject({workspace:[{text:'Saved artifact'}]});expect(workspace).toHaveBeenCalledTimes(1);
});
