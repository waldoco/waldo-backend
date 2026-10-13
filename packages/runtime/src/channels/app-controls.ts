import { appControlActionV1Schema, appControlProjectionV1Schema, appControlQueryV1Schema, appControlRequestIdV1Schema, appControlResultV1Schema } from '../../../contracts/src/app/controls';
import { controlAction, controlRevision, type ControlReceipt } from './dashboard-control-actions';
import { projectControls, readControlsQuery } from './dashboard-controls';
import { ownerControlsAction, ownerControlsRead, type OwnerControlsDeps } from './dashboard-owner-controls';
import type { ConsoleAction, ConsoleView } from './console';
import { readMemoryGraph } from './memory-graph';
import { pageMemoryGraph } from './memory-graph-page';

export type AppControlsHost = Readonly<{
  csrf:string; expires:number; storage:DurableObjectStorage;
  assertCurrent():Promise<void>; sessions():Promise<readonly {csrf:string;expires:number}[]>;
  view(page?:{traceBefore?:number;runsBefore?:number}):Promise<ConsoleView>;
  // The day read's cards with the Main chat row each was delivered to. It reads the chat, so only that read asks for it.
  cardsLatest?(view:ConsoleView):Promise<ConsoleView['cards']>;
  act(action:ConsoleAction):Promise<boolean|string|ControlReceipt>;
  account:Pick<OwnerControlsDeps,'owner'|'auth'|'requestUrl'|'purgeOwnerFiles'|'eraseOwnerStorage'>;
}>;
const reply=(body:object,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
// App memory ids are `memory:claim:<n>` and `memory:node:<n>`: a constant scope, so the DO id never reaches the app.
const MEMORY_SCOPE='memory';
type Item=Record<string,unknown>&{local_id?:number};
const withoutLocalId=({local_id:_local,...item}:Item)=>item;
// The console pager's body, with its sub-view key renamed and the table-local ids and static lists it carries removed.
const appMemoryGraph=({view,actions:_actions,views:_views,items,item,center,nodes,...rest}:Record<string,unknown>)=>({
  ...rest,memory_view:view,
  ...(Array.isArray(items)?{items:items.map(withoutLocalId)}:{}),...(item?{item:withoutLocalId(item as Item)}:{}),
  ...(center?{center:withoutLocalId(center as Item)}:{}),...(Array.isArray(nodes)?{nodes:nodes.map(withoutLocalId)}:{}),
});
type Book=Record<string,{receipt:unknown;expires:number}>;
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
      let paged:ReturnType<typeof pageMemoryGraph>;
      try{paged=pageMemoryGraph(readMemoryGraph(host.storage.sql,MEMORY_SCOPE),new URLSearchParams(paging));}catch{return reply({error:'projection_unavailable'},503);}
      if(paged.status!==200)return reply({error:paged.body.error},paged.status);
      const data=appMemoryGraph(paged.body),parsed=appControlProjectionV1Schema.safeParse({version:1,state:'available',view:'constellation',revision:await controlRevision(data),data});
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
    const parsed=appControlProjectionV1Schema.safeParse({...shown,revision});
    await host.assertCurrent();return parsed.success?reply(parsed.data):reply({error:'projection_unavailable'},503);
  }
  if(path!=='/app/v1/actions')return reply({error:'not_found'},404);
  if(request.method!=='POST')return reply({error:'method_not_allowed'},405);
  let raw:unknown;try{raw=await request.json();}catch{return reply({error:'invalid_action'},400);}
  const action=appControlActionV1Schema.safeParse(raw);
  // A recorded deletion erases this storage and revokes the session: nothing may write or check currency after it.
  if(action.success&&action.data.action==='account.delete'){
    const form=new FormData();for(const key of ['action','view','revision','request_id','confirmation'] as const)form.set(key,action.data[key]!);form.set('csrf',host.csrf);
    const response=await ownerControlsAction(form,owner),body:unknown=await response.json();
    if(!body||typeof body!=='object'||!('receipt'in body))return reply(body as object,response.status);
    const result=appControlResultV1Schema.safeParse({...body,request_id:action.data.request_id});
    return result.success?reply(result.data,response.status):reply({error:'receipt_unavailable'},503);
  }
  if(!action.success||!(action.data.view==='day'||(action.data.view==='connections'&&(action.data.action==='google.connect'||action.data.action==='session.revoke'))))return reply({error:'invalid_action'},400);
  const form=new FormData();for(const [key,value]of Object.entries(action.data))if(value!==undefined)form.set(key,value);form.set('csrf',host.csrf);
  const response=await controlAction(form,{csrf:host.csrf,expires:host.expires,sessions:host.sessions,store:host.storage,view:read,projection,
    act:async action=>{await host.assertCurrent();return host.act(action);}});
  const body:unknown=await response.json();if(!body||typeof body!=='object'||!('receipt'in body))return reply(body as object,response.status);
  const result=appControlResultV1Schema.safeParse({...body,request_id:action.data.request_id});
  // Signout is a separate push-first endpoint. No control can invalidate its own receipt.
  await host.assertCurrent();return result.success?reply(result.data,response.status):reply({error:'receipt_unavailable'},503);
}
