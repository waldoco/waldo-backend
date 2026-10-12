import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_UPDATE_BASE, appSubjectFor } from '../src/channels/app-api';
import { reminderBook } from '../src/channels/reminders';
import { canonicalOwnerConversationStore } from '../src/conversation/canonical-owner-store';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

const REMINDER_TEXT = 'Time to call Sam.';
const model = vi.hoisted(() => ({ requests: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete(request: import('../src/llm/provider').LLMGatewayRequest) {
    const sent = JSON.stringify(request);
    model.requests.push(sent);
    return { ok: true as const, data: { model: request.request.model, text: sent.includes('Reminder due now') ? REMINDER_TEXT : 'Noted.', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { TelegramOwnerDO } = await import('../src/channels/telegram-owner-do');

const OWNER_ID = '7c2e9a14-3b5d-4f60-8a71-92b3c4d5e6f7';
const ownerHex = OWNER_ID.replaceAll('-', '');
const PRINCIPAL = `prn_${ownerHex}`, TENANT = `ten_${ownerHex}`, CHAT = `owner:${PRINCIPAL}`;
const PREFIX = `canonical-owner-v1:${PRINCIPAL}:${TENANT}:`;
const FIRST_TURN = `app-${APP_UPDATE_BASE + 1}`;
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };

beforeEach(() => {
  model.requests = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Row = Readonly<Record<string, unknown> & { id: string }>;
const row = (id: string, role: 'user' | 'assistant', text: string, parentId: string | null): Row => ({ id, ownerId: PRINCIPAL, chatId: CHAT, parentId, threadAnchorId: null, surface: 'app',
  modelPayload: text, appPayload: text, modelProjection: { mode: 'include' }, role, ...(role === 'user' ? { inputOrigin: 'owner' } : {}) });
const user = (id: string, text: string, parentId: string | null) => row(id, 'user', text, parentId);
const reply = (id: string, text: string, parentId: string | null) => row(id, 'assistant', text, parentId);
// A row an older build could have left behind: it fails the entry shape on its role.
const broken = (id: string, parentId: string | null): Row => ({ ...reply(id, 'Broken row.', parentId), role: undefined });

// Rows in stored order, each with its exact witness unless named unwitnessed or given a different one.
const history = (rows: readonly Row[], leaf: string, options: Readonly<{ unwitnessed?: readonly string[]; witnessOf?: Readonly<Record<string, Row>> }> = {}) => {
  const stored: Record<string, unknown> = { [`${PREFIX}count`]: rows.length, [`${PREFIX}leaf`]: leaf };
  rows.forEach((entry, index) => {
    stored[`${PREFIX}conv:${String(index).padStart(10, '0')}`] = entry;
    if (!options.unwitnessed?.includes(entry.id)) stored[`${PREFIX}witness:${entry.id}`] = { lineage: 'canonical_v1', principal_ref: PRINCIPAL, tenant_ref: TENANT, entry: options.witnessOf?.[entry.id] ?? entry };
  });
  return stored;
};

type Owner = InstanceType<typeof TelegramOwnerDO>;
type Shown = readonly Readonly<{ id: string; role: string; text: string; parent_id: string | null }>[];
const headers = (name: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' });
const withOwner = <T>(name: string, stored: Readonly<Record<string, unknown>>, work: (owner: Owner, state: DurableObjectState, lines: () => readonly Record<string, unknown>[]) => Promise<T>) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    for (const [key, value] of Object.entries(stored)) state.storage.kv.put(key, value);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new TelegramOwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    const lines = () => logged.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith('{"hop":"app_')).map(line => JSON.parse(line) as Record<string, unknown>);
    try { return await work(owner, state, lines); } finally { logged.mockRestore(); await state.storage.deleteAlarm(); }
  });
const send = async (owner: Owner, state: DurableObjectState, name: string, clientId: string, text: string) => {
  const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: clientId, text }) }));
  expect(sent.status).toBe(202);
  const { message_id: id } = await sent.json() as { message_id: string };
  const settled = () => state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state;
  await vi.waitFor(() => expect(['completed', 'interrupted']).toContain(settled()), { timeout: 10_000, interval: 20 });
  return { id, outcome: settled() };
};
const shown = async (owner: Owner, name: string): Promise<Shown | number> => {
  const response = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: headers(name) }));
  return response.status === 200 ? [...(await response.json() as { messages: Shown }).messages].reverse() : response.status;
};
const links = (messages: Shown | number) => typeof messages === 'number' ? messages : messages.map(message => [message.id, message.parent_id]);
const loads = (lines: () => readonly Record<string, unknown>[]) => lines().filter(line => line.hop === 'app_history_load');

