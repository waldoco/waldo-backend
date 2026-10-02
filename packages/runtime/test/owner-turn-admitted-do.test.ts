import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { recallResultSchema, type LLMRequest, type ToolName } from '@waldo/contracts';
import type { ContextComposerDependencies } from '../src/context-composer';
import type { OwnerMessageAdmission } from '../src/identity/owner-message-admission';
import { claimStore } from '../src/memory/claims';
import { TelegramOwnerDO, type TelegramOwnerPrivateHost } from '../src/channels/telegram-owner-do';

// Background boot planning is outside this canonical turn proof; deny its SDK locally.
vi.mock('openai', () => ({ default: class { responses = { create: async () => { throw new Error('local proof denies unrelated model work'); } }; } }));
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
let seq = 700000;
async function proof(work: (h: {
  send(text: string, content?: Record<string, unknown>): Promise<readonly { state: string; selected: number }[]>; requests: LLMRequest[]; admissions: OwnerMessageAdmission[]; state: DurableObjectState;
  mutateDescriptor(): void; mutate(): void; revoke(): void; unavailable(): void; wrongOwner(): void; crossOwnerContext(): void; pause(): Promise<(() => void) & { reached: Promise<void> }>; reload(): void;
}) => Promise<void>, omitHost = false) {
  const subject = 81101;
  const doName = `admitted-proof-${++seq}`;
  const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(doName));
  await runInDurableObject(stub, async (_instance, state) => {
    const noFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('local proof denies network'));
    const requests: LLMRequest[] = [];
    const admissions: OwnerMessageAdmission[] = [];
    let foreignContext = false;
    let revision = '9007199254740993';
    let grants: readonly ToolName[] = ['get_context'];
    let grantUnavailable = false;
    let ownerId = '10000000-0000-0000-0000-000000000001';
    let paused: { entered(): void; wait: Promise<void> } | undefined;
    const host: TelegramOwnerPrivateHost = {
      environment: 'staging', namespace: 'private-local-namespace', allowedDoNames: [doName],
      lookup: async () => ({ owner_id: ownerId, presence_id: '20000000-0000-0000-0000-000000000001', state_version: 0, admission_revision: revision, do_name: doName, provider: 'telegram', subject: String(subject) }),
      context: admission => {
        admissions.push(admission);
        const deps = sources(admission);
        return foreignContext ? { ...deps, materials: { load: async request => ({ ...await deps.materials.load(request), principal_ref: 'prn_ffffffffffffffffffffffffffffffff' }) } } : deps;
      }, access: async () => ({ grants: grantUnavailable ? { status: 'unavailable' } : { status: 'available', tools: grants }, connectors: { status: 'unavailable' } }),
      connectorBacked: () => false,
      gateway: { complete: async ({ request, route }) => {
        requests.push(structuredClone(request));
        const writer = request.response_format?.name === 'claim_ops';
        if (!request.response_format && paused) { const slot = paused; paused = undefined; slot.entered(); await slot.wait; }
        const calls = !request.response_format && !request.tool_turns?.length && request.tools?.some(t => t.name === 'get_context') ? [{ call_id: 'fixture-clock', name: 'get_context', arguments: '{}' }] : undefined;
        return { ok: true, data: { text: writer ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : calls ? '' : 'Synthetic admitted reply.', ...(calls ? { tool_calls: calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, model: request.model, latency_ms: 1 } };
      } },
    };
    const privateEnv = { ...env, TELEGRAM_BOT_TOKEN: '12345:fictional', TELEGRAM_WEBHOOK_SECRET: 'fictional-inbox-secret', OPENAI_API_KEY: 'fictional-model-key' };
    const preparation = { mode: 'canonical' as const, host: omitHost ? undefined : host };
    let instance = new TelegramOwnerDO(state, privateEnv, preparation);
    const send = async (text: string, content: Record<string, unknown> = {}) => {
      const id = ++seq;
      const response = await instance.fetch(new Request('https://local.invalid/enqueue', { method: 'POST', headers: { 'x-waldo-inbox-secret': 'fictional-inbox-secret', 'x-waldo-telegram-subject': String(subject), 'x-waldo-do-name': doName }, body: JSON.stringify({ update_id: id, message: { message_id: id, from: { id: subject, is_bot: false }, chat: { id: subject, type: 'private' }, text, ...content } }) }));
      expect(response.status).toBe(200);
      const steps: { state: string; selected: number }[] = [];
      // Inbox, outbox and scheduler each get service within three actual alarms.
      for (let alarm = 0; alarm < 3; alarm++) {
        await instance.alarm();
        const row = state.storage.kv.get<{ updateId: number; state: string; closedAt?: number }[]>('telegram_owner_inbox_v1')!.find(row => row.updateId === id)!;
        expect(row).toBeDefined();
        steps.push({ state: row.state, selected: state.storage.kv.get<number>('owner_alarm_last_v1')! });
        if (typeof row.closedAt === 'number' && ['awaiting_delivery', 'completed', 'quarantined'].includes(row.state)) return steps;
      }
      throw new Error(`Fixture inbox update ${id} did not close within three real alarms`);
    };
    try { await work({ send, requests, admissions, state, mutateDescriptor: () => { Object.assign(preparation, { mode: 'invalid', host: undefined }); }, crossOwnerContext: () => { foreignContext = true; }, mutate: () => { revision = String(BigInt(revision) + 2n); }, revoke: () => { grants = []; }, unavailable: () => { grantUnavailable = true; }, wrongOwner: () => { ownerId = '10000000-0000-0000-0000-000000000002'; }, reload: () => { instance = new TelegramOwnerDO(state, privateEnv, { mode: 'canonical', host: omitHost ? undefined : host }); }, pause: async () => {
      let resume!: () => void; let entered!: () => void;
      const wait = new Promise<void>(resolve => { resume = resolve; });
      const reached = new Promise<void>(resolve => { entered = resolve; });
      paused = { wait, entered };
      return Object.assign(resume, { reached });
    } }); } finally { await state.storage.deleteAlarm(); noFetch.mockRestore(); }
  });
}
it('actual authenticated DO turn uses admitted input, canonical continuation and granted installed handler with zero skills', async () => {
  await proof(async h => {
    const legacy = { id: 'legacy', ownerId: 'legacy-owner', chatId: 'legacy-chat', parentId: null, threadAnchorId: null, surface: 'telegram', modelPayload: 'preserved legacy bytes', appPayload: 'preserved legacy bytes', modelProjection: { mode: 'include' }, role: 'user' };
    await h.state.storage.put('conv:0000000000', legacy);
    const claims = claimStore(h.state.storage.sql);
    claims.add({ kind: 'fact', text: 'LEGACY_MEMORY_MARKER', source: 'stated', evidence: 'legacy' }, new Date().toISOString());
    h.state.storage.sql.exec('CREATE TABLE IF NOT EXISTS standing_orders (id TEXT PRIMARY KEY, scope TEXT NOT NULL, trigger TEXT NOT NULL, at TEXT, gate TEXT NOT NULL, escalation TEXT NOT NULL, created_at INTEGER NOT NULL)');
    h.state.storage.sql.exec('INSERT INTO standing_orders VALUES (?, ?, ?, NULL, ?, ?, ?)', 'legacy-order', 'LEGACY_ORDER_MARKER', 'every_turn', 'notify', 'none', Date.now());
    await h.state.storage.put('toolout:0000000000', { tool: 'get_context', ok: true, at: Date.now(), taint: 'external', summary: 'LEGACY_TOOL_OUTPUT_MARKER' });
    await h.send('Plan the Bengaluru demo on October 15.');
    const replies = h.requests.filter(r => !r.response_format);
    expect(replies.length).toBeGreaterThan(1);
    expect(replies[0]!.cache_key).toBe('waldo:prn_10000000000000000000000000000001');
    expect(replies[0]!.messages.at(-1)?.content).toContain('Bengaluru');
    expect(replies[0]!.system).toContain('Trusted user_message invocation.');
    expect(replies[0]!.system).toContain('Plan the Bengaluru demo on October 15.');
    const invocation = h.admissions[0]!.invocation;
    expect(invocation.admission_source).toBe('authenticated_ingress');
    expect(invocation.runtime_binding.trigger).toBe('user_message');
    expect(invocation.verified_authority).toMatchObject({ principal_ref: 'prn_10000000000000000000000000000001', tenant_ref: 'ten_10000000000000000000000000000001' });
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('Plan the Bengaluru demo on October 15.')))].map(b => b.toString(16).padStart(2, '0')).join('');
    expect(invocation.input_refs[0]!.content_digest).toBe(`sha256:${digest}`);
    const inbox = h.state.storage.kv.get<{ id: string; admittedAt: number; runId: string; attempt: string; reason: string; closedAt?: number }[]>('telegram_owner_inbox_v1')!.at(-1)!;
    expect(invocation.occurrence.occurred_at).toBe(inbox.admittedAt);
    expect(inbox.reason).toBe('final_committed');
    expect(inbox.closedAt).toBeTypeOf('number');
    const response = h.state.storage.kv.get<{ id: string; ownerSubject: string; payload: { chat_id: number; text: string }; inbox: { id: string; runId: string; attempt: string } }[]>('telegram_final_outbox_v1')!.find(row => row.id === `turn:${inbox.id}`)!;
    expect(response).toBeDefined();
    expect(response.ownerSubject).toBe('81101');
    expect(response.payload.chat_id).toBe(81101);
    expect(response.payload.text).toContain('Synthetic admitted reply.');
    expect(response.inbox).toEqual({ id: inbox.id, runId: inbox.runId, attempt: inbox.attempt });

    expect(replies[0]!.tools?.map(t => t.name)).toEqual(['get_context']);
    expect(replies.at(-1)!.tool_turns?.some(t => t.call.name === 'get_context')).toBe(true);
    expect(JSON.stringify(replies)).not.toContain('skill_procedure');
    for (const marker of ['LEGACY_MEMORY_MARKER', 'LEGACY_ORDER_MARKER', 'LEGACY_TOOL_OUTPUT_MARKER']) expect(JSON.stringify(replies)).not.toContain(marker);
    expect(claims.claims().map(row => row.text)).toEqual(['LEGACY_MEMORY_MARKER']);
    expect(h.requests.some(r => r.response_format?.name === 'claim_ops')).toBe(false);
    const prefix = 'canonical-owner-v1:prn_10000000000000000000000000000001:ten_10000000000000000000000000000001:';
    expect((await h.state.storage.list({ prefix: prefix + 'conv:' })).size).toBe(2);
    const before = h.requests.length;
    h.reload();
    await h.send('Continue that demo plan.');
    const resumed = h.requests.slice(before).filter(r => !r.response_format);
    expect(JSON.stringify(resumed[0]!.messages)).toContain('Bengaluru');
    expect((await h.state.storage.list({ prefix: prefix + 'conv:' })).size).toBe(4);
    expect(await h.state.storage.get('conv:0000000000')).toEqual(legacy);
  });
});
it('missing grants filter actual provider tool discovery', async () => { await proof(async h => { h.revoke(); await h.send('Hello from the admitted owner.'); expect(h.requests.filter(r => !r.response_format).length).toBeGreaterThan(0); expect(h.requests.filter(r => !r.response_format).every(r => !r.tools?.length)).toBe(true); }); });
it('owner custody ABA during awaited provider denies canonical memory and final publication', async () => {
  await proof(async h => {
    const resume = await h.pause();
    const sending = h.send('Do not publish after custody changes.');
    await resume.reached;
    h.mutate(); resume(); await sending;
    expect((await h.state.storage.list({ prefix: 'canonical-owner-v1:' })).size).toBe(0);
    expect((h.state.storage.kv.get<{ id: string }[]>('telegram_final_outbox_v1') ?? []).filter(r => r.id.startsWith('turn:'))).toEqual([]);
  });
});

