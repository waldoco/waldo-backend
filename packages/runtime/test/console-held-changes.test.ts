import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { consoleAccess } from '../src/channels/console';
import { CONTROLS_PATH } from '../src/channels/dashboard-controls';
import { DASHBOARD_HELD_CHANGES_PATH, heldChangesSchema, readHeldChanges } from '../src/channels/dashboard-held-changes';
import { updateBook, type Change } from '../src/channels/update-cards';

// The console Today view's held changes: what the sweep recorded on the owner's day that never reached them. Times, kind, a
// calendar title, a mail's sender and subject; never a snippet, description, location or attendee, and a field carrying a
// health value is withheld whole.
const root = 'https://telegram-owner';
const HOUR = 60 * 60_000;
const calendar = (over: Record<string, unknown>, kind: Change['kind'] = 'changed', before?: Change['before']): Change => ({
  source: 'calendar', kind, ref: 'event:e-1', ...(before ? { before } : {}),
  detail: JSON.stringify({ id: 'e-1', title: 'Sync with Krati', start: '2026-10-20T15:00:00Z', end: '2026-10-20T15:30:00Z', all_day: false,
    description: 'Agenda: pricing', location: '12 Hill Road', attendees: 3, ...over }),
});
const mail = (subject: string): Change => ({ source: 'mail', kind: 'new', ref: 'message:m-1',
  detail: JSON.stringify({ from: 'Asha <asha@client.example>', subject, snippet: 'the lab results came back fine', at: '2026-10-20T07:05:00Z' }) });

const owner = async (name: string) => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  const token = await runInDurableObject(stub, (instance, state) => {
    Object.assign((instance as unknown as { env: Record<string, unknown> }).env, { TELEGRAM_BOT_TOKEN: '123:synthetic', OPENAI_API_KEY: 'synthetic-key' });
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('timezone', 'UTC');
    return consoleAccess(state.storage).grant();
  });
  const headers = { cookie: `waldo_console=${token}`, accept: 'application/json' };
  expect((await stub.fetch(`${root}${CONTROLS_PATH}?view=connections`, { headers })).status).toBe(200);
  const read = (query = '', init: RequestInit = {}) => stub.fetch(`${root}${DASHBOARD_HELD_CHANGES_PATH}${query}`, { headers, ...init });
  const record = (at: number, changes: readonly Change[], reached?: 'delivered' | 'folded', day?: string) => runInDurableObject(stub, (_instance, state) => {
    const book = updateBook(state.storage.sql);
    const id = book.record(day ?? new Date(at).toISOString().slice(0, 10), at, changes, null);
    if (reached === 'delivered') book.pushed(id, 'Waldo told you', at);
    if (reached === 'folded') book.fold(at);
  });
  return { stub, read, record };
};

