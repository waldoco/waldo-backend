import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { registerCommonBrowserSdk } from '../src/channels/common-staging-registration';
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
  const name=`app-owner-browser-${crypto.randomUUID()}`, stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_instance,state) => {
    let live=true; const calls:string[]=[], expires=Date.now()+3600000;
    const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async (input,init) => {
      const url=new URL(String(input)); if(url.origin!==DIRECTORY||!url.pathname.startsWith('/rest/v1/rpc/'))throw Error('unlisted outbound network forbidden');
      const fn=url.pathname.split('/').at(-1)!,args=JSON.parse(String(init?.body));calls.push(fn);
      const message=fn==='console_session_list'?`consolesess.list.${args.p_do_name}`:fn==='app_session_authority'?`app.session.${args.p_do_name}.${args.p_session_hash}`:fn==='owner_runtime_authority'?`owner.runtime.${args.p_do_name}`:undefined;
      if(message)expect(args.p_sig).toBe(await routerSignature(SECRET,args.p_at,message));
      if(fn==='console_session_list')return Response.json(live&&args.p_do_name===name?[{session:SESSION,created_at:new Date().toISOString(),last_seen_at:new Date().toISOString()}]:[]);
      if(fn==='app_session_authority')return Response.json(live&&args.p_do_name===name&&args.p_session_hash===SESSION?{owner_id:OWNER,do_name:name,session_hash:SESSION,state_version:0,admission_revision:'1',expires_at:expires}:null);
      if(fn==='owner_runtime_authority')return Response.json(args.p_do_name===name?{owner_id:OWNER,auth_user_id:AUTH_USER,do_name:name,state_version:0,admission_revision:'1'}:null);
      if(fn==='workspace_owner_binding')return Response.json({owner_id:OWNER,environment:'staging',namespace:'fixture-app-owner',do_name:name,do_id:state.id.toString(),state_version:0,mapping_version:1});
      if(fn==='health_context_read')return Response.json(null);
      if(fn==='health_plane')return Response.json(null);
      throw Error(`unlisted signed directory RPC ${fn}`);
    });
    const settings={...env,TELEGRAM_BOT_TOKEN:undefined,TELEGRAM_WEBHOOK_SECRET:undefined,WALDO_OWNER_TELEGRAM_ID:undefined,OPENAI_API_KEY:'synthetic-model-key',COMMON_OWNER_TASKS:'0',COMMON_BROWSER_REGISTRATION:undefined,WALDO_ENVIRONMENT:'staging',WALDO_OWNER_DO_NAMESPACE:'fixture-app-owner',WALDO_OWNER_TIMEZONE:'UTC',WALDO_EGRESS_ALLOWLIST:'*',WALDO_TOOL_OFFLOAD:'0',SUPABASE_PROJECT_URL:DIRECTORY,SUPABASE_PUBLISHABLE_KEY:'fictional-public-key',WALDO_ROUTER_HMAC_SECRET:SECRET,BROWSER:{fetch:async()=>new Response('{}')} as never};
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

