import { expect, it } from 'vitest';
import { browseActArgsSchema } from '@waldo/contracts';
import { browseActHandler, executeBrowserSubmit } from '../src/tools/live/browser';
import { browserTaskHandler, browserTaskApprovalBridge } from '../src/tools/live/browser-task';
import type { BrowserSubmitProposal } from '../src/channels/approvals';

const context = { authenticatedUserId: 'owner-a', assertTaskSourceCurrent: async () => {} } as never;
it('preserves free-text legacy calls and never falls back for a typed command without a host', async () => {
  let legacyCalls = 0;
  const legacy = { ...browseActHandler(undefined, undefined, undefined), handle: async () => { legacyCalls++; return { ok: true as const, data: { legacy: true }, source_taint: 'external' as const }; } };
  const handler = browserTaskHandler({ legacy, host: async () => null, propose: async () => 'must-not-propose' });
  expect(await handler.handle(browseActArgsSchema.parse({ url: 'https://fixture.example/form', task: 'read' }), context)).toMatchObject({ ok: true, data: { legacy: true } });
  expect(await handler.handle(browseActArgsSchema.parse({ url: 'https://fixture.example/form', task: 'inspect', command: { operation: 'inspect' } }), context)).toMatchObject({ ok: false, code: 'rejected', source_taint: 'external' });
  expect(legacyCalls).toBe(1);
});

it('routes prepare-submit into the existing approval payload and exposes no private session', async () => {
  let payload: BrowserSubmitProposal | undefined, approved = 0;
  const scopeDigest = `sha256:${'a'.repeat(64)}`;
  const host = { taskRef: 'task-one', pageUrl: 'https://fixture.example/form', read: async (owner: string) => { expect(owner).toBe('owner-a'); return { url: 'https://fixture.example/form', binding: { value: 'synthetic' } }; }, propose: async () => ({ id: 'prepared-one', url: 'https://fixture.example/form', actionRef: '#submit', scopeDigest, binding: { value: 'synthetic' } }), validateProposal: async () => true, validateReceipt: async () => true, submit: async (_owner: string, id: string, approval: string) => { expect(id).toBe('prepared-one'); expect(approval).toBe('fresh-desk-approval'); approved++; return { status: 'acknowledged_unverified' as const, message: 'not verified' }; } };
  const handler = browserTaskHandler({ legacy: browseActHandler(undefined, undefined, undefined), host: async () => host as never, propose: async next => { payload = next; return 'desk-proposal'; } });
  const prepared = await handler.handle(browseActArgsSchema.parse({ url: host.pageUrl, task: 'prepare', command: { operation: 'prepare_submit' } }), context);
  expect(prepared).toMatchObject({ ok: true, data: { stopped: 'approval_pending', proposal_id: 'desk-proposal' }, source_taint: 'external' });
  expect(payload).toMatchObject({ binding: { value: 'synthetic' }, continuation: { version: 1, taskRef: 'task-one', proposalId: 'prepared-one', scopeDigest } });
  expect(approved).toBe(0);
  const bridge = browserTaskApprovalBridge({ ownerId: 'owner-a', host: async () => host as never });
  expect(await bridge.submit(payload!)).toMatchObject({ status: 'rejected' });
  await bridge.submit(payload!, 'fresh-desk-approval'); expect(approved).toBe(1);
});

