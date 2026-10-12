import {browserBoundedText,BrowserBodyError} from './browser-bounded-body';
import {pageHeading,resultCard,standalonePage} from './standalone-page';
export const BROWSER_HANDOFF_PATH='/console/browser-handoff';
const headers={'content-type':'text/html; charset=utf-8','cache-control':'private, no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; frame-src https://live.browser.run; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"};
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
type Status={state:string;origin:string;reason:string;expiresAt:number};
export async function browserHandoffConsole(request:Request,options:Readonly<{
 csrf:string;ownerScope:string;limiter?:{limit(input:{key:string}):Promise<{success:boolean}>};
 assertConsole():Promise<void>;status():Promise<Status|undefined>;open():Promise<string>;cancel():Promise<void>;
}>):Promise<Response>{
 const reply=(body:string,status=200)=>new Response(body,{status,headers});
 // Every outcome keeps its status code and reads as the same private utility page.
 const state=(title:string,copy:string,status:number,tone:'neutral'|'negative'='negative')=>reply(standalonePage({title:'Browser sign-in · Waldo',layout:'card',home:true,body:resultCard({tone,title,body:`<p>${escape(copy)}</p>`,actions:'<a class="button-link" href="/console">Back to dashboard</a>'})}),status);
 if(request.method!=='GET'&&request.method!=='POST')return state('Method not allowed.','Open this page from your Waldo dashboard.',405);
 try{
  await options.assertConsole();
  let live:string|undefined;
  if(request.method==='POST'){
   if(request.headers.get('origin')!==new URL(request.url).origin)return state('Request rejected.','This request did not come from your Waldo console. Nothing was opened.',403);
   if(request.headers.get('content-type')?.split(';')[0]?.trim()!=='application/x-www-form-urlencoded')return state('Request rejected.','Use the buttons on the browser sign-in page. Nothing was opened.',415);
   const form=new URLSearchParams(await browserBoundedText(request));await options.assertConsole();
   if(form.getAll('csrf').length!==1||form.get('csrf')!==options.csrf||form.getAll('action').length!==1||[...form.keys()].some(k=>k!=='csrf'&&k!=='action'))return state('Request rejected.','This form could not be verified. Reload the browser sign-in page and try again. Nothing was opened.',403);
   if(form.get('action')!=='open'&&form.get('action')!=='cancel')return state('Request rejected.','That action is not available here. Nothing was opened.',400);
   if(!options.limiter||!(await options.limiter.limit({key:`browser-handoff:${options.ownerScope}`})).success)return state('Please try again later.','Too many browser sign-in requests in a short time. Wait a little, then reload this page.',429,'neutral');
   await options.assertConsole();
   if(form.get('action')==='cancel'){await options.cancel();await options.assertConsole();return state('Browser session closed.','The browser session was closed. Send Waldo a new message when you want to continue.',200,'neutral');}
   live=await options.open();await options.assertConsole();
  }
  const status=await options.status();await options.assertConsole();
  if(!status)return state('No sign-in is waiting.','No owner browser sign-in is waiting. Waldo asks here when a site needs you to sign in.',409,'neutral');
  const form=(action:string,label:string,kind:string)=>`<form method="post" action="${BROWSER_HANDOFF_PATH}"><input type="hidden" name="csrf" value="${escape(options.csrf)}"><button class="${kind}" name="action" value="${action}">${label}</button></form>`;
  const context=`<section class="tile" aria-labelledby="request-heading"><h2 id="request-heading">Sign-in request</h2><dl class="facts"><dt>Requested at</dt><dd>${escape(status.origin)}</dd><dt>Reason</dt><dd>${escape(status.reason)}</dd></dl><p class="notice" role="note">Check the actual address in the provider viewer before entering credentials. Legitimate identity providers may redirect to another origin.</p></section>`;
  const viewer=live?`<section class="tile" aria-label="Provider sign-in viewer"><iframe class="viewer" title="Cloudflare browser sign-in" src="${escape(live)}" referrerpolicy="no-referrer"></iframe></section>`:`<section class="tile"><h2>Open the browser</h2><p>Opening starts a private Cloudflare browser for this sign-in. Nothing opens until you press the button.</p><div class="actions">${form('open','Open Cloudflare browser','primary')}</div></section>`;
  const close=`<section class="tile"><h2>When you finish</h2><p>Use the provider Done control, then send Waldo a new message to resume and verify the intended account. Done does not promise to disconnect an already connected viewer. Closing the browser below terminates the session.</p><div class="actions">${form('cancel','Close browser session','danger')}</div></section>`;
  return reply(standalonePage({title:'Browser sign-in · Waldo',body:`${pageHeading('Owner browser sign-in','Waldo’s browser is waiting for you to sign in yourself.')}${context}${viewer}${close}`}));
 }catch(cause){return state('Browser sign-in unavailable.','Your session may have expired or the browser is not available right now. Reload this page from your dashboard.',cause instanceof BrowserBodyError?cause.status:409);}
}
