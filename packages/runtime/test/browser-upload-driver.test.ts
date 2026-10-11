import {expect,it} from 'vitest';
import {cloudflareGeneralBrowser} from '../src/channels/cloudflare-general-browser';
import {commonBrowserFixture,commonBrowserFixtureLoader} from './fixtures/common-browser-sdk';
import type {BrowserSession} from '@waldo/contracts';
import {generalDigest} from '../src/channels/general-browser-observation';
async function fixture(options:{ttl?:number;admit?:()=>Promise<void>}={}){
 commonBrowserFixture.reset();const sdk=await commonBrowserFixtureLoader();await sdk.acquire({} as never,{} as never);
 const session={id:'upload-session',ownerId:'owner',provider:'cloudflare_playwright',providerSessionId:'fixture-retained-provider',contextHandle:null,mode:'public',state:'active',generation:1,expiresAt:Date.now()+(options.ttl??300),updatedAt:Date.now()} as BrowserSession;
 const driver=cloudflareGeneralBrowser({ownerId:'owner',binding:{} as never,loadSdk:async()=>sdk,publicRead:true,retainConnection:true,now:Date.now,deadline:()=>session.expiresAt,admit:options.admit??(async()=>{}),authorizeRequest:async()=>true,maxScreenshotBytes:1024});
 await driver.navigate(session,'https://public-pages.fixture.invalid/a');
 const page=commonBrowserFixture.pages[0],evaluate=page.evaluate;let changed=false,onInputValidation:(()=>void)|undefined;
 page.evaluate=async()=>{const result=await evaluate();return {...result,...(changed?{text:'changed document'}:{}),elements:result.elements.map((element:any)=>element.type==='file'?{...element,inForm:true,formAction:'https://public-pages.fixture.invalid/upload',formMethod:'post'}:element)};};
 const locator=page.locator;page.locator=(selector:string)=>{const target=locator(selector);return {...target,elementHandle:async()=>({...target,evaluate:async()=>{onInputValidation?.();return !changed;},dispose:async()=>{}})};};
 const snapshot=await driver.observe(session),reference=snapshot.observation.elements.find(element=>element.name==='Document')!.ref;
 const file={name:'report.csv',mimeType:'text/csv',buffer:new TextEncoder().encode('fictional')};
 return {driver,session,snapshot,reference,file,change:()=>{changed=true;},onValidation:(work:()=>void)=>{onInputValidation=work;}};
}
it('concurrent uploads cannot replace the winning approval authority before input exposure',async()=>{
 const f=await fixture();let revoked=false;
 const first=f.driver.upload(f.session,f.snapshot,f.reference,f.file,{destination:'https://public-pages.fixture.invalid/upload',expiresAt:f.session.expiresAt,assertCurrent:async()=>{if(revoked)throw Error('winning owner revoked');}},async()=>{revoked=true;});
 const second=f.driver.upload(f.session,f.snapshot,f.reference,{...f.file,name:'other.csv'},{destination:'https://public-pages.fixture.invalid/upload',expiresAt:f.session.expiresAt,assertCurrent:async()=>{}},async()=>{});
 const outcomes=await Promise.allSettled([first,second]);expect(outcomes.every(result=>result.status==='rejected')).toBe(true);expect(commonBrowserFixture.uploads).toBe(0);await f.driver.disconnect();
},1000);
it('a document change during the exposure checkpoint cannot receive approved bytes',async()=>{
 const f=await fixture();await expect(f.driver.upload(f.session,f.snapshot,f.reference,f.file,{destination:'https://public-pages.fixture.invalid/upload',expiresAt:f.session.expiresAt,assertCurrent:async()=>{}},async()=>{f.change();})).rejects.toThrow();expect(commonBrowserFixture.uploads).toBe(0);await f.driver.disconnect();
},1000);

it('owner revocation during final native node validation cannot expose file bytes',async()=>{
 const f=await fixture();let owner=true;f.onValidation(()=>{owner=false;});
 await expect(f.driver.upload(f.session,f.snapshot,f.reference,f.file,{destination:'https://public-pages.fixture.invalid/upload',expiresAt:f.session.expiresAt,assertCurrent:async()=>{if(!owner)throw Error('owner revoked');}},async()=>{})).rejects.toThrow();expect(commonBrowserFixture.uploads).toBe(0);await f.driver.disconnect();
},1000);

