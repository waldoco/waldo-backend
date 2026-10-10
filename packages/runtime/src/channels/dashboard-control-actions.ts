import {parseConsoleAction,NOTICES,consoleMayApprove,type ConsoleAction,type ConsoleView} from './console';
import type {ApprovalDecision} from './approvals';
import {DASHBOARD_OVERVIEW_HEADERS} from './dashboard-overview';
export const CONTROL_ACTION_PATH='/console/dashboard/api/v1/actions';
type Projection=Readonly<{view:string;csrf:string;data:unknown}>;
export type ControlReceipt=Readonly<{state:'recorded'|'incomplete'|'rejected'|'unconfirmed';message:string;navigation?:string; signed_out?:boolean}>;
export type StoredReceipt=Readonly<{fingerprint:string;status:number;receipt:ControlReceipt;expires:number;approval_state?:string}>;
type Store=Readonly<{get<T>(key:string):Promise<T|undefined>;put(key:string,value:unknown):Promise<void>}>;
export const RECEIPT_BOOK_KEY='console:control-receipts';
// One receipt book per owner: rows live while their session does, and a session's capacity is bounded.
export async function loadReceiptBook(store:Store,sessions:()=>Promise<readonly {csrf:string;expires:number}[]>):Promise<Record<string,StoredReceipt>>{
 const book=await store.get<Record<string,StoredReceipt>>(RECEIPT_BOOK_KEY)??{};
 const live=new Map(await Promise.all((await sessions()).map(async session=>[await controlRevision(session.csrf),session.expires] as const)));
 for(const [id,row] of Object.entries(book)){const renewed=live.get(id.split(':')[0]!);if(renewed!==undefined&&renewed>row.expires)book[id]={...row,expires:renewed};if((book[id]?.expires??0)<Date.now())delete book[id];}
 return book;
}
export const receiptCapacityReached=(book:Readonly<Record<string,StoredReceipt>>,session:string)=>Object.keys(book).filter(id=>id.startsWith(session+':')).length>=100||Object.keys(book).length>=1000;
export type ControlActionDeps=Readonly<{csrf:string;expires:number;sessions():Promise<readonly {csrf:string;expires:number}[]>;projection(view:string,id?:string):Promise<Projection|null>;view():Promise<ConsoleView>;act(action:ConsoleAction):Promise<boolean|string|ControlReceipt>;store:Store}>;
const allowed:Readonly<Record<string,readonly string[]>>={memory:['spot.confirm','spot.dismiss','spot.forget','node.forget'],day:['timezone.set','proactivity.set','card.today','card.pin','card.unpin'],connections:['google.connect','google.disconnect','telegram.link','telegram.unlink','session.signout','session.signout.all'],waiting:['approval.approve','approval.skip','approval.undo'],files:['file.remove']};
const reply=(value:object,status=200)=>Response.json(value,{status,headers:DASHBOARD_OVERVIEW_HEADERS});
export async function controlRevision(value:unknown):Promise<string>{const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));return Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');}
function eligible(action:ConsoleAction,view:ConsoleView):boolean {
 if(action.action.startsWith('card.')){const card=view.cards.find(c=>c.id===action.id);return !!card&&(action.action==='card.unpin'?!!card.pin:!card.sent);}
 if(action.action==='google.connect')return view.google.connectAvailable;
 if(action.action==='google.disconnect')return view.google.accounts.some(a=>a.id===action.id);
 if(action.action==='telegram.unlink')return view.telegram.linked&&view.telegram.unlinkAvailable;
 if(action.action==='session.signout.all')return view.sessionCount>1;
 if(action.action==='file.remove')return view.files.some(f=>String(f.id)===action.id);
 if(action.action.startsWith('approval.')) {
  const p=view.approvals.find(p=>p.id===action.id);if(!p)return false;
  if(action.action==='approval.approve')return consoleMayApprove(p);
  if(action.action==='approval.undo')return p.state==='done'&&p.undoable&&p.kind==='calendar_change';
  return consoleMayApprove(p)||(['email_send','message_send'].includes(p.kind)&&['open','review_only'].includes(p.state));
 }
 return true;
}
// Caller serializes this entire operation inside the authenticated owner DO. CSRF,
// the current read revision and existing executor eligibility remain independent gates.
// A durable uncertain receipt prevents a duplicate request from re-running an effect.
export async function controlAction(form:FormData,deps:ControlActionDeps):Promise<Response>{
 const fields=['csrf','action','id','value','quiet_start','quiet_end','volume','view','revision','request_id'];
 if([...form.keys()].some(k=>!fields.includes(k)||form.getAll(k).length!==1)||[...form.values()].some(v=>typeof v!=='string'||v.length>4096))return reply({error:'invalid_action'},400);
 const action=parseConsoleAction(form,deps.csrf),view=String(form.get('view')??''),requestId=String(form.get('request_id')??'');
 if(!action||!allowed[view]?.includes(action.action))return reply({error:'invalid_action'},403);
 if(!/^[A-Za-z0-9_-]{8,80}$/.test(requestId))return reply({error:'request_id_required'},400);
 const fingerprint=await controlRevision({view,action,revision:form.get('revision')});
 const session=await controlRevision(deps.csrf),key=`${session}:${requestId}`;
 const book=await loadReceiptBook(deps.store,deps.sessions);
 const prior=book[key];
 if(prior)return prior.fingerprint===fingerprint?reply({receipt:prior.receipt,duplicate:true},prior.status):reply({error:'request_reused'},409);
 if(receiptCapacityReached(book,session))return reply({error:'receipt_capacity',message:'This session has reached its change limit. Sign in again after this session expires; existing receipts remain available.'},429);
 const projection=await deps.projection(view,action.id);
 if(!projection)return reply({error:'unavailable'},503);
 if(await controlRevision(projection)!==form.get('revision'))return reply({error:'stale_read',message:'These records changed. Refresh and review again before applying a change.'},409);
 const current=await deps.view();
 if(!eligible(action,current))return reply({error:'no_longer_eligible',message:'This action is no longer available. Refresh the records.'},409);
 const pending:StoredReceipt={fingerprint,expires:deps.expires,status:503,receipt:{state:'unconfirmed',message:'The outcome is not confirmed. Refresh the records before attempting another change.'}};
 book[key]=pending;await deps.store.put(RECEIPT_BOOK_KEY,book);
 let receipt:ControlReceipt,status=200;
 try{
  const result=await deps.act(action);
  receipt=typeof result==='object'?result:typeof result==='string'?result===action.action?{state:'recorded',message:NOTICES[result]??'The change was recorded.'}:(result==='spot.forget.incomplete'||result==='node.forget.incomplete')?{state:'incomplete',message:NOTICES[result]!}:result==='invalid'||result.endsWith('.failed')?{state:'rejected',message:NOTICES[result]??'The change could not be applied.'}:pending.receipt:result?{state:'recorded',message:NOTICES[action.action]??'The change was recorded.'}:{state:'rejected',message:'That change could not be applied. Refresh the records and try again.'};
  if(receipt.state==='rejected')status=409;else if(receipt.state==='unconfirmed')status=503;
 }catch{receipt=pending.receipt;status=503;}
 book[key]={fingerprint,status,receipt,expires:deps.expires};await deps.store.put(RECEIPT_BOOK_KEY,book);
 return reply({receipt,duplicate:false},status);
}

