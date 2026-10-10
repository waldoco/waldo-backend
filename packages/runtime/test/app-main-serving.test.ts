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

it('actual main serving consumes owner file and reviewed voice bytes and reads same-ID receipt after restart without replay',async()=>withOwner(async f=>{
  const workspace=await workspaceOwnerHost(f.settings,f.state.storage,f.state.id.toString(),f.name);
  const image=await workspace.write({path:'fixture.png',bytes:Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII='),c=>c.charCodeAt(0)),mime:'image/png',expected_revision:0,provenance:'owner_upload',operation_id:crypto.randomUUID()});
  const voice=await workspace.write({path:'fixture.wav',bytes:new Uint8Array([82,73,70,70]),mime:'audio/wav',expected_revision:0,provenance:'owner_upload',operation_id:crypto.randomUUID()});
  const clientId=`client-${crypto.randomUUID()}`,body={client_message_id:clientId,text:'Use my attached picture and reviewed voice note.',attachment_refs:[{file_id:image.file_id,revision:image.revision}],voice:{original:{file_id:voice.file_id,revision:voice.revision},processing:'owner_reviewed',transcript:'The owner reviewed this fixture transcript.'}};
  const request=()=>new Request('https://local.invalid/app/v1/chat/main/messages',{method:'POST',headers:f.headers,body:JSON.stringify(body)});
  const response=await f.instance.fetch(request());expect(response.status).toBe(202);const accepted=await response.json() as any;
  await vi.waitFor(()=>expect(f.state.storage.kv.get<any>(`app:inbox-record:${accepted.message_id}`)?.state).toBe('completed'),{timeout:10000,interval:20});
  const model=proof.inputs.filter(row=>!row.text?.format);expect(model.length).toBeGreaterThan(0);
  expect(JSON.stringify(model)).toContain('data:image/png;base64,');expect(JSON.stringify(model)).toContain('The owner reviewed this fixture transcript.');expect(JSON.stringify(model)).toContain(`workspace:${voice.file_id}:${voice.revision}`);
  const calls=proof.inputs.length;f.restart();
  const readback=await f.instance.fetch(new Request(`https://local.invalid/app/v1/chat/main/messages/${clientId}`,{headers:f.headers}));expect(readback.status).toBe(200);expect(await readback.json()).toMatchObject({message_id:accepted.message_id,state:'completed'});
  const duplicate=await f.instance.fetch(request());expect(duplicate.status).toBe(202);expect(await duplicate.json()).toMatchObject({message_id:accepted.message_id,state:'completed'});expect(proof.inputs.length).toBe(calls);expect(proof.telegramCalls).toBe(0);
}),30000);

it('actual main media ingress rejects stale or foreign files before durable admission',async()=>withOwner(async f=>{
  const clientId=`client-${crypto.randomUUID()}`;
  const response=await f.instance.fetch(new Request('https://local.invalid/app/v1/chat/main/messages',{method:'POST',headers:f.headers,body:JSON.stringify({client_message_id:clientId,text:'Read the selected file.',attachment_refs:[{file_id:crypto.randomUUID(),revision:1}]})}));
  expect(response.status).toBeGreaterThanOrEqual(400);expect([...f.state.storage.kv.list({prefix:'app:inbox-record:'})]).toHaveLength(0);expect(proof.inputs).toHaveLength(0);expect(proof.telegramCalls).toBe(0);
}));