const DESTINATION='https://public-pages.fixture.invalid/upload';
// A route double for the context-level interception the driver installs.
function post(page:unknown,url:string,body:unknown,contentType='application/json'){
 const route={fetches:[] as unknown[],fulfilled:0,aborted:0,
  request:()=>({method:()=>'POST',url:()=>url,frame:()=>({parentFrame:()=>null,page:()=>page}),isNavigationRequest:()=>false}),
  fetch:async(options:unknown)=>{route.fetches.push(options);return {status:()=>200,headers:()=>({'content-type':contentType}),body:async()=>new TextEncoder().encode(typeof body==='string'?body:JSON.stringify(body))};},
  fulfill:async()=>{route.fulfilled++;},abort:async()=>{route.aborted++;}};
 return route;
}
async function exposed(f:Awaited<ReturnType<typeof fixture>>,custody:()=>boolean){
 const pending=f.driver.upload(f.session,f.snapshot,f.reference,f.file,{destination:DESTINATION,expiresAt:f.session.expiresAt,assertCurrent:async()=>{if(!custody())throw Error('upload custody ended');}},async()=>{});
 void pending.catch(()=>{});
 for(let tick=0;tick<200&&commonBrowserFixture.uploads<1;tick++)await new Promise(resolve=>setTimeout(resolve,5));
 expect(commonBrowserFixture.uploads).toBe(1);
 return {pending};
}

it('the approved POST is the only one: it is fetched without redirects, and its receipt must echo name, size and sha256',async()=>{
 const f=await fixture({ttl:5000}),page=commonBrowserFixture.pages[0];
 const {pending}=await exposed(f,()=>true);
 const elsewhere=post(page,'https://public-pages.fixture.invalid/other',{});await commonBrowserFixture.route!(elsewhere);
 expect(elsewhere.fetches).toHaveLength(0);expect(elsewhere.aborted).toBe(1);
 const sha256=await generalDigest(f.file.buffer),approved=post(page,DESTINATION,{filename:'report.csv',byte_size:f.file.buffer.length,sha256});
 await commonBrowserFixture.route!(approved);
 expect(await pending).toEqual({filename:'report.csv',mime:'text/csv',byte_size:f.file.buffer.length,sha256});
 expect(approved.fetches).toEqual([expect.objectContaining({maxRedirects:0,maxRetries:0})]);expect(approved.fulfilled).toBe(1);
 const again=post(page,DESTINATION,{filename:'report.csv',byte_size:f.file.buffer.length,sha256});await commonBrowserFixture.route!(again);
 expect(again.fetches).toHaveLength(0);expect(again.aborted).toBe(1);
 await f.driver.disconnect();
},5000);

it('two POSTs fired together while the upload is in flight reach the server once',async()=>{
 const f=await fixture({ttl:5000}),page=commonBrowserFixture.pages[0];
 const {pending}=await exposed(f,()=>true);
 const receipt={filename:'report.csv',byte_size:f.file.buffer.length,sha256:await generalDigest(f.file.buffer)};
 const first=post(page,DESTINATION,receipt),second=post(page,DESTINATION,receipt);
 await Promise.all([commonBrowserFixture.route!(first),commonBrowserFixture.route!(second)]);
 expect(first.fetches.length+second.fetches.length).toBe(1);expect(first.aborted+second.aborted).toBe(1);
 await pending;await f.driver.disconnect();
},5000);

it.each([
 ['a different sha256',async(f:Awaited<ReturnType<typeof fixture>>)=>({filename:'report.csv',byte_size:f.file.buffer.length,sha256:'0'.repeat(64)}),'application/json'],
 ['a different filename',async(f:Awaited<ReturnType<typeof fixture>>)=>({filename:'other.csv',byte_size:f.file.buffer.length,sha256:await generalDigest(f.file.buffer)}),'application/json'],
 ['a non-JSON answer',async(f:Awaited<ReturnType<typeof fixture>>)=>({filename:'report.csv',byte_size:f.file.buffer.length,sha256:await generalDigest(f.file.buffer)}),'text/html'],
] as const)('a server answer with %s is not a receipt',async(_label,body,contentType)=>{
 const f=await fixture({ttl:5000});
 const {pending}=await exposed(f,()=>true);
 await commonBrowserFixture.route!(post(commonBrowserFixture.pages[0],DESTINATION,await body(f),contentType));
 await expect(pending).rejects.toThrow();await f.driver.disconnect();
},5000);

