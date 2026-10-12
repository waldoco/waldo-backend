import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import {workspaceStore} from '@waldo/workspace';
import {workspaceOwnerHost} from '../src/channels/workspace-host';
import {registerCommonBrowserSdk} from '../src/channels/common-staging-registration';
import { commonBrowserFixture, commonBrowserMeteredFixtureLoader } from './fixtures/common-browser-sdk';

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
  const at=format?-1:proof.phase==='fresh'?14+proof.phaseCalls++:proof.normalCalls++;
  const calls=[
    {name:'browse_page',args:{provider:'cloudflare_playwright',retain_session:true,url:'https://example.com/a',instruction:'Read the public page'}},
    {name:'browse_act',args:{provider:'cloudflare_playwright',url:'https://example.com/a',task:'Set the note',max_actions:1,command:{operation:'type',element_ref:outputs[0]?.data?.elements[0]?.ref,value:'Owner retained note',intent:'read'}}},
    {name:'browse_act',args:{provider:'cloudflare_playwright',url:'https://example.com/a',task:'Select North',max_actions:1,command:{operation:'select',element_ref:outputs.at(-1)?.data?.elements.find((row:any)=>row.name==='Region')?.ref,value:'north'}}},
    {name:'browse_act',args:{provider:'cloudflare_playwright',url:'https://example.com/a',task:'Read another tab',max_actions:1,command:{operation:'open_tab',url:'https://www.iana.org/b'}}},
    {name:'browse_act',args:{provider:'cloudflare_playwright',session_handle:proof.sessionHandle,url:'https://www.iana.org/b',task:'Read current B',max_actions:1,command:{operation:'read'}}},
    {name:'browse_act',args:{provider:'cloudflare_playwright',session_handle:proof.sessionHandle,url:'https://www.iana.org/b',task:'Inspect current B',max_actions:1,command:{operation:'inspect'}}},
  ];
  const call=at===11?{name:'browse_act',args:{provider:'cloudflare_playwright',session_handle:proof.sessionHandle,url:'https://example.com/a',task:'Close my browser',max_actions:1,command:{operation:'cancel'}}}:at===14?{name:'browse_page',args:{provider:'cloudflare_playwright',retain_session:true,url:'https://example.com/a',instruction:'Start a new owner browser task'}}:at===8?{name:'browse_act',args:{provider:'cloudflare_playwright',session_handle:proof.sessionHandle,url:'https://example.com/a',task:'Apply my availability choice',max_actions:1,command:{operation:'set_checked',element_ref:outputs.at(-1)?.data?.elements.find((row:any)=>row.name==='Available only')?.ref,checked:true}}}:at===9?{name:'browse_act',args:{provider:'cloudflare_playwright',session_handle:proof.sessionHandle,url:'https://example.com/a',task:'Save my screenshot',max_actions:1,command:{operation:'screenshot'}}}:at===7?{name:'browse_act',args:{provider:'cloudflare_playwright',session_handle:proof.sessionHandle,url:'https://www.iana.org/b',task:'Return to my note',max_actions:1,command:{operation:'switch_tab',tab_ref:proof.tabRef}}}:calls[at];
  const read=Boolean(call);
  return { id: 'synthetic-public-browser-reply', output: read ? [{ type: 'function_call', call_id: `public-call-${at}`, name:call!.name, arguments:JSON.stringify(call!.args) }] : [],
    output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : read ? '' : 'Option A costs 10 fictional tokens; option B costs 20 fictional tokens. A was revisited. Shall I show available only?', usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async (method: string, payload: any) => {
  if (method === 'sendMessage') { proof.delivered.push(payload.text); return { message_id: proof.delivered.length,chat:{id:payload.chat_id} }; }
  return method === 'getMe' ? { username: 'public_browser_fixture_bot' } : true;
} }));