describe('an app turn over a history that holds a row failing the entry shape', () => {
  it('a clean history answers and logs no skipped rows', async () => {
    const name = 'turn-clean';
    await withOwner(name, history([user('u1', 'First question.', null), reply('u1-reply', 'First answer.', 'u1')], 'u1-reply'), async (owner, state, lines) => {
      const turn = await send(owner, state, name, 'client-clean-0001', 'Next question.');
      expect(turn.outcome).toBe('completed');
      expect(links(await shown(owner, name))).toEqual([['u1', null], ['u1-reply', 'u1'], [turn.id, 'u1-reply'], [`${turn.id}-reply`, turn.id]]);
      expect(lines()).toEqual([]);
    });
  });

  it('loading for a turn writes nothing to storage', async () => {
    const rows = [user('u1', 'First question.', null), broken('broken-1', 'u1'), user('u2', 'Second question.', 'broken-1')];
    await withOwner('turn-load-readonly', history(rows, 'u2'), async (_owner, state) => {
      const snapshot = () => JSON.stringify([...state.storage.kv.list({ prefix: PREFIX })]);
      const before = snapshot();
      const store = canonicalOwnerConversationStore(state.storage, { invocation: { verified_authority: { principal_ref: PRINCIPAL, tenant_ref: TENANT } }, assertCurrent: async () => undefined } as never);
      const loaded = await store.load();
      expect(loaded.entries.map(entry => [entry.id, entry.parentId])).toEqual([['u1', null], ['u2', 'u1']]);
      expect(snapshot()).toBe(before);
    });
  });

  it('leaves out a broken leaf, answers, and hangs the new message on the last good row', async () => {
    const name = 'turn-skip-leaf';
    const rows = [user('u1', 'First question.', null), reply('u1-reply', 'First answer.', 'u1'), broken('broken-1', 'u1-reply')];
    await withOwner(name, history(rows, 'broken-1'), async (owner, state, lines) => {
      const turn = await send(owner, state, name, 'client-leaf-0001', 'Next question.');
      expect(turn.outcome).toBe('completed');
      expect(links(await shown(owner, name))).toEqual([['u1', null], ['u1-reply', 'u1'], [turn.id, 'u1-reply'], [`${turn.id}-reply`, turn.id]]);
      expect(model.requests.at(-1)).toContain('First answer.');
      expect(model.requests.at(-1)).not.toContain('Broken row.');
      expect(loads(lines)).toEqual([{ hop: 'app_history_load', ok: true, code: 'history_rows_skipped', check: 'role', count: 1, unwitnessed: 0, orphans: 0, leaf: true }]);
    });
  });

  it('a history holding only one witnessed user row without an input origin answers, and the new message starts the conversation', async () => {
    const name = 'turn-skip-only-row';
    const { inputOrigin: _origin, ...lone } = user('u1', 'Lone question.', null);
    await withOwner(name, history([lone as Row], 'u1'), async (owner, state, lines) => {
      const turn = await send(owner, state, name, 'client-only-0001', 'Next question.');
      expect(turn.outcome).toBe('completed');
      expect(links(await shown(owner, name))).toEqual([[turn.id, null], [`${turn.id}-reply`, turn.id]]);
      expect(model.requests.at(-1)).not.toContain('Lone question.');
      expect(loads(lines)).toEqual([{ hop: 'app_history_load', ok: true, code: 'history_rows_skipped', check: 'input_origin', count: 1, unwitnessed: 0, orphans: 0, leaf: true }]);
      expect(state.storage.kv.get(`${PREFIX}witness:u1`)).toEqual({ lineage: 'canonical_v1', principal_ref: PRINCIPAL, tenant_ref: TENANT, entry: lone });
    });
  });

  // A store an older build wrote can lack the count and leaf keys, or carry a count behind its rows. A skipped row still
  // keeps its slot: the turn's rows go after the last stored row, never over one.
  it.each([
    ['without count or leaf keys', 'turn-skip-no-count', (rows: Record<string, unknown>) => { delete rows[`${PREFIX}count`]; delete rows[`${PREFIX}leaf`]; }, 1, false],
    ['with a count behind its rows', 'turn-skip-stale-count', (rows: Record<string, unknown>) => { rows[`${PREFIX}count`] = 0; }, 1, true],
    ['with a count ahead of its rows', 'turn-skip-ahead-count', (rows: Record<string, unknown>) => { rows[`${PREFIX}count`] = 3; }, 3, true],
  ] as const)('a turn over a skipped row stored %s writes after it, never over it', async (_case, name, damage, firstFree, leaf) => {
    const { inputOrigin: _origin, ...lone } = user('u1', 'Lone question.', null);
    const stored = history([lone as Row], 'u1');
    damage(stored);
    await withOwner(name, stored, async (owner, state, lines) => {
      const turn = await send(owner, state, name, `client-${name}`.slice(0, 40), 'Next question.');
      expect(turn.outcome).toBe('completed');
      expect(state.storage.kv.get(`${PREFIX}conv:0000000000`)).toEqual(lone);
      expect([0, 1].map(index => state.storage.kv.get<Row>(`${PREFIX}conv:${String(firstFree + index).padStart(10, '0')}`)?.id)).toEqual([turn.id, `${turn.id}-reply`]);
      expect(state.storage.kv.get(`${PREFIX}count`)).toBe(firstFree + 2);
      expect(links(await shown(owner, name))).toEqual([[turn.id, null], [`${turn.id}-reply`, turn.id]]);
      expect(loads(lines)).toEqual([{ hop: 'app_history_load', ok: true, code: 'history_rows_skipped', check: 'input_origin', count: 1, unwitnessed: 0, orphans: 0, leaf }]);
    });
  });

  it('a save outside a run scope also writes after the last stored row', async () => {
    const { inputOrigin: _origin, ...lone } = user('u1', 'Lone question.', null);
    const stored = history([lone as Row], 'u1');
    delete stored[`${PREFIX}count`];
    await withOwner('save-unscoped-no-count', stored, async (_owner, state) => {
      const store = canonicalOwnerConversationStore(state.storage, { invocation: { verified_authority: { principal_ref: PRINCIPAL, tenant_ref: TENANT } }, assertCurrent: async () => undefined } as never);
      await store.load();
      const next = user('u2', 'Next question.', null);
      await store.save([next as never], 'u2');
      expect(state.storage.kv.get(`${PREFIX}conv:0000000000`)).toEqual(lone);
      expect(state.storage.kv.get(`${PREFIX}conv:0000000001`)).toEqual(next);
      expect(state.storage.kv.get(`${PREFIX}count`)).toBe(2);
    });
  });

  it('a last stored row under a key that is not a slot number stops the save and writes nothing', async () => {
    const first = user('u1', 'First question.', null);
    const stored = { ...history([first], 'u1'), [`${PREFIX}conv:stray`]: reply('u1-reply', 'First answer.', 'u1'), [`${PREFIX}witness:u1-reply`]: { lineage: 'canonical_v1', principal_ref: PRINCIPAL, tenant_ref: TENANT, entry: reply('u1-reply', 'First answer.', 'u1') } };
    await withOwner('save-stray-slot', stored, async (_owner, state) => {
      const store = canonicalOwnerConversationStore(state.storage, { invocation: { verified_authority: { principal_ref: PRINCIPAL, tenant_ref: TENANT } }, assertCurrent: async () => undefined } as never);
      await store.load();
      await expect(store.save([user('u2', 'Next question.', 'u1-reply') as never], 'u2')).rejects.toThrow('canonical history entry invalid');
      expect(state.storage.kv.get(`${PREFIX}witness:u2`)).toBeUndefined();
      expect(state.storage.kv.get(`${PREFIX}count`)).toBe(1);
    });
  });

  it('leaves out a broken parent and links its child to the nearest good row above it, for the turn only', async () => {
    const name = 'turn-skip-parent';
    const rows = [user('u1', 'First question.', null), broken('broken-1', 'u1'), user('u2', 'Second question.', 'broken-1'), reply('u2-reply', 'Second answer.', 'u2')];
    await withOwner(name, history(rows, 'u2-reply'), async (owner, state, lines) => {
      const turn = await send(owner, state, name, 'client-parent-0001', 'Third question.');
      expect(turn.outcome).toBe('completed');
      expect(model.requests.at(-1)).toContain('First question.');
      expect(model.requests.at(-1)).toContain('Second answer.');
      expect(model.requests.at(-1)).not.toContain('Broken row.');
      // The main-chat page still shows each row with its stored parent.
      expect(links(await shown(owner, name))).toEqual([['u1', null], ['u2', 'broken-1'], ['u2-reply', 'u2'], [turn.id, 'u2-reply'], [`${turn.id}-reply`, turn.id]]);
      expect(state.storage.kv.get(`${PREFIX}witness:u2`)).toEqual({ lineage: 'canonical_v1', principal_ref: PRINCIPAL, tenant_ref: TENANT, entry: rows[2] });
      expect(loads(lines)).toEqual([{ hop: 'app_history_load', ok: true, code: 'history_rows_skipped', check: 'role', count: 1, unwitnessed: 0, orphans: 1, leaf: false }]);
    });
  });

  it('walks up through two broken rows in a row', async () => {
    const name = 'turn-skip-chain';
    const rows = [user('u1', 'First question.', null), broken('broken-1', 'u1'), broken('broken-2', 'broken-1'), user('u2', 'Second question.', 'broken-2'), reply('u2-reply', 'Second answer.', 'u2')];
    await withOwner(name, history(rows, 'u2-reply'), async (owner, state, lines) => {
      expect((await send(owner, state, name, 'client-chain-0001', 'Third question.')).outcome).toBe('completed');
      expect(model.requests.at(-1)).toContain('First question.');
      expect(loads(lines)).toEqual([{ hop: 'app_history_load', ok: true, code: 'history_rows_skipped', check: 'role', count: 2, unwitnessed: 0, orphans: 1, leaf: false }]);
    });
  });

  it.each([
    ['a loop between broken rows', 'turn-skip-loop', [broken('broken-1', 'broken-2'), broken('broken-2', 'broken-1')]],
    ['a broken row whose parent is not stored', 'turn-skip-gone', [broken('broken-2', 'never-stored')]],
  ] as const)('stops walking at %s and starts the conversation at the first good row', async (_case, name, brokenRows) => {
    const rows = [...brokenRows, user('u2', 'Second question.', 'broken-2'), reply('u2-reply', 'Second answer.', 'u2')];
    await withOwner(name, history(rows, 'u2-reply'), async (owner, state) => {
      expect((await send(owner, state, name, 'client-loop-0001', 'Third question.')).outcome).toBe('completed');
      expect(model.requests.at(-1)).toContain('Second question.');
    });
  });

  it('a retried turn whose saved message hangs off a broken row saves that message once and answers', async () => {
    const name = 'turn-skip-retry';
    const rows = [user('u1', 'First question.', null), broken('broken-1', 'u1'), user(FIRST_TURN, 'Second question.', 'broken-1')];
    await withOwner(name, history(rows, FIRST_TURN), async (owner, state) => {
      expect((await send(owner, state, name, 'client-retry-0001', 'Second question.')).outcome).toBe('completed');
      expect(links(await shown(owner, name))).toEqual([['u1', null], [FIRST_TURN, 'broken-1'], [`${FIRST_TURN}-reply`, FIRST_TURN]]);
      expect(state.storage.kv.get(`${PREFIX}count`)).toBe(4);
    });
  });

  it('never stores a new message under the id of a row it left out', async () => {
    const name = 'turn-skip-reused-id';
    const { inputOrigin: _origin, ...stray } = user(FIRST_TURN, 'Stray input.', 'u1-reply');
    const rows = [user('u1', 'First question.', null), reply('u1-reply', 'First answer.', 'u1'), stray as Row];
    await withOwner(name, history(rows, 'u1-reply', { unwitnessed: [FIRST_TURN] }), async (owner, state, lines) => {
      expect((await send(owner, state, name, 'client-reuse-0001', 'Next question.')).outcome).toBe('interrupted');
      expect(state.storage.kv.get(`${PREFIX}count`)).toBe(3);
      expect(links(await shown(owner, name))).toEqual([['u1', null], ['u1-reply', 'u1']]);
      expect(lines().filter(line => line.hop === 'app_turn')).toEqual([{ hop: 'app_turn', ok: false, code: 'history_conflict' }]);
    });
  });

  it.each([
    ['a broken row whose witness differs', 'turn-fatal-witness', history([user('u1', 'First question.', null), broken('broken-1', 'u1')], 'broken-1', { witnessOf: { 'broken-1': broken('broken-1', null) } })],
    ['a good row with no witness', 'turn-fatal-unwitnessed', history([user('u1', 'First question.', null), reply('u1-reply', 'First answer.', 'u1')], 'u1-reply', { unwitnessed: ['u1-reply'] })],
  ] as const)('%s still stops the turn, which logs one fixed code and stores nothing', async (_case, name, stored) => {
    await withOwner(name, stored, async (owner, state, lines) => {
      expect((await send(owner, state, name, `client-${name}`.slice(0, 40), 'Next question.')).outcome).toBe('interrupted');
      expect(state.storage.kv.get(`${PREFIX}count`)).toBe(2);
      expect(model.requests).toEqual([]);
      expect(lines().filter(line => line.hop === 'app_turn')).toEqual([{ hop: 'app_turn', ok: false, code: 'history_witness' }]);
      expect(JSON.stringify(lines())).not.toContain('question');
    });
  });
});

