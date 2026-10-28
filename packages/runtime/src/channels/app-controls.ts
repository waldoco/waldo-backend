import { APP_CONTROLS_CARD_STATE_REVISION, APP_CONTROLS_DAY_HISTORY_REVISION, APP_CONTROLS_MEMORY_REVISION, type AppWelcomeBuildV1, appControlActionV1Schema, appControlProjectionV1Schema, appControlQueryV1Schema, appControlRequestIdV1Schema, appControlResultV1Schema } from '../../../contracts/src/app/controls';
import { APP_CONTRACT_HEADER, appContractRevision } from '../../../contracts/src/app/core';
import { appControlStepUpAction, appStepUpRefusal, stepUpGated } from './console-step-up';
import { signedInRecently } from '../identity/console-auth';
import { controlAction, controlRevision, type ControlReceipt } from './dashboard-control-actions';
import { projectControls, readControlsQuery } from './dashboard-controls';
import { ownerControlsAction, ownerControlsRead, type OwnerControlsDeps } from './dashboard-owner-controls';
import type { ConsoleAction, ConsoleView } from './console';
import { readMemoryGraph } from './memory-graph';
import { pageMemoryGraph } from './memory-graph-page';
import { phoneControlAct, phoneControls, type IMessageProof } from './dashboard-phone';
import type { PhoneSmsEnv } from '../identity/phone-sms';

