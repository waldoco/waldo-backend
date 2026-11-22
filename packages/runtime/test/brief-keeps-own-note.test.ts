import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarItem } from '../src/connectors/google';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { dayPlanBook } from '../src/channels/day-cards';
import { episodeIndex, WALDO_READ_OUTSIDE } from '../src/channels/episodes';
import { loopBook } from '../src/channels/loops';
import { traceBook } from '../src/channels/harness';
import { claimStore, WALDO_RUN_REF } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';

// A Brief's taint follows what it read: one written only from the owner's own data (their health logs, their own events, the
// day so far) runs clean and keeps what it learned as Waldo's own note, on the app and on Telegram alike. One whose calendar
// holds an invite someone else wrote runs tainted, so while notes learned from outside content are off it keeps nothing.
const NOTE = { kind: 'fact', text: 'Deep work moved to the afternoon this week.', evidence_quote: 'Deep work, 14:00 to 16:00' };
const fixture = vi.hoisted(() => ({ events: [] as CalendarItem[], results: [] as string[], call: null as Readonly<{ name: string; args: object }> | null }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, _health: unknown, account: unknown) => ({
    account, events: async () => fixture.events, newMail: async () => [], changedEvents: async () => [], event: async () => fixture.events[0] ?? null,
    calendarPage: async () => ({ events: fixture.events, next_page_token: null, fetched_count: fixture.events.length, account, observed_at: new Date().toISOString() }),
  }) };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete({ request }) {
    const card = String(request.messages.at(-1)?.content ?? '').includes('[Scheduled card') && !request.response_format;
    const step = fixture.call ?? { name: 'remember', args: NOTE };
    const answered = request.tool_turns?.find((turn) => turn.call.name === step.name);
    if (answered) fixture.results.push(answered.output);
    const tool_calls = card && !answered ? [{ call_id: 'first', name: step.name, arguments: JSON.stringify(step.args) }] : undefined;
    const text = request.response_format ? '{}' : tool_calls ? '' : card ? 'Deep work is this afternoon.' : 'SKIP';
    return { ok: true, data: { model: request.model, text, ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '6c7d8e9f-0a1b-4c2d-8e3f-4a5b6c7d8e9f';
const AT = Date.parse('2026-11-21T07:00:00Z');
const DAY = '2026-11-21';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const event = (over: Partial<CalendarItem>): CalendarItem => ({ id: 'e1', title: 'Deep work', start: `${DAY}T14:00:00Z`, end: `${DAY}T16:00:00Z`, all_day: false, ...over });

beforeEach(() => {
  fixture.events = []; fixture.results = []; fixture.call = null;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'app_push_targets') return Response.json([]);
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (url.startsWith('https://api.telegram.org/')) return Response.json({ ok: true, result: { message_id: 1, chat: { id: 7 } } });
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown> }; alarm(): Promise<void> }>;

// An owner on the app or on Telegram, Google connected when the calendar has events, with a Brief due now and nothing else.
const briefFires = async (name: string, surface: 'app' | 'telegram', google: boolean, seed?: (sql: SqlStorage) => void) => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  return runInDurableObject(stub, async (_instance, state) => {
    const originalNow = Date.now;
    Date.now = () => AT;
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      if (surface === 'app') state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      else state.storage.kv.put('telegram_subject', '7');
      state.storage.kv.put('timezone', 'UTC');
      state.storage.kv.put('timezone_confirmed', true);
      if (google) await state.storage.put('origin', 'https://fixture.invalid');
      if (google) await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only',
        scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
      const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC',
        WALDO_OWNER_TELEGRAM_ID: surface === 'telegram' ? '7' : undefined, GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret', MEMORY_OUTSIDE_NOTES: '0' }) as unknown as Owner;
      await owner.setup(surface).ready;
      state.storage.sql.exec('DELETE FROM schedule');
      seed?.(state.storage.sql);
      dayPlanBook(state.storage.sql).save(DAY, { card: 'card:brief', time: '00:00', reason: 'planned' });
      await new Scheduler(state.storage.sql, state.storage, productionDeps())
        .schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: AT - 1000, dueAt: AT - 1000, recurrence: null });
      state.storage.kv.put('owner_alarm_last_v1', 1);
      await owner.alarm();
      const loops = state.storage.sql.exec<{ status: string }>('SELECT status FROM loops').toArray().map((row) => row.status);
      return { claims: claimStore(state.storage.sql).allClaims().map((claim) => ({ origin: claim.origin, ref: claim.source_ref })), loops };
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
};

describe('a Brief keeps what it learned when it read only the owner\'s own data', () => {
  it.each(['app', 'telegram'] as const)('on %s, with no calendar connected', async (surface) => {
    const kept = await briefFires(`brief-own-note-${surface}`, surface, false);
    expect(fixture.results).toHaveLength(1);
    expect(kept.claims).toEqual([{ origin: 'agent', ref: expect.stringMatching(new RegExp(`^${WALDO_RUN_REF}`)) }]);
  });

  it('when every event on its calendar is one the owner made', async () => {
    fixture.events = [event({ owner_status: 'organizer' })];
    expect((await briefFires('brief-own-events', 'app', true)).claims).toEqual([{ origin: 'agent', ref: expect.stringMatching(new RegExp(`^${WALDO_RUN_REF}`)) }]);
  });

  it.each([
    ['the day so far holds an update Waldo sent after reading mail', (sql: SqlStorage) => episodeIndex(sql).add('update-1', WALDO_READ_OUTSIDE, 'Priya moved the pitch to Friday.', AT - 3_600_000)],
    ['its ledger lists a loop opened from a mail', (sql: SqlStorage) => {
      const loop = loopBook(sql, { newId: () => '2', now: () => AT }).open({ title: 'Reply to Priya about the pitch', due: '2026-11-24' });
      sql.exec('INSERT INTO loop_mail_sources (loop_id, source_ref) VALUES (?, ?)', loop.id, 'gmail:owner@example.test:m1');
    }],
    ['its ledger lists an approval', (sql: SqlStorage) => sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, created_at) VALUES ('l1', 'email_send', 'skipped', 'Send Priya the deck', '{}', ?)", AT - 86_400_000)],
  ])('but not when %s: it then keeps nothing while outside notes are off', async (_name, seed) => {
    expect((await briefFires(`brief-others-${_name.length}`, 'app', false, seed)).claims).toEqual([]);
    expect(fixture.results.join('\n')).toContain('keeps no note from it');
  });

  it('but not when its calendar holds an invite someone else wrote: it then keeps nothing while outside notes are off', async () => {
    fixture.events = [event({ owner_status: 'organizer' }), event({ id: 'e2', title: 'Pitch sync', owner_status: 'accepted', attendee_names: ['Priya'] })];
    expect((await briefFires('brief-invite', 'app', true)).claims).toEqual([]);
    expect(fixture.results.join('\n')).toContain('keeps no note from it');
  });
});

// What else changes for a Brief that starts clean: it closes an owner's loop still ahead as an owner turn would, with no card,
// where a Brief that read someone else's text needs the owner's card for it (passed-loops.test.ts).
describe('a clean Brief\'s other inward writes', () => {
  it('closes a loop still ahead without a card', async () => {
    const kept = await briefFires('brief-closes-ahead', 'app', false, (sql) => {
      const loop = loopBook(sql, { newId: () => '1', now: () => AT }).open({ title: 'Renew the passport', due: '2026-12-10' });
      fixture.call = { name: 'close_loop', args: { id: loop.id, outcome: 'done' } };
    });
    expect(kept.loops).toEqual(['done']);
    expect(fixture.results.join('\n')).not.toContain('taint_needs_approval');
  });
});