describe('a scheduled app message over a history whose stored leaf is a broken row', () => {
  it('is delivered and hangs on the last good row, not on a new root', async () => {
    const name = 'scheduled-skip-leaf';
    const rows = [user('u1', 'First question.', null), reply('u1-reply', 'First answer.', 'u1'), broken('broken-1', 'u1-reply')];
    await withOwner(name, history(rows, 'broken-1'), async (owner, state, lines) => {
      state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      const clockBack = (ms: number) => () => new Date(Date.now() - ms);
      await reminderBook(state.storage.sql, new Scheduler(state.storage.sql, state.storage, productionDeps()), { timezone: 'UTC', now: clockBack(3_600_000) }, () => 'rem-skip')
        .set({ note: 'call Sam', at: clockBack(30 * 60_000)().toISOString().slice(0, 16), repeat: 'none' });
      await owner.alarm();
      const messages = await shown(owner, name);
      expect(typeof messages).not.toBe('number');
      const delivered = (messages as Shown).at(-1)!;
      expect([delivered.role, delivered.text, delivered.parent_id]).toEqual(['assistant', REMINDER_TEXT, 'u1-reply']);
      expect(loads(lines)).toContainEqual({ hop: 'app_history_load', ok: true, code: 'history_rows_skipped', check: 'role', count: 1, unwitnessed: 0, orphans: 0, leaf: true });
    });
  });
});
