import {parseConsoleAction,NOTICES,consoleMayApprove,waitingMaySend,CONSOLE_GOOGLE_START_PATH,type ConsoleAction,type ConsoleView} from './console';
import {HANDOFF_PARAM} from './connect-confirm';
import type {ApprovalDecision} from './approvals';
import {DASHBOARD_OVERVIEW_HEADERS} from './dashboard-overview';
export const CONTROL_ACTION_PATH='/console/dashboard/api/v1/actions';
type Projection=Readonly<{view:string;csrf:string;data:unknown}>;
export type ControlReceipt=Readonly<{state:'recorded'|'incomplete'|'rejected'|'unconfirmed';message:string;navigation?:string; signed_out?:boolean}>;
// A code or challenge the owner must copy goes back in that one response: the receipt book keeps
// the receipt without it, so a replayed request never shows the value again.
export type ControlReveal=Readonly<{kind:'link_code'|'host_code'|'challenge'|'pairing_code';value:string;to?:string}>;
export type RevealingReceipt=Readonly<{receipt:ControlReceipt;reveal:ControlReveal}>;
export type StoredReceipt=Readonly<{fingerprint:string;status:number;receipt:ControlReceipt;expires:number;kept_until?:number;approval_state?:string}>;
type Store=Readonly<{get<T>(key:string):Promise<T|undefined>;put(key:string,value:unknown):Promise<void>}>;
export const RECEIPT_BOOK_KEY='console:control-receipts';
// One receipt book per owner: rows live while their session does, but no longer than RECEIPT_RETENTION_MS after they
// were written, and a session's capacity is bounded. A console session lasts up to 30 days, so without that bound a busy
// session would fill its capacity and refuse changes for weeks.
export const RECEIPT_RETENTION_MS=12*60*60_000;
export async function loadReceiptBook(store:Store,sessions:()=>Promise<readonly {csrf:string;expires:number}[]>,key=RECEIPT_BOOK_KEY):Promise<Record<string,StoredReceipt>>{
 const book=await store.get<Record<string,StoredReceipt>>(key)??{};
 const live=new Map(await Promise.all((await sessions()).map(async session=>[await controlRevision(session.csrf),session.expires] as const)));
 for(const [id,row] of Object.entries(book)){const renewed=live.get(id.split(':')[0]!);if(renewed!==undefined&&renewed>row.expires)book[id]={...row,expires:Math.min(renewed,row.kept_until??renewed)};if((book[id]?.expires??0)<Date.now())delete book[id];}
 return book;
}
export const receiptCapacityReached=(book:Readonly<Record<string,StoredReceipt>>,session:string)=>Object.keys(book).filter(id=>id.startsWith(session+':')).length>=100||Object.keys(book).length>=1000;
// view() is read only for views that do not list their own actions. book names the caller's receipt book (default: the shared one).
export type ControlActionDeps=Readonly<{csrf:string;expires:number;sessions():Promise<readonly {csrf:string;expires:number}[]>;projection(view:string,id?:string):Promise<Projection|null>;view?():Promise<ConsoleView>;act(action:ConsoleAction,fields:Readonly<Record<string,string>>):Promise<boolean|string|ControlReceipt|RevealingReceipt>;store:Store;book?:string}>;
export const CONTROL_VIEW_ACTIONS:Readonly<Record<string,readonly string[]>>={memory:['spot.confirm','spot.dismiss','spot.forget','node.forget'],day:['timezone.set','proactivity.set','proactive_surface.set','health_memory.set','card.today','card.pin','card.unpin'],connections:['google.connect','google.disconnect','telegram.link','telegram.unlink','whatsapp.link','whatsapp.unlink','session.signout','session.signout.all','session.revoke','mcp.connect','mcp.disconnect','mcp.runs'],waiting:['approval.approve','approval.send','approval.edit','approval.skip','approval.undo'],files:['file.remove'],
 imessage:['imessage.enroll','imessage.link','imessage.unlink','imessage.pair','imessage.pair_shared','imessage.verify','imessage.activate','imessage.activate_shared','imessage.revoke'],devices:['device.pair','device.revoke','device.query','device.notify']};
