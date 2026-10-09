import {expect,it} from 'vitest';
import {cloudflareGeneralBrowser} from '../src/channels/cloudflare-general-browser';
import {commonBrowserFixture,commonBrowserFixtureLoader} from './fixtures/common-browser-sdk';
import type {BrowserSession} from '@waldo/contracts';
async function fixture(){
 commonBrowserFixture.reset();const sdk=await commonBrowserFixtureLoader();await sdk.acquire({} as never,{} as never);
 const session={id:'upload-session',ownerId:'owner',provider:'cloudflare_playwright',providerSessionId:'fixture-retained-provider',contextHandle:null,mode:'public',state:'active',generation:1,expiresAt:Date.now()+300,updatedAt:Date.now()} as BrowserSession;
 const driver=cloudflareGeneralBrowser({ownerId:'owner',binding:{} as never,loadSdk:async()=>sdk,publicRead:true,retainConnection:true,now:Date.now,deadline:()=>session.expiresAt,admit:async()=>{},authorizeRequest:async()=>true,maxScreenshotBytes:1024});
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
