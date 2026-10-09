import type {CDPSession,HandoffCompleteResponse} from '@cloudflare/playwright';
// Only correlation/state crosses into the task checkpoint. Provider URLs and
// arbitrary completion reasons never leave this volatile controller.
export type NativeHandoffMetadata=Readonly<{version:1;state:'starting'|'pending'|'resuming';targetId:string;handoffId?:string;origin:string;reason:string;requestRunId:string}>;
export function nativeBrowserHandoff(options:Readonly<{cdp:CDPSession;providerSessionId:string;targetId:string;expiresAt:number;now():number;assertCustody():Promise<void>}>) {
 let handoffId:string|undefined,phase:'starting'|'pending'|'resuming'|'consumed'|'failed'='starting';
 let completion:Readonly<{handoffId:string;success:boolean}>|undefined,contradictory=false;
 const fail=()=>{phase='failed';throw Error('Native owner handoff unavailable');};
 const current=()=>{if(phase==='failed'||phase==='consumed'||options.now()>=options.expiresAt)fail();};
 const listener=(event:HandoffCompleteResponse)=>{
  if(event.targetId!==options.targetId||typeof event.handoffId!=='string'||!event.handoffId||typeof event.success!=='boolean'||handoffId&&event.handoffId!==handoffId
   ||completion&&(completion.handoffId!==event.handoffId||completion.success!==event.success)){contradictory=true;phase='failed';return;}
  completion={handoffId:event.handoffId,success:event.success};
 };
 // The installed fork augments send types, but on/off use arrow-property
 // declarations that cannot merge Cloudflare event overloads.
 const on=options.cdp.on as (event:string,listener:(event:HandoffCompleteResponse)=>void)=>CDPSession;
 const off=options.cdp.off as (event:string,listener:(event:HandoffCompleteResponse)=>void)=>CDPSession;
 const status=async()=>{
  current();await options.assertCustody();current();
  const identity=await options.cdp.send('Cloudflare.getSessionId');if(identity.sessionId!==options.providerSessionId)fail();
  const state=await options.cdp.send('Cloudflare.getHandoffState',{targetId:options.targetId});
  current();await options.assertCustody();current();
  if(typeof state.active!=='boolean'||state.active&&state.handoffId!==handoffId||contradictory||completion&&completion.handoffId!==handoffId)fail();
  return state;
 };
 return {
  async start(reason:string){
   if(phase!=='starting')fail();await options.assertCustody();current();
   const identity=await options.cdp.send('Cloudflare.getSessionId');if(identity.sessionId!==options.providerSessionId)fail();
   on.call(options.cdp,'Cloudflare.handoffComplete',listener);
   const response=await options.cdp.send('Cloudflare.handoff',{targetId:options.targetId,instructions:reason,timeout:Math.min(1800000,options.expiresAt-options.now())});
   await options.assertCustody();current();
   if(response.targetId!==options.targetId||typeof response.handoffId!=='string'||!response.handoffId||completion&&completion.handoffId!==response.handoffId)fail();
   handoffId=response.handoffId;phase='pending';return handoffId;
  },
  status,
  async origin(){
   await status();const result=await options.cdp.send('Target.getTargetInfo');await options.assertCustody();current();
   if(result.targetInfo.targetId!==options.targetId)fail();
   const url=new URL(result.targetInfo.url);if(url.protocol!=='https:'&&url.protocol!=='http:')fail();return url.origin;
  },
  async open(){
   const state=await status();if(phase!=='pending'||!state.active)fail();
   const result=await options.cdp.send('Cloudflare.getLiveView',{targetId:options.targetId,mode:'tab',expiresInMs:Math.min(300000,options.expiresAt-options.now())});
   await options.assertCustody();current();
   if(result.id!==options.targetId||phase!=='pending')fail();
   const latest=await status();if(!latest.active||completion||phase!=='pending')fail();
   const url=new URL(result.devtoolsFrontendUrl);
   if(url.protocol!=='https:'||url.hostname!=='live.browser.run'||url.port||url.pathname!=='/ui/view'||url.searchParams.get('mode')!=='tab'||url.username||url.password||url.hash)fail();
   return url.href;
  },
  async resume(commit:()=>void){
   const state=await status();if(state.active||phase!=='pending')fail();
   // Consume after the final await, reading the live event state. A completion
   // copied before custody could race a contradictory provider event.
   await options.assertCustody();current();
   if(contradictory||!completion||!completion.success||completion.handoffId!==handoffId||phase!=='pending')fail();
   phase='resuming';commit();
  },
  ready(){return phase==='resuming'&&!contradictory&&options.now()<options.expiresAt;},
  complete(){if(phase!=='resuming'||contradictory)fail();phase='consumed';off.call(options.cdp,'Cloudflare.handoffComplete',listener);},
  async dispose(){phase='failed';off.call(options.cdp,'Cloudflare.handoffComplete',listener);await options.cdp.detach();},
 };
}
