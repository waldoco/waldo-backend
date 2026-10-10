import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { handleGoogleCallback, googleConsentSecret } from '../src/channels/google-oauth';
import { readConsentState, sha256Hex } from '../src/connectors/google';
import { RunLoopDO } from '../src/run-loop/do';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { registerCommonBrowserSdk } from '../src/channels/common-staging-registration';
import { routerSignature } from '../src/identity/owner-directory';
import { workspaceOwnerHost } from '../src/channels/workspace-host';
import { commonBrowserFixture, commonBrowserMeteredFixtureLoader } from './fixtures/common-browser-sdk';

const proof = vi.hoisted(() => ({ normalCalls: 0, command: undefined as any, inputs: [] as any[], outputs: [] as any[], telegramCalls: 0, errors: [] as string[],proxyOps:[] as string[] }));
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

beforeEach(() => { commonBrowserFixture.reset(); proof.normalCalls=0; proof.command=undefined; proof.inputs=[]; proof.outputs=[]; proof.telegramCalls=0;proof.errors=[];proof.proxyOps=[]; });
const OWNER='10000000-0000-0000-0000-000000000001', AUTH_USER='20000000-0000-0000-0000-000000000001', SESSION='a'.repeat(64), DIRECTORY='https://app-owner-browser.fixture.invalid', SECRET='fictional-owner-router-secret-000000000000';
async function withOwner(work: (f: { instance: TelegramOwnerDO; state: DurableObjectState; name: string; headers: Record<string,string>; send(command: any, text?: string): Promise<any>; settings: any; sessionLive(value: boolean): void; calls: string[]; restart(): void }) => Promise<void>) {
  const name=`app-owner-browser-${crypto.randomUUID()}`, stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_instance,state) => {
    let live=true; const calls:string[]=[], expires=Date.now()+3600000;
    const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async (input,init) => {
      const url=new URL(String(input));
      if(url.origin===DIRECTORY&&url.pathname==='/functions/v1/connector-proxy'){
        const raw=String(init?.body),body=JSON.parse(raw),headers=new Headers(init?.headers),at=Number(headers.get('x-waldo-at'));
        expect(headers.get('x-waldo-sig')).toBe(await routerSignature(SECRET,at,`proxy.${await sha256Hex(raw)}`));expect(body.do_name).toBe(name);proof.proxyOps.push(body.op==='call'?body.method:body.op);
        if(body.op==='exchange')return Response.json({id:'fixture-google-connection',email:'owner@example.test',scopes:['https://www.googleapis.com/auth/calendar.readonly']});
        if(body.op==='call'&&body.method==='events')return Response.json({data:[]});throw Error('unlisted provider operation');
      }
      if(url.origin!==DIRECTORY||!url.pathname.startsWith('/rest/v1/rpc/'))throw Error('unlisted outbound network forbidden');
      const fn=url.pathname.split('/').at(-1)!,args=JSON.parse(String(init?.body));calls.push(fn);
      const message=fn==='console_session_list'?`consolesess.list.${args.p_do_name}`:fn==='app_session_authority'?`app.session.${args.p_do_name}.${args.p_session_hash}`:fn==='owner_runtime_authority'?`owner.runtime.${args.p_do_name}`:undefined;
      if(message)expect(args.p_sig).toBe(await routerSignature(SECRET,args.p_at,message));
      if(fn==='console_session_list')return Response.json(live&&args.p_do_name===name?[{session:SESSION,created_at:new Date().toISOString(),last_seen_at:new Date().toISOString()}]:[]);
      if(fn==='app_session_authority')return Response.json(live&&args.p_do_name===name&&args.p_session_hash===SESSION?{owner_id:OWNER,do_name:name,session_hash:SESSION,state_version:0,admission_revision:'1',expires_at:expires}:null);
      if(fn==='owner_runtime_authority')return Response.json(args.p_do_name===name?{owner_id:OWNER,auth_user_id:AUTH_USER,do_name:name,state_version:0,admission_revision:'1'}:null);
      if(fn==='workspace_owner_binding')return Response.json({owner_id:OWNER,environment:'staging',namespace:'fixture-app-owner',do_name:name,do_id:state.id.toString(),state_version:0,mapping_version:1});
      if(fn==='connect_session_issue'){expect(args.p_channel).toBe('console');expect(args.p_sig).toBe(await routerSignature(SECRET,args.p_at,`connsess.issue.${name}.google.console.${args.p_ticket_hash}`));return Response.json('30000000-0000-0000-0000-000000000001');}
      if(fn==='connect_session_complete')return Response.json(true);
      if(fn==='health_context_read')return Response.json(null);
      if(fn==='health_plane')return Response.json(null);
      throw Error(`unlisted signed directory RPC ${fn}`);
    });
    const settings={...env,TELEGRAM_BOT_TOKEN:undefined,TELEGRAM_WEBHOOK_SECRET:undefined,WALDO_OWNER_TELEGRAM_ID:undefined,GOOGLE_CLIENT_ID:'fixture-client',GOOGLE_CLIENT_SECRET:'fixture-secret',OPENAI_API_KEY:'synthetic-model-key',COMMON_OWNER_TASKS:'0',COMMON_BROWSER_REGISTRATION:undefined,WALDO_ENVIRONMENT:'staging',WALDO_OWNER_DO_NAMESPACE:'fixture-app-owner',WALDO_OWNER_TIMEZONE:'UTC',WALDO_EGRESS_ALLOWLIST:'*',WALDO_TOOL_OFFLOAD:'0',SUPABASE_PROJECT_URL:DIRECTORY,SUPABASE_PUBLISHABLE_KEY:'fictional-public-key',WALDO_ROUTER_HMAC_SECRET:SECRET,BROWSER:{fetch:async()=>new Response('{}')} as never};
    const actualRoots=env.RUN_LOOP_DO!;
    settings.RUN_LOOP_DO={idFromName:(name:string)=>actualRoots.idFromName(name),get:(id:DurableObjectId)=>({readOwnerWorkProjectionFromHost:async(request:any)=>runInDurableObject(actualRoots.get(id),async(_root,rootState)=>new RunLoopDO(rootState,settings as never).readOwnerWorkProjectionFromHost(request))})} as never;
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


