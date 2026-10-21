import {browserBoundedText,BrowserBodyError} from './browser-bounded-body';
export const BROWSER_HANDOFF_PATH='/console/browser-handoff';
const headers={'content-type':'text/html; charset=utf-8','cache-control':'private, no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; frame-src https://live.browser.run; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"};
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
type Status={state:string;origin:string;reason:string;expiresAt:number};
export async function browserHandoffConsole(request:Request,options:Readonly<{
 csrf:string;ownerScope:string;limiter?:{limit(input:{key:string}):Promise<{success:boolean}>};
 assertConsole():Promise<void>;status():Promise<Status|undefined>;open():Promise<string>;cancel():Promise<void>;
}>):Promise<Response>{
 const reply=(body:string,status=200)=>new Response(body,{status,headers});
 if(request.method!=='GET'&&request.method!=='POST')return reply('Method not allowed.',405);
 try{
  await options.assertConsole();
  let live:string|undefined;
  if(request.method==='POST'){
   if(request.headers.get('origin')!==new URL(request.url).origin)return reply('Origin rejected.',403);
   if(request.headers.get('content-type')?.split(';')[0]?.trim()!=='application/x-www-form-urlencoded')return reply('Form required.',415);
   const form=new URLSearchParams(await browserBoundedText(request));await options.assertConsole();
   if(form.getAll('csrf').length!==1||form.get('csrf')!==options.csrf||form.getAll('action').length!==1||[...form.keys()].some(k=>k!=='csrf'&&k!=='action'))return reply('Form rejected.',403);
   if(form.get('action')!=='open'&&form.get('action')!=='cancel')return reply('Action rejected.',400);
   if(!options.limiter||!(await options.limiter.limit({key:`browser-handoff:${options.ownerScope}`})).success)return reply('Please try again later.',429);
   await options.assertConsole();
   if(form.get('action')==='cancel'){await options.cancel();await options.assertConsole();return reply('Browser session closed.');}
   live=await options.open();await options.assertConsole();
  }
  const status=await options.status();await options.assertConsole();
  if(!status)return reply('No owner browser sign-in is waiting.',409);
  const form=(action:string,label:string)=>`<form method="post" action="${BROWSER_HANDOFF_PATH}"><input type="hidden" name="csrf" value="${escape(options.csrf)}"><button name="action" value="${action}">${label}</button></form>`;
  return reply(`<!doctype html><html><head><title>Browser sign-in</title></head><body><h1>Owner browser sign-in</h1><p>Requested at ${escape(status.origin)}</p><p>${escape(status.reason)}</p><p>Check the actual address in the provider viewer before entering credentials. Legitimate identity providers may redirect to another origin.</p>${live?`<iframe title="Cloudflare browser sign-in" src="${escape(live)}" referrerpolicy="no-referrer" style="width:100%;height:75vh"></iframe>`:form('open','Open Cloudflare browser')}<p>Use the provider Done control, then send Waldo a new message to resume and verify the intended account. Done does not promise to disconnect an already connected viewer. Closing the browser below terminates the session.</p>${form('cancel','Close browser session')}</body></html>`);
 }catch(cause){return reply('Browser sign-in unavailable.',cause instanceof BrowserBodyError?cause.status:409);}
}