it('unavailable grants fail closed in actual provider discovery', async () => {
  await proof(async h => {
    h.unavailable();
    await h.send('Hello with unavailable grants.');
    const replies = h.requests.filter(r => !r.response_format);
    expect(replies.length).toBeGreaterThan(0);
    for (const reply of replies) {
      expect(reply.tools?.length ?? 0).toBe(0);
      expect(reply.system).toContain('ADMITTED_MATERIAL_OWNER_BOUND_CANVAS');
      expect(reply.system).toContain("Call only tools in this request's function list");
      expect(reply.system).not.toContain('Tools available in this chat:');
    }
  });
});
it('grant revocation during awaited provider denies publication', async () => {
  await proof(async h => {
    const resume = await h.pause(); const sending = h.send('Do not publish after grant revocation.');
    await resume.reached; h.revoke(); resume(); await sending;
    expect((await h.state.storage.list({ prefix: 'canonical-owner-v1:' })).size).toBe(0);
    expect((h.state.storage.kv.get<{ id: string }[]>('telegram_final_outbox_v1') ?? []).filter(r => r.id.startsWith('turn:'))).toEqual([]);
  });
});
it('closed run during awaited provider denies publication', async () => {
  await proof(async h => {
    const resume = await h.pause(); const sending = h.send('Do not publish after closing this run.');
    await resume.reached;
    const rows = h.state.storage.kv.get<{ state: string; closedAt?: number }[]>('telegram_owner_inbox_v1')!;
    rows.find(row => row.state === 'claimed')!.closedAt = Date.now(); h.state.storage.kv.put('telegram_owner_inbox_v1', rows);
    resume(); await sending;
    expect((await h.state.storage.list({ prefix: 'canonical-owner-v1:' })).size).toBe(0);
    expect((h.state.storage.kv.get<{ id: string }[]>('telegram_final_outbox_v1') ?? []).filter(r => r.id.startsWith('turn:'))).toEqual([]);
  });
});
it('wrong owner during awaited provider denies publication', async () => {
  await proof(async h => {
    const resume = await h.pause(); const sending = h.send('Do not publish for a different owner.');
    await resume.reached; h.wrongOwner(); resume(); await sending;
    expect((await h.state.storage.list({ prefix: 'canonical-owner-v1:' })).size).toBe(0);
  });
});
it('mismatched per-row history lineage denies continuation before another reply provider call', async () => {
  await proof(async h => {
    await h.send('First canonical owner turn.');
    const rows = await h.state.storage.list<{ principal_ref: string }>({ prefix: 'canonical-owner-v1:' });
    const witness = [...rows.entries()].find(([key]) => key.includes(':witness:'))!;
    expect(witness).toBeDefined();
    await h.state.storage.put(witness[0], { ...witness[1], principal_ref: 'prn_ffffffffffffffffffffffffffffffff' });
    const finals = h.state.storage.kv.get<import('../src/channels/telegram-final-outbox').FinalRecord[]>('telegram_final_outbox_v1')!;
    const prior = finals.find(row => row.id.startsWith('turn:'))!;
    expect(prior.status).toBe('pending');
    expect(h.state.storage.kv.get('owner_alarm_last_v1')).toBe(0);
    // Make the prior response deterministically ready, retaining actual round-robin arbitration.
    prior.dueAt = 0; h.state.storage.kv.put('telegram_final_outbox_v1', finals);
    const canonicalBefore = await h.state.storage.list({ prefix: 'canonical-owner-v1:' });
    h.reload(); const before = h.requests.filter(r => !r.response_format).length;
    const steps = await h.send('Reject corrupt canonical history.');
    expect(steps[0]).toEqual({ state: 'admitted', selected: 1 });
    expect(h.state.storage.kv.get<import('../src/channels/telegram-final-outbox').FinalRecord[]>('telegram_final_outbox_v1')!.find(row => row.id === prior.id)?.attempts).toBe(1);
    expect(h.requests.filter(r => !r.response_format)).toHaveLength(before);
    const inbox = h.state.storage.kv.get<{ state: string }[]>('telegram_owner_inbox_v1')!;
    expect(inbox.at(-1)!.state).toBe('quarantined');
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps.length).toBeLessThanOrEqual(3);
    expect(steps.at(-1)).toEqual({ state: 'quarantined', selected: 0 });
    expect(await h.state.storage.list({ prefix: 'canonical-owner-v1:' })).toEqual(canonicalBefore);
    expect(h.state.storage.kv.get<import('../src/channels/telegram-final-outbox').FinalRecord[]>('telegram_final_outbox_v1')!.filter(row => row.id.startsWith('turn:')).map(row => row.id)).toEqual([prior.id]);
  });
});