it('actual canonical app-only Google connect/callback uses fixed app return and single exchanged/readback grant without Telegram',async()=>withOwner(async f=>{
  const response=await f.instance.fetch(new Request('https://local.invalid/app/v1/access/connect',{method:'POST',headers:f.headers,body:JSON.stringify({operation_id:'native-connect-0001',provider:'google',mode:'connect',feature:'calendar'})}));
  expect(response.status).toBe(200);const receipt=await response.json() as any;expect(receipt.state,JSON.stringify(receipt)).toBe('recorded');
  // Connect links use the existing ticket hash normalization.
  const actualHash=[...f.state.storage.kv.list<string>({prefix:'connect_surface:'})][0]![0].slice('connect_surface:'.length);
  expect(actualHash).toHaveLength(64);expect(f.state.storage.kv.get(`connect_auth:${actualHash}`)).toBe(SESSION);
  const begin=await f.instance.fetch(new Request('https://local.invalid/google/begin-session',{method:'POST',body:JSON.stringify({ticket_hash:actualHash})}));
  const url=new URL((await begin.json() as any).url),signed=url.searchParams.get('state')!;
  const parsed=await readConsentState(googleConsentSecret(f.settings)!,signed);expect(parsed).toMatchObject({owner:f.name,surface:'app'});
  const callbackEnv={...f.settings,TELEGRAM_OWNER_DO:{idFromName:(name:string)=>name,get:(name:string)=>({fetch:async(url:string,init:RequestInit)=>{expect(name).toBe(f.name);return f.instance.fetch(new Request(url,init));}})}} as never;
  const callback=()=>handleGoogleCallback(new Request(`https://local.invalid/oauth/google/callback?state=${encodeURIComponent(signed)}&code=synthetic-approved-code`),callbackEnv);
  const landed=await callback();expect(landed.status).toBe(200);expect(await landed.text()).toContain('waldo://oauth/complete');
  expect(proof.proxyOps).toEqual(['exchange','events']);expect(f.state.storage.kv.get<any[]>('google:accounts')).toMatchObject([{id:'fixture-google-connection',email:'owner@example.test'}]);
  expect((await callback()).status).toBe(200);expect(proof.proxyOps).toEqual(['exchange','events']);expect(proof.telegramCalls).toBe(0);
}),30000);

