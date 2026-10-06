// @vitest-environment happy-dom
import {act,useEffect,useState} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {MemoryPanel} from './Memory';
import {response} from './memory-test-fixtures';

let root:Root,host:HTMLDivElement;
const requests:{url:string;options:RequestInit}[]=[];
function Harness(){
 const [hash,setHash]=useState(window.location.hash);
 useEffect(()=>{const listener=()=>setHash(window.location.hash);window.addEventListener('hashchange',listener);return()=>window.removeEventListener('hashchange',listener);},[]);
 return <MemoryPanel subview={hash.startsWith('#/memory/constellation')?'constellation':'spots'}/>;
}
const settle=async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});};
async function mount(hash:string){window.history.replaceState(null,'',hash);await act(async()=>root.render(<Harness/>));await settle();await toList();}
async function toList(){const toggle=Array.from(host.querySelectorAll('button')).find(b=>b.textContent?.trim()==='List');if(toggle){await act(async()=>toggle.click());await settle();}}
async function hashTo(hash:string){await act(async()=>{window.location.hash=hash;});await settle();}
async function click(text:string){const element=Array.from(host.querySelectorAll('a,button')).find(e=>e.textContent?.trim()===text||e.querySelector('h2')?.textContent===text);expect(element).toBeDefined();await act(async()=>{(element as HTMLElement).click();});await settle();}
const readUrls=()=>requests.filter(r=>r.url.startsWith('/console/dashboard/api/v1/memory?')).map(r=>r.url);
// The graph view also reads the patterns page to draw beside the Spots; only Spots-list reads are counted here.
const spotReads=()=>readUrls().filter(url=>url.includes('view=claims'));
const assertReadOnly=()=>{expect(requests.every(r=>!r.options.method||r.options.method==='GET')).toBe(true);expect(requests.every(r=>r.options.credentials==='same-origin'&&r.options.cache==='no-store')).toBe(true);};
beforeEach(()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);requests.length=0;
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
 vi.stubGlobal('fetch',vi.fn(async(url:string,options:RequestInit)=>{
  requests.push({url,options});const p=new URL(url,'http://localhost').searchParams;
  if(url.includes('/memory-controls?'))return new Response(JSON.stringify({version:1,view:'memory',state:'available',csrf:'fixture',revision:'a'.repeat(64),data:{id:p.get('id'),status:'active',review:{label:'Current item',note:'Synthetic'},actions:[]}}));
  const data=response(p.toString());
  if('page' in data)return new Response(JSON.stringify({...data,page:{...data.page,total:2,next_cursor:p.has('cursor')?null:'page-two'}}));
  if('expand' in data)return new Response(JSON.stringify({...data,expand:{...data.expand,next_cursor:p.has('cursor')?null:'graph-two'}}));
  return new Response(JSON.stringify(data));
 }));
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
describe('mounted Memory read navigation',()=>{
 it('keeps next-page, detail and back links on the originating page, including remount',async()=>{
  await mount('#/memory/spots');await click('Next page');expect(window.location.hash).toBe('#/memory/spots?cursor=page-two');
  await click('<script>claim</script>');expect(window.location.hash).toContain('returnCursor=page-two');
  expect(host.textContent).toContain('Saved Spot');await click('← Back to Spots');expect(window.location.hash).toBe('#/memory/spots?cursor=page-two');
  await act(async()=>root.unmount());root=createRoot(host);await act(async()=>root.render(<Harness/>));await settle();
  expect(spotReads().at(-1)).toContain('cursor=page-two');assertReadOnly();
 });
 it('handles backward and forward history through hashchange without writes',async()=>{
  await mount('#/memory/spots');await hashTo('#/memory/spots?cursor=page-two');
  await act(async()=>window.history.back());await settle();expect(window.location.hash).toBe('#/memory/spots');expect(readUrls().at(-1)).not.toContain('cursor=');
  await act(async()=>window.history.forward());await settle();expect(window.location.hash).toContain('cursor=page-two');expect(readUrls().at(-1)).toContain('cursor=page-two');assertReadOnly();
 });
 it('persists graph expansion cursor and returns to the originating pattern list',async()=>{
  await mount('#/memory/constellation?cursor=list-two');await click('Pattern A');await click('Explore saved connections');
  expect(window.location.hash).toContain('returnCursor=list-two');
  const next=Array.from(host.querySelectorAll('button')).find(e=>e.textContent?.includes('Expand')||e.textContent?.includes('Next'));
  expect(next).toBeDefined();await act(async()=>next!.click());await settle();
  expect(window.location.hash).toContain('cursor=graph-two');expect(readUrls().some(url=>url.includes('view=pattern')&&url.includes('cursor=graph-two'))).toBe(true);
  await click('← Back to pattern details');await click('← Back to patterns');expect(window.location.hash).toBe('#/memory/constellation?cursor=list-two');assertReadOnly();
 });
 it('requests nothing for invalid links and recovers through the visible list link',async()=>{
  await mount('#/memory/spots?id=1&owner=other');expect(host.textContent).toContain('Memory link unavailable');expect(requests).toEqual([]);
  await click('Return to Spots');expect(spotReads()).toEqual(['/console/dashboard/api/v1/memory?view=claims&limit=25']);assertReadOnly();
 });
 it.each([401,503])('aborts and ignores a stale %s response after navigation',async(status)=>{
  let resolve!:(value:Response)=>void;const pending=new Promise<Response>(done=>{resolve=done;});
  const original=globalThis.fetch;
  vi.stubGlobal('fetch',vi.fn((url:string,options:RequestInit)=>{
   if(url.includes('cursor=slow')){requests.push({url,options});return pending;}return original(url,options);
  }));
  await mount('#/memory/spots?cursor=slow');const old=requests[0]!;
  await hashTo('#/memory/spots');expect(old.options.signal?.aborted).toBe(true);
  await act(async()=>resolve(new Response('{"error":"memory_unavailable"}',{status})));await settle();
  expect(host.textContent).toContain('<script>claim</script>');expect(host.textContent).not.toContain('Memory unavailable.');expect(host.querySelector('a[href="/console/signin"]')).toBeNull();assertReadOnly();
 });
 it('restarts an invalid cursor with exactly one first-page read',async()=>{
  const original=globalThis.fetch;vi.stubGlobal('fetch',vi.fn((url:string,options:RequestInit)=>{
   if(url.includes('cursor=expired')){requests.push({url,options});return Promise.resolve(new Response('{"error":"cursor_invalid"}',{status:400}));}return original(url,options);
  }));
  await mount('#/memory/spots?cursor=expired');expect(host.textContent).toContain('Restart list');const before=readUrls().length;
  await click('Restart list');expect(window.location.hash).toBe('#/memory/spots');expect(readUrls().slice(before).filter(url=>url.includes('view=claims'))).toEqual(['/console/dashboard/api/v1/memory?view=claims&limit=25']);assertReadOnly();
 });
 it('preserves cross-view list origin on a failed detail read',async()=>{
  const original=globalThis.fetch;vi.stubGlobal('fetch',vi.fn((url:string,options:RequestInit)=>url.includes('view=detail')?Promise.resolve(new Response('{"error":"not_found"}',{status:404})):original(url,options)));
  await mount('#/memory/constellation?id=synthetic-owner%3Anode%3A1&returnView=spots&returnCursor=page-two');
  expect(host.textContent).toContain('Memory unavailable.');await click('Back to list');expect(window.location.hash).toBe('#/memory/spots?cursor=page-two');assertReadOnly();
 });
 it.each([401,503])('shows truthful current %s recovery without launching a write',async(status)=>{
  vi.stubGlobal('fetch',vi.fn(async(url:string,options:RequestInit)=>{requests.push({url,options});return new Response('{"error":"memory_unavailable"}',{status});}));
  await mount('#/memory/spots');expect(host.textContent).toContain('Memory unavailable.');
  if(status===401)expect(host.querySelector('a[href="/console/signin"]')).not.toBeNull();else expect(host.textContent).toContain('Retry read');assertReadOnly();
 });
});
