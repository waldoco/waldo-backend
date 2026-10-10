import { appSessionV1Schema, appVerifyResultV1Schema, appHistoryResultV1Schema, appMessageReceiptV1Schema } from '../../contracts/src/app/core';
import { appControlProjectionV1Schema, appControlResultV1Schema } from '../../contracts/src/app/controls';
import { AppInbox } from '../src/channels/app-inbox';
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { handleApp } from '../src/channels/app-api';
import { routerSignature, linkCodeHash } from '../src/identity/owner-directory';

const proof=vi.hoisted(()=>({inputs:[] as any[],telegram:0,hold:null as null|(()=>Promise<void>)}));
vi.mock('openai',()=>({default:class {responses={create:async(input:any)=>{
  proof.inputs.push(structuredClone(input));const format=input.text?.format?.name;if(!format&&proof.hold){const hold=proof.hold;proof.hold=null;await hold();}
  return {id:'basic-fixture-model-reply',output:[],output_text:format==='claim_ops'?'{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}':format?'{}':'Hello from the signed app owner.',usage:{input_tokens:1,output_tokens:1}};
}};}}));
vi.mock('../src/channels/telegram-api',async load=>({...await load<typeof import('../src/channels/telegram-api')>(),createTelegramCaller:()=>async()=>{proof.telegram++;throw Error('No Telegram binding exists');}}));