export type AppControlsHost = Readonly<{
  csrf:string; expires:number; storage:DurableObjectStorage;
  // The session row's created_at: the proof of a recent email code that a gated action needs.
  signedInAt:string;
  assertCurrent():Promise<void>; sessions():Promise<readonly {csrf:string;expires:number}[]>;
  view(page?:{traceBefore?:number;runsBefore?:number}):Promise<ConsoleView>;
  // The day read's cards with the Main chat row each was delivered to. It reads the chat, so only that read asks for it.
  cardsLatest?(view:ConsoleView):Promise<ConsoleView['cards']>;
  // The days view: the last 14 local days, or one of them in detail; null for a date outside them.
  days?(date?:string):Promise<object|null>;
  act(action:ConsoleAction):Promise<boolean|string|ControlReceipt>;
  // The owner's welcome build, read with the constellation summary; a read also takes up a build an interrupted run left.
  welcome?():AppWelcomeBuildV1;
  account:Pick<OwnerControlsDeps,'owner'|'auth'|'requestUrl'|'purgeOwnerFiles'|'eraseOwnerStorage'>;
  phone:PhoneSmsEnv;
  // Clears the WhatsApp chat this owner DO holds, after the directory unlinked it.
  whatsappUnlinked():Promise<void>;
  // Whether the owner can prove a number by sending their iMessage link code from it; absent means they cannot.
  imessageProof?:IMessageProof;
}>;
const reply=(body:object,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
// App memory ids are `memory:claim:<n>` and `memory:node:<n>`: a constant scope, so the DO id never reaches the app.
const MEMORY_SCOPE='memory';
type Item=Record<string,unknown>&{local_id?:number};
const withoutLocalId=({local_id:_local,...item}:Item)=>item;
// The console pager's body, with its sub-view key renamed and the table-local ids and static lists it carries removed.
// A claim as each revision reads it. Revision 2 adds its pin and names a claim the nightly model confirmed waldo_confirmed;
// revision 1 reads that claim as confirmed, as it always did. Interpretations carry neither.
const pinOf=(pins:ReadonlyMap<number,string>|undefined)=>(item:Item):Item=>item.type==='interpretation'?item
  :pins?{...item,pinned:pins.get(item.local_id!)??null}:item.source==='waldo_confirmed'?{...item,source:'confirmed'}:item;
const appMemoryGraph=({view,actions:_actions,views:_views,items,item,center,nodes,...rest}:Record<string,unknown>,pins?:ReadonlyMap<number,string>)=>({
  ...rest,memory_view:view,
  ...(Array.isArray(items)?{items:items.map(pinOf(pins)).map(withoutLocalId)}:{}),...(item?{item:withoutLocalId(pinOf(pins)(item as Item))}:{}),
  ...(center?{center:withoutLocalId(center as Item)}:{}),...(Array.isArray(nodes)?{nodes:nodes.map(withoutLocalId)}:{}),
});
type Book=Record<string,{receipt:unknown;expires:number}>;
const showsPins=(request:Request)=>appContractRevision(request.headers.get(APP_CONTRACT_HEADER),'controls')>=APP_CONTROLS_MEMORY_REVISION;
// A build before controls revision 3 knows four card states and neither reason nor tries: a card being made, failed or paused
// is still unfinished, so it reads as pending.
const OLDER_CARD_STATE:Readonly<Record<string,string>>={generating:'pending',failed:'pending',paused:'pending'};
const dayForRevision=(request:Request,shown:Record<string,unknown>)=>{
  if(appContractRevision(request.headers.get(APP_CONTRACT_HEADER),'controls')>=APP_CONTROLS_CARD_STATE_REVISION)return shown;
  const data=shown.data as {cards:readonly Record<string,unknown>[]};
  return {...shown,data:{...data,cards:data.cards.map(({state_reason:_reason,retries_left:_left,...card})=>typeof card.state==='string'&&OLDER_CARD_STATE[card.state]?{...card,state:OLDER_CARD_STATE[card.state]}:card)}};
};
const pinsOf=(sql:Pick<SqlStorage,'exec'>)=>new Map(sql.exec<{id:number;pinned:string}>("SELECT id, pinned FROM claims WHERE pinned IN ('profile','facts')").toArray().map(row=>[row.id,row.pinned]));
// The console's memory action for each of the app's claim actions; the app's id names one claim, memory:claim:<n>.
const SPOT_ACTION:Readonly<Record<string,string>>={'claim.pin':'spot.pin','claim.unpin':'spot.unpin','claim.edit':'spot.edit'};
// One constellation read, as the app sees it: paged from the console graph, its local ids gone, pins added for revision 2.
const constellationData=(storage:DurableObjectStorage,paging:readonly (readonly [string,string])[],pins:boolean)=>{
  const paged=pageMemoryGraph(readMemoryGraph(storage.sql,MEMORY_SCOPE),new URLSearchParams(paging as [string,string][]));
  return paged.status===200?{status:200,data:appMemoryGraph(paged.body,pins?pinsOf(storage.sql):undefined)}:{status:paged.status,error:paged.body.error};
};
export async function appControlsRequest(request:Request,host:AppControlsHost):Promise<Response> {
  const url=new URL(request.url),path=url.pathname;await host.assertCurrent();
  if(path.startsWith('/app/v1/actions/')){
    if(request.method!=='GET')return reply({error:'method_not_allowed'},405);
    const id=path.slice('/app/v1/actions/'.length);
    if(url.search||!appControlRequestIdV1Schema.safeParse(id).success)return reply({error:'invalid_query'},400);
    const key=`${await controlRevision(host.csrf)}:${id}`;
    const row=(await host.storage.get<Book>('console:control-receipts'))?.[key]??(await host.storage.get<Book>('console:owner-control-receipts'))?.[key];
    if(!row||row.expires<=Date.now())return reply({error:'receipt_not_found'},404);
    const result=appControlResultV1Schema.safeParse({request_id:id,receipt:row.receipt,duplicate:true});
    await host.assertCurrent();return result.success?reply(result.data):reply({error:'receipt_unavailable'},503);
  }
  const owner:OwnerControlsDeps={...host.account,csrf:host.csrf,expires:host.expires,sessions:host.sessions,store:host.storage};
  let built:ConsoleView|undefined;
  const read=async(page?:{traceBefore?:number;runsBefore?:number})=>built??(built=await host.view(page));
  const projection=async(view:string,_id?:string,page?:{traceBefore?:number;runsBefore?:number})=>{
    if(!['day','connections','activity'].includes(view))return null;
    const query=readControlsQuery(new URLSearchParams({view}));return query?projectControls(await read(page),query.view):null;
  };
  if(path==='/app/v1/controls'){
    if(request.method!=='GET')return reply({error:'method_not_allowed'},405);
    if([...url.searchParams.keys()].some(key=>url.searchParams.getAll(key).length!==1))return reply({error:'invalid_query'},400);
    const query=appControlQueryV1Schema.safeParse(Object.fromEntries(url.searchParams));if(!query.success)return reply({error:'invalid_query'},400);
    if(query.data.view==='constellation'){
      const {memory_view,cursor,limit,id,max_nodes,max_links}=query.data;
      const paging=Object.entries({view:memory_view,cursor,limit,id,max_nodes,max_links}).filter((entry):entry is [string,string]=>entry[1]!==undefined);
      let graph:ReturnType<typeof constellationData>;
      try{graph=constellationData(host.storage,paging,showsPins(request));}catch{return reply({error:'projection_unavailable'},503);}
      if(graph.status!==200||!graph.data)return reply({error:graph.error},graph.status);
      const data=graph.data.memory_view==='summary'&&host.welcome?{...graph.data,welcome:host.welcome()}:graph.data,parsed=appControlProjectionV1Schema.safeParse({version:1,state:'available',view:'constellation',revision:await controlRevision(data),data});
      await host.assertCurrent();return parsed.success?reply(parsed.data):reply({error:'projection_unavailable'},503);
    }
    if(query.data.view==='days'){
      if(!host.days||appContractRevision(request.headers.get(APP_CONTRACT_HEADER),'controls')<APP_CONTROLS_DAY_HISTORY_REVISION)return reply({error:'invalid_query'},400);
      let data:object|null;
      try{data=await host.days(query.data.date);}catch{return reply({error:'projection_unavailable'},503);}
      if(data===null)return reply({error:'not_found'},404);
      const parsed=appControlProjectionV1Schema.safeParse({version:1,state:'available',view:'days',revision:await controlRevision(data),data});
      await host.assertCurrent();return parsed.success?reply(parsed.data):reply({error:'projection_unavailable'},503);
    }
    if(query.data.view==='phone'){
      let controls:Awaited<ReturnType<typeof phoneControls>>;
      try{controls=await phoneControls(host.phone,host.account.owner,host.csrf,host.imessageProof);}catch{return reply({error:'projection_unavailable'},503);}
      const {csrf:_csrf,...shown}=controls,parsed=appControlProjectionV1Schema.safeParse({...shown,revision:await controlRevision(controls)});
      await host.assertCurrent();return parsed.success?reply(parsed.data):reply({error:'projection_unavailable'},503);
    }
    if(query.data.view==='account'){
      const response=await ownerControlsRead('account',owner);if(!response.ok)return reply({error:'projection_unavailable'},503);
      const {csrf:_csrf,...shown}=await response.json() as Record<string,unknown>,parsed=appControlProjectionV1Schema.safeParse(shown);
      await host.assertCurrent();return parsed.success?reply(parsed.data):reply({error:'projection_unavailable'},503);
    }
    const page={...(query.data.trace_before?{traceBefore:Number(query.data.trace_before)}:{}),...(query.data.runs_before?{runsBefore:Number(query.data.runs_before)}:{})};
    const result=await projection(query.data.view,undefined,page);if(!result)return reply({error:'not_found'},404);
    // The revision guards what an action changes, so it is taken before latest is added: an action rebuilds the day without it.
    const revision=await controlRevision(result);
    const {csrf:_csrf,...shown}=query.data.view==='day'&&host.cardsLatest&&built?projectControls({...built,cards:await host.cardsLatest(built)},'day'):result;
    const parsed=appControlProjectionV1Schema.safeParse({...(query.data.view==='day'?dayForRevision(request,shown):shown),revision});
    await host.assertCurrent();return parsed.success?reply(parsed.data):reply({error:'projection_unavailable'},503);
  }
  if(path!=='/app/v1/actions')return reply({error:'not_found'},404);
  if(request.method!=='POST')return reply({error:'method_not_allowed'},405);
  let raw:unknown;try{raw=await request.json();}catch{return reply({error:'invalid_action'},400);}
  const action=appControlActionV1Schema.safeParse(raw);
  if(action.success&&stepUpGated(appControlStepUpAction(action.data))&&!signedInRecently(host.signedInAt,Date.now()))return appStepUpRefusal();
  // A recorded deletion erases this storage and revokes the session: nothing may write or check currency after it.
  if(action.success&&action.data.action==='account.delete'){
    const form=new FormData();for(const key of ['action','view','revision','request_id','confirmation'] as const)form.set(key,action.data[key]!);form.set('csrf',host.csrf);
    const response=await ownerControlsAction(form,owner),body:unknown=await response.json();
    if(!body||typeof body!=='object'||!('receipt'in body))return reply(body as object,response.status);
    const result=appControlResultV1Schema.safeParse({...body,request_id:action.data.request_id});
    return result.success?reply(result.data,response.status):reply({error:'receipt_unavailable'},503);
  }
  // A node action runs as the console's memory action on the node it names, against the revision of that node's detail read.
  if(action.success&&action.data.view==='constellation'&&action.data.action.startsWith('node.')){
    const {id,action:name,value,revision,request_id}=action.data,form=new FormData();
    for(const [key,field] of Object.entries({csrf:host.csrf,view:'memory',action:name,id:id!.split(':')[2]!,revision,request_id,...(value===undefined?{}:{value:value.trim()})}))form.set(key,field);
    const response=await controlAction(form,{csrf:host.csrf,expires:host.expires,sessions:host.sessions,store:host.storage,view:read,
      projection:async()=>{const detail=constellationData(host.storage,[['view','detail'],['id',id!]],showsPins(request));return detail.status===200?detail.data as never:null;},
      act:async node=>{await host.assertCurrent();return host.act(node);}});
    const body:unknown=await response.json();if(!body||typeof body!=='object'||!('receipt'in body))return reply(body as object,response.status);
    const result=appControlResultV1Schema.safeParse({...body,request_id});
    await host.assertCurrent();return result.success?reply(result.data,response.status):reply({error:'receipt_unavailable'},503);
  }
  // A claim action runs as the console's memory action on the claim it names. It carries the revision of that claim's
  // detail read under revision 2, so a pin or an edit made elsewhere since makes it stale.
  if(action.success&&action.data.view==='constellation'){
    if(!showsPins(request))return reply({error:'invalid_action'},400);
    const {id,action:name,value,revision,request_id}=action.data,form=new FormData();
    for(const [key,field] of Object.entries({csrf:host.csrf,view:'memory',action:SPOT_ACTION[name]!,id:id!.split(':')[2]!,revision,request_id,...(value===undefined?{}:{value:name==='claim.edit'?value.trim():value})}))form.set(key,field);
    const response=await controlAction(form,{csrf:host.csrf,expires:host.expires,sessions:host.sessions,store:host.storage,view:read,
      projection:async()=>{const detail=constellationData(host.storage,[['view','detail'],['id',id!]],true);return detail.status===200?detail.data as never:null;},
      act:async spot=>{await host.assertCurrent();return host.act({...spot,made:`app:${name}`});}});
    const body:unknown=await response.json();if(!body||typeof body!=='object'||!('receipt'in body))return reply(body as object,response.status);
    const result=appControlResultV1Schema.safeParse({...body,request_id});
    await host.assertCurrent();return result.success?reply(result.data,response.status):reply({error:'receipt_unavailable'},503);
  }
  // Try again came with the card states (controls=3): an older build that names it gets what it got before it existed.
  if(action.success&&action.data.action==='card.retry'&&appContractRevision(request.headers.get(APP_CONTRACT_HEADER),'controls')<APP_CONTROLS_CARD_STATE_REVISION)return reply({error:'invalid_action'},400);
  if(!action.success||!(action.data.view==='day'||action.data.view==='phone'||(action.data.view==='connections'&&['google.connect','granola.connect','granola.disconnect','app.connect','app.disconnect','session.revoke'].includes(action.data.action))))return reply({error:'invalid_action'},400);
  const form=new FormData();for(const [key,value]of Object.entries(action.data))if(value!==undefined)form.set(key,value);form.set('csrf',host.csrf);
  // The phone view lists its own actions, so its fresh read is the eligibility check; the console view is never built.
  const phone=action.data.view==='phone';
  const response=await controlAction(form,phone
    ?{csrf:host.csrf,expires:host.expires,sessions:host.sessions,store:host.storage,
      projection:async view=>view==='phone'?phoneControls(host.phone,host.account.owner,host.csrf,host.imessageProof):null,
      act:async(action,fields)=>{await host.assertCurrent();return phoneControlAct(host.phone,host.account.owner,action,fields,host.whatsappUnlinked,host.imessageProof);}}
    :{csrf:host.csrf,expires:host.expires,sessions:host.sessions,store:host.storage,view:read,projection,
      act:async action=>{await host.assertCurrent();return host.act(action);}});
  const body:unknown=await response.json();if(!body||typeof body!=='object'||!('receipt'in body))return reply(body as object,response.status);
  const result=appControlResultV1Schema.safeParse({...body,request_id:action.data.request_id});
  // Signout is a separate push-first endpoint. No control can invalidate its own receipt.
  await host.assertCurrent();return result.success?reply(result.data,response.status):reply({error:'receipt_unavailable'},503);
}
