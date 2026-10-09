import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import {workspaceStore} from '@waldo/workspace';
import {workspaceOwnerHost} from '../src/channels/workspace-host';
import {registerCommonBrowserSdk} from '../src/channels/common-staging-registration';
import { commonBrowserFixture, commonBrowserMeteredFixtureLoader,nativeHandoffDouble } from './fixtures/common-browser-sdk';

const proof = vi.hoisted(() => ({ inputs: [] as any[], delivered: [] as string[], directoryOwner: '10000000-0000-0000-0000-000000000001', doName: '', subject: '81101',normalCalls:0,phase:'main',phaseCalls:0,sessionHandle:'',tabRef:'',outputs:[] as any[],bodies:new Map<string,Uint8Array>() }));
vi.mock('../src/identity/common-owner-authority', () => ({ commonOwnerAuthority: () => ({ resolve: async () => ({ directoryOwnerId: proof.directoryOwner, custodyDigest: 'a'.repeat(64) }) }) }));
vi.mock('../src/channels/workspace-host',async load=>{
 const actual=await load<typeof import('../src/channels/workspace-host')>();
 return {...actual,workspaceOwnerHost:async(_env:any,storage:any,_physical:any,doName:string,_fetch:any,scope:any,assertCurrent?:()=>Promise<void>)=>workspaceStore({
  binding:{ownerId:proof.directoryOwner,environment:'staging',namespace:'fixture',doName,doId:doName,stateVersion:0,mappingVersion:1},metadata:actual.workspaceMetadata(storage,scope),
  bodies:{put:async(body:any,bytes:Uint8Array)=>{proof.bodies.set(JSON.stringify(body),bytes.slice());},get:async(body:any)=>proof.bodies.get(JSON.stringify(body))?.slice()??null,remove:async(body:any)=>{proof.bodies.delete(JSON.stringify(body));}},
  admit:async()=>{await assertCurrent?.();scope?.admit();return {status:'ok'};},now:Date.now,newId:()=>crypto.randomUUID(),
 })};
});
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  proof.inputs.push(structuredClone(input));
  const format = input.text?.format?.name;
  const previous = (Array.isArray(input.input) ? input.input : []).filter((item: any) => item.type === 'function_call_output');
  const outputs=previous.map((row:any)=>JSON.parse(row.output));if(outputs.length){proof.outputs=outputs;const first=outputs.find((row:any)=>row.ok&&row.data?.session_handle);if(first){proof.sessionHandle=first.data.session_handle;proof.tabRef ||= first.data.tab_ref;}}
  const at=format?-1:proof.phaseCalls++;
  const call=format?undefined:proof.phase==='main'?[
    {name:'browse_page',args:{provider:'cloudflare_playwright',retain_session:true,url:'https://example.com/a',instruction:'Open the owner login page'}},
    {name:'browse_act',args:{provider:'cloudflare_playwright',url:'https://example.com/a',task:'Owner login',max_actions:1,command:{operation:'owner_login',reason:'Sign in to the intended account and complete MFA.'}}},
  ][at]:proof.phase==='resume'&&at===0?{name:'browse_act',args:{provider:'cloudflare_playwright',session_handle:proof.sessionHandle,url:'https://example.com/a',task:'Resume and verify intended account',max_actions:1,command:{operation:'resume_owner_login'}}}:undefined;
  const read=Boolean(call);
  return { id: 'synthetic-public-browser-reply', output: read ? [{ type: 'function_call', call_id: `public-call-${at}`, name:call!.name, arguments:JSON.stringify(call!.args) }] : [],
    output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : read ? '' : proof.phase==='main'?'Sign in through https://local.invalid/console/browser-handoff then reply after Done.':'Fresh evidence identifies the fictional intended owner.', usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async (method: string, payload: any) => {
  if (method === 'sendMessage') { proof.delivered.push(payload.text); return { message_id: proof.delivered.length,chat:{id:payload.chat_id} }; }
  return method === 'getMe' ? { username: 'public_browser_fixture_bot' } : true;
} }));

