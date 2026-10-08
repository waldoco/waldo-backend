import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { type LLMRequest } from '@waldo/contracts';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { BROWSER_TASK_KEY, type BrowserOwnerConfiguration } from '../src/channels/browser-owner-host';
import { armAlarm } from '../src/scheduler/alarm-slot';
import { syntheticCommandAdapter, type SyntheticRequest } from '../src/channels/browser-synthetic-commands';
import { fixtureDigest } from '../src/channels/public-fixture-browser';
const legacyModel = vi.hoisted(() => ({ enabled: false, calls: 0 }));
const modelGateway = vi.hoisted(() => ({ current: undefined as undefined | { complete(request: never): Promise<unknown> } }));
vi.mock('../src/llm/openai', async load => {
  const original = await load<typeof import('../src/llm/openai')>();
  return { ...original, OpenAIResponsesAdapter: class extends original.OpenAIResponsesAdapter {
    override complete(request: never) { return modelGateway.current && !legacyModel.enabled ? modelGateway.current.complete(request) as never : super.complete(request); }
  } };
});
vi.mock('openai', () => ({ default: class { responses = { create: async (input: { text?: { format?: { name?: string } } }) => {
  if (!legacyModel.enabled) throw new Error('browser proof denies unrelated model work');
  legacyModel.calls++; return { id: 'synthetic-default-reply', output: [], output_text: 'Ordinary messaging remains available.', usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string) => method === 'getMe' ? { username: 'fixture_bot' } : method === 'sendMessage' ? { message_id: 1 } : true };
});
let sequence = 880000;
async function browserProof(work: (h: {
  send(text: string): Promise<void>; approve(id: string, owner?: number): Promise<void>; deny(id: string): Promise<void>; readOnly(): void; submits(): number; present(): boolean; reload(): void; foreign(): void; stale(): void;
  reloadAbsent(): void; failCleanup(): void; failFinishRunOnce(): void; alarm(): Promise<void>; replyOnly(): void; pauseCleanup(): (() => void) & { reached: Promise<void> }; state: DurableObjectState; requests: LLMRequest[]; pauseInspect(): (() => void) & { reached: Promise<void> }; pauseLookup(): (() => void) & { reached: Promise<void> }; starts(): number; ends(): number; inspections(): number;
}) => Promise<void>, mode: 'enabled' | 'absent' | 'disabled' | 'factory_failed' | 'legacy_factory_failed' | 'journey' = 'enabled', ownerId = '10000000-0000-0000-0000-000000000001') {
  const subject = 81101, doName = `browser-do-proof-${++sequence}`;
  const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(doName));
  await runInDurableObject(stub, async (_instance, state) => {
    const noFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('browser proof denies network'));
    let starts = 0, ends = 0, inspections = 0, replyOnly = false, cleanupFails = false;
    let inspectPause: { enter(): void; wait: Promise<void> } | undefined, lookupPause: { enter(): void; wait: Promise<void> } | undefined;
    let endPause: { enter(): void; wait: Promise<void> } | undefined;
    const requests: LLMRequest[] = [];
    const binding = { owner_id: ownerId, presence_id: '20000000-0000-0000-0000-000000000001', do_name: doName, provider: 'telegram' as const, subject: String(subject), admission_revision: '9007199254740993', state_version: 0 };
    let directory = { ...binding };
    const legacyDriver = {
      provider: 'cloudflare_playwright' as const, origin: 'https://fixture.example', pageUrl: 'https://fixture.example/form', runId: `browser-task-${sequence}`, submitRef: '#submit',
      start: async () => { starts++; return 'PRIVATE_SYNTHETIC_PROVIDER_SESSION'; }, navigate: async () => {},
      inspect: async () => { inspections++; if (inspectPause) { const slot = inspectPause; inspectPause = undefined; slot.enter(); await slot.wait; } return { url: 'https://fixture.example/form', stateDigest: await fixtureDigest('synthetic'), binding: { value: 'synthetic' } }; },
      fill: async (_id: string, _field: string, _value: string, _state: string, before: () => Promise<void>) => { await before(); },
      submit: async (_id: string, _state: string, before: () => Promise<void>) => { await before(); }, verify: async () => null,
      end: async () => { ends++; if (cleanupFails) throw Error('synthetic cleanup unavailable'); if (endPause) { const slot = endPause; endPause = undefined; slot.enter(); await slot.wait; } },
    };
    let present = false, submits = 0, value = 'synthetic initial';
    let policy: (request: SyntheticRequest) => boolean = () => false;
    const journeyCommands: unknown[] = [{ operation: 'read' }, { operation: 'type', element_ref: 'value', value: 'synthetic approved' }, { operation: 'click', element_ref: 'plain' }, { operation: 'click', element_ref: '#submit', intent: 'read' }];
    const syntheticDriver = syntheticCommandAdapter({ origin: legacyDriver.origin, pageUrl: legacyDriver.pageUrl, runId: legacyDriver.runId, submitRef: legacyDriver.submitRef, transport: {
      start: async (_ttl, gate) => { starts++; present = true; policy = gate; return 'PRIVATE_SYNTHETIC_PROVIDER_SESSION'; },
      observe: async () => { inspections++; return { url: legacyDriver.pageUrl, text: `Synthetic form ${value}`, elements: [{ ref: 'value', tag: 'input', type: 'text', field: 'value', inForm: true }, { ref: '#submit', tag: 'button', type: 'submit', inForm: true }, { ref: 'plain', tag: 'button', type: 'button', inForm: false }], form: { action: `${legacyDriver.origin}/submit`, method: 'POST', values: { value } } }; },
      execute: async (_id, command, _digest, before) => { await before(); if (command.operation === 'type' && command.value) value = command.value;
        if (command.operation === 'click' && command.element_ref === '#submit') { if (!policy({ url: `${legacyDriver.origin}/submit`, method: 'POST', body: new URLSearchParams({ value }).toString() })) throw Error('synthetic request denied'); submits++; }
      },
      close: async () => { ends++; if (cleanupFails) throw Error('synthetic close unavailable'); present = false; }, absent: async () => !present,
      verify: async bindingDigest => submits ? { id: 'synthetic-do-receipt', observed_at: new Date().toISOString(), source: 'controlled_fixture', binding_digest: bindingDigest } : null,
    } });
    const driver = mode === 'journey' ? syntheticDriver : legacyDriver;
    const config: BrowserOwnerConfiguration = { enabled: mode !== 'disabled', binding, manifestDigest: `sha256:${'a'.repeat(64)}`, driver, lookup: async () => { if (lookupPause) { const slot = lookupPause; lookupPause = undefined; slot.enter(); await slot.wait; } return { ...directory }; }, grant: async request => ({ ...request, ref: 'synthetic-current-grant', expiresAt: Date.now() + 60000 }) };
    const host = {
      gateway: { complete: async ({ request }: { request: LLMRequest }) => {
        requests.push(structuredClone(request));
        const journey = mode === 'journey' && !request.response_format && request.tools?.some((t: { name: string }) => t.name === 'browse_act') ? journeyCommands.shift() : undefined;
        const calls = journey ? [{ call_id: `synthetic-command-${requests.length}`, name: 'browse_act', arguments: JSON.stringify({ url: driver.pageUrl, task: 'Prepare the known synthetic form', command: journey }) }] : !replyOnly && mode !== 'journey' && !request.response_format && !request.tool_turns?.length && request.tools?.some((t: { name: string }) => t.name === 'browse_act')
          ? [{ call_id: `browser-inspect-${requests.length}`, name: 'browse_act', arguments: JSON.stringify({ url: driver.pageUrl, task: 'Inspect the synthetic public form', command: { operation: 'inspect' } }) }] : undefined;
        return { ok: true, data: { text: request.response_format ? JSON.stringify({ decision: 'retain', sources: [] }) : calls ? '' : 'Synthetic browser reply.', ...(calls ? { tool_calls: calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, model: request.model, latency_ms: 1 } };
      } },
    };
    modelGateway.current = host.gateway as never;
    const privateEnv = { ...env, WALDO_ENVIRONMENT: 'staging', LANGFUSE_CAPTURE_TEXT: 'true', WALDO_EGRESS_ALLOWLIST: 'fixture.example', TELEGRAM_BOT_TOKEN: '12345:fictional', TELEGRAM_WEBHOOK_SECRET: 'fictional-browser-inbox-secret', OPENAI_API_KEY: 'fictional-model-key' };
    const construct = () => new TelegramOwnerDO(state, privateEnv, mode === 'absent' || mode === 'factory_failed' || mode === 'legacy_factory_failed' ? undefined : config, mode === 'factory_failed' || mode === 'legacy_factory_failed' ? { policy: { enabled: false, doName, fixtureOrigin: 'https://fixture.example' }, manifest: { origin: 'https://fixture.example', pagePath: '/form', submitPath: '/submit', receiptPrefix: '/receipts/', runId: 'trial-one', fields: ['value'], formSelector: '#form', submitSelector: '#submit', resultSelector: '#result' } } : undefined);
    if (mode === 'legacy_factory_failed') { legacyModel.enabled = true; legacyModel.calls = 0; }
    let instance = construct();
    const sendUpdate = async (update: object, text = '', expectedStatus = 200) => {
      const id = ++sequence;
      const response = await instance.fetch(new Request('https://local.invalid/enqueue', { method: 'POST', headers: { 'x-waldo-inbox-secret': 'fictional-browser-inbox-secret', 'x-waldo-telegram-subject': String(subject), 'x-waldo-do-name': doName }, body: JSON.stringify({ update_id: id, ...update }) }));
      expect(response.status).toBe(expectedStatus);
      if (expectedStatus !== 200) return;
      for (let i = 0; i < 5; i++) {
        await instance.alarm();
        const row = state.storage.kv.get<{ updateId: number; state: string; closedAt?: number }[]>('telegram_owner_inbox_v1')?.find(row => row.updateId === id);
        if (row?.closedAt !== undefined || row?.state === 'consumed' || row?.state === 'completed') return;
      }
      if (text === '/stop') return;
      throw Error('Synthetic browser turn did not close in five actual alarms');
    };
    const send = (text: string) => sendUpdate({ message: { message_id: sequence + 1, from: { id: subject, is_bot: false }, chat: { id: subject, type: 'private' }, text } }, text);
    const decide = (id: string, action: 'a' | 's', owner = subject) => sendUpdate({ callback_query: { id: `synthetic-callback-${sequence + 1}`, from: { id: owner }, data: `${action}:${id}`, message: { message_id: 1, chat: { id: subject, type: 'private' } } } }, '', owner === subject ? 200 : 403);
    const failFinishRunOnce = () => {
      const task = (instance as unknown as { browserTasks: { finishRun(): Promise<void> } }).browserTasks;
      const original = task.finishRun;
      task.finishRun = async () => { task.finishRun = original; throw Error('synthetic finishRun storage failure'); };
    };
    const pause = (kind: 'inspect' | 'lookup') => { let enter!: () => void, resume!: () => void; const reached = new Promise<void>(resolve => { enter = resolve; }); const slot = { enter, wait: new Promise<void>(resolve => { resume = resolve; }) }; if (kind === 'inspect') inspectPause = slot; else lookupPause = slot; return Object.assign(resume, { reached }); };
    try { await work({ failFinishRunOnce, approve: (id, owner) => decide(id, 'a', owner), deny: id => decide(id, 's'), readOnly: () => { journeyCommands.splice(0, journeyCommands.length, { operation: 'read' }); }, submits: () => submits, present: () => present, pauseInspect: () => pause('inspect'), pauseLookup: () => pause('lookup'), send, state, requests, reloadAbsent: () => { instance = new TelegramOwnerDO(state, privateEnv); }, failCleanup: () => { cleanupFails = true; }, alarm: () => instance.alarm(), replyOnly: () => { replyOnly = true; }, pauseCleanup: () => { let enter!: () => void, resume!: () => void; const reached = new Promise<void>(resolve => { enter = resolve; }); const wait = new Promise<void>(resolve => { resume = resolve; }); endPause = { enter, wait }; return Object.assign(resume, { reached }); }, starts: () => starts, ends: () => ends, inspections: () => inspections, reload: () => { instance = construct(); }, foreign: () => { directory = { ...directory, owner_id: '10000000-0000-0000-0000-000000000002' }; }, stale: () => { directory = { ...directory, admission_revision: '9007199254740995' }; } }); }
    finally { legacyModel.enabled = false; await state.storage.deleteAlarm(); noFetch.mockRestore(); }
  });
}
it('authenticated actual DO typed inspection persists one owner browser session across reconstruction without exposing provider identifiers', async () => {
  await browserProof(async h => {
    await h.send('Inspect the public fixture.');
    expect(h.starts()).toBe(1); expect(h.inspections()).toBeGreaterThan(0);
    const before = await h.state.storage.get(BROWSER_TASK_KEY);
    expect(before).toMatchObject({ session: { ownerId: 'prn_10000000000000000000000000000001' }, phase: 'active' });
    h.reload(); await h.send('Inspect that same public fixture again.');
    expect(h.starts()).toBe(1); expect(h.inspections()).toBeGreaterThan(1);
    const projected = JSON.stringify(h.requests);
    expect(projected).toContain('synthetic'); expect(projected).not.toContain('PRIVATE_SYNTHETIC_PROVIDER_SESSION');
    expect(projected).toContain('field_refs');
  });
});
for (const mode of ['absent', 'disabled', 'factory_failed'] as const) it(`actual DO ${mode} browser configuration rejects typed calls without provider allocation`, async () => {
  await browserProof(async h => {
    await h.send('Inspect the public fixture.');
    expect(h.starts()).toBe(0); expect(h.inspections()).toBe(0);
    expect(await h.state.storage.get(BROWSER_TASK_KEY)).toBeUndefined();
    expect(JSON.stringify(h.requests)).toContain('rejected');
  }, mode);
});
for (const mutation of ['foreign', 'stale'] as const) it(`actual owner admission ${mutation} lookup cannot operate a retained browser session`, async () => {
  await browserProof(async h => {
    await h.send('Inspect the public fixture.'); expect(h.starts()).toBe(1); const starts = h.starts(), inspections = h.inspections();
    h[mutation](); h.reload(); await h.send('Inspect after custody changes.');
    expect(h.starts()).toBe(starts); expect(h.inspections()).toBe(inspections);
  });
});
it('authenticated /stop fences and cleans a persisted browser task even after DO reconstruction', async () => {
  await browserProof(async h => {
    await h.send('Inspect the public fixture.'); expect(h.starts()).toBe(1);
    h.reload(); await h.send('/stop');
    expect(h.ends()).toBe(1); expect(await h.state.storage.get(BROWSER_TASK_KEY)).toMatchObject({ phase: 'closed' });
    await h.send('Inspect again after stop.'); expect(h.starts()).toBe(1);
  });
});

it('two actual authenticated owner DOs retain independent browser tasks and canonical UUID authority', async () => {
  let firstTask: unknown;
  await browserProof(async h => {
    await h.send('Inspect owner one public fixture.'); expect(h.starts()).toBe(1);
    firstTask = await h.state.storage.get(BROWSER_TASK_KEY);
    expect(firstTask).toMatchObject({ session: { ownerId: 'prn_10000000000000000000000000000001' } });
  });
  await browserProof(async h => {
    await h.send('Inspect owner two public fixture.'); expect(h.starts()).toBe(1);
    const task = await h.state.storage.get<{ taskId: string; session: { ownerId: string } }>(BROWSER_TASK_KEY);
    expect(task).toMatchObject({ session: { ownerId: 'prn_10000000000000000000000000000002' } });
    expect(task?.taskId).not.toBe((firstTask as { taskId: string }).taskId);
    expect(JSON.stringify(h.requests)).not.toContain('prn_10000000000000000000000000000001');
    h.reload(); await h.send('Continue owner two fixture.'); expect(h.starts()).toBe(1);
  }, 'enabled', '10000000-0000-0000-0000-000000000002');
});

it('expired browser cleanup waiting on a provider cannot starve actual inbox or outbox alarms and retains an earlier wake', async () => {
  await browserProof(async h => {
    await h.send('Open a synthetic public browser task.'); expect(h.starts()).toBe(1);
    h.replyOnly();
    const checkpoint = await h.state.storage.get<{ session: Record<string, unknown> }>(BROWSER_TASK_KEY);
    await h.state.storage.put(BROWSER_TASK_KEY, { ...checkpoint, session: { ...checkpoint!.session, expiresAt: Date.now() - 1 } });
    await h.state.storage.put('browser_owner_task_due_v1', Date.now() - 1);
    h.state.storage.kv.put('owner_alarm_last_v1', 2);
    const earlier = Date.now() + 10000;
    await armAlarm(h.state.storage, earlier);
    const resume = h.pauseCleanup();
    try {
      // A prelude that awaited provider.end would never return this alarm.
      await Promise.race([h.alarm(), new Promise<never>((_, reject) => setTimeout(() => reject(Error('browser cleanup blocked owner alarm')), 1500))]);
      await resume.reached;
      expect(h.ends()).toBe(1);
      expect(await h.state.storage.get(BROWSER_TASK_KEY)).toMatchObject({ phase: 'cleanup_pending' });
      expect(await h.state.storage.get<number>('browser_owner_task_due_v1')).toBeGreaterThan(Date.now());
      expect(await h.state.storage.getAlarm()).toBeLessThanOrEqual(earlier);
      const finals = h.state.storage.kv.get<import('../src/channels/telegram-final-outbox').FinalRecord[]>('telegram_final_outbox_v1')!;
      const prior = finals.find(row => row.id.startsWith('turn:'))!;
      const attempts = prior.attempts;
      prior.dueAt = 0; h.state.storage.kv.put('telegram_final_outbox_v1', finals);
      const requestCount = h.requests.length;
      await h.send('Reply while expired browser cleanup is still pending.');
      expect(h.requests.length).toBeGreaterThan(requestCount);
      await h.alarm(); // Round-robin gives the ready transport its next bounded service slot.
      expect(h.state.storage.kv.get<import('../src/channels/telegram-final-outbox').FinalRecord[]>('telegram_final_outbox_v1')!.find(row => row.id === prior.id)!.attempts).toBeGreaterThan(attempts);
      expect(await h.state.storage.get(BROWSER_TASK_KEY)).toMatchObject({ phase: 'cleanup_pending' });
    } finally { resume(); }
  });
});
for (const state of ['missing', 'malformed', 'closed'] as const) it(`actual owner alarm retires an overdue browser wake with ${state} checkpoint without deleting evidence`, async () => {
  await browserProof(async h => {
    await h.send('Open synthetic browser task.'); h.replyOnly();
    const original = await h.state.storage.get<Record<string, unknown>>(BROWSER_TASK_KEY);
    const retained = state === 'malformed' ? { private_provider_id: 'unresolved-private-id', damaged: true } : state === 'closed' ? { ...original, phase: 'closed', session: { ...(original!.session as object), state: 'ended' } } : undefined;
    if (state === 'missing') await h.state.storage.delete(BROWSER_TASK_KEY); else await h.state.storage.put(BROWSER_TASK_KEY, retained);
    await h.state.storage.put('browser_owner_task_due_v1', Date.now() - 1);
    h.state.storage.kv.put('owner_alarm_last_v1', 2);
    await h.alarm();
    // waitUntil maintenance may finish after the bounded alarm service slot.
    for (let n = 0; n < 20 && await h.state.storage.get('browser_owner_task_due_v1') !== null; n++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(await h.state.storage.get('browser_owner_task_due_v1')).toBeNull();
    expect(await h.state.storage.get(BROWSER_TASK_KEY)).toEqual(retained);
    expect(h.ends()).toBe(0);
    if (state === 'malformed') expect(await h.state.storage.get('browser_owner_task_quarantine_v1')).toMatchObject({ reason: 'malformed_checkpoint' });
    h.state.storage.kv.put('owner_alarm_last_v1', 2); await h.alarm();
    expect(h.state.storage.kv.get('owner_alarm_last_v1')).not.toBe(3);
  });
});

for (const recovery of ['missing_configuration', 'exhausted_cleanup'] as const) it(`actual DO ${recovery} retires its cleanup wake while preserving unresolved identity and servicing owner inbox`, async () => {
  await browserProof(async h => {
    await h.send('Open the synthetic browser session.'); h.replyOnly();
    const original = await h.state.storage.get<{ session: Record<string, unknown> }>(BROWSER_TASK_KEY);
    expect(original!.session.providerSessionId).toBe('PRIVATE_SYNTHETIC_PROVIDER_SESSION');
    await h.state.storage.put(BROWSER_TASK_KEY, { ...original, session: { ...original!.session, expiresAt: Date.now() - 1 } });
    if (recovery === 'missing_configuration') h.reloadAbsent(); else h.failCleanup();
    const count = recovery === 'missing_configuration' ? 1 : 4;
    for (let attempt = 0; attempt < count; attempt++) {
      await h.state.storage.put('browser_owner_task_due_v1', Date.now() - 1);
      h.state.storage.kv.put('owner_alarm_last_v1', 2);
      await h.alarm();
      // Cleanup runs in waitUntil; wait only for this persisted recovery result.
      for (let n = 0; n < 30 && (await h.state.storage.get<number>('browser_owner_task_due_v1') ?? 0) <= Date.now() && await h.state.storage.get('browser_owner_task_due_v1') !== null; n++) await new Promise(resolve => setTimeout(resolve, 5));
      if (recovery === 'exhausted_cleanup' && attempt < 2) {
        for (let n = 0; n < 30 && h.ends() <= attempt; n++) await new Promise(resolve => setTimeout(resolve, 5));
        h.reload();
      }
    }
    for (let n = 0; n < 30 && await h.state.storage.get('browser_owner_task_due_v1') !== null; n++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(h.ends()).toBe(recovery === 'missing_configuration' ? 0 : 3);
    expect(await h.state.storage.get('browser_owner_task_due_v1')).toBeNull();
    expect(await h.state.storage.get('browser_owner_task_cleanup_v1')).toMatchObject({ status: recovery === 'missing_configuration' ? 'driver_unavailable' : 'exhausted', ...(recovery === 'exhausted_cleanup' ? { attempts: 3 } : {}) });
    expect(await h.state.storage.get(BROWSER_TASK_KEY)).toMatchObject({ session: { providerSessionId: 'PRIVATE_SYNTHETIC_PROVIDER_SESSION' } });
    expect((await h.state.storage.get<{ phase: string }>(BROWSER_TASK_KEY))!.phase).not.toBe('closed');
    const before = h.requests.length; await h.send('Continue the owner conversation despite unavailable browser cleanup.');
    expect(h.requests.length).toBeGreaterThan(before);
    expect(JSON.stringify(h.requests)).not.toContain('PRIVATE_SYNTHETIC_PROVIDER_SESSION');
  });
});

it('factory failure does not stop ordinary owner messaging', async () => {
  await browserProof(async h => {
    h.replyOnly(); await h.send('Hello, continue the owner conversation.');
    expect(h.requests.length).toBeGreaterThan(0); expect(h.starts()).toBe(0);
  }, 'factory_failed');
});

for (const seam of ['lookup', 'inspect'] as const) it(`actual DO fences browser work on authenticated stop during paused ${seam}`, async () => {
  await browserProof(async h => {
    const resume = seam === 'lookup' ? h.pauseLookup() : h.pauseInspect();
    const pending = h.send('Inspect the public fixture.'); await resume.reached;
    await h.send('/stop');
    resume(); await pending;
    expect(h.starts()).toBe(seam === 'lookup' ? 0 : 1);
    expect(JSON.stringify(h.requests)).not.toContain('field_refs');
    await h.send('/stop'); if (seam === 'inspect') expect(h.ends()).toBe(1);
  });
});
it('browser approval custody survives reconstruction but denies replaced physical owner or continuation', async () => {
  await browserProof(async h => {
    const { browserTaskSourceCustody } = await import('../src/channels/browser-task-source');
    await h.send('Inspect the public fixture.');
    const ownerKey = 'telegram:physical-owner-one';
    let currentOwner = ownerKey;
    const owner = async () => currentOwner;
    const payload = { url: 'https://fixture.example/form', action: { selector: '#submit', method: 'click', description: 'synthetic' }, binding: { value: 'synthetic' }, steps: [], continuation: { version: 1 as const, taskRef: 'synthetic-task', proposalId: 'synthetic-proposal', scopeDigest: `sha256:${'a'.repeat(64)}` } };
    browserTaskSourceCustody(h.state.storage.sql, h.state.storage.kv, owner).capture(payload, ownerKey);
    const guard = browserTaskSourceCustody(h.state.storage.sql, h.state.storage.kv, owner).guard(payload); await guard();
    currentOwner = 'telegram:physical-owner-two';
    await expect(guard()).rejects.toThrow('changed');
    const { browserTaskApprovalBridge } = await import('../src/tools/live/browser-task');
    let submits = 0, receipts = 0;
    const approval = browserTaskApprovalBridge({ ownerId: 'prn_10000000000000000000000000000001', host: async next => {
      const current = browserTaskSourceCustody(h.state.storage.sql, h.state.storage.kv, owner).guard(next); await current();
      return { taskRef: 'synthetic-task', pageUrl: next.url, validateProposal: async () => true, submit: async () => { submits++; }, validateReceipt: async () => { receipts++; return true; } } as never;
    } });
    expect(await approval.submit(payload, 'authenticated-owner-approval')).toMatchObject({ status: 'rejected' });
    expect(await approval.receiptVerified(payload, { id: 'r', observed_at: new Date().toISOString(), source: 'controlled_fixture', binding_digest: `sha256:${'a'.repeat(64)}`, action_digest: `sha256:${'b'.repeat(64)}` })).toBe(false);
    expect(submits).toBe(0); expect(receipts).toBe(0);
    expect(() => browserTaskSourceCustody(h.state.storage.sql, h.state.storage.kv, owner).guard({ ...payload, continuation: { ...payload.continuation, proposalId: 'foreign' } })).toThrow();
  });
});

it('default responder still answers ordinary owner text when the configured browser binding RPC is unavailable', async () => {
  await browserProof(async h => {
    await h.send('Hello, please answer using this message only.');
    expect(legacyModel.calls).toBeGreaterThan(0); expect(h.starts()).toBe(0); expect(h.inspections()).toBe(0);
    expect(JSON.stringify(h.state.storage.kv.get('telegram_final_outbox_v1'))).toContain('Ordinary messaging remains available.');
  }, 'legacy_factory_failed');
});
it('browser approval custody remains valid without a classifier and is revoked by authenticated stop', async () => {
  await browserProof(async h => {
    const { browserTaskSourceCustody } = await import('../src/channels/browser-task-source');
    await h.send('Inspect the public fixture.');
    const ownerKey = 'telegram:physical-owner';
    const owner = async () => ownerKey;
    const payload = { url: 'https://fixture.example/form', action: { selector: '#submit', method: 'click', description: 'synthetic' }, binding: { value: 'synthetic' }, steps: [], continuation: { version: 1 as const, taskRef: 'synthetic-task', proposalId: 'synthetic-proposal', scopeDigest: `sha256:${'a'.repeat(64)}` } };
    const custody = browserTaskSourceCustody(h.state.storage.sql, h.state.storage.kv, owner);
    custody.capture(payload, ownerKey);
    const guard = browserTaskSourceCustody(h.state.storage.sql, h.state.storage.kv, owner).guard(payload);
    await guard();
    expect(h.state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='owner_task_source_scope'").toArray()).toHaveLength(0);
    await h.send('/stop');
    await expect(guard()).rejects.toThrow('changed');
  });
});

it('complete fake owner journey fills, holds for owner desk approval, submits once and verifies physical absence across reconstruction', async () => {
  await browserProof(async h => {
    await h.send('Fill and submit the synthetic form after my approval.');
    expect(h.starts()).toBe(1); expect(h.submits()).toBe(0); expect(h.present()).toBe(true);
    const row = h.state.storage.sql.exec<{ id: string; status: string; payload_json: string; summary: string }>("SELECT id,status,payload_json,summary FROM ledger WHERE kind='browser_submit'").one();
    expect(row.status).toBe('open'); expect(JSON.parse(row.payload_json)).toMatchObject({ binding: { value: 'synthetic approved' }, request: { url: 'https://fixture.example/submit', method: 'POST', fields: ['value'] } });
    expect(row.summary).toContain('POST https://fixture.example/submit');
    h.reload(); await h.approve(row.id, 81102); expect(h.submits()).toBe(0);
    await h.approve(row.id); expect(h.submits()).toBe(1); expect(h.ends()).toBe(1); expect(h.present()).toBe(false);
    expect(h.state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', row.id).one().status).toBe('done');
    await h.approve(row.id); expect(h.submits()).toBe(1);
    expect(await h.state.storage.get(BROWSER_TASK_KEY)).toMatchObject({ phase: 'closed', receipt: { id: 'synthetic-do-receipt' } });
    expect(JSON.stringify(h.requests)).not.toContain('PRIVATE_SYNTHETIC_PROVIDER_SESSION');
  }, 'journey');
});

it('actual synthetic owner denial closes the held physical session without submitting and rejects late approval', async () => {
  await browserProof(async h => {
    await h.send('Prepare the synthetic form.');
    const { id } = h.state.storage.sql.exec<{ id: string }>("SELECT id FROM ledger WHERE kind='browser_submit'").one();
    await h.deny(id); expect(h.submits()).toBe(0); expect(h.ends()).toBe(1); expect(h.present()).toBe(false);
    expect(await h.state.storage.get(BROWSER_TASK_KEY)).toMatchObject({ phase: 'closed', proposal: null });
    await h.approve(id); expect(h.submits()).toBe(0);
  }, 'journey');
});
it('actual synthetic read-only owner run physically closes at run end', async () => {
  await browserProof(async h => {
    h.readOnly(); await h.send('Read this synthetic form.');
    expect(h.starts()).toBe(1); expect(h.ends()).toBe(1); expect(h.present()).toBe(false);
    expect(await h.state.storage.get(BROWSER_TASK_KEY)).toMatchObject({ phase: 'closed' });
  }, 'journey');
});
it('actual synthetic approval expiry closes via the existing owner alarm and late approval does not submit', async () => {
  await browserProof(async h => {
    await h.send('Prepare the synthetic form.');
    const { id } = h.state.storage.sql.exec<{ id: string }>("SELECT id FROM ledger WHERE kind='browser_submit'").one();
    const record = await h.state.storage.get<import('@waldo/contracts').BrowserTaskCheckpoint>(BROWSER_TASK_KEY);
    await h.state.storage.put(BROWSER_TASK_KEY, { ...record, session: { ...record!.session, expiresAt: Date.now() - 1 } });
    await h.state.storage.put('browser_owner_task_due_v1', Date.now() - 1); h.state.storage.kv.put('owner_alarm_last_v1', 2);
    await h.alarm();
    for (let n = 0; n < 30 && h.present(); n++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(h.ends()).toBe(1); expect(h.present()).toBe(false);
    h.reload(); await h.approve(id); expect(h.submits()).toBe(0);
  }, 'journey');
});
it('owner result survives finishRun failure while unresolved browser state stays fenced and logged', async () => {
  await browserProof(async h => {
    const logs = vi.spyOn(console, 'log');
    try {
      h.readOnly(); h.failFinishRunOnce();
      await expect(h.send('Read the form and reply.')).resolves.toBeUndefined();
      const entries = logs.mock.calls.flatMap(([value]) => { try { return [JSON.parse(String(value))]; } catch { return []; } });
      expect(entries.some(entry => entry.hop === 'respond' && entry.ok === true)).toBe(true);
      expect(entries).toContainEqual(expect.objectContaining({ hop: 'browser_cleanup', code: 'browser_cleanup_unresolved', ok: false }));
      expect(h.submits()).toBe(0);
      expect(await h.state.storage.get('browser_owner_task_revoked_v1')).toBe((await h.state.storage.get<import('@waldo/contracts').BrowserTaskCheckpoint>(BROWSER_TASK_KEY))!.taskId);
    } finally { logs.mockRestore(); }
  }, 'journey');
});
