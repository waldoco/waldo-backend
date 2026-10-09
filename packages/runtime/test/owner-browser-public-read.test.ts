import {expect,it,vi} from 'vitest';
import {ownerBrowserRuntime} from '../src/channels/owner-browser-runtime';
import {registerCommonBrowserSdk} from '../src/channels/common-staging-registration';
vi.mock('../src/identity/common-owner-authority',()=>({commonOwnerAuthority:()=>({resolve:async()=>({directoryOwnerId:'10000000-0000-0000-0000-000000000002',custodyDigest:'b'.repeat(64)})})}));
const calls:string[]=[];let alive=false;
registerCommonBrowserSdk(async()=>({
 acquire:async()=>{calls.push('acquire');alive=true;return {sessionId:'owned-public-read'};},
 connect:async()=>({newContext:async()=>({route:async()=>{},newPage:async()=>({mainFrame:()=>null,setDefaultTimeout(){},goto:async()=>({status:()=>200}),url:()=> 'https://example.com/menu',title:async()=> 'Menu',locator:()=>({innerText:async()=> 'Vegetarian pasta'})}),close:async()=>{}}),newBrowserCDPSession:async()=>({send:async()=>{calls.push('close');alive=false;}}),close:async()=>{}}),
 sessions:async()=>alive?[{sessionId:'owned-public-read'}]:[],endpointURLString:()=>'',
} as never));
function fixture(){
 calls.length=0;const rows=new Map<string,any>([['do_name','public-owner'],['telegram_subject','81102']]);
 const storage={kv:{get:(key:string)=>rows.get(key),put:(key:string,value:unknown)=>{calls.push('reserve');rows.set(key,structuredClone(value));},list:({prefix}:{prefix:string})=>[...rows].filter(([key])=>key.startsWith(prefix))},transactionSync:<T>(work:()=>T)=>work()} as unknown as DurableObjectStorage;
 const scope={runId:'public-run',attempt:'attempt',deadline:Date.now()+60000,signal:new AbortController().signal,admit(){},commit:<T>(work:()=>T)=>work()};
 const env={WALDO_ENVIRONMENT:'staging',BROWSER:{},TELEGRAM_OWNER_DO:{idFromName:()=>({toString:()=> 'physical'})}} as never;
 const runtime=ownerBrowserRuntime({env,storage,actualDoId:'physical',activeScope:()=>scope});
 const fallback={name:'browse_page',handle:vi.fn(()=>{throw Error('No paid alternative');})} as never;
 const args={provider:'cloudflare_playwright' as const,url:'https://example.com/menu',instruction:'Read menu'};
 const ctx={authenticatedUserId:'prn_10000000000000000000000000000002',runScope:scope,egressAllowlist:['*'],toolCallId:'read-1'};
 return {rows,storage,env,runtime,fallback,args,ctx,reconstruct:()=>ownerBrowserRuntime({env,storage,actualDoId:'physical',activeScope:()=>scope}),read:(id='read-1')=>runtime.read(fallback).handle(args,{...ctx,toolCallId:id} as never)};
}
it('ordinary owner Cloudflare read works without trial registration and reserves retained owner cost before acquire',async()=>{
 const {read,rows}=fixture(),result=await read();
 expect(result).toMatchObject({ok:true,data:{provider:'cloudflare_playwright',data:{text:'Vegetarian pasta'}}});
 expect(calls.indexOf('reserve')).toBeLessThan(calls.indexOf('acquire'));expect(calls).toContain('close');expect(alive).toBe(false);
 expect(rows.get('common-public-browser-month:'+new Date().toISOString().slice(0,7))).toBe(2090000);
});
it('expired trial registration does not block normal reads or reset prior reservations',async()=>{
 const f=fixture();(f.env as any).COMMON_BROWSER_REGISTRATION=JSON.stringify({scope:'verified_owners',policy:{ref:'expired',createdAt:1,expiresAt:2},spend:{validUntil:2}});
 const ownerId=f.ctx.authenticatedUserId;
 f.rows.set('common-spend:expired',{policy:{ref:'expired',ownerId,validUntil:2,limitMicrousd:10000000,maxCalls:100},reservedMicrousd:100,calls:[{id:'prior',upperBoundMicrousd:100}],cleanup:[]});
 const prior=structuredClone(f.rows.get('common-spend:expired'));
 expect(await f.read()).toMatchObject({ok:true});expect(f.rows.get('common-spend:expired')).toEqual(prior);
 expect(f.rows.has('common_owner_browser_registration_v1')).toBe(false);
});
it('reconstruction and further reads cannot reset monthly or uncertain reservations; ordinary model turns remain ungated',async()=>{
 const f=fixture();expect(await f.read()).toMatchObject({ok:true});expect(await f.read('read-2')).toMatchObject({ok:true});
 const before=calls.filter(x=>x==='acquire').length,snapshot=structuredClone([...f.rows]);
 expect(await f.reconstruct().read(f.fallback).handle(f.args,{...f.ctx,toolCallId:'read-3'} as never)).toMatchObject({ok:false});expect(await f.read('read-1')).toMatchObject({ok:false});
 expect(calls.filter(x=>x==='acquire')).toHaveLength(before);expect([...f.rows]).toEqual(snapshot);
 expect(f.runtime.gateway()).toBeUndefined();
});
it.each(['foreign','corrupt','monthly','revoked','lower_ceiling'])('rejects %s retained authority/accounting before provider allocation',async kind=>{
 const f=fixture();
 if(kind==='foreign')f.rows.set('common-spend:old',{policy:{ownerId:'another-owner'}});
 if(kind==='corrupt')f.rows.set('owner-public-browser-spend:v1',{ownerId:f.ctx.authenticatedUserId,custodyDigest:'b'.repeat(64),reservedMicrousd:0,intents:['prior']});
 if(kind==='monthly')f.rows.set('common-public-browser-month:'+new Date().toISOString().slice(0,7),-1);
 if(kind==='revoked')f.rows.set('telegram_unlinked',true);
 if(kind==='lower_ceiling')(f.env as any).COMMON_BROWSER_REGISTRATION=JSON.stringify({spend:{limitMicrousd:2000000}});
 const snapshot=structuredClone([...f.rows]);expect(await f.read()).toMatchObject({ok:false});expect(calls).not.toContain('acquire');expect([...f.rows]).toEqual(snapshot);
});