// Fields a view's actions carry beyond the console action. They are fingerprinted with it.
const viewFields:Readonly<Record<string,readonly string[]>>={imessage:['subject','chat','phone'],devices:['query_kind','body','severity']};
// These views list every action their read offers, at the top level (no id) or on the row it
// targets. The fresh read's list is the eligibility check, so the console view is never built.
const listedRows:Readonly<Record<string,string>>={imessage:'bridges',devices:'devices'};
const listedAction=(action:ConsoleAction,data:unknown,rows:string):boolean=>{
 const listing=data as Readonly<Record<string,unknown>>|null,has=(actions:unknown)=>Array.isArray(actions)&&actions.includes(action.action);
 if(action.id==='')return has(listing?.actions);
 const items=listing?.[rows];
 return Array.isArray(items)&&items.some((item:Readonly<{id?:unknown;actions?:unknown}>)=>item?.id===action.id&&has(item.actions));
};
const reply=(value:object,status=200)=>Response.json(value,{status,headers:DASHBOARD_OVERVIEW_HEADERS});
// A Google connect receipt carries one of this deployment's own start links and nothing else: the console's start path,
// which only the signed-in owner's browser can follow, or a /c/<ticket> link with the one-time handoff code that binds
// the browser the app opens it in.
const GOOGLE_STARTS=[new RegExp(`^${CONSOLE_GOOGLE_START_PATH}[A-Za-z0-9_-]{43}$`),new RegExp(`^/c/[A-Za-z0-9_-]{22}\\?${HANDOFF_PARAM}=[A-Za-z0-9_-]{22}$`)];
export const googleConnectReceipt=(link:string|null,origin:string|undefined):ControlReceipt=>{
 if(!link)return {state:'rejected',message:NOTICES['google.connect.failed']!};
 const destination=origin?new URL(link,origin):null;
 if(!destination||destination.origin!==origin||destination.hash||!GOOGLE_STARTS.some(start=>start.test(destination.pathname+destination.search)))return {state:'rejected',message:'Google connect returned an unavailable destination. Try again later.'};
 return {state:'recorded',message:'Google connect is ready to begin. Access has not been granted or tested.',navigation:destination.pathname+destination.search};
};
// An MCP connect either finished without sign-in or continues on this deployment's own start link,
// which redirects to the provider only for the signed-in owner. No other destination is ever returned.
const MCP_CONNECT_FAILURES:Readonly<Record<string,string>>={
 egress_scheme:'That address is not https. Use the server\'s https URL.',egress_host:'That address points at a private or internal network, which Waldo does not reach.',egress_port:'Waldo connects to servers on the standard https port only.',
 egress_credentials:'Remove the user name or password from the address.',egress_malformed:'That is not a web address.',query_string:'Remove the part after "?" from the address.',
 pkce_unsupported:'That server\'s sign-in does not support the secure flow (PKCE with S256) Waldo requires.',registration_unsupported:'That server does not let Waldo register as an app, so it cannot be connected yet.',
 oauth_unavailable:'Signing in to servers is not set up on this Waldo yet.',
};
export const mcpConnectReceipt=(result:Readonly<{kind:string;path?:string;name?:string;reason?:string}>):ControlReceipt=>{
 if(result.kind==='connected')return {state:'recorded',message:`Connected ${result.name}. It needed no sign-in. Its tools ask you first until you choose otherwise.`};
 if(result.kind==='already')return {state:'recorded',message:`${result.name} is already connected.`};
 if(result.kind==='redirect'&&result.path&&/^\/console\/mcp\/start\/[A-Za-z0-9_-]{43}$/.test(result.path))return {state:'recorded',message:'Sign in to the server to finish connecting. Nothing has been granted yet.',navigation:result.path};
 return {state:'rejected',message:MCP_CONNECT_FAILURES[result.reason??'']??'That server could not be connected. Check the address and try again.'};
};
// "tool|on|<digest>" or "tool|off". Allowing names the digest the console showed; taking a permission back needs none.
export const mcpRunsReceipt=async(id:string,value:string,setRuns:(id:string,tool:string,withoutAsking:boolean,seen?:string)=>Promise<boolean|'changed'>):Promise<ControlReceipt>=>{
 const [tool,choice,seen,...rest]=value.split('|');
 const valid=!!tool&&!rest.length&&(choice==='on'?/^[0-9a-f]{64}$/.test(seen??''):choice==='off'&&seen===undefined);
 if(!valid)return {state:'rejected',message:NOTICES.invalid!};
 const done=await setRuns(id,tool,choice==='on',choice==='on'?seen:undefined);
 if(done==='changed')return {state:'rejected',message:'That server changed its tools since this page loaded, so nothing was allowed. Refresh Connections and choose again.'};
 if(!done)return {state:'rejected',message:NOTICES.invalid!};
 const label=tool==='*read_only_hint'?'The tools labelled read-only':tool;
 return {state:'recorded',message:choice==='on'?`${label} run${tool==='*read_only_hint'?'':'s'} without asking.`:`${label} ask${tool==='*read_only_hint'?'':'s'} you first.`};
};
export const mcpDisconnectReceipt=(result:Readonly<{ok:boolean;provider:string}>):ControlReceipt=>!result.ok
 ?{state:'rejected',message:result.provider==='not_needed'?'That server is no longer connected. Refresh the records.':'The server was not disconnected because Waldo could not reach its sign-in service. Try again.'}
 :{state:'recorded',message:result.provider==='revoked'?'Disconnected, and the server revoked Waldo\'s access.':result.provider==='failed'||result.provider==='unsupported'?'Disconnected and forgotten by Waldo. The server did not confirm it revoked access; remove Waldo in that service\'s settings to be sure.':'Disconnected.'};