it('the old fresh-session submit executor rejects continuation proposals before any provider request', async () => {
  let calls = 0;
  const proposal: BrowserSubmitProposal = { url: 'https://fixture.example/form', action: { selector: '#submit', method: 'click', description: 'Submit' }, binding: { value: 'synthetic' }, steps: [], continuation: { version: 1, taskRef: 'task-one', proposalId: 'prepared-one', scopeDigest: `sha256:${'a'.repeat(64)}` } };
  expect(await executeBrowserSubmit('key', 'project', undefined, proposal, (async () => { calls++; throw Error('must not call'); }) as typeof fetch)).toMatchObject({ status: 'rejected' });
  expect(calls).toBe(0);
});
it('reports fenced actions with unresolved physical cleanup honestly', async () => {
  const host = { pageUrl: 'https://fixture.example/form', cancel: async () => ({ stopped: 'cleanup_pending', actions_fenced: true }) };
  const handler = browserTaskHandler({ legacy: browseActHandler(undefined, undefined, undefined), host: async () => host as never, stopAdmission: async () => {}, propose: async () => 'unused' });
  expect(await handler.handle(browseActArgsSchema.parse({ url: host.pageUrl, task: 'stop', command: { operation: 'cancel' } }), context)).toMatchObject({ ok: true, data: { stopped: 'cleanup_pending', actions_fenced: true } });
});
it('can retry publication after the approval desk throws without repeating submit', async () => {
  const { browserTaskContinuity } = await import('../src/channels/browser-task-continuity');
  const { fixtureDigest } = await import('../src/channels/public-fixture-browser');
  let row: unknown = null, clicks = 0, publications = 0;
  const host = browserTaskContinuity({ enabled: true, ownerId: 'owner-a', taskId: 'publish-run', manifestDigest: `sha256:${'a'.repeat(64)}`, now: () => 1, newId: () => crypto.randomUUID(), admit: async () => 'host-grant',
    store: { exclusive: async work => work(), load: async () => row, save: async next => { row = next; } },
    driver: { provider: 'cloudflare_playwright', origin: 'https://fixture.example', pageUrl: 'https://fixture.example/form', runId: 'publish-run', submitRef: '#submit', start: async () => 'private-session', navigate: async () => {}, inspect: async () => ({ url: 'https://fixture.example/form', binding: { value: 'synthetic' }, stateDigest: await fixtureDigest({ value: 'synthetic' }) }), fill: async () => {}, submit: async () => { clicks++; }, verify: async () => null, end: async () => {} },
  });
  await host.open('owner-a');
  const handler = browserTaskHandler({ legacy: browseActHandler(undefined, undefined, undefined), host: async () => host, propose: async () => { if (++publications === 1) throw Error('desk unavailable'); return 'published-desk-proposal'; } });
  const args = browseActArgsSchema.parse({ url: host.pageUrl, task: 'prepare', command: { operation: 'prepare_submit' } });
  expect(await handler.handle(args, context)).toMatchObject({ ok: false });
  expect(await handler.handle(args, context)).toMatchObject({ ok: true, data: { proposal_id: 'published-desk-proposal' } });
  expect(clicks).toBe(0); expect(publications).toBe(2);
});
it('requires independent stop admission and fences it before task cleanup', async () => {
  const events: string[] = [], host = { pageUrl: 'https://fixture.example/form', cancel: async () => { events.push('cleanup'); return { stopped: 'cancelled', actions_fenced: true }; } };
  const base = { legacy: browseActHandler(undefined, undefined, undefined), host: async () => host as never, propose: async () => 'unused' };
  const args = browseActArgsSchema.parse({ url: host.pageUrl, task: 'stop', command: { operation: 'cancel' } });
  expect(await browserTaskHandler(base).handle(args, context)).toMatchObject({ ok: false }); expect(events).toEqual([]);
  await browserTaskHandler({ ...base, stopAdmission: async () => { events.push('revoked'); } }).handle(args, context);
  expect(events).toEqual(['revoked','cleanup']);
});

