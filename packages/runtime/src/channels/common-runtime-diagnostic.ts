import type {TelegramWebhookEnv} from './telegram-webhook';
// Called only behind the existing owner-console session. Fixed staging equality
// receipt, no input-selected target, URL/key/HMAC/owner data or new provider request.
// Existing outer owner authentication still touches its session RPC; ordinary
// DO routing may persist its name. This helper does not claim zero endpoint effects.
export async function commonRuntimeDiagnostic(env:TelegramWebhookEnv,limiter:RateLimit|undefined,ownerScope:string):Promise<Response>{
 const headers={'cache-control':'no-store','referrer-policy':'no-referrer','x-frame-options':'DENY'};
 if(env.WALDO_ENVIRONMENT!=='staging')return new Response('not found',{status:404,headers});
 if(!limiter)return Response.json({error:'unavailable'},{status:503,headers});
 try{if(!(await limiter.limit({key:`common-runtime-diagnostic:${ownerScope}`})).success)return Response.json({error:'rate_limited'},{status:429,headers:{...headers,'retry-after':'60'}});}
 catch{return Response.json({error:'unavailable'},{status:503,headers});}
 let matches=false;
 try{const url=new URL(env.SUPABASE_PROJECT_URL??'');matches=url.protocol==='https:'&&url.hostname==='togdshayyxycitzckpqv.supabase.co'&&!url.username&&!url.password&&!url.port&&(url.pathname==='/'||url.pathname==='')&&!url.search&&!url.hash;}
 catch{/* Fixed false receipt; malformed secret values never leave this function. */}
 return Response.json({version:1,project_matches_expected:matches,configured:{directory_key:Boolean(env.SUPABASE_PUBLISHABLE_KEY),router_signing:Boolean(env.WALDO_ROUTER_HMAC_SECRET),common_owner_tasks:env.COMMON_OWNER_TASKS==='1',browser_binding:Boolean(env.BROWSER)},scope:'configuration_only_not_rpc_acl_or_secret_equality'}, {headers});
}
