import { appControlActionV1Schema, appControlProjectionV1Schema, appControlQueryV1Schema, appControlRequestIdV1Schema, appControlResultV1Schema } from '../../../contracts/src/app/controls';
import { controlAction, controlRevision } from './dashboard-control-actions';
import { projectControls, readControlsQuery } from './dashboard-controls';
import type { ConsoleAction, ConsoleView } from './console';

export type AppControlsHost = Readonly<{
  csrf:string; expires:number; storage:DurableObjectStorage;
  assertCurrent():Promise<void>; sessions():Promise<readonly {csrf:string;expires:number}[]>;
  view(page?:{traceBefore?:number;runsBefore?:number}):Promise<ConsoleView>;
  act(action:ConsoleAction):Promise<boolean|string>;
}>;
const reply=(body:object,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
export async function appControlsRequest(request:Request,host:AppControlsHost):Promise<Response> {
  const url=new URL(request.url),path=url.pathname;await host.assertCurrent();
  if(path.startsWith('/app/v1/actions/')){
    if(request.method!=='GET')return reply({error:'method_not_allowed'},405);
    const id=path.slice('/app/v1/actions/'.length);
    if(url.search||!appControlRequestIdV1Schema.safeParse(id).success)return reply({error:'invalid_query'},400);
    const key=`${await controlRevision(host.csrf)}:${id}`,rows=await host.storage.get<Record<string,{receipt:unknown;expires:number}>>('console:control-receipts')??{},row=rows[key];
    if(!row||row.expires<=Date.now())return reply({error:'receipt_not_found'},404);
    const result=appControlResultV1Schema.safeParse({request_id:id,receipt:row.receipt,duplicate:true});
    await host.assertCurrent();return result.success?reply(result.data):reply({error:'receipt_unavailable'},503);
  }
  let built:ConsoleView|undefined;
  const read=async(page?:{traceBefore?:number;runsBefore?:number})=>built??(built=await host.view(page));
  const projection=async(view:string,_id?:string,page?:{traceBefore?:number;runsBefore?:number})=>{
    if(!['day','connections','activity'].includes(view))return null;
    const query=readControlsQuery(new URLSearchParams({view}));return query?projectControls(await read(page),query.view):null;
  };
  if(path==='/app/v1/controls'){
    if(request.method!=='GET')return reply({error:'method_not_allowed'},405);
    if([...url.searchParams.keys()].some(key=>!['view','trace_before','runs_before'].includes(key)||url.searchParams.getAll(key).length!==1))return reply({error:'invalid_query'},400);
    const query=appControlQueryV1Schema.safeParse(Object.fromEntries(url.searchParams));if(!query.success)return reply({error:'invalid_query'},400);
    const page={...(query.data.trace_before?{traceBefore:Number(query.data.trace_before)}:{}),...(query.data.runs_before?{runsBefore:Number(query.data.runs_before)}:{})};
    const result=await projection(query.data.view,undefined,page);if(!result)return reply({error:'not_found'},404);
    const {csrf:_csrf,...shown}=result;
    const parsed=appControlProjectionV1Schema.safeParse({...shown,revision:await controlRevision(result)});
    await host.assertCurrent();return parsed.success?reply(parsed.data):reply({error:'projection_unavailable'},503);
  }
  if(path!=='/app/v1/actions')return reply({error:'not_found'},404);
  if(request.method!=='POST')return reply({error:'method_not_allowed'},405);
  let raw:unknown;try{raw=await request.json();}catch{return reply({error:'invalid_action'},400);}
  const action=appControlActionV1Schema.safeParse(raw);if(!action.success||action.data.view!=='day')return reply({error:'invalid_action'},400);
  const form=new FormData();for(const [key,value]of Object.entries(action.data))if(value!==undefined)form.set(key,value);form.set('csrf',host.csrf);
  const response=await controlAction(form,{csrf:host.csrf,expires:host.expires,sessions:host.sessions,store:host.storage,view:read,projection,
    act:async action=>{await host.assertCurrent();return host.act(action);}});
  const body:unknown=await response.json();if(!body||typeof body!=='object'||!('receipt'in body))return reply(body as object,response.status);
  const result=appControlResultV1Schema.safeParse({...body,request_id:action.data.request_id});
  // Signout is a separate push-first endpoint. No control can invalidate its own receipt.
  await host.assertCurrent();return result.success?reply(result.data,response.status):reply({error:'receipt_unavailable'},503);
}