export const whatsappLinkReceipt=(code:string|null):ControlReceipt=>code
 ?{state:'recorded',message:`Send this to the Waldo WhatsApp number within 10 minutes: waldo ${code}`}
 :{state:'rejected',message:'Linking WhatsApp needs account sign-in, which is not configured on this server.'};
export const whatsappUnlinkReceipt=(done:boolean):ControlReceipt=>done
 ?{state:'recorded',message:'WhatsApp unlinked. New messages from that number no longer reach your Waldo, and Waldo will not message it.'}
 :{state:'rejected',message:'WhatsApp was not unlinked. Refresh the records and try again.'};
export async function controlRevision(value:unknown):Promise<string>{const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));return Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');}
function eligible(action:ConsoleAction,view:ConsoleView):boolean {
 if(action.action.startsWith('card.')){const card=view.cards.find(c=>c.id===action.id);return !!card&&(action.action==='card.unpin'?!!card.pin:!card.sent);}
 if(action.action==='google.connect')return view.google.connectAvailable;
 if(action.action==='google.disconnect')return view.google.accounts.some(a=>a.id===action.id);
 if(action.action==='telegram.unlink')return view.telegram.linked&&view.telegram.unlinkAvailable;
 if(action.action==='whatsapp.unlink')return view.whatsapp?.linked===true;
 if(action.action==='file.remove')return view.files.some(f=>String(f.id)===action.id);
 if(action.action==='session.revoke')return view.sessions.some(row=>row.ref!==undefined&&row.ref===action.value&&!row.current);
 if(action.action.startsWith('approval.')) {
  const p=view.approvals.find(p=>p.id===action.id);if(!p)return false;
  if(action.action==='approval.approve')return consoleMayApprove(p);
  if(action.action==='approval.send'||action.action==='approval.edit')return waitingMaySend(p);
  if(action.action==='approval.undo')return p.state==='done'&&p.undoable&&p.kind==='calendar_change';
  return consoleMayApprove(p)||(['email_send','message_send'].includes(p.kind)&&['open','review_only'].includes(p.state));
 }
 return true;
}
// Caller serializes this entire operation, with every other writer of the same book, inside the
// authenticated owner DO. CSRF, the current read revision and existing executor eligibility remain independent gates.
// A durable uncertain receipt prevents a duplicate request from re-running an effect.
export async function controlAction(form:FormData,deps:ControlActionDeps):Promise<Response>{
 const view=String(form.get('view')??''),extra=Object.hasOwn(viewFields,view)?viewFields[view]!:[];
 const fields=['csrf','action','id','value','quiet_start','quiet_end','volume','view','revision','request_id',...extra];
 if([...form.keys()].some(k=>!fields.includes(k)||form.getAll(k).length!==1)||[...form.values()].some(v=>typeof v!=='string'||v.length>4096))return reply({error:'invalid_action'},400);
 const action=parseConsoleAction(form,deps.csrf),requestId=String(form.get('request_id')??'');
 if(!action||!Object.hasOwn(CONTROL_VIEW_ACTIONS,view)||!CONTROL_VIEW_ACTIONS[view]!.includes(action.action))return reply({error:'invalid_action'},403);
 if(!/^[A-Za-z0-9_-]{8,80}$/.test(requestId))return reply({error:'request_id_required'},400);
 const values:Record<string,string>=Object.fromEntries(extra.flatMap(k=>form.has(k)?[[k,String(form.get(k))]]:[]));
 const fingerprint=await controlRevision(extra.length?{view,action,revision:form.get('revision'),fields:values}:{view,action,revision:form.get('revision')});
 const session=await controlRevision(deps.csrf),key=`${session}:${requestId}`,bookKey=deps.book??RECEIPT_BOOK_KEY;
 const book=await loadReceiptBook(deps.store,deps.sessions,bookKey);
 const prior=book[key];
 if(prior)return prior.fingerprint===fingerprint?reply({receipt:prior.receipt,duplicate:true},prior.status):reply({error:'request_reused'},409);
 if(receiptCapacityReached(book,session))return reply({error:'receipt_capacity',message:'This session has reached its change limit. Sign in again after this session expires; existing receipts remain available.'},429);
 const projection=await deps.projection(view,action.id);
 if(!projection)return reply({error:'unavailable'},503);
 if(await controlRevision(projection)!==form.get('revision'))return reply({error:'stale_read',message:'These records changed. Refresh and review again before applying a change.'},409);
 const rows=Object.hasOwn(listedRows,view)?listedRows[view]:undefined;
 if(rows?!listedAction(action,projection.data,rows):!deps.view||!eligible(action,await deps.view()))return reply({error:'no_longer_eligible',message:'This action is no longer available. Refresh the records.'},409);
 const kept_until=Date.now()+RECEIPT_RETENTION_MS,expires=Math.min(deps.expires,kept_until);
 const pending:StoredReceipt={fingerprint,expires,kept_until,status:503,receipt:{state:'unconfirmed',message:'The outcome is not confirmed. Refresh the records before attempting another change.'}};
 book[key]=pending;await deps.store.put(bookKey,book);
 let receipt:ControlReceipt,status=200,reveal:ControlReveal|undefined;
 try{
  const outcome=await deps.act(action,{...values,request_id:requestId});
  const result=typeof outcome==='object'&&'reveal' in outcome?(reveal=outcome.reveal,outcome.receipt):outcome;
  receipt=typeof result==='object'?result:typeof result==='string'?result===action.action?{state:'recorded',message:NOTICES[result]??'The change was recorded.'}:(result==='spot.forget.incomplete'||result==='node.forget.incomplete')?{state:'incomplete',message:NOTICES[result]!}:result==='invalid'||result.endsWith('.failed')?{state:'rejected',message:NOTICES[result]??'The change could not be applied.'}:pending.receipt:result?{state:'recorded',message:NOTICES[action.action]??'The change was recorded.'}:{state:'rejected',message:'That change could not be applied. Refresh the records and try again.'};
  if(receipt.state==='rejected')status=409;else if(receipt.state==='unconfirmed')status=503;
 }catch{receipt=pending.receipt;status=503;}
 book[key]={fingerprint,status,receipt,expires,kept_until};await deps.store.put(bookKey,book);
 return reply({receipt,duplicate:false,...(reveal&&receipt.state==='recorded'?{reveal}:{})},status);
}