it('withholds a typed observation and proposal after the captured task source is withdrawn', async () => {
  let allowed = true, proposed = 0;
  const host = { pageUrl: 'https://fixture.example/form', read: async () => { allowed = false; return { binding: { value: 'stale' } }; }, propose: async () => { allowed = false; return {}; } };
  const ctx = { authenticatedUserId: 'owner-a', assertTaskSourceCurrent: async () => { if (!allowed) throw Error('narrowed to supplied only'); } } as never;
  const handler = browserTaskHandler({ legacy: browseActHandler(undefined, undefined, undefined), host: async () => host as never, propose: async () => { proposed++; return 'stale'; } });
  const args = browseActArgsSchema.parse({ url: host.pageUrl, task: 'inspect', command: { operation: 'inspect' } });
  expect(await handler.handle(args, ctx)).toMatchObject({ ok: false }); expect(proposed).toBe(0);
});
it('projects closed-command snapshots as text and refs and refuses a declared-send-only hold without a card or success claim', async () => {
  let cards = 0, send = false;
  const host = { pageUrl: 'https://fixture.example/form', command: async () => send ? { held: true, reason: 'declared_send_unsupported' } : { held: false, snapshot: { url: 'https://fixture.example/form', text: 'Synthetic page', elements: [{ ref: 'value' }], binding: { value: 'synthetic' }, stateDigest: 'private-host-digest', session_id: 'private-provider-id' } } };
  const handler = browserTaskHandler({ legacy: browseActHandler(undefined, undefined, undefined), host: async () => host as never, propose: async () => { cards++; return 'must-not-publish'; } });
  const args = browseActArgsSchema.parse({ url: host.pageUrl, task: 'Lying description: submit is only a read', command: { operation: 'read' } });
  const result = await handler.handle(args, context);
  expect(result).toEqual({ ok: true, data: { url: host.pageUrl, text: 'Synthetic page', elements: [{ ref: 'value' }] }, source_taint: 'external' });
  send = true;
  expect(await handler.handle(args, context)).toMatchObject({ ok: false, code: 'rejected' });
  expect(cards).toBe(0);
});

it.each(['desk', 'source'] as const)('closes an unpublished native hold when %s admission/publication fails', async failure => {
  const { browserTaskContinuity } = await import('../src/channels/browser-task-continuity');
  const { syntheticCommandAdapter } = await import('../src/channels/browser-synthetic-commands');
  let row: unknown = null, alive = false, posts = 0, closes = 0;
  const driver = syntheticCommandAdapter({ origin: 'https://fixture.example', pageUrl: 'https://fixture.example/form', runId: 'run', submitRef: '#submit', transport: {
    start: async () => { alive = true; return 'fake-id'; },
    observe: async () => ({ url: 'https://fixture.example/form', text: 'Form', elements: [{ ref: 'value', tag: 'input', type: 'text', field: 'value', inForm: true }, { ref: '#submit', tag: 'button', type: 'submit', inForm: true }], form: { action: 'https://fixture.example/submit', method: 'POST', values: { value: 'synthetic' } } }),
    execute: async (_id, command) => { if (command.operation === 'click') posts++; },
    close: async () => { closes++; alive = false; }, absent: async () => !alive, verify: async () => null,
  } });
  const host = browserTaskContinuity({ enabled: true, ownerId: 'owner-a', taskId: 'run', manifestDigest: `sha256:${'a'.repeat(64)}`, driver, now: () => 100, newId: () => crypto.randomUUID(), admit: async () => 'grant',
    store: { exclusive: work => work(), load: async () => row, save: async value => { row = value; } },
  });
  const handler = browserTaskHandler({ legacy: browseActHandler(undefined, undefined, undefined), host: async () => host, propose: async () => { throw Error('desk unavailable'); } });
  let sourceChecks = 0;
  const guardedContext = { authenticatedUserId: 'owner-a', assertTaskSourceCurrent: async () => { if (failure === 'source' && ++sourceChecks > 2) throw Error('source revoked'); } } as never;
  expect(await handler.handle(browseActArgsSchema.parse({ url: host.pageUrl, task: 'read', command: { operation: 'click', element_ref: '#submit', intent: 'read' } }), guardedContext)).toMatchObject({ ok: false });
  expect(posts).toBe(0); expect(closes).toBe(1); expect(alive).toBe(false); expect(row).toMatchObject({ phase: 'closed', session: { state: 'ended' } });
});

