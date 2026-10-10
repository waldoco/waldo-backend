import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { registerCommonBrowserSdk } from '../src/channels/common-staging-registration';
import { ownerRuntimeAuthority } from '../src/identity/owner-runtime-authority';
import { routerSignature } from '../src/identity/owner-directory';
import { workspaceOwnerHost } from '../src/channels/workspace-host';
import { commonBrowserFixture, commonBrowserMeteredFixtureLoader } from './fixtures/common-browser-sdk';

const proof = vi.hoisted(() => ({ normalCalls: 0, command: undefined as any, inputs: [] as any[], outputs: [] as any[], telegramCalls: 0, errors: [] as string[] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  proof.inputs.push(structuredClone(input));
  const format = input.text?.format?.name;
  const previous = (Array.isArray(input.input) ? input.input : []).filter((item: any) => item.type === 'function_call_output');
  if (!format && previous.length) proof.outputs = previous.map((row: any) => JSON.parse(row.output));
  const call = !format && proof.normalCalls++ === 0 ? proof.command : undefined;
  return { id: 'synthetic-app-browser-reply', output: call ? [{ type: 'function_call', call_id: crypto.randomUUID(), name: call.name, arguments: JSON.stringify(call.args) }] : [],
    output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : call ? '' : 'I read the owner page and retained the browser for your next step.', usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async () => { proof.telegramCalls++; throw Error('Telegram is absent from this app owner'); } }));
registerCommonBrowserSdk(commonBrowserMeteredFixtureLoader);

beforeEach(() => { commonBrowserFixture.reset(); proof.normalCalls=0; proof.command=undefined; proof.inputs=[]; proof.outputs=[]; proof.telegramCalls=0;proof.errors=[]; });
const OWNER='10000000-0000-0000-0000-000000000001', AUTH_USER='20000000-0000-0000-0000-000000000001', SESSION='a'.repeat(64), DIRECTORY='https://app-owner-browser.fixture.invalid', SECRET='fictional-owner-router-secret';
async function withOwner(work: (f: { instance: TelegramOwnerDO; state: DurableObjectState; name: string; headers: Record<string,string>; send(command: any, text?: string): Promise<any>; settings: any; sessionLive(value: boolean): void; calls: string[]; restart(): void }) => Promise<void>) {
  const name=`app-owner-channels-${crypto.randomUUID()}`, stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_instance,state) => {
    let live=true, revision='1', telegramLinked=true; const calls:string[]=[], expires=Date.now()+3600000;
    const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async (input,init) => {
      const url=new URL(String(input)); if(url.origin!==DIRECTORY||!url.pathname.startsWith('/rest/v1/rpc/'))throw Error('unlisted outbound network forbidden');
      const fn=url.pathname.split('/').at(-1)!,args=JSON.parse(String(init?.body));calls.push(fn);
      const message=fn==='console_session_list'?`consolesess.list.${args.p_do_name}`:fn==='app_session_authority'?`app.session.${args.p_do_name}.${args.p_session_hash}`:fn==='owner_runtime_authority'?`owner.runtime.${args.p_do_name}`:undefined;
      if(message)expect(args.p_sig).toBe(await routerSignature(SECRET,args.p_at,message));
      if(fn==='console_session_list')return Response.json(live&&args.p_do_name===name?[{session:SESSION,created_at:new Date().toISOString(),last_seen_at:new Date().toISOString()}]:[]);
      if(fn==='app_session_authority')return Response.json(live&&args.p_do_name===name&&args.p_session_hash===SESSION?{owner_id:OWNER,do_name:name,session_hash:SESSION,state_version:0,admission_revision:revision,expires_at:expires}:null);
      if(fn==='owner_runtime_authority')return Response.json(args.p_do_name===name?{owner_id:OWNER,auth_user_id:AUTH_USER,do_name:name,state_version:0,admission_revision:revision}:null);
      if(fn==='owner_channel_inventory'){expect(args.p_sig).toBe(await routerSignature(SECRET,args.p_at,`app.channels.inventory.${name}.${SESSION}.${args.p_expected_revision}`));return Response.json({owner_id:OWNER,do_name:name,revision:`0:${revision}`,linked:telegramLinked?['telegram']:[]});}
      if(fn==='unlink_presence'){expect(args.p_sig).toBe(await routerSignature(SECRET,args.p_at,`app.channels.unlink.${name}.${SESSION}.${args.p_expected_revision}.${args.p_provider}`));if(args.p_expected_revision!==`0:${revision}`)return Response.json(null);if(telegramLinked){telegramLinked=false;revision='2';}return Response.json({owner_id:OWNER,do_name:name,revision:`0:${revision}`});}
      if(fn==='workspace_owner_binding')return Response.json({owner_id:OWNER,environment:'staging',namespace:'fixture-app-owner',do_name:name,do_id:state.id.toString(),state_version:0,mapping_version:1});
      if(fn==='health_context_read')return Response.json(null);
      if(fn==='health_plane')return Response.json(null);
      throw Error(`unlisted signed directory RPC ${fn}`);
    });
    const settings={...env,RESPONSIBILITY_RATE_LIMITER:{limit:async()=>({success:true})} as never,TELEGRAM_BOT_TOKEN:undefined,TELEGRAM_WEBHOOK_SECRET:undefined,WALDO_OWNER_TELEGRAM_ID:undefined,OPENAI_API_KEY:'synthetic-model-key',COMMON_OWNER_TASKS:'0',COMMON_BROWSER_REGISTRATION:undefined,WALDO_ENVIRONMENT:'staging',WALDO_OWNER_DO_NAMESPACE:'fixture-app-owner',WALDO_OWNER_TIMEZONE:'UTC',WALDO_EGRESS_ALLOWLIST:'*',WALDO_TOOL_OFFLOAD:'0',SUPABASE_PROJECT_URL:DIRECTORY,SUPABASE_PUBLISHABLE_KEY:'fictional-public-key',WALDO_ROUTER_HMAC_SECRET:SECRET,BROWSER:{fetch:async()=>new Response('{}')} as never};
    let instance=new TelegramOwnerDO(state,settings);
    const observeTurn=()=>{const turn=(instance as any).turn.bind(instance);vi.spyOn(instance as any,'turn').mockImplementation(async(...args:any[])=>{try{return await turn(...args);}catch(error){proof.errors.push(error instanceof Error?error.stack??error.message:String(error));throw error;}});};observeTurn();
    state.storage.kv.put('do_name',name);state.storage.kv.put('origin','https://local.invalid');
    const headers={'x-waldo-do-name':name,'x-waldo-app-session-hash':SESSION,'content-type':'application/json'};
    const f={get instance(){return instance;},state,name,headers,settings,calls,sessionLive(value:boolean){live=value;},restart(){instance=new TelegramOwnerDO(state,settings);observeTurn();},async send(command:any,text='Read my public browser page.'){
      proof.command=command;proof.normalCalls=0;proof.outputs=[];
      const response=await instance.fetch(new Request('https://local.invalid/app/v1/chat/main/messages',{method:'POST',headers,body:JSON.stringify({client_message_id:`client-${crypto.randomUUID()}`,text})}));
      expect(response.status).toBe(202);const accepted=await response.json() as any;
      await vi.waitFor(async()=>{const record=state.storage.kv.get<any>(`app:inbox-record:${accepted.message_id}`);expect(record?.state).toMatch(/completed|failed|interrupted/);},{timeout:10000,interval:20});
      return accepted;
    }};
    try {await work(f);} finally {(instance as any).ownerBrowser.stop();await (instance as any).ownerBrowser.maintain();expect(commonBrowserFixture.pages).toHaveLength(0);await state.storage.deleteAlarm();fetcher.mockRestore();}
  });
}
const read=(session_handle?:string)=>({name:'browse_page',args:{provider:'cloudflare_playwright',retain_session:true,url:'https://example.com/a',instruction:'Read the owner page',...(session_handle?{session_handle}:{})}});