// Fixed receipt text per decision outcome. The desk's own message is never echoed: it can carry
// provider errors or external tool output, and receipts reach surfaces that render them as given.
const APPROVAL_RECEIPT_TEXT:Readonly<Record<string,string>>={
 Done:'Done.',Sent:'Sent. This cannot be undone.','Already sent':'That exact message already went out once; nothing was sent twice.',Verified:'Done, and the result was verified.',Undone:'Undone.',
 'Not now':'Left it. Nothing changed.','Tell me what to change':'Tell Waldo in the chat what to change.','Already handled.':'That was already handled.',
 'This proposal expired':'That proposal expired, so nothing happened. Ask again if you still want it.',Expired:'That request expired. Ask again.',
 'Google is not connected':'Google is not connected, so nothing happened.','The event changed':'The event changed after the proposal, so nothing was changed.',
 'The task changed':'The Google task changed after your review, so nothing was changed.','Nothing was changed':'Nothing was changed. Ask again to retry.',
 'Too late to undo':'The 10-minute undo window has passed, so it was left as it is.',"Can't be undone":'This cannot be undone from here. Nothing was reversed.',
 'Not available':'This approval cannot be applied here. Nothing was changed.','Not available here':'That approval was not shown in full here, so nothing was done.',
 'Review it in the app':'That approval was not shown in full here, so nothing was done.','Channel not connected':'That channel is not connected, so nothing was sent.',
 'Messaging is not set up':'Messaging is not set up, so nothing was sent.','Browsing is not set up':'Browsing is not set up, so nothing was done.','MCP is not set up':'MCP is not set up, so nothing ran.',
 'Email changed':'The stored email no longer matches what was approved, so nothing was sent.','Key already used':'A different message already used this send key, so nothing was sent.',
 'Not done':'The browser action was not done.','That failed':'That did not work. Nothing else ran.',
 'Outcome unknown':'The operation outcome is unknown. Check the result before retrying; nothing was run again.',
 'Result not verified':'The result could not be verified. Check it before retrying.','Receipt not checked':'The result could not be verified. Check it before retrying.',
};
const APPROVAL_RECEIPT_FALLBACK:Readonly<Record<ControlReceipt['state'],string>>={recorded:'The decision was recorded.',incomplete:'The decision was only partly applied. Refresh the records.',
 rejected:'That decision was not carried out. Refresh the records and try again.',unconfirmed:'The proposal outcome could not be confirmed. Check the records and chat before retrying.'};
const approvalReceiptState=(out:ApprovalDecision):ControlReceipt['state']=>['Done','Undone','Not now','Sent','Already sent','Verified','Tell me what to change'].includes(out.toast)?'recorded':out.toast==='Outcome unknown'?'unconfirmed'
 :['Already handled.','This proposal expired','Google is not connected','The event changed','The task changed','Nothing was changed','Too late to undo','Not available','Not available here','Review it in the app','Channel not connected'].includes(out.toast)?'rejected':'unconfirmed';
// The console derives the state from the decision; the app passes the state its status transition proved.
// A desk refusal the console treats as unconfirmed is still a definite "nothing was done" once the
// app's transition proves the row did not move; unknown outcomes never read as refusals.
export function approvalControlReceipt(out:ApprovalDecision,state=approvalReceiptState(out)):ControlReceipt {
 const natural=approvalReceiptState(out),unknown=['Outcome unknown','Result not verified','Receipt not checked'].includes(out.toast);
 const fits=natural===state||state==='rejected'&&natural==='unconfirmed'&&!unknown;
 return {state,message:fits?APPROVAL_RECEIPT_TEXT[out.toast]??APPROVAL_RECEIPT_FALLBACK[state]:APPROVAL_RECEIPT_FALLBACK[state]};
}
