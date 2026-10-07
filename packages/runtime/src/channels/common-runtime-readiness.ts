import {commonOwnerAuthority} from '../identity/common-owner-authority';
import {signedRpc} from '../identity/owner-directory';
import type {TelegramWebhookEnv} from './telegram-webhook';
// Fixed owner-console read checks. No schema mutation, model, root run, raw health,
// secret values, identity rows or request-selected target leaves the endpoint.
export async function commonRuntimeReadiness(env:TelegramWebhookEnv,storage:DurableObjectStorage,actualDoId:string,limiter:RateLimit|undefined):Promise<Response>{
 const headers={'cache-control':'no-store','referrer-policy':'no-referrer','x-frame-options':'DENY'};
 if(env.WALDO_ENVIRONMENT!=='staging')return new Response('not found',{status:404,headers});
 if(!limiter)return Response.json({error:'unavailable'},{status:503,headers});
 try{if(!(await limiter.limit({key:`common-runtime-readiness:${actualDoId}`})).success)return Response.json({error:'rate_limited'},{status:429,headers:{...headers,'retry-after':'60'}});}catch{return Response.json({error:'unavailable'},{status:503,headers});}
 const doName=storage.kv.get<string>('do_name'),subject=storage.kv.get<string>('telegram_subject');
 if(!doName||!subject||storage.kv.get<boolean>('telegram_unlinked')||env.TELEGRAM_OWNER_DO?.idFromName(doName).toString()!==actualDoId)return Response.json({error:'owner_unavailable'},{status:503,headers});
 let owner:'verified'|'unlinked'|'unverifiable'='unverifiable',workspace:'verified'|'unlinked'|'unverifiable'='unverifiable';
 try{
  const directory=commonOwnerAuthority(env),authority=await directory.resolve('telegram',subject,doName);
  if(!authority){owner='unlinked';workspace='unlinked';}
  else{
   await directory.assertCurrent(authority);owner='verified';
   const environment=env.WALDO_ENVIRONMENT,namespace=env.WALDO_OWNER_DO_NAMESPACE,call=signedRpc(env);
   if(namespace&&call){
    const locator=JSON.stringify([environment,namespace,doName,actualDoId]);
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(locator)))].map(b=>b.toString(16).padStart(2,'0')).join('');
    const value=await call('workspace_owner_binding',`workspace.bind.${hash}`,{p_environment:environment,p_namespace:namespace,p_do_name:doName,p_do_id:actualDoId,p_locator:locator});
    const row=value as Record<string,unknown>|null;
    workspace=row===null?'unlinked':row&&row.owner_id===authority.directoryOwnerId&&row.environment===environment&&row.namespace===namespace&&row.do_name===doName&&row.do_id===actualDoId&&row.state_version===authority.stateVersion&&Number.isSafeInteger(row.mapping_version)&&Number(row.mapping_version)>0?'verified':'unverifiable';
   }
   await directory.assertCurrent(authority);
  }
 }catch{owner='unverifiable';workspace='unverifiable';}
 if(storage.kv.get('do_name')!==doName||storage.kv.get('telegram_subject')!==subject||storage.kv.get<boolean>('telegram_unlinked')){owner='unverifiable';workspace='unverifiable';}
 return Response.json({version:1,owner_authority:owner,workspace_binding:workspace,scope:'signed_read_checks_only_not_schema_health_issuer_or_execution_acceptance'}, {headers});
}