it('unregistered ordinary owner loop performs six observations, select/check, PNG delivery, continuation and exact cancellation without trial refill', async () => {
  commonBrowserFixture.reset();commonBrowserFixture.filters=true;
  const doName = proof.doName = `public-browser-two-arg-${crypto.randomUUID()}`, subject = Number(proof.subject);
  const now = Date.now(), ref = `public-proof-${crypto.randomUUID()}`;
  registerCommonBrowserSdk(commonBrowserMeteredFixtureLoader);
  const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(doName));
  await runInDurableObject(stub, async (_instance, state) => {
    const denied = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('live network forbidden'));
    const binding = { fetch: vi.fn(async () => new Response('{}', { status: 200 })) };
    const publicEnv = { ...env, COMMON_OWNER_TASKS: '0', WALDO_ENVIRONMENT: 'staging', LANGFUSE_CAPTURE_TEXT: 'true', WALDO_EGRESS_ALLOWLIST: '*', WALDO_TOOL_OFFLOAD: '0', BROWSER: binding as never, TELEGRAM_BOT_TOKEN: '12345:fictional', TELEGRAM_WEBHOOK_SECRET: 'synthetic-public-browser-secret', OPENAI_API_KEY: 'synthetic-model-key' };
    let instance = new TelegramOwnerDO(state, publicEnv);
    let updateId = 9981000;
    const send = async (text: string) => {
      const id = ++updateId;
      const response = await instance.fetch(new Request('https://local.invalid/enqueue', { method: 'POST', headers: { 'x-waldo-inbox-secret': publicEnv.TELEGRAM_WEBHOOK_SECRET, 'x-waldo-telegram-subject': String(subject), 'x-waldo-do-name': doName }, body: JSON.stringify({ update_id: id, message: { message_id: id, from: { id: subject, is_bot: false }, chat: { id: subject, type: 'private' }, text } }) }));
      expect(response.status).toBe(200);
      for (let i = 0; i < 8; i++) {
        await instance.alarm();
        const row = state.storage.kv.get<any[]>('telegram_owner_inbox_v1')?.find(row => row.updateId === id);
        if (row?.closedAt !== undefined || row?.state === 'completed' || row?.state === 'consumed') return;
      }
      throw Error('Owner turn did not finish');
    };
    try {
      state.storage.kv.put('origin','https://local.invalid');
      const workspace=await workspaceOwnerHost(publicEnv,state.storage,state.id.toString(),doName);
      await send('Use Cloudflare to read A, set my note, verify it, and open B in another tab.');
      // Final commitment closes inbox custody before asynchronous outbox delivery.
      await vi.waitFor(async () => { await instance.alarm(); expect(proof.delivered.some(text => text.includes('Option A costs 10') && text.includes('option B costs 20'))).toBe(true); }, { timeout: 3000, interval: 50 });
      expect(commonBrowserFixture.allocations).toBe(1);
      const replies = proof.inputs.filter(input => !input.text?.format);
      const final = replies.find(input => Array.isArray(input.input) && input.input.filter((item: any) => item.type === 'function_call_output').length === 6);
      expect(final).toBeDefined();
      const outputs = final.input.filter((item: any) => item.type === 'function_call_output').map((item: any) => JSON.parse(item.output));
      expect(outputs.every((row:any)=>row.ok===true)).toBe(true);
      expect(outputs.map((row:any)=>row.data.url)).toEqual(['https://example.com/a','https://example.com/a','https://example.com/a','https://www.iana.org/b','https://www.iana.org/b','https://www.iana.org/b']);
      expect(outputs[1].data.browser_action_session_handle).toBe(outputs[0].data.session_handle);expect(outputs[2].data.field_values[0].value).toBe('Owner retained note');
      expect(new Set(outputs.slice(0,2).map((row: any) => row.data.session_handle)).size).toBe(1);
      expect(outputs[2].data.elements.find((row:any)=>row.name==='Region').options.find((row:any)=>row.value==='north').selected).toBe(true);
      expect(outputs[0].data.accessibility_snapshot).toContain('Available only');
      expect(outputs[0].data.text).toContain('Option A costs 10'); expect(outputs[3].data.text).toContain('Option B costs 20');
      expect(JSON.stringify(final)).toContain('data:image/png;base64,iVBOR');
      expect(JSON.stringify(proof.inputs)).not.toContain('fixture-retained-provider');
      expect(proof.delivered.some(text => text.includes('Option A costs 10') && text.includes('option B costs 20'))).toBe(true);
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='owner_task_source_scope'").toArray()).toHaveLength(0);
      const records = [...state.storage.kv.list<any>({ prefix: 'common-browser:' })].map(([, row]) => row);
      expect(records).toHaveLength(1); expect(records[0]).toMatchObject({allocation:'observed',session:{state:'active'}});
      expect(commonBrowserFixture.ends).toBe(0);expect(commonBrowserFixture.pages).toHaveLength(2);
      expect(proof.delivered.some(text=>text.includes('Shall I show available only?'))).toBe(true);
      const continuationInputs=proof.inputs.length;
      const beforeContinuation=state.storage.kv.get<any>('owner-public-browser-spend:v2').reservations.length;
      await send(`Continue browser ${proof.sessionHandle}, return to my note and show available only.`);
      expect(proof.outputs[0]).toMatchObject({ok:true,data:{field_values:expect.arrayContaining([expect.objectContaining({name:'Note',value:'Owner retained note'})])}});
      expect(proof.outputs.find(row=>row.data?.elements?.find((element:any)=>element.name==='Available only'&&element.checked===true))).toBeDefined();
      const screenshot=proof.outputs.find(row=>row.data?.screenshot);
      expect(JSON.stringify(proof.inputs.slice(continuationInputs))).toContain('data:image/png;base64,iVBOR');
      const receipt=screenshot?.data.screenshot;expect(receipt).toMatchObject({audience:'owner_authenticated',retrieval:'verified'});
      const image=await workspace.export(receipt.file_id,receipt.revision);expect(image.meta.sha256).toBe(receipt.sha256);expect(image.bytes.slice(0,8)).toEqual(new Uint8Array([137,80,78,71,13,10,26,10]));
      expect(commonBrowserFixture.allocations).toBe(1);expect(commonBrowserFixture.attachments).toBe(1);
      expect(state.storage.kv.get<any>('owner-public-browser-spend:v2').reservations.length).toBe(beforeContinuation);
      expect(binding.fetch).toHaveBeenCalled(); expect(denied).not.toHaveBeenCalled();
      await send(`Cancel browser ${proof.sessionHandle}.`);
      expect(commonBrowserFixture.ends).toBe(1);expect(commonBrowserFixture.pages).toHaveLength(0);
      proof.phase='fresh';proof.phaseCalls=0;
      await send('Start a fresh Cloudflare browser task.');
      expect(proof.outputs.at(-1)).toMatchObject({ok:true,data:{text:expect.stringContaining('Option A costs 10')}});
      expect(commonBrowserFixture.allocations).toBe(2);
      await send('/stop');
      await vi.waitFor(()=>expect(commonBrowserFixture.ends).toBe(2));
      expect(commonBrowserFixture.pages).toHaveLength(0);
      expect(await (await commonBrowserMeteredFixtureLoader()).sessions(binding as never)).toEqual([]);
      instance = new TelegramOwnerDO(state, publicEnv);
      expect(commonBrowserFixture.allocations).toBe(2); expect(commonBrowserFixture.ends).toBe(2);
      const ledger=state.storage.kv.get<any>('owner-public-browser-spend:v2');
      expect(ledger.reservations).toHaveLength(2);expect(ledger.reservations.every((row:any)=>row.settled)).toBe(true);
      expect([...state.storage.kv.list({prefix:'common-spend:'})]).toHaveLength(0);expect(state.storage.kv.get('common_owner_browser_registration_v1')).toBeUndefined();
      const readTool=proof.inputs.flatMap(input=>input.tools??[]).find((tool:any)=>tool.name==='browse_page');
      expect(readTool.parameters.properties.retain_session).toBeDefined();
    } finally { await state.storage.deleteAlarm(); denied.mockRestore(); }
  });
});
