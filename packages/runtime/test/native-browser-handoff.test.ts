import {expect,it,vi} from 'vitest';
import {nativeBrowserHandoff} from '../src/channels/native-browser-handoff';
function fixture(){
 let stateId='handoff',sendHook:((method:string)=>Promise<void>)|undefined;
 let listener:((event:any)=>void)|undefined,active=true,calls=0,hook:(()=>Promise<void>)|undefined;
 const commands:string[]=[];
 const cdp={on:(_event:string,fn:any)=>{listener=fn;},off:()=>{listener=undefined;},detach:async()=>{},send:async(method:string)=>{commands.push(method);await sendHook?.(method);if(method==='Target.getTargetInfo')return {targetInfo:{targetId:'tab',url:'https://account.fixture.invalid:8443/login'}};if(method==='Cloudflare.getSessionId')return {sessionId:'session'};if(method==='Cloudflare.handoff'){expect(listener).toBeDefined();return {targetId:'tab',handoffId:'handoff'};}if(method==='Cloudflare.getHandoffState')return {active,handoffId:stateId};if(method==='Cloudflare.getLiveView')return {id:'tab',devtoolsFrontendUrl:'https://live.browser.run/ui/view?mode=tab&wss=fictional'};throw Error('unexpected');}};
 const controller=nativeBrowserHandoff({cdp:cdp as never,providerSessionId:'session',targetId:'tab',expiresAt:Date.now()+60000,now:Date.now,assertCustody:async()=>{calls++;await hook?.();}});
 return {controller,commands,raw:(event:any)=>listener?.(event),stateId:(id:string)=>{stateId=id;},sendHook:(fn:(method:string)=>Promise<void>)=>{sendHook=fn;},emit:(success:boolean,id='handoff')=>{active=false;listener?.({targetId:'tab',handoffId:id,success});},setHook:(fn:()=>Promise<void>)=>{hook=fn;},calls:()=>calls};
}
it('contradictory completion during final custody await prevents atomic resume commit',async()=>{
 const f=fixture();await f.controller.start('Owner login');f.emit(true);let committed=false,checks=0;
 f.setHook(async()=>{if(++checks===3)f.emit(false);});
 await expect(f.controller.resume(()=>{committed=true;})).rejects.toThrow();expect(committed).toBe(false);expect(f.controller.ready()).toBe(false);
});
it('matching duplicate completion is consumed once; missing or mismatched correlation fails closed',async()=>{
 const f=fixture();await f.controller.start('Owner login');f.emit(true);f.emit(true);let commits=0;await f.controller.resume(()=>commits++);expect(commits).toBe(1);f.controller.complete();await expect(f.controller.resume(()=>commits++)).rejects.toThrow();expect(commits).toBe(1);
 const bad=fixture();await bad.controller.start('Owner login');bad.emit(true,'');await expect(bad.controller.resume(()=>commits++)).rejects.toThrow();expect(commits).toBe(1);
});

it('null completion fails closed without throwing out of the provider callback',async()=>{
 const f=fixture();await f.controller.start('Owner login');expect(()=>f.raw(null)).not.toThrow();await expect(f.controller.resume(()=>{})).rejects.toThrow('Native owner handoff unavailable');
});
it('inactive status carrying a contradictory handoff ID cannot consume matching success',async()=>{
 const f=fixture();await f.controller.start('Owner login');f.emit(true);f.stateId('different-handoff');await expect(f.controller.resume(()=>{})).rejects.toThrow('Native owner handoff unavailable');
});
it('stalled CDP transport ends at existing 10s bound without extending funded human lifetime',async()=>{
 vi.useFakeTimers();try{const f=fixture();f.sendHook(async()=>new Promise(()=>{}));const result=f.controller.start('Owner login');const rejected=expect(result).rejects.toThrow('Native owner handoff unavailable');await vi.advanceTimersByTimeAsync(10001);await rejected;}finally{vi.useRealTimers();}
});
it('private provider exception text is replaced with a stable controller failure',async()=>{
 const f=fixture();f.sendHook(async()=>{throw Error('FICTIONAL_PRIVATE_PROVIDER_BEARER');});await expect(f.controller.start('Owner login')).rejects.toThrow(/^Native owner handoff unavailable$/);
});