it('missing trusted host supplier denies scoped user turn without model fixture fallback', async () => {
  await proof(async h => {
    await h.send('Owner input must not fall back to a fixture.');
    expect(h.requests).toEqual([]);
    expect((await h.state.storage.list({ prefix: 'canonical-owner-v1:' })).size).toBe(0);
    expect(h.state.storage.kv.get<{ state: string }[]>('telegram_owner_inbox_v1')!.at(-1)!.state).toBe('quarantined');
  }, true);
});

it('admitted materials reach the actual provider system while only granted handlers are callable', async () => {
  await proof(async h => {
    await h.send('Prove admitted material delivery.');
    const replies = h.requests.filter(r => !r.response_format);
    expect(replies.length).toBeGreaterThan(0);
    for (const reply of replies) {
      expect(reply.system).toContain('ADMITTED_MATERIAL_OWNER_BOUND_CANVAS');
      expect(reply.system).toContain('Tool ACL ceiling:');
      expect(reply.system).toContain("Call only tools in this request's function list");
      expect(reply.tools?.map(tool => tool.name)).toEqual(['get_context']);
      expect(reply.system).not.toContain('memory records it automatically');
    }
  });
});


it('a new verified owner in the same DO receives fresh context without prior owner history', async () => {
  await proof(async h => {
    await h.send('OWNER_A_PRIVATE_PLAN October 15.');
    const first = await h.state.storage.list({ prefix: 'canonical-owner-v1:prn_10000000000000000000000000000001:' });
    expect(first.size).toBeGreaterThan(0);
    expect((await h.state.storage.list({ prefix: 'canonical-owner-v1:prn_10000000000000000000000000000001:ten_10000000000000000000000000000001:conv:' })).size).toBe(2);
    const ownerAReplies = h.requests.filter(request => !request.response_format);
    expect(ownerAReplies.length).toBeGreaterThan(0);
    expect(JSON.stringify(ownerAReplies)).toContain('OWNER_A_PRIVATE_PLAN');
    const before = h.requests.length;
    h.wrongOwner();
    h.reload();
    await h.send('OWNER_B_NEW_PLAN October 16.');
    const replies = h.requests.slice(before).filter(request => !request.response_format);
    expect(replies.length).toBeGreaterThan(0);
    expect(h.admissions.at(-1)!.invocation.verified_authority.principal_ref).toBe('prn_10000000000000000000000000000002');
    for (const reply of replies) {
      expect(reply.cache_key).toBe('waldo:prn_10000000000000000000000000000002');
      expect(JSON.stringify(reply)).toContain('OWNER_B_NEW_PLAN');
      expect(JSON.stringify(reply)).not.toContain('OWNER_A_PRIVATE_PLAN');
    }
    expect(await h.state.storage.list({ prefix: 'canonical-owner-v1:prn_10000000000000000000000000000001:' })).toEqual(first);
    expect((await h.state.storage.list({ prefix: 'canonical-owner-v1:prn_10000000000000000000000000000002:ten_10000000000000000000000000000002:conv:' })).size).toBe(2);
  });
});

