import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appControlProjectionV1Schema } from '../../contracts/src/app/controls';
import { appSubjectFor } from '../src/channels/app-api';
import { traceBook } from '../src/channels/harness';
import { loopBook } from '../src/channels/loops';
import { responsibilityBook } from '../src/channels/responsibilities';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// The app's day view carries what Waldo took on and the open follow-ups beside the day's cards.
const { TelegramOwnerDO } = await import('../src/channels/telegram-owner-do');

const OWNER_ID = '5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f';
const AT = Date.parse('2026-10-13T09:00:00Z');
const HASH = 'b'.repeat(64);
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };

beforeEach(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'console_session_list') return Response.json([{ session: HASH, created_at: new Date(AT - 60_000).toISOString(), last_seen_at: new Date(AT).toISOString() }]);
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'assert_channel_presence') return Response.json(false);
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown> }; fetch(request: Request): Promise<Response> }>;

const appOwner = async (name: string, check: (owner: Owner, sql: SqlStorage) => Promise<void>) => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now;
    Date.now = () => AT;
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      state.storage.kv.put('timezone', 'UTC');
      const owner = new TelegramOwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC',
        WALDO_OWNER_TELEGRAM_ID: undefined }) as unknown as Owner;
      await owner.setup('app').ready;
      state.storage.sql.exec('DELETE FROM schedule');
      await check(owner, state.storage.sql);
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
};
const dayData = async (owner: Owner, name: string) => {
  const response = await owner.fetch(new Request('https://telegram-owner/app/v1/controls?view=day', { headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': HASH } }));
  expect(response.status).toBe(200);
  const body = appControlProjectionV1Schema.parse(await response.json());
  if (body.view !== 'day') throw Error(`unexpected view ${body.view}`);
  return body.data;
};
let seq = 0;
const ids = { newId: () => `t${(seq += 1)}`, now: () => AT };

it('lists what Waldo is carrying with its next move, who holds it and when Waldo checks again, soonest check first', async () => {
  await appOwner('open-work-carrying', async (owner, sql) => {
    const book = responsibilityBook(sql, ids);
    const venue = book.track({ title: 'Get the venue quote signed', intent: 'Venue booked by Friday', items: [
      { title: 'Ask the venue for the final quote', owner: 'waldo', depends_on: [] },
      { title: 'Sign the quote', owner: 'owner', depends_on: [0] },
    ], next_check_at: '2026-10-15T09:00' }, 'chat');
    book.update({ item_id: venue.items[0]!.id, status: 'done' });
    const visa = book.track({ title: 'Renew the visa appointment', intent: 'Before the trip', items: [], next_check_at: '2026-10-14T08:00' }, 'chat');
    sql.exec("UPDATE responsibilities SET status = 'waiting' WHERE id = ?", visa.responsibility.id);
    // Listed first, the purchase waits on the shortlist, so the shortlist is the next move.
    const gift = book.track({ title: 'Find a birthday gift', intent: 'Under the budget', items: [
      { title: 'Buy the gift', owner: 'owner', depends_on: [1] }, { title: 'Shortlist three gifts', owner: 'waldo', depends_on: [] },
    ], next_check_at: '2026-10-14' }, 'chat');
    const receipts = book.track({ title: 'Sort the expense receipts', intent: 'For the claim', items: [], next_check_at: null }, 'chat');
    const done = book.track({ title: 'Book the dentist', intent: 'Any weekday', items: [], next_check_at: '2026-10-13' }, 'chat');
    book.close({ id: done.responsibility.id, outcome: 'done', evidence_ref: 'calendar receipt' });

    // Soonest check first across every open state, and work with no check time last.
    expect((await dayData(owner, 'open-work-carrying')).carrying).toEqual({ total: 4, items: [
      { id: gift.responsibility.id, title: 'Find a birthday gift', state: 'open', next: { title: 'Shortlist three gifts', holder: 'waldo' }, check_at: '2026-10-14' },
      { id: visa.responsibility.id, title: 'Renew the visa appointment', state: 'waiting', next: null, check_at: '2026-10-14T08:00' },
      { id: venue.responsibility.id, title: 'Get the venue quote signed', state: 'open', next: { title: 'Sign the quote', holder: 'owner' }, check_at: '2026-10-15T09:00' },
      { id: receipts.responsibility.id, title: 'Sort the expense receipts', state: 'open', next: null, check_at: null },
    ] });
  });
});

it('lists open loops soonest due first, saying a mail loop came from Gmail without naming the thread', async () => {
  await appOwner('open-work-loops', async (owner, sql) => {
    const loops = loopBook(sql, ids);
    const later = loops.open({ title: 'Send the signed lease back', due: '2026-10-16' });
    const undated = loops.open({ title: 'Return the borrowed charger', due: null });
    const mail = loops.open({ title: 'Reply about the invoice', due: '2026-10-14T17:00' });
    sql.exec('INSERT INTO loop_mail_sources (loop_id, source_ref) VALUES (?, ?)', mail.id, 'gmail:synthetic-thread-ref');
    const closed = loops.open({ title: 'Pay the parking fine', due: '2026-10-13' });
    loops.close(closed.id, 'done');

    const data = await dayData(owner, 'open-work-loops');
    expect(data.open_loops).toEqual({ total: 3, items: [
      { id: mail.id, title: 'Reply about the invoice', due: '2026-10-14T17:00', source: 'gmail' },
      { id: later.id, title: 'Send the signed lease back', due: '2026-10-16', source: 'chat' },
      { id: undated.id, title: 'Return the borrowed charger', due: null, source: 'chat' },
    ] });
    expect(JSON.stringify(data)).not.toContain('synthetic-thread-ref');
  });
});

it('shows the first page of each and counts the rest, and shows empty pages when nothing is open', async () => {
  await appOwner('open-work-pages', async (owner, sql) => {
    expect(await dayData(owner, 'open-work-pages')).toMatchObject({ carrying: { items: [], total: 0 }, open_loops: { items: [], total: 0 } });
    const loops = loopBook(sql, ids);
    for (let i = 0; i < 21; i += 1) loops.open({ title: `Follow up ${i}`, due: `2026-10-${String(14 + (i % 9)).padStart(2, '0')}` });
    const { open_loops } = await dayData(owner, 'open-work-pages');
    expect([open_loops?.items.length, open_loops?.total]).toEqual([20, 21]);
  });
});

it('keeps the day when open work cannot be shown, rather than failing the Home', async () => {
  await appOwner('open-work-unshowable', async (owner, sql) => {
    responsibilityBook(sql, ids);
    sql.exec("INSERT INTO responsibilities (id, title, intent, status, created_from, created_at) VALUES ('r-long', ?, 'x', 'open', 'chat', ?)", 'Q'.repeat(201), AT);
    const logged = vi.spyOn(console, 'error');
    const data = await dayData(owner, 'open-work-unshowable');
    expect(Array.isArray(data.cards)).toBe(true);
    expect(data.carrying).toBeUndefined();
    // The fallback says only that open work was left out, never what it was.
    const lines = logged.mock.calls.flat().map(String);
    expect(lines.some(line => line.includes('"hop":"app_open_work"'))).toBe(true);
    expect(lines.join('\n')).not.toContain('QQQQ');
  });
});

it('shows titles and ids at their maxima', async () => {
  await appOwner('open-work-maxima', async (owner, sql) => {
    let n = 0;
    const long = { newId: () => `${'m'.repeat(97)}${String((n += 1)).padStart(2, '0')}`, now: () => AT };
    const work = responsibilityBook(sql, long).track({ title: 'W'.repeat(200), intent: 'x', items: [{ title: 'S'.repeat(200), owner: 'waldo', depends_on: [] }], next_check_at: null }, 'chat');
    const loop = loopBook(sql, long).open({ title: 'L'.repeat(200), due: null });
    expect([work.responsibility.id.length, loop.id.length]).toEqual([100, 100]);
    const data = await dayData(owner, 'open-work-maxima');
    expect(data.carrying?.items).toEqual([{ id: work.responsibility.id, title: 'W'.repeat(200), state: 'open', next: { title: 'S'.repeat(200), holder: 'waldo' }, check_at: null }]);
    expect(data.open_loops?.items).toEqual([{ id: loop.id, title: 'L'.repeat(200), due: null, source: 'chat' }]);
  });
});