it('actual channel unlink keeps the retained owner browser and workspace while fencing the old channel epoch',async()=>withOwner(async f=>{
  const workspace=await workspaceOwnerHost(f.settings,f.state.storage,f.state.id.toString(),f.name);
  const note=await workspace.write({path:'channel-continuity.txt',bytes:new TextEncoder().encode('Owner workspace survives real channel route.'),mime:'text/plain',expected_revision:0,provenance:'agent_generated',operation_id:crypto.randomUUID()});
  await f.send(read()); expect(proof.outputs.at(-1),JSON.stringify(proof.errors)).toMatchObject({ok:true,data:{session_handle:expect.any(String)}});
  const handle=proof.outputs.at(-1).data.session_handle, before=f.state.storage.kv.get<any>('owner-public-browser-spend:v2');
  const locator={doName:f.name,actualDoId:f.state.id.toString(),expectedDoId:(name:string)=>env.TELEGRAM_OWNER_DO!.idFromName(name).toString(),assertCurrent:()=>{}};
  const authority=ownerRuntimeAuthority(f.settings), captured=await authority.resolve(locator);
  const inventory=await (await f.instance.fetch(new Request('https://local.invalid/app/v1/channels',{headers:f.headers}))).json() as any;
  expect(inventory.channels.find((row:any)=>row.provider==='telegram')).toMatchObject({state:'linked',unlink_available:true});
  expect(inventory.channels.find((row:any)=>row.provider==='imessage')).toMatchObject({state:'unavailable',reason:'integration_absent'});
  const args={operation_id:'unlink-owner-actual-01',provider:'telegram',expected_revision:'0:1'};
  const mutation=await f.instance.fetch(new Request('https://local.invalid/app/v1/channels/unlink',{method:'POST',headers:f.headers,body:JSON.stringify(args)}));
  expect(mutation.status).toBe(200);expect(await mutation.json()).toMatchObject({state:'recorded',revision:'0:2',owner_state:'preserved',authority:'channel_only'});
  await expect(authority.assertCurrent(captured,locator)).rejects.toThrow('owner runtime authority revoked');
  expect((await authority.resolve(locator)).ownerId).toBe(OWNER);
  const stale=await f.instance.fetch(new Request('https://local.invalid/app/v1/channels/unlink',{method:'POST',headers:f.headers,body:JSON.stringify({...args,operation_id:'unlink-owner-actual-02'})}));expect(stale.status).toBe(409);
  const noOp=await f.instance.fetch(new Request('https://local.invalid/app/v1/channels/unlink',{method:'POST',headers:f.headers,body:JSON.stringify({...args,operation_id:'unlink-owner-actual-03',expected_revision:'0:2'})}));expect(await noOp.json()).toMatchObject({state:'recorded',revision:'0:2'});
  f.restart(); await f.send(read(handle),'Continue my retained browser after unlinking the channel.');
  expect(proof.outputs.at(-1),JSON.stringify(proof.errors)).toMatchObject({ok:true,data:{session_handle:handle}});
  expect(commonBrowserFixture.allocations).toBe(1);expect(f.state.storage.kv.get<any>('owner-public-browser-spend:v2').custodyDigest).toBe(before.custodyDigest);
  expect((await workspace.read(note.file_id,note.revision,0,1024)).text).toContain('survives real channel route');expect(proof.telegramCalls).toBe(0);
  expect(f.calls).toContain('owner_channel_inventory');expect(f.calls).toContain('unlink_presence');
}),30000);

it('actual channel route denies foreign owner, wrong physical DO and revoked session before channel I/O',async()=>withOwner(async f=>{
  const first=f.calls.length;
  const foreign=await f.instance.fetch(new Request('https://local.invalid/app/v1/channels',{headers:{...f.headers,'x-waldo-do-name':'other-owner'}}));expect(foreign.status).toBe(403);expect(f.calls).toHaveLength(first);
  const other=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`wrong-${crypto.randomUUID()}`));
  await runInDurableObject(other,async(_instance,state)=>{const wrong=new TelegramOwnerDO(state,f.settings);const response=await wrong.fetch(new Request('https://local.invalid/app/v1/channels',{headers:f.headers}));expect(response.status).toBe(403);expect(state.storage.kv.get('do_name')).toBeUndefined();});
  f.sessionLive(false);const revoked=await f.instance.fetch(new Request('https://local.invalid/app/v1/channels',{headers:f.headers}));expect(revoked.status).toBe(401);
  expect(f.calls).not.toContain('owner_channel_inventory');expect(f.calls).not.toContain('unlink_presence');expect(commonBrowserFixture.allocations).toBe(0);
}));