it('cross-owner material source rejects before the actual reply provider or publication', async () => {
  await proof(async h => {
    h.crossOwnerContext();
    await h.send('Keep other owners material private.');
    expect(h.admissions).toHaveLength(1);
    expect(h.requests.filter(request => !request.response_format)).toEqual([]);
    expect((await h.state.storage.list({ prefix: 'canonical-owner-v1:' })).size).toBe(0);
    expect((h.state.storage.kv.get<{ id: string }[]>('telegram_final_outbox_v1') ?? []).filter(row => row.id.startsWith('turn:'))).toEqual([]);
    expect(h.state.storage.kv.get<{ state: string }[]>('telegram_owner_inbox_v1')!.at(-1)!.state).toBe('quarantined');
  });
});


it.each([
  { photo: [{ file_id: 'fictional-photo', width: 1, height: 1, file_size: 3 }] },
  { document: { file_id: 'fictional-document', file_name: 'fixture.txt', file_size: 3 } },
  { voice: { file_id: 'fictional-voice', duration: 1, file_size: 3 } },
])('explicit canonical mode rejects unsupported media without legacy model fallback: %j', async content => {
  await proof(async h => {
    await h.send('Canonical media must not fall back.', { text: undefined, caption: 'Canonical media must not fall back.', ...content });
    expect(h.requests).toEqual([]);
    expect((await h.state.storage.list({ prefix: 'canonical-owner-v1:' })).size).toBe(0);
    expect((h.state.storage.kv.get<{ id: string }[]>('telegram_final_outbox_v1') ?? []).filter(row => row.id.startsWith('turn:'))).toEqual([]);
    expect(h.state.storage.kv.get<{ state: string }[]>('telegram_owner_inbox_v1')!.at(-1)!.state).toBe('quarantined');
  });
});


it('captures private preparation selection and supplier at construction', async () => {
  await proof(async h => {
    h.mutateDescriptor();
    await h.send('Keep selected canonical preparation after caller descriptor mutation.');
    expect(h.admissions).toHaveLength(1);
    expect(h.requests.filter(request => !request.response_format).length).toBeGreaterThan(0);
    expect(h.state.storage.kv.get<{ reason: string }[]>('telegram_owner_inbox_v1')!.at(-1)!.reason).toBe('final_committed');
  });
});
