import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NIGHTLY_ID } from '../src/channels/episodes';
import { BRIEF_SWEEP_ID } from '../src/channels/event-briefs';
import { HEARTBEAT_ID } from '../src/channels/heartbeat';
import { DAY_CARDS } from '../src/prompt/day-cards';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

const model = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete(request: import('../src/llm/provider').LLMGatewayRequest) {
    model.calls += 1;
    return { ok: true as const, data: { model: request.request.model, text: 'Noted.', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { TelegramOwnerDO } = await import('../src/channels/telegram-owner-do');

const OWNER_ID = '5d1f3c2b-8a4e-4b6c-9d0e-1f2a3b4c5d6e';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };

beforeEach(() => {
  model.calls = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'set_owner_settings') return Response.json(true);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

// A fixed-id row as an older Worker meets it after a rollback: the id and kind it knows, with a recurrence only a newer
// Worker writes.
const plantReshaped = (sql: SqlStorage, id: string, kind: string, dueAt: number) => sql.exec(
  `INSERT INTO schedule (id, kind, occurrence_at, due_at, recurrence_json, payload_json, status, attempts, last_fired_at, quarantined_until, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, 'armed', 0, NULL, NULL, ?, ?)`,
  id, kind, dueAt, dueAt, JSON.stringify({ type: 'every_other_tuesday', every_ms: 600_000 }), JSON.stringify({ id }), dueAt, dueAt);
const rowOf = (sql: SqlStorage, id: string) => sql.exec('SELECT * FROM schedule WHERE id = ?', id).toArray();

type Owner = InstanceType<typeof TelegramOwnerDO>;
const headers = (name: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' });
const send = async (owner: Owner, state: DurableObjectState, name: string, text: string) => {
  const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: `client-${name}-0001`, text }) }));
  expect(sent.status).toBe(202);
  const { message_id: id } = await sent.json() as { message_id: string };
  const settled = () => state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state;
  await vi.waitFor(() => expect(['completed', 'interrupted']).toContain(settled()), { timeout: 10_000, interval: 20 });
  return settled();
};

describe('a fixed-id schedule row this Worker cannot read, on an app owner with a confirmed zone', () => {
  const cases = [['heartbeat', HEARTBEAT_ID, 'heartbeat'], ['nightly', NIGHTLY_ID, 'dreaming'], ['brief sweep', BRIEF_SWEEP_ID, 'pre_activity_spot'], ['day card', DAY_CARDS[0]!.id, 'brief']] as const;
  const boot = (name: string, plant: (sql: SqlStorage) => void, work: (owner: Owner, state: DurableObjectState) => Promise<void>) =>
    runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
      claimStore(state.storage.sql);
      ensureSchema(state.storage);
      state.storage.kv.put('do_name', name);
      state.storage.kv.put('timezone', 'UTC');
      state.storage.kv.put('timezone_confirmed', true);
      plant(state.storage.sql);
      const owner = new TelegramOwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
      try { await work(owner, state); } finally { await state.storage.deleteAlarm(); }
    });

  it('control: with every row readable, the same turn and alarm run and the fixed jobs are armed', async () => {
    const name = 'unreadable-fixed-control';
    await boot(name, () => undefined, async (owner, state) => {
      expect(await send(owner, state, name, 'What is on today?')).toBe('completed');
      await owner.alarm();
      expect(state.storage.sql.exec<{ id: string }>("SELECT id FROM schedule WHERE status = 'armed' AND id IN (?, ?, ?)", HEARTBEAT_ID, NIGHTLY_ID, BRIEF_SWEEP_ID).toArray().map(row => row.id).sort()).toEqual([BRIEF_SWEEP_ID, HEARTBEAT_ID, NIGHTLY_ID].sort());
    });
    expect(model.calls).toBeGreaterThan(0);
  });

  cases.forEach(([label, id, kind], index) => {
    it(`${label}: an app chat turn and an alarm both still run, and the row is left exactly as it was`, async () => {
      const name = `unreadable-fixed-${index}`;
      let before: unknown[] = [];
      await boot(name, sql => { plantReshaped(sql, id, kind, Date.now() + 6 * 3_600_000); before = rowOf(sql, id); }, async (owner, state) => {
        expect([label, await send(owner, state, name, 'What is on today?')]).toEqual([label, 'completed']);
        await owner.alarm();
        expect([label, rowOf(state.storage.sql, id)]).toEqual([label, before]);
        // The owner's other fixed jobs are still armed around it.
        const armed = state.storage.sql.exec<{ id: string }>("SELECT id FROM schedule WHERE status = 'armed' AND id IN (?, ?, ?)", HEARTBEAT_ID, NIGHTLY_ID, BRIEF_SWEEP_ID).toArray().map(row => row.id).sort();
        expect([label, armed]).toEqual([label, [BRIEF_SWEEP_ID, HEARTBEAT_ID, NIGHTLY_ID].sort()]);
      });
      expect(model.calls).toBeGreaterThan(0);
    });
  });

  type Runtime = Readonly<{ ready: Promise<unknown>; act(action: { action: string; id?: string; value?: string }): Promise<boolean | string>; ledger(): Promise<string> }>;
  const runtimeOf = (owner: Owner) => (owner as unknown as { setup(channel: string): Runtime }).setup('app');

  it('refuses every change to a card whose row cannot be read, says why, and leaves the row and the pins as they were', async () => {
    const name = 'unreadable-card-actions', card = DAY_CARDS[0]!.id;
    let before: unknown[] = [];
    await boot(name, sql => {
      plantReshaped(sql, card, 'brief' as never, Date.now() + 6 * 3_600_000);
      before = rowOf(sql, card);
      sql.exec('CREATE TABLE IF NOT EXISTS card_pins (card TEXT PRIMARY KEY, time TEXT NOT NULL)');
      sql.exec("INSERT INTO card_pins (card, time) VALUES (?, '07:15')", card);
    }, async (owner, state) => {
      const runtime = runtimeOf(owner);
      await runtime.ready;
      const pins = () => state.storage.sql.exec('SELECT * FROM card_pins ORDER BY card').toArray();
      const pinsBefore = pins();
      for (const action of [{ action: 'card.pin', id: card, value: '08:30' }, { action: 'card.today', id: card, value: '08:45' }, { action: 'card.unpin', id: card }]) {
        expect([action.action, await runtime.act(action)]).toEqual([action.action, 'card.unreadable.failed']);
      }
      expect(rowOf(state.storage.sql, card)).toEqual(before);
      expect(pins()).toEqual(pinsBefore);
    });
  });

  it('counts reminders it cannot read in the ledger, and leaves the ledger as it was when there are none', async () => {
    await boot('unreadable-ledger-none', () => undefined, async owner => {
      const ledger = await runtimeOf(owner).ledger();
      expect(ledger).not.toContain('more reminder');
      expect(ledger).not.toContain('\n\n\n');
    });
    await boot('unreadable-ledger-one', sql => {
      sql.exec('CREATE TABLE IF NOT EXISTS reminder_notes (id TEXT PRIMARY KEY, note TEXT NOT NULL, created_at INTEGER NOT NULL)');
      sql.exec("INSERT INTO reminder_notes (id, note, created_at) VALUES ('reminder-unreadable', 'call Sam', ?)", Date.now());
      plantReshaped(sql, 'reminder-unreadable', 'reminder', Date.now() + 3_600_000);
    }, async owner => {
      const ledger = await runtimeOf(owner).ledger();
      expect(ledger).toContain("1 more reminder was saved in a form this version can't read");
      expect(ledger).not.toContain('call Sam');
    });
  });
});
