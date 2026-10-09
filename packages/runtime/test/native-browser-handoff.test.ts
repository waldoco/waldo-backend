import {expect,it} from 'vitest';
import {nativeBrowserHandoff} from '../src/channels/native-browser-handoff';
function fixture(){
 let listener:((event:any)=>void)|undefined,active=true,calls=0,hook:(()=>Promise<void>)|undefined;
 const commands:string[]=[];
 const cdp={on:(_event:string,fn:any)=>{listener=fn;},off:()=>{listener=undefined;},detach:async()=>{},send:async(method:string)=>{commands.push(method);if(method==='Target.getTargetInfo')return {targetInfo:{targetId:'tab',url:'https://account.fixture.invalid:8443/login'}};if(method==='Cloudflare.getSessionId')return {sessionId:'session'};if(method==='Cloudflare.handoff'){expect(listener).toBeDefined();return {targetId:'tab',handoffId:'handoff'};}if(method==='Cloudflare.getHandoffState')return {active,handoffId:'handoff'};if(method==='Cloudflare.getLiveView')return {id:'tab',devtoolsFrontendUrl:'https://live.browser.run/ui/view?mode=tab&wss=fictional'};throw Error('unexpected');}};
 const controller=nativeBrowserHandoff({cdp:cdp as never,providerSessionId:'session',targetId:'tab',expiresAt:Date.now()+60000,now:Date.now,assertCustody:async()=>{calls++;await hook?.();}});
 return {controller,commands,emit:(success:boolean,id='handoff')=>{active=false;listener?.({targetId:'tab',handoffId:id,success});},setHook:(fn:()=>Promise<void>)=>{hook=fn;},calls:()=>calls};
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