it('actual app-only owner serving factory retains one browser/workspace across surface link changes and DO restart',async()=>withOwner(async f=>{
  expect(f.settings.TELEGRAM_BOT_TOKEN).toBeUndefined();expect(f.state.storage.kv.get('telegram_subject')).toBeUndefined();
  const workspace=await workspaceOwnerHost(f.settings,f.state.storage,f.state.id.toString(),f.name);
  const note=await workspace.write({path:'owner-note.txt',bytes:new TextEncoder().encode('Canonical owner workspace survives surface unlink.'),mime:'text/plain',expected_revision:0,provenance:'agent_generated',operation_id:crypto.randomUUID()});
  const accepted=await f.send(read());
  expect(proof.outputs.at(-1),JSON.stringify({outputs:proof.outputs,errors:proof.errors})).toMatchObject({ok:true,data:{text:expect.stringContaining('Option A costs 10'),session_handle:expect.any(String)}});
  const handle=proof.outputs.at(-1).data.session_handle;
  const before=f.state.storage.kv.get<any>('owner-public-browser-spend:v2');expect(before.reservations).toHaveLength(1);
  expect(commonBrowserFixture.allocations).toBe(1);
  f.state.storage.kv.put('telegram_subject','81101');f.state.storage.kv.put('whatsapp_subject','15555550101');f.state.storage.kv.put('telegram_unlinked',false);
  await expect(f.instance.alarm()).resolves.toBeUndefined();
  await f.send(read(handle),'Continue the same browser after linking my surfaces.');
  expect(proof.outputs.at(-1)).toMatchObject({ok:true,data:{session_handle:handle}});
  f.state.storage.kv.delete('telegram_subject');f.state.storage.kv.delete('whatsapp_subject');f.state.storage.kv.put('telegram_unlinked',true);f.state.storage.kv.put('whatsapp_unlinked',true);f.restart();
  await expect(f.instance.alarm()).resolves.toBeUndefined();
  await f.send(read(handle),'Continue the owner browser after unlinking my surfaces.');
  expect(proof.outputs.at(-1)).toMatchObject({ok:true,data:{session_handle:handle}});
  expect(commonBrowserFixture.allocations).toBe(1);expect(f.state.storage.kv.get<any>('owner-public-browser-spend:v2').reservations).toHaveLength(1);
  expect(f.state.storage.kv.get<any>('owner-public-browser-spend:v2').custodyDigest).toBe(before.custodyDigest);
  expect((await workspace.read(note.file_id,note.revision,0,1024)).text).toContain('survives surface unlink');
  const page=await (await f.instance.fetch(new Request('https://local.invalid/app/v1/chat/main',{headers:f.headers}))).json() as any;
  expect(page.messages.find((m:any)=>m.role==='assistant'&&m.text.includes('I read the owner page'))).toMatchObject({channel:'app',parent_id:expect.any(String)});
  expect(page.messages.some((m:any)=>m.id===accepted.message_id)).toBe(true);expect(proof.telegramCalls).toBe(0);
  expect(f.calls).toContain('app_session_authority');expect(f.calls).toContain('owner_runtime_authority');expect(f.calls).not.toContain('common_owner_authority');
  await f.send({name:'browse_act',args:{provider:'cloudflare_playwright',session_handle:handle,url:'https://example.com/a',task:'Cancel my browser',max_actions:1,command:{operation:'cancel'}}},'Cancel my retained browser.');
  expect(commonBrowserFixture.ends).toBe(1);expect(f.state.storage.kv.get<any>('owner-public-browser-spend:v2').reservations[0].settled).toBe(true);
}),30000);

it('actual app serving route rejects foreign owner and revoked session without browser allocation',async()=>withOwner(async f=>{
  const foreign=await f.instance.fetch(new Request('https://local.invalid/app/v1/chat/main',{headers:{...f.headers,'x-waldo-do-name':'other-owner'}}));expect(foreign.status).toBe(403);
  f.sessionLive(false);const revoked=await f.instance.fetch(new Request('https://local.invalid/app/v1/chat/main',{headers:f.headers}));expect(revoked.status).toBe(401);
  expect(commonBrowserFixture.allocations).toBe(0);expect(f.state.storage.kv.get('do_name')).toBe(f.name);
}));

it('actual app serving route rejects a wrong physical DO before directory or provider I/O',async()=>withOwner(async f=>{
  const other=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`wrong-${crypto.randomUUID()}`));
  await runInDurableObject(other,async(_instance,state)=>{const owner=new TelegramOwnerDO(state,f.settings),before=f.calls.length;const response=await owner.fetch(new Request('https://local.invalid/app/v1/chat/main',{headers:f.headers}));expect(response.status).toBe(403);expect(f.calls).toHaveLength(before);expect(state.storage.kv.get('do_name')).toBeUndefined();});
  expect(commonBrowserFixture.allocations).toBe(0);
}));

it('session revocation during provider await fences tool publication and app delivery',async()=>withOwner(async f=>{
  commonBrowserFixture.onGoto=()=>f.sessionLive(false);
  await f.send(read());
  expect(commonBrowserFixture.allocations,JSON.stringify(proof.errors)).toBe(1);expect(commonBrowserFixture.navigations).toBe(1);expect(proof.outputs.every(row=>row.ok!==true),JSON.stringify(proof.outputs)).toBe(true);
  expect([...f.state.storage.kv.list<any>({prefix:'common-browser:'})].every(([,row])=>row.observation===undefined)).toBe(true);
  const journal=[...f.state.storage.kv.list<any>({prefix:'app:delivery:'})];expect(JSON.stringify(journal)).not.toContain('I read the owner page');
  expect(proof.telegramCalls).toBe(0);
}),30000);


it('owner rights lock rejects app/browser admission while retaining existing owner storage for cleanup',async()=>withOwner(async f=>{
  f.state.storage.kv.put('preserved-owner-agent',{owner:OWNER,workspace:'retained'});f.state.storage.kv.put('rights:owner-lock',{receipt:'fictional-lock',at:Date.now()});
  const before=f.calls.length;const response=await f.instance.fetch(new Request('https://local.invalid/app/v1/chat/main',{headers:f.headers}));
  expect(response.status).toBe(401);expect(f.calls).toHaveLength(before);expect(commonBrowserFixture.allocations).toBe(0);
  expect(f.state.storage.kv.get('preserved-owner-agent')).toEqual({owner:OWNER,workspace:'retained'});
}));
