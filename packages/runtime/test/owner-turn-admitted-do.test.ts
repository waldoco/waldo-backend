import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { recallResultSchema, type LLMRequest, type ToolName } from '@waldo/contracts';
import type { ContextComposerDependencies } from '../src/context-composer';
import type { OwnerMessageAdmission } from '../src/identity/owner-message-admission';
import { claimStore } from '../src/memory/claims';
import { TelegramOwnerDO, type TelegramOwnerPrivateHost } from '../src/channels/telegram-owner-do';

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
  send(text: string): Promise<void>; requests: LLMRequest[]; state: DurableObjectState;
  mutate(): void; revoke(): void; unavailable(): void; wrongOwner(): void; pause(): Promise<(() => void) & { reached: Promise<void> }>; reload(): void;
}) => Promise<void>, omitHost = false) {
  const subject = 81101;
  const doName = `admitted-proof-${++seq}`;
  const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(doName));
  await runInDurableObject(stub, async (_instance, state) => {
    const noFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('local proof denies network'));
    const requests: LLMRequest[] = [];
    let revision = '9007199254740993';
    let grants: readonly ToolName[] = ['get_context'];
    let grantUnavailable = false;
    let ownerId = '10000000-0000-0000-0000-000000000001';
    let paused: { entered(): void; wait: Promise<void> } | undefined;
    const host: TelegramOwnerPrivateHost = {
      environment: 'staging', namespace: 'private-local-namespace', allowedDoNames: [doName],
      lookup: async () => ({ owner_id: ownerId, presence_id: '20000000-0000-0000-0000-000000000001', state_version: 0, admission_revision: revision, do_name: doName, provider: 'telegram', subject: String(subject) }),
      context: sources, access: async () => ({ grants: grantUnavailable ? { status: 'unavailable' } : { status: 'available', tools: grants }, connectors: { status: 'unavailable' } }),
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
    let instance = new TelegramOwnerDO(state, privateEnv, omitHost ? undefined : host);
    const send = async (text: string) => {
      const id = ++seq;
      const response = await instance.fetch(new Request('https://local.invalid/enqueue', { method: 'POST', headers: { 'x-waldo-inbox-secret': 'fictional-inbox-secret', 'x-waldo-telegram-subject': String(subject), 'x-waldo-do-name': doName }, body: JSON.stringify({ update_id: id, message: { message_id: id, from: { id: subject, is_bot: false }, chat: { id: subject, type: 'private' }, text } }) }));
      expect(response.status).toBe(200);
      await instance.alarm();
    };
    try { await work({ send, requests, state, mutate: () => { revision = String(BigInt(revision) + 2n); }, revoke: () => { grants = []; }, unavailable: () => { grantUnavailable = true; }, wrongOwner: () => { ownerId = '10000000-0000-0000-0000-000000000002'; }, reload: () => { instance = new TelegramOwnerDO(state, privateEnv, omitHost ? undefined : host); }, pause: async () => {
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
    h.reload(); const before = h.requests.filter(r => !r.response_format).length;
    await h.send('Reject corrupt canonical history.');
    expect(h.requests.filter(r => !r.response_format)).toHaveLength(before);
    const inbox = h.state.storage.kv.get<{ state: string }[]>('telegram_owner_inbox_v1')!;
    expect(inbox.at(-1)!.state).toBe('quarantined');
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