// Fixed receipt text per decision outcome. The desk's own message is never echoed: it can carry
// provider errors or external tool output, and receipts reach surfaces that render them as given.
const APPROVAL_RECEIPT_TEXT:Readonly<Record<string,string>>={
 Done:'Done.',Sent:'Sent. This cannot be undone.','Already sent':'That exact message already went out once; nothing was sent twice.',Verified:'Done, and the result was verified.',Undone:'Undone.',
 'Not now':'Left it. Nothing changed.',Later:'Left it for later. It is still waiting, and it can still expire.','Tell me what to change':'Tell Waldo in the chat what to change.','Already handled.':'That was already handled.',
 'This proposal expired':'That proposal expired, so nothing happened. Ask again if you still want it.',Expired:'That request expired. Ask again.',
 'Google is not connected':'Google is not connected, so nothing happened.','The event changed':'The event changed after the proposal, so nothing was changed.',
 'The task changed':'The Google task changed after your review, so nothing was changed.','Nothing was changed':'Nothing was changed. Ask again to retry.',
 'Too late to undo':'The 10-minute undo window has passed, so it was left as it is.',"Can't be undone":'This cannot be undone from here. Nothing was reversed.',
 'Not available':'This approval cannot be applied here. Nothing was changed.','Not available here':'That approval was not shown in full here, so nothing was done.',
 'Review it in the app':'That approval was not shown in full here, so nothing was done.','Channel not connected':'That channel is not connected, so nothing was sent.',
 'Messaging is not set up':'Messaging is not set up, so nothing was sent.','Browsing is not set up':'Browsing is not set up, so nothing was done.','MCP is not set up':'MCP is not set up, so nothing ran.',
 'Email changed':'The stored email no longer matches what was approved, so nothing was sent.','Message changed':'The stored message no longer matches what was approved, so nothing was sent.','Key already used':'A different message already used this send key, so nothing was sent.',
 'Not done':'The browser action was not done.','Not sent':'Gmail refused the send, so nothing went out.','That failed':'That did not work. Nothing else ran.',
 'Nothing ran':'Nothing ran. The server did not carry out that call.','Call changed':'The stored call no longer matches what was approved, so nothing ran.',
 'Outcome unknown':'The operation outcome is unknown. Check the result before retrying; nothing was run again.',
 'Result not verified':'The result could not be verified. Check it before retrying.','Receipt not checked':'The result could not be verified. Check it before retrying.',
};
const APPROVAL_RECEIPT_FALLBACK:Readonly<Record<ControlReceipt['state'],string>>={recorded:'The decision was recorded.',incomplete:'The decision was only partly applied. Refresh the records.',
 rejected:'That decision was not carried out. Refresh the records and try again.',unconfirmed:'The proposal outcome could not be confirmed. Check the records and chat before retrying.'};