import {consoleAccess,CONSOLE_COOKIE} from '../src/channels/console';
it.each(['resume','restart'])('protocol double: real owner inbox and console handoff %s keep exact allocation custody',async(mode)=>{
 commonBrowserFixture.reset();proof.inputs=[];proof.delivered=[];proof.outputs=[];proof.phase='main';proof.phaseCalls=0;proof.sessionHandle='';
 const doName=proof.doName=`native-handoff-${crypto.randomUUID()}`,subject=Number(proof.subject);
 if(mode==='resume')registerCommonBrowserSdk(commonBrowserMeteredFixtureLoader);
 const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(doName));
 await runInDurableObject(stub,async(_instance,state)=>{
  const denied=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('live network forbidden'));
  const binding={fetch:vi.fn(async()=>new Response('{}'))};
  const publicEnv={...env,COMMON_OWNER_TASKS:'0',WALDO_ENVIRONMENT:'staging',LANGFUSE_CAPTURE_TEXT:'true',WALDO_EGRESS_ALLOWLIST:'*',WALDO_TOOL_OFFLOAD:'0',BROWSER:binding as never,RESPONSIBILITY_RATE_LIMITER:{limit:async()=>({success:true})} as never,TELEGRAM_BOT_TOKEN:'12345:fictional',TELEGRAM_WEBHOOK_SECRET:'synthetic-handoff-secret',OPENAI_API_KEY:'synthetic-model-key'};
  const instance=new TelegramOwnerDO(state,publicEnv);let updateId=9982100;
  const send=async(text:string)=>{
   const id=++updateId;expect((await instance.fetch(new Request('https://local.invalid/enqueue',{method:'POST',headers:{'x-waldo-inbox-secret':publicEnv.TELEGRAM_WEBHOOK_SECRET,'x-waldo-telegram-subject':String(subject),'x-waldo-do-name':doName},body:JSON.stringify({update_id:id,message:{message_id:id,from:{id:subject,is_bot:false},chat:{id:subject,type:'private'},text}})}))).status).toBe(200);
   for(let i=0;i<8;i++){await instance.alarm();const row=state.storage.kv.get<any[]>('telegram_owner_inbox_v1')?.find(row=>row.updateId===id);if(row?.closedAt!==undefined||row?.state==='completed'||row?.state==='consumed')return;}throw Error('Owner turn did not finish');
  };
  try{
   state.storage.kv.put('origin','https://local.invalid');
   await send('Use Cloudflare to open my login page and let me sign in.');
   expect(proof.outputs.at(-1)).toMatchObject({ok:true,data:{owner_login:'pending',console_url:'https://local.invalid/console/browser-handoff'}});
   expect(nativeHandoffDouble.commands.filter(command=>command==='Cloudflare.handoff')).toHaveLength(1);expect(nativeHandoffDouble.commands).not.toContain('Cloudflare.getLiveView');
   if(mode==='restart'){
    const restarted=new TelegramOwnerDO(state,publicEnv);
    await vi.waitFor(async()=>{await restarted.alarm();expect(commonBrowserFixture.ends).toBe(1);},{timeout:3000,interval:50});
    expect(commonBrowserFixture.allocations).toBe(1);expect(commonBrowserFixture.pages).toHaveLength(0);return;
   }
   const token=await consoleAccess(state.storage).grant(),session=(await consoleAccess(state.storage).session(token))!;
   const url='https://local.invalid/console/browser-handoff',cookie=`${CONSOLE_COOKIE}=${token}`;
   const preview=await instance.fetch(new Request(url,{headers:{cookie}}));expect(preview.status).toBe(200);expect(await preview.text()).not.toContain('FICTIONAL_BEARER');
   const opened=await instance.fetch(new Request(url,{method:'POST',headers:{cookie,origin:'https://local.invalid','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:session.csrf,action:'open'})}));expect(opened.status).toBe(200);expect(await opened.text()).toContain('FICTIONAL_BEARER');
   nativeHandoffDouble.emit(true);commonBrowserFixture.text='Signed in as fictional intended owner';proof.phase='resume';proof.phaseCalls=0;
   await send(`I used Done; resume browser ${proof.sessionHandle} and verify the intended account.`);
   expect(proof.outputs.at(-1)).toMatchObject({ok:true,data:{owner_login:'completed',intended_account_verification_required:true,text:'Signed in as fictional intended owner'}});
   expect(commonBrowserFixture.allocations).toBe(1);expect(commonBrowserFixture.ends).toBe(0);
   expect(JSON.stringify(proof.inputs)+JSON.stringify([...state.storage.kv.list({prefix:'common-browser:'})])).not.toContain('FICTIONAL_BEARER');expect(JSON.stringify(proof.inputs)).not.toContain('fixture-retained-provider');expect(denied).not.toHaveBeenCalled();
   await send('/stop');await vi.waitFor(()=>expect(commonBrowserFixture.ends).toBe(1));expect(commonBrowserFixture.pages).toHaveLength(0);
  }finally{await state.storage.deleteAlarm();denied.mockRestore();}
 });
});
