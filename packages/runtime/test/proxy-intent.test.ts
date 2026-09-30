import {expect,it,vi} from 'vitest';
import {executeProxyIntent,type IntentLedger,type IntentClaim} from '../src/connectors/proxy-intent';
const ledger=()=>{
 const rows=new Map<string,{digest:string;result?:unknown;done:boolean}>();
 const api:IntentLedger={claim:async(id,digest):Promise<IntentClaim>=>{const row=rows.get(id);if(!row){rows.set(id,{digest,done:false});return{state:'new'};}return row.digest!==digest?{state:'conflict'}:row.done?{state:'done',result:row.result}:{state:'pending'};},store:async(id,result)=>{const row=rows.get(id);if(!row||row.done)return false;row.done=true;row.result=result;return true;}};return{api,rows};
};
it('claim-before-dispatch and response loss replay never repeat a settled provider call',async()=>{
 const {api,rows}=ledger();const dispatch=vi.fn(async()=>{expect(rows.get('approval:1')?.done).toBe(false);return{message_id:'one'};});
 const first=await executeProxyIntent({id:'approval:1'},{connection:'c',method:'sendRaw',args:['bytes']},api,dispatch);
 expect(await executeProxyIntent({id:'approval:1'},{connection:'c',method:'sendRaw',args:['bytes']},api,dispatch)).toEqual(first);expect(dispatch).toHaveBeenCalledOnce();
});
it('unknown dispatch outcome retains pending on same intent and never blindly retries',async()=>{
 const {api}=ledger();const dispatch=vi.fn(async()=>{throw new Error('response lost');});
 await expect(executeProxyIntent({id:'a'},['bytes'],api,dispatch)).rejects.toThrow('intent_pending');
 await expect(executeProxyIntent({id:'a'},['bytes'],api,dispatch)).rejects.toThrow('intent_pending');expect(dispatch).toHaveBeenCalledOnce();
});
it('changed payload conflicts; two distinct approved intents with identical bytes both dispatch',async()=>{
 const {api}=ledger();const dispatch=vi.fn(async()=>({ok:true}));
 await executeProxyIntent({id:'a'},['one'],api,dispatch);await expect(executeProxyIntent({id:'a'},['two'],api,dispatch)).rejects.toThrow('intent_conflict');
 await executeProxyIntent({id:'b'},['one'],api,dispatch);expect(dispatch).toHaveBeenCalledTimes(2);
});
it('missing/invalid host context and ledger denial fail before dispatch',async()=>{
 const {api}=ledger();const dispatch=vi.fn();for(const id of [undefined,{id:''},{id:'model/path'}])await expect(executeProxyIntent(id,{},api,dispatch)).rejects.toThrow('intent_required');
 await expect(executeProxyIntent({id:'a'},{},{...api,claim:async()=>null},dispatch)).rejects.toThrow('intent_unavailable');expect(dispatch).not.toHaveBeenCalled();
});
it('failed receipt storage after a successful effect retains pending and cannot resend',async()=>{
 const {api}=ledger();const dispatch=vi.fn(async()=>({id:'one'}));const failing={...api,store:async()=>{throw new Error('store unavailable');}};
 await expect(executeProxyIntent({id:'a'},{},failing,dispatch)).rejects.toThrow('intent_pending');await expect(executeProxyIntent({id:'a'},{},failing,dispatch)).rejects.toThrow('intent_pending');expect(dispatch).toHaveBeenCalledOnce();
});
it('concurrent callers share one durable pending claim before await and only one dispatch',async()=>{
 const {api}=ledger();let release:()=>void=()=>{};const block=new Promise<void>(r=>{release=r;});let began:()=>void=()=>{};const started=new Promise<void>(r=>{began=r;});
 const dispatch=vi.fn(async()=>{began();await block;return{id:'one'};});const first=executeProxyIntent({id:'a'},{},api,dispatch);await started;
 await expect(executeProxyIntent({id:'a'},{},api,dispatch)).rejects.toThrow('intent_pending');release();await first;expect(dispatch).toHaveBeenCalledOnce();
});
import {googleProxy} from '../src/connectors/connections';
it('vault effect client rejects missing host intent before signed request but reads stay available',async()=>{
 const fetcher=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>Response.json({data:[]}));const proxy=googleProxy({SUPABASE_PROJECT_URL:'https://fixture.invalid',SUPABASE_PUBLISHABLE_KEY:'fixture',WALDO_ROUTER_HMAC_SECRET:'fixture'},fetcher)!;
 await expect(proxy.client('owner','conn').sendRaw('bytes')).rejects.toThrow('intent_required');expect(fetcher).not.toHaveBeenCalled();
 await proxy.client('owner','conn').events('a','b',1,false);expect(fetcher).toHaveBeenCalledOnce();
 await proxy.client('owner','conn',undefined,{id:'approval:1'}).sendRaw('bytes');expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).intent_id).toBe('approval:1');
});
import {googleHandlers,type GoogleAccess} from '../src/tools/live/google';
import type {GoogleClient} from '../src/connectors/google';
it('draft identity binds host owner/turn/call, repeats stable invocation but distinguishes legitimate identical calls',async()=>{
 const ids:string[]=[];const client={draft:async()=>({draft_id:'fixture'})} as unknown as GoogleClient;
 const access:GoogleAccess={client:async(_feature,intent)=>{ids.push(intent?.id??'missing');return client;}};
 const handler=googleHandlers(access,{propose:async()=>'',proposeSendEmail:async()=>'',record:()=>{}},{timezone:'UTC',now:()=>new Date(0)}).find(h=>h.name==='draft_email')!;
 const args={to:['fictional@test.invalid'],subject:'fixture',body_markdown:'fixture'};
 const ctx={authenticatedUserId:'owner',turnId:'turn',toolCallId:'call'};
 await handler.handle(args as never,ctx as never);await handler.handle(args as never,ctx as never);await handler.handle(args as never,{...ctx,toolCallId:'other'} as never);
 expect(ids[0]).toMatch(/^draft:[0-9a-f]{64}$/);expect(ids[1]).toBe(ids[0]);expect(ids[2]).not.toBe(ids[0]);
 const denied=await handler.handle(args as never);expect(denied).toMatchObject({ok:false,code:'rejected'});expect(ids).toHaveLength(3);
});