const approvalReceiptState=(out:ApprovalDecision):ControlReceipt['state']=>['Done','Undone','Not now','Later','Sent','Already sent','Verified','Tell me what to change'].includes(out.toast)?'recorded':out.toast==='Outcome unknown'?'unconfirmed'
 :['Already handled.','Nothing ran','Call changed','This proposal expired','Google is not connected','The event changed','The task changed','Nothing was changed','Too late to undo','Not available','Not available here','Review it in the app','Channel not connected',
  'Email changed','Message changed','Not sent','Key already used','Messaging is not set up'].includes(out.toast)?'rejected':'unconfirmed';
// The console derives the state from the decision; the app passes the state its status transition proved.
// A desk refusal the console treats as unconfirmed is still a definite "nothing was done" once the
// app's transition proves the row did not move; unknown outcomes never read as refusals.
export function approvalControlReceipt(out:ApprovalDecision,state=approvalReceiptState(out)):ControlReceipt {
 const natural=approvalReceiptState(out),unknown=['Outcome unknown','Result not verified','Receipt not checked'].includes(out.toast);
 const fits=natural===state||state==='rejected'&&natural==='unconfirmed'&&!unknown;
 return {state,message:fits?APPROVAL_RECEIPT_TEXT[out.toast]??APPROVAL_RECEIPT_FALLBACK[state]:APPROVAL_RECEIPT_FALLBACK[state]};
}
