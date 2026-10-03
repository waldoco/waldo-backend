import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { recallResultSchema, type LLMRequest } from '@waldo/contracts';
import type { ContextComposerDependencies } from '../src/context-composer';
import type { OwnerMessageAdmission } from '../src/identity/owner-message-admission';
import { TelegramOwnerDO, type TelegramOwnerPrivateHost } from '../src/channels/telegram-owner-do';
import { BROWSER_TASK_KEY, type BrowserOwnerConfiguration } from '../src/channels/browser-owner-host';
import { fixtureDigest } from '../src/channels/public-fixture-browser';
vi.mock('openai', () => ({ default: class { responses = { create: async () => { throw new Error('browser proof denies unrelated model work'); } }; } }));
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string) => method === 'getMe' ? { username: 'fixture_bot' } : method === 'sendMessage' ? { message_id: 1 } : true };
});
function sources(admission: OwnerMessageAdmission): ContextComposerDependencies {
  const identity = { principal_ref: admission.invocation.verified_authority.principal_ref, tenant_ref: admission.invocation.verified_authority.tenant_ref };
  const snapshot = { ...admission.snapshot, revision_ref: 'rev_11111111111111111111111111111111' };
  const source = (key: string, scope: 'system' | 'principal' = 'system') => ({ source_key: key.toLowerCase().replaceAll(' ', '-'), source_kind: 'runtime_metadata' as const, scope, source_taint: null, produced_at: snapshot.snapshot_at });
  const fragment = (key: string, scope: 'system' | 'principal' = 'system') => ({ text: key, source: source(key, scope) });
  return {
    staged_inputs: { resolve: async () => { throw new Error('admitted input adapter required'); } },
    materials: { load: async () => ({ ...identity, snapshot, identity: fragment('ADMITTED_MATERIAL_OWNER_BOUND_CANVAS', 'principal'), trigger_behaviour: fragment('Help the owner'), zone_modifier: fragment('Keep practical'), mode_template: fragment('Concise response'), soul_base: fragment('Be direct'), safety_rules: fragment('Respect permissions'), health: null, workspace: [], tool_outputs: [] }) },
    owner_binding: { bind: async () => ({ ...identity, snapshot, local_user_ref: 'private-owner', source: source('owner', 'principal') }) },
    system_skills: { list: async () => ({ rows: [], snapshot, source: source('skills') }) },
    system_skill_state: { load: async () => ({ ...identity, snapshot, source: source('skill-state', 'principal'), connected_connectors: [], dismissed_today: [], provisional_reverted: [], identity_drift: [], priority_pinned: [] }) },
    skill_budget: { countRenderedSkill: async () => ({ ok: false, code: 'unavailable' }), countRenderedBlock: async () => ({ ok: false, code: 'unavailable' }) },
    recall: { recall: async () => ({ ...identity, snapshot, status: 'failed', result: recallResultSchema.parse({ memory_hits: [], episode_hits: [], evolution_hits: [], query_used: 'No recall source', duration_ms: 0 }), source: null, capability: 'owner_bound_local_temporal_snapshot' }) },
  };
}
let sequence = 880000;
async function browserProof(work: (h: {
  send(text: string): Promise<void>; reload(): void; foreign(): void; stale(): void;
  alarm(): Promise<void>; replyOnly(): void; pauseCleanup(): (() => void) & { reached: Promise<void> }; state: DurableObjectState; requests: LLMRequest[]; starts(): number; ends(): number; inspections(): number;
}) => Promise<void>, mode: 'enabled' | 'absent' | 'disabled' = 'enabled', ownerId = '10000000-0000-0000-0000-000000000001') {
  const subject = 81101, doName = `browser-do-proof-${++sequence}`;
  const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(doName));
  await runInDurableObject(stub, async (_instance, state) => {
    const noFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('browser proof denies network'));
    let starts = 0, ends = 0, inspections = 0, replyOnly = false;
    let endPause: { enter(): void; wait: Promise<void> } | undefined;
    const requests: LLMRequest[] = [];
    const binding = { owner_id: ownerId, presence_id: '20000000-0000-0000-0000-000000000001', do_name: doName, provider: 'telegram' as const, subject: String(subject), admission_revision: '9007199254740993', state_version: 0 };
    let directory = { ...binding };
    const driver = {
      provider: 'cloudflare_playwright' as const, origin: 'https://fixture.example', pageUrl: 'https://fixture.example/form', runId: `browser-task-${sequence}`, submitRef: '#submit',
      start: async () => { starts++; return 'PRIVATE_SYNTHETIC_PROVIDER_SESSION'; }, navigate: async () => {},
      inspect: async () => { inspections++; return { url: 'https://fixture.example/form', stateDigest: await fixtureDigest('synthetic'), binding: { value: 'synthetic' } }; },
      fill: async (_id: string, _field: string, _value: string, _state: string, before: () => Promise<void>) => { await before(); },
      submit: async (_id: string, _state: string, before: () => Promise<void>) => { await before(); }, verify: async () => null,
      end: async () => { ends++; if (endPause) { const slot = endPause; endPause = undefined; slot.enter(); await slot.wait; } },
    };
    const config: BrowserOwnerConfiguration = { enabled: mode !== 'disabled', binding, manifestDigest: `sha256:${'a'.repeat(64)}`, driver, lookup: async () => ({ ...directory }), grant: async request => ({ ...request, ref: 'synthetic-current-grant', expiresAt: Date.now() + 60000 }) };
    const host: TelegramOwnerPrivateHost = {
      environment: 'staging', namespace: 'browser-proof-namespace', allowedDoNames: [doName], lookup: async () => ({ ...directory }), context: sources,
      access: async () => ({ grants: { status: 'available', tools: ['browse_act'] }, connectors: { status: 'unavailable' } }), connectorBacked: () => false,
      gateway: { complete: async ({ request }) => {
        requests.push(structuredClone(request));
        const calls = !replyOnly && !request.response_format && !request.tool_turns?.length && request.tools?.some(t => t.name === 'browse_act')
          ? [{ call_id: `browser-inspect-${requests.length}`, name: 'browse_act', arguments: JSON.stringify({ url: driver.pageUrl, task: 'Inspect the synthetic public form', command: { operation: 'inspect' } }) }] : undefined;
        return { ok: true, data: { text: calls ? '' : 'Synthetic browser reply.', ...(calls ? { tool_calls: calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, model: request.model, latency_ms: 1 } };
      } },
    };
    const privateEnv = { ...env, WALDO_EGRESS_ALLOWLIST: 'fixture.example', TELEGRAM_BOT_TOKEN: '12345:fictional', TELEGRAM_WEBHOOK_SECRET: 'fictional-browser-inbox-secret', OPENAI_API_KEY: 'fictional-model-key' };
    const construct = () => new TelegramOwnerDO(state, privateEnv, { mode: 'canonical', host }, mode === 'absent' ? undefined : config);
    let instance = construct();
    const send = async (text: string) => {
      const id = ++sequence;
      const response = await instance.fetch(new Request('https://local.invalid/enqueue', { method: 'POST', headers: { 'x-waldo-inbox-secret': 'fictional-browser-inbox-secret', 'x-waldo-telegram-subject': String(subject), 'x-waldo-do-name': doName }, body: JSON.stringify({ update_id: id, message: { message_id: id, from: { id: subject, is_bot: false }, chat: { id: subject, type: 'private' }, text } }) }));
      expect(response.status).toBe(200);
      for (let i = 0; i < 5; i++) {
        await instance.alarm();
        const row = state.storage.kv.get<{ updateId: number; state: string; closedAt?: number }[]>('telegram_owner_inbox_v1')?.find(row => row.updateId === id);
        if (row?.closedAt !== undefined || row?.state === 'consumed' || row?.state === 'completed') return;
      }
      if (text === '/stop') return;
      throw Error('Synthetic browser turn did not close in five actual alarms');
    };
    try { await work({ send, state, requests, alarm: () => instance.alarm(), replyOnly: () => { replyOnly = true; }, pauseCleanup: () => { let enter!: () => void, resume!: () => void; const reached = new Promise<void>(resolve => { enter = resolve; }); const wait = new Promise<void>(resolve => { resume = resolve; }); endPause = { enter, wait }; return Object.assign(resume, { reached }); }, starts: () => starts, ends: () => ends, inspections: () => inspections, reload: () => { instance = construct(); }, foreign: () => { directory = { ...directory, owner_id: '10000000-0000-0000-0000-000000000002' }; }, stale: () => { directory = { ...directory, admission_revision: '9007199254740995' }; } }); }
    finally { await state.storage.deleteAlarm(); noFetch.mockRestore(); }
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
for (const mode of ['absent', 'disabled'] as const) it(`actual DO ${mode} browser configuration rejects typed calls without provider allocation`, async () => {
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
    await h.state.storage.setAlarm(earlier);
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
