// Synthetic provider fixture. Sessions/pages outlive caller instances; no network is issued.
import type { CloudflareBrowserSdkLoader } from '../../src/channels/public-fixture-browser';
export const commonBrowserFixture={expiresAt:Date.now()+60000,allocations:0,attachments:0,ends:0,onTerminate:undefined as undefined|(()=>void|Promise<void>),onAcquire:undefined as undefined|(()=>void|Promise<void>),pages:[] as any[],reset(){this.expiresAt=Date.now()+60000;this.allocations=0;this.attachments=0;this.ends=0;this.onAcquire=undefined;this.onTerminate=undefined;this.pages=[];}};
const image=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1cAAAAASUVORK5CYII='),x=>x.charCodeAt(0));
let ended=false;
const page=()=>{
 const id=`fixture-target-${commonBrowserFixture.pages.length}`;let url='about:blank';
 const p={id,url:()=>url,title:async()=>url.endsWith('/a')?'Public A':'Public B',setDefaultTimeout(){},
  goto:async(input:string)=>{url=input;return {status:()=>200};},
  evaluate:async()=>({url,title:url.endsWith('/a')?'Public A':'Public B',text:url.endsWith('/a')?'Option A costs 10 fictional tokens.':'Option B costs 20 fictional tokens.',width:1,height:1,scrollX:0,scrollY:0,elements:[]}),
  screenshot:async()=>image.slice(),close:async()=>{commonBrowserFixture.pages=commonBrowserFixture.pages.filter(row=>row!==p);}};
 commonBrowserFixture.pages.push(p);return p;
};
const context={pages:()=>commonBrowserFixture.pages.slice(),newPage:async()=>page(),route:async()=>{},unroute:async()=>{},newCDPSession:async(p:any)=>({send:async()=>({targetInfo:{targetId:p.id}}),detach:async()=>{}})};
export const commonBrowserFixtureLoader:CloudflareBrowserSdkLoader=async()=>({
 acquire:async()=>{ended=false;commonBrowserFixture.allocations++;if(!commonBrowserFixture.pages.length)page();await commonBrowserFixture.onAcquire?.();return {sessionId:'fixture-retained-provider'};},
 connect:async()=>{if(ended)throw Error('fixture session ended');commonBrowserFixture.attachments++;return {contexts:()=>[context],close:async()=>{},newBrowserCDPSession:async()=>({send:async()=>{await commonBrowserFixture.onTerminate?.();ended=true;commonBrowserFixture.ends++;}})};},
 sessions:async()=>ended?[]:[{sessionId:'fixture-retained-provider'}],endpointURLString:()=>'',
} as never);

// Provider-shaped transport fixture: unlike the original in-memory SDK, every
// acquire, attach and sessions call crosses the host's real binding wrapper.
export const commonBrowserMeteredFixtureLoader:CloudflareBrowserSdkLoader=async()=>{
 const sdk=await commonBrowserFixtureLoader();
 return {...sdk,
  acquire:async(binding:any,options:any)=>{await binding.fetch(`http://fake.host/v1/devtools/browser?keep_alive=${options.keep_alive}`,{method:'POST'});return sdk.acquire(binding,options);},
  connect:async(binding:any,options:any)=>{await binding.fetch(`http://fake.host/v1/devtools/browser/${options.sessionId}?persistent=true`,{headers:{upgrade:'websocket'}});return sdk.connect(binding,options);},
  sessions:async(binding:any)=>{await binding.fetch('http://fake.host/v1/sessions');return sdk.sessions(binding);},
 } as never;
};