it('issued app OAuth attempt rejects a revoked originating session before any provider exchange',async()=>withOwner(async f=>{
  const response=await f.instance.fetch(new Request('https://local.invalid/app/v1/access/connect',{method:'POST',headers:f.headers,body:JSON.stringify({operation_id:'native-connect-revoke',provider:'google',mode:'connect',feature:'calendar'})}));expect(response.status).toBe(200);
  const hash=[...f.state.storage.kv.list<string>({prefix:'connect_surface:'})][0]![0].slice('connect_surface:'.length);f.sessionLive(false);
  await expect(f.instance.fetch(new Request('https://local.invalid/google/begin-session',{method:'POST',body:JSON.stringify({ticket_hash:hash})}))).rejects.toThrow();expect(proof.proxyOps).toEqual([]);expect(proof.telegramCalls).toBe(0);
}));

it('actual Work approval dispatch captures fresh main audience independently of an older paused thread and closed scope',async()=>withOwner(async f=>{
  expect((await f.instance.fetch(new Request('https://local.invalid/app/v1/chat/main',{headers:f.headers}))).status).toBe(200);
  const principal=`prn_${OWNER.replaceAll('-','')}`,conversationRef=`owner:${principal}`,scope=(f.instance as any).requestScope('fixture-control-request'),control={owner:f.name,hash:SESSION,scope,conversationRef,runRef:scope.runId,assertCurrent:async()=>{scope.admit();if(!(await (f.instance as any).appSessionCurrent(SESSION,f.name)))throw Error('revoked');}};
  const runtime=(f.instance as any).setup('app',control);await runtime.ready;const id=await runtime.desk.proposeSendMessage({channel:'app',content:'Exact words approved from the current native Work audience.',idempotency_key:'native-audience-proof'});
  const other=`${conversationRef}:thread:older-paused`;(f.instance as any).activeApp={id:'older-run',owner:f.name,sessionHash:'b'.repeat(64),conversationRef:other};(f.instance as any).activeScope={admit:()=>{throw Error('older scope closed');}};
  try{
    const projected=await f.instance.fetch(new Request('https://local.invalid/app/v1/work',{headers:f.headers}));expect(projected.status,JSON.stringify(proof.errors)).toBe(200);const projection=await projected.json() as any,proposal=projection.approvals.find((row:any)=>row.id===id);expect(proposal.actions).toContain('approve');
    const result=await f.instance.fetch(new Request('https://local.invalid/app/v1/work/approvals',{method:'POST',headers:f.headers,body:JSON.stringify({operation_id:'native-audience-approve',approval_id:id,action:'approve',proposal_digest:proposal.proposal_digest,expected_source_revision:projection.source_revision,projection_revision:projection.revision})}));
    expect(result.status).toBe(200);expect((await result.json() as any).receipt).toMatchObject({state:'recorded',external_effects:'verified'});
    const delivered=[...f.state.storage.kv.list<any>({prefix:'app:delivery:'})].map(([,row])=>row).filter(row=>row.text==='Exact words approved from the current native Work audience.');expect(delivered).toHaveLength(1);expect(delivered[0]).toMatchObject({conversationRef,parent_id:null});expect(proof.telegramCalls).toBe(0);
  }finally{(f.instance as any).activeApp=null;(f.instance as any).activeScope=undefined;}
}),30000);

it('fresh same-owner native read during browser allocation preserves canonical authority object and successful browser receipt',async()=>withOwner(async f=>{
  commonBrowserFixture.onAcquire=async()=>{expect((await f.instance.fetch(new Request('https://local.invalid/app/v1/chat/main',{headers:f.headers}))).status).toBe(200);};
  await f.send({name:'browse_page',args:{provider:'cloudflare_playwright',retain_session:true,url:'https://example.com/a',instruction:'Read the owner page'}});
  expect(proof.outputs.at(-1),JSON.stringify(proof.errors)).toMatchObject({ok:true,data:{session_handle:expect.any(String)}});expect(proof.telegramCalls).toBe(0);
}),30000);