it('signed no-Telegram app signin, chat history, lost ACK restart readback, isolation and push-first signout',async()=>{
  proof.inputs=[];proof.telegram=0;
  const name=`basic-app-owner-${crypto.randomUUID()}`,stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
  await runInDurableObject(stub,async(_unused,state)=>{
    const SECRET='fictional-basic-app-router-secret-000000000000',DIRECTORY='https://basic-app.fixture.invalid',OWNER='10000000-0000-0000-0000-000000000001',AUTH='20000000-0000-0000-0000-000000000001',EMAIL='owner@example.test';
    const calls:string[]=[];let hash:string|undefined,live=false,directoryUnavailable=false,settingsWrites=0;let savedZone='UTC';const created=new Date().toISOString(),expires=Date.now()+3600000;
    const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
      const url=new URL(String(input));expect(url.origin).toBe(DIRECTORY);const a=JSON.parse(String(init?.body));
      if(url.pathname==='/auth/v1/otp'){expect(a.email).toBe(EMAIL);calls.push('otp');return Response.json({});}
      if(url.pathname==='/auth/v1/verify'){expect(a).toMatchObject({email:EMAIL,token:'123456',type:'email'});calls.push('verify');return Response.json({user:{id:AUTH,email:EMAIL}});}
      expect(url.pathname.startsWith('/rest/v1/rpc/')).toBe(true);const fn=url.pathname.split('/').at(-1)!;calls.push(fn);
      const messages:Record<string,string>={
        console_auth_throttle:`throttle.${a.p_key}.${a.p_limit}.${a.p_window_seconds}`,signin_allowed:`signin.${a.p_email}.${a.p_code_hash}`,
        owner_for_auth:`owner.${a.p_auth_user}.${a.p_email}.${a.p_phone}.${a.p_code_hash}`,
        console_session_open:`consolesess.open.${a.p_do_name}.${a.p_session_hash}`,console_session_touch:`consolesess.touch.${a.p_do_name}.${a.p_session_hash}`,
        console_session_list:`consolesess.list.${a.p_do_name}`,console_session_revoke:`consolesess.revoke.${a.p_do_name}.${a.p_session_hash}`,
        owner_runtime_authority:`owner.runtime.${a.p_do_name}`,app_session_authority:`app.session.${a.p_do_name}.${a.p_session_hash}`,
        app_push_revoke_session:`app.push.revoke-session.${a.p_do_name}.${a.p_session_hash}`,set_owner_settings:`settings.${a.p_do_name}.${a.p_timezone}.${a.p_quiet_start}.${a.p_quiet_end}.${a.p_volume}`,
      };
      if(messages[fn])expect(a.p_sig).toBe(await routerSignature(SECRET,a.p_at,messages[fn]!));
      if(fn==='console_auth_throttle')return Response.json(true);
      if(fn==='signin_allowed')return Response.json(a.p_email===EMAIL);
      if(fn==='owner_for_auth')return Response.json(a.p_auth_user===AUTH&&a.p_email===EMAIL?name:null);
      if(fn==='console_session_open'){expect(a.p_do_name).toBe(name);hash=a.p_session_hash;live=true;return Response.json(true);}
      if(fn==='console_session_touch')return Response.json(live&&a.p_do_name===name&&a.p_session_hash===hash);
      if(fn==='console_session_list')return Response.json(live&&a.p_do_name===name?[{session:hash,created_at:created,last_seen_at:created}]:[]);
      if(fn==='owner_runtime_authority')return Response.json(a.p_do_name===name?{owner_id:OWNER,auth_user_id:AUTH,do_name:name,state_version:0,admission_revision:'1'}:null);
      if(fn==='app_session_authority'&&directoryUnavailable)return new Response('',{status:503});
      if(fn==='set_owner_settings'){settingsWrites++;savedZone=a.p_timezone;return Response.json(true);}
      if(fn==='app_session_authority')return Response.json(live&&a.p_do_name===name&&a.p_session_hash===hash?{owner_id:OWNER,do_name:name,session_hash:hash,state_version:0,admission_revision:'1',expires_at:expires}:null);
      if(fn==='workspace_owner_binding')return Response.json({owner_id:OWNER,environment:'staging',namespace:'basic-app-owner',do_name:name,do_id:state.id.toString(),state_version:0,mapping_version:1});
      if(fn==='app_push_revoke_session'){expect(live).toBe(true);expect(a.p_do_name).toBe(name);expect(a.p_session_hash).toBe(hash);return Response.json(0);}
      if(fn==='console_session_revoke'){expect(calls.at(-2)).toBe('app_push_revoke_session');live=false;return Response.json(true);}
      if(fn==='health_context_read'||fn==='health_plane')return Response.json(null);
      throw Error(`Unlisted fixture RPC ${fn}`);
    });
    const settings={...env,TELEGRAM_BOT_TOKEN:undefined,TELEGRAM_WEBHOOK_SECRET:undefined,WALDO_OWNER_TELEGRAM_ID:undefined,OPENAI_API_KEY:'synthetic-model-key',COMMON_OWNER_TASKS:'0',COMMON_BROWSER_REGISTRATION:undefined,WALDO_ENVIRONMENT:'staging',WALDO_OWNER_DO_NAMESPACE:'basic-app-owner',WALDO_OWNER_TIMEZONE:'UTC',WALDO_EGRESS_ALLOWLIST:'*',WALDO_TOOL_OFFLOAD:'0',SUPABASE_PROJECT_URL:DIRECTORY,SUPABASE_PUBLISHABLE_KEY:'fictional-public-key',WALDO_ROUTER_HMAC_SECRET:SECRET,RESPONSIBILITY_RATE_LIMITER:{limit:async()=>({success:true})},BROWSER:undefined};
    let instance=new TelegramOwnerDO(state,settings as never);state.storage.kv.put('do_name',name);state.storage.kv.put('origin','https://app.fixture.invalid');
    const forwards:Request[]=[];
    const routed={...settings,TELEGRAM_OWNER_DO:{idFromName:(n:string)=>env.TELEGRAM_OWNER_DO!.idFromName(n),get:(id:DurableObjectId)=>{expect(id.toString()).toBe(state.id.toString());return {fetch:(r:Request)=>{forwards.push(r.clone());return instance.fetch(r).catch(e=>{throw Error('native route failed: '+String(e));});}};}}} as never;
    const request=(path:string,body?:unknown,credential?:string)=>new Request(`https://app.fixture.invalid/app/v1${path}`,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(credential?{authorization:`Bearer ${credential}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const app=async(path:string,body?:unknown,credential?:string)=>{const r=await handleApp(request(path,body,credential),routed);expect(r).not.toBeNull();return r!;};
    try{
      expect((await app('/auth/code',{email:EMAIL})).status).toBe(200);
      const verify=await app('/auth/verify',{email:EMAIL,code:'123456'});expect(verify.status).toBe(200);const auth=await verify.json() as any;expect(auth).toMatchObject({state:'active',surface:'app',session_ref:`sess_${hash}`});expect(appVerifyResultV1Schema.safeParse(auth).success).toBe(true);const credential=auth.credential;
      const session=await app('/session',undefined,credential);expect(session.status).toBe(200);expect(appSessionV1Schema.safeParse(await session.json()).success).toBe(true);
      const clientId=`basic-client-${crypto.randomUUID()}`,body={client_message_id:clientId,text:'Hello from my signed app.'};
      const admitted=await app('/chat/main/messages',body,credential);expect(admitted.status,JSON.stringify({body:await admitted.clone().text(),calls,forwards:forwards.length})).toBe(202);const receipt=await admitted.json() as any;
      await vi.waitFor(()=>expect(state.storage.kv.get<any>(`app:inbox-record:${receipt.message_id}`)?.state).toBe('completed'),{timeout:10000,interval:20});
      const history=await app('/chat/main',undefined,credential);expect(history.status).toBe(200);const page=await history.json() as any;expect(appHistoryResultV1Schema.safeParse(page).success).toBe(true);
      expect(page.messages.find((m:any)=>m.role==='user')).toMatchObject({id:receipt.message_id,text:body.text,channel:'app'});
      expect(page.messages.find((m:any)=>m.role==='assistant')).toMatchObject({text:'Hello from the signed app owner.',parent_id:receipt.message_id,channel:'app'});
      expect(forwards[0]!.headers.get('x-waldo-app-session-hash')).toBe(hash);expect(proof.inputs.filter(i=>!i.text?.format)).toHaveLength(1);
      const count=proof.inputs.length;instance=new TelegramOwnerDO(state,settings as never);
      const recovered=await app(`/chat/main/messages/${clientId}`,undefined,credential);expect(recovered.status).toBe(200);expect(await recovered.json()).toMatchObject({message_id:receipt.message_id,state:'completed'});
      const retried=await app('/chat/main/messages',body,credential);expect(retried.status).toBe(202);expect(await retried.json()).toMatchObject({message_id:receipt.message_id,state:'completed'});
      expect((await (await app('/chat/main',undefined,credential)).json() as any).messages).toEqual(page.messages);expect(proof.inputs.length).toBe(count);
      expect((await app('/chat/main/messages',{...body,text:'Changed payload'},credential)).status).toBe(409);
      for(const view of ['day','connections','activity']){const response=await app(`/controls?view=${view}`,undefined,credential);expect(response.status).toBe(200);expect(appControlProjectionV1Schema.safeParse(await response.json()).success).toBe(true);}
      const day=await (await app('/controls?view=day',undefined,credential)).json() as any;
      const action={view:'day',action:'timezone.set',value:'Asia/Kolkata',revision:day.revision,request_id:'timezone-request-0001'};
      const changed=await app('/actions',action,credential);expect(changed.status).toBe(200);expect(appControlResultV1Schema.parse(await changed.json()).receipt.state).toBe('recorded');expect(settingsWrites).toBe(1);expect(savedZone).toBe('Asia/Kolkata');
      const duplicate=await app('/actions',action,credential);expect(duplicate.status).toBe(200);expect((await duplicate.json() as any).duplicate).toBe(true);expect(settingsWrites).toBe(1);
      const actionReceipt=await app('/actions/timezone-request-0001',undefined,credential);expect(actionReceipt.status).toBe(200);expect(appControlResultV1Schema.parse(await actionReceipt.json()).duplicate).toBe(true);
      expect((await app('/actions',{...action,request_id:'timezone-request-0002'},credential)).status).toBe(409);expect(settingsWrites).toBe(1);
      const longClient='max-text-client-0001',long=await (await app('/chat/main/messages',{client_message_id:longClient,text:'x'.repeat(4000)},credential)).json() as any;
      await vi.waitFor(()=>expect(state.storage.kv.get<any>(`app:inbox-record:${long.message_id}`)?.state).toBe('completed'));
      expect((await app('/chat/main/messages',{client_message_id:'too-long-client-0001',text:'x'.repeat(4001)},credential)).status).toBe(403);
      const ordinaryBefore=proof.inputs.filter(i=>!i.text?.format).length;
      let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});proof.hold=()=>held;
      const blockedId='blocked-running-client',blocked=await (await app('/chat/main/messages',{client_message_id:blockedId,text:'Interrupted in-flight turn'},credential)).json() as any;
      await vi.waitFor(()=>expect(state.storage.kv.get<any>(`app:inbox-record:${blocked.message_id}`)?.state).toBe('running'));
      await vi.waitFor(()=>expect(proof.hold).toBeNull());
      const queuedId='queued-after-running-client',queued=await (await app('/chat/main/messages',{client_message_id:queuedId,text:'Queued durable turn'},credential)).json() as any;
      expect(state.storage.kv.get<any>(`app:inbox-record:${queued.message_id}`)?.state).toBe('admitted');expect(await state.storage.getAlarm()).not.toBeNull();
      const old=instance;instance=new TelegramOwnerDO(state,settings as never);
      await instance.alarm();release();
      const interrupted=await (await app(`/chat/main/messages/${blockedId}`,undefined,credential)).json() as any;expect(appMessageReceiptV1Schema.parse(interrupted)).toMatchObject({state:'interrupted',effects_unconfirmed:true});
      expect(await (await app(`/chat/main/messages/${queuedId}`,undefined,credential)).json()).toMatchObject({state:'completed'});
      await vi.waitFor(()=>expect(proof.inputs.filter(i=>!i.text?.format)).toHaveLength(ordinaryBefore+2));
      const afterRecovery=await (await app('/chat/main',undefined,credential)).json() as any;
      expect(afterRecovery.messages.filter((m:any)=>m.role==='assistant'&&m.parent_id===blocked.message_id)).toHaveLength(0);expect(afterRecovery.messages.filter((m:any)=>m.role==='assistant'&&m.parent_id===queued.message_id)).toHaveLength(1);
      const retryInterrupted=await app('/chat/main/messages',{client_message_id:blockedId,text:'Interrupted in-flight turn'},credential);expect(await retryInterrupted.json()).toMatchObject({state:'interrupted'});
      const inbox=new AppInbox(state.storage),pending=await inbox.admit(name,hash!,'revoked-pending-client','Pending then revoked',`owner:prn_${OWNER.replaceAll('-','')}`);expect(pending.kind).toBe('admitted');
      directoryUnavailable=true;await instance.alarm();expect(inbox.receipt(name,'revoked-pending-client')?.state).toBe('admitted');directoryUnavailable=false;
      const total=proof.inputs.length;
      expect((await app('/chat/main',undefined,credential.slice(0,-1)+'!')).status).toBe(401);
      const foreign='foreign-basic-owner',sid='b'.repeat(32),foreignCredential=`${foreign}.${sid}.${await routerSignature(SECRET,0,`cookie.${foreign}.${sid}`)}`;
      expect((await app('/chat/main',undefined,foreignCredential)).status).toBe(401);
      const foreignPhysical=await instance.fetch(new Request('https://telegram-owner/app/v1/chat/main',{headers:{'x-waldo-do-name':foreign,'x-waldo-app-session-hash':hash!}}));expect(foreignPhysical.status).toBeGreaterThanOrEqual(400);expect(state.storage.kv.get('do_name')).toBe(name);
      const signout=await app('/auth/signout',{},credential);expect(signout.status).toBe(200);expect(await signout.json()).toEqual({result:'revoked'});expect(calls.slice(-3)).toEqual(['app_push_revoke_session','console_session_revoke','console_session_list']);
      expect((await app('/session',undefined,credential)).status).toBe(401);expect((await app('/chat/main/messages',{...body,client_message_id:'revoked-client'},credential)).status).toBe(401);
      const revokedDirect=await instance.fetch(new Request('https://telegram-owner/app/v1/chat/main',{headers:{'x-waldo-do-name':name,'x-waldo-app-session-hash':hash!}}));expect(revokedDirect.status).toBeGreaterThanOrEqual(400);
      await instance.alarm();expect(inbox.receipt(name,'revoked-pending-client')?.state).toBe('revoked');expect(proof.inputs.length).toBe(total);expect(proof.telegram).toBe(0);expect(hash).toBe(await linkCodeHash(credential.split('.').at(-2)!));
    }finally{(instance as any).ownerBrowser.stop();await (instance as any).ownerBrowser.maintain();await state.storage.deleteAlarm();fetcher.mockRestore();}
  });
},30000);