it.each(['scroll','read','wait'] as const)('only landed %s produces a host-local action session receipt',async operation=>{
 const {browserTaskContinuity}=await import('../src/channels/browser-task-continuity');
 const {syntheticCommandAdapter}=await import('../src/channels/browser-synthetic-commands');
 let row:unknown=null,alive=false;
 const driver=syntheticCommandAdapter({origin:'https://fixture.example',pageUrl:'https://fixture.example/form',runId:'run',submitRef:'#submit',transport:{
  start:async()=>{alive=true;return 'PRIVATE_PROVIDER_ID';},observe:async()=>({url:'https://fixture.example/form',text:'Fixture',elements:[{ref:'value',tag:'input',type:'text',field:'value',inForm:true},{ref:'#submit',tag:'button',type:'submit',inForm:true}],form:{action:'https://fixture.example/submit',method:'POST',values:{value:'synthetic'}}}),execute:async()=>{},close:async()=>{alive=false;},absent:async()=>!alive,verify:async()=>null,
 }});
 const host=browserTaskContinuity({enabled:true,ownerId:'owner-a',taskId:'run',manifestDigest:`sha256:${'a'.repeat(64)}`,driver,now:()=>100,newId:()=>crypto.randomUUID(),admit:async()=> 'grant',store:{exclusive:work=>work(),load:async()=>row,save:async value=>{row=value;}}});
 const handler=browserTaskHandler({legacy:browseActHandler(undefined,undefined,undefined),host:async()=>host,propose:async()=> 'unused'});
 const command=operation==='scroll'?{operation,delta:400,intent:'read'}:operation==='wait'?{operation,milliseconds:0,intent:'read'}:{operation,intent:'read'};
 const parsed=browseActArgsSchema.parse({url:host.pageUrl,task:'Synthetic command',command});
 const result=await handler.handle(parsed,context);
 expect(result.ok).toBe(true);
 if(result.ok){const data=result.data as Record<string,unknown>;expect(typeof data.browser_action_session_handle).toBe(operation==='scroll'?'string':'undefined');expect(JSON.stringify(result)).not.toContain('PRIVATE_PROVIDER_ID');}
});

 it.each([{operation:'open_tab',url:'https://fixture.example/other'},{operation:'switch_tab',tab_ref:'tab-one'},{operation:'close_tab',tab_ref:'tab-one'},{operation:'screenshot'},{operation:'upload',element_ref:'file',file_id:'00000000-0000-4000-8000-000000000001',revision:1}])('legacy task host refuses native-only command $operation before resolving or proposing',async command=>{
 let resolutions=0,cards=0,legacy=0;
 const handler=browserTaskHandler({legacy:{...browseActHandler(undefined,undefined,undefined),handle:async()=>{legacy++;return {ok:true,data:{},source_taint:'external'};}},host:async()=>{resolutions++;return {pageUrl:'https://fixture.example/form',propose:async()=>({})} as never;},propose:async()=>{cards++;return 'unexpected';}});
 expect(await handler.handle(browseActArgsSchema.parse({url:'https://fixture.example/form',task:'native command',command}),context)).toMatchObject({ok:false,code:'rejected'});
 expect({resolutions,cards,legacy}).toEqual({resolutions:0,cards:0,legacy:0});
 });
 it('legacy submit cannot allocate a paid alternative for a common browser approval',async()=>{
 let calls=0;
 const proposal={url:'https://fixture.example/form',action:{selector:'file',method:'click',description:'Select file'},binding:{},steps:[],commonBrowser:{version:1,taskId:'task',sessionHandle:'handle',revision:1,actionDigest:'digest',elementRef:'file',file:{}}} as unknown as BrowserSubmitProposal;
 expect(await executeBrowserSubmit('key','project',undefined,proposal,(async()=>{calls++;throw Error('must not call');}) as typeof fetch)).toMatchObject({status:'rejected'});
 expect(calls).toBe(0);
 });