it('after the upload settles the session answers to the run again, and stays on the upload origin',async()=>{
 let runOpen=true,custody=true;
 const f=await fixture({ttl:5000,admit:async()=>{if(!runOpen)throw Error('run closed');}}),page=commonBrowserFixture.pages[0];
 const {pending}=await exposed(f,()=>custody);
 await commonBrowserFixture.route!(post(page,DESTINATION,{filename:'report.csv',byte_size:f.file.buffer.length,sha256:await generalDigest(f.file.buffer)}));
 await pending;
 custody=false;
 await expect(f.driver.observe(f.session)).resolves.toMatchObject({observation:expect.anything()});
 await expect(f.driver.navigate(f.session,'https://elsewhere.fixture.invalid/a')).rejects.toThrow();
 runOpen=false;
 await expect(f.driver.observe(f.session)).rejects.toThrow();
 await f.driver.disconnect();
},5000);

it('a refusal before the file reaches the page leaves no upload authority behind',async()=>{
 let runOpen=true;
 const f=await fixture({ttl:5000,admit:async()=>{if(!runOpen)throw Error('run closed');}});
 await expect(f.driver.upload(f.session,f.snapshot,f.reference,f.file,{destination:DESTINATION,expiresAt:f.session.expiresAt,assertCurrent:async()=>{throw Error('custody gone');}},async()=>{})).rejects.toThrow();
 expect(commonBrowserFixture.uploads).toBe(0);
 // No bytes reached the page, so no origin fence or upload custody remains.
 await expect(f.driver.navigate(f.session,'https://elsewhere.fixture.invalid/a')).resolves.toBeTruthy();
 runOpen=false;
 await expect(f.driver.navigate(f.session,'https://public-pages.fixture.invalid/a')).rejects.toThrow();
 await f.driver.disconnect();
},5000);

it('a sign-in handoff cannot reopen the session to other origins once a file reached the page',async()=>{
 const control=await fixture({ttl:5000});
 const handoff=await control.driver.beginOwnerHandoff(control.session,await control.driver.observe(control.session),'Sign in',async()=>{});
 expect(handoff).toBeTruthy();await control.driver.disconnect();
 const f=await fixture({ttl:5000}),page=commonBrowserFixture.pages[0];
 const {pending}=await exposed(f,()=>true);
 await commonBrowserFixture.route!(post(page,DESTINATION,{filename:'report.csv',byte_size:f.file.buffer.length,sha256:await generalDigest(f.file.buffer)}));
 await pending;
 await expect(f.driver.beginOwnerHandoff(f.session,await f.driver.observe(f.session),'Sign in',async()=>{})).rejects.toThrow();
 await f.driver.disconnect();
},5000);

it('once the upload settles, its approval expiry no longer bounds the session',async()=>{
 const f=await fixture({ttl:5000}),page=commonBrowserFixture.pages[0];
 const pending=f.driver.upload(f.session,f.snapshot,f.reference,f.file,{destination:DESTINATION,expiresAt:Date.now()+300,assertCurrent:async()=>{}},async()=>{});
 for(let tick=0;tick<200&&commonBrowserFixture.uploads<1;tick++)await new Promise(resolve=>setTimeout(resolve,5));
 await commonBrowserFixture.route!(post(page,DESTINATION,{filename:'report.csv',byte_size:f.file.buffer.length,sha256:await generalDigest(f.file.buffer)}));
 await pending;
 await new Promise(resolve=>setTimeout(resolve,350));
 await expect(f.driver.observe(f.session)).resolves.toMatchObject({observation:expect.anything()});
 await f.driver.disconnect();
},5000);