describe('the held-changes read', () => {
  // The read takes "today" from the owner object's clock, so the tests pin it: a recording an hour or two back must not fall on the previous day.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-21T12:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('golden: today\'s undelivered changes, newest first, with times, kind, title, sender and subject only', async () => {
    const o = await owner('held-golden');
    const now = Date.now();
    await o.record(now - 2 * HOUR, [calendar({}, 'changed', { start: '2026-10-20T10:00:00Z', end: '2026-10-20T10:30:00Z', all_day: false, title_changed: false, attendees: 3 })]);
    await o.record(now - HOUR, [mail('Quote for the deck')]);
    await o.record(now - 3 * HOUR, [calendar({ title: 'Folded into a card' })], 'folded');
    await o.record(now - 30 * 60_000, [calendar({ title: 'Delivered one' })], 'delivered');
    await o.record(now - 25 * HOUR, [calendar({ title: 'Yesterday' })], undefined, '2000-01-01');
    const response = await o.read();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json();
    expect(heldChangesSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ version: 1, timezone: 'UTC', day: new Date(now).toISOString().slice(0, 10), changes: [
      { source: 'mail', kind: 'new', from: 'Asha <asha@client.example>', subject: 'Quote for the deck' },
      { source: 'calendar', kind: 'changed', title: 'Sync with Krati', start: '2026-10-20T15:00:00Z', end: '2026-10-20T15:30:00Z', all_day: false,
        before: { start: '2026-10-20T10:00:00Z', end: '2026-10-20T10:30:00Z', all_day: false } },
    ] });
    const text = JSON.stringify(body);
    for (const leak of ['lab results', 'Agenda', 'Hill Road', 'attendees', 'title_changed', 'Delivered one', 'Folded into a card', 'Yesterday', 'e-1', 'm-1']) expect(text).not.toContain(leak);
  });

  it('withholds a title or subject that carries a health value, and keeps the rest', async () => {
    const o = await owner('held-health');
    const now = Date.now();
    await o.record(now - HOUR, [calendar({ title: 'Review glucose 9.8 mmol/L with Dr Rao' }), mail('Your resting HR was 48 bpm')]);
    const { changes } = await (await o.read()).json() as { changes: Record<string, unknown>[] };
    expect(changes).toEqual([
      expect.objectContaining({ source: 'calendar', title: null, start: '2026-10-20T15:00:00Z' }),
      expect.objectContaining({ source: 'mail', subject: null, from: 'Asha <asha@client.example>' }),
    ]);
    expect(JSON.stringify(changes)).not.toMatch(/9\.8 mmol|48 bpm/);
  });

  it('a cancelled event comes without times', async () => {
    const o = await owner('held-cancelled');
    await o.record(Date.now() - HOUR, [calendar({ title: '', start: '', end: '' }, 'cancelled', { start: '2026-10-20T10:00:00Z', end: '2026-10-20T10:30:00Z', all_day: false, title_changed: false })]);
    const { changes } = await (await o.read()).json() as { changes: unknown[] };
    expect(changes).toEqual([expect.objectContaining({ kind: 'cancelled', title: null, start: null, end: null, before: { start: '2026-10-20T10:00:00Z', end: '2026-10-20T10:30:00Z', all_day: false } })]);
  });

  it('refuses a signed-out read, a write, any query, and a read over the console budget', async () => {
    const o = await owner('held-refusals');
    expect((await o.stub.fetch(`${root}${DASHBOARD_HELD_CHANGES_PATH}`, { headers: { accept: 'application/json' } })).status).toBe(401);
    expect((await o.read('', { method: 'POST' })).status).toBe(405);
    expect((await o.read('?owner=someone-else')).status).toBe(400);
    await runInDurableObject(o.stub, (_instance, state) => { state.storage.kv.put('console:controls-rate:read', { start: Date.now(), count: 90 }); });
    const limited = await o.read();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
  });

  it('shows each owner only their own changes', async () => {
    const a = await owner('held-owner-a'), b = await owner('held-owner-b');
    await b.record(Date.now() - HOUR, [mail('For b only')]);
    expect(JSON.stringify(await (await a.read()).json())).not.toContain('For b only');
  });
});

describe('the held-changes schema', () => {
  const valid = { version: 1, as_of: '2026-10-20T09:00:00.000Z', timezone: 'UTC', day: '2026-10-20', changes: [
    { source: 'mail', at: '2026-10-20T08:00:00.000Z', kind: 'new', from: 'Asha', subject: null },
    { source: 'calendar', at: '2026-10-20T08:00:00.000Z', kind: 'added', title: 'Sync', start: '2026-10-20T15:00:00Z', end: '2026-10-20T15:30:00Z', all_day: false },
  ] };

  it('accepts the shape the read returns', () => {
    expect(heldChangesSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ['a mail snippet', { ...valid, changes: [{ ...valid.changes[0], snippet: 'text' }] }],
    ['a calendar description', { ...valid, changes: [{ ...valid.changes[1], description: 'text' }] }],
    ['a field on the envelope', { ...valid, owner: 'x' }],
    ['a mail change of another kind', { ...valid, changes: [{ ...valid.changes[0], kind: 'changed' }] }],
    ['more than fifty changes', { ...valid, changes: Array(51).fill(valid.changes[0]) }],
  ])('rejects %s', (_case, body) => {
    expect(heldChangesSchema.safeParse(body).success).toBe(false);
  });

  it('reads nothing before the sweep has made its table', async () => {
    await runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName('held-no-table')), (_instance, state) => {
      expect(readHeldChanges(state.storage.sql, Date.parse('2026-10-20T09:00:00Z'), 'UTC').changes).toEqual([]);
    });
  });
});
